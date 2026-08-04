/**
 * The preflight's job is to be *loud and non-fatal*. Both halves matter: a
 * gateway that is down silently queues every message, but aborting startup over
 * it would feed the crash-loop circuit breaker and delay recovery by minutes.
 */
import http from 'http';
import type { AddressInfo } from 'net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let server: http.Server | null = null;

/** Real listener rather than a fetch mock — the failure being guarded against is
 *  transport-level (ECONNREFUSED), which a mock would paper over. */
async function startServer(status: number): Promise<string> {
  server = http.createServer((req, res) => {
    res.writeHead(req.url === '/health' ? status : 404);
    res.end();
  });
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${(server!.address() as AddressInfo).port}`;
}

/** A port nobody is listening on, to get a genuine ECONNREFUSED. */
async function deadPort(): Promise<number> {
  const s = http.createServer();
  await new Promise<void>((resolve) => s.listen(0, '127.0.0.1', resolve));
  const port = (s.address() as AddressInfo).port;
  await new Promise<void>((resolve) => s.close(() => resolve()));
  return port;
}

async function deadUrl(): Promise<string> {
  return `http://127.0.0.1:${await deadPort()}`;
}

/** Bring a gateway up on a known port, the way a successful `onecli start` would. */
function listenOn(port: number): void {
  server = http.createServer((req, res) => {
    res.writeHead(req.url === '/health' ? 200 : 404);
    res.end();
  });
  server.listen(port, '127.0.0.1');
}

async function loadWith(url: string | undefined, execFileSync: () => void) {
  vi.resetModules();
  vi.doMock('./config.js', async (importActual) => ({
    ...(await importActual<typeof import('./config.js')>()),
    ONECLI_URL: url,
  }));
  vi.doMock('child_process', () => ({ execFileSync, default: { execFileSync } }));
  return import('./onecli-health.js');
}

beforeEach(() => {
  vi.restoreAllMocks();
});

afterEach(async () => {
  if (server) {
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = null;
  }
  vi.doUnmock('./config.js');
  vi.doUnmock('child_process');
  vi.resetModules();
});

describe('isOneCLIHealthy', () => {
  it('is true when /health answers 200', async () => {
    const url = await startServer(200);
    const { isOneCLIHealthy } = await loadWith(url, () => {});
    expect(await isOneCLIHealthy(url)).toBe(true);
  });

  it('is false when nothing is listening', async () => {
    const url = await deadUrl();
    const { isOneCLIHealthy } = await loadWith(url, () => {});
    expect(await isOneCLIHealthy(url)).toBe(false);
  });

  it('is false when the port answers but the gateway is unhealthy', async () => {
    // Something else squatting the port must not read as a working gateway.
    const url = await startServer(503);
    const { isOneCLIHealthy } = await loadWith(url, () => {});
    expect(await isOneCLIHealthy(url)).toBe(false);
  });
});

describe('ensureOneCLIRunning', () => {
  it('does not try to start anything when the gateway is already up', async () => {
    const url = await startServer(200);
    const execFileSync = vi.fn();
    const { ensureOneCLIRunning } = await loadWith(url, execFileSync);

    await ensureOneCLIRunning();

    expect(execFileSync).not.toHaveBeenCalled();
  });

  it('skips entirely when no gateway is configured', async () => {
    // The native-credential-proxy install has no ONECLI_URL; warning there would
    // be noise about a component that install doesn't have.
    const execFileSync = vi.fn();
    const { ensureOneCLIRunning } = await loadWith(undefined, execFileSync);

    await ensureOneCLIRunning();

    expect(execFileSync).not.toHaveBeenCalled();
  });

  it('starts a down gateway and returns as soon as it is healthy', async () => {
    // The full recovery path: down → `onecli start` → poll → up. The mock brings
    // a real listener up on the same port, so readiness is observed rather than
    // assumed.
    const port = await deadPort();
    const execFileSync = vi.fn(() => listenOn(port));
    const { ensureOneCLIRunning } = await loadWith(`http://127.0.0.1:${port}`, execFileSync);

    const started = Date.now();
    await ensureOneCLIRunning();

    expect(execFileSync).toHaveBeenCalledWith('onecli', ['start'], expect.anything());
    // Returns on readiness, not after burning the whole 15s budget.
    expect(Date.now() - started).toBeLessThan(5000);
  });

  it('does not throw when `onecli start` itself fails', async () => {
    // Startup must continue: messages queue and the 60s sweep drains them once
    // the gateway returns. Aborting here would trip the crash-loop breaker.
    const url = await deadUrl();
    const { ensureOneCLIRunning } = await loadWith(url, () => {
      throw Object.assign(new Error('Command failed'), { status: 1, stderr: Buffer.from('vault locked') });
    });

    await expect(ensureOneCLIRunning()).resolves.toBeUndefined();
  });

  it('does not throw when the CLI is missing entirely', async () => {
    const url = await deadUrl();
    const { ensureOneCLIRunning } = await loadWith(url, () => {
      throw Object.assign(new Error('spawn onecli ENOENT'), { code: 'ENOENT' });
    });

    await expect(ensureOneCLIRunning()).resolves.toBeUndefined();
  });
});
