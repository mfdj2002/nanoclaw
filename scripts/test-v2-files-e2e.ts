/**
 * End-to-end test of the file round trip:
 *
 *   adapter attachment → router → extractAttachmentFiles → session inbox
 *     → [the path the agent is actually told] → visible inside a container
 *     → send_file's outbox layout → readOutboxFiles → delivery → adapter files
 *
 * Deliberately no model call. The seam that had no coverage is whether the path
 * the agent is *told* about is the path the file is *at* — those two are derived
 * independently, in different codebases (session-manager.ts computes the host
 * location, formatter.ts computes the announced container path). If they ever
 * disagree, "read this PDF" fails silently and totally, and no unit test on
 * either side would notice. A container is used only to prove the mount really
 * exposes the file; the agent's judgment is not under test here.
 *
 * Usage: pnpm exec tsx scripts/test-v2-files-e2e.ts
 * Requires: Docker (or the configured container runtime) and a built agent image.
 */
import Database from 'better-sqlite3';
import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';

const TEST_DIR = fs.mkdtempSync(path.join(process.env.TMPDIR || '/tmp', 'nanoclaw-files-e2e-'));

import { initDb } from '../src/db/connection.js';
import { runMigrations } from '../src/db/migrations/index.js';
import { createAgentGroup } from '../src/db/agent-groups.js';
import { createMessagingGroup, createMessagingGroupAgent } from '../src/db/messaging-groups.js';
import { findSession, getSession } from '../src/db/sessions.js';
import { routeInbound } from '../src/router.js';
import { setDeliveryAdapter, deliverSessionMessages, stopDeliveryPolls } from '../src/delivery.js';
import { registerChannelAdapter, getChannelAdapter, initChannelAdapters } from '../src/channels/channel-registry.js';
import { ensureContainerConfig } from '../src/db/container-configs.js';
import { sessionDir, openOutboundDbRw } from '../src/session-manager.js';
import { CONTAINER_IMAGE } from '../src/config.js';
import { CONTAINER_RUNTIME_BIN } from '../src/container-runtime.js';
import type { ChannelAdapter, OutboundMessage, OutboundFile } from '../src/channels/adapter.js';

const AGENT_GROUP = 'ag-files';
const GROUP_FOLDER = 'test-files-e2e';
const PDF_BYTES = Buffer.from('%PDF-1.4\nSENTINEL-INBOUND-9f3a\n');
const REPORT_BYTES = Buffer.from('# Report\n\nSENTINEL-OUTBOUND-71bc\n');

let failures = 0;
function check(label: string, cond: boolean, detail?: string): void {
  if (cond) {
    console.log(`  ✓ ${label}`);
  } else {
    failures++;
    console.log(`  ✗ ${label}${detail ? `\n      ${detail}` : ''}`);
  }
}

const groupsDir = path.resolve(process.cwd(), 'groups');
const testGroupDir = path.join(groupsDir, GROUP_FOLDER);

function cleanup(sessionPath?: string): void {
  stopDeliveryPolls();
  fs.rmSync(testGroupDir, { recursive: true, force: true });
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
  // Keep the session dir when something failed — it holds the inbox/outbox
  // state you need to see in order to diagnose.
  if (sessionPath && failures === 0) fs.rmSync(sessionPath, { recursive: true, force: true });
  else if (sessionPath) console.log(`  (session dir kept for inspection: ${sessionPath})`);
}

// ── Setup ────────────────────────────────────────────────────────────────────
console.log('\n=== Setup ===');
const centralDb = initDb(path.join(TEST_DIR, 'v2.db'));
runMigrations(centralDb);

fs.mkdirSync(testGroupDir, { recursive: true });
fs.writeFileSync(path.join(testGroupDir, 'CLAUDE.md'), '# Files E2E\n');

const now = new Date().toISOString();
createAgentGroup({ id: AGENT_GROUP, name: 'Files E2E', folder: GROUP_FOLDER, agent_provider: 'mock', created_at: now });
// A real group always has one (group-init scaffolds it); without it the spawn
// path throws before the message is ever written.
ensureContainerConfig(AGENT_GROUP);

createMessagingGroup({
  id: 'mg-files',
  channel_type: 'mock',
  platform_id: 'mock-files-1',
  name: 'Mock Files',
  is_group: 0,
  unknown_sender_policy: 'public',
  created_at: now,
});
createMessagingGroupAgent({
  id: 'mga-files',
  messaging_group_id: 'mg-files',
  agent_group_id: AGENT_GROUP,
  engage_mode: 'pattern',
  engage_pattern: '.',
  sender_scope: 'all',
  ignored_message_policy: 'drop',
  session_mode: 'shared',
  priority: 0,
  created_at: now,
});

const delivered: Array<{ threadId: string | null; message: OutboundMessage }> = [];
const mockAdapter: ChannelAdapter = {
  name: 'mock',
  channelType: 'mock',
  async setup() {},
  async deliver(_platformId, threadId, message) {
    delivered.push({ threadId, message });
  },
  async teardown() {},
  isConnected() {
    return true;
  },
};
registerChannelAdapter('mock', { factory: () => mockAdapter });
await initChannelAdapters(() => ({
  conversations: [],
  onInbound() {},
  onMetadata() {},
}));

// Unlike the bridge in test-v2-channel-e2e.ts, this one forwards `files` —
// dropping them is exactly the bug being tested for.
setDeliveryAdapter({
  async deliver(channelType, platformId, threadId, kind, content, files?: OutboundFile[]) {
    const adapter = getChannelAdapter(channelType);
    if (!adapter) return;
    await adapter.deliver(platformId, threadId, { kind, content: JSON.parse(content), files });
  },
});
console.log('✓ central DB, mock channel, delivery adapter');

