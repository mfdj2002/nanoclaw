/**
 * Obsidian "Connect MCP" control handler — a tiny private MCP app-store.
 *
 * The Obsidian plugin can send control messages over the same obsidian.sock to
 * connect/disconnect MCP servers on the agent group, without the user touching
 * the DB or `ncl`. Two ways to connect:
 *   - a curated preset by name (MCP_REGISTRY below), or
 *   - a free-form custom spec { name, command, args, env }.
 *
 * Security note: this is reachable only over the 0600 owner-only unix socket, so
 * allowing free-form command/args is the same trust level as the owner running
 * `ncl groups config add-mcp-server` themselves — no remote/agent can reach it.
 *
 * Effect: writes the group's container_configs.mcp_servers, then kills any
 * running container so the next message respawns with the new tool set
 * (config is materialized from the DB at spawn time).
 */
import { restartAgentGroupContainers } from '../container-restart.js';
import { getAllAgentGroups } from '../db/agent-groups.js';
import { ensureContainerConfig, getContainerConfig, updateContainerConfigJson } from '../db/container-configs.js';
import { log } from '../log.js';

/** Stored shape — args/env MUST be concrete (the container does `[command, ...args]`). */
interface StoredMcp {
  command: string;
  args: string[];
  env: Record<string, string>;
}

interface RegistryEntry {
  description: string;
  server: StoredMcp;
}

/** Curated, one-click MCP servers known to run in the agent container. */
export const MCP_REGISTRY: Record<string, RegistryEntry> = {
  wallstreetcn: {
    description: '华尔街见闻快讯/资讯 (wallstreetcn_flash, wallstreetcn_news) — 实时财经新闻，无需 key',
    server: { command: 'bun', args: ['run', '/app/src/wallstreetcn-mcp-stdio.ts'], env: {} },
  },
  everything: {
    description: 'MCP 官方测试服务器 (echo/add/printEnv…) — 用于验证连通性',
    server: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-everything'], env: {} },
  },
  'sequential-thinking': {
    description: 'MCP 官方 sequential-thinking 工具',
    server: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-sequential-thinking'], env: {} },
  },
  playwright: {
    description: 'Playwright 浏览器自动化（指向容器内 /usr/bin/chromium）',
    server: {
      command: 'npx',
      args: ['-y', '@playwright/mcp@latest', '--executable-path', '/usr/bin/chromium'],
      env: {},
    },
  },
};

export type McpControl =
  | { type: 'list-mcp' }
  | {
      type: 'connect-mcp';
      server?: string;
      spec?: { name?: string; command?: string; args?: string[]; env?: Record<string, string> };
    }
  | { type: 'disconnect-mcp'; server?: string };

export function isMcpControl(p: { type?: unknown }): boolean {
  return p.type === 'list-mcp' || p.type === 'connect-mcp' || p.type === 'disconnect-mcp';
}

/** Resolve the agent group the Obsidian channel targets (the cli-with* group). */
function resolveGroup(): { id: string; name: string } | null {
  const groups = getAllAgentGroups();
  const g =
    groups.find((x) => x.folder?.startsWith('cli-with')) ??
    groups.find((x) => x.folder?.includes('cli-with')) ??
    groups[0];
  return g ? { id: g.id, name: g.name } : null;
}

function readServers(groupId: string): Record<string, StoredMcp> {
  const row = getContainerConfig(groupId);
  if (!row) return {};
  try {
    return (JSON.parse(row.mcp_servers || '{}') as Record<string, StoredMcp>) ?? {};
  } catch {
    return {};
  }
}

/**
 * Handle one MCP control message. `reply` writes a line back to the plugin
 * (rendered as a normal chat message in the originating tab).
 */
export async function handleMcpControl(ctrl: McpControl, reply: (text: string) => void): Promise<void> {
  const g = resolveGroup();
  if (!g) {
    reply('❌ 找不到 agent group（cli-with*）。');
    return;
  }

  if (ctrl.type === 'list-mcp') {
    const connected = readServers(g.id);
    const presets = Object.entries(MCP_REGISTRY)
      .map(([k, v]) => `• ${k}${connected[k] ? ' ✅已连接' : ''} — ${v.description}`)
      .join('\n');
    const custom = Object.keys(connected).filter((k) => !MCP_REGISTRY[k]);
    const customTxt = custom.length
      ? `\n\n自定义已连接：\n${custom.map((k) => `• ${k} (${connected[k].command} ${connected[k].args.join(' ')})`).join('\n')}`
      : '';
    reply(`可连接的 MCP（group: ${g.name}）：\n${presets}${customTxt}`);
    return;
  }

  if (ctrl.type === 'connect-mcp') {
    let name: string;
    let server: StoredMcp;
    if (ctrl.spec && ctrl.spec.name && ctrl.spec.command) {
      name = ctrl.spec.name.trim();
      server = { command: ctrl.spec.command, args: ctrl.spec.args ?? [], env: ctrl.spec.env ?? {} };
    } else if (ctrl.server && MCP_REGISTRY[ctrl.server]) {
      name = ctrl.server;
      server = MCP_REGISTRY[ctrl.server].server;
    } else {
      reply(
        `❌ 未知 MCP："${ctrl.server ?? '(空)'}"。可用预设：${Object.keys(MCP_REGISTRY).join(', ')}；或提供自定义 {name, command, args, env}。`,
      );
      return;
    }

    ensureContainerConfig(g.id);
    const servers = readServers(g.id);
    const already = !!servers[name];
    servers[name] = server;
    updateContainerConfigJson(g.id, 'mcp_servers', servers);
    const killed = restartAgentGroupContainers(g.id, `connect MCP ${name} from obsidian`);
    log.info('Obsidian: connected MCP', { group: g.id, name, killed });
    reply(
      `✅ 已${already ? '更新' : '连接'} MCP「${name}」→ ${g.name}\n   ${server.command} ${server.args.join(' ')}\n` +
        `下一条消息起 agent 即可调用其工具。${killed ? `（已重启 ${killed} 个运行中的容器）` : ''}`,
    );
    return;
  }

  if (ctrl.type === 'disconnect-mcp') {
    if (!ctrl.server) {
      reply('❌ 缺少要断开的 MCP 名称。');
      return;
    }
    const servers = readServers(g.id);
    if (!servers[ctrl.server]) {
      reply(`「${ctrl.server}」未连接。`);
      return;
    }
    delete servers[ctrl.server];
    updateContainerConfigJson(g.id, 'mcp_servers', servers);
    const killed = restartAgentGroupContainers(g.id, `disconnect MCP ${ctrl.server} from obsidian`);
    log.info('Obsidian: disconnected MCP', { group: g.id, name: ctrl.server, killed });
    reply(`✅ 已断开 MCP「${ctrl.server}」。${killed ? `（重启 ${killed} 个容器）` : ''}`);
    return;
  }
}
