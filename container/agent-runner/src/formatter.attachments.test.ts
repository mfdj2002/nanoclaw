/**
 * The container half of the attachment path contract.
 *
 * The host writes an attachment to `<session>/inbox/<msgId>/<name>` and records
 * `localPath` relative to the session dir; the formatter turns that into the
 * absolute path the agent is told to open, relying on the session dir being
 * mounted at /workspace. Those two derivations live in different codebases and
 * nothing forces them to agree, so if this prefix changes without the mount
 * changing (or vice versa) every "read this file" request breaks silently.
 *
 * The host half — that localPath really is `inbox/<msgId>/<name>`, and that the
 * resulting absolute path really resolves inside a container — is covered by
 * scripts/test-v2-files-e2e.ts.
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';

import { initTestSessionDb, closeSessionDb } from './db/connection.js';
import { formatMessages } from './formatter.js';
import type { MessageInRow } from './db/messages-in.js';

beforeEach(() => initTestSessionDb());
afterEach(() => closeSessionDb());

function message(content: object): MessageInRow {
  return {
    id: 'm1',
    kind: 'chat',
    timestamp: '2026-01-01T00:00:00Z',
    status: 'pending',
    platform_id: 'chan-1',
    channel_type: 'discord',
    thread_id: null,
    content: JSON.stringify(content),
  } as MessageInRow;
}

describe('formatMessages — attachment announcements', () => {
  it('announces the inbox path the host actually wrote to', () => {
    const out = formatMessages([
      message({
        sender: 'kite',
        text: 'summarize this',
        attachments: [{ name: 'spec.pdf', type: 'application/pdf', localPath: 'inbox/m1/spec.pdf' }],
      }),
    ]);

    // `/workspace/` + localPath. The mount that makes this true is in
    // container-runner.ts (session dir → /workspace).
    expect(out).toContain('/workspace/inbox/m1/spec.pdf');
    expect(out).toContain('spec.pdf');
  });

  it('still names an attachment that has no local file', () => {
    const out = formatMessages([
      message({ sender: 'kite', text: 'look', attachments: [{ name: 'photo.jpg', type: 'image' }] }),
    ]);
    // No localPath → no path claim. Announcing one the agent can't open is worse
    // than announcing none, since it will report the file as missing.
    expect(out).toContain('photo.jpg');
    expect(out).not.toContain('/workspace/');
  });

  it('does not leak the base64 payload into the prompt', () => {
    const out = formatMessages([
      message({
        sender: 'kite',
        text: 'read it',
        attachments: [{ name: 'spec.pdf', localPath: 'inbox/m1/spec.pdf', data: 'QUFBQUFBQUFBQQ==' }],
      }),
    ]);
    // The host strips `data` before the row is written; if that ever regresses,
    // a whole file would be inlined into the context window.
    expect(out).not.toContain('QUFBQUFBQUFBQQ==');
  });
});
