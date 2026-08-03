/**
 * Destination map — lives in inbound.db's `destinations` table.
 *
 * The host writes this table before every container wake AND on demand
 * (e.g. when a new child agent is created mid-session). The container
 * queries the table live on every lookup, so admin changes take effect
 * immediately — no restart required.
 *
 * This table is BOTH the routing map and the container-visible ACL.
 * The host re-validates on the delivery side against the central DB,
 * so even if this table is stale the host's enforcement is authoritative.
 */
import { getInboundDb } from './db/connection.js';

export interface DestinationEntry {
  name: string;
  displayName: string;
  type: 'channel' | 'agent';
  channelType?: string;
  platformId?: string;
  agentGroupId?: string;
}

interface DestRow {
  name: string;
  display_name: string | null;
  type: 'channel' | 'agent';
  channel_type: string | null;
  platform_id: string | null;
  agent_group_id: string | null;
}

function rowToEntry(row: DestRow): DestinationEntry {
  return {
    name: row.name,
    displayName: row.display_name ?? row.name,
    type: row.type,
    channelType: row.channel_type ?? undefined,
    platformId: row.platform_id ?? undefined,
    agentGroupId: row.agent_group_id ?? undefined,
  };
}

export function getAllDestinations(): DestinationEntry[] {
  const rows = getInboundDb().prepare('SELECT * FROM destinations ORDER BY name').all() as DestRow[];
  return rows.map(rowToEntry);
}

export function findByName(name: string): DestinationEntry | undefined {
  const row = getInboundDb().prepare('SELECT * FROM destinations WHERE name = ?').get(name) as DestRow | undefined;
  return row ? rowToEntry(row) : undefined;
}

/**
 * Reverse lookup: given routing fields from an inbound message, find
 * which destination they correspond to (what does this agent call the sender?).
 */
export function findByRouting(
  channelType: string | null | undefined,
  platformId: string | null | undefined,
): DestinationEntry | undefined {
  if (!channelType || !platformId) return undefined;
  const db = getInboundDb();
  const row =
    channelType === 'agent'
      ? (db
          .prepare("SELECT * FROM destinations WHERE type = 'agent' AND agent_group_id = ?")
          .get(platformId) as DestRow | undefined)
      : (db
          .prepare("SELECT * FROM destinations WHERE type = 'channel' AND channel_type = ? AND platform_id = ?")
          .get(channelType, platformId) as DestRow | undefined);
  return row ? rowToEntry(row) : undefined;
}

/**
 * Generate the system-prompt addendum: agent identity + destination map.
 *
 * Identity is injected here (not in the shared CLAUDE.md) because it's
 * per-agent-group and changes when the operator renames an agent, while
 * the shared base is identical across all agents.
 */
export function buildSystemPromptAddendum(assistantName?: string, mountedDirs?: string[]): string {
  const sections: string[] = [];

  if (assistantName) {
    sections.push(['# You are ' + assistantName, '', `Your name is **${assistantName}**. Use it when the channel asks who you are, when introducing yourself, and when signing any message that explicitly calls for a signature.`].join('\n'));
  }

  sections.push(buildDestinationsSection());
  sections.push(buildFilesSection(mountedDirs));

  return sections.join('\n\n');
}

/**
 * Where files live, in the agent's own path namespace.
 *
 * This has to be spelled out in the prompt rather than left to a provider
 * option: only the Claude SDK consumes `additionalDirectories`, so under any
 * other provider a mounted directory is invisible unless the agent is told
 * about it. The user, meanwhile, sees the *host* path — so the closing rule
 * matters as much as the paths: never quote a container path back at someone,
 * because `/workspace/extra/vault/notes.md` means nothing to them.
 */
function buildFilesSection(mountedDirs?: string[]): string {
  const lines = [
    '## Files',
    '',
    '- `/workspace/agent/` — your own workspace. Persists across turns.',
    '- `/workspace/inbox/<messageId>/` — files the user attached to a message. Each attachment is announced inline in the message as `[type: name — saved to <path>]`; read it from that path.',
  ];

  if (mountedDirs && mountedDirs.length > 0) {
    lines.push(
      `- ${mountedDirs.map((d) => `\`${d}\``).join(', ')} — ${mountedDirs.length === 1 ? 'a directory' : 'directories'} the user mounted for you, holding their own documents. Read from ${mountedDirs.length === 1 ? 'it' : 'them'} freely; write only if asked.`,
    );
  }

  lines.push(
    '',
    'To hand a file back, use `send_file` — do NOT just write it somewhere and name the path. Your filesystem is not the one the user is looking at, so a file you leave behind is a file they cannot find. `send_file` delivers it to them where they actually are.',
    '',
    'Never quote your own absolute paths to the user. Refer to files by name ("the summary I just sent you"), not by location.',
  );

  return lines.join('\n');
}

function buildDestinationsSection(): string {
  const all = getAllDestinations();

  if (all.length === 0) {
    return [
      '## Sending messages',
      '',
      'You currently have no configured destinations. You cannot send messages until an admin wires one up.',
    ].join('\n');
  }

  const lines = ['## Sending messages', ''];

  if (all.length === 1) {
    const d = all[0];
    const label = d.displayName && d.displayName !== d.name ? ` (${d.displayName})` : '';
    lines.push(
      `Your destination is \`${d.name}\`${label}. Just reply normally — your response is delivered there automatically; no tags needed.`,
    );
  } else {
    lines.push(
      'Just reply normally to answer whoever messaged you — your bare response goes back to the sender automatically. Use a `<message to="name">…</message>` block ONLY to send to a *different* destination:',
      '',
    );
    for (const d of all) {
      const label = d.displayName && d.displayName !== d.name ? ` (${d.displayName})` : '';
      lines.push(`- \`${d.name}\`${label}`);
    }
  }
  lines.push('');
  lines.push("Use `<internal>…</internal>` for private scratchpad you don't want delivered.");
  lines.push('');
  lines.push(
    'The `send_message` MCP tool delivers mid-turn (e.g. a quick "on it" before a slow tool call); each call lands as its own message.',
  );
  return lines.join('\n');
}
