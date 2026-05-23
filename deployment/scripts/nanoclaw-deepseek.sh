#!/usr/bin/env bash
#
# nanoclaw-deepseek.sh — point an already-installed NanoClaw at DeepSeek and start chatting.
#
# Picks up where nanoclaw-provision.sh leaves off (base install done, OpenCode
# provider wired + image built, host service running, OneCLI up). Takes a DeepSeek
# API key, registers it, creates/reconfigures a local CLI agent on DeepSeek, then
# drops you into an interactive chat — the "wake up the agent" step.
#
# Idempotent: safe to re-run (e.g. to swap in a new key).
#
# Usage:
#   ./nanoclaw-deepseek.sh sk-<deepseek-key>
#   DEEPSEEK_API_KEY=sk-... ./nanoclaw-deepseek.sh
#   ./nanoclaw-deepseek.sh sk-... --verify-only      # set up + one test message, no REPL
#   ./nanoclaw-deepseek.sh --chat                     # already set up → jump straight into interactive chat (no re-setup, no key)
#
# Optional env: NANOCLAW_DIR (default: the repo this script lives in),
#               DEEPSEEK_MODEL (default deepseek-chat), AGENT_NAME (default Andy),
#               DISPLAY_NAME (default $USER)
set -uo pipefail

# Resolve the install dir from this script's own location (deployment/scripts/ ->
# repo root) so it works wherever the repo is cloned — no ~/cc assumption.
_self="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
NANOCLAW_DIR="${NANOCLAW_DIR:-$(cd "$_self/../.." && pwd)}"
DEEPSEEK_MODEL="${DEEPSEEK_MODEL:-deepseek-chat}"   # deprecates 2026-07-24 → deepseek-v4-flash; switch to deepseek-v4-pro then
AGENT_NAME="${AGENT_NAME:-Andy}"
DISPLAY_NAME="${DISPLAY_NAME:-${USER:-you}}"
LOG_FILE="${LOG_FILE:-$PWD/nanoclaw-deepseek.log}"

ONECLI_URL="http://127.0.0.1:10254"
VERIFY_ONLY=0
CHAT_ONLY=0

ts()  { date '+%H:%M:%S'; }
log() { printf '\033[2m%s\033[0m %s\n' "$(ts)" "$*" | tee -a "$LOG_FILE"; }
ok()  { printf '\033[32m✓\033[0m %s\n' "$*" | tee -a "$LOG_FILE"; }
die() { printf '\033[31m✗ %s\033[0m\n' "$*" | tee -a "$LOG_FILE" >&2; exit 1; }
have(){ command -v "$1" >/dev/null 2>&1; }

# ── args ────────────────────────────────────────────────────────────────────
KEY="${DEEPSEEK_API_KEY:-}"
for a in "$@"; do
  case "$a" in
    --verify-only) VERIFY_ONLY=1 ;;
    --chat|--repl) CHAT_ONLY=1 ;;     # already set up → jump straight into the chat loop
    sk-*)          KEY="$a" ;;
    *)             die "unknown arg: $a" ;;
  esac
done
if [ "$CHAT_ONLY" = 0 ]; then
  if [ -z "$KEY" ]; then
    if [ -t 0 ]; then read -r -s -p "DeepSeek API key (sk-...): " KEY; echo; else die "no DeepSeek key (pass as arg or set DEEPSEEK_API_KEY)"; fi
  fi
  [ -n "$KEY" ] || die "empty DeepSeek key"
fi

export PATH="$HOME/.local/bin:$HOME/.bun/bin:$PATH"
[ -x /opt/homebrew/bin/brew ] && eval "$(/opt/homebrew/bin/brew shellenv)" 2>/dev/null
[ -d "$(brew --prefix 2>/dev/null)/opt/node@22/bin" ] && export PATH="$(brew --prefix)/opt/node@22/bin:$PATH"

printf '\n\033[1m######## nanoclaw-deepseek @ %s ########\033[0m\n' "$(ts)"

