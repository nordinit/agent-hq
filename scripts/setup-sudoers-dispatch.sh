#!/usr/bin/env bash
# setup-sudoers-dispatch.sh — Configure sudoers for agent dispatch.
#
# Usage:
#   sudo DISPATCH_USER=<user> ./scripts/setup-sudoers-dispatch.sh
#
# Allows the dispatch user (defaults to the invoking user) to run commands as any agent-* user
# without a password prompt. This is required for the dispatcher to execute
# agent processes under the correct OS user identity.
#
# Creates /etc/sudoers.d/agent-hq-agents (atomic write via visudo -c).
#
# Idempotent: overwrites the file on each run.
#
# Requires: sudo (must be run as root)
set -euo pipefail

if [[ "$(id -u)" -ne 0 ]]; then
  echo "Error: this script must be run as root (sudo)." >&2
  exit 1
fi

DISPATCH_USER="${DISPATCH_USER:-${SUDO_USER:-$(id -un)}}"
SUDOERS_FILE="/etc/sudoers.d/agent-hq-agents"
TEMP_FILE=$(mktemp)

echo "==> Configuring sudoers for Agent HQ agent dispatch..."
echo "    Dispatch user: ${DISPATCH_USER}"
echo "    Sudoers file:  ${SUDOERS_FILE}"

# ── Build sudoers entries ──────────────────────────────────────────────────────
# Allow the dispatch user to run any command as any agent-* user, without password.
# The wildcard pattern agent-* matches all agent OS users.
cat > "${TEMP_FILE}" <<EOF
# Agent HQ agent dispatch — allows ${DISPATCH_USER} to run processes as agent users.
# Managed by scripts/setup-sudoers-dispatch.sh — do not edit manually.
#
# Pattern: ${DISPATCH_USER} can run ANY command as any user matching agent-*
# NOPASSWD so automated dispatch does not prompt.
${DISPATCH_USER} ALL=(agent-*) NOPASSWD: ALL
EOF

# ── Validate syntax ────────────────────────────────────────────────────────────
if ! visudo -c -f "${TEMP_FILE}" &>/dev/null; then
  echo "Error: generated sudoers file has syntax errors!" >&2
  rm -f "${TEMP_FILE}"
  exit 1
fi

# ── Install ────────────────────────────────────────────────────────────────────
mv "${TEMP_FILE}" "${SUDOERS_FILE}"
chmod 0440 "${SUDOERS_FILE}"
chown root:wheel "${SUDOERS_FILE}"

echo "==> Sudoers file installed and validated."
echo ""

# ── Verify ─────────────────────────────────────────────────────────────────────
echo "==> Verification:"
echo "    Checking ${DISPATCH_USER} can sudo as agent users..."

# Quick check with sudo -l (non-destructive)
for agent_home in /Users/agent-*/; do
  if [[ -d "$agent_home" ]]; then
    agent_user=$(basename "$agent_home")
    if sudo -u "${DISPATCH_USER}" sudo -l -U "${DISPATCH_USER}" 2>/dev/null | grep -q "${agent_user}" 2>/dev/null; then
      echo "    ✓  ${DISPATCH_USER} → ${agent_user}: allowed"
    else
      echo "    ✓  ${DISPATCH_USER} → ${agent_user}: rule installed (verify with: sudo -u ${agent_user} whoami)"
    fi
  fi
done

echo ""
echo "── Summary ──────────────────────────────────────────────────"
echo "   ${DISPATCH_USER} can now run: sudo -u agent-<slug> <command>"
echo "   Sudoers file: ${SUDOERS_FILE}"
echo "─────────────────────────────────────────────────────────────"
