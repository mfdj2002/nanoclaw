/**
 * The Files section of the system prompt.
 *
 * This is the only thing that tells a non-Claude provider a mounted directory
 * exists (`additionalDirectories` is Claude-SDK-only), and the only thing that
 * tells any provider which of its paths the user can actually see. Getting it
 * wrong is silent: the agent writes somewhere invisible and cheerfully reports
 * success.
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';

import { initTestSessionDb, closeSessionDb, getInboundDb } from './db/connection.js';
import { buildSystemPromptAddendum } from './destinations.js';

beforeEach(() => {
  initTestSessionDb();
  getInboundDb()
    .prepare(
      `INSERT INTO destinations (name, display_name, type, channel_type, platform_id, agent_group_id)
       VALUES ('obsidian', 'Obsidian', 'channel', 'obsidian', 'local', NULL)`,
    )
    .run();
});

afterEach(() => closeSessionDb());

const SHARED = '/workspace/extra/vault';

describe('Files section — with a shared directory', () => {
  it('names the mounted directory so non-Claude providers learn it exists', () => {
    const p = buildSystemPromptAddendum('Andy', [SHARED]);
    expect(p).toContain(SHARED);
  });

  it('directs user-facing work into the shared directory', () => {
    const p = buildSystemPromptAddendum('Andy', [SHARED]);
    expect(p).toContain('Work in the shared directory');
  });

  it('says the private workspace is invisible to the user', () => {
    // The base container prompt tells the agent to save files in
    // /workspace/agent/. Left uncorrected it writes deliverables somewhere the
    // user cannot open.
    const p = buildSystemPromptAddendum('Andy', [SHARED]);
    expect(p).toMatch(/\/workspace\/agent\/.*CANNOT see/s);
  });

  it('explains why sending a snapshot breaks iteration', () => {
    const p = buildSystemPromptAddendum('Andy', [SHARED]);
    expect(p).toContain('cannot read back a file you sent');
  });

  it('asks for paths relative to the shared root', () => {
    // The user sees `Andy Files/report.md` in their vault; the container prefix
    // is meaningless to them, so a full path is unusable as a reference.
    const p = buildSystemPromptAddendum('Andy', [SHARED]);
    expect(p).toContain('relative to the shared directory');
  });

  it('demotes send_file to the fallback it now is', () => {
    const p = buildSystemPromptAddendum('Andy', [SHARED]);
    expect(p).toContain('Use `send_file` only for');
  });
});

describe('Files section — with no shared directory', () => {
  it('makes send_file the primary route', () => {
    const p = buildSystemPromptAddendum('Andy', []);
    expect(p).toContain('use `send_file`');
    expect(p).not.toContain('Work in the shared directory');
  });

  it('is honest that iteration is impossible', () => {
    // Better to say so than to have the agent promise revisions it can't make.
    const p = buildSystemPromptAddendum('Andy', []);
    expect(p).toContain('iterating on a document is not possible');
  });

  it('keeps the no-absolute-paths rule, which only applies without a shared root', () => {
    const p = buildSystemPromptAddendum('Andy', []);
    expect(p).toContain('Never quote your own absolute paths');
  });

  it('behaves the same when mounts are omitted entirely', () => {
    expect(buildSystemPromptAddendum('Andy')).toBe(buildSystemPromptAddendum('Andy', []));
  });
});
