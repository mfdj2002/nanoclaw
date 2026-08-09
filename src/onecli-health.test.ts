/**
 * The check's job is to be *accurate and non-fatal*, in that order.
 *
 * The first version of this shipped a false alarm: it required 2xx from
 * `/health`, which 404s on OneCLI 2.2.0, so a perfectly healthy gateway was
 * reported as down. A check that cries wolf is worse than no check, so most of
 * these pin "does not report a reachable gateway as down".
 */
import http from 'http';
import type { AddressInfo } from 'net';
import { afterEach, describe, expect, it, vi } from 'vitest';

let server: http.Server | null = null;

/** Real listener rather than a fetch mock — the failure being guarded against is
 *  transport-level (ECONNREFUSED), which a mock would paper over. */
async function startServer(handler: (url: string) => number): Promise<string> {
  server = http.createServer((req, res) => {
    res.writeHead(handler(req.url ?? ''));
    res.end();
  });
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${(server!.address() as AddressInfo).port}`;
}

/** A port nobody is listening on, for a genuine ECONNREFUSED. */
async function deadUrl(): Promise<string> {
  const s = http.createServer();
  await new Promise<void>((resolve) => s.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(s.address() as AddressInfo).port}`;
  await new Promise<void>((resolve) => s.close(() => resolve()));
  return url;
}

async function loadWith(url: string | undefined) {
  vi.resetModules();
  vi.doMock('./config.js', async (importActual) => ({
    ...(await importActual<typeof import('./config.js')>()),
    ONECLI_URL: url,
  }));
  return import('./onecli-health.js');
}

afterEach(async () => {
  if (server) {
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = null;
  }
  vi.doUnmock('./config.js');
  vi.resetModules();
});

describe('probeOneCLI', () => {
  it('reports listening when /api/health answers 200', async () => {
    const url = await startServer((u) => (u === '/api/health' ? 200 : 404));
    const { probeOneCLI } = await loadWith(url);

    expect(await probeOneCLI(url)).toEqual({ listening: true, status: 200 });
  });

  it('still reports listening when the health endpoint has moved', async () => {
    // The regression that shipped: OneCLI 2.2.0 serves /api/health and 404s
    // /health. Requiring 2xx turned a working gateway into a scary banner.
    const url = await startServer(() => 404);
    const { probeOneCLI } = await loadWith(url);

    const probe = await probeOneCLI(url);
    expect(probe.listening).toBe(true);
    expect(probe.status).toBe(404);
  });

  it('reports not listening when nothing is bound to the port', async () => {
    const url = await deadUrl();
    const { probeOneCLI } = await loadWith(url);

    expect(await probeOneCLI(url)).toEqual({ listening: false });
  });
});

describe('checkOneCLIGateway', () => {
  it('does not throw when the gateway is down', async () => {
    // Startup must continue: messages queue and the 60s sweep drains them once
    // the gateway returns. Aborting would trip the crash-loop breaker.
    const url = await deadUrl();
    const { checkOneCLIGateway } = await loadWith(url);

    await expect(checkOneCLIGateway()).resolves.toBeUndefined();
  });

  it('does not throw when the gateway is up', async () => {
    const url = await startServer(() => 200);
    const { checkOneCLIGateway } = await loadWith(url);

    await expect(checkOneCLIGateway()).resolves.toBeUndefined();
  });

  it('skips entirely when no gateway is configured', async () => {
    // The native-credential-proxy install has no ONECLI_URL.
    const { checkOneCLIGateway } = await loadWith(undefined);

    await expect(checkOneCLIGateway()).resolves.toBeUndefined();
  });

  it('never shells out — the CLI has no command that starts the gateway', async () => {
    // onecli 2.2.0 exposes run/agents/secrets/rules/projects/auth/config only.
    // The previous version called `onecli start`, which failed with
    // "unexpected argument start" and then falsely declared the gateway down.
    const execFileSync = vi.fn();
    vi.doMock('child_process', () => ({ execFileSync, default: { execFileSync } }));
    const url = await deadUrl();
    const { checkOneCLIGateway } = await loadWith(url);

    await checkOneCLIGateway();

    expect(execFileSync).not.toHaveBeenCalled();
    vi.doUnmock('child_process');
  });
});
