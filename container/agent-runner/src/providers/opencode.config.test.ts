import { describe, it, expect, beforeEach, afterEach } from 'bun:test';

import { buildOpenCodeConfig } from './opencode.js';

const ENV_KEYS = [
  'OPENCODE_PROVIDER',
  'OPENCODE_MODEL',
  'OPENCODE_SMALL_MODEL',
  'ANTHROPIC_BASE_URL',
  'OPENCODE_BASE_URL_MOONSHOTAI',
];

let saved: Record<string, string | undefined> = {};

beforeEach(() => {
  saved = {};
  for (const k of ENV_KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

/** The install-wide DeepSeek setup that every current install has in .env. */
function deepseekEnv(): void {
  process.env.OPENCODE_PROVIDER = 'deepseek';
  process.env.OPENCODE_MODEL = 'deepseek/deepseek-v4-pro';
  process.env.OPENCODE_SMALL_MODEL = 'deepseek/deepseek-chat';
  process.env.ANTHROPIC_BASE_URL = 'https://api.deepseek.com/v1';
}

const providerFor = (cfg: Record<string, unknown>, name: string): Record<string, unknown> =>
  (cfg.provider as Record<string, Record<string, unknown>>)[name];

describe('buildOpenCodeConfig — vendor + model resolution', () => {
  it('uses the env model when the group specifies none', () => {
    deepseekEnv();
    const cfg = buildOpenCodeConfig({});
    expect(cfg.model).toBe('deepseek/deepseek-v4-pro');
    expect(cfg.enabled_providers).toEqual(['deepseek']);
    expect(cfg.small_model).toBe('deepseek/deepseek-chat');
  });

  it('lets a per-group model override the install-wide env default', () => {
    deepseekEnv();
    const cfg = buildOpenCodeConfig({ model: 'deepseek/deepseek-chat' });
    expect(cfg.model).toBe('deepseek/deepseek-chat');
  });

  it('derives the vendor from a per-group `vendor/model` id', () => {
    deepseekEnv();
    const cfg = buildOpenCodeConfig({ model: 'moonshotai/kimi-k3' });
    expect(cfg.enabled_providers).toEqual(['moonshotai']);
    expect(providerFor(cfg, 'moonshotai')).toBeDefined();
    expect(providerFor(cfg, 'deepseek')).toBeUndefined();
  });

  it("does not send another vendor's model to the DeepSeek base URL", () => {
    deepseekEnv();
    const cfg = buildOpenCodeConfig({ model: 'moonshotai/kimi-k3' });
    // No baseURL at all → OpenCode's own registry supplies the vendor's host.
    // The bug this guards is inheriting api.deepseek.com for a Kimi model.
    const opts = providerFor(cfg, 'moonshotai').options as Record<string, unknown>;
    expect(opts.baseURL).toBeUndefined();
    expect(JSON.stringify(cfg)).not.toContain('api.deepseek.com');
  });

  it('honours a per-vendor base URL override', () => {
    deepseekEnv();
    process.env.OPENCODE_BASE_URL_MOONSHOTAI = 'https://api.moonshot.cn/v1';
    const cfg = buildOpenCodeConfig({ model: 'moonshotai/kimi-k3' });
    const opts = providerFor(cfg, 'moonshotai').options as Record<string, unknown>;
    expect(opts.baseURL).toBe('https://api.moonshot.cn/v1');
  });

  it("drops the small model when it belongs to a vendor that isn't enabled", () => {
    deepseekEnv();
    const cfg = buildOpenCodeConfig({ model: 'moonshotai/kimi-k3' });
    expect(cfg.small_model).toBeUndefined();
  });

  it('keeps the base URL for the vendor it was configured alongside', () => {
    deepseekEnv();
    const cfg = buildOpenCodeConfig({ model: 'deepseek/deepseek-v4-pro' });
    const opts = providerFor(cfg, 'deepseek').options as Record<string, unknown>;
    expect(opts.baseURL).toBe('https://api.deepseek.com/v1');
  });

  it('registers the model id without its vendor prefix', () => {
    deepseekEnv();
    const cfg = buildOpenCodeConfig({ model: 'moonshotai/kimi-k3' });
    const models = providerFor(cfg, 'moonshotai').models as Record<string, unknown>;
    expect(Object.keys(models)).toEqual(['kimi-k3']);
  });

  it('leaves anthropic unconfigured so the SDK default path applies', () => {
    const cfg = buildOpenCodeConfig({});
    expect(cfg.enabled_providers).toEqual(['anthropic']);
    expect(cfg.provider).toEqual({});
  });
});