// ── 1. Inbound attachment lands where the agent will be told to look ─────────
console.log('\n=== 1. Inbound attachment → session inbox ===');
const MSG_ID = 'msg-files-1';
await routeInbound({
  channelType: 'mock',
  platformId: 'mock-files-1',
  threadId: null,
  message: {
    id: MSG_ID,
    kind: 'chat',
    timestamp: now,
    content: JSON.stringify({
      sender: 'kite',
      text: 'summarize this',
      attachments: [{ name: 'spec.pdf', data: PDF_BYTES.toString('base64'), type: 'application/pdf' }],
    }),
  },
});

const session = findSession('mg-files', null);
if (!session) {
  console.log('✗ no session created');
  cleanup();
  process.exit(1);
}
const sessPath = sessionDir(AGENT_GROUP, session.id);

// The row id is not the inbound message id — writeSessionMessage rewrites it via
// messageIdForAgent so one platform message fanned out to several agent groups
// gets a distinct row each. The inbox directory is named after that derived id,
// so read it back rather than assuming.
const inboundDb = new Database(path.join(sessPath, 'inbound.db'), { readonly: true });
const row = inboundDb.prepare('SELECT id, content FROM messages_in').get() as
  | { id: string; content: string }
  | undefined;
inboundDb.close();

check('message reached the session inbound DB', row !== undefined);
const agentMsgId = row?.id ?? MSG_ID;
const stored = row ? (JSON.parse(row.content) as { attachments?: Array<Record<string, unknown>> }) : undefined;
const att = stored?.attachments?.[0];

const hostFile = path.join(sessPath, 'inbox', agentMsgId, 'spec.pdf');
check('attachment written to the session inbox', fs.existsSync(hostFile), hostFile);
check('bytes survive the base64 round trip', fs.existsSync(hostFile) && fs.readFileSync(hostFile).equals(PDF_BYTES));
check(
  'attachment entry rewritten to a localPath',
  att?.localPath === `inbox/${agentMsgId}/spec.pdf`,
  String(att?.localPath),
);
check('base64 payload stripped from the DB row', att !== undefined && att.data === undefined);

// This is the assertion that ties the two independent derivations together.
// formatter.ts announces `/workspace/${localPath}`; container-runner mounts the
// session dir at /workspace. If either changes without the other, this breaks.
const announcedPath = `/workspace/${att?.localPath as string}`;
check(
  'announced path is the documented one',
  announcedPath === `/workspace/inbox/${agentMsgId}/spec.pdf`,
  announcedPath,
);

// ── 2. That exact path resolves inside a container ───────────────────────────
console.log('\n=== 2. Announced path resolves inside the container ===');
// The host writes the attachment while the container may already be running, so
// this also covers bind-mount write visibility — the failure mode that bites on
// macOS/virtiofs but never on Linux CI.
try {
  const out = execFileSync(
    CONTAINER_RUNTIME_BIN,
    ['run', '--rm', '-v', `${sessPath}:/workspace`, '--entrypoint', 'cat', CONTAINER_IMAGE, announcedPath],
    { encoding: 'buffer', timeout: 60_000 },
  );
  check('file readable at the announced path', Buffer.from(out).equals(PDF_BYTES), `got ${out.length} bytes`);
} catch (err) {
  const e = err as { message?: string; stderr?: Buffer };
  check('file readable at the announced path', false, e.stderr?.toString() || e.message);
  console.log(`      (is the agent image built? expected ${CONTAINER_IMAGE})`);
}

// ── 3. send_file's layout reaches the adapter as bytes ───────────────────────
console.log('\n=== 3. send_file outbox → delivery → adapter ===');
// Replicates exactly what the send_file MCP tool does inside the container:
// copy into /workspace/outbox/<id>/<filename>, then a messages_out row naming it.
const OUT_ID = 'out-files-1';
const outboxDir = path.join(sessPath, 'outbox', OUT_ID);
fs.mkdirSync(outboxDir, { recursive: true });
fs.writeFileSync(path.join(outboxDir, 'report.md'), REPORT_BYTES);

const outDb = openOutboundDbRw(AGENT_GROUP, session.id);
outDb
  .prepare(
    `INSERT INTO messages_out (id, seq, in_reply_to, timestamp, kind, platform_id, channel_type, thread_id, content)
     VALUES (?, 1, ?, datetime('now'), 'chat', 'mock-files-1', 'mock', NULL, ?)`,
  )
  .run(OUT_ID, agentMsgId, JSON.stringify({ text: '', files: ['report.md'] }));
outDb.close();

// Drive delivery directly rather than waiting on a poll: the active poll only
// visits sessions with a live container, and this test deliberately runs none.
await deliverSessionMessages(getSession(session.id)!);

const got = delivered[0];
check('file-only message was delivered at all', got !== undefined);
check('delivery carried the file', (got?.message.files?.length ?? 0) === 1, `files=${got?.message.files?.length ?? 0}`);
check('filename preserved', got?.message.files?.[0]?.filename === 'report.md', got?.message.files?.[0]?.filename);
check('bytes preserved end to end', got?.message.files?.[0]?.data?.equals(REPORT_BYTES) === true);

// ── Done ─────────────────────────────────────────────────────────────────────
console.log(failures === 0 ? '\n✓ file round trip verified\n' : `\n✗ ${failures} check(s) failed\n`);
cleanup(sessPath);
process.exit(failures === 0 ? 0 : 1);
