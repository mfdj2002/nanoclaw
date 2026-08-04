/**
 * Startup preflight for the OneCLI credential gateway.
 *
 * Every container spawn calls `onecli.ensureAgent()` (container-runner.ts) to
 * provision the agent in the vault, because API keys deliberately never live in
 * `.env`. So a gateway that isn't listening means no container starts at all —
 * but the symptom is only a per-session `wakeContainer failed … fetch failed`
 * warning in the error log, while inbound messages queue and the user watches a
 * chat client spin forever.
 *
 * The container-runtime preflight next door catches the equivalent Docker
 * failure loudly. This is its counterpart, with one deliberate difference: it
 * warns instead of aborting. A missing runtime is unrecoverable, whereas the
 * host sweep retries wakes every 60s, so a gateway that comes up later drains
 * the queue on its own. Aborting would instead feed the crash-loop circuit
 * breaker and delay startup by five minutes.
 *
 * Deployment-agnostic on purpose: recovery goes through `onecli start`, the
 * interface OneCLI documents, so this works whether the gateway is a plain
 * binary or a container. Nothing here reaches into Docker.
 */
import { execFileSync } from 'child_process';

import { ONECLI_URL } from './config.js';
import { log } from './log.js';

const PROBE_TIMEOUT_MS = 2000;
const START_TIMEOUT_MS = 20_000;
const READY_POLL_MS = 500;
/** Matches the readiness poll documented in the /init-onecli skill. */
const READY_WAIT_MS = 15_000;

/** Is the gateway answering? Any transport failure counts as "no". */
export async function isOneCLIHealthy(url: string): Promise<boolean> {
  try {
    const res = await fetch(new URL('/health', url), { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
    return res.ok;
  } catch {
    return false;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForHealthy(url: string, budgetMs: number): Promise<boolean> {
  const deadline = Date.now() + budgetMs;
  while (Date.now() < deadline) {
    if (await isOneCLIHealthy(url)) return true;
    await sleep(READY_POLL_MS);
  }
  return false;
}

/**
 * Try `onecli start`. Returns false when the CLI isn't installed or refuses,
 * with the reason logged — the caller only needs to know whether it's worth
 * waiting for readiness afterwards.
 */
function tryStartGateway(): boolean {
  try {
    execFileSync('onecli', ['start'], { timeout: START_TIMEOUT_MS, stdio: 'pipe' });
    return true;
  } catch (err) {
    const e = err as NodeJS.ErrnoException & { stderr?: Buffer };
    if (e.code === 'ENOENT') {
      // launchd gives the daemon a minimal PATH; setup/service.ts adds
      // ~/.local/bin (where the CLI installer puts it) for exactly this reason.
      log.warn('`onecli` not found on PATH — cannot auto-start the gateway', { path: process.env.PATH });
      return false;
    }
    log.warn('`onecli start` failed', { err: e.stderr?.toString().trim() || e.message });
    return false;
  }
}

/**
 * Check the gateway, start it if it's down, and report clearly if it stays
 * down. Never throws — a broken gateway degrades the install, it doesn't
 * invalidate it.
 */
export async function ensureOneCLIRunning(): Promise<void> {
  if (!ONECLI_URL) {
    // Installs using the built-in credential proxy (/use-native-credential-proxy)
    // have no gateway, and nothing here applies.
    log.debug('ONECLI_URL not configured — skipping gateway preflight');
    return;
  }

  if (await isOneCLIHealthy(ONECLI_URL)) {
    log.info('OneCLI gateway is healthy', { url: ONECLI_URL });
    return;
  }

  log.warn('OneCLI gateway not reachable — attempting to start it', { url: ONECLI_URL });

  if (tryStartGateway() && (await waitForHealthy(ONECLI_URL, READY_WAIT_MS))) {
    log.info('OneCLI gateway started', { url: ONECLI_URL });
    return;
  }

  // Loud, because the alternative is a silent queue: agents never spawn, and the
  // only other trace is a repeating wakeContainer warning further down the log.
  log.error(
    [
      '',
      '╔════════════════════════════════════════════════════════════════╗',
      '║  OneCLI gateway is NOT running                                 ║',
      '║                                                                ║',
      '║  Agents cannot start: every container spawn needs the vault    ║',
      '║  to inject credentials. Messages will QUEUE until it is up.    ║',
      '║                                                                ║',
      '║  To fix:                                                       ║',
      '║  1. Run: onecli start                                          ║',
      `║  2. Check: curl -sf ${ONECLI_URL}/health`.padEnd(65) + '║',
      '║  3. Queued messages resume automatically (60s sweep) —         ║',
      '║     no restart or resend needed.                               ║',
      '╚════════════════════════════════════════════════════════════════╝',
      '',
    ].join('\n'),
  );
}
