/**
 * Obsidian channel — multi-session local channel for the Nanoclaw Obsidian plugin.
 *
 * Unlike the `cli` channel (single terminal, one shared session), this is a
 * proper thread-aware adapter: every message carries a `threadId` (one per chat
 * tab), so the router gives each thread its own session → its own container, and
 * `deliver()` routes each reply back tagged with the same `threadId`. The plugin
 * keeps ONE socket connection and multiplexes all tabs over it by `threadId` —
 * no single-client chat slot, no cross-talk.
 *
 * Listens on `data/obsidian.sock` (chmod 0600). Wire format: one JSON object
 * per line, in both directions:
 *
 *   plugin → daemon:  { "threadId": "tab-abc", "text": "user message",
 *                       "attachments": [{ "name": "spec.pdf", "data": "<base64>" }] }
 *   daemon → plugin:  { "threadId": "tab-abc", "text": "agent reply", "kind": "final",
 *                       "files": [{ "name": "report.md", "data": "<base64>" }] }
 *
 * `threadId` null/absent collapses to a single default thread. Multiple plugin
 * connections (e.g. two Obsidian windows) are allowed; replies broadcast to all
 * live connections and each demuxes by threadId.
 *
 * Attachments and files are optional on both sides. Inbound ones ride the same
 * path as every other channel's: the router hands `content.attachments` to
 * `extractAttachmentFiles`, which writes each to `<session>/inbox/<msgId>/` and
 * rewrites the entry to a `localPath` the agent is told about verbatim. Outbound
 * ones come from the `send_file` MCP tool via the session outbox; the plugin
 * writes them into the vault, which is what makes agent-authored files findable
 * without the user having to know any container path.
 */
import fs from 'fs';
import net from 'net';
import path from 'path';

import { DATA_DIR } from '../config.js';
import { log } from '../log.js';
import type { ChannelAdapter, ChannelSetup, OutboundMessage } from './adapter.js';
import { registerChannelAdapter } from './channel-registry.js';
import { handleMcpControl, isMcpControl, type McpControl } from './obsidian-mcp.js';

const PLATFORM_ID = 'local';

function socketPath(): string {
  return path.join(DATA_DIR, 'obsidian.sock');
}

