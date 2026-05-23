#!/usr/bin/env bash
#
# nanoclaw-provision.sh — non-interactive NanoClaw v2 install on DeepSeek (via OpenCode).
# Target: a STOCK macOS (Apple Silicon or Intel). Assumes NO dependencies beyond
# what ships with macOS — installs CLT, Homebrew, Node, pnpm, bun.
# PREREQUISITE the operator must provide: Docker Desktop installed AND running
# (it needs a GUI + license click-through, so the script can't bring it up; it
# fails fast with instructions if Docker isn't reachable).
# Run as an ADMIN user: the CLT + Homebrew install need sudo (Homebrew's installer
# prompts once for the password unless passwordless sudo is configured).
#
# RESUMABLE: every step is checkpointed to a state file. If a step fails, fix the
# cause and re-run — completed steps are skipped automatically. See --help.
# LOGGED: all output is timestamped and appended to a rolling log file.
#
# Drives the per-step setup runner (setup/index.ts --step …) rather than the
# interactive `bash nanoclaw.sh` wizard. Reference contract: docs/setup-flow.md.
#
# VERIFIED end-to-end on an M4 Pro (2026-05-21): bootstrap → environment →
# container → onecli → mounts → service → OpenCode wiring → image rebuild.
# NOT YET exercised (need tokens): channel/register + a live DeepSeek call.
#
# Required env:  DEEPSEEK_API_KEY
# Optional env:  NANOCLAW_DIR (default ./nanoclaw-v2), DEEPSEEK_MODEL (default deepseek-chat),
#                TELEGRAM_BOT_TOKEN, STATE_FILE, LOG_FILE
#
# Usage:
#   DEEPSEEK_API_KEY=... ./nanoclaw-provision.sh           # run / resume
#   ./nanoclaw-provision.sh --list                          # show steps + status
#   ./nanoclaw-provision.sh --from onecli                   # force re-run from a step (by id or number)
#   ./nanoclaw-provision.sh --only opencode_wiring          # run a single step
#   ./nanoclaw-provision.sh --restart                       # clear checkpoints, run all
set -uo pipefail   # NOT -e: errors are handled per-step by the driver

# ── config ──────────────────────────────────────────────────────────────────
NANOCLAW_DIR="${NANOCLAW_DIR:-$PWD/nanoclaw-v2}"
DEEPSEEK_MODEL="${DEEPSEEK_MODEL:-deepseek-chat}"
STATE_FILE="${STATE_FILE:-$PWD/.nanoclaw-provision.state}"
LOG_FILE="${LOG_FILE:-$PWD/nanoclaw-provision.log}"

# ── logging: tee everything (console + rolling log), timestamped ─────────────
exec > >(tee -a "$LOG_FILE") 2>&1
ts()   { date '+%Y-%m-%d %H:%M:%S'; }
log()  { printf '\033[2m%s\033[0m %s\n' "$(ts)" "$*"; }
step_banner() { printf '\n\033[1;36m== [%s] %s ==\033[0m\n' "$1" "$2"; }
ok()   { printf '\033[32m✓ %s\033[0m\n' "$*"; }
die()  { printf '\033[31m✗ ERROR: %s\033[0m\n' "$*" >&2; exit 1; }
have() { command -v "$1" >/dev/null 2>&1; }
brew_env() { [ -x /opt/homebrew/bin/brew ] && eval "$(/opt/homebrew/bin/brew shellenv)"; [ -x /usr/local/bin/brew ] && eval "$(/usr/local/bin/brew shellenv)"; return 0; }
# wire_path runs on EVERY invocation (incl. resumed runs where the install steps
# are checkpoint-skipped) so node@22/bun/local-bin are always on PATH.
wire_path() { brew_env; local p; p=$(brew --prefix 2>/dev/null); [ -n "$p" ] && [ -d "$p/opt/node@22/bin" ] && export PATH="$p/opt/node@22/bin:$PATH"; export PATH="$HOME/.bun/bin:$HOME/.local/bin:$PATH"; }

