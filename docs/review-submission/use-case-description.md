# Use Case Description — Fumireply

**Submitted to**: Meta App Review
**App name**: Fumireply
**App ID**: _(申請時に確定する Meta App ID をここに記入)_
**Operator**: Malbek Inc. (株式会社Malbek)
**Reviewer-facing URL**: `https://review.fumireply.ecsuite.work`
**Privacy Policy URL**: `https://review.fumireply.ecsuite.work/privacy`
**Terms URL**: `https://review.fumireply.ecsuite.work/terms`
**Data Deletion URL**: `https://review.fumireply.ecsuite.work/data-deletion`
**Webhook Callback URL**: `https://review.fumireply.ecsuite.work/api/webhook`
**Data Deletion Callback URL**: `https://review.fumireply.ecsuite.work/api/data-deletion`

---

## How will you use these permissions and features? (English)

> 以下を申請フォーム "App Review → Permissions and Features" の各権限の Use Case 入力欄にコピー＆ペーストする。共通プリアンブル + 各権限の個別段落の構成。

### Common preamble (paste at the top of every permission's use case)

Fumireply is an admin tool that lets human operators of a Facebook Page reply to incoming Messenger messages from their customers. The core workflow is:

**Step 0 — Connect Facebook Page (one-time setup, screencast 0:15–1:00)**

Before the inbox is accessible the operator must connect a Facebook Page:

1. After signing in, the operator is redirected to `/onboarding/connect-page`.
2. The operator clicks "Connect with Facebook", which opens the Facebook Login dialog requesting four permissions: `pages_messaging`, `pages_read_engagement`, `pages_manage_metadata`, and `pages_show_list`.
3. On successful consent, our server calls the Graph API to exchange the short-lived user token for a long-lived token, retrieves the operator's page list, and asks the operator to select one page.
4. After the operator selects a page, our server calls `POST /{pageId}/subscribed_apps` to subscribe the webhook and stores the encrypted Page Access Token in our database. The operator is redirected to `/inbox`.

This onboarding flow runs entirely on our server — the Page Access Token never appears in the browser.

**Step 1 — Incoming messages (screencast 1:00–1:20)**

A customer sends a Messenger message to the connected Facebook Page. Our webhook receives the event, stores the message, and triggers an AI draft generator (Anthropic Claude Haiku 4.5) over HTTPS.

**Step 2 — AI draft (screencast 1:20–1:45)**

The AI-generated reply draft appears in the operator's admin inbox as a suggestion.

**Step 3 — Human review and send (screencast 1:45–2:10)**

The human operator reviews the draft, edits it as needed, and **explicitly clicks a Send button** to deliver the reply through the Send API. **Auto-sending is not implemented anywhere in the codebase.**

The disclosure that customer message bodies are processed by Anthropic for the sole purpose of draft generation is included in our Privacy Policy at `https://review.fumireply.ecsuite.work/privacy`. Customer data is retained while the service contract is active and deleted upon request via our data deletion endpoint, which also removes any AI-generated drafts.

The end users of our Facebook Page are customers of a Japanese cross-border e-commerce business operated by Malbek Inc. (mainly trading-card-game retail). The primary benefits are: (a) faster response time for customer inquiries, and (b) reduced typing time for the operator while keeping a human in the loop on every reply.

---

### `pages_messaging`

We use `pages_messaging` in two ways:

**1. Send API (screencast 1:45–2:10)** — Each reply is composed as follows: the operator opens the conversation in our admin panel, reviews the AI-generated draft that has been pre-filled in the reply textarea, edits it if necessary, and explicitly clicks the Send button. Only at that point do we call `POST https://graph.facebook.com/v19.0/me/messages` with the long-lived Page Access Token to deliver the message.

We do **not** implement automated sending. There is no scheduler, no AI-trigger, and no batch send. Every outgoing Messenger message corresponds to a manual click action by an authenticated operator. The Send button is also explicitly disabled when the 24-hour window has expired.

We are not requesting `pages_messaging_subscriptions` in this submission; we only reply within the 24-hour window.

**2. Webhook subscription (screencast 0:55–1:00)** — During the Connect Page onboarding, we call `POST /{pageId}/subscribed_apps` with the `messages` and `messaging_postbacks` fields so that incoming Messenger events are delivered to our webhook at `https://review.fumireply.ecsuite.work/api/webhook`.

---

### `pages_read_engagement`