# ── preconditions (fail fast → point back at the provision script) ──────────
[ -f "$NANOCLAW_DIR/package.json" ] || die "no NanoClaw at $NANOCLAW_DIR — run nanoclaw-provision.sh first"
cd "$NANOCLAW_DIR"
have onecli || die "onecli not found — run nanoclaw-provision.sh first"
curl -sf "$ONECLI_URL/api/health" >/dev/null 2>&1 || die "OneCLI not reachable at $ONECLI_URL — is the install complete?"
launchctl list 2>/dev/null | grep -q nanoclaw || die "NanoClaw service not loaded — run nanoclaw-provision.sh first"
grep -q 'ANTHROPIC_BASE_URL' src/providers/opencode.ts 2>/dev/null || die "OpenCode provider not wired/patched — re-run nanoclaw-provision.sh"
docker images --format '{{.Repository}}' 2>/dev/null | grep -q nanoclaw-agent || die "no agent image — re-run nanoclaw-provision.sh"
ok "preconditions met (NanoClaw installed, OneCLI up, OpenCode wired)"

if [ "$CHAT_ONLY" = 1 ]; then
  log "chat mode — setup already done, jumping straight to chat"
else

# ── 1. .env DeepSeek block (idempotent) ─────────────────────────────────────
if grep -q '^OPENCODE_PROVIDER=' .env 2>/dev/null; then
  ok ".env already has the DeepSeek/OpenCode block"
else
  cat >> .env <<EOF

OPENCODE_PROVIDER=deepseek
OPENCODE_MODEL=deepseek/${DEEPSEEK_MODEL}
OPENCODE_SMALL_MODEL=deepseek/${DEEPSEEK_MODEL}
ANTHROPIC_BASE_URL=https://api.deepseek.com/v1
EOF
  ok ".env DeepSeek block written"
fi

