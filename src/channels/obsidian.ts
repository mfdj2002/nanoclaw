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
 *   plugin → daemon:  { "threadId": "tab-abc", "text": "user message" }
 *   daemon → plugin:  { "threadId": "tab-abc", "text": "agent reply" }
 *
 * `threadId` null/absent collapses to a single default thread. Multiple plugin
 * connections (e.g. two Obsidian windows) are allowed; replies broadcast to all
 * live connections and each demuxes by threadId.
 */
import fs from 'fs';
import net from 'net';
import path from 'path';

import { DATA_DIR } from '../config.js';
import { log } from '../log.js';
import type { ChannelAdapter, ChannelSetup, OutboundMessage } from './adapter.js';
import { registerChannelAdapter } from './channel-registry.js';

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
      if (text === null) return undefined;
      // Reasoning/progress rows carry { progress: true } in content — tag them so
      // the plugin renders a foldable "thinking" block instead of an answer.
      const content = message.content as Record<string, unknown> | undefined;
      const isThinking = !!content && typeof content === 'object' && content.progress === true;
      const line = JSON.stringify({ threadId: threadId ?? null, text, kind: isThinking ? 'thinking' : 'final' }) + '\n';
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

  function handleConnection(socket: net.Socket, config: ChannelSetup): void {
    clients.add(socket);
    log.info('Obsidian client connected', { clients: clients.size });

    let buffer = '';
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      let idx: number;
      while ((idx = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, idx).trim();
        buffer = buffer.slice(idx + 1);
        if (line) void handleLine(line, config);
      }
    });
    socket.on('close', () => {
      clients.delete(socket);
      log.info('Obsidian client disconnected', { clients: clients.size });
    });
    socket.on('error', (err) => log.warn('Obsidian client socket error', { err }));
  }

  async function handleLine(line: string, config: ChannelSetup): Promise<void> {
    let payload: { threadId?: unknown; text?: unknown };
    try {
      payload = JSON.parse(line);
    } catch {
      log.warn('Obsidian: ignoring non-JSON line', { line });
      return;
    }
    if (typeof payload.text !== 'string' || payload.text.length === 0) return;
    const threadId = typeof payload.threadId === 'string' && payload.threadId.length > 0 ? payload.threadId : null;

    try {
      await config.onInbound(PLATFORM_ID, threadId, {
        id: `obs-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        kind: 'chat',
        timestamp: new Date().toISOString(),
        content: { text: payload.text, sender: 'obsidian', senderId: `obsidian:${PLATFORM_ID}` },
      });
    } catch (err) {
      log.error('Obsidian: onInbound threw', { err });
    }
  }

  return adapter;
}

function extractText(message: OutboundMessage): string | null {
  const content = message.content as Record<string, unknown> | string | undefined;
  if (typeof content === 'string') return content;
  if (content && typeof content === 'object' && typeof content.text === 'string') return content.text;
  return null;
}

registerChannelAdapter('obsidian', { factory: createAdapter });