# ── checkpoint helpers ──────────────────────────────────────────────────────
is_done()   { grep -qxF "$1" "$STATE_FILE" 2>/dev/null; }
mark_done() { is_done "$1" || echo "$1" >> "$STATE_FILE"; }

# ── ordered steps (id → description). Driver runs in this order. ────────────
STEP_IDS=(prereq_clt prereq_brew prereq_tools prereq_runtime clone bootstrap \
          environment container onecli mounts service opencode_wiring \
          deepseek_config channel)
# macOS ships bash 3.2 (no associative arrays) — descriptions via a case fn.
step_desc() {
  case "$1" in
    prereq_clt)      echo "Xcode Command Line Tools" ;;
    prereq_brew)     echo "Homebrew" ;;
    prereq_tools)    echo "Node + corepack(pnpm) + git + bun" ;;
    prereq_runtime)  echo "Verify Docker is installed & running" ;;
    clone)           echo "Clone nanoclaw repo" ;;
    bootstrap)       echo "Bootstrap deps (setup.sh)" ;;
    environment)     echo "Setup step: environment" ;;
    container)       echo "Setup step: container (image build, 3-10 min)" ;;
    onecli)          echo "Setup step: onecli vault" ;;
    mounts)          echo "Setup step: mounts" ;;
    service)         echo "Setup step: service (launchd)" ;;
    opencode_wiring) echo "OpenCode provider wiring + image rebuild" ;;
    deepseek_config) echo "DeepSeek .env + OneCLI secret" ;;
    channel)         echo "Channel + first agent  [NEEDS TOKEN / UNTESTED]" ;;
  esac
}

# ════════════════════════════ step implementations ══════════════════════════
prereq_clt() {
  if xcode-select -p >/dev/null 2>&1; then ok "CLT already present"; return 0; fi
  # Headless CLT install (softwareupdate trick). Fallback is interactive xcode-select --install.
  touch /tmp/.com.apple.dt.CommandLineTools.installondemand.in-progress
  local prod; prod=$(softwareupdate -l 2>/dev/null | grep -i 'Command Line Tools' | tail -1 | sed 's/^[^C]*//;s/^\* //')
  [ -n "$prod" ] || { rm -f /tmp/.com.apple.dt.*; die "no CLT package offered — run: xcode-select --install"; }
  sudo softwareupdate -i "$prod" --verbose; local rc=$?   # needs admin/sudo rights
  rm -f /tmp/.com.apple.dt.CommandLineTools.installondemand.in-progress
  [ $rc -eq 0 ] && xcode-select -p >/dev/null 2>&1
}

prereq_brew() {
  if ! have brew; then
    NONINTERACTIVE=1 /bin/bash -c \
      "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)" || return 1
  fi
  brew_env
  have brew
}

