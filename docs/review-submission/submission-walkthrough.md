# Meta App Review — Submission Walkthrough

**App**: Fumireply  
**Operator**: Malbek Inc. (株式会社 Malbek)  
**Reviewer-facing URL**: `https://review.fumireply.ecsuite.work`

This document walks through the complete step-by-step process for submitting the Meta App Review request, from pre-submission prerequisites to capturing the submission ID.

---

## 1. Pre-Submit Prerequisites

All of the following must be in place **before** opening the Meta App Dashboard form. Check each item before proceeding to section 2.

| # | Prerequisite | How to verify |
|---|---|---|
| 1 | `002-app-review-submission` branch deployed to production | `curl -o /dev/null -s -w "%{http_code}" https://review.fumireply.ecsuite.work/` → `200` |
| 2 | Business Verification approved or pending review | Meta App Dashboard → App Review → Business Verification (green badge or pending) |
| 3 | Production screencast MP4 rendered and uploaded as YouTube Unlisted | YouTube Studio → Video → Visibility = Unlisted + URL copied to clipboard |
| 4 | `use-case-description.md` finalised (English body, all 4 permissions, timestamps matching screencast) | `grep -c "<<" docs/review-submission/use-case-description.md` → `0` |
| 5 | `reviewer-credentials.md` §3 block updated with actual Test Page name, Page ID, and latest password from SSM | `bash scripts/prep-screencast.sh --dry-run` passes without error _(script added in U7.1; if not yet available, verify SSM parameter exists: `aws ssm get-parameter --name /fumireply/review/supabase/reviewer-password --with-decryption`)_ |
| 6 | Reviewer account enabled (`banned_until = NULL`) | `bash scripts/prep-screencast.sh` completes successfully _(U7.1 script; if not yet available, use Supabase Dashboard to set `banned_until = NULL` for `reviewer@malbek.co.jp`)_ |
| 7 | Webhook green check in Meta App Dashboard | Dashboard → Products → Webhooks → Page → subscribed_apps field: green ✓ |
| 8 | Long-lived Page Access Token active (not expired) | `bash scripts/prep-screencast.sh` health check passes _(U7.1 script; if not yet available, `curl -o /dev/null -s -w "%{http_code}" https://review.fumireply.ecsuite.work/` → 200)_ |
| 9 | All public pages return 200 | `curl https://review.fumireply.ecsuite.work/privacy` → 200 (and `/terms`, `/data-deletion`) |
| 10 | Supabase keep-alive Lambda running (prevents DB pause) | AWS Lambda console → `fumireply-review-keep-alive` → last invocation ≤ 5 min ago |
| 11 | Anthropic AI usage disclosed in Privacy Policy | `https://review.fumireply.ecsuite.work/privacy` contains "Anthropic" |
| 12 | Connect Page flow reachable | Clear `connected_pages` row (via prep script or `psql -c "DELETE FROM connected_pages WHERE tenant_id = ..."`) → log in → `/onboarding/connect-page` loads |

