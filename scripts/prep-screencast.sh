#!/usr/bin/env bash
# prep-screencast.sh — screencast 撮影前の本番状態を整える (US5 / T059)
#
#   - reviewer アカウントを有効化 (banned_until 解除)
#   - connected_pages の Malbek 行を削除 (撮影中に Connect フローで再接続するため)
#   - reviewer パスワードを SSM から取得しクリップボードへ (標準出力はマスク)
#   - 公開ページ / ログイン / onboarding の 200 ヘルスチェック
#   - 監査ログを docs/operations/audit-runbook.md に追記
#
# 必須: 環境変数 AWS_PROFILE
# 任意: REVIEWER_EMAIL (既定 reviewer@malbek.co.jp), TENANT_SLUG (既定 malbek)
# オプション: --dry-run (本番無影響で計画のみ表示), --yes (確認プロンプトskip)
set -euo pipefail

DRY_RUN=0
ASSUME_YES=0
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=1 ;;
    --yes|-y) ASSUME_YES=1 ;;
    *) echo "unknown arg: $arg" >&2; exit 2 ;;
  esac
done

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
AUDIT_LOG="${REPO_ROOT}/docs/operations/audit-runbook.md"
REVIEWER_EMAIL="${REVIEWER_EMAIL:-reviewer@malbek.co.jp}"
TENANT_SLUG="${TENANT_SLUG:-malbek}"
BASE_URL="https://review.fumireply.ecsuite.work"

log()  { printf '[prep] %s\n' "$*"; }
die()  { printf '[prep][ERROR] %s\n' "$*" >&2; exit 1; }
plan() { printf '[prep][DRY-RUN] would: %s\n' "$*"; }

require_cmd() { command -v "$1" >/dev/null 2>&1 || die "required command not found: $1"; }

confirm() {
  [ "$ASSUME_YES" -eq 1 ] && return 0
  [ "$DRY_RUN" -eq 1 ] && return 0
  read -r -p "[prep] $1 Continue? (y/N) " ans
  [ "$ans" = "y" ] || [ "$ans" = "Y" ]
}

ssm_get() {
  aws ssm get-parameter --name "$1" --with-decryption \
    --query 'Parameter.Value' --output text
}

audit_append() {
  local action="$1"
  local ts; ts="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  [ -f "$AUDIT_LOG" ] || {
    mkdir -p "$(dirname "$AUDIT_LOG")"
    printf '# Audit Runbook — Fumireply Review Operations\n\n運用スクリプト (prep/post-screencast.sh) が監査行を追記する。手動操作も同形式で追記すること。\n\n| UTC timestamp | actor | action |\n|---|---|---|\n' > "$AUDIT_LOG"
  }
  if [ "$DRY_RUN" -eq 1 ]; then
    plan "append audit row: ${action}"
  else
    printf '| %s | %s | %s |\n' "$ts" "${USER:-unknown}@prep-screencast" "$action" >> "$AUDIT_LOG"
  fi
}

# --- preflight ---
: "${AWS_PROFILE:?AWS_PROFILE env var is required}"
require_cmd aws
require_cmd curl
require_cmd psql
require_cmd jq
command -v pbcopy >/dev/null 2>&1 || log "pbcopy not found (non-macOS?) — password copy will be skipped"

log "mode: $([ "$DRY_RUN" -eq 1 ] && echo DRY-RUN || echo LIVE)  profile=${AWS_PROFILE}  reviewer=${REVIEWER_EMAIL}  tenant=${TENANT_SLUG}"

# --- read SSM (read-only, safe in dry-run) ---
log "reading SSM parameters..."
SUPABASE_URL="$(ssm_get /fumireply/review/supabase/url)"
SUPABASE_SECRET="$(ssm_get /fumireply/review/supabase/secret-key)"
REVIEWER_PW="$(ssm_get /fumireply/review/supabase/reviewer-password)"
DB_URL="$(ssm_get /fumireply/review/supabase/db-url)"
# fetched to validate presence (master key is used by the app, not mutated here)
ssm_get /fumireply/master-encryption-key >/dev/null
log "SSM OK (supabase url + secret + reviewer pw + db url + master key present)"

# --- (a) reviewer banned_until = NULL via GoTrue admin API ---
if confirm "Enable reviewer account (${REVIEWER_EMAIL})?"; then
  USER_ID="$(curl -fsS \
    "${SUPABASE_URL}/auth/v1/admin/users?email=$(printf '%s' "$REVIEWER_EMAIL" | jq -sRr @uri)" \
    -H "apikey: ${SUPABASE_SECRET}" -H "Authorization: Bearer ${SUPABASE_SECRET}" \
    | jq -r '.users[0].id // .[0].id // empty')"
  [ -n "$USER_ID" ] || die "reviewer user not found for ${REVIEWER_EMAIL}"
  if [ "$DRY_RUN" -eq 1 ]; then
    plan "PUT /auth/v1/admin/users/${USER_ID} ban_duration=none"
  else
    curl -fsS -X PUT "${SUPABASE_URL}/auth/v1/admin/users/${USER_ID}" \
      -H "apikey: ${SUPABASE_SECRET}" -H "Authorization: Bearer ${SUPABASE_SECRET}" \
      -H "Content-Type: application/json" \
      -d '{"ban_duration":"none"}' >/dev/null
    log "reviewer enabled (ban_duration=none)"
  fi
  audit_append "reviewer ENABLED (${REVIEWER_EMAIL})"
fi

# --- (b) DELETE connected_pages for the Malbek tenant ---
if confirm "DELETE connected_pages for tenant slug '${TENANT_SLUG}'?"; then
  SQL="DELETE FROM connected_pages WHERE tenant_id = (SELECT id FROM tenants WHERE slug = '${TENANT_SLUG}');"
  if [ "$DRY_RUN" -eq 1 ]; then
    plan "psql: ${SQL}"
  else
    psql "$DB_URL" -v ON_ERROR_STOP=1 -c "$SQL"
    log "connected_pages cleared for tenant '${TENANT_SLUG}'"
  fi
  audit_append "connected_pages DELETED (tenant=${TENANT_SLUG})"
fi

# --- (c) reviewer password to clipboard (masked stdout) ---
MASKED="${REVIEWER_PW:0:2}****${REVIEWER_PW: -2}"
if command -v pbcopy >/dev/null 2>&1; then
  if [ "$DRY_RUN" -eq 1 ]; then
    plan "pbcopy reviewer password (masked: ${MASKED})"
  else
    printf '%s' "$REVIEWER_PW" | pbcopy
    log "reviewer password copied to clipboard (masked: ${MASKED})"
  fi
else
  log "reviewer password (masked): ${MASKED} — copy manually from SSM"
fi
log "reviewer login: ${BASE_URL}/login  email: ${REVIEWER_EMAIL}"

# --- (d) health checks (read-only) ---
log "health checks:"
HEALTH_FAIL=0
for path in "" /login /onboarding/connect-page /privacy /terms /data-deletion; do
  code="$(curl -o /dev/null -s -w '%{http_code}' "${BASE_URL}${path}" || echo 000)"
  printf '  %s%-26s -> %s\n' "$BASE_URL" "${path:-/}" "$code"
  [ "$code" = "200" ] || HEALTH_FAIL=1
done
[ "$HEALTH_FAIL" -eq 0 ] || log "WARNING: some endpoints did not return 200 — investigate before recording"

audit_append "prep-screencast run complete (dry_run=${DRY_RUN})"
log "done."
