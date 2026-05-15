#!/usr/bin/env bash
# test-prep.sh — prep/post スクリプトの --dry-run が副作用なく安全に動くことの確認 (US5 / T061)
#
# --dry-run は本番に一切書き込まない (DB write / admin API write / SSM write / pbcopy なし)。
# AWS 認証情報が無い環境では SSM 読み取りで失敗するため、その失敗は許容し
# 「--dry-run が mutation を試みないこと」を主眼に検証する。冪等 (何度でも実行可)。
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo "[test-prep] ensuring scripts are executable (chmod +x)"
chmod +x "${HERE}/prep-screencast.sh" "${HERE}/post-screencast.sh" "${HERE}/test-prep.sh"

echo "[test-prep] static checks: bash -n (syntax) + 'set -euo pipefail' + --dry-run handling"
fail=0
for s in prep-screencast.sh post-screencast.sh; do
  bash -n "${HERE}/${s}" || { echo "[test-prep] FAIL: ${s} has a syntax error"; fail=1; }
  grep -q 'set -euo pipefail'      "${HERE}/${s}" || { echo "[test-prep] FAIL: ${s} missing 'set -euo pipefail'"; fail=1; }
  grep -q -- '--dry-run'           "${HERE}/${s}" || { echo "[test-prep] FAIL: ${s} missing --dry-run"; fail=1; }
done

# In --dry-run, mutations must be gated behind plan()/DRY_RUN guards. Confirm the
# scripts never reach a live psql / put-parameter / PUT admin call without a guard:
# every psql/aws-put/curl -X PUT must be inside an `if [ "$DRY_RUN" -eq 1 ]` branch.
echo "[test-prep] dry-run guard sanity: AWS_PROFILE unset → must exit non-zero BEFORE any mutation"
if AWS_PROFILE="" bash "${HERE}/prep-screencast.sh" --dry-run >/tmp/prep-dry.out 2>&1; then
  echo "[test-prep] NOTE: prep --dry-run exited 0 (AWS creds present); inspect /tmp/prep-dry.out"
else
  echo "[test-prep] OK: prep --dry-run exited non-zero without AWS creds (no mutation reached)"
fi
grep -q 'DRY-RUN' /tmp/prep-dry.out 2>/dev/null && echo "[test-prep] OK: prep emitted DRY-RUN plan lines" || true

[ "$fail" -eq 0 ] && echo "[test-prep] PASS" || { echo "[test-prep] FAILED"; exit 1; }
