#!/usr/bin/env bash
# prep-screencast.sh — Prepare production state for Fumireply screencast recording.
#
# What this script does:
#   1. Validates required tools
#   2. Fetches SSM parameters (skipped in --dry-run)
#   3. Enables reviewer account by setting banned_until = NULL via Supabase Admin API
#   4. Deletes the Malbek tenant's connected_pages row so onboarding flow is visible
#   5. Runs HTTP health checks on all public URLs
#   6. Appends an audit log entry
#
# Usage:
#   bash scripts/prep-screencast.sh            # live run (requires AWS CLI + psql)
#   bash scripts/prep-screencast.sh --dry-run  # print plan; skips SSM fetch and all mutations
#
# Prerequisites:
#   - AWS CLI configured (AWS_PROFILE env var or default profile)
#   - SSM parameters under /fumireply/review/supabase/{url,secret-key,reviewer-password,db-url}
#   - jq and psql available on PATH

set -euo pipefail

# ── Constants ────────────────────────────────────────────────────────────────

REVIEWER_EMAIL="reviewer@malbek.co.jp"
MALBEK_TENANT_SLUG="malbek"
REVIEW_BASE_URL="https://review.fumireply.ecsuite.work"
SSM_PREFIX="/fumireply/review/supabase"
AUDIT_LOG="docs/operations/audit-runbook.md"

HEALTH_URLS=(
  "$REVIEW_BASE_URL"
  "$REVIEW_BASE_URL/login"
  "$REVIEW_BASE_URL/privacy"
  "$REVIEW_BASE_URL/terms"
  "$REVIEW_BASE_URL/data-deletion"
)

# ── Argument parsing ──────────────────────────────────────────────────────────

DRY_RUN=false
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=true ;;
    *) echo "Unknown argument: $arg" >&2; exit 1 ;;
  esac
done

# ── Helpers ───────────────────────────────────────────────────────────────────

log() { echo "[prep-screencast] $*"; }
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

# ── DRY-RUN: print plan and exit without fetching secrets ────────────────────

if $DRY_RUN; then
  echo ""
  dry "=== prep-screencast plan ==="
  dry "Would fetch SSM: ${SSM_PREFIX}/url"
  dry "Would fetch SSM: ${SSM_PREFIX}/secret-key  [redacted]"
  dry "Would fetch SSM: ${SSM_PREFIX}/reviewer-password  [redacted]"
  dry "Would fetch SSM: ${SSM_PREFIX}/db-url  [redacted]"
  dry ""
  dry "Would copy reviewer password to clipboard via pbcopy (macOS)"
  dry ""
  dry "Would GET ${SSM_PREFIX}/url/auth/v1/admin/users?email=${REVIEWER_EMAIL}"
  dry "  → extract reviewer UUID with jq"
  dry "Would PATCH /auth/v1/admin/users/<REVIEWER_UUID> → ban_duration=none  (enable account)"
  dry ""
  dry "Would SELECT id FROM tenants WHERE slug = '${MALBEK_TENANT_SLUG}'"
  dry "Would DELETE FROM connected_pages WHERE tenant_id = '<MALBEK_TENANT_ID>'"
  dry ""
  for url in "${HEALTH_URLS[@]}"; do
    dry "Would curl --max-time 10 $url  (expect 200)"
  done
  dry ""
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
require_tool psql

# ── Step 1: Fetch SSM parameters ─────────────────────────────────────────────

log "Fetching SSM parameters..."
SUPABASE_URL=$(ssm_get "${SSM_PREFIX}/url")
SUPABASE_SECRET_KEY=$(ssm_get "${SSM_PREFIX}/secret-key")
REVIEWER_PASSWORD=$(ssm_get "${SSM_PREFIX}/reviewer-password")
DATABASE_URL=$(ssm_get "${SSM_PREFIX}/db-url")
log "SSM fetch OK."

# Copy password to clipboard (macOS only — silent fail on Linux)
if command -v pbcopy >/dev/null 2>&1; then
  printf '%s' "$REVIEWER_PASSWORD" | pbcopy
  log "Reviewer password copied to clipboard."
else
  log "Note: pbcopy not available — password NOT copied to clipboard. Retrieve manually."
fi

# ── Step 2: Enable reviewer account (banned_until = NULL) ────────────────────

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
  -d '{"ban_duration":"none"}' \
  "${SUPABASE_URL}/auth/v1/admin/users/${REVIEWER_UUID}" \
  > /dev/null
log "Reviewer account enabled (banned_until = NULL)."

# ── Step 3: Delete connected_pages for Malbek tenant ─────────────────────────

log "Fetching Malbek tenant ID from DB..."
MALBEK_TENANT_ID=$(psql "$DATABASE_URL" -tAc \
  "SELECT id FROM tenants WHERE slug = '${MALBEK_TENANT_SLUG}' LIMIT 1;")

if [[ -z "$MALBEK_TENANT_ID" ]]; then
  echo "ERROR: Could not find tenant with slug '${MALBEK_TENANT_SLUG}'" >&2
  exit 1
fi

DELETED=$(psql "$DATABASE_URL" -tAc \
  "DELETE FROM connected_pages WHERE tenant_id = '${MALBEK_TENANT_ID}' RETURNING id;" \
  | wc -l | tr -d ' ')
log "Deleted ${DELETED} connected_pages row(s) for tenant ${MALBEK_TENANT_SLUG}."

# ── Step 4: HTTP health checks ────────────────────────────────────────────────

log "Running health checks..."
ALL_OK=true
for url in "${HEALTH_URLS[@]}"; do
  STATUS=$(curl -o /dev/null -s -w "%{http_code}" --max-time 10 "$url")
  if [[ "$STATUS" == "200" ]]; then
    log "  OK  $url → $STATUS"
  else
    log "  FAIL $url → $STATUS"
    ALL_OK=false
  fi
done

if ! $ALL_OK; then
  echo "ERROR: One or more health checks failed. Do not proceed with recording." >&2
  exit 1
fi

# ── Step 5: Audit log ─────────────────────────────────────────────────────────

TIMESTAMP=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
AUDIT_ENTRY="| ${TIMESTAMP} | prep-screencast | reviewer enabled, connected_pages cleared | $(whoami) |"

if [[ -f "$AUDIT_LOG" ]]; then
  echo "$AUDIT_ENTRY" >> "$AUDIT_LOG"
  log "Audit entry appended to ${AUDIT_LOG}."
else
  log "Warning: ${AUDIT_LOG} not found — skipping audit log append."
fi

# ── Done ─────────────────────────────────────────────────────────────────────

echo ""
echo "════════════════════════════════════════════════"
echo "  prep-screencast COMPLETE"
echo ""
echo "  Reviewer email:    ${REVIEWER_EMAIL}"
echo "  Password:          (check clipboard — do not print here)"
echo "  connected_pages:   cleared for tenant '${MALBEK_TENANT_SLUG}'"
echo ""
echo "  Ready to record. Open Chrome incognito → ${REVIEW_BASE_URL}/login"
echo "════════════════════════════════════════════════"