prereq_tools() {
  brew_env
  have git || brew install git || return 1
  # Pin Node 22: brew's unversioned 'node' is bleeding-edge (e.g. 26) and the
  # lockfile-pinned better-sqlite3 won't compile against it. Container uses node:22 too.
  if ! node -v 2>/dev/null | grep -q '^v22\.'; then
    brew install node@22 || return 1
  fi
  wire_path
  # Node 22 ships corepack (pnpm); if absent, fall back to npm. setup.sh also
  # installs the pinned pnpm as a backstop.
  corepack enable >/dev/null 2>&1 || npm install -g pnpm >/dev/null 2>&1 || true
  have bun || brew install oven-sh/bun/bun || { curl -fsSL https://bun.sh/install | bash; }
  wire_path
  command -v pnpm >/dev/null 2>&1 && command -v node >/dev/null 2>&1
}

prereq_runtime() {
  # Docker is operator-provided. We don't auto-install it: Docker Desktop needs a
  # GUI + license click-through and can't be brought up headlessly. Fail fast.
  if docker info >/dev/null 2>&1; then ok "docker reachable"; return 0; fi
  printf '\033[31mDocker is not reachable. Install Docker Desktop\n  https://www.docker.com/products/docker-desktop/\nand start it (wait for the whale icon), then re-run — completed steps are skipped.\033[0m\n' >&2
  return 1
}

clone() {
  # Clone kite's fork branch — it has the Obsidian channel + OpenCode/DeepSeek
  # provider (+ env-gap patch) committed, so no source-patching is needed.
  # (Swap back to nanocoai/nanoclaw if you want a vanilla install; opencode_wiring
  # below still handles patching a vanilla clone.)
  [ -d "$NANOCLAW_DIR/.git" ] || git clone --branch kite/obsidian-channel \
    https://github.com/mfdj2002/nanoclaw.git "$NANOCLAW_DIR" || return 1
  cd "$NANOCLAW_DIR"
}

bootstrap() {
  cd "$NANOCLAW_DIR" || return 1
  bash setup.sh
}

environment() { cd "$NANOCLAW_DIR" && pnpm --silent exec tsx setup/index.ts --step environment </dev/null; }
container()   { cd "$NANOCLAW_DIR" && pnpm --silent exec tsx setup/index.ts --step container   </dev/null; }

onecli() {
  cd "$NANOCLAW_DIR" || return 1
  # OneCLI bundles Postgres on 5432; bump if taken (native PG OR a docker-published port).
  local port=5432
  lsof -nP -iTCP:5432 -sTCP:LISTEN >/dev/null 2>&1 && { port=5433; log "5432 busy → POSTGRES_PORT=5433"; }
  POSTGRES_PORT="$port" pnpm --silent exec tsx setup/index.ts --step onecli </dev/null
}

mounts()  { cd "$NANOCLAW_DIR" && pnpm --silent exec tsx setup/index.ts --step mounts --empty </dev/null; }
service() { cd "$NANOCLAW_DIR" && pnpm --silent exec tsx setup/index.ts --step service </dev/null; }
# NOTE: Anthropic 'auth' step is intentionally omitted — a DeepSeek agent needs no Anthropic secret.

opencode_wiring() {
  cd "$NANOCLAW_DIR" || return 1
  export PATH="$HOME/.bun/bin:$HOME/.local/bin:$PATH"
  # Fork already ships the OpenCode provider + env-gap patch — nothing to copy/patch.
  if grep -q "./opencode.js" src/providers/index.ts 2>/dev/null && grep -q 'ANTHROPIC_BASE_URL' src/providers/opencode.ts 2>/dev/null; then
    ok "OpenCode provider already committed (fork) — skipping source wiring"
    return 0
  fi
  git fetch origin providers || return 1
  local f
  for f in src/providers/opencode.ts \
           container/agent-runner/src/providers/opencode.ts \
           container/agent-runner/src/providers/mcp-to-opencode.ts \
           container/agent-runner/src/providers/mcp-to-opencode.test.ts \
           container/agent-runner/src/providers/opencode.factory.test.ts; do
    git show "origin/providers:$f" > "$f" || return 1
  done
  grep -q "./opencode.js" src/providers/index.ts || echo "import './opencode.js';" >> src/providers/index.ts
  grep -q "./opencode.js" container/agent-runner/src/providers/index.ts || echo "import './opencode.js';" >> container/agent-runner/src/providers/index.ts
  ( cd container/agent-runner && bun add @opencode-ai/sdk@1.4.17 ) || return 1
  grep -q 'OPENCODE_VERSION' container/Dockerfile || \
    sed -i.bak 's/^ARG VERCEL_VERSION=.*/&\nARG OPENCODE_VERSION=1.4.17/' container/Dockerfile
  grep -q 'opencode-ai@' container/Dockerfile || \
    perl -0pi -e 's/(pnpm install -g "\@anthropic-ai\/claude-code\@\$\{CLAUDE_CODE_VERSION\}")/$1\n\nRUN --mount=type=cache,target=\/root\/.cache\/pnpm \\\n    pnpm install -g "opencode-ai\@\$\{OPENCODE_VERSION\}"/' container/Dockerfile
  rm -f container/Dockerfile.bak
  # Service-mode env-gap fix: the host opencode contribution reads OPENCODE_* from
  # process.env only and never forwards ANTHROPIC_BASE_URL. But the launchd/systemd
  # service doesn't load .env into process.env, so the container defaults to
  # 'anthropic' → "no providers found". Make it read from .env (like claude.ts does)
  # and forward the baseURL. Idempotent (skips if already patched). Verified on a
  # live install 2026-05-22 — without it, opencode/DeepSeek never gets a provider.
  if ! grep -q 'ANTHROPIC_BASE_URL' src/providers/opencode.ts; then
    grep -q 'readEnvFile' src/providers/opencode.ts || \
      perl -0pi -e "s{(import \{ registerProviderContainerConfig \} from './provider-container-registry.js';)}{import { readEnvFile } from '../env.js';\n\$1}" src/providers/opencode.ts
    perl -0pi -e "s/  for \(const key of \['OPENCODE_PROVIDER', 'OPENCODE_MODEL', 'OPENCODE_SMALL_MODEL'\] as const\) \{\n    const value = ctx\.hostEnv\[key\];/  const envFile = readEnvFile(['OPENCODE_PROVIDER','OPENCODE_MODEL','OPENCODE_SMALL_MODEL','ANTHROPIC_BASE_URL']);\n  for (const key of ['OPENCODE_PROVIDER','OPENCODE_MODEL','OPENCODE_SMALL_MODEL','ANTHROPIC_BASE_URL'] as const) {\n    const value = ctx.hostEnv[key] || envFile[key];/" src/providers/opencode.ts
    grep -q 'ANTHROPIC_BASE_URL' src/providers/opencode.ts || { log 'opencode env-gap patch did not apply (upstream changed?) — check src/providers/opencode.ts'; return 1; }
  fi
  pnpm --silent run build || return 1
  pnpm --silent exec tsc -p container/agent-runner/tsconfig.json --noEmit || return 1
  ./container/build.sh || { log "build failed — if 'Unknown provider: opencode': docker builder prune -f && re-run"; return 1; }
  # WATCH-ITEM: pnpm skips opencode-ai's postinstall ("Ignored build scripts"). `opencode
  # --version` works regardless; if live calls fail with a missing-native-binary error,
  # add  only-built-dependencies[]=opencode-ai  to container/Dockerfile's /root/.npmrc block.
  docker run --rm --entrypoint sh "$(docker images --format '{{.Repository}}:{{.Tag}}' | grep nanoclaw-agent | head -1)" \
    -c 'opencode --version' >/dev/null 2>&1 && ok "opencode runs in image"
}

deepseek_config() {
  cd "$NANOCLAW_DIR" || return 1
  export PATH="$HOME/.local/bin:$PATH"
  grep -q '^OPENCODE_PROVIDER=' .env 2>/dev/null || cat >> .env <<EOF

OPENCODE_PROVIDER=deepseek
OPENCODE_MODEL=deepseek/${DEEPSEEK_MODEL}
OPENCODE_SMALL_MODEL=deepseek/${DEEPSEEK_MODEL}
ANTHROPIC_BASE_URL=https://api.deepseek.com/v1
EOF
  : "${DEEPSEEK_API_KEY:?set DEEPSEEK_API_KEY}"
  onecli secrets create --name DeepSeek --type generic \
    --value "$DEEPSEEK_API_KEY" --host-pattern api.deepseek.com \
    --header-name Authorization --value-format 'Bearer {value}' \
    || log "secret create returned non-zero (may already exist) — continuing"
  return 0
}

channel() {
  # [NEEDS TOKEN / UNTESTED] Telegram is the only fully scriptable channel.
  cd "$NANOCLAW_DIR" || return 1
  if [ -z "${TELEGRAM_BOT_TOKEN:-}" ]; then
    log "TELEGRAM_BOT_TOKEN unset — skipping channel wiring (set it to enable)"; return 0
  fi
  TELEGRAM_BOT_TOKEN="$TELEGRAM_BOT_TOKEN" bash setup/add-telegram.sh || return 1
  log "Next (manual): register the channel, flip group to 'opencode', grant DeepSeek secret:"
  log "  pnpm exec tsx setup/index.ts --step register --channel telegram --platform-id <chat-id> --name Andy"
  log "  ncl groups config update --id <group-id> --provider opencode"
  log "  onecli agents set-secret-mode --id <agent-id> --mode all"
  return 0
}

# ════════════════════════════ driver ════════════════════════════════════════
print_list() {
  echo "Steps (state: $STATE_FILE):"
  local i=1 s mark
  for s in "${STEP_IDS[@]}"; do
    if is_done "$s"; then mark="\033[32m[done]\033[0m"; else mark="[    ]"; fi
    printf "  %2d. %b %-16s %s\n" "$i" "$mark" "$s" "$(step_desc "$s")"
    i=$((i+1))
  done
}

resolve_step() {  # accept id or 1-based number → echo id
  local q="$1" i=1 s
  for s in "${STEP_IDS[@]}"; do
    [ "$q" = "$s" ] && { echo "$s"; return 0; }
    [ "$q" = "$i" ] && { echo "$s"; return 0; }
    i=$((i+1))
  done
  return 1
}

FROM=""; ONLY=""; RESTART=0
while [ $# -gt 0 ]; do
  case "$1" in
    --list)    print_list; exit 0 ;;
    --restart) RESTART=1 ;;
    --from)    FROM=$(resolve_step "$2") || die "unknown step: $2"; shift ;;
    --only)    ONLY=$(resolve_step "$2") || die "unknown step: $2"; shift ;;
    --help|-h) sed -n '2,40p' "$0"; exit 0 ;;
    *) die "unknown arg: $1 (try --help)" ;;
  esac; shift
