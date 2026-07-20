# Phase 0 — Research: 外部送信 echo の取り込み設計

本ドキュメントは、spec.md の Functional Requirements と Clarifications (Q1〜Q4) を実装に落とすにあたって意思決定が必要だった点をまとめる。

---

## R1. echo 取り込みの冪等戦略: 両側 UPSERT スキーム

### 背景

`messages.metaMessageId` は column-level UNIQUE 制約 (`app/src/server/db/schema.ts:114`)。fumireply 自送信フロー (`send-reply.fn.ts:60`) は

1. **TX1** で `metaMessageId=NULL, sendStatus='pending'` の outbound 行を INSERT (id=R.id)
2. Meta Send API 呼び出し
3. **TX2** で `UPDATE messages SET sendStatus='sent', metaMessageId=mid WHERE id=R.id`

という 2 段構成。一方、Meta は echo を非同期で配信し、**TX2 が完了する前に echo 到着**しうる。現状の `webhook/src/handler.ts:130-138` の echo 分岐は

```ts
await tx.update(messages).set({ sendStatus: 'sent' })
  .where(and(eq(messages.metaMessageId, mid), eq(messages.tenantId, tenantId)))
```

で「`mid` 一致 UPDATE のみ」。`mid` がまだ NULL の `R.id` 行は引っかからず 0 行更新で終わる。本 Issue でこの分岐を「未一致時は外部送信として INSERT」に変えると、**TX2 がまだ走っていないだけの自送信** まで外部送信扱いで INSERT してしまい、後続の TX2 が UNIQUE 違反で詰まる or 2 行残る (SC-002 違反)。

### Decision

両側を「`meta_message_id` をキーとする UPSERT 的挙動」に揃える。具体的には:

#### echo 側 (webhook): `INSERT ... ON CONFLICT (meta_message_id) DO UPDATE`

```ts
await tx.insert(messages).values({
  tenantId,
  conversationId: conv.id,
  direction: 'outbound',
  metaMessageId: mid,
  body,                  // 非テキストは ''
  messageType,           // 'text' | 'sticker' | 'image' | 'unknown'
  timestamp: new Date(ts),
  sendStatus: 'sent',
  sentByAuthUid: null,
}).onConflictDoUpdate({
  target: messages.metaMessageId,
  set: { sendStatus: 'sent' },  // timestamp / body / sentByAuthUid は UPDATE 経路で触らない (Q3)
})
```