> **Note**: Items 5, 6, 8, and 12 reference `scripts/prep-screencast.sh` and `scripts/post-screencast.sh` which are added in U7.1 (see PR #21). Until that branch is merged, use the manual alternatives shown in each row above.

Once all items are checked, open Chrome in a **separate window** (not incognito) and log in to [Meta for Developers](https://developers.facebook.com/apps/) as the App owner.

---

## 2. Meta App Dashboard Navigation Map

```
Meta for Developers (developers.facebook.com)
└── My Apps
    └── [Select your Fumireply App]
        ├── Dashboard                           ← landing
        ├── App Review
        │   ├── Permissions and Features        ← ★ main submission form (section 3–5)
        │   └── Business Verification           ← prerequisite check (section 1, item 2)
        └── Products
            └── Webhooks                        ← prerequisite check (section 1, item 7)
```

Navigate to: **App Review → Permissions and Features**

The page lists all permissions and features that require review. For Fumireply, four permissions require substantive use-case justification:

| Permission | Review status needed |
|---|---|
| `pages_messaging` | Standard Access |
| `pages_show_list` | Standard Access |
| `pages_manage_metadata` | Standard Access |
| `pages_read_engagement` | Standard Access |

Click **Request** (or **Edit request**) next to each permission to open its use-case form.

---

## 3. Per-Permission Paste Content

For each permission, paste the following content from `docs/review-submission/use-case-description.md` into the corresponding "How will you use this permission?" text area.

| Permission | Source section in `use-case-description.md` | What to paste |
|---|---|---|
| `pages_messaging` | `### Common preamble` **+** `### \`pages_messaging\`` | Full preamble paragraph (steps 1–4 + disclosure + data retention) **followed by** the `pages_messaging` section |
| `pages_show_list` | `### Common preamble` **+** `### \`pages_show_list\`` | Same preamble **followed by** the `pages_show_list` section |
| `pages_manage_metadata` | `### Common preamble` **+** `### \`pages_manage_metadata\`` | Same preamble **followed by** the `pages_manage_metadata` section |
| `pages_read_engagement` | `### Common preamble` **+** `### \`pages_read_engagement\`` | Same preamble **followed by** the `pages_read_engagement` section |

**Paste order**: Common preamble first, then the permission-specific paragraph. Do not include the Markdown heading lines (`###`) — paste plain text only.

> **Tip**: Open `use-case-description.md` in a plain-text editor or `cat` it in terminal so that Markdown formatting does not interfere. The content is written in submission-ready English.

---

## 4. Screencast Upload Procedure

The same screencast is used for all four permission fields.

### 4.1 Upload to YouTube (if not already done)

1. Open [YouTube Studio](https://studio.youtube.com)
2. Click **Create → Upload videos**
3. Select the exported MP4 (1080p, ≤100 MB, ≤4 minutes)
4. Title: `Fumireply — Meta App Review Screencast`
5. Visibility: **Unlisted** (not Public, not Private)
6. Click **Save** and wait for processing to complete (≤5 min)
7. Copy the video URL from the browser address bar (format: `https://youtu.be/XXXXXXXXXXX`)

### 4.2 Paste into Each Permission Form

In the Meta App Dashboard, each permission's use-case form has a field for a **video URL / screencast**. Paste the same YouTube Unlisted URL into:

1. `pages_messaging` → video field
2. `pages_show_list` → video field
3. `pages_manage_metadata` → video field
4. `pages_read_engagement` → video field

> Meta's form may label the field "Screencast URL", "Video URL", or "Demonstration". All four fields accept the same URL.

### 4.3 Screencast Content Requirements

The video must show (see `docs/review-submission/screencast-script.md` for precise timestamps):

| Timestamp | Scene |
|---|---|
| 0:00–0:15 | App intro slide |
| 0:15–0:45 | Login, language toggle (EN), /inbox overview |
| 0:45–1:30 | Connect Facebook Page flow (pages_show_list + pages_manage_metadata: FB.login popup, 4-permission consent, Page selection) |
| 1:30–2:00 | Inbox with incoming Messenger message |
| 2:00–2:30 | Thread view: AI draft appears, operator edits, clicks Send |
| 2:30–2:45 | Customer receives reply on Messenger (phone screen) |
| 2:45–3:00 | Public pages: /privacy, /terms, /data-deletion each return 200 |

---

## 5. Reviewer Credentials Placement

In the **Reviewer Credentials** section of each permission's form (sometimes labelled "Test user credentials" or "Additional instructions for reviewer"), paste the English block from `docs/review-submission/reviewer-credentials.md` §3 verbatim.

Before pasting:

1. Replace `<<PASSWORD — paste from SSM>>` with the actual password:
   ```bash
   aws ssm get-parameter \
     --name /fumireply/review/supabase/reviewer-password \
     --with-decryption \
     --query 'Parameter.Value' --output text
   ```
2. Replace `<<TEST PAGE NAME — fill before submission>>` with the Test Page's display name.
3. Replace `<<NUMERIC PAGE ID — fill before submission>>` with the Page's numeric ID (visible in the Page's About section or from `/me/accounts` response).

**Important**: Do not save the password anywhere other than the submission form and the SSM parameter.

---

## 6. Pre-Submit Checklist

Work through this list top to bottom immediately before clicking Submit. Mark each item confirmed.

- [ ] **Business Verification** badge is green (or pending review) in App Review dashboard
- [ ] All 4 permission use-case text fields are filled (no empty fields, no Markdown headings)
- [ ] Same YouTube Unlisted screencast URL is pasted into all 4 video fields
- [ ] Reviewer credentials block is pasted into all 4 fields with actual password, Page name, and Page ID substituted
- [ ] `<<` placeholder search returns zero matches: `grep -c "<<" docs/review-submission/use-case-description.md`
- [ ] Public pages return 200: `/`, `/privacy`, `/terms`, `/data-deletion`, `/login`, `/onboarding/connect-page`
- [ ] Webhook green check visible in Dashboard → Products → Webhooks → Page feed
- [ ] Reviewer account is **enabled** (`banned_until = NULL`): confirmed by `bash scripts/prep-screencast.sh` step (a)
- [ ] Long-lived Page Access Token is active (not expired within 60-day window): prep script health check passed
- [ ] Anthropic AI usage is disclosed in the live Privacy Policy page at `https://review.fumireply.ecsuite.work/privacy`
- [ ] Supabase keep-alive Lambda shows a successful invocation within the last 5 minutes in CloudWatch
- [ ] Screencast video is accessible (Unlisted, not Private): open the YouTube URL in an incognito window
- [ ] Connect Page flow works end-to-end on production: login → /onboarding → FB.login popup → select Page → /inbox
- [ ] Data Deletion callback returns 200 for the Meta "Send test" button in App Settings → Advanced

All items checked? Proceed to section 7.

---

## 7. Submit and Capture Submission ID

1. In Meta App Dashboard → App Review → Permissions and Features, scroll to the bottom of the form.
2. Review the submission summary — confirm all 4 permissions are listed.
3. Click **Submit for Review**.
4. A confirmation banner appears with a submission reference number (format: `APP-REVIEW-XXXXXXXX` or similar).
5. **Immediately copy this ID** and record it:

   ```bash
   # Append to audit log (format: YYYY-MM-DDTHH:MM:SSZ | EVENT | DETAIL)
   echo "$(date -u +"%Y-%m-%dT%H:%M:%SZ") | Submitted App Review | Submission ID: <PASTE-ID-HERE>" \
     >> docs/operations/audit-runbook.md
   ```

6. Take a screenshot of the confirmation banner as an additional record.
7. The dashboard status changes to **In Review**. Do not modify the form or re-submit while in this state.

---

## 8. Post-Submit Handoff

After submission, hand off to the ongoing operations workflow documented in `docs/operations/audit-runbook.md`:

1. **Keep reviewer enabled** — do not run `bash scripts/post-screencast.sh` until the review result arrives. The reviewer must remain able to log in throughout the review period.
2. **Monitor App Review status** — check Meta App Dashboard once per business day. Status changes appear under App Review → Permissions and Features.
3. **Do not rotate the reviewer password** during the review period — changing credentials while a review is open causes "Cannot reproduce" rejections.
4. **If rejected**: address the rejection notes using the `docs/review-submission/` documents as a base. Common rejection reasons:
   - Missing Business Verification → complete verification via App Review → Business Verification
   - Screencast doesn't show permission usage → re-record per updated `screencast-script.md`
   - Reviewer cannot log in → check `banned_until` and test credentials manually
5. **After result notification** (approved or rejected): run `bash scripts/post-screencast.sh` to re-disable the reviewer account and optionally rotate the password.
6. **If approved**: update `docs/operations/audit-runbook.md` with the approval date and proceed to the production token refresh workflow.
