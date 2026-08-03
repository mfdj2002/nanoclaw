/**
 * Turn-level retry on transient upstream failures.
 *
 * The bug these cover: a dropped socket between the provider and the model API
 * used to surface the raw error to the user and mark the batch completed, so the
 * message was gone. Reproducing that against a real network would be testing
 * Bun's fetch; what needs pinning down is our own behaviour when the provider
 * raises it — retry exactly the cases worth retrying, keep the conversation, and
 * say something useful when it really is dead.
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';

import { initTestSessionDb, closeSessionDb, getInboundDb } from './db/connection.js';
import { getUndeliveredMessages } from './db/messages-out.js';
import { getPendingMessages } from './db/messages-in.js';
import { setContinuation } from './db/session-state.js';
import { runPollLoop } from './poll-loop.js';
import type { AgentProvider, AgentQuery, ProviderEvent, QueryInput } from './providers/types.js';

/** Verbatim from a user report — the string the real provider raises. */
const SOCKET_ERROR = 'OpenCode retry limit (3): Cannot connect to API: The socket connection was closed unexpectedly.';

beforeEach(() => {
  initTestSessionDb();
  getInboundDb()
    .prepare(
      `INSERT INTO destinations (name, display_name, type, channel_type, platform_id, agent_group_id)
       VALUES ('discord-test', 'Discord Test', 'channel', 'discord', 'chan-1', NULL)`,
    )
    .run();
});

afterEach(() => {
  closeSessionDb();
});

function insertMessage(id: string): void {
  getInboundDb()
    .prepare(
      `INSERT INTO messages_in (id, kind, timestamp, status, platform_id, channel_type, thread_id, content)
       VALUES (?, 'chat', datetime('now'), 'pending', 'chan-1', 'discord', 'thread-1', ?)`,
    )
    .run(id, JSON.stringify({ sender: 'Alice', text: 'summarize this' }));
}

/**
 * Provider that fails a fixed number of leading attempts, then succeeds.
 * Records the continuation it was handed on every attempt so the test can prove
 * the retry resumed the conversation rather than starting a fresh one.
 */
class ScriptedProvider implements AgentProvider {
  readonly supportsNativeSlashCommands = false;
  attempts = 0;
  seenContinuations: Array<string | undefined> = [];

  constructor(
    private readonly failures: number,
    private readonly error: string,
    private readonly emitInit = false,
  ) {}

  isSessionInvalid(): boolean {
    return false; // Never disown the session — a dropped socket doesn't invalidate it.
  }

  query(input: QueryInput): AgentQuery {
    this.attempts++;
    this.seenContinuations.push(input.continuation);
    const attempt = this.attempts;
    const { failures, error, emitInit } = this;

    const events = (async function* (): AsyncGenerator<ProviderEvent> {
      if (emitInit) yield { type: 'init', continuation: 'sess-abc' };
      if (attempt <= failures) throw new Error(error);
      yield { type: 'result', text: 'here is the summary' };
    })();

    return { push() {}, end() {}, abort() {}, events };
  }
}

/**
 * Run the loop until it produces an outbound message (success or give-up), then
 * stop it. Condition-driven rather than a fixed sleep: the retry path contains a
 * real backoff, so a sleep long enough to be safe makes every test slow.
 */
async function runUntilOutput(provider: AgentProvider, timeoutMs = 8000): Promise<void> {
  const controller = new AbortController();
  const loop = Promise.race([
    runPollLoop({ provider, providerName: 'mock', cwd: '/tmp' }),
    new Promise<void>((_, reject) => controller.signal.addEventListener('abort', () => reject(new Error('done')))),
  ]).catch(() => {});
  const start = Date.now();
  while (getUndeliveredMessages().length === 0) {
    if (Date.now() - start > timeoutMs) break;
    await new Promise((r) => setTimeout(r, 25));
  }
  // Let the loop finish marking the batch completed before we cut it off.
  await new Promise((r) => setTimeout(r, 50));
  controller.abort();
  await loop;
}

const textsOf = (): string[] => getUndeliveredMessages().map((m) => JSON.parse(m.content).text as string);

describe('poll loop — transient upstream failures', () => {
  it(
    'retries a dropped socket and delivers the answer, with no error shown to the user',
    async () => {
      insertMessage('m1');
      const provider = new ScriptedProvider(1, SOCKET_ERROR);

      await runUntilOutput(provider);

      expect(provider.attempts).toBe(2);
      const texts = textsOf();
      expect(texts).toContain('here is the summary');
      // The whole point: the user never sees the transport failure.
      expect(texts.some((t) => t.includes('socket connection') || t.startsWith('Error:'))).toBe(false);
    },
    10_000,
  );

  it(
    'keeps an established conversation across the retry',
    async () => {
      // The case that matters: a turn fails partway through an ongoing
      // conversation. Losing the continuation here would silently drop all prior
      // history, which is far worse than the dropped socket itself.
      setContinuation('mock', 'sess-prior');
      insertMessage('m1');
      const provider = new ScriptedProvider(1, SOCKET_ERROR);

      await runUntilOutput(provider);

      expect(provider.attempts).toBe(2);
      expect(provider.seenContinuations).toEqual(['sess-prior', 'sess-prior']);
    },
    10_000,
  );

  it(
    'starts a fresh session when the failed attempt was the one creating it',
    async () => {
      // No prior continuation, and attempt 1 dies after establishing one. The
      // retry deliberately does NOT resume that session: it holds nothing but a
      // half-finished turn, and the prompt is re-sent anyway. Pinned because it
      // looks like a lost continuation until you know it's intended.
      insertMessage('m1');
      const provider = new ScriptedProvider(1, SOCKET_ERROR, true);

      await runUntilOutput(provider);

      expect(provider.attempts).toBe(2);
      expect(provider.seenContinuations).toEqual([undefined, undefined]);
      expect(textsOf()).toContain('here is the summary');
    },
    10_000,
  );

  it(
    'gives up after the second failure with a message that says what to do',
    async () => {
      insertMessage('m1');
      const provider = new ScriptedProvider(Infinity, SOCKET_ERROR);

      await runUntilOutput(provider);

      expect(provider.attempts).toBe(2); // bounded — not an infinite retry loop
      const texts = textsOf();
      expect(texts).toHaveLength(1);
      expect(texts[0]).toContain('send it again');
      expect(texts[0]).not.toStartWith('Error:');
      // The batch is still completed, so the loop doesn't spin on a dead message.
      expect(getPendingMessages()).toHaveLength(0);
    },
    10_000,
  );

  it(
    'does not retry an error that re-running cannot fix',
    async () => {
      insertMessage('m1');
      const provider = new ScriptedProvider(Infinity, 'Invalid model id: nonexistent-model-9000');

      await runUntilOutput(provider);

      // Burning a second call on a request that cannot succeed is the failure
      // mode a blanket retry would introduce.
      expect(provider.attempts).toBe(1);
      expect(textsOf()[0]).toStartWith('Error:');
    },
    10_000,
  );
});