function createAdapter(): ChannelAdapter {
  let server: net.Server | null = null;
  const clients = new Set<net.Socket>();

  const adapter: ChannelAdapter = {
    name: 'obsidian',
    channelType: 'obsidian',
    supportsThreads: true,

    async setup(config: ChannelSetup): Promise<void> {
      const sock = socketPath();
      try {
        fs.unlinkSync(sock);
      } catch (err) {
        const e = err as NodeJS.ErrnoException;
        if (e.code !== 'ENOENT') log.warn('Failed to unlink stale obsidian socket (binding anyway)', { sock, err });
      }

      server = net.createServer((socket) => handleConnection(socket, config));
      await new Promise<void>((resolve, reject) => {
        server!.once('error', reject);
        server!.listen(sock, () => {
          try {
            fs.chmodSync(sock, 0o600);
          } catch (err) {
            log.warn('Failed to chmod obsidian socket (continuing)', { sock, err });
          }
          log.info('Obsidian channel listening', { sock });
          resolve();
        });
      });
    },

    async teardown(): Promise<void> {
      for (const c of clients) {
        try {
          c.end();
        } catch {
          /* best-effort */
        }
      }
      clients.clear();
      if (server) {
        await new Promise<void>((resolve) => server!.close(() => resolve()));
        server = null;
      }
      try {
        fs.unlinkSync(socketPath());
      } catch {
        /* swallow */
      }
    },

    isConnected(): boolean {
      return server !== null;
    },

    // Route a reply back to the plugin, tagged with its threadId. Broadcast to
    // all live connections (each demuxes by threadId). No-ops if nobody's
    // connected — the outbound row is already persisted in the session DB.
    async deliver(platformId, threadId, message: OutboundMessage): Promise<string | undefined> {
      if (platformId !== PLATFORM_ID) return undefined;
      const text = extractText(message);
      // A `send_file` row can carry files with no covering text — deliver it
      // anyway, or the file silently never reaches the vault.
      const files = (message.files ?? []).map((f) => ({
        name: f.filename,
        data: f.data.toString('base64'),
      }));
      if (text === null && files.length === 0) return undefined;
      // Reasoning/progress rows carry { progress: true } in content — tag them so
      // the plugin renders a foldable "thinking" block instead of an answer.
      const content = message.content as Record<string, unknown> | undefined;
      const isThinking = !!content && typeof content === 'object' && content.progress === true;
      const line =
        JSON.stringify({
          threadId: threadId ?? null,
          text: text ?? '',
          kind: isThinking ? 'thinking' : 'final',
          ...(files.length > 0 ? { files } : {}),
        }) + '\n';
      for (const c of clients) {
        try {
          c.write(line);
        } catch (err) {
          log.warn('Failed to write to obsidian client', { err });
        }
      }
      return undefined;
    },
  };

  // Write one framed line to every live plugin connection (each demuxes by
  // threadId). Used for control-message acks (deliver() handles outbound rows).
  function sendLine(threadId: string | null, text: string, kind: 'final' | 'thinking' = 'final'): void {
    const line = JSON.stringify({ threadId: threadId ?? null, text, kind }) + '\n';
    for (const c of clients) {
      try {
        c.write(line);
      } catch (err) {
        log.warn('Failed to write to obsidian client', { err });
      }
    }
  }

  function handleConnection(socket: net.Socket, config: ChannelSetup): void {
    clients.add(socket);
    log.info('Obsidian client connected', { clients: clients.size });

    let buffer = '';
    // Set once a line has outgrown MAX_LINE_BYTES: the rest of it is dropped up
    // to the next newline, then framing resumes. Line framing otherwise lets an
    // unterminated line grow the buffer without bound — reachable by accident
    // now that attachments ride this socket (someone drags in a video). Skipping
    // the line rather than dropping the connection keeps the plugin's in-flight
    // turn alive, so it fails fast instead of hanging until its turn timeout.
    let skippingOversizeLine = false;
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8');

      if (skippingOversizeLine) {
        const nl = buffer.indexOf('\n');
        if (nl < 0) {
          buffer = '';
          return;
        }
        buffer = buffer.slice(nl + 1);
        skippingOversizeLine = false;
      }

      let idx: number;
      while ((idx = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, idx).trim();
        buffer = buffer.slice(idx + 1);
        if (line) void handleLine(line, config);
      }

      // No newline in what's left and it's already too big to ever be valid.
      if (buffer.length > MAX_LINE_BYTES) {
        log.warn('Obsidian: line exceeded limit, skipping it', { limit: MAX_LINE_BYTES, buffered: buffer.length });
        buffer = '';
        skippingOversizeLine = true;
        sendLine(
          null,
          `⚠ That message was too large to accept (limit ${Math.floor(MAX_LINE_BYTES / 1024 / 1024)}MB) and was dropped.`,
        );
      }
    });
    socket.on('close', () => {
      clients.delete(socket);
      log.info('Obsidian client disconnected', { clients: clients.size });
    });
    socket.on('error', (err) => log.warn('Obsidian client socket error', { err }));
  }

  async function handleLine(line: string, config: ChannelSetup): Promise<void> {
    let payload: {
      type?: unknown;
      threadId?: unknown;
      text?: unknown;
      server?: unknown;
      spec?: unknown;
      attachments?: unknown;
    };
    try {
      payload = JSON.parse(line);
    } catch {
      log.warn('Obsidian: ignoring non-JSON line', { line });
      return;
    }
    const threadId = typeof payload.threadId === 'string' && payload.threadId.length > 0 ? payload.threadId : null;

    // Control messages (connect/list/disconnect MCP) — handled host-side, acked
    // back to the originating tab. Must run before the text-required check below.
    if (isMcpControl(payload)) {
      try {
        await handleMcpControl(payload as McpControl, (text) => sendLine(threadId, text));
      } catch (err) {
        log.error('Obsidian: MCP control handler threw', { err });
        sendLine(threadId, `❌ MCP 操作失败：${err instanceof Error ? err.message : String(err)}`);
      }
      return;
    }

    const attachments = sanitizeAttachments(payload.attachments);

    // An attachment-only message is legitimate ("look at this"), so require text
    // only when nothing came with it.
    const text = typeof payload.text === 'string' ? payload.text : '';
    if (text.length === 0 && attachments.length === 0) return;

    try {
      await config.onInbound(PLATFORM_ID, threadId, {
        id: `obs-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        kind: 'chat',
        timestamp: new Date().toISOString(),
        content: {
          text,
          sender: 'obsidian',
          senderId: `obsidian:${PLATFORM_ID}`,
          ...(attachments.length > 0 ? { attachments } : {}),
        },
      });
    } catch (err) {
      log.error('Obsidian: onInbound threw', { err });
    }
  }

  return adapter;
}

/** Caps on a single inbound message. The socket is 0600 and local, so this is
 *  bounding accidents (a user dragging in a video) rather than an attacker: the
 *  whole line is already buffered in memory before we see it. */
const MAX_ATTACHMENTS = 20;
const MAX_ATTACHMENT_BYTES = 32 * 1024 * 1024;
/** Headroom over MAX_ATTACHMENT_BYTES for base64 expansion (~4/3) plus JSON
 *  overhead, so a legitimate at-the-limit attachment still gets through. */
const MAX_LINE_BYTES = 48 * 1024 * 1024;

/**
 * Keep only well-formed `{ name, data }` entries. Filename safety and the write
 * itself are the host's job (`extractAttachmentFiles` in session-manager.ts,
 * which rejects traversal and refuses to follow pre-placed symlinks) — this pass
 * only drops entries that aren't attachments at all and enforces size limits.
 */
function sanitizeAttachments(raw: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(raw)) return [];
  const out: Array<Record<string, unknown>> = [];
  for (const entry of raw) {
    if (out.length >= MAX_ATTACHMENTS) {
      log.warn('Obsidian: dropping attachments beyond cap', { cap: MAX_ATTACHMENTS });
      break;
    }
    if (!entry || typeof entry !== 'object') continue;
    const att = entry as Record<string, unknown>;
    if (typeof att.data !== 'string' || att.data.length === 0) continue;
    // base64 decodes to ~3/4 of its length; check before allocating a Buffer.
    const approxBytes = Math.floor((att.data.length * 3) / 4);
    if (approxBytes > MAX_ATTACHMENT_BYTES) {
      log.warn('Obsidian: attachment too large, dropping', { name: att.name, approxBytes });
      continue;
    }
    out.push({
      name: typeof att.name === 'string' && att.name ? att.name : 'attachment',
      data: att.data,
      size: approxBytes,
      ...(typeof att.type === 'string' ? { type: att.type } : {}),
    });
  }
  return out;
}

function extractText(message: OutboundMessage): string | null {
  const content = message.content as Record<string, unknown> | string | undefined;
  if (typeof content === 'string') return content;
  if (content && typeof content === 'object' && typeof content.text === 'string') return content.text;
  return null;
}

registerChannelAdapter('obsidian', { factory: createAdapter });
