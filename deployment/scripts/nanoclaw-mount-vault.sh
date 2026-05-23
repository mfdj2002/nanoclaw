#!/usr/bin/env bash
#
# nanoclaw-mount-vault.sh — mount an Obsidian vault's `workspace/` folder into
# Andy's container as a writable drop zone (so the agent can save reports/files
# that show up live in Obsidian).
#
#   nanoclaw-mount-vault.sh                 # AUTODETECT the vault (the one with the
#                                           #   nanoclaw-chat plugin installed)
#   nanoclaw-mount-vault.sh /path/to/vault  # use an explicit vault root
#
# What it does (idempotent — safe to re-run):
#   1. Find the vault root deterministically from the plugin's install path.
#   2. mkdir -p "<vault>/workspace".
#   3. Register "<vault>/workspace" as an allowed RW root in the mount allowlist.
#   4. Set the group's additional_mounts so <vault>/workspace → /workspace/extra/vault
#      inside the container (the /workspace/extra/ prefix is forced by the mount
#      validator; there is no ncl verb for additional_mounts, so we write the DB).
#   5. Restart the host daemon (reloads the cached allowlist) + the container.
#
set -euo pipefail

DIR="${NANOCLAW_DIR:-$HOME/cc/nanoclaw-v2}"
GROUP_ID="${NANOCLAW_GROUP_ID:-ag-1779431774034-taufoo}"   # Andy / cli-with-kite
ALLOWLIST="$HOME/.config/nanoclaw/mount-allowlist.json"
CONTAINER_SUBDIR="vault"                                    # → /workspace/extra/vault
export PATH="$HOME/.local/bin:$PATH"

[ -d "$DIR" ] || { echo "nanoclaw dir not found: $DIR" >&2; exit 1; }

# ── 1. Autodetect the vault root from the plugin's install location ──
VAULT="${1:-}"
if [ -z "$VAULT" ]; then
  PLUGIN_MAIN=$(find "$HOME" -maxdepth 7 -path '*/.obsidian/plugins/nanoclaw-chat/main.js' -print -quit 2>/dev/null || true)
  [ -n "$PLUGIN_MAIN" ] || { echo "Could not autodetect a vault (no nanoclaw-chat plugin found under \$HOME). Pass the vault root explicitly." >&2; exit 1; }
  VAULT="${PLUGIN_MAIN%/.obsidian/plugins/nanoclaw-chat/main.js}"
fi
[ -d "$VAULT/.obsidian" ] || { echo "Not an Obsidian vault (no .obsidian/): $VAULT" >&2; exit 1; }
echo "vault root      : $VAULT"

# ── 2. Ensure the workspace drop folder exists (validator rejects missing paths) ──
WS="$VAULT/workspace"
mkdir -p "$WS"
echo "workspace folder: $WS"

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
    a.allowedRoots.push({ path: ws, allowReadWrite: true, description: "Obsidian vault workspace drop zone" });
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
echo "  cont : /workspace/extra/vault   (writable)"
