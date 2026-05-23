# deployment/

Operational glue for this NanoClaw install (DeepSeek provider + Obsidian client).
These are personal deployment/ops scripts — **not** part of upstream NanoClaw.

The Obsidian **plugin** (the client UI) lives in its own repo, since it installs into
`<vault>/.obsidian/plugins/` and has an independent release lifecycle:
👉 https://github.com/mfdj2002/nanoclaw-obsidian

The **channel adapter** (server side) stays in this repo at
[`src/channels/obsidian.ts`](../src/channels/obsidian.ts), wired by
[`scripts/wire-obsidian.ts`](../scripts/wire-obsidian.ts).

## Scripts (`scripts/`)

| Script | What it does |
|--------|--------------|
| `nanoclaw-provision.sh` | Non-interactive, resumable provisioning from stock macOS (Docker assumed pre-installed). Clones the fork branch, pins `node@22`, builds deps, installs OneCLI, wires the OpenCode/DeepSeek provider. Checkpointed so a re-run skips completed steps. |
| `nanoclaw-deepseek.sh` | Wire the DeepSeek API key → agent group, reset/clear a wedged OpenCode session, open a chat. `--chat` fast-path. |
| `nanoclaw-model.sh` | Switch `OPENCODE_MODEL` in `.env` — fast `deepseek-v4-flash` ⇄ pro `deepseek-v4-pro` — and restart the agent. Powers the plugin's fast/pro toggle. |
| `nanoclaw-mount-vault.sh` | Autodetect the Obsidian vault (from the installed plugin's path), `mkdir` a `workspace/` drop folder, register it RW in `~/.config/nanoclaw/mount-allowlist.json`, set the group's `additional_mounts` so it lands at `/workspace/extra/vault` in the container, then restart. |
| `nanoclaw-logs.sh` | Tail the live agent container logs. |
| `nanoclaw-vm-test.sh` | Clean-room provisioning test inside a tart macOS VM. |

> Note: scripts hardcode this install's defaults (e.g. the agent group id) but accept
> overrides via env vars (`NANOCLAW_DIR`, `NANOCLAW_GROUP_ID`, …). No secrets are
> stored here — the DeepSeek key lives only in the OneCLI vault / gitignored `.env`.

## Obsidian channel ↔ plugin wire protocol

Both sides speak newline-delimited JSON over a Unix socket at `data/obsidian.sock`:

- **plugin → host:** `{ "threadId": string, "text": string }`
- **host → plugin:** `{ "threadId": string|null, "text": string, "kind": "thinking" | "final" }`

`kind:"thinking"` carries the streamed chain-of-thought (cumulative text, emitted ~1×/sec
as each reasoning round completes); `kind:"final"` is the answer. Each `threadId` maps to
its own session (parallel tabs run concurrently with no cross-talk). Replies are broadcast
to all connected clients, each filtering by the `threadId` it owns.
