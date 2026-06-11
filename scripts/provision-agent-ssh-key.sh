#!/usr/bin/env bash
# provision-agent-ssh-key.sh <agent_id>
#
# Generates a per-agent ed25519 SSH key pair and registers it as a GitHub
# Deploy Key on the agent-hq repo (read_only=false so agents can push branches).
#
# Usage:
#   GITHUB_TOKEN=<pat> ./scripts/provision-agent-ssh-key.sh <agent_id>
#
# Requirements:
#   - GITHUB_TOKEN env var: a GitHub PAT with `admin:public_key` + repo admin scope
#   - ssh-keygen, curl, jq
#
# Idempotency:
#   - If the key pair already exists locally, generation is skipped.
#   - If the public key is already registered on GitHub (matched by title),
#     the existing deploy key is reported and no duplicate is created.
#   - If the key exists locally but is missing from GitHub, it is re-registered.

set -euo pipefail

# ── Constants ──────────────────────────────────────────────────────────────────
GITHUB_OWNER="${GITHUB_OWNER:-nordinit}"
GITHUB_REPO="${GITHUB_REPO:-agent-hq}"
GITHUB_API="https://api.github.com"
KEYS_DIR="$(cd "$(dirname "$0")/.." && pwd)/docker/keys"

# ── Args & env validation ──────────────────────────────────────────────────────
if [[ $# -lt 1 ]]; then
  echo "Usage: $(basename "$0") <agent_id>" >&2
  exit 1
fi

AGENT_ID="$1"

if [[ -z "${GITHUB_TOKEN:-}" ]]; then
  echo "Error: GITHUB_TOKEN environment variable is required." >&2
  echo "  export GITHUB_TOKEN=<github-pat-with-repo-admin-scope>" >&2
  exit 1
fi

for bin in ssh-keygen curl jq; do
  if ! command -v "$bin" &>/dev/null; then
    echo "Error: '$bin' is required but not found in PATH." >&2
    exit 1
  fi
done

# ── Paths ──────────────────────────────────────────────────────────────────────
KEY_DIR="${KEYS_DIR}/${AGENT_ID}"
PRIVATE_KEY="${KEY_DIR}/id_ed25519"
PUBLIC_KEY="${KEY_DIR}/id_ed25519.pub"
KEY_TITLE="agent-hq-agent-${AGENT_ID}"

echo "==> Agent:      ${AGENT_ID}"
echo "==> Key title:  ${KEY_TITLE}"
echo "==> Key dir:    ${KEY_DIR}"

# ── Step 1: Generate key pair if missing ──────────────────────────────────────
if [[ -f "${PRIVATE_KEY}" && -f "${PUBLIC_KEY}" ]]; then
  echo "==> Key pair already exists — skipping generation."
else
  echo "==> Generating ed25519 key pair..."
  mkdir -p "${KEY_DIR}"
  chmod 700 "${KEY_DIR}"
  ssh-keygen -t ed25519 -C "${KEY_TITLE}" -f "${PRIVATE_KEY}" -N ""
  chmod 600 "${PRIVATE_KEY}"
  chmod 644 "${PUBLIC_KEY}"
  echo "==> Key pair generated."
fi

# ── Print fingerprint ─────────────────────────────────────────────────────────
FINGERPRINT=$(ssh-keygen -lf "${PUBLIC_KEY}" | awk '{print $2}')
echo "==> Fingerprint: ${FINGERPRINT}"

PUB_KEY_CONTENT=$(cat "${PUBLIC_KEY}")

# ── Step 2: Check for existing GitHub deploy key with matching title ───────────
echo "==> Checking GitHub for existing deploy key titled '${KEY_TITLE}'..."

EXISTING=$(curl -sf \
  -H "Authorization: token ${GITHUB_TOKEN}" \
  -H "Accept: application/vnd.github+json" \
  "${GITHUB_API}/repos/${GITHUB_OWNER}/${GITHUB_REPO}/keys" \
  | jq -r --arg title "${KEY_TITLE}" '.[] | select(.title == $title)')

if [[ -n "${EXISTING}" ]]; then
  EXISTING_ID=$(echo "${EXISTING}" | jq -r '.id')
  EXISTING_KEY=$(echo "${EXISTING}" | jq -r '.key')

  # Normalize keys for comparison (strip trailing whitespace/newlines)
  LOCAL_KEY_BODY=$(echo "${PUB_KEY_CONTENT}" | awk '{print $1, $2}')
  REMOTE_KEY_BODY=$(echo "${EXISTING_KEY}" | awk '{print $1, $2}')

  if [[ "${LOCAL_KEY_BODY}" == "${REMOTE_KEY_BODY}" ]]; then
    echo "==> Deploy key already registered on GitHub (id=${EXISTING_ID}) and matches local key — nothing to do."
    echo ""
    echo "── Summary ──────────────────────────────────────────────────"
    echo "   Agent ID:          ${AGENT_ID}"
    echo "   Key title:         ${KEY_TITLE}"
    echo "   Fingerprint:       ${FINGERPRINT}"
    echo "   GitHub deploy key: ${EXISTING_ID}"
    echo "   Private key path:  ${PRIVATE_KEY}"
    echo "─────────────────────────────────────────────────────────────"
    exit 0
  else
    echo "==> Found existing deploy key id=${EXISTING_ID} with same title but different key content."
    echo "==> Deleting stale GitHub deploy key id=${EXISTING_ID} and re-registering..."
    curl -sf \
      -X DELETE \
      -H "Authorization: token ${GITHUB_TOKEN}" \
      -H "Accept: application/vnd.github+json" \
      "${GITHUB_API}/repos/${GITHUB_OWNER}/${GITHUB_REPO}/keys/${EXISTING_ID}"
    echo "==> Stale key deleted."
  fi
fi

# ── Step 3: Register public key as GitHub deploy key ─────────────────────────
echo "==> Registering public key with GitHub as deploy key..."

REGISTER_RESPONSE=$(curl -sf \
  -X POST \
  -H "Authorization: token ${GITHUB_TOKEN}" \
  -H "Accept: application/vnd.github+json" \
  "${GITHUB_API}/repos/${GITHUB_OWNER}/${GITHUB_REPO}/keys" \
  -d "$(jq -n \
    --arg title "${KEY_TITLE}" \
    --arg key "${PUB_KEY_CONTENT}" \
    '{title: $title, key: $key, read_only: false}')")

DEPLOY_KEY_ID=$(echo "${REGISTER_RESPONSE}" | jq -r '.id')

if [[ -z "${DEPLOY_KEY_ID}" || "${DEPLOY_KEY_ID}" == "null" ]]; then
  echo "Error: Failed to register deploy key. GitHub response:" >&2
  echo "${REGISTER_RESPONSE}" >&2
  exit 1
fi

echo "==> Deploy key registered successfully."
echo ""
echo "── Summary ──────────────────────────────────────────────────"
echo "   Agent ID:          ${AGENT_ID}"
echo "   Key title:         ${KEY_TITLE}"
echo "   Fingerprint:       ${FINGERPRINT}"
echo "   GitHub deploy key: ${DEPLOY_KEY_ID}"
echo "   Private key path:  ${PRIVATE_KEY}"
echo "   Read-only:         false (write access enabled)"
echo "─────────────────────────────────────────────────────────────"