# ── 2. register the DeepSeek key in OneCLI (delete-then-create = always current) ──
old=$(onecli secrets list 2>/dev/null | python3 -c "import sys,json
try: d=json.load(sys.stdin)
except: d={}
print('\n'.join(s['id'] for s in d.get('data',[]) if s.get('hostPattern')=='api.deepseek.com'))" 2>/dev/null)
for id in $old; do onecli secrets delete --id "$id" >/dev/null 2>&1 && log "removed stale DeepSeek secret $id"; done
onecli secrets create --name DeepSeek --type generic \
  --value "$KEY" --host-pattern api.deepseek.com \
  --header-name Authorization --value-format 'Bearer {value}' >/dev/null 2>&1 \
  || die "failed to register DeepSeek secret in OneCLI"
ok "DeepSeek key registered in OneCLI vault"

# ── 3. local CLI agent (create if missing) ──────────────────────────────────
GROUP_ID=$(ncl groups list 2>/dev/null | awk '/cli-with/{print $1; exit}')
if [ -z "$GROUP_ID" ]; then
  pnpm --silent exec tsx setup/index.ts --step cli-agent \
    --display-name "$DISPLAY_NAME" --agent-name "$AGENT_NAME" </dev/null >/dev/null 2>&1 \
    || die "failed to create local CLI agent"
  GROUP_ID=$(ncl groups list 2>/dev/null | awk '/cli-with/{print $1; exit}')
  [ -n "$GROUP_ID" ] || die "CLI agent created but group id not found"
  ok "local CLI agent created ($GROUP_ID)"
else
  ok "local CLI agent exists ($GROUP_ID)"
fi

# ── 4. point that agent at the OpenCode/DeepSeek provider (idempotent) ───────
ncl groups config update --id "$GROUP_ID" --provider opencode >/dev/null 2>&1 \
  || die "failed to set provider=opencode on $GROUP_ID"
ok "agent group set to provider=opencode"

# ── 4b. wire the Obsidian channel to this agent (per-thread tabs for the plugin) ──
( cd "$NANOCLAW_DIR" && pnpm --silent exec tsx scripts/wire-obsidian.ts --group-id "$GROUP_ID" >/dev/null 2>&1 ) \
  && ok "Obsidian channel wired (per-thread)" \
  || log "Obsidian wiring skipped (channel not present in this build — vanilla clone?)"

# ── 5. fresh start: kill any running container + clear stale OpenCode sessions ─
# (a previously errored turn — e.g. an empty wallet — poisons the OpenCode session
#  continuation so it resumes to nothing; a clean slate avoids that.)
ncl groups restart --id "$GROUP_ID" >/dev/null 2>&1 || true
for sess in data/v2-sessions/"$GROUP_ID"/*/; do
  [ -d "$sess" ] || continue
  [ -f "$sess/outbound.db" ] && pnpm --silent exec tsx scripts/q.ts "$sess/outbound.db" \
    "DELETE FROM session_state WHERE key LIKE 'continuation:%'" >/dev/null 2>&1
  rm -rf "$sess/opencode-xdg"/* 2>/dev/null
done
ok "cleared stale OpenCode session state"

# ── 6. verify with a live message (also creates + grants the OneCLI agent) ───
log "sending a test message (first cold turn can take ~30-60s)…"
reply=$(pnpm --silent run chat "Reply in one short sentence and name the AI model you are." 2>&1)
# Best-effort: ensure the just-created OneCLI agent can use every matching secret.
agent_id=$(onecli agents list 2>/dev/null | python3 -c "import sys,json
try: d=json.load(sys.stdin)
except: d={}
print(next((a['id'] for a in d.get('data',[]) if a.get('identifier')=='$GROUP_ID'),''))" 2>/dev/null)
[ -n "$agent_id" ] && onecli agents set-secret-mode --id "$agent_id" --mode all >/dev/null 2>&1

case "$reply" in
  *"Insufficient Balance"*)
    log "reply: $reply"
    printf '\n\033[33m⚠ Setup is correct, but the DeepSeek account has no balance.\033[0m\n'
    printf '   Top up at https://platform.deepseek.com (Billing), then run this script again.\n'
    exit 0 ;;
  ""|*"timeout: no reply"*)
    log "no reply on first try — resetting session and retrying once…"
    ncl groups restart --id "$GROUP_ID" >/dev/null 2>&1 || true
    for sess in data/v2-sessions/"$GROUP_ID"/*/; do
      [ -f "$sess/outbound.db" ] && pnpm --silent exec tsx scripts/q.ts "$sess/outbound.db" "DELETE FROM session_state WHERE key LIKE 'continuation:%'" >/dev/null 2>&1
      rm -rf "$sess/opencode-xdg"/* 2>/dev/null
    done
    reply=$(pnpm --silent run chat "Reply in one short sentence and name the AI model you are." 2>&1)
    ;;
esac

case "$reply" in
  ""|*"timeout: no reply"*|*Error:*) die "agent did not reply cleanly: ${reply:-<empty>} (see container: docker logs \$(docker ps --format '{{.Names}}' | grep cli-with))" ;;
  *) ok "DeepSeek-backed reply received:"; printf '   \033[36m%s\033[0m\n' "$reply" ;;
esac
fi   # end of CHAT_ONLY guard (setup steps 1-6)

# ── 7. wake it up: interactive local chat ───────────────────────────────────
if [ "$VERIFY_ONLY" = 1 ] || [ ! -t 0 ]; then
  printf '\n\033[1;32mReady.\033[0m Chat with it any time:\n'
  printf '   cd %s && pnpm run chat "your message"\n' "$NANOCLAW_DIR"
  exit 0
fi

printf '\n\033[1;32m######## %s is awake (DeepSeek). Type a message, or "exit". ########\033[0m\n' "$AGENT_NAME"
while true; do
  printf '\n\033[1;36myou>\033[0m '
  IFS= read -r line || break
  case "$line" in
    ''|' ') continue ;;
    exit|quit|q) break ;;
    *) pnpm --silent run chat "$line" ;;
  esac
done
printf '\n\033[2mbye — restart any time with: ./nanoclaw-deepseek.sh\033[0m\n'
