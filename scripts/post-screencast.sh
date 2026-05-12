#!/usr/bin/env bash
# post-screencast.sh — Restore production state after Fumireply screencast recording.
#
# What this script does:
#   1. Disables reviewer account (ban_duration=876000h, approximately 100 years)
#   2. Optionally rotates reviewer password (--rotate-password)
#   3. Optionally deletes the just-connected page and its conversations (--cleanup-recording-data)
#   4. Appends an audit log entry
#
# Usage:
#   bash scripts/post-screencast.sh                              # disable reviewer only
#   bash scripts/post-screencast.sh --rotate-password           # also rotate password
#   bash scripts/post-screencast.sh --cleanup-recording-data    # also delete recording data
#   bash scripts/post-screencast.sh --dry-run                   # print plan; skips SSM fetch and all mutations
#
# WARNING: Do NOT run --rotate-password until AFTER Meta notifies the review result.
# Rotating the password mid-review causes "Cannot reproduce" rejections.

set -euo pipefail

# ── Constants ────────────────────────────────────────────────────────────────

REVIEWER_EMAIL="reviewer@malbek.co.jp"
MALBEK_TENANT_SLUG="malbek"
SSM_PREFIX="/fumireply/review/supabase"
# Supabase ban_duration accepts duration strings; 876000h ≈ 100 years
BAN_DURATION="876000h"
AUDIT_LOG="docs/operations/audit-runbook.md"

# ── Argument parsing ──────────────────────────────────────────────────────────

DRY_RUN=false
ROTATE_PASSWORD=false
CLEANUP_RECORDING_DATA=false

for arg in "$@"; do
  case "$arg" in
    --dry-run)              DRY_RUN=true ;;
    --rotate-password)      ROTATE_PASSWORD=true ;;
    --cleanup-recording-data) CLEANUP_RECORDING_DATA=true ;;
    *) echo "Unknown argument: $arg" >&2; exit 1 ;;
  esac
done

# ── Helpers ───────────────────────────────────────────────────────────────────

log() { echo "[post-screencast] $*"; }
dry() { echo "[DRY-RUN] $*"; }

require_tool() {
  command -v "$1" >/dev/null 2>&1 || { echo "Required tool not found: $1" >&2; exit 1; }
}

ssm_get() {
  aws ssm get-parameter \
    --name "$1" \
    --with-decryption \
    --query 'Parameter.Value' \
    --output text
}

ssm_put() {
  aws ssm put-parameter \
    --name "$1" \
    --value "$2" \
    --type SecureString \
    --overwrite \
    > /dev/null
}

# ── DRY-RUN: print plan and exit without fetching secrets ────────────────────

if $DRY_RUN; then
  echo ""
  dry "=== post-screencast plan ==="
  dry "Would fetch SSM: ${SSM_PREFIX}/url"
  dry "Would fetch SSM: ${SSM_PREFIX}/secret-key  [redacted]"
  if $CLEANUP_RECORDING_DATA; then
    dry "Would fetch SSM: ${SSM_PREFIX}/db-url  [redacted]"
  fi
  dry ""
  dry "Would GET /auth/v1/admin/users?email=${REVIEWER_EMAIL}"
  dry "  → extract reviewer UUID with jq"
  dry "Would PATCH /auth/v1/admin/users/<REVIEWER_UUID> → ban_duration=${BAN_DURATION} (disable account)"
  dry ""
  if $ROTATE_PASSWORD; then
    dry "Would generate new password via openssl rand -base64 24"
    dry "Would PATCH /auth/v1/admin/users/<REVIEWER_UUID> with new password"
    dry "Would SSM put-parameter ${SSM_PREFIX}/reviewer-password  [redacted]"
    dry ""
  fi
  if $CLEANUP_RECORDING_DATA; then
    dry "Would SELECT id FROM tenants WHERE slug = '${MALBEK_TENANT_SLUG}'"
    dry "Would DELETE ai_drafts / messages / conversations / connected_pages for tenant '${MALBEK_TENANT_SLUG}'"
    dry ""
  fi
  dry "Would append audit row to ${AUDIT_LOG} (if file exists)"
  echo ""
  echo "════════════════════════════════════════════════"
  echo "  DRY RUN complete — no secrets fetched, no changes made."
  echo "════════════════════════════════════════════════"
  exit 0
fi

# ── Step 0: Validate tools (live run only) ───────────────────────────────────

log "Validating required tools..."
require_tool aws
require_tool curl
require_tool jq
if $CLEANUP_RECORDING_DATA; then require_tool psql; fi
if $ROTATE_PASSWORD; then require_tool openssl; fi

# ── Step 1: Fetch SSM parameters ─────────────────────────────────────────────

log "Fetching SSM parameters..."
SUPABASE_URL=$(ssm_get "${SSM_PREFIX}/url")
SUPABASE_SECRET_KEY=$(ssm_get "${SSM_PREFIX}/secret-key")
if $CLEANUP_RECORDING_DATA; then
  DATABASE_URL=$(ssm_get "${SSM_PREFIX}/db-url")
