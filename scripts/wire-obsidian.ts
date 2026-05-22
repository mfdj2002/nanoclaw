/**
 * Wire the `obsidian/local` messaging group to an agent group with PER-THREAD
 * sessions, so the Obsidian plugin's tabs (each a distinct threadId) get their
 * own isolated session + container. Idempotent.
 *
 * Usage:
 *   pnpm exec tsx scripts/wire-obsidian.ts --group-id ag-...   (preferred)
 *   pnpm exec tsx scripts/wire-obsidian.ts --folder cli-with-kite
 */
import path from 'path';

import { getAgentGroupByFolder } from '../src/db/agent-groups.js';
import { initDb } from '../src/db/connection.js';
import {
  createMessagingGroup,
  createMessagingGroupAgent,
  getMessagingGroupAgentByPair,
  getMessagingGroupByPlatform,
} from '../src/db/messaging-groups.js';
import { runMigrations } from '../src/db/migrations/index.js';
import { upsertUser } from '../src/modules/permissions/db/users.js';
import { DATA_DIR } from '../src/config.js';
import type { MessagingGroup } from '../src/types.js';

const CHANNEL = 'obsidian';
const PLATFORM_ID = 'local';

function generateId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}
function arg(name: string, def: string): string {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
}

async function main(): Promise<void> {
  const db = initDb(path.join(DATA_DIR, 'v2.db'));
  runMigrations(db);
  const now = new Date().toISOString();

  // Resolve the target agent group: --group-id wins; else look up by --folder.
  let agId = arg('--group-id', '');
  if (!agId) {
    const folder = arg('--folder', 'cli-with-kite');
    const ag = getAgentGroupByFolder(folder);
    if (!ag) {
      console.error(`No agent group with folder "${folder}" — create the CLI agent first, or pass --group-id.`);
      process.exit(1);
    }
    agId = ag.id;
  }

  upsertUser({ id: `${CHANNEL}:${PLATFORM_ID}`, kind: CHANNEL, display_name: 'Obsidian', created_at: now });

  let mg: MessagingGroup | undefined = getMessagingGroupByPlatform(CHANNEL, PLATFORM_ID);
  if (!mg) {
    mg = {
      id: generateId('mg'),
      channel_type: CHANNEL,
      platform_id: PLATFORM_ID,
      name: 'Obsidian',
      is_group: 0,
      unknown_sender_policy: 'public',
      created_at: now,
    };
    createMessagingGroup(mg);
    console.log(`Created obsidian messaging group: ${mg.id}`);
  } else {
    console.log(`Reusing obsidian messaging group: ${mg.id}`);
  }

  const existing = getMessagingGroupAgentByPair(mg.id, agId);
  if (!existing) {
    createMessagingGroupAgent({
      id: generateId('mga'),
      messaging_group_id: mg.id,
      agent_group_id: agId,
      engage_mode: 'pattern',
      engage_pattern: '.',
      sender_scope: 'all',
      ignored_message_policy: 'drop',
      session_mode: 'per-thread',   // each tab (threadId) → its own session/container
      priority: 0,
      created_at: now,
    });
    console.log(`Wired obsidian/${PLATFORM_ID} -> ${agId} (per-thread)`);
  } else {
    console.log(`Wiring already exists: ${existing.id} (session_mode=${existing.session_mode})`);
  }
}

main().catch((err) => { console.error(err); process.exit(1); });
