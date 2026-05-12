#!/usr/bin/env bash
# test-prep.sh — Idempotent smoke test for prep/post screencast scripts.
#
# Verifies that --dry-run executes without errors and without fetching secrets.
# Safe to run in any environment (no AWS credentials required).
#
# Usage:
#   bash scripts/test-prep.sh

set -euo pipefail

PASS=0
FAIL=0

check() {
  local label="$1"; shift
  if "$@" >/dev/null 2>&1; then
    echo "  PASS: $label"
    ((PASS++)) || true
  else
    echo "  FAIL: $label (exit $?)"
    ((FAIL++)) || true
  fi
}

echo ""
echo "=== scripts/test-prep.sh ==="
echo ""

# Both scripts must be executable
check "prep-screencast.sh is executable" test -x scripts/prep-screencast.sh
check "post-screencast.sh is executable" test -x scripts/post-screencast.sh

# --dry-run must exit 0 without AWS credentials
check "prep-screencast --dry-run exits 0" bash scripts/prep-screencast.sh --dry-run
check "post-screencast --dry-run exits 0" bash scripts/post-screencast.sh --dry-run
check "post-screencast --dry-run --rotate-password exits 0" \
  bash scripts/post-screencast.sh --dry-run --rotate-password
check "post-screencast --dry-run --cleanup-recording-data exits 0" \
  bash scripts/post-screencast.sh --dry-run --cleanup-recording-data

# Unknown argument must exit non-zero
check "prep-screencast rejects unknown args" bash -c '! bash scripts/prep-screencast.sh --unknown 2>/dev/null'
check "post-screencast rejects unknown args" bash -c '! bash scripts/post-screencast.sh --unknown 2>/dev/null'

echo ""
echo "Results: ${PASS} passed, ${FAIL} failed"
if [[ $FAIL -gt 0 ]]; then
  echo "FAILED"
  exit 1
fi
echo "OK"
