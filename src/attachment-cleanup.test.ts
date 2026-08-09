/**
 * Retention sweep over inbox/outbox scratch dirs.
 *
 * The risk in a reaper is asymmetric: failing to delete wastes disk, deleting
 * too much loses a user's attachment. So most of these pin what must survive.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-reap-test-'));
vi.mock('./config.js', async (importActual) => ({
  ...(await importActual<typeof import('./config.js')>()),
  DATA_DIR: TMP,
}));

const { reapAgedAttachments, retentionDays, DEFAULT_RETENTION_DAYS } = await import('./attachment-cleanup.js');

const SESSIONS = path.join(TMP, 'v2-sessions');
const MS_PER_DAY = 24 * 60 * 60 * 1000;
const NOW = 1_800_000_000_000;

/** Create `<group>/<session>/<kind>/<msgId>/file.md`, aged `ageDays` old. */
function seed(kind: string, msgId: string, ageDays: number): string {
  const dir = path.join(SESSIONS, 'ag-1', 'sess-1', kind, msgId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'file.md'), 'x');
  const t = new Date(NOW - ageDays * MS_PER_DAY);
  fs.utimesSync(dir, t, t);
  return dir;
}

beforeEach(() => {
  fs.rmSync(SESSIONS, { recursive: true, force: true });
  delete process.env.INBOX_RETENTION_DAYS;
});

afterEach(() => {
  fs.rmSync(SESSIONS, { recursive: true, force: true });
  delete process.env.INBOX_RETENTION_DAYS;
});

describe('reapAgedAttachments', () => {
  it('removes directories older than the retention window', () => {
    const old = seed('inbox', 'msg-old', 45);

    expect(reapAgedAttachments(30, NOW)).toBe(1);
    expect(fs.existsSync(old)).toBe(false);
  });

  it('keeps anything inside the window', () => {
    const recent = seed('inbox', 'msg-recent', 29);

    expect(reapAgedAttachments(30, NOW)).toBe(0);
    expect(fs.existsSync(recent)).toBe(true);
  });

  it('reaps the outbox too, not just the inbox', () => {
    // Same lifetime, same growth — covering only one leaves a silent leak.
    const inbox = seed('inbox', 'msg-a', 40);
    const outbox = seed('outbox', 'msg-b', 40);

    expect(reapAgedAttachments(30, NOW)).toBe(2);
    expect(fs.existsSync(inbox)).toBe(false);
    expect(fs.existsSync(outbox)).toBe(false);
  });

  it('leaves the inbox and outbox roots in place', () => {
    // The host writes straight into these; removing them would turn the next
    // attachment into an error instead of a file.
    seed('inbox', 'msg-old', 40);
    reapAgedAttachments(30, NOW);

    expect(fs.existsSync(path.join(SESSIONS, 'ag-1', 'sess-1', 'inbox'))).toBe(true);
  });

  it('never touches the session DBs or the agent workspace', () => {
    const sess = path.join(SESSIONS, 'ag-1', 'sess-1');
    fs.mkdirSync(path.join(sess, 'agent'), { recursive: true });
    const db = path.join(sess, 'inbound.db');
    const work = path.join(sess, 'agent', 'CLAUDE.local.md');
    fs.writeFileSync(db, 'db');
    fs.writeFileSync(work, 'memory');
    const t = new Date(NOW - 400 * MS_PER_DAY);
    fs.utimesSync(db, t, t);
    fs.utimesSync(work, t, t);
    seed('inbox', 'msg-old', 40);

    reapAgedAttachments(30, NOW);

    // Ancient, but not attachment scratch — the agent's memory lives here.
    expect(fs.existsSync(db)).toBe(true);
    expect(fs.existsSync(work)).toBe(true);
  });

  it('does nothing when retention is zero', () => {
    const old = seed('inbox', 'msg-old', 400);

    expect(reapAgedAttachments(0, NOW)).toBe(0);
    expect(fs.existsSync(old)).toBe(true);
  });

  it('is a no-op when no sessions exist yet', () => {
    expect(reapAgedAttachments(30, NOW)).toBe(0);
  });

  it('sweeps every session of every agent group', () => {
    fs.mkdirSync(path.join(SESSIONS, 'ag-2', 'sess-9', 'inbox', 'msg-z'), { recursive: true });
    const other = path.join(SESSIONS, 'ag-2', 'sess-9', 'inbox', 'msg-z');
    const t = new Date(NOW - 90 * MS_PER_DAY);
    fs.utimesSync(other, t, t);
    seed('inbox', 'msg-old', 90);

    expect(reapAgedAttachments(30, NOW)).toBe(2);
  });
});

describe('retentionDays', () => {
  it('defaults to 30 when unset', () => {
    expect(retentionDays()).toBe(DEFAULT_RETENTION_DAYS);
  });

  it('honours an explicit value', () => {
    process.env.INBOX_RETENTION_DAYS = '7';
    expect(retentionDays()).toBe(7);
  });

  it('treats 0 as an explicit opt-out rather than a missing value', () => {
    process.env.INBOX_RETENTION_DAYS = '0';
    expect(retentionDays()).toBe(0);
  });

  it('falls back to the default on garbage rather than deleting everything', () => {
    // A typo must not resolve to 0-and-reap or NaN-and-reap.
    process.env.INBOX_RETENTION_DAYS = 'thirty';
    expect(retentionDays()).toBe(DEFAULT_RETENTION_DAYS);
  });
});
