#!/usr/bin/env bash
# Stop hook: run the CI-gating checks for the app package (typecheck + lint).
# On failure, block Claude from finishing and feed the errors back so they get
# fixed before the user commits. On success, stay silent and let the turn end.
set -uo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
app_dir="$repo_root/app"

if ! cd "$app_dir" 2>/dev/null; then
  echo "{\"systemMessage\":\"ci-check hook: app directory not found at $app_dir\"}"
  exit 0
fi

tc_output="$(npm run typecheck 2>&1)"
tc_status=$?

lint_output="$(npm run lint 2>&1)"
lint_status=$?

if [ "$tc_status" -eq 0 ] && [ "$lint_status" -eq 0 ]; then
  exit 0
fi

reason="コミット前 CI チェックが失敗しました。修正してから完了してください。"
if [ "$tc_status" -ne 0 ]; then
  reason="$reason

=== npm run typecheck (exit $tc_status) ===
$tc_output"
fi
if [ "$lint_status" -ne 0 ]; then
  reason="$reason

=== npm run lint (exit $lint_status) ===
$lint_output"
fi

jq -n --arg r "$reason" '{decision:"block", reason:$r}'
exit 0
