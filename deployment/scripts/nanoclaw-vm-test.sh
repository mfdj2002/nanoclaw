#!/usr/bin/env bash
# nanoclaw-vm-test.sh — runs INSIDE a vanilla macOS VM (no nested virt → no Docker).
# Exercises the self-bootstrap branches + source wiring that a real clean install
# hits, stopping before anything that needs a container runtime. Records PASS/FAIL
# per phase instead of aborting, so one run surfaces every problem.
set -uo pipefail
PASS=0; FAIL=0
ok()   { printf '\033[32mPASS\033[0m %s\n' "$1"; PASS=$((PASS+1)); }
bad()  { printf '\033[31mFAIL\033[0m %s\n' "$1"; FAIL=$((FAIL+1)); }
phase(){ printf '\n\033[1;36m== %s ==\033[0m\n' "$1"; }
run()  { "$@" && ok "$*" || bad "$*"; }

NANOCLAW_DIR="${NANOCLAW_DIR:-$HOME/nanoclaw-v2}"

phase "Xcode CLT"
if xcode-select -p >/dev/null 2>&1; then ok "CLT present"; else
  touch /tmp/.com.apple.dt.CommandLineTools.installondemand.in-progress
  PROD=$(softwareupdate -l 2>/dev/null | grep -i 'Command Line Tools' | tail -1 | sed 's/^[^C]*//;s/^\* //')
  [ -n "$PROD" ] && sudo softwareupdate -i "$PROD" --verbose && ok "CLT installed via softwareupdate" || bad "CLT install ($PROD)"
  rm -f /tmp/.com.apple.dt.CommandLineTools.installondemand.in-progress
fi

phase "Homebrew"
if command -v brew >/dev/null 2>&1; then ok "brew present"; else
  NONINTERACTIVE=1 /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)" && ok "brew installed" || bad "brew install"
fi
[ -x /opt/homebrew/bin/brew ] && eval "$(/opt/homebrew/bin/brew shellenv)"
[ -x /usr/local/bin/brew    ] && eval "$(/usr/local/bin/brew shellenv)"

phase "node@22 / pnpm / git / bun"
command -v git >/dev/null || run brew install git
# Pin Node 22 — brew's unversioned 'node' is bleeding-edge (26) and the pinned
# better-sqlite3 won't compile against it.
node -v 2>/dev/null | grep -q '^v22\.' || run brew install node@22
BP=$(brew --prefix); [ -d "$BP/opt/node@22/bin" ] && export PATH="$BP/opt/node@22/bin:$PATH"
corepack enable >/dev/null 2>&1 || npm install -g pnpm >/dev/null 2>&1 || true
command -v bun >/dev/null || { brew install oven-sh/bun/bun || { curl -fsSL https://bun.sh/install | bash; }; }
export PATH="$HOME/.bun/bin:$HOME/.local/bin:$PATH"
export npm_config_python="${npm_config_python:-/usr/bin/python3}"
export COREPACK_ENABLE_DOWNLOAD_PROMPT=0
node -v && pnpm -v && bun -v && ok "toolchain versions (node@22)" || bad "toolchain versions"

phase "clone"
[ -d "$NANOCLAW_DIR/.git" ] || run git clone https://github.com/nanocoai/nanoclaw.git "$NANOCLAW_DIR"
cd "$NANOCLAW_DIR" || { bad "cd repo"; }

phase "bootstrap (setup.sh — pnpm install + native better-sqlite3)"
run bash setup.sh

phase "environment step (docker will be absent — informational)"
pnpm --silent exec tsx setup/index.ts --step environment </dev/null 2>&1 | grep -E "DOCKER:|STATUS:" || bad "environment step ran"

phase "OpenCode wiring (no-docker portion)"
run git fetch origin providers
for f in src/providers/opencode.ts \
         container/agent-runner/src/providers/opencode.ts \
         container/agent-runner/src/providers/mcp-to-opencode.ts \
         container/agent-runner/src/providers/mcp-to-opencode.test.ts \
         container/agent-runner/src/providers/opencode.factory.test.ts; do
  git show "origin/providers:$f" > "$f" || bad "copy $f"
done
grep -q "./opencode.js" src/providers/index.ts || echo "import './opencode.js';" >> src/providers/index.ts
grep -q "./opencode.js" container/agent-runner/src/providers/index.ts || echo "import './opencode.js';" >> container/agent-runner/src/providers/index.ts
( cd container/agent-runner && bun add @opencode-ai/sdk@1.4.17 ) && ok "bun add sdk" || bad "bun add sdk"

phase "host build + container typecheck"
run pnpm --silent run build
run pnpm --silent exec tsc -p container/agent-runner/tsconfig.json --noEmit
[ -f dist/providers/opencode.js ] && ok "dist/providers/opencode.js" || bad "host opencode not compiled"

printf '\n\033[1m=== VM TEST SUMMARY: %d passed, %d failed ===\033[0m\n' "$PASS" "$FAIL"
echo "(container build / onecli / service / live DeepSeek are NOT testable here — no nested virt.)"
