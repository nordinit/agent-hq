#!/usr/bin/env bash
# init.sh — idempotent repo-harness setup for Agent HQ.
# Safe to run repeatedly from a clean clone or an existing checkout.
set -uo pipefail
cd "$(dirname "$0")"

warn() { printf 'WARN  %s\n' "$*"; }
step() { printf '\n== %s\n' "$*"; }

step "toolchain"
for tool in node npm; do
  if command -v "$tool" >/dev/null 2>&1; then
    printf '  %-5s %s\n' "$tool" "$(command -v "$tool")"
  else
    warn "$tool not on PATH — required"
  fi
done

step "dependencies"
if command -v npm >/dev/null 2>&1; then
  if [ -f package-lock.json ]; then npm ci || npm install; else npm install; fi
  if [ -f cli/package.json ]; then (cd cli && { [ -f package-lock.json ] && npm ci || npm install; }); fi
else
  warn "npm missing — cannot install"
fi

step "smoke"
npm run status || warn "status check failed (services may simply be stopped — try 'npm run start')"

cat <<'NEXT'

Next steps:
  npm run test:cli   # CLI unit tests
  npm run start      # bring the control plane up
  npm run open       # admin UI
NEXT
