#!/usr/bin/env bash
# provision-agent-user.sh — Create a dedicated macOS OS user for an agent.
#
# Usage:
#   sudo ./scripts/provision-agent-user.sh <agent-user>
#
# Example:
#   sudo ./scripts/provision-agent-user.sh agent-forge
#
# Creates:
#   - macOS user <agent-user> with home /Users/<agent-user>/
#   - /Users/<agent-user>/workspaces/ — writable workspace root
#   - No admin group membership, no sudo access
#   - Home directory permissions: 700 (no other agent can access)
#
# Idempotent: safe to re-run. Skips steps already completed.
#
# Requires: sudo (must be run as root)
set -euo pipefail

# ── Args & validation ──────────────────────────────────────────────────────────
if [[ $# -lt 1 ]]; then
  echo "Usage: $(basename "$0") <agent-user>" >&2
  echo "  e.g. $(basename "$0") agent-forge" >&2
  exit 1
fi

AGENT_USER="$1"

# Validate the user name starts with "agent-"
if [[ ! "$AGENT_USER" =~ ^agent- ]]; then
  echo "Error: agent user must start with 'agent-' (got: ${AGENT_USER})" >&2
  exit 1
fi

if [[ "$(id -u)" -ne 0 ]]; then
  echo "Error: this script must be run as root (sudo)." >&2
  exit 1
fi

AGENT_HOME="/Users/${AGENT_USER}"
WORKSPACES_DIR="${AGENT_HOME}/workspaces"

echo "==> Provisioning OS user: ${AGENT_USER}"
echo "    Home: ${AGENT_HOME}"
echo "    Workspaces: ${WORKSPACES_DIR}"

# ── Step 1: Find a free UID in the 600-699 range ──────────────────────────────
# macOS convention: 500+ are non-system users, 600-699 reserved for agents.
find_free_uid() {
  for uid in $(seq 600 699); do
    if ! dscl . -list /Users UniqueID 2>/dev/null | awk '{print $2}' | grep -qx "$uid"; then
      echo "$uid"
      return
    fi
  done
  echo ""
}

# ── Step 2: Check if user already exists ───────────────────────────────────────
if dscl . -read "/Users/${AGENT_USER}" UniqueID &>/dev/null; then
  EXISTING_UID=$(dscl . -read "/Users/${AGENT_USER}" UniqueID | awk '{print $2}')
  echo "==> User ${AGENT_USER} already exists (UID=${EXISTING_UID}) — skipping creation."
else
  AGENT_UID=$(find_free_uid)
  if [[ -z "$AGENT_UID" ]]; then
    echo "Error: no free UID in range 600-699." >&2
    exit 1
  fi

  echo "==> Creating user ${AGENT_USER} with UID=${AGENT_UID}..."

  # Create the user record
  dscl . -create "/Users/${AGENT_USER}"
  dscl . -create "/Users/${AGENT_USER}" UserShell /usr/bin/false
  dscl . -create "/Users/${AGENT_USER}" RealName "Agent ${AGENT_USER#agent-}"
  dscl . -create "/Users/${AGENT_USER}" UniqueID "${AGENT_UID}"
  dscl . -create "/Users/${AGENT_USER}" PrimaryGroupID 20  # staff group
  dscl . -create "/Users/${AGENT_USER}" NFSHomeDirectory "${AGENT_HOME}"

  # Set a random password (user won't log in interactively)
  RANDOM_PASS=$(openssl rand -base64 32)
  dscl . -passwd "/Users/${AGENT_USER}" "${RANDOM_PASS}"
  unset RANDOM_PASS

  echo "==> User ${AGENT_USER} created (UID=${AGENT_UID})."
fi

# ── Step 3: Remove from admin group if present ─────────────────────────────────
if dseditgroup -o checkmember -m "${AGENT_USER}" admin &>/dev/null; then
  dseditgroup -o edit -d "${AGENT_USER}" -t user admin 2>/dev/null || true
  echo "==> Removed ${AGENT_USER} from admin group."
else
  echo "==> ${AGENT_USER} is not in admin group — good."
fi

# ── Step 4: Create home + workspaces directory ─────────────────────────────────
if [[ ! -d "$AGENT_HOME" ]]; then
  mkdir -p "$AGENT_HOME"
  echo "==> Created home directory: ${AGENT_HOME}"
fi

chown "${AGENT_USER}:staff" "${AGENT_HOME}"
chmod 700 "${AGENT_HOME}"

if [[ ! -d "$WORKSPACES_DIR" ]]; then
  mkdir -p "$WORKSPACES_DIR"
  echo "==> Created workspaces directory: ${WORKSPACES_DIR}"
fi

chown "${AGENT_USER}:staff" "${WORKSPACES_DIR}"
chmod 755 "${WORKSPACES_DIR}"

# ── Step 5: Verify ─────────────────────────────────────────────────────────────
FINAL_UID=$(dscl . -read "/Users/${AGENT_USER}" UniqueID 2>/dev/null | awk '{print $2}')
echo ""
echo "── Summary ──────────────────────────────────────────────────"
echo "   User:       ${AGENT_USER}"
echo "   UID:        ${FINAL_UID}"
echo "   Home:       ${AGENT_HOME}"
echo "   Workspaces: ${WORKSPACES_DIR}"
echo "   Home perms: $(stat -f '%Sp' "${AGENT_HOME}") (700 = owner-only)"
echo "   Admin grp:  $(dseditgroup -o checkmember -m "${AGENT_USER}" admin &>/dev/null && echo "YES ⚠️" || echo "no ✓")"
echo "─────────────────────────────────────────────────────────────"
