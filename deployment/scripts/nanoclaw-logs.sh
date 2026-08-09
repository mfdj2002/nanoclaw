#!/usr/bin/env bash
#
# nanoclaw-logs.sh — tail the live agent container's logs (poll-loop, OpenCode
# events, "Progress:", the reasoning the chat doesn't surface).
#
# IMPORTANT: agent containers run with --rm, so `docker logs` only works while
# the container is alive. Per-session transcripts are mirrored to
# <install>/logs/containers/<group>-<session>.log and DO persist — read those
# for anything that already finished. Host-side logs (routing, delivery,
# crashes) live at <install>/logs/nanoclaw.log.
#
# Usage: nanoclaw-logs.sh [<group-folder-substring>]
set -euo pipefail

# Resolve the install dir from this script's own location (deployment/scripts/ ->
# repo root) so it works wherever the repo is cloned. Override with NANOCLAW_DIR.
DIR="${NANOCLAW_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"

# Agent containers are named `nanoclaw-v2-<group-folder>-<timestamp>` (the v2 is
# upstream's, see src/container-runner.ts). Match on that prefix only — the
# previous filter also required the folder to contain "cli-with", which is just
# one install's group naming and matched nothing on any other setup. An optional
# argument narrows to a specific group when several are running.
FILTER="${1:-}"
NAME=$(docker ps --format '{{.Names}}' | grep -i "^nanoclaw-v2-" | grep -i -- "$FILTER" | head -1 || true)
if [ -z "$NAME" ]; then
  echo "No running agent container${FILTER:+ matching \"$FILTER\"} right now (one spawns on a message, exits ~30 min after idle)."
  echo
  echo "Most recent persistent session transcript:"
  LATEST=$(ls -t "$DIR/logs/containers/" 2>/dev/null | head -1 || true)
  [ -n "$LATEST" ] && echo "  tail -f $DIR/logs/containers/$LATEST" || echo "  (none yet)"
  echo "Host logs:  tail -f $DIR/logs/nanoclaw.log"
  exit 0
fi
echo "tailing $NAME  (Ctrl-C to stop)"
exec docker logs -f --tail 80 "$NAME"