- 新規 INSERT 経路 (= 外部送信 echo の取り込み) と既存 UPDATE 経路 (= 自送信 echo の確定) を 1 文で両立。
- 戻り値で `(xmax = 0)` パターン (PG では `RETURNING (xmax = 0) AS inserted`) を使えば INSERT/UPDATE を判別し、構造化ログで分岐できる ([R4](#r4-構造化ログイベント名))。

#### 送信側 (send-reply): UPDATE + UNIQUE 違反捕捉

`TX2` の `UPDATE WHERE id=R.id SET metaMessageId=mid` で UNIQUE 制約違反 (`23505`) を `try/catch`:

```ts
try {
  await tx.update(messages)
    .set({ sendStatus: 'sent', metaMessageId: mid })
    .where(eq(messages.id, prep.insertedId))
} catch (err) {
  if (isUniqueViolation(err, 'messages_meta_message_id_unique')) {
    // 先着 echo が同 mid で既に行を作っている。tentative 行を消して echo 行に attribute。
    await tx.delete(messages).where(eq(messages.id, prep.insertedId))
    await tx.update(messages)
      .set({ sentByAuthUid, sendStatus: 'sent' })
      .where(eq(messages.metaMessageId, mid))
    console.info('echo_send_attribution_recovered', {
      conversationId: data.conversationId,
      mid,
      droppedRowId: prep.insertedId,
    })
  } else {
    throw err
  }
}
```

- echo 側が `sendStatus='sent', sentByAuthUid=null` で INSERT 済み → 送信側がこれを「自分の送信」と認識して `sentByAuthUid` を被せる。
- 戻り値の `message.id` を、本来 R.id だったところを **収束後の存続行 id** に置換して返す必要がある。`get-conversation.fn.ts` は id でメッセージを再フェッチしないが、UI 楽観更新で送信直後にメッセージリストへ R.id を差す箇所がある → 差し戻し UI は次回ロードで自動回復する想定。

### Rationale

- 「echo を UPSERT」「送信側を UPDATE + catch」の組み合わせは、`metaMessageId` UNIQUE という 1 つの DB 制約に冪等性の責任を集約できる。アプリケーション側の "lock" や時間窓ヒューリスティック (Q2 Option D) を持ち込まない。
- 送信側を最初から `mid` 取得後の単発 UPSERT に変えるアプローチ (TX1/TX2 統合) も検討したが、(a) Meta Send API 中の中断時に「pending 行が残らない」と UI 上のフェイルセーフが崩れる、(b) TX1 が短いことを利用した他フロー (`get-conversation.fn.ts` での pending 行の即時表示) が薄く依存している、ため温存する。
- `metaMessageId` UNIQUE は column-level なのでテナント横断。Meta の `mid` はグローバル一意 (Facebook Messaging Platform 仕様) で実用上問題は起きないが、`echo_send_attribution_recovered` 経路は同テナント内に閉じる WHERE を残し防御する。

### Alternatives considered

| 案 | 理由で却下 |
|---|---|
| `app_id` で fumireply 自送信を識別、自送信 echo は UPDATE 専用 (Q2 Option C) | Meta App ID は env 化が必要・Webhook 仕様変更で取得不能になるリスク・他テナントが同 App ID を共有する SaaS テナンシでは無効。 |
| 時間窓 N 秒以内の pending 行とマッチさせる (Q2 Option D) | 同一会話で同時送信が複数あるとマッチ崩れ。境界 N の決定が運用判断になり技術的に固められない。 |
| echo 側のみ INSERT 経路、自送信側は元のまま | Q2 のシナリオ (echo 先着) で 2 行残る。SC-002 違反。 |
| schema に `(tenant_id, meta_message_id)` 複合 UNIQUE を追加 | テナント横断の `mid` 衝突は仕様上起きないため複合 UNIQUE は無駄。マイグレーションコストが乗る。 |

---

## R2. 会話解決: `recipient.id` ベースの upsert

### 背景

inbound 経路は `webhook/src/handler.ts:140-155` で

```ts
const psid = event.sender.id  // 顧客 PSID
const [conv] = await tx.insert(conversations).values({ tenantId, pageId, customerPsid: psid })
  .onConflictDoUpdate({ target: [conversations.pageId, conversations.customerPsid], ... })
  .returning(...)
```

echo では `event.sender.id = PageID`、`event.recipient.id = 顧客 PSID`。同じ upsert を **`recipient.id` を使って** 呼ぶ必要がある。

### Decision

`processMessagingEvent` 内で `is_echo` 分岐の冒頭に **echo 用の PSID 抽出** を入れ、`upsertConversation(tx, tenantId, pageUuid, psid)` というヘルパ関数で inbound/echo の両方から呼ぶ。

```ts
if (is_echo) {
  const psid = event.recipient.id   // ← 顧客 PSID
  const conv = await upsertConversation(tx, tenantId, pageUuid, psid)
  const { messageType, body } = determineMessageType(msg)
  // ... UPSERT message ...
}
```

`upsertConversation` は現 inbound 経路の 12 行を関数化するだけ。挙動は完全に同じ。

### Rationale

- echo は新規顧客への外部送信もありうる (spec User Story 1 シナリオ 2)。事前に会話が存在することを前提にできない。
- inbound と同じ upsert を再利用することで `(pageId, customerPsid)` UNIQUE 制約に依存する挙動が一貫し、テストも対称になる。

### Alternatives considered

| 案 | 理由で却下 |
|---|---|
| 既存会話のみ対象 (新規顧客への外部送信 echo はスキップ) | spec FR-007 違反。シナリオ 2 に対応できない。 |
| `recipient.id` で会話を SELECT、見つからなければスキップ | 同上。 |

---

## R3. echo 経路で発火させない副作用の明示

### 背景

inbound 経路は `is_echo` 分岐の外で:
- `conversations.lastInboundAt / lastMessageAt / unreadCount` 更新
- 新規顧客なら Graph API で `customerName` 取得
- AI 下書きパイプライン用 SQS 送信 (`draft_enqueued`)
- Summary trigger (`maybeEnqueueSummaryJob`)
- stale-pending guard ロジック

を実行する。echo は **これらいずれも発火させない**。

### Decision

`is_echo` 分岐は self-contained に閉じる:

```ts
if (is_echo) {
  // 1. recipient PSID → conv upsert
  // 2. messages UPSERT
  // 3. 構造化ログ (INSERT/UPDATE 判別)
  // 4. return null
}
```

`processMessagingEvent` の戻り値を `null` のままにすることで、呼び出し元 (`handlePost` 内 350 行付近) の `if (result) { sqsClient.send(...); maybeEnqueueSummaryJob(...) }` をスキップさせる。

`lastMessageAt` を echo で更新するかは要検討:
- 更新する利点: 会話一覧の並び順が「最後に何かあった時刻」になる (= 外部送信も含む)
- 更新しない利点: inbound 経路と分離・テスト不要

→ **更新しない**: 現行 `lastMessageAt` は inbound と自送信 SendAPI 成功 (`send-reply.fn.ts:91`) でのみ進む。自送信 echo は SendAPI 成功時点で既に更新済み、外部送信 echo の `lastMessageAt` 反映は本機能スコープ外 (UI 一覧並び順は別 Issue で判断)。`messages.timestamp` には正しく入るので、スレッド内のメッセージ並びは正しい。

### Rationale

echo は「自分の送信が DB に着いた」だけのイベントで、AI 下書きの再生成や `customerName` 取得のような **顧客発話起因の処理** をトリガすべきではない (spec FR-009)。

### Alternatives considered

| 案 | 理由で却下 |
|---|---|
| echo でも `lastMessageAt` を更新 | 一覧並びの仕様変更が本機能スコープに乗ってしまう。 |
| echo でも `customerName` を取得 | 新規顧客への外部送信 echo は `recipient.id` が新 PSID で、`customerName` 未設定。取りに行く価値はあるが、本機能のスコープ外で次回 inbound 時に取得される。 |

---

## R4. 構造化ログイベント名

### Decision

| イベントキー | いつ | 含めるフィールド |
|---|---|---|
| `external_echo_ingested` | echo UPSERT で **INSERT** された (= xmax 0 / rows.length > 0) | `conversationId`, `mid`, `pageId`, `messageType`, `bodyLength`, `tsMs` |
| `self_echo_confirmed` | echo UPSERT で **UPDATE** された (= xmax != 0) | `conversationId`, `mid`, `pageId` |
| `echo_send_attribution_recovered` | send-reply の mid 書き戻しで UNIQUE 違反 → DELETE + 既存行 attribute | `conversationId`, `mid`, `droppedRowId`, `sentByAuthUid` |

INSERT/UPDATE 判別は drizzle の `onConflictDoUpdate().returning({ inserted: sql<boolean>\`(xmax = 0)\` })` で取得。

カスタムメトリクスは追加しない (Q4)。CloudWatch Logs Insights クエリ例は `quickstart.md` 参照。

### Rationale

- イベント名は動詞句で過去形を統一 (既存 `draft_enqueued`, `draft_persisted` と整合)。
- `bodyLength` で本文サイズの分布を観測 (テキスト送信か非テキストかも `messageType` で取れる)。本文そのものは PII / 個人情報を含むためログに出さない。
- `external_echo_ingested` を日次集計すれば SC-005「外部アプリ送信が出ない問い合わせ 0 件」の裏付け量を得られる (SC-006)。

---

## R5. テキスト/非テキスト echo の `body` 規約

### Decision

Q1 に従い:
- `messageType='text'`: `body = msg.text`
- それ以外 (`sticker` / `image` / `unknown`): `body = ''`、`messageType` のみ実タイプに設定

> **(009 で更新)**: 本節の「echo は添付を保存しない / inbound image は body に URL」という前提は
> specs/009-media-attachments で刷新された。判定は `classifyAttachments` に一本化され、
> inbound / echo とも body に URL を入れず、添付メディアは S3 保存 + `messages.attachments` JSONB
> 記録となった (`determineEchoMessageType` は廃止)。以下は 006 時点の記録として残す。

inbound 経路の `determineMessageType` (`handler.ts:101-110`) を **echo 経路でも流用** する。inbound 経路は `image` の場合 `body = att.payload?.url ?? ''` を採用しているが、echo 経路はあえてこれと揃えず `body=''` で統一する。

### Rationale

- Q1 の意思決定: 本文は空文字、UI は messageType から表示生成。
- inbound 画像経路と挙動が分かれるが、これは「外部 echo は添付 URL を Meta から取得しに行く責務を持たない」という設計判断。inbound 画像の URL は Graph API 経由で再取得可能だが、echo の image attachment URL は短命の可能性があり保存価値が低い。
- 別関数 `determineEchoMessageType` を切り出すか同関数で分岐させるかは実装裁量。テスト容易性で別関数推奨。

### Alternatives considered

| 案 | 理由で却下 |
|---|---|
| inbound と完全同一 (image なら URL を body に) | URL が短命で再取得不能、UI 表示価値が低い。 |
| 添付 JSON を body にシリアライズ | UI が文字列を JSON.parse する必要があり責務逸脱。 |
| 非テキスト echo はスキップ | スレッドが歯抜けになり Issue の主目的に反する。 |

---

## R6. `message_echoes` 購読の運用切替手順

### Decision

`docs/resume-webhook-bringup.md` の購読フィールド一覧に `message_echoes` を追記する (現在は `messages, messaging_postbacks`)。本機能リリースの順序は:

1. PR マージ → 本番デプロイ (echo を受け取っても新コードは未起動・受信時は単に UPSERT が動く)
2. Meta App 管理画面 (`developers.facebook.com`) で対象 App の Webhook 購読フィールドに `message_echoes` を追加・保存
3. 直後の `gh issue` 受け入れ条件を動作確認 (Messenger 公式アプリで送信 → fumireply スレッドに反映)

### Rationale

- 順序を「コード先行・購読後追加」にすることで、購読有効化前は echo イベントが届かないため挙動変化ゼロ。問題が起きた場合は購読を外せばロールバック可能 (= Q4 PR の revert より速い緊急回避)。
- `docs/resume-webhook-bringup.md` 自体は実運用手順書のため、更新と同時に Slack 連絡 / 運営者への通知が必要 (タスク内に含める)。

---

## R7. データモデル変更ゼロの確認

`messages` テーブル定義 (`schema.ts:103-131`) を再確認:

- `metaMessageId varchar(128) UNIQUE NULL`: UPSERT ターゲットとして必要十分
- `direction varchar(10) NOT NULL`: `'outbound'` リテラル直入れで OK
- `body text NOT NULL`: 空文字 `''` を保存することで NOT NULL を満たす
- `messageType varchar(20) NOT NULL DEFAULT 'text'`: 明示指定で OK
- `timestamp timestamp with TZ NOT NULL`: echo の `event.timestamp` (ms epoch) を `new Date()` で渡す
- `sendStatus varchar(20) NULL`: 'sent' リテラル
- `sentByAuthUid uuid NULL`: 外部送信は null、attribute 補正で fumireply uid を後付け
- index `messages_tenant_id_conversation_id_timestamp_idx`: 未返信バッチ判定の `MAX(timestamp) WHERE direction='outbound'` クエリ高速化に既に有効

→ **マイグレーション・列追加・index 追加すべて不要**。

---

## R8. テスト戦略

### Webhook (`webhook/src/handler.test.ts`)

新規追加するテストケース (既存形式 `processMessagingEvent` 単体 + 統合 `handlePost` 両方):

| # | 名称 | アサーション |
|---|---|---|
| 1 | echo 既存自送信 pending 行あり → UPDATE | 行数 1、`sendStatus='sent'`、`timestamp`/`body`/`sentByAuthUid` 元値維持、`event=self_echo_confirmed` ログ |
| 2 | echo 既存行なし → INSERT (テキスト) | 行 1 件追加、`direction='outbound'`、`sentByAuthUid=null`、`messageType='text'`、`body=テキスト`、`event=external_echo_ingested` |
| 3 | echo 既存行なし → INSERT (sticker) | 同上、`messageType='sticker'`、`body=''` |
| 4 | echo 既存行なし → INSERT (image) | 同上、`messageType='image'`、`body=''` |
| 5 | 同一 mid の echo 2 連発 | 1 件目 INSERT、2 件目 UPDATE (no-op)、最終行数 1 |
| 6 | echo の `recipient.id` が新規 PSID | `conversations` に行が 1 件追加され、その上に `messages` 1 件 |
| 7 | echo は SQS 送信を起動しない | `sqsClient.send` が呼ばれない |
| 8 | 未知 Page → skip (回帰) | DB 状態無変更 |

### App (`app/src/routes/(app)/threads/$id/-lib/send-reply.fn.test.ts`)

| # | 名称 | アサーション |
|---|---|---|
| 1 | echo 先着 → mid 書き戻し UNIQUE 違反 catch | tentative 行 DELETE、echo 行に `sentByAuthUid` 設定、戻り値の `message.id` が echo 行 ID、`event=echo_send_attribution_recovered` ログ |
| 2 | echo 未着 (通常) → mid 書き戻し成功 (回帰) | 既存挙動完全維持 |

### E2E (Playwright スモーク)

- 既存スレッドで自送信 → スレッドに 1 件のみ表示
- (mock echo INSERT) → スレッドに外部送信メッセージとして 1 件追加表示
- 全件並びは timestamp 昇順

---

## Open questions (Phase 1 で確認)

- drizzle `onConflictDoUpdate` の `RETURNING (xmax = 0)` サポート状況: 1 つの SQL で INSERT/UPDATE 判別が可能か、もしくは 2 段に分けて先 SELECT が必要か → Phase 1 contracts で型定義固める。最悪 `INSERT … ON CONFLICT DO NOTHING RETURNING id` で 0 行なら UPDATE 経路に分岐するパターンに切り替える (1 RTT 増えるが性能的に許容)。
