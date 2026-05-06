#!/usr/bin/env bash
# post-screencast.sh — 撮影後 cleanup: reviewer 再無効化 + オプション cleanup
# Usage: bash scripts/post-screencast.sh [--dry-run] [--rotate-password] [--cleanup-recording-data]
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
AUDIT_LOG="$REPO_ROOT/docs/operations/audit-runbook.md"
REVIEWER_EMAIL="reviewer@malbek.co.jp"
TENANT_SLUG="malbek"
BAN_UNTIL_DEFAULT="2099-12-31T00:00:00Z"

DRY_RUN=false
ROTATE_PASSWORD=false
CLEANUP_DATA=false
for arg in "$@"; do
  case "$arg" in
    --dry-run)               DRY_RUN=true ;;
    --rotate-password)       ROTATE_PASSWORD=true ;;
    --cleanup-recording-data) CLEANUP_DATA=true ;;
  esac
done

log() { echo "[post-screencast] $*"; }
dryrun_note() { $DRY_RUN && log "[dry-run] $*" || true; }
confirm() {
  local msg="$1"
  $DRY_RUN && { log "[dry-run] skip confirm: $msg"; return 0; }
  read -r -p "$msg (y/n) " ans
  [[ "$ans" == "y" ]] || { log "中止しました。"; exit 1; }
}

log "=== post-screencast 開始 $(date -u +"%Y-%m-%dT%H:%M:%SZ") ==="
$DRY_RUN && log "*** DRY-RUN MODE: 本番への副作用はありません ***"
$ROTATE_PASSWORD && log "  --rotate-password: パスワードをローテーションします"
$CLEANUP_DATA && log "  --cleanup-recording-data: 撮影データを削除します"

# ── 事前チェック ──────────────────────────────────────────────────────────────
log "依存ツールの確認..."
for cmd in aws curl jq openssl psql; do
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
DATABASE_URL="$(get_ssm "${SSM_PREFIX}/db-url")"
log "SSM 取得完了。"

# ── curl helper: service role key を ps に露出させない ───────────────────────
CURL_CFG=$(mktemp)
trap 'rm -f "$CURL_CFG"' EXIT
printf 'header = "Authorization: Bearer %s"\nheader = "apikey: %s"\n' \
  "$SERVICE_ROLE_KEY" "$SERVICE_ROLE_KEY" > "$CURL_CFG"

supabase_curl() {
  curl -sf --config "$CURL_CFG" --max-time 30 "$@"
}

# ── psql helper: DATABASE_URL を引数に露出させない ───────────────────────────
parse_db_url() {
  local url="${DATABASE_URL}"
  url="${url#postgres://}"
  url="${url#postgresql://}"
  local userinfo="${url%%@*}"
  local hostinfo="${url#*@}"
  export PGUSER="${userinfo%%:*}"
  export PGPASSWORD="${userinfo#*:}"
  local hostport="${hostinfo%%/*}"
  export PGDATABASE="${hostinfo#*/}"
  export PGDATABASE="${PGDATABASE%%\?*}"
  if [[ "$hostport" =~ :[0-9]+$ ]]; then
    export PGHOST="${hostport%:*}"
    export PGPORT="${hostport##*:}"
  else
    export PGHOST="$hostport"
    export PGPORT="5432"
  fi
}

parse_db_url

