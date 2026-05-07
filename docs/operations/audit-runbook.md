# Operations Audit Runbook — Fumireply

**App**: Fumireply  
**Operator**: Malbek Inc. (株式会社 Malbek)

This file serves two purposes:
1. **Runbook** — step-by-step procedures for recurring operational tasks
2. **Audit log** — append-only record of key operational events (prep runs, submissions, result notifications)

Scripts (`scripts/prep-screencast.sh`, `scripts/post-screencast.sh`) append audit rows automatically.
Human operators append rows for events not covered by scripts.

---

## Recurring Procedures

### Reviewer Account Enable / Disable

Enable before review period (run via `scripts/prep-screencast.sh`):
```bash
bash scripts/prep-screencast.sh  # enables reviewer, clears connected_pages, health checks
```

Disable after review result (run via `scripts/post-screencast.sh`):
```bash
bash scripts/post-screencast.sh  # re-bans reviewer, optionally rotates password
```

### Reviewer Password Rotation

```bash
bash scripts/post-screencast.sh --rotate-password
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
