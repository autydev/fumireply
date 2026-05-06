#!/usr/bin/env bash
# prep-screencast.sh — 撮影前 prep: reviewer 有効化 + connected_pages 削除 + ヘルスチェック
# Usage: bash scripts/prep-screencast.sh [--dry-run]
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
AUDIT_LOG="$REPO_ROOT/docs/operations/audit-runbook.md"
REVIEWER_EMAIL="reviewer@malbek.co.jp"
TENANT_SLUG="malbek"
PROD_BASE="https://review.fumireply.ecsuite.work"

DRY_RUN=false
for arg in "$@"; do
  [[ "$arg" == "--dry-run" ]] && DRY_RUN=true
done

log() { echo "[prep-screencast] $*"; }
dryrun_note() { $DRY_RUN && log "[dry-run] $*" || true; }
confirm() {
  local msg="$1"
  $DRY_RUN && { log "[dry-run] skip confirm: $msg"; return 0; }
  read -r -p "$msg (y/n) " ans
  [[ "$ans" == "y" ]] || { log "中止しました。"; exit 1; }
}

log "=== prep-screencast 開始 $(date -u +"%Y-%m-%dT%H:%M:%SZ") ==="
$DRY_RUN && log "*** DRY-RUN MODE: 本番への副作用はありません ***"

# ── 事前チェック ──────────────────────────────────────────────────────────────
log "依存ツールの確認..."
for cmd in aws curl jq; do
  command -v "$cmd" &>/dev/null || { log "ERROR: '$cmd' が見つかりません。インストールしてください。"; exit 1; }
done

[[ -n "${AWS_PROFILE:-}" ]] || { log "ERROR: AWS_PROFILE 環境変数が未設定です。"; exit 1; }
log "AWS_PROFILE=$AWS_PROFILE"

# ── SSM パラメータ取得 ────────────────────────────────────────────────────────
log "SSM からパラメータを取得中..."
SSM_PREFIX="/fumireply/review/supabase"

get_ssm() {
  local name="$1"
  aws ssm get-parameter --name "$name" --with-decryption \
    --query 'Parameter.Value' --output text 2>/dev/null \
    || { log "ERROR: SSM パラメータ '$name' の取得に失敗しました。"; exit 1; }
}

SUPABASE_URL="$(get_ssm "${SSM_PREFIX}/url")"
SERVICE_ROLE_KEY="$(get_ssm "${SSM_PREFIX}/secret-key")"
REVIEWER_PASSWORD="$(get_ssm "${SSM_PREFIX}/reviewer-password")"
DATABASE_URL="$(get_ssm "${SSM_PREFIX}/db-url")"

log "SSM 取得完了。"

# ── (c) パスワードをクリップボードにコピー ──────────────────────────────────
log "(c) reviewer パスワードをクリップボードへ..."
log "    password: ${REVIEWER_PASSWORD:0:4}****${REVIEWER_PASSWORD: -2} (先頭4文字+末尾2文字のみ表示)"
if ! $DRY_RUN; then
  if command -v pbcopy &>/dev/null; then
    printf '%s' "$REVIEWER_PASSWORD" | pbcopy
    log "    → クリップボードにコピーしました (pbcopy)。"
  elif command -v xclip &>/dev/null; then
    printf '%s' "$REVIEWER_PASSWORD" | xclip -selection clipboard
    log "    → クリップボードにコピーしました (xclip)。"
  else
    log "    ⚠ pbcopy / xclip が見つかりません。手動でコピーしてください。"
  fi
fi

# ── (a) reviewer banned_until = NULL ─────────────────────────────────────────
log "(a) Supabase Admin API で reviewer の ban を解除中..."

find_reviewer_id() {
  local page=1
  while true; do
    local resp
    resp="$(curl -sf \
      -H "Authorization: Bearer ${SERVICE_ROLE_KEY}" \
      -H "apikey: ${SERVICE_ROLE_KEY}" \
      "${SUPABASE_URL}/auth/v1/admin/users?page=${page}&per_page=100")" || {
        log "ERROR: Supabase Admin API (/auth/v1/admin/users) の呼び出しに失敗しました。"
        exit 1
      }
    local found
    found="$(printf '%s' "$resp" | jq -r --arg email "$REVIEWER_EMAIL" \
      '.users[] | select(.email == $email) | .id' 2>/dev/null || true)"
    [[ -n "$found" ]] && { echo "$found"; return; }
    local total
    total="$(printf '%s' "$resp" | jq '.total // 0' 2>/dev/null || echo 0)"
    (( page * 100 >= total )) && break
    (( page++ ))
  done
  echo ""
}

