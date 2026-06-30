#!/usr/bin/env bash
# nanoclaw-boot-fix.sh
# Diagnose + repair "daemon not reachable … is the nanoclaw service running?"
# after a reboot. Safe to run repeatedly. Run as your normal user — NOT with sudo.

set -uo pipefail

b(){    printf '\033[1m%s\033[0m\n' "$*"; }
ok(){   printf '\033[32m  ✓ %s\033[0m\n' "$*"; }
warn(){ printf '\033[33m  ! %s\033[0m\n' "$*"; }
bad(){  printf '\033[31m  ✗ %s\033[0m\n' "$*"; }
hr(){   printf '\033[2m──────────────────────────────────────────────\033[0m\n'; }

# ── locate the install ───────────────────────────────────────────────────────
INSTALL="${NANOCLAW_DIR:-$HOME/nanoclaw}"
if [ ! -f "$INSTALL/dist/index.js" ]; then
  found="$(find "$HOME" -maxdepth 6 \( -name Library -o -name node_modules -o -name .git \) -prune \
           -o -path '*nanoclaw*/dist/index.js' -print 2>/dev/null | head -1)"
  [ -n "$found" ] && INSTALL="$(cd "$(dirname "$found")/.." && pwd)"
fi
[ -f "$INSTALL/dist/index.js" ] || { bad "No NanoClaw install found (no dist/index.js). Set NANOCLAW_DIR=/path/to/install and re-run."; exit 1; }

SLUG="$(printf '%s' "$INSTALL" | shasum | cut -c1-8)"
LABEL="com.nanoclaw-v2-$SLUG"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
SOCK="$INSTALL/data/obsidian.sock"
U="$(id -u)"

b "NanoClaw boot doctor"
echo "  install : $INSTALL"
echo "  label   : $LABEL"
echo "  socket  : $SOCK"
hr

# ── 1) DIAGNOSE (read-only) ──────────────────────────────────────────────────
b "1) Current state"
if docker info >/dev/null 2>&1; then ok "Docker is running"; DOCKER_OK=1
else bad "Docker is NOT running  ← the daemon refuses to start without it"; DOCKER_OK=0; fi

if [ -f "$PLIST" ]; then ok "plist present"; else bad "plist MISSING ($PLIST)"; fi

if launchctl print "gui/$U/$LABEL" >/dev/null 2>&1; then
  ok "LaunchAgent is loaded"
  launchctl print "gui/$U/$LABEL" 2>/dev/null | grep -E 'state =|last exit code =|pid =' | sed 's/^/      /'
else
  warn "LaunchAgent is NOT loaded"
fi

# node path baked into the plist must still exist (nvm upgrades move it)
NODE_IN_PLIST="$(grep -o '/[^<]*/bin/node' "$PLIST" 2>/dev/null | head -1)"
if [ -n "$NODE_IN_PLIST" ]; then
  if [ -x "$NODE_IN_PLIST" ]; then ok "node path OK ($NODE_IN_PLIST)"
  else bad "node path in plist is GONE: $NODE_IN_PLIST  (nvm upgrade? will regenerate below)"; fi
fi

[ -S "$SOCK" ] && ok "socket exists" || bad "socket missing → plugin can't connect"

if [ -f "$INSTALL/logs/nanoclaw.error.log" ]; then
  echo; b "   tail of logs/nanoclaw.error.log:"
  tail -n 15 "$INSTALL/logs/nanoclaw.error.log" | sed 's/^/      /'
fi
hr

# ── 2) REPAIR ────────────────────────────────────────────────────────────────
b "2) Repair"

# 2a. Bring Docker up and WAIT until it's actually ready
if [ "$DOCKER_OK" -ne 1 ]; then
  warn "Starting Docker Desktop…"
  open -a Docker 2>/dev/null || open -a "Docker Desktop" 2>/dev/null || bad "Couldn't open Docker — is Docker Desktop in /Applications?"
  printf "      waiting for Docker"
  for _ in $(seq 1 60); do docker info >/dev/null 2>&1 && { DOCKER_OK=1; break; }; printf "."; sleep 2; done
  echo
  [ "$DOCKER_OK" -eq 1 ] && ok "Docker ready" || bad "Docker still not ready after 2 min — open it by hand, then re-run."
fi

# 2b. Make Docker auto-start at login so the NEXT reboot just works
if ! osascript -e 'tell application "System Events" to get the name of every login item' 2>/dev/null | grep -qi docker; then
  osascript -e 'tell application "System Events" to make login item at end with properties {path:"/Applications/Docker.app", hidden:true}' >/dev/null 2>&1 \
    && ok "Added Docker to Login Items (auto-start at next reboot)" \
    || warn "Couldn't add Docker to Login Items — turn on 'Start Docker Desktop when you sign in' in Docker → Settings."
else
  ok "Docker already auto-starts at login"
fi

# 2c. If the baked-in node path died, regenerate the plist with the current node
if [ -n "$NODE_IN_PLIST" ] && [ ! -x "$NODE_IN_PLIST" ]; then
  warn "Regenerating the service for the current node…"
  ( cd "$INSTALL" && pnpm exec tsx setup/index.ts --step service ) \
    && ok "service regenerated" \
    || warn "auto-regen failed — run by hand: cd $INSTALL && pnpm exec tsx setup/index.ts --step service"
fi

# 2d. Clear any wedged crash-backoff so it restarts immediately (not in 15 min)
[ -f "$INSTALL/data/circuit-breaker.json" ] && rm -f "$INSTALL/data/circuit-breaker.json" && ok "cleared crash-backoff timer"

# 2e. (Re)load + force-restart the service
launchctl unload "$PLIST" >/dev/null 2>&1
launchctl load   "$PLIST" >/dev/null 2>&1 && ok "service loaded" || bad "launchctl load failed"
launchctl kickstart -k "gui/$U/$LABEL" >/dev/null 2>&1 && ok "daemon kickstarted"

# 2f. Wait for the socket to appear
printf "      waiting for the daemon to bind its socket"
for _ in $(seq 1 30); do [ -S "$SOCK" ] && break; printf "."; sleep 1; done
echo
hr

# ── 3) VERDICT ───────────────────────────────────────────────────────────────
b "3) Result"
docker info >/dev/null 2>&1 && ok "Docker: running" || bad "Docker: down"
launchctl print "gui/$U/$LABEL" >/dev/null 2>&1 && ok "Service: loaded" || bad "Service: not loaded"
if [ -S "$SOCK" ]; then
  ok "Socket: present  →  reload Obsidian (or the plugin) and ask Andy again"
  echo
  b "Reboot test: restart the Mac, wait ~1 min for Docker, then just open Obsidian — no terminal needed."
else
  bad "Socket still missing. Send these lines back:"
  tail -n 25 "$INSTALL/logs/nanoclaw.error.log" 2>/dev/null | sed 's/^/      /'
fi