done

[ "$(uname -s)" = "Darwin" ] || die "this script targets macOS"
[ "$RESTART" = 1 ] && { : > "$STATE_FILE"; log "checkpoints cleared"; }
# node-gyp bakes the python path UNQUOTED into its Makefile — an interpreter at a
# spaced path (e.g. a poetry venv under "~/Library/Application Support/…") breaks
# the native better-sqlite3 build. Pin a space-free interpreter for the whole run.
export npm_config_python="${npm_config_python:-/usr/bin/python3}"
export COREPACK_ENABLE_DOWNLOAD_PROMPT=0

printf '\n\033[1m######## nanoclaw-provision run @ %s ########\033[0m\n' "$(ts)"
log "state=$STATE_FILE  log=$LOG_FILE  dir=$NANOCLAW_DIR"
wire_path   # always-on: ensure node@22/bun/pnpm are on PATH even on resumed runs

reached=0
for s in "${STEP_IDS[@]}"; do
  n=$((${n:-0}+1))
  # --only: run just that step (force), skip everything else
  if [ -n "$ONLY" ]; then [ "$s" = "$ONLY" ] || continue; fi
  # --from: skip until we reach it; from there on, force re-run (ignore checkpoint)
  if [ -n "$FROM" ] && [ "$reached" = 0 ]; then
    [ "$s" = "$FROM" ] && reached=1 || { log "SKIP (before --from) $s"; continue; }
  fi
  forced=0; { [ -n "$ONLY" ] || { [ -n "$FROM" ] && [ "$reached" = 1 ]; }; } && forced=1
  if [ "$forced" = 0 ] && is_done "$s"; then log "SKIP (checkpoint) $n. $s"; continue; fi

  step_banner "$n/${#STEP_IDS[@]}" "$(step_desc "$s")"
  if "$s"; then
    mark_done "$s"; ok "step '$s' complete"
  else
    die "step '$s' failed (see $LOG_FILE). Fix the cause and re-run — completed steps are skipped."
  fi
done

printf '\n\033[1;32m######## provisioning complete ########\033[0m\n'
log "Health: curl -sf http://127.0.0.1:10254/api/health ; docker images | grep nanoclaw-agent"
