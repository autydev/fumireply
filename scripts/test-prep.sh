#!/usr/bin/env bash
# test-prep.sh — 撮影スクリプトの前提条件チェック（副作用なし、どこでも実行可）
# Usage: bash scripts/test-prep.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

pass() { echo "  [OK]  $*"; }
fail() { echo "  [FAIL] $*"; FAILURES=$((FAILURES + 1)); }

FAILURES=0
echo "=== test-prep: 撮影スクリプト前提チェック ==="

# ── 1. chmod +x (冪等) ───────────────────────────────────────────────────────
echo ""
echo "1. 実行権限"
for script in prep-screencast.sh post-screencast.sh; do
  path="$SCRIPT_DIR/$script"
  if [[ ! -f "$path" ]]; then
    fail "$script が見つかりません"
    continue
  fi
  chmod +x "$path"
  if [[ -x "$path" ]]; then
    pass "$script: 実行可能"
  else
    fail "$script: chmod +x 後も実行不可"
  fi
done

# ── 2. --dry-run フラグのサポート確認 ────────────────────────────────────────
echo ""
echo "2. --dry-run フラグ"
for script in prep-screencast.sh post-screencast.sh; do
  path="$SCRIPT_DIR/$script"
  [[ -f "$path" ]] || continue
  if grep -q -- '--dry-run' "$path"; then
    pass "$script: --dry-run フラグあり"
  else
    fail "$script: --dry-run フラグが見つかりません"
  fi
done

# ── 3. set -euo pipefail ─────────────────────────────────────────────────────
echo ""
echo "3. set -euo pipefail"
for script in prep-screencast.sh post-screencast.sh; do
  path="$SCRIPT_DIR/$script"
  [[ -f "$path" ]] || continue
  if grep -q 'set -euo pipefail' "$path"; then
    pass "$script: set -euo pipefail あり"
  else
    fail "$script: set -euo pipefail が見つかりません"
  fi
done

# ── 4. AWS_PROFILE 要求の明示 ────────────────────────────────────────────────
echo ""
echo "4. AWS_PROFILE 要求"
for script in prep-screencast.sh post-screencast.sh; do
  path="$SCRIPT_DIR/$script"
  [[ -f "$path" ]] || continue
  if grep -q 'AWS_PROFILE' "$path"; then
    pass "$script: AWS_PROFILE チェックあり"
  else
    fail "$script: AWS_PROFILE チェックが見つかりません"
  fi
done

# ── 5. AUDIT_LOG パスの整合性 ────────────────────────────────────────────────
echo ""
echo "5. AUDIT_LOG パス整合性"
for script in prep-screencast.sh post-screencast.sh; do
  path="$SCRIPT_DIR/$script"
  [[ -f "$path" ]] || continue
  if grep -q 'docs/operations/audit-runbook.md' "$path"; then
    pass "$script: AUDIT_LOG = docs/operations/audit-runbook.md"
  else
    fail "$script: AUDIT_LOG パスが docs/operations/audit-runbook.md でない"
  fi
done

# ── 結果 ─────────────────────────────────────────────────────────────────────
echo ""
if [[ $FAILURES -eq 0 ]]; then
  echo "=== PASS: 全チェック通過 ==="
  echo ""
  echo "注意: --dry-run の完全実行には AWS_PROFILE が必要です。"
  echo "  AWS_PROFILE=review bash scripts/prep-screencast.sh --dry-run"
  echo "  AWS_PROFILE=review bash scripts/post-screencast.sh --dry-run"
  exit 0
else
  echo "=== FAIL: ${FAILURES} 件の問題があります ==="
  exit 1
fi
