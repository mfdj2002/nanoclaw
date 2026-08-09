#!/usr/bin/env bash
#
# nanoclaw-mount-vault.sh — share one folder of an Obsidian vault with the agent,
# read-write, so both sides see the same files: you edit in Obsidian, the agent
# edits in its container, no copies and no divergence.
#
# The folder has the SAME name on both sides (default `shared-with-agent`), which
# the previous `workspace/` → `/workspace/extra/vault` mapping did not — the host
# called it "workspace" while the container called it "vault", and "workspace"
# already means the session root inside the container. Override with SHARED_DIR.
#
#   nanoclaw-mount-vault.sh                 # AUTODETECT the vault (the one with the
#                                           #   nanoclaw-chat plugin installed)
#   nanoclaw-mount-vault.sh /path/to/vault  # use an explicit vault root
#
# What it does (idempotent — safe to re-run):
#   1. Find the vault root deterministically from the plugin's install path.
#   2. mkdir -p "<vault>/<SHARED_DIR>".
#   3. Register it as an allowed RW root in the mount allowlist.
#   4. Set the group's additional_mounts so <vault>/<SHARED_DIR> →
#      /workspace/extra/<SHARED_DIR> in the container (the /workspace/extra/
#      prefix is forced by the mount validator; there is no ncl verb for
#      additional_mounts, so we write the DB).
#   5. Restart the host daemon (reloads the cached allowlist) + the container.
#
set -euo pipefail

# Resolve the install dir from this script's own location (deployment/scripts/ ->
# repo root) so it works wherever the repo is cloned — no ~/cc assumption.
# Override with NANOCLAW_DIR.
_self="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DIR="${NANOCLAW_DIR:-$(cd "$_self/../.." && pwd)}"
ALLOWLIST="$HOME/.config/nanoclaw/mount-allowlist.json"
# One name, both sides — nothing to translate when the agent names a file.
SHARED_DIR="${SHARED_DIR:-shared-with-agent}"
CONTAINER_SUBDIR="$SHARED_DIR"                              # → /workspace/extra/<SHARED_DIR>
export PATH="$HOME/.local/bin:$PATH"
# Autodetect the obsidian/CLI agent group (the cli-with-* group wire-obsidian.ts targets)
# rather than hardcoding an install-specific id. Override with NANOCLAW_GROUP_ID.
# First agent group, not one whose name happens to contain "cli-with" — that is
# one install's naming convention and matches nothing elsewhere.
GROUP_ID="${NANOCLAW_GROUP_ID:-$(ncl groups list 2>/dev/null | awk 'NR>1 && $1 ~ /^ag-/ {print $1; exit}')}"
[ -n "$GROUP_ID" ] || { echo "Could not find an agent group (set NANOCLAW_GROUP_ID)." >&2; exit 1; }

[ -d "$DIR" ] || { echo "nanoclaw dir not found: $DIR" >&2; exit 1; }

# ── 1. Autodetect the vault root from the plugin's install location ──
VAULT="${1:-}"
if [ -z "$VAULT" ]; then
  # Match the plugin by its manifest id, not by its directory name — the folder
  # can be called anything (nanoclaw-obsidian, nanoclaw-chat, …) and a name-based
  # find silently reports "no vault" on a perfectly good install.
  MANIFEST=$(grep -rl '"id"[[:space:]]*:[[:space:]]*"nanoclaw-chat"' \
             "$HOME"/*/.obsidian/plugins/*/manifest.json \
             "$HOME"/*/*/.obsidian/plugins/*/manifest.json \
             "$HOME"/*/*/*/.obsidian/plugins/*/manifest.json 2>/dev/null | head -1 || true)
  [ -n "$MANIFEST" ] || { echo "Could not autodetect a vault (no nanoclaw plugin found under \$HOME). Pass the vault root explicitly." >&2; exit 1; }
  VAULT="${MANIFEST%/.obsidian/plugins/*/manifest.json}"
fi
[ -d "$VAULT/.obsidian" ] || { echo "Not an Obsidian vault (no .obsidian/): $VAULT" >&2; exit 1; }
echo "vault root      : $VAULT"

# ── 2. Ensure the workspace drop folder exists (validator rejects missing paths) ──
WS="$VAULT/$SHARED_DIR"
mkdir -p "$WS"
echo "shared folder   : $WS"

# ── 3. Register the allowlist root (RW), idempotently ──
mkdir -p "$(dirname "$ALLOWLIST")"
[ -f "$ALLOWLIST" ] || printf '{"allowedRoots":[],"blockedPatterns":[]}\n' > "$ALLOWLIST"
ALLOWLIST="$ALLOWLIST" WS="$WS" pnpm exec tsx -e '
  import fs from "fs";
  const p = process.env.ALLOWLIST!, ws = process.env.WS!;
  const a = JSON.parse(fs.readFileSync(p, "utf8"));
  a.allowedRoots = a.allowedRoots || [];
  a.blockedPatterns = a.blockedPatterns || [];
  if (!a.allowedRoots.some((r: any) => r.path === ws))
    a.allowedRoots.push({ path: ws, allowReadWrite: true, description: "Shared with the agent (Obsidian vault)" });
  fs.writeFileSync(p, JSON.stringify(a, null, 2) + "\n");
  console.log("allowlist roots :", a.allowedRoots.map((r: any) => r.path).join(", "));
'

# ── 4. Set additional_mounts on the group (write DB; no ncl verb exists) ──
MOUNTS_JSON="[{\"hostPath\":\"$WS\",\"containerPath\":\"$CONTAINER_SUBDIR\",\"readonly\":false}]"
TS="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
cd "$DIR"
pnpm exec tsx scripts/q.ts "$DIR/data/v2.db" \
  "PRAGMA busy_timeout=5000; UPDATE container_configs SET additional_mounts = '$MOUNTS_JSON', updated_at = '$TS' WHERE agent_group_id = '$GROUP_ID';"
echo "additional_mounts: $MOUNTS_JSON"

# ── 5. Restart daemon (reloads cached allowlist) + container ──
# The launchd label carries a per-install hash (com.nanoclaw-v2-XXXXXXXX), so
# discover it rather than hardcoding.
LABEL="$(launchctl list 2>/dev/null | awk '/nanoclaw/{print $3; exit}')"
if [ -n "$LABEL" ] && launchctl kickstart -k "gui/$(id -u)/$LABEL" 2>/dev/null; then
  echo "daemon restarted (allowlist reloaded): $LABEL"
  sleep 4
else
  echo "(daemon restart skipped — could not resolve launchd label; restart nanoclaw manually)"
fi
ncl groups restart --id "$GROUP_ID" >/dev/null 2>&1 \
  && echo "container restart requested" \
  || echo "(container restart skipped; mount applies on next message)"

echo
echo "DONE."
echo "  host : $WS"
echo "  cont : /workspace/extra/$SHARED_DIR   (writable)"
