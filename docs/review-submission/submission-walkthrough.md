# Submission Walkthrough — Fumireply Meta App Review

**Audience**: Submission operator (Malbek Inc.)
**Purpose**: Step-by-step guide to complete the Meta App Review submission in the App Dashboard
**Updated**: 2026-05-12

> This guide assumes all implementation tasks (Phase 1–7 of `specs/002-app-review-submission/tasks.md`) are complete, the app is deployed to `https://review.fumireply.ecsuite.work`, and the screencast has been recorded and uploaded to YouTube as Unlisted.

---

## 1. Pre-Submit Prerequisites

Confirm all of the following before opening the Meta App Dashboard:

| # | Item | How to verify |
|---|------|---------------|
| 1 | Branch `002-app-review-submission` merged to main and deployed | CI green + `curl -o /dev/null -s -w "%{http_code}" https://review.fumireply.ecsuite.work/login` returns `200` |
| 2 | `bash scripts/prep-screencast.sh` run successfully after final deploy | Audit log entry in `docs/operations/audit-runbook.md` |
| 3 | Reviewer account enabled (`banned_until = NULL`) | Supabase Dashboard → Auth → Users → `reviewer@malbek.co.jp` → `banned_until` is empty |
| 4 | Reviewer account password current in SSM | `aws ssm get-parameter --name /fumireply/review/supabase/reviewer-password --with-decryption --query 'Parameter.Value' --output text` succeeds |
| 5 | Reviewer can sign in to review URL | Incognito → `https://review.fumireply.ecsuite.work/login` → SSM password → reaches `/onboarding/connect-page` |
| 6 | Screencast uploaded to YouTube as Unlisted | Incognito → paste YouTube URL → plays without sign-in |
| 7 | Webhook subscription green | Meta App Dashboard → Webhooks → page shows green checkmark |
| 8 | Business Verification approved | Meta App Dashboard → App Settings → Business Verification shows "Verified" |
| 9 | All public pages return 200 | See §6 pre-submit checklist |
| 10 | Data Deletion endpoint passes "Send test" | App Settings → Advanced → Data Deletion Request URL → "Send test" returns `200` |

---

## 2. Meta App Dashboard Navigation Map

```
Meta for Developers (developers.facebook.com)
└── My Apps → [Fumireply App]
    ├── App Review
    │   └── Permissions and Features          ← main submission UI
    │       ├── pages_messaging               ← paste use-case + screencast URL
    │       ├── pages_read_engagement         ← paste use-case + screencast URL
    │       ├── pages_manage_metadata         ← paste use-case + screencast URL
    │       └── pages_show_list               ← paste use-case + screencast URL
    ├── App Settings
    │   ├── Basic                             ← App Domains, Privacy Policy URL, ToS URL
    │   └── Advanced
    │       └── Data Deletion Request URL     ← verify "Send test" returns 200
    └── Webhooks                              ← verify green checkmark
```

---

## 3. Per-Permission Paste Content

For each of the four permissions, paste the corresponding content from `docs/review-submission/use-case-description.md`.

| Permission | What to paste |
|---|---|
| `pages_messaging` | **Common preamble** (from "Fumireply is an admin tool..." to the end of Step 3) + **`pages_messaging` section** |
| `pages_read_engagement` | **Common preamble** + **`pages_read_engagement` section** |
| `pages_manage_metadata` | **Common preamble** + **`pages_manage_metadata` section** |
| `pages_show_list` | **Common preamble** + **`pages_show_list` section** |

> The common preamble is identical across all four fields — copy-paste it in full each time. Meta reviewers may be assigned to different permissions independently, so each field must be self-contained.

### Paste procedure (per permission)

1. Open `docs/review-submission/use-case-description.md` in your editor.
2. Select from `## How will you use these permissions` preamble through the specific permission's section.
3. In the Meta App Dashboard, click the permission's "Edit" or "Add Details" button.
4. Paste into the "How will you use this permission?" text area.
5. Do **not** include the "Future enhancements" section or the data handling table — those are for reference only.

---

## 4. Screencast Upload Procedure

### 4.1 One video, four fields

The **same** YouTube URL is pasted into all four permission fields. Meta accepts a single shared screencast covering all requested permissions.

### 4.2 Where to paste

In each permission's detail pane, find the field labeled **"Screencast / Video URL"** (or similar wording) and paste the YouTube URL.

### 4.3 Video requirements checklist

