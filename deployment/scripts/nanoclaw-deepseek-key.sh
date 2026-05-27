#!/usr/bin/env bash
#
# nanoclaw-deepseek-key.sh — rotate ONLY the DeepSeek API key in OneCLI vault.
#
# Does NOT touch .env, the agent group, the Obsidian wiring, the container, or
# launchd — just swaps the credential. Because OneCLI resolves secrets per
# request, running agent containers pick up the new key on their next API call;
# no restart needed.
#
# Usage:
#   ./nanoclaw-deepseek-key.sh sk-<new-key>
#   DEEPSEEK_API_KEY=sk-... ./nanoclaw-deepseek-key.sh
#   ./nanoclaw-deepseek-key.sh           # prompts (hidden) if attached to a tty
#
set -uo pipefail
export PATH="$HOME/.local/bin:$PATH"

ONECLI_URL="${ONECLI_URL:-http://127.0.0.1:10254}"

KEY="${DEEPSEEK_API_KEY:-${1:-}}"
if [ -z "$KEY" ] && [ -t 0 ]; then read -r -s -p "DeepSeek API key (sk-...): " KEY; echo; fi
[ -n "$KEY" ] || { echo "✗ no DeepSeek key (pass as arg or set DEEPSEEK_API_KEY)" >&2; exit 1; }
case "$KEY" in sk-*) ;; *) echo "✗ key doesn't look like 'sk-...'" >&2; exit 1 ;; esac

command -v onecli >/dev/null 2>&1 || { echo "✗ onecli not found — run nanoclaw-provision.sh first" >&2; exit 1; }
curl -sf "$ONECLI_URL/api/health" >/dev/null 2>&1 || { echo "✗ OneCLI not reachable at $ONECLI_URL" >&2; exit 1; }

# 1) Delete any existing DeepSeek secrets (host_pattern=api.deepseek.com).
old=$(onecli secrets list 2>/dev/null | python3 -c "import sys,json
try: d=json.load(sys.stdin)
except: d={}
print('\n'.join(s['id'] for s in d.get('data',[]) if s.get('hostPattern')=='api.deepseek.com'))" 2>/dev/null)
for id in $old; do
  onecli secrets delete --id "$id" >/dev/null 2>&1 && echo "  removed old DeepSeek secret $id"
done

# 2) Create the new one (same shape deepseek.sh uses).
onecli secrets create --name DeepSeek --type generic \
  --value "$KEY" --host-pattern api.deepseek.com \
  --header-name Authorization --value-format 'Bearer {value}' >/dev/null 2>&1 \
  || { echo "✗ failed to register DeepSeek secret in OneCLI" >&2; exit 1; }

echo "✓ DeepSeek key rotated. Next API call from any agent container will use the new key — no restart needed."
