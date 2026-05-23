#!/usr/bin/env bash
#
# nanoclaw-model.sh — switch the DeepSeek model nanoclaw uses (incl. thinking mode).
#
#   nanoclaw-model.sh deepseek-reasoner   # THINKING mode (chain-of-thought; slower,
#                                         #   stronger reasoning; supports tools since V3.2)
#   nanoclaw-model.sh deepseek-chat       # fast / non-thinking (default)
#   nanoclaw-model.sh deepseek-v4-pro     # bigger non-thinking model
#   nanoclaw-model.sh                     # show current model
#
# Edits OPENCODE_MODEL in the install's .env and restarts the agent container so
# the next message uses the new model. OPENCODE_SMALL_MODEL is left as-is (cheap
# model for trivial sub-tasks). This is GLOBAL — all chat tabs share the model,
# because they all route to the one agent group.
#
# NOTE: deepseek-reasoner deprecates 2026-07-24 → switch to deepseek-v4-flash /
# deepseek-v4-pro (thinking then needs a `thinking:{type:enabled}` provider param).
set -euo pipefail

# Resolve the install dir from this script's own location (deployment/scripts/ ->
# repo root) so it works wherever the repo is cloned — no ~/cc assumption.
# Override with NANOCLAW_DIR.
_self="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DIR="${NANOCLAW_DIR:-$(cd "$_self/../.." && pwd)}"
ENV="$DIR/.env"
export PATH="$HOME/.local/bin:$PATH"
[ -f "$ENV" ] || { echo "No .env at $ENV — run nanoclaw-deepseek.sh first." >&2; exit 1; }

MODEL="${1:-}"
if [ -z "$MODEL" ]; then
  echo "current: $(grep '^OPENCODE_MODEL=' "$ENV" 2>/dev/null || echo '(unset)')"
  echo "usage: nanoclaw-model.sh <deepseek-chat|deepseek-reasoner|deepseek-v4-flash|deepseek-v4-pro>"
  exit 0
fi

if grep -q '^OPENCODE_MODEL=' "$ENV"; then
  sed -i.bak "s|^OPENCODE_MODEL=.*|OPENCODE_MODEL=deepseek/$MODEL|" "$ENV" && rm -f "$ENV.bak"
else
  printf '\nOPENCODE_MODEL=deepseek/%s\n' "$MODEL" >> "$ENV"
fi
echo "OPENCODE_MODEL → deepseek/$MODEL"

# Restart the local agent container so the next message picks up the new model.
GID=$(ncl groups list 2>/dev/null | awk '/cli-with/{print $1; exit}' || true)
if [ -n "$GID" ]; then
  ncl groups restart --id "$GID" >/dev/null 2>&1 \
    && echo "agent container restarted — next message uses deepseek/$MODEL" \
    || echo "(restart skipped; new model applies on the next container spawn)"
else
  echo "(no cli agent found; new model applies on the next container spawn)"
fi
[ "$MODEL" = "deepseek-reasoner" ] && echo "thinking mode ON (slower). Reasoning shows as a foldable block in the Obsidian plugin + is saved to the .md; the terminal 'pnpm run chat' shows only the final answer."
exit 0
