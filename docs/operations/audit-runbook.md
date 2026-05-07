# Operations Audit Runbook — Fumireply

**App**: Fumireply  
**Operator**: Malbek Inc. (株式会社 Malbek)

This file serves two purposes:
1. **Runbook** — step-by-step procedures for recurring operational tasks
2. **Audit log** — append-only record of key operational events (prep runs, submissions, result notifications)

Once `scripts/prep-screencast.sh` and `scripts/post-screencast.sh` are available (added in U7.1), they append audit rows automatically.
Until then, append rows manually using the format defined in the Audit Log section below.

---

## Recurring Procedures

### Reviewer Account Enable / Disable

> `scripts/prep-screencast.sh` and `scripts/post-screencast.sh` are added in U7.1 (PR #21). Until merged, use the manual steps below.

Enable before review period:
```bash
# With script (U7.1+):
bash scripts/prep-screencast.sh  # enables reviewer, clears connected_pages, health checks

# Manual alternative:
# 1. Supabase Dashboard → Authentication → Users → reviewer@malbek.co.jp → set banned_until = NULL
# 2. psql -c "DELETE FROM connected_pages WHERE tenant_id = '<malbek-uuid>';"
# 3. curl -o /dev/null -s -w "%{http_code}" https://review.fumireply.ecsuite.work/  # → 200
```

Disable after review result:
```bash
# With script (U7.1+):
bash scripts/post-screencast.sh  # re-bans reviewer, optionally rotates password

# Manual alternative:
# Supabase Dashboard → Authentication → Users → reviewer@malbek.co.jp → set banned_until = 2099-12-31
```

### Reviewer Password Rotation

```bash
# With script (U7.1+):
bash scripts/post-screencast.sh --rotate-password

# Manual alternative:
NEW_PW=$(openssl rand -base64 24)
# Set in Supabase Dashboard → Authentication → Users → reviewer@malbek.co.jp → Update password
# Then update SSM:
aws ssm put-parameter --name /fumireply/review/supabase/reviewer-password \
  --value "$NEW_PW" --type SecureString --overwrite
```

Generates a new password via `openssl rand -base64 24`, updates Supabase Auth and SSM
`/fumireply/review/supabase/reviewer-password`.

### Master Encryption Key Recovery

If the master encryption key (`/fumireply/master-encryption-key` in SSM) is lost:

1. Identify all rows in `connected_pages` — the `page_access_token` column is encrypted.
2. Retrieve the backup copy from the secure offline store (see internal credentials doc).
3. If no backup exists, reconnect each Facebook Page via the Connect Page flow after restoring the key placeholder.
4. Update SSM `/fumireply/master-encryption-key` with the recovered or newly generated key.
5. Append an audit row below.

---

## Audit Log

Format: `YYYY-MM-DDTHH:MM:SSZ | EVENT | DETAIL`

<!-- Append new rows below this line. Do not edit existing rows. -->