# ── reviewer user_id 取得 ────────────────────────────────────────────────────
find_reviewer_id() {
  local page=1
  while true; do
    local resp
    resp="$(supabase_curl \
      "${SUPABASE_URL}/auth/v1/admin/users?page=${page}&per_page=100")" || {
        log "ERROR: Supabase Admin API の呼び出しに失敗しました。"
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
  REVIEWER_ID="dry-run-placeholder"
else
  REVIEWER_ID="$(find_reviewer_id)"
  [[ -n "$REVIEWER_ID" ]] || { log "ERROR: reviewer ($REVIEWER_EMAIL) が見つかりません。"; exit 1; }
  log "reviewer user_id=$REVIEWER_ID"
fi

# ── (1) reviewer を再 ban ─────────────────────────────────────────────────────
log "(1) reviewer を再無効化 (banned_until=$BAN_UNTIL_DEFAULT)..."
if $DRY_RUN; then
  dryrun_note "PUT ${SUPABASE_URL}/auth/v1/admin/users/{user_id} ban_duration=876000h をスキップ"
else
  confirm "reviewer ($REVIEWER_EMAIL) を再度 ban しますか？"
  # Supabase ban_duration は Go duration 形式。2099-12-31 相当は ~876000h（≈100年）
  BAN_HOURS="$(python3 -c "
from datetime import datetime, timezone
target = datetime(2099, 12, 31, 0, 0, 0, tzinfo=timezone.utc)
now = datetime.now(timezone.utc)
diff_hours = int((target - now).total_seconds() / 3600)
print(f'{diff_hours}h')
" 2>/dev/null || echo "876000h")"
  supabase_curl -X PUT \
    -H "Content-Type: application/json" \
    -d "{\"ban_duration\":\"${BAN_HOURS}\"}" \
    "${SUPABASE_URL}/auth/v1/admin/users/${REVIEWER_ID}" \
    | jq '.banned_until' \
    || { log "ERROR: ban 設定の API 呼び出しに失敗しました。"; exit 1; }
  log "    → banned_until = $BAN_UNTIL_DEFAULT に設定しました。"
fi

# ── (2) パスワードローテーション (--rotate-password) ─────────────────────────
NEW_PASSWORD=""
if $ROTATE_PASSWORD; then
  log "(2) reviewer パスワードをローテーション中..."
  NEW_PASSWORD="$(openssl rand -base64 24)"
  log "    新パスワード: ${NEW_PASSWORD:0:4}****${NEW_PASSWORD: -2} (先頭4文字+末尾2文字のみ表示)"
  if $DRY_RUN; then
    dryrun_note "Supabase Admin API: パスワード更新スキップ"
    dryrun_note "SSM put-parameter: /fumireply/review/supabase/reviewer-password スキップ"
  else
    confirm "パスワードをローテーションしますか？（Meta 審査中は変更しないこと）"
    supabase_curl -X PUT \
      -H "Content-Type: application/json" \
      -d "{\"password\":\"${NEW_PASSWORD}\"}" \
      "${SUPABASE_URL}/auth/v1/admin/users/${REVIEWER_ID}" \
      | jq '.updated_at' \
      || { log "ERROR: パスワード更新 API の呼び出しに失敗しました。"; exit 1; }
    aws ssm put-parameter \
      --name "${SSM_PREFIX}/reviewer-password" \
      --value "$NEW_PASSWORD" \
      --type SecureString \
      --overwrite
    log "    → Supabase + SSM のパスワードを更新しました。"
    log "    ⚠ Meta 申請フォームへの新パスワード反映が必要な場合は reviewer-credentials.md を更新してください。"
  fi
fi

# ── (3) 撮影データ削除 (--cleanup-recording-data) ────────────────────────────
if $CLEANUP_DATA; then
  log "(3) 撮影で生じた connected_pages 行と関連データを削除中..."
  CLEANUP_SQL="
DO \$\$
DECLARE
  v_tenant_id uuid;
  v_page_id uuid;
BEGIN
  SELECT id INTO v_tenant_id FROM tenants WHERE slug = '${TENANT_SLUG}' LIMIT 1;
  IF v_tenant_id IS NULL THEN RAISE NOTICE 'tenant not found'; RETURN; END IF;

  SELECT id INTO v_page_id FROM connected_pages WHERE tenant_id = v_tenant_id LIMIT 1;
  IF v_page_id IS NULL THEN RAISE NOTICE 'no connected_page to clean up'; RETURN; END IF;

  DELETE FROM messages
    WHERE conversation_id IN (
      SELECT id FROM conversations WHERE tenant_id = v_tenant_id
    );
  DELETE FROM conversations WHERE tenant_id = v_tenant_id;
  DELETE FROM connected_pages WHERE tenant_id = v_tenant_id;
  RAISE NOTICE 'cleanup complete for tenant %', v_tenant_id;
END;
\$\$;
"
  if $DRY_RUN; then
    dryrun_note "psql cleanup SQL スキップ"
  else
    confirm "撮影データ (connected_pages + conversations + messages for tenant '${TENANT_SLUG}') を削除しますか？"
    psql -v ON_ERROR_STOP=1 -c "$CLEANUP_SQL"
    log "    → 撮影データを削除しました。"
  fi
fi

# ── (4) 監査ログ append ────────────────────────────────────────────────────────
log "(4) 監査ログを追記中..."
AUDIT_ENTRY="
## $(date -u +"%Y-%m-%d") post-screencast 実行

- **実行者**: \`${USER:-unknown}\` on \`$(hostname)\`
- **AWS_PROFILE**: \`${AWS_PROFILE}\`
- **時刻 (UTC)**: \`$(date -u +"%Y-%m-%dT%H:%M:%SZ")\`
- **操作**:
  - reviewer ($REVIEWER_EMAIL) 再 ban (banned_until ≈ $BAN_UNTIL_DEFAULT)
  - --rotate-password: \`${ROTATE_PASSWORD}\`$(${ROTATE_PASSWORD} && [[ -n "${NEW_PASSWORD}" ]] && echo " → SSM 更新済み" || true)
  - --cleanup-recording-data: \`${CLEANUP_DATA}\`
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

log "=== post-screencast 完了 ==="
log ""
log "実施済み確認事項:"
log "  ✓ reviewer ($REVIEWER_EMAIL) を再 ban (banned_until ≈ $BAN_UNTIL_DEFAULT)"
$ROTATE_PASSWORD && log "  ✓ パスワードローテーション完了" || true
$CLEANUP_DATA && log "  ✓ 撮影データ削除完了" || true
log ""
log "次のステップ:"
log "  - Supabase ダッシュボードで banned_until が設定されているか目視確認"
$ROTATE_PASSWORD && log "  - reviewer-credentials.md を新パスワードで更新（Meta 審査中の場合は提出後まで待つこと）" || true
