#!/usr/bin/env bash
#
# nanoclaw-logs.sh — tail the live agent container's logs (poll-loop, OpenCode
# events, "Progress:", the reasoning the chat doesn't surface).
#
# IMPORTANT: agent containers run with --rm, so their logs VANISH when the
# container exits (after the 30-min idle window). This only shows logs while a
# turn is active / the container is alive. Persistent host-side logs (routing,
# delivery, crashes) live at <install>/logs/nanoclaw.log.
set -euo pipefail

# Resolve the install dir from this script's own location (deployment/scripts/ ->
# repo root) so it works wherever the repo is cloned. Override with NANOCLAW_DIR.
DIR="${NANOCLAW_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"

# Match the cli/obsidian agent container (per-install image tag, folder cli-with-*).
NAME=$(docker ps --format '{{.Names}}' | grep -i 'nanoclaw-v2-cli-with' | head -1 || true)
if [ -z "$NAME" ]; then
  echo "No running agent container right now (it spawns on a message, exits ~30 min after idle)."
  echo "Persistent host logs:  tail -f $DIR/logs/nanoclaw.log"
  exit 0
fi
echo "tailing $NAME  (Ctrl-C to stop)"
exec docker logs -f --tail 80 "$NAME"
