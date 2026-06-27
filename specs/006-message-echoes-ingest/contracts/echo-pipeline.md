# Contract: echo パイプライン

本ドキュメントは本機能で **コードと外部設定の境界に固定する契約** を列挙する。テストとレビューはこの契約に対して書く。

---

## C1. Meta Webhook 購読フィールド

### 契約

Meta App 管理画面で対象 App の Messenger 製品 Webhook 購読フィールド一覧に以下を含むこと:

- `messages`
- `messaging_postbacks`
- **`message_echoes`** ← 本機能で追加

### 検証

- `docs/resume-webhook-bringup.md` に当該フィールドが列挙されている (DOC-1)
- Meta App 管理画面で `gh issue` のリリースタスク内で人手確認 (RUN-1)

### 注意

- フィールド追加後、Meta から既存会話の echo がバックフィルされない (Meta は購読開始以降のイベントのみ送る)
- フィールドを外せば echo 配信が止まり、本機能のコード経路は dead code 化する (= 緊急ロールバック手段)

---

## C2. Webhook 受信ペイロード (echo 部分)

### スキーマ (既存 `messagingEventSchema` を流用)

```ts
{
  sender:    { id: PageId },      // string、page = fumireply 自送信もしくは外部アプリ送信
  recipient: { id: CustomerPsid },// string、顧客の PSID
  timestamp: number,              // ms epoch (Meta 確定時刻)
  message: {
    mid:         string,           // Meta 採番、一意
    is_echo:     true,             // ← echo の識別子
    text?:       string,           // テキスト送信時のみ
    attachments?: Array<{ type: string, payload?: { sticker_id?: number, url?: string } }>,
    app_id?:     number,           // 送信元アプリ ID。本機能では参照しない
  }
}
```

### 不変条件

- `is_echo === true` のとき `sender.id` は Page ID、`recipient.id` は顧客 PSID
- `mid` はテナント横断グローバル一意 (Facebook Messaging Platform 仕様)
- `text` と `attachments` は排他 (実用上)、両方なければ `messageType='unknown'`

---

## C3. echo 取り込みハンドラ契約 (`webhook/src/handler.ts`)

### 入口

```ts
async function processMessagingEvent(
  event: MessagingEvent,
  tenantId: string,
  pageUuid: string,
  pageAccessTokenEncrypted: Buffer,
): Promise<{ messageId: string; conversationId: string } | null>
```

戻り値は **echo 経路では常に `null`** とする。これにより `handlePost` のループ内の `if (result) { sqsClient.send(...); maybeEnqueueSummaryJob(...) }` がスキップされる (FR-009)。

### 内部契約 (擬似コード)

```ts
if (msg.is_echo) {
  const psid = event.recipient.id
  const { messageType, body } = determineEchoMessageType(msg)
  const ts = event.timestamp

  const outcome = await withTenant(tenantId, async (tx) => {
    const conv = await upsertConversation(tx, tenantId, pageUuid, psid)
    const inserted = await tx
      .insert(messages)
      .values({
        tenantId,
        conversationId: conv.id,
        direction: 'outbound',
        metaMessageId: msg.mid,
        body,
        messageType,
        timestamp: new Date(ts),
        sendStatus: 'sent',
        sentByAuthUid: null,
      })
      .onConflictDoUpdate({
        target: messages.metaMessageId,
        set: { sendStatus: 'sent' },
      })
      .returning({ id: messages.id, inserted: sql<boolean>`(xmax = 0)` })
    return inserted[0]
  })

  if (outcome.inserted) {
    console.info('external_echo_ingested', {
      conversationId: outcome.id, mid: msg.mid, pageId: pageUuid,
      messageType, bodyLength: body.length, tsMs: ts,
    })
  } else {
    console.info('self_echo_confirmed', {
      conversationId: outcome.id, mid: msg.mid, pageId: pageUuid,
    })
  }
  return null
}
```

### 副作用契約 (echo は以下を行わない)

| 項目 | 振る舞い |
|---|---|
| `conversations.lastInboundAt` 更新 | しない |
| `conversations.lastMessageAt` 更新 | しない (本リリースのスコープ外) |
| `conversations.unreadCount` 加算 | しない |
| `conversations.customerName` 取得 (Graph API) | しない |
| `ai_drafts` への書き込み / SQS 送信 | しない |
| Summary trigger (`maybeEnqueueSummaryJob`) | しない |
| stale-pending guard 評価 | しない |

### 関数分割 (推奨)

- `upsertConversation(tx, tenantId, pageId, customerPsid) => Promise<{ id, customerName }>` を新規切出し、inbound 経路 (`handler.ts:144`) からも呼ぶように差し替え (DRY)
- `determineEchoMessageType(msg)` を新規追加 (`body=''` ルール / Q1)。inbound 用 `determineMessageType` とは別関数

---

## C4. send-reply mid 書き戻し契約 (`app/src/routes/(app)/threads/$id/-lib/send-reply.fn.ts`)

### 変更前 (line 87-115 抜粋)

```ts
if (sendResult.ok) {
  await tx.update(messages).set({ sendStatus: 'sent', metaMessageId: sendResult.messageId })
    .where(eq(messages.id, prep.insertedId))
  // ... ack drafts, return ok ...
}
```

### 変更後

