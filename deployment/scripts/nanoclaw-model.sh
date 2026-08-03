#!/usr/bin/env bash
#
# nanoclaw-model.sh — switch the model a nanoclaw agent group uses.
#
#   nanoclaw-model.sh                                  # show current model + known vendors
#   nanoclaw-model.sh deepseek-v4-pro                  # bare name → keep current vendor
#   nanoclaw-model.sh deepseek/deepseek-chat           # explicit vendor/model
#   nanoclaw-model.sh moonshotai/kimi-k3               # switch vendor too
#   nanoclaw-model.sh --group <agent-group-id> <model> # target one group
#   nanoclaw-model.sh --list-groups                    # show groups and their models
#
# The model is stored per agent group (container_configs.model) via
# `ncl groups config update`, so two groups can run different vendors. The agent
# container is restarted so the next message picks it up.
#
# Falls back to editing OPENCODE_MODEL in the install's .env when ncl isn't
# reachable — that value is the install-wide default for groups with no model set.
#
# Switching VENDOR additionally needs the API key in the OneCLI vault, matched on
# the vendor's API host (nanoclaw never puts keys in .env):
#   onecli secrets create --name moonshot --value sk-… --hosts api.moonshot.cn
# If OpenCode doesn't know the vendor's base URL, set it explicitly in .env:
#   OPENCODE_BASE_URL_MOONSHOTAI=https://api.moonshot.cn/v1
set -euo pipefail

# Resolve the install dir from this script's own location (deployment/scripts/ ->
# repo root) so it works wherever the repo is cloned — no ~/cc assumption.
# Override with NANOCLAW_DIR.
_self="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DIR="${NANOCLAW_DIR:-$(cd "$_self/../.." && pwd)}"
ENV="$DIR/.env"
export PATH="$HOME/.local/bin:$PATH"

# Vendors known to work through the OneCLI proxy, with the host the API key must
# be registered against. Informational — any vendor OpenCode supports will work.
KNOWN_VENDORS="deepseek(api.deepseek.com) moonshotai(api.moonshot.cn) zhipuai(open.bigmodel.cn) openrouter(openrouter.ai) anthropic(api.anthropic.com) openai(api.openai.com)"

GROUP=""
MODEL=""
while [ $# -gt 0 ]; do
  case "$1" in
    --group) GROUP="${2:-}"; shift 2 ;;
    --list-groups)
      ncl groups list 2>/dev/null || { echo "ncl not reachable — is the nanoclaw service running?" >&2; exit 1; }
      exit 0 ;;
    -h|--help) sed -n '3,23p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) MODEL="$1"; shift ;;
  esac
done

env_model() { grep '^OPENCODE_MODEL=' "$ENV" 2>/dev/null | head -1 | cut -d= -f2- || true; }
env_vendor() { grep '^OPENCODE_PROVIDER=' "$ENV" 2>/dev/null | head -1 | cut -d= -f2- || true; }

# Default to the first agent group when none was named. The previous version
# grepped for a group whose name contained "cli-with", which only matched one
# particular install's naming.
resolve_group() {
  [ -n "$GROUP" ] && { echo "$GROUP"; return; }
  ncl groups list 2>/dev/null | awk 'NR>1 && $1 ~ /^ag-/ {print $1; exit}' || true
}

if [ -z "$MODEL" ]; then
  echo "current (install default): OPENCODE_MODEL=$(env_model)"
  GID="$(resolve_group)"
  if [ -n "$GID" ]; then
    echo "current (group $GID):"
    ncl groups config get --id "$GID" 2>/dev/null | grep -i '^model' || echo "  model: (unset → uses install default)"
  fi
  echo
  echo "known vendors: $KNOWN_VENDORS"
  echo "usage: nanoclaw-model.sh [--group <id>] <model|vendor/model>"
  exit 0
fi

# Bare model name → keep whatever vendor is configured now.
case "$MODEL" in
  */*) FULL="$MODEL" ;;
  *)
    V="$(env_vendor)"
    [ -z "$V" ] && { echo "No OPENCODE_PROVIDER in $ENV — pass an explicit vendor/model." >&2; exit 1; }
    FULL="$V/$MODEL" ;;
esac
VENDOR="${FULL%%/*}"

GID="$(resolve_group)"
if [ -n "$GID" ]; then
  # Per-group: the model column beats the .env default for this group only.
  ncl groups config update --id "$GID" --model "$FULL" >/dev/null 2>&1 \
    && echo "group $GID model → $FULL" \
    || { echo "ncl update failed — falling back to the install-wide default in .env" >&2; GID=""; }
fi

if [ -z "$GID" ]; then
  [ -f "$ENV" ] || { echo "No .env at $ENV." >&2; exit 1; }
  if grep -q '^OPENCODE_MODEL=' "$ENV"; then
    sed -i.bak "s|^OPENCODE_MODEL=.*|OPENCODE_MODEL=$FULL|" "$ENV" && rm -f "$ENV.bak"
  else
    printf '\nOPENCODE_MODEL=%s\n' "$FULL" >> "$ENV"
  fi
  echo "OPENCODE_MODEL → $FULL"
fi

# Warn on a vendor switch: the key lives in OneCLI, not .env, so a switch with no
# matching secret fails at the first API call with an auth error.
if [ "$VENDOR" != "$(env_vendor)" ]; then
  echo
  echo "⚠ vendor is now '$VENDOR' (install default is '$(env_vendor)')."
  echo "  Make sure its API key is in the OneCLI vault, matched on the vendor's host:"
  echo "    onecli secrets list"
  echo "  If OpenCode doesn't know this vendor's base URL, add to $ENV:"
  echo "    OPENCODE_BASE_URL_$(echo "$VENDOR" | tr '[:lower:]-' '[:upper:]_')=https://<api-host>/v1"
fi

# Restart the agent container so the next message picks up the new model.
if [ -n "${GID:-}" ] || GID="$(resolve_group)"; then
  if [ -n "$GID" ]; then
    ncl groups restart --id "$GID" >/dev/null 2>&1 \
      && echo "agent container restarted — next message uses $FULL" \
      || echo "(restart skipped; new model applies on the next container spawn)"
  fi
fi
exit 0
