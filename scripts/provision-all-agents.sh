#!/usr/bin/env bash
# provision-all-agents.sh — Create dedicated OS users for all known agents.
#
# Usage:
#   sudo ./scripts/provision-all-agents.sh
#
# Calls provision-agent-user.sh for each agent slug. Idempotent.
#
# Requires: sudo (must be run as root)
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROVISION_SCRIPT="${SCRIPT_DIR}/provision-agent-user.sh"

if [[ ! -x "$PROVISION_SCRIPT" ]]; then
  echo "Error: provision-agent-user.sh not found or not executable at ${PROVISION_SCRIPT}" >&2
  exit 1
fi

if [[ "$(id -u)" -ne 0 ]]; then
  echo "Error: this script must be run as root (sudo)." >&2
  exit 1
fi

# ── Agent slugs ────────────────────────────────────────────────────────────────
# Each agent gets a dedicated OS user: agent-<slug>
# Add new agents here as they are onboarded.
AGENT_SLUGS=(
  forge       # agency-backend
  pixel       # agency-frontend
  scout       # agency-qa
  rook        # agency-qa2
  harbor      # agency-devops
  wren        # agency-pm
  kai         # software-engineer
  rex         # trader
  pulse       # pulse
)

echo "============================================================"
echo " Provisioning ${#AGENT_SLUGS[@]} agent OS users"
echo "============================================================"
echo ""

ERRORS=0
for slug in "${AGENT_SLUGS[@]}"; do
  echo "────────────────────────────────────────────────────────────"
  if ! "${PROVISION_SCRIPT}" "agent-${slug}"; then
    echo "⚠️  Failed to provision agent-${slug}" >&2
    ERRORS=$((ERRORS + 1))
  fi
  echo ""
done

echo "============================================================"
if [[ "$ERRORS" -gt 0 ]]; then
  echo " Done with ${ERRORS} error(s). Review output above."
  exit 1
else
  echo " All ${#AGENT_SLUGS[@]} agent users provisioned successfully."
fi
echo "============================================================"
