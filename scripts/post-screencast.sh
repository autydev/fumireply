#!/usr/bin/env bash
# post-screencast.sh — screencast 撮影/提出後の後処理 (US5 / T060)
#
#   - reviewer アカウントを再無効化 (banned_until を未来日に)
#   - --rotate-password : reviewer パスワードを再生成し SSM を更新
#   - --cleanup-recording-data : 撮影で生じた接続ページと会話/メッセージを削除
#   - 監査ログを docs/operations/audit-runbook.md に追記
#
# 必須: 環境変数 AWS_PROFILE
# 任意: REVIEWER_EMAIL (既定 reviewer@malbek.co.jp), TENANT_SLUG (既定 malbek)
# オプション: --dry-run, --yes, --rotate-password, --cleanup-recording-data
set -euo pipefail

DRY_RUN=0; ASSUME_YES=0; ROTATE_PW=0; CLEANUP_DATA=0
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=1 ;;
    --yes|-y) ASSUME_YES=1 ;;
    --rotate-password) ROTATE_PW=1 ;;
    --cleanup-recording-data) CLEANUP_DATA=1 ;;
    *) echo "unknown arg: $arg" >&2; exit 2 ;;
  esac
done

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
AUDIT_LOG="${REPO_ROOT}/docs/operations/audit-runbook.md"
REVIEWER_EMAIL="${REVIEWER_EMAIL:-reviewer@malbek.co.jp}"
TENANT_SLUG="${TENANT_SLUG:-malbek}"
BAN_DURATION="${BAN_DURATION:-876000h}"   # ~100 years ≈ permanently disabled

log()  { printf '[post] %s\n' "$*"; }
die()  { printf '[post][ERROR] %s\n' "$*" >&2; exit 1; }
plan() { printf '[post][DRY-RUN] would: %s\n' "$*"; }
require_cmd() { command -v "$1" >/dev/null 2>&1 || die "required command not found: $1"; }

confirm() {
  [ "$ASSUME_YES" -eq 1 ] && return 0
  [ "$DRY_RUN" -eq 1 ] && return 0
  read -r -p "[post] $1 Continue? (y/N) " ans
  [ "$ans" = "y" ] || [ "$ans" = "Y" ]
}

ssm_get() { aws ssm get-parameter --name "$1" --with-decryption --query 'Parameter.Value' --output text; }

audit_append() {
  local action="$1"; local ts; ts="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  [ -f "$AUDIT_LOG" ] || {
    mkdir -p "$(dirname "$AUDIT_LOG")"
    printf '# Audit Runbook — Fumireply Review Operations\n\n運用スクリプト (prep/post-screencast.sh) が監査行を追記する。手動操作も同形式で追記すること。\n\n| UTC timestamp | actor | action |\n|---|---|---|\n' > "$AUDIT_LOG"
  }
  if [ "$DRY_RUN" -eq 1 ]; then plan "append audit row: ${action}"
  else printf '| %s | %s | %s |\n' "$ts" "${USER:-unknown}@post-screencast" "$action" >> "$AUDIT_LOG"; fi
}

: "${AWS_PROFILE:?AWS_PROFILE env var is required}"
require_cmd aws; require_cmd curl; require_cmd psql; require_cmd jq

log "mode: $([ "$DRY_RUN" -eq 1 ] && echo DRY-RUN || echo LIVE)  rotate_pw=${ROTATE_PW}  cleanup=${CLEANUP_DATA}"

SUPABASE_URL="$(ssm_get /fumireply/review/supabase/url)"
SUPABASE_SECRET="$(ssm_get /fumireply/review/supabase/secret-key)"
DB_URL="$(ssm_get /fumireply/review/supabase/db-url)"

USER_ID="$(curl -fsS \
  "${SUPABASE_URL}/auth/v1/admin/users?email=$(printf '%s' "$REVIEWER_EMAIL" | jq -sRr @uri)" \
  -H "apikey: ${SUPABASE_SECRET}" -H "Authorization: Bearer ${SUPABASE_SECRET}" \
  | jq -r '.users[0].id // .[0].id // empty')"
[ -n "$USER_ID" ] || die "reviewer user not found for ${REVIEWER_EMAIL}"

# --- (1) re-disable reviewer ---
if confirm "Re-disable reviewer account (${REVIEWER_EMAIL}, ban_duration=${BAN_DURATION})?"; then
  if [ "$DRY_RUN" -eq 1 ]; then
    plan "PUT /auth/v1/admin/users/${USER_ID} ban_duration=${BAN_DURATION}"
  else
    curl -fsS -X PUT "${SUPABASE_URL}/auth/v1/admin/users/${USER_ID}" \
      -H "apikey: ${SUPABASE_SECRET}" -H "Authorization: Bearer ${SUPABASE_SECRET}" \
      -H "Content-Type: application/json" -d "{\"ban_duration\":\"${BAN_DURATION}\"}" >/dev/null
    log "reviewer disabled (ban_duration=${BAN_DURATION})"
  fi
  audit_append "reviewer DISABLED (${REVIEWER_EMAIL}, ${BAN_DURATION})"
fi

# --- (2) optional password rotation ---
if [ "$ROTATE_PW" -eq 1 ] && confirm "Rotate reviewer password + update SSM?"; then
  NEW_PW="$(openssl rand -base64 24)"
  if [ "$DRY_RUN" -eq 1 ]; then
    plan "set new reviewer password via admin API + ssm put-parameter --overwrite"
  else
    curl -fsS -X PUT "${SUPABASE_URL}/auth/v1/admin/users/${USER_ID}" \
      -H "apikey: ${SUPABASE_SECRET}" -H "Authorization: Bearer ${SUPABASE_SECRET}" \
      -H "Content-Type: application/json" \
      -d "$(jq -nc --arg p "$NEW_PW" '{password:$p}')" >/dev/null
    aws ssm put-parameter --name /fumireply/review/supabase/reviewer-password \
      --type SecureString --value "$NEW_PW" --overwrite >/dev/null
    log "reviewer password rotated + SSM updated"
  fi
  audit_append "reviewer PASSWORD ROTATED"
fi

# --- (3) optional recording-data cleanup (FK-safe order) ---
if [ "$CLEANUP_DATA" -eq 1 ] && confirm "DELETE recorded conversations/messages/drafts/pages for tenant '${TENANT_SLUG}'?"; then
  read -r -d '' SQL <<SQL || true
BEGIN;
WITH t AS (SELECT id FROM tenants WHERE slug = '${TENANT_SLUG}')
, del_msg AS (DELETE FROM messages       WHERE tenant_id IN (SELECT id FROM t))
, del_drf AS (DELETE FROM ai_drafts      WHERE tenant_id IN (SELECT id FROM t))
, del_cnv AS (DELETE FROM conversations  WHERE tenant_id IN (SELECT id FROM t))
DELETE FROM connected_pages WHERE tenant_id IN (SELECT id FROM t);
COMMIT;
SQL
  if [ "$DRY_RUN" -eq 1 ]; then
    plan "psql transaction: cleanup messages/ai_drafts/conversations/connected_pages for tenant '${TENANT_SLUG}'"
  else
    psql "$DB_URL" -v ON_ERROR_STOP=1 <<<"$SQL"
    log "recording data cleaned up for tenant '${TENANT_SLUG}'"
  fi
  audit_append "recording data CLEANED UP (tenant=${TENANT_SLUG})"
fi

audit_append "post-screencast run complete (dry_run=${DRY_RUN})"
log "done."