We use `pages_read_engagement` to read incoming messages from customers on the connected Facebook Page so that we can (screencast 1:00–1:45):

1. Display the messages in the operator's admin inbox in a chronological, threaded view.
2. Pass the message body and recent conversation history to Anthropic's Claude Haiku 4.5 model over HTTPS as input for generating the reply draft.

The message bodies and the customer's Page-Scoped ID (PSID) are the only Messenger fields we read. We do not enumerate Page posts, comments, or other engagement objects beyond what is necessary for the messaging inbox.

---

### `pages_manage_metadata`

We use `pages_manage_metadata` to (screencast 0:50–1:00):

1. Subscribe our app to the `messages` and `messaging_postbacks` webhook fields on the Page so that incoming Messenger events are delivered to our webhook endpoint at `https://review.fumireply.ecsuite.work/api/webhook`.
2. Optionally tag conversations with internal labels (e.g., "needs follow-up") in future iterations of the inbox UI.

Webhook subscription is performed once at onboarding time per Page (during the Connect Page flow visible in the screencast at 0:55–1:00). We do not modify Page metadata such as name, description, or profile picture.

---

### `pages_show_list`

We use `pages_show_list` during the Connect Page onboarding flow (screencast 0:30–0:55):

After the operator grants consent, our server calls `GET https://graph.facebook.com/v19.0/me/accounts` to retrieve the list of Pages the operator administers. We display the page names and IDs to the operator so they can select which Page to connect to Fumireply. The Page Access Token returned by this endpoint is immediately encrypted (AES-256-GCM) and stored server-side; it is never exposed to the browser.

We do not access post content, insights, or any Page data beyond the Page ID, name, and access token needed to establish the connection.

---

## Future enhancements (within the same permission scope)

Within the same permission scope (`pages_messaging`, `pages_read_engagement`, `pages_manage_metadata`, `pages_show_list`), we plan the following enhancements after approval. These are mentioned here so that subsequent rollout does not require a new App Review:

1. **AI-based message categorization** — automatically classifying incoming messages into intent categories (price inquiry, stock check, shipping, product detail, other) to help the operator prioritize, while still requiring a human to send each reply.
2. **Customer profile management** — associating PSIDs with internal customer records, purchase history, and VIP tags, displayed alongside the conversation in the inbox.
3. **Product catalog integration** — letting the AI draft generator look up the operator's product catalog (price, stock, shipping info) so drafts are pre-populated with concrete answers; the operator still reviews and sends.
4. **Operator notifications via Slack** — pushing inbox alerts to a connected Slack workspace so operators get notified outside the admin panel.
5. **Instagram Direct Messages** — supporting the same review-and-send flow for Instagram DMs under the same inbox UX (we will request `instagram_basic` / `instagram_manage_messages` separately as required).

In all of the above, the human-in-the-loop send model remains unchanged. No automated message sending will be added.

---

## Data handling summary

| Data | Source | Purpose | Storage | Retention | Third-party |
|------|--------|---------|---------|-----------|-------------|
| Messenger message body | Webhook | Display + AI draft input | Supabase Postgres (Tokyo, encrypted at rest) | 180 days or until deletion request | Anthropic (HTTPS, draft generation only) |
| PSID (Page-Scoped ID) | Webhook | Conversation identity | Supabase Postgres | Same as above | None |
| Page Access Token | Connect Page onboarding flow | Send API authentication | Supabase Postgres, AES-256-GCM encrypted at field level | Until token rotation | None |
| AI draft text | Anthropic response | Pre-fill operator's reply textarea | Supabase Postgres | Same as message | Stored only on our side |

The data deletion endpoint at `POST https://review.fumireply.ecsuite.work/api/data-deletion` complies with Meta's signed-request specification (HMAC-SHA256). When a deletion request is received, we delete all messages, conversations, and AI drafts associated with the PSID, retaining only a hashed audit log entry as evidence of the deletion.

---

## Reviewer testing notes

- Reviewer credentials and the test Facebook Page handle are provided in `reviewer-credentials.md` (also pasted into the App Review submission form).
- The reviewer performs the Connect Page onboarding during the screencast demo — no pre-seeded DB state is required.
- The 24-hour reply window is enforced — please send a fresh inbound message immediately before testing the Send button.
- The reviewer account does not have 2FA enabled and is not IP-restricted, per the Meta reviewer guideline.
- Anthropic API outages are handled gracefully: the reply textarea remains usable with a manually composed reply (no AI draft required to send).