- [ ] YouTube visibility: **Unlisted** (not Public, not Private)
- [ ] No sign-in required to view
- [ ] Length ≤ 4 minutes (target: ~3:00)
- [ ] Resolution 1920×1080
- [ ] Audio narration in English with English subtitles burned in
- [ ] UI language: English (EN toggle must be set before recording)
- [ ] No personal data visible (no real PSID, no real name, no password visible)

---

## 5. Reviewer Credentials Placement

In the App Review submission form, find the **"Test User Credentials"** or **"Reviewer Instructions"** field and paste the English block from `docs/review-submission/reviewer-credentials.md` §3, with placeholders filled in:

1. Retrieve password from SSM:
   ```bash
   aws ssm get-parameter \
     --name /fumireply/review/supabase/reviewer-password \
     --with-decryption \
     --query 'Parameter.Value' \
     --output text
   ```
2. Replace `<<PASSWORD — paste from SSM>>` with the retrieved value.
3. Replace `<<TEST PAGE NAME — fill before submission>>` with the Facebook Test Page name.
4. Replace `<<NUMERIC PAGE ID — fill before submission>>` with the numeric Page ID.
5. Replace `<<FB TEST USER EMAIL — fill before submission>>` with the Test User's Facebook email.
6. Paste the completed block into the reviewer credentials field.

> **Never** save the filled-in block to a file, Slack DM, or note-taking app. Use the clipboard only.

---

## 6. Pre-Submit Checklist (≥10 Items)

Complete every item before clicking Submit:

- [ ] `https://review.fumireply.ecsuite.work` returns `200`
- [ ] `https://review.fumireply.ecsuite.work/privacy` returns `200` and contains "Anthropic" disclosure
- [ ] `https://review.fumireply.ecsuite.work/terms` returns `200`
- [ ] `https://review.fumireply.ecsuite.work/data-deletion` returns `200`
- [ ] `https://review.fumireply.ecsuite.work/login` returns `200`
- [ ] `https://review.fumireply.ecsuite.work/onboarding/connect-page` returns `200` (after auth redirect)
- [ ] Data Deletion "Send test" returns `200` (App Settings → Advanced)
- [ ] Webhook subscription shows green checkmark (Dashboard → Webhooks)
- [ ] Reviewer account `banned_until = NULL` (enabled for review period)
- [ ] SSM password retrieval works and incognito sign-in succeeds
- [ ] Business Verification: Meta App Dashboard shows "Verified"
- [ ] Anthropic disclosure is visible in Privacy Policy at `/privacy`
- [ ] Long-lived Page Access Token encrypted in DB (verify via Drizzle Studio — `page_access_token_encrypted` column non-null in `connected_pages`)
- [ ] Supabase project is active (no paused state — check Supabase Dashboard project health)
- [ ] Screencast YouTube URL plays in incognito, duration ≤ 4 minutes, English UI visible
- [ ] All four permission use-case texts pasted and saved in the form
- [ ] Reviewer credentials block pasted with all placeholders replaced

---

## 7. Submit and Capture Submission ID

1. Review the complete App Review submission form one final time.
2. Click **"Submit for Review"** (or equivalent button — exact label depends on current Meta Dashboard UI).
3. A confirmation dialog or page will display a **Submission ID** (numeric string).
4. Record the Submission ID and timestamp immediately:
   ```
   Submission ID: <ID>
   Submitted at:  <ISO 8601 timestamp, e.g. 2026-05-15T10:30:00+09:00>
   Submitted by:  <operator name>
   ```
5. Append this record to `docs/operations/audit-runbook.md` under the "Submission History" section.

---

## 8. Post-Submit Handoff

After submitting:

1. Run the post-submit cleanup script immediately:
   ```bash
   bash scripts/post-screencast.sh
   ```
   This re-disables the reviewer account (`ban_duration=876000h`, approximately 100 years).

2. **Do NOT rotate the reviewer password** until after Meta notifies the result. Rotating mid-review causes "Cannot reproduce" rejections.

3. Monitor for Meta's review decision (typically 5–10 business days). Check the App Dashboard notification panel and the email associated with the Meta Business account.

4. On result notification:
   - **Approved**: run `bash scripts/post-screencast.sh --rotate-password` to rotate credentials, update `docs/operations/audit-runbook.md`.
   - **Rejected / "Cannot reproduce"**: follow `docs/operations/audit-runbook.md` §Rejection Response runbook to address the feedback before resubmitting.

5. Document the result and any follow-up actions in `docs/operations/audit-runbook.md`.

For full post-submit operations, see `docs/operations/audit-runbook.md`.
