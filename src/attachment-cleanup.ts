/**
 * Retention sweep for per-session attachment scratch dirs.
 *
 * `inbox/<messageId>/` (files a user attached) and `outbox/<messageId>/` (files
 * the agent sent back) are copies the host makes at message time. Nothing ever
 * removed them, so a heavy attachment user grows `data/v2-sessions/` without
 * bound — a 25MB PDF sent once is 25MB kept forever, and the same file re-sent
 * lands in a fresh per-message directory rather than replacing the old one.
 *
 * Both directories are covered: they have identical lifetimes and identical
 * growth, and reaping only one would leave the other as a silent leak.
 *
 * Retention is read from `.env` on every run rather than at import, so changing
 * it takes effect on the next pass (~1h) without restarting the daemon — the
 * Obsidian plugin exposes it as a setting and writing a value that needs a
 * restart to apply is a bad setting.
 */
import fs from 'fs';
import path from 'path';

import { DATA_DIR } from './config.js';
import { readEnvFile } from './env.js';
import { log } from './log.js';

export const DEFAULT_RETENTION_DAYS = 30;
/** Full scans are cheap but pointless at sweep cadence (60s); hourly is plenty
 *  for a 30-day policy. */
const RUN_INTERVAL_MS = 60 * 60 * 1000;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

let lastRunAt = 0;

/**
 * Retention in days. `0` (or negative) disables cleanup entirely — an explicit
 * opt-out, distinct from an unset value which takes the default.
 */
export function retentionDays(): number {
  const raw = process.env.INBOX_RETENTION_DAYS ?? readEnvFile(['INBOX_RETENTION_DAYS']).INBOX_RETENTION_DAYS;
  if (raw === undefined || raw === '') return DEFAULT_RETENTION_DAYS;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) {
    log.warn('Invalid INBOX_RETENTION_DAYS — using default', { raw, default: DEFAULT_RETENTION_DAYS });
    return DEFAULT_RETENTION_DAYS;
  }
  return n;
}

/**
 * Delete per-message attachment directories last modified more than `days` ago.
 * Returns how many were removed. Pure filesystem work — safe to call with no
 * containers running, and safe while they are: the directories are only read at
 * message time, and anything this old has long since been delivered.
 */
export function reapAgedAttachments(days: number, now = Date.now()): number {
  if (days <= 0) return 0;

  const sessionsRoot = path.join(DATA_DIR, 'v2-sessions');
  if (!fs.existsSync(sessionsRoot)) return 0;

  const cutoff = now - days * MS_PER_DAY;
  let removed = 0;

  for (const agentGroup of readDirSafe(sessionsRoot)) {
    for (const session of readDirSafe(path.join(sessionsRoot, agentGroup))) {
      for (const kind of ['inbox', 'outbox']) {
        const root = path.join(sessionsRoot, agentGroup, session, kind);
        for (const messageDir of readDirSafe(root)) {
          const target = path.join(root, messageDir);
          try {
            // lstat, not stat: never follow a symlink out of the session tree.
            const st = fs.lstatSync(target);
            if (!st.isDirectory() || st.mtimeMs > cutoff) continue;
            fs.rmSync(target, { recursive: true, force: true });
            removed++;
          } catch (err) {
            log.warn('Failed to reap attachment directory', { target, err });
          }
        }
      }
    }
  }

  return removed;
}

/** Hourly-throttled entry point for the host sweep. */
export function maybeReapAgedAttachments(now = Date.now()): void {
  if (now - lastRunAt < RUN_INTERVAL_MS) return;
  lastRunAt = now;

  const days = retentionDays();
  if (days <= 0) {
    log.debug('Attachment retention disabled (INBOX_RETENTION_DAYS=0)');
    return;
  }

  try {
    const removed = reapAgedAttachments(days, now);
    if (removed > 0) log.info('Reaped aged attachment directories', { removed, retentionDays: days });
  } catch (err) {
    log.error('Attachment cleanup failed', { err });
  }
}

/** Test seam — the throttle is module state. */
export function _resetAttachmentCleanupThrottle(): void {
  lastRunAt = 0;
}

function readDirSafe(dir: string): string[] {
  try {
    return fs.readdirSync(dir);
  } catch {
    return [];
  }
}