if $DRY_RUN; then
  dryrun_note "PATCH ${SUPABASE_URL}/auth/v1/admin/users/{user_id} ban_duration=none をスキップ"
else
  REVIEWER_ID="$(find_reviewer_id)"
  [[ -n "$REVIEWER_ID" ]] || { log "ERROR: reviewer ($REVIEWER_EMAIL) がユーザーリストに見つかりません。"; exit 1; }
  log "    reviewer user_id=$REVIEWER_ID"
  confirm "reviewer ($REVIEWER_EMAIL) の ban を解除しますか？"
  curl -sf -X PUT \
    -H "Authorization: Bearer ${SERVICE_ROLE_KEY}" \
    -H "apikey: ${SERVICE_ROLE_KEY}" \
    -H "Content-Type: application/json" \
    -d '{"ban_duration":"none"}' \
    "${SUPABASE_URL}/auth/v1/admin/users/${REVIEWER_ID}" \
    | jq '.banned_until' \
    || { log "ERROR: ban 解除の API 呼び出しに失敗しました。"; exit 1; }
  log "    → banned_until = null になりました。"
fi

# ── (b) connected_pages 削除 (Malbek tenant) ─────────────────────────────────
log "(b) connected_pages から Malbek テナントの行を削除中..."
DELETE_SQL="
DELETE FROM connected_pages
WHERE tenant_id = (SELECT id FROM tenants WHERE slug = '${TENANT_SLUG}' LIMIT 1);
"
if $DRY_RUN; then
  dryrun_note "psql: $DELETE_SQL"
else
  confirm "connected_pages から slug='${TENANT_SLUG}' のテナント行を削除しますか？（撮影後に再接続します）"
  DELETED_COUNT="$(psql "$DATABASE_URL" -At -c \
    "DELETE FROM connected_pages WHERE tenant_id = (SELECT id FROM tenants WHERE slug = '${TENANT_SLUG}' LIMIT 1); SELECT ROW_COUNT();" \
    2>/dev/null || echo "?")"
  log "    → 削除完了 (affected rows: ${DELETED_COUNT})。"
fi

# ── (d) ヘルスチェック ─────────────────────────────────────────────────────────
log "(d) 本番 URL のヘルスチェック..."
HEALTH_URLS=(
  "$PROD_BASE"
  "$PROD_BASE/privacy"
  "$PROD_BASE/terms"
  "$PROD_BASE/data-deletion"
  "$PROD_BASE/login"
)
HEALTH_FAILED=false
for url in "${HEALTH_URLS[@]}"; do
  if $DRY_RUN; then
    dryrun_note "curl $url → (dry-run スキップ)"
    continue
  fi
  status="$(curl -o /dev/null -s -w "%{http_code}" --max-time 15 "$url" || echo "ERR")"
  if [[ "$status" == "200" || "$status" == "301" || "$status" == "302" ]]; then
    log "    ✓ $url → $status"
  else
    log "    ✗ $url → $status (期待値: 200)"
    HEALTH_FAILED=true
  fi
done
$HEALTH_FAILED && { log "ERROR: 一部 URL が 200 を返していません。本番の状態を確認してください。"; exit 1; } || true

# ── (e) 監査ログ append ────────────────────────────────────────────────────────
log "(e) 監査ログを追記中..."
AUDIT_ENTRY="
## $(date -u +"%Y-%m-%d") prep-screencast 実行

- **実行者**: \`${USER:-unknown}\` on \`$(hostname)\`
- **AWS_PROFILE**: \`${AWS_PROFILE}\`
- **時刻 (UTC)**: \`$(date -u +"%Y-%m-%dT%H:%M:%SZ")\`
- **操作**:
  - reviewer ($REVIEWER_EMAIL) ban 解除 (banned_until = NULL)
  - connected_pages Malbek 行削除
  - 本番 URL ヘルスチェック PASS
- **dry-run**: \`${DRY_RUN}\`
"

mkdir -p "$(dirname "$AUDIT_LOG")"
if [[ ! -f "$AUDIT_LOG" ]]; then
  printf '# Operations Audit Runbook\n\n' > "$AUDIT_LOG"
fi
if ! $DRY_RUN; then
  printf '%s\n' "$AUDIT_ENTRY" >> "$AUDIT_LOG"
  log "    → $AUDIT_LOG に追記しました。"
else
  dryrun_note "監査ログへの追記をスキップ"
fi

log "=== prep-screencast 完了 ==="
log ""
log "次のステップ:"
log "  1. クリップボードのパスワードを使って ${PROD_BASE}/login でログイン確認"
log "  2. 撮影スクリプトに従って screencast を録画"
log "  3. 撮影完了後: bash scripts/post-screencast.sh"
