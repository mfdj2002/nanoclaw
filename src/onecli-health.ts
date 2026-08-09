/**
 * Startup check for the OneCLI credential gateway.
 *
 * Every container spawn calls `onecli.ensureAgent()` (container-runner.ts) to
 * provision the agent in the vault, because API keys deliberately never live in
 * `.env`. So a gateway that isn't listening means no container starts at all —
 * but the symptom is only a per-session `wakeContainer failed … fetch failed`
 * warning in the error log, while inbound messages queue and the user watches a
 * chat client spin forever. This turns that into one loud line at startup.
 *
 * Detection only — it does NOT try to start the gateway. The `onecli` CLI (2.2.0)
 * manages agents, secrets, rules and projects; it has no `start`/`serve` command,
 * so there is nothing for nanoclaw to invoke. Whatever runs the gateway (its own
 * service, a container with a restart policy, a desktop app) is what has to bring
 * it back. Attempting a start here previously produced
 * `unexpected argument start` and a false "not running" banner.
 *
 * Warns rather than aborting: the host sweep retries wakes every 60s, so a
 * gateway that comes up later drains the queue by itself, whereas aborting would
 * feed the crash-loop circuit breaker and delay recovery by five minutes.
 */
import { ONECLI_URL } from './config.js';
import { log } from './log.js';

const PROBE_TIMEOUT_MS = 2000;

/**
 * `/api/health` on OneCLI 2.2.0. (`/health`, which the /init-onecli skill used
 * to suggest, 404s — a check that required 2xx from it reported a perfectly
 * healthy gateway as down.)
 */
const HEALTH_PATH = '/api/health';

export interface GatewayProbe {
  /** Something is bound to the port and speaking HTTP. */
  listening: boolean;
  /** HTTP status, when we got a response at all. */
  status?: number;
}

/**
 * Probe the gateway.
 *
 * Any HTTP response counts as listening, including a non-2xx one: the failure
 * this guards against is the process being absent (ECONNREFUSED), and treating
 * an unexpected status as "down" is exactly the false alarm that shipped the
 * first time. A moved or renamed endpoint should not read as an outage.
 */
export async function probeOneCLI(url: string): Promise<GatewayProbe> {
  try {
    const res = await fetch(new URL(HEALTH_PATH, url), { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
    return { listening: true, status: res.status };
  } catch {
    return { listening: false };
  }
}

/**
 * Report on the gateway at startup. Never throws — a missing gateway degrades
 * the install, it doesn't invalidate it.
 */
export async function checkOneCLIGateway(): Promise<void> {
  if (!ONECLI_URL) {
    // Installs on the built-in credential proxy (/use-native-credential-proxy)
    // have no gateway; warning would be noise about a component they don't have.
    log.debug('ONECLI_URL not configured — skipping gateway check');
    return;
  }

  const { listening, status } = await probeOneCLI(ONECLI_URL);

  if (listening) {
    if (status !== undefined && status >= 400) {
      // Reachable, so agents will probably spawn; surfaced in case a future
      // version moves the endpoint again and this needs revisiting.
      log.info('OneCLI gateway reachable (unexpected health status)', { url: ONECLI_URL, status, path: HEALTH_PATH });
    } else {
      log.info('OneCLI gateway is healthy', { url: ONECLI_URL });
    }
    return;
  }

  // Loud, because the alternative is a silent queue: agents never spawn, and the
  // only other trace is a repeating wakeContainer warning further down the log.
  log.error(
    [
      '',
      '╔════════════════════════════════════════════════════════════════╗',
      '║  OneCLI gateway is NOT reachable                                ║',
      '║                                                                 ║',
      '║  Agents cannot start: every container spawn needs the vault     ║',
      '║  to inject credentials. Messages will QUEUE until it is up.     ║',
      '║                                                                 ║',
      '║  The `onecli` CLI cannot start it — that command only manages   ║',
      '║  agents and secrets. Start whatever hosts the gateway:          ║',
      '║    docker ps -a | grep -i onecli   → start that container       ║',
      '║    otherwise, the OneCLI service or app on this machine         ║',
      '║                                                                 ║',
      '║  Queued messages resume automatically (60s sweep) — no          ║',
      '║  restart or resend needed once it answers.                      ║',
      '╚════════════════════════════════════════════════════════════════╝',
      `  gateway: ${ONECLI_URL}${HEALTH_PATH}`,
      '',
    ].join('\n'),
  );
}
