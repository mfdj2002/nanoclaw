/**
 * Obsidian channel adapter — the wire, exercised over a real socket.
 *
 * Attachments and files are what make this worth testing end to end rather than
 * by calling handleLine directly: the failure modes live in the framing (a line
 * big enough to matter now that files ride this socket) and in the base64
 * round trip, neither of which a direct call would exercise.
 */
import fs from 'fs';
import net from 'net';
import os from 'os';
import path from 'path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

// DATA_DIR decides where the socket is bound, and it resolves from cwd — under
// vitest that is the repo root, whose data/obsidian.sock may belong to a running
// daemon. Bind in a temp dir instead of unlinking the real one.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-obsidian-test-'));

// Shrink the limits before the adapter module is loaded, so the cap and framing
// behaviour can be exercised with kilobytes instead of tens of megabytes.
process.env.NANOCLAW_OBSIDIAN_MAX_ATTACHMENT_MB = '1';
process.env.NANOCLAW_OBSIDIAN_MAX_LINE_MB = '2';
const MAX_ATTACHMENT_BYTES = 1024 * 1024;
const MAX_LINE_BYTES = 2 * 1024 * 1024;
vi.mock('../config.js', async (importActual) => ({
  ...(await importActual<typeof import('../config.js')>()),
  DATA_DIR: TMP,
}));

const { initChannelAdapters, getChannelAdapter, teardownChannelAdapters } = await import('./channel-registry.js');
await import('./obsidian.js');
import type { ChannelAdapter } from './adapter.js';

type Inbound = { threadId: string | null; content: Record<string, unknown> };

const inbound: Inbound[] = [];
let adapter: ChannelAdapter;
let sock: string;

beforeAll(async () => {
  await initChannelAdapters(() => ({
    onInbound: async (_platformId, threadId, message) => {
      inbound.push({ threadId, content: message.content as Record<string, unknown> });
    },
    onInboundEvent: () => {},
    onMetadata: () => {},
    onAction: () => {},
  }));
  adapter = getChannelAdapter('obsidian')!;
  sock = path.join(TMP, 'obsidian.sock');
});

afterAll(async () => {
  await teardownChannelAdapters();
  fs.rmSync(TMP, { recursive: true, force: true });
});

afterEach(() => {
  inbound.length = 0;
});

/** Open a client, run the body, close. Returns every line the daemon sent back. */
async function withClient(body: (write: (o: unknown) => Promise<void>) => Promise<void>): Promise<string[]> {
  const rx: string[] = [];
  const c = net.connect(sock);
  c.on('data', (b) => {
    for (const l of b.toString().split('\n')) if (l.trim()) rx.push(l.trim());
  });
  await new Promise<void>((resolve, reject) => {
    c.once('connect', () => resolve());
    c.once('error', reject);
  });
  const write = (o: unknown): Promise<void> =>
    new Promise((resolve) => c.write(JSON.stringify(o) + '\n', () => resolve()));
  try {
    await body(write);
  } finally {
    // Wait for the server to observe the close, or the adapter keeps the dead
    // socket in its client set and the next deliver() writes after FIN.
    const closed = new Promise<void>((resolve) => c.once('close', () => resolve()));
    c.destroy();
    await closed;
    await settle(50);
  }
  return rx;
}

const settle = (ms = 250): Promise<void> => new Promise((r) => setTimeout(r, ms));
const b64 = (s: string): string => Buffer.from(s).toString('base64');

