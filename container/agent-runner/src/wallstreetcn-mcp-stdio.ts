/**
 * 华尔街见闻 (Wallstreetcn) MCP server — standalone stdio process.
 *
 * A thin "shim": it speaks MCP on stdin/stdout (so OpenCode/the agent sees it as
 * a normal tool server) and translates each tool call into one HTTP GET against
 * wallstreetcn's public, no-auth JSON endpoints — the same ones wallstreetcn.com
 * itself calls in the browser. No API key, no state, no dependencies beyond the
 * MCP SDK already vendored in the agent-runner image.
 *
 * Run inside the container via:  bun run /app/src/wallstreetcn-mcp-stdio.ts
 * Registered as an MCP server in the group's container_configs.mcp_servers.
 *
 * Endpoints (undocumented but stable — they power the live site & every aggregator):
 *   快讯   GET api-one.wallstcn.com/apiv1/content/lives?channel=<ch>&limit=<n>
 *   信息流 GET api-one.wallstcn.com/apiv1/content/information-flow?channel=<ch>&accept=article&limit=<n>
 *
 * IMPORTANT: stdout is the JSON-RPC channel — only ever log to stderr.
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const API = 'https://api-one.wallstcn.com/apiv1/content';
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124';

// Channels the public API accepts. global = 全球快讯 (default firehose).
const CHANNELS = [
  'global-channel',
  'a-stock-channel',
  'us-stock-channel',
  'hk-stock-channel',
  'forex-channel',
  'commodity-channel',
] as const;

function log(msg: string): void {
  console.error(`[wallstreetcn-mcp] ${msg}`);
}

/** GET JSON with a User-Agent + a hard timeout (the API hangs rather than 4xx when unhappy). */
async function getJson(url: string): Promise<any> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 15_000);
  try {
    const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json' }, signal: ctrl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(t);
  }
}

/** Beijing-time short stamp "MM-DD HH:mm" from a unix-seconds field. */
function stamp(sec: unknown): string {
  const n = typeof sec === 'number' ? sec : Number(sec);
  if (!n || Number.isNaN(n)) return '';
  return new Date(n * 1000)
    .toLocaleString('zh-CN', {
      timeZone: 'Asia/Shanghai',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    })
    .replace(/\//g, '-');
}

function clampLimit(limit: unknown, def: number, max: number): number {
  const n = typeof limit === 'number' ? limit : Number(limit);
  if (!n || Number.isNaN(n)) return def;
  return Math.max(1, Math.min(max, Math.floor(n)));
}

function pickChannel(ch: unknown): string {
  return typeof ch === 'string' && (CHANNELS as readonly string[]).includes(ch) ? ch : 'global-channel';
}

const channelEnumDesc = `频道，默认 global-channel（全球快讯）。可选: ${CHANNELS.join(', ')}`;

const TOOLS = [
  {
    name: 'wallstreetcn_flash',
    description:
      '获取华尔街见闻最新快讯（实时财经新闻流 / live news）。返回结构化的标题+时间+链接列表，适合快速了解市场动态。无需登录或 API key。',
    inputSchema: {
      type: 'object',
      properties: {
        channel: { type: 'string', enum: [...CHANNELS], description: channelEnumDesc },
        limit: { type: 'number', description: '返回条数，默认 20，最多 50' },
      },
    },
  },
  {
    name: 'wallstreetcn_news',
    description:
      '获取华尔街见闻主信息流（资讯/要闻，比快讯更聚合，含文章与重点新闻）。返回标题+时间+链接列表。无需登录或 API key。',
    inputSchema: {
      type: 'object',
      properties: {
        channel: { type: 'string', enum: [...CHANNELS], description: channelEnumDesc },
        limit: { type: 'number', description: '返回条数，默认 15，最多 40' },
      },
    },
  },
];

async function handleFlash(args: Record<string, unknown>): Promise<string> {
  const channel = pickChannel(args.channel);
  const limit = clampLimit(args.limit, 20, 50);
  const data = await getJson(`${API}/lives?channel=${encodeURIComponent(channel)}&limit=${limit}`);
  const items: any[] = data?.data?.items ?? [];
  if (items.length === 0) return `（${channel} 暂无快讯返回）`;
  const lines = items.map((it) => {
    const title = (it.title || it.content_text || '').trim();
    return `[${stamp(it.display_time)}] ${title}\n  ${it.uri || ''}`;
  });
  return `华尔街见闻快讯 · ${channel} · ${items.length}条\n\n${lines.join('\n')}`;
}

async function handleNews(args: Record<string, unknown>): Promise<string> {
  const channel = pickChannel(args.channel);
  const limit = clampLimit(args.limit, 15, 40);
  const data = await getJson(
    `${API}/information-flow?channel=${encodeURIComponent(channel)}&accept=article&limit=${limit}`,
  );
  const items: any[] = data?.data?.items ?? [];
  const rows = items
    .map((it) => it.resource ?? it)
    .filter((r) => r && (r.title || r.content_text))
    .map((r) => {
      const title = (r.highlight_title || r.title || r.content_text || '').trim();
      return `[${stamp(r.display_time)}] ${title}\n  ${r.uri || ''}`;
    });
  if (rows.length === 0) return `（${channel} 暂无资讯返回）`;
  return `华尔街见闻资讯流 · ${channel} · ${rows.length}条\n\n${rows.join('\n')}`;
}

async function main(): Promise<void> {
  const server = new Server({ name: 'wallstreetcn', version: '1.0.0' }, { capabilities: { tools: {} } });

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    try {
      let text: string;
      if (name === 'wallstreetcn_flash') text = await handleFlash(args ?? {});
      else if (name === 'wallstreetcn_news') text = await handleNews(args ?? {});
      else return { content: [{ type: 'text', text: `Unknown tool: ${name}` }], isError: true };
      return { content: [{ type: 'text', text }] };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log(`tool ${name} failed: ${msg}`);
      return { content: [{ type: 'text', text: `华尔街见闻接口调用失败：${msg}` }], isError: true };
    }
  });

  await server.connect(new StdioServerTransport());
  log(`started with tools: ${TOOLS.map((t) => t.name).join(', ')}`);
}

main().catch((err) => {
  log(`fatal: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