fi
log "SSM fetch OK."

# ── Step 2: Disable reviewer account ─────────────────────────────────────────

log "Looking up reviewer UUID in Supabase..."
REVIEWER_UUID=$(curl -fsSL \
  -H "Authorization: Bearer ${SUPABASE_SECRET_KEY}" \
  -H "apikey: ${SUPABASE_SECRET_KEY}" \
  "${SUPABASE_URL}/auth/v1/admin/users?email=${REVIEWER_EMAIL}" \
  | jq -r '.users[0].id // empty')

if [[ -z "$REVIEWER_UUID" ]]; then
  echo "ERROR: Could not find reviewer account for ${REVIEWER_EMAIL}" >&2
  exit 1
fi

curl -fsSL -X PATCH \
  -H "Authorization: Bearer ${SUPABASE_SECRET_KEY}" \
  -H "apikey: ${SUPABASE_SECRET_KEY}" \
  -H "Content-Type: application/json" \
  -d "{\"ban_duration\":\"${BAN_DURATION}\"}" \
  "${SUPABASE_URL}/auth/v1/admin/users/${REVIEWER_UUID}" \
  > /dev/null
log "Reviewer account disabled (ban_duration=${BAN_DURATION}, ≈100 years)."

# ── Step 3: Rotate reviewer password (optional) ───────────────────────────────

if $ROTATE_PASSWORD; then
  NEW_PASSWORD=$(openssl rand -base64 24)
  curl -fsSL -X PATCH \
    -H "Authorization: Bearer ${SUPABASE_SECRET_KEY}" \
    -H "apikey: ${SUPABASE_SECRET_KEY}" \
    -H "Content-Type: application/json" \
    -d "{\"password\":\"${NEW_PASSWORD}\"}" \
    "${SUPABASE_URL}/auth/v1/admin/users/${REVIEWER_UUID}" \
    > /dev/null
  ssm_put "${SSM_PREFIX}/reviewer-password" "$NEW_PASSWORD"
  log "Reviewer password rotated and SSM updated."
  NEW_PASSWORD=""
fi

# ── Step 4: Delete recording data (optional) ─────────────────────────────────

if $CLEANUP_RECORDING_DATA; then
  log "Fetching Malbek tenant ID from DB..."
  MALBEK_TENANT_ID=$(psql "$DATABASE_URL" -tAc \
    "SELECT id FROM tenants WHERE slug = '${MALBEK_TENANT_SLUG}' LIMIT 1;")

  if [[ -z "$MALBEK_TENANT_ID" ]]; then
    echo "ERROR: Could not find tenant with slug '${MALBEK_TENANT_SLUG}'" >&2
    exit 1
  fi

  # Delete in dependency order: ai_drafts → messages → conversations → connected_pages
  psql "$DATABASE_URL" <<'SQL'
BEGIN;
DELETE FROM ai_drafts
  WHERE conversation_id IN (
    SELECT id FROM conversations WHERE tenant_id = (
      SELECT id FROM tenants WHERE slug = 'malbek'
    )
  );
DELETE FROM messages
  WHERE conversation_id IN (
    SELECT id FROM conversations WHERE tenant_id = (
      SELECT id FROM tenants WHERE slug = 'malbek'
    )
  );
DELETE FROM conversations
  WHERE tenant_id = (SELECT id FROM tenants WHERE slug = 'malbek');
DELETE FROM connected_pages
  WHERE tenant_id = (SELECT id FROM tenants WHERE slug = 'malbek');
COMMIT;
SQL
  log "Recording data deleted for tenant '${MALBEK_TENANT_SLUG}'."
fi

# ── Step 5: Audit log ─────────────────────────────────────────────────────────

TIMESTAMP=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
ACTIONS="reviewer disabled (${BAN_DURATION})"
$ROTATE_PASSWORD && ACTIONS="${ACTIONS}, password rotated"
$CLEANUP_RECORDING_DATA && ACTIONS="${ACTIONS}, recording data deleted"
AUDIT_ENTRY="| ${TIMESTAMP} | post-screencast | ${ACTIONS} | $(whoami) |"

if [[ -f "$AUDIT_LOG" ]]; then
  echo "$AUDIT_ENTRY" >> "$AUDIT_LOG"
  log "Audit entry appended to ${AUDIT_LOG}."
else
  log "Warning: ${AUDIT_LOG} not found — skipping audit log append."
fi

# ── Done ─────────────────────────────────────────────────────────────────────

echo ""
echo "════════════════════════════════════════════════"
echo "  post-screencast COMPLETE"
echo ""
echo "  Reviewer account: DISABLED (ban_duration=${BAN_DURATION}, ≈100 years)"
$ROTATE_PASSWORD && echo "  Password: ROTATED (new value in SSM)"
$CLEANUP_RECORDING_DATA && echo "  Recording data: DELETED"
echo "════════════════════════════════════════════════"