describe('obsidian adapter — inbound', () => {
  it('passes attachments through for the host to write into the session inbox', async () => {
    await withClient(async (write) => {
      await write({
        threadId: 'tab-1',
        text: 'summarize',
        attachments: [{ name: 'spec.pdf', data: b64('%PDF hi'), type: 'application/pdf' }],
      });
      await settle();
    });

    expect(inbound).toHaveLength(1);
    const atts = inbound[0].content.attachments as Array<Record<string, unknown>>;
    expect(atts).toHaveLength(1);
    expect(atts[0].name).toBe('spec.pdf');
    expect(Buffer.from(atts[0].data as string, 'base64').toString()).toBe('%PDF hi');
  });

  it('accepts an attachment with no accompanying text', async () => {
    // "look at this" with nothing typed is a real message; requiring text would
    // silently drop it.
    await withClient(async (write) => {
      await write({ threadId: 'tab-2', attachments: [{ name: 'a.md', data: b64('# hi') }] });
      await settle();
    });

    expect(inbound).toHaveLength(1);
    expect(inbound[0].content.text).toBe('');
    expect((inbound[0].content.attachments as unknown[]).length).toBe(1);
  });

  it('ignores a message with neither text nor attachments', async () => {
    await withClient(async (write) => {
      await write({ threadId: 'tab-3', text: '' });
      await settle();
    });
    expect(inbound).toHaveLength(0);
  });

  it('caps the number of attachments per message', async () => {
    await withClient(async (write) => {
      await write({
        threadId: 'tab-4',
        text: 'lots',
        attachments: Array.from({ length: 25 }, (_, i) => ({ name: `f${i}.txt`, data: b64('x') })),
      });
      await settle();
    });

    expect((inbound[0].content.attachments as unknown[]).length).toBe(20);
  });

  it('drops an oversized attachment but keeps the message', async () => {
    await withClient(async (write) => {
      // Over the per-attachment cap, under the line cap.
      const over = 'A'.repeat(Math.floor((MAX_ATTACHMENT_BYTES * 4) / 3) + 10_000);
      await write({ threadId: 'tab-5', text: 'too big', attachments: [{ name: 'huge.bin', data: over }] });
      await settle(500);
    });

    expect(inbound).toHaveLength(1);
    expect(inbound[0].content.text).toBe('too big');
    expect(inbound[0].content.attachments).toBeUndefined();
  });

  it('passes a traversal filename through untouched for the host to sanitize', async () => {
    // Filename safety is the host's job (extractAttachmentFiles refuses to
    // escape the inbox). Sanitizing here too would hide a regression there.
    await withClient(async (write) => {
      await write({ threadId: 'tab-6', text: 'x', attachments: [{ name: '../../escape.txt', data: b64('hi') }] });
      await settle();
    });

    const atts = inbound[0].content.attachments as Array<Record<string, unknown>>;
    expect(atts[0].name).toBe('../../escape.txt');
  });

  it('skips an oversized line and recovers framing without dropping the connection', async () => {
    // Dropping the connection here would leave the plugin's in-flight turn
    // hanging until its 30-minute timeout, so the recovery matters more than
    // the rejection.
    const rx = await withClient(async (write) => {
      await write({
        threadId: 'big',
        text: 'x',
        attachments: [{ name: 'huge.bin', data: 'A'.repeat(MAX_LINE_BYTES + 100_000) }],
      });
      await write({ threadId: 'after', text: 'still here?' });
      await settle(1000);
    });

    expect(inbound.map((i) => i.threadId)).toContain('after');
    expect(rx.some((l) => l.includes('too large'))).toBe(true);
  }, 20_000);
});

describe('obsidian adapter — outbound', () => {
  it('sends files back as base64 alongside the reply', async () => {
    const rx = await withClient(async () => {
      await adapter.deliver('local', 'tab-9', {
        kind: 'chat',
        content: { text: 'here you go' },
        files: [{ filename: 'report.md', data: Buffer.from('# Report') }],
      });
      await settle();
    });

    const msg = JSON.parse(rx[0]);
    expect(msg.text).toBe('here you go');
    expect(msg.files).toHaveLength(1);
    expect(msg.files[0].name).toBe('report.md');
    expect(Buffer.from(msg.files[0].data, 'base64').toString()).toBe('# Report');
  });

  it('delivers a file that has no covering text', async () => {
    // send_file with no `text` — without this the file never reaches the vault.
    const rx = await withClient(async () => {
      await adapter.deliver('local', 'tab-9', {
        kind: 'chat',
        content: { text: '' },
        files: [{ filename: 'a.txt', data: Buffer.from('body') }],
      });
      await settle();
    });

    expect(rx).toHaveLength(1);
    expect(JSON.parse(rx[0]).files[0].name).toBe('a.txt');
  });

  it('omits the files key entirely when there are none', async () => {
    const rx = await withClient(async () => {
      await adapter.deliver('local', 'tab-9', { kind: 'chat', content: { text: 'plain' } });
      await settle();
    });

    expect(JSON.parse(rx[0]).files).toBeUndefined();
  });

  it('still tags reasoning rows as thinking', async () => {
    const rx = await withClient(async () => {
      await adapter.deliver('local', 'tab-9', { kind: 'chat', content: { text: 'pondering', progress: true } });
      await settle();
    });

    expect(JSON.parse(rx[0]).kind).toBe('thinking');
  });
});