```ts
if (sendResult.ok) {
  let finalMessageId = prep.insertedId
  try {
    await tx.update(messages)
      .set({ sendStatus: 'sent', metaMessageId: sendResult.messageId })
      .where(eq(messages.id, prep.insertedId))
  } catch (err) {
    if (isUniqueViolation(err, 'messages_meta_message_id_unique')) {
      // echo が先着して同 mid の行を作っていた。tentative 行を消して echo 行に attribute。
      await tx.delete(messages).where(eq(messages.id, prep.insertedId))
      const claimed = await tx.update(messages)
        .set({ sentByAuthUid, sendStatus: 'sent' })
        .where(eq(messages.metaMessageId, sendResult.messageId))
        .returning({ id: messages.id })
      finalMessageId = claimed[0]?.id ?? prep.insertedId
      console.info('echo_send_attribution_recovered', {
        conversationId: data.conversationId,
        mid: sendResult.messageId,
        droppedRowId: prep.insertedId,
        sentByAuthUid,
      })
    } else {
      throw err
    }
  }
  // ... ack drafts, return ok with id=finalMessageId ...
}
```

### `isUniqueViolation` ヘルパ

Postgres エラーコード `23505` と制約名 `messages_meta_message_id_unique` の組み合わせで判定:

```ts
function isUniqueViolation(err: unknown, constraint: string): boolean {
  return (
    typeof err === 'object' && err !== null &&
    'code' in err && err.code === '23505' &&
    'constraint_name' in err && err.constraint_name === constraint
  )
}
```

(postgres-js / drizzle のエラーオブジェクトに `code` と `constraint_name` が露出することを確認済み。詳細は実装時に再確認。)

### 戻り値契約

```ts
{
  ok: true,
  message: { id: finalMessageId, body, timestamp, send_status: 'sent' }
}
```

- `finalMessageId` は attribute 補正発生時に echo 行の id に置き換わる
- UI 側 (`ReplyForm` / `ThreadMessages`) はこの id を楽観更新で受け取る。次回ロードで DB 状態と同期する

---

## C5. 構造化ログイベント契約

CloudWatch Logs に以下のイベントが上記の場面で必ず 1 度だけ出ること。フィールド名・型は固定。

**形式**: 既存 `~/server/services/summary-trigger.ts` や `regenerate-draft.fn.ts` 等と揃え、 `console.info({ event: '...', ...fields })` の **単一引数オブジェクト形式**で出力する。これにより CloudWatch Logs Insights で `filter event = "..."` がそのまま使えるようになる。

| event | 出力箇所 | 必須フィールド |
|---|---|---|
| `external_echo_ingested` | webhook handler.ts (UPSERT INSERT 経路) | `event: string`, `conversationId: string`, `mid: string`, `pageId: string (uuid)`, `messageType: 'text'|'sticker'|'image'|'unknown'`, `bodyLength: number`, `tsMs: number` |
| `self_echo_confirmed` | webhook handler.ts (UPSERT UPDATE 経路) | `event: string`, `conversationId: string`, `mid: string`, `pageId: string (uuid)` |
| `echo_send_attribution_recovered` | app send-reply.fn.ts (UNIQUE 違反 catch) | `event: string`, `conversationId: string`, `mid: string`, `droppedRowId: string`, `sentByAuthUid: string` |

**注意**: `conversationId` は `conversations.id` であり `messages.id` ではない。echo 経路では `upsertConversation` の戻り値 `conv.id` を採用する (RETURNING で `messages.id` を取って間違って使わないこと)。

PII (本文・名前など) は出力しない。`bodyLength` は文字数 (string.length)。

---

## C6. ドキュメント更新

### `docs/resume-webhook-bringup.md` (DOC-1)

「Subscription Fields」 (現:`messages, messaging_postbacks`) を `messages, messaging_postbacks, message_echoes` に書き換える。
追加で運用手順末尾に:

> **2026-06-27 以降の必須設定**: Meta App 管理画面で `message_echoes` フィールドを購読する。
> 未購読の場合、外部アプリ (Messenger 公式アプリ等) からの送信が fumireply に取り込まれない。
> 詳細は `specs/006-message-echoes-ingest/` を参照。

を追記する。

---

## C7. テスト契約 (詳細は `research.md` R8)

### Webhook テスト (`webhook/src/handler.test.ts`)

最低 8 ケース ([R8 表](../research.md#r8-テスト戦略))。fixtures は既存 `is_echo` の 1 ケースを土台に拡張。

### App テスト (`send-reply.fn.test.ts`)

最低 2 ケース。UNIQUE 違反シミュレートは `pg_query_emulator` でなく、テスト用 schema にあらかじめ `(metaMessageId=X)` の echo 行を仕込んで送信 fn を呼ぶ。

### E2E (Playwright)

スレッドに自送信 1 件 + 外部 echo モック 1 件が並んで表示されること。Webhook に直接 POST を投げるためテスト用エンドポイント or signature bypass 環境変数 (既存) を使う。

---

## C8. 非契約 (out-of-scope の確認)

以下は本機能の契約外で、変更しない:

- `messages` テーブルのスキーマ
- `conversations.lastMessageAt` / `unreadCount` の更新ロジック
- AI 下書きパイプライン (#004 / #005)
- UI 上での自送信 / 外部送信の視覚区別
- 過去送信の遡及取り込み
- `app_id` の保存・参照
