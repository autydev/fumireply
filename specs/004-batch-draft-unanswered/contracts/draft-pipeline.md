# Contract: 下書きパイプライン (会話スコープ + デバウンス)

**Feature**: 未返信メッセージのバッチ下書き生成
**Branch**: `004-batch-draft-unanswered`
**Date**: 2026-06-20

webhook (enqueue) → SQS → ai-worker (生成) → app (表示/送信) の契約。003 からの差分のみを規定する。

---

## 1. SQS メッセージ契約 (draft job)

### 新形式 (会話スコープ)

```jsonc
{
  "jobType": "draft",
  "conversationId": "<uuid>",        // 必須: 生成対象の会話
  "triggerMessageId": "<uuid>",      // 必須: このジョブを起こした inbound メッセージ (coalesce 判定用)
  "triggerTimestamp": "<iso8601>",   // 任意: triggerMessage の timestamp (ログ/補助判定)
  "enqueuedAt": "<iso8601>"          // 任意: 観測用
}
```

**送信パラメータ**: `SendMessageCommand` に `DelaySeconds: DRAFT_DEBOUNCE_SECONDS` (初期 20, 範囲 0〜900) を付与する。

### レガシー形式 (移行期のみ受理)

```jsonc
{ "messageId": "<uuid>" }            // または { "jobType": "draft", "messageId": "<uuid>" }
```

ai-worker は受信時、`conversationId` が無く `messageId` がある場合のみ、`messageId → conversationId` を解決し `triggerMessageId = messageId` として新経路に合流させる。**キュー消化後、後続 PR で撤去予定**。

---

## 2. webhook enqueue 契約 (差分)

inbound **テキスト**メッセージを受信し `messages` に INSERT した後:

1. **アクティブ下書きを pending に upsert** (会話単位。`ai_drafts_active_per_conversation` をターゲット):
   - 既存アクティブあり → `status='pending'`, `message_id=<当該>`, `updated_at=now()`
   - なし → 新規 INSERT (`status='pending'`, `conversation_id`, `message_id`, `tenant_id`)
2. **draft job を DelaySeconds 付きで enqueue** (新形式)。

**非テキスト** (image/sticker/unknown) は従来同様、下書きジョブを起こさない。ただしアクティブ下書きが既にあれば触らない (直前テキストのバッチを温存)。

**変更前との差分**: 「メッセージごとに pending 行を INSERT + `{ messageId }` を即時 enqueue」→「会話アクティブ下書きを upsert + 会話ジョブを遅延 enqueue」。

---

## 3. ai-worker `processDraftJob` 契約 (再設計)

入力: `{ conversationId, triggerMessageId, ... }` (レガシーは解決後に合流)。

**手順** (すべて `dbAdmin` で tenant 解決 → `withTenant` 内):

1. **tenant 解決**: `conversationId` から `tenant_id` を引く。会話が無ければ `event: 'conversation_not_found'` で return。
2. **coalesce 判定**: 会話の最新 inbound テキストメッセージ `L` を取得。`L.id !== triggerMessageId` なら **skip** (`event: 'draft_superseded'`)。後続ジョブが最終バッチを処理する。
3. **未返信バッチ抽出**:
   - `lastOutboundTs = MAX(messages.timestamp WHERE direction='outbound')`
   - `unanswered = inbound テキスト WHERE timestamp > lastOutboundTs, ASC, LIMIT UNANSWERED_CAP`
   - `unanswered` が空 → アクティブ下書きを `dismissed` にして return (`event: 'draft_no_unanswered'`)。
4. **文脈取得** (003 踏襲): 要約カーソル以降の text 履歴 (`RECENT_MESSAGES_CAP=50`) + 会話設定 (page_prompt / tone / customer_prompt / summary)。
5. **プロンプト合成**: システムブロックは 003 のまま (`BASE` + `buildAdditionalSystemPrompt(...)` + `LANGUAGE_DIRECTIVE`)。ユーザープロンプトは `buildUserPrompt(history, unanswered)` (§4)。
6. **Anthropic 呼び出し**: `callAnthropicWithRetry` を不変で利用 (DB トランザクション外)。
7. **書込**: 会話のアクティブ下書き (`WHERE conversation_id=$1 AND status='pending'`) を `ready` / `failed` に更新。

**冪等性**: 2 の coalesce skip + partial unique index + upsert により、SQS at-least-once / 順不同でも「最新起点ジョブのみが 1 件生成」を保証する。

**構造化ログ (イベント名)**:
| event | 意味 |
|---|---|
| `draft_enqueued` | webhook が遅延ジョブを積んだ (conversationId, delaySeconds) |
| `draft_superseded` | coalesce skip (より新しい inbound が存在) |
| `draft_no_unanswered` | 未返信バッチが空、下書きを dismissed |
| `draft_batch_composed` | 生成実行 (unanswered_count, history_count, 各 prompt present フラグ) |
| `draft_persisted` | ready/failed を書込 (status, latencyMs) |

---

## 4. プロンプト合成差分 (`prompt.ts`)

**システムプロンプト**: 003 から**変更なし** (`BASE_SYSTEM_PROMPT` + `buildAdditionalSystemPrompt({ pagePrompt, tonePreset, customerPrompt, summary })` + `LANGUAGE_DIRECTIVE`)。

**ユーザープロンプト**: `buildUserPrompt(history)` → `buildUserPrompt(history, unanswered)` に拡張。

構成:
1. **会話履歴 (文脈)**: 従来通り `history` を direction 付きでレンダリング。
2. **未返信メッセージ (回答対象)**: `unanswered` を箇条書きで列挙し、明示の指示を付す。

未返信節のテンプレ (英語固定・既存方針に一致):

```
## Unanswered customer messages (reply to ALL of these in ONE message)
The customer sent the following messages since your last reply. Write a single
reply that addresses every point below — do not answer only the last message.
- <unanswered[0].body>
- <unanswered[1].body>
- ...
```

`unanswered` が 1 件のみのときも同じ構造で出す (単発回帰: 従来と実質同等の出力)。`unanswered` が `history` と重複する分は、文脈節での重複表示を許容する (役割が異なるため二重でも害が小さい)。実装で重複を抑える場合は、文脈節から未返信分を除く形にしてもよい (テストで出力安定性を固定)。

---

## 5. app server fn 契約 (差分)

### `get-conversation.fn.ts` (MODIFY)
- `latest_draft` の取得元を「最新 inbound メッセージ紐付き下書き」→「会話のアクティブ下書き」へ:
  ```sql
  SELECT status, body FROM ai_drafts
  WHERE conversation_id = $1 AND status IN ('pending','ready')
  ORDER BY created_at DESC LIMIT 1;
  ```
- 返却フィールド形 (`{ status, body } | null`) は維持。

### `get-draft-status.fn.ts` (MODIFY)
- 入力を `{ messageId }` → `{ conversationId }` に変更。
- アクティブ下書きの `status` / `body` を返す。pending → ready のポーリングに使う。

### `send-reply.server.ts` (MODIFY)
- 送信成功 (Meta API OK + outbound 行確定) の後、同一トランザクションまたは直後に、会話のアクティブ下書きを `dismissed` にする:
  ```sql
  UPDATE ai_drafts SET status='dismissed', updated_at=now()
  WHERE conversation_id = $1 AND status IN ('pending','ready');
  ```
- これにより loader 再実行で送信済み下書きが再提示されない (FR-030, SC-004)。

### `dismiss-draft.fn.ts` (NEW)
- 入力: `{ conversationId }`。`authMiddleware` + `withTenant`。
- 会話のアクティブ下書きを `dismissed` に。破棄ボタンから呼ぶ (FR-031)。
- 冪等 (アクティブが無ければ no-op)。

---

## 6. UI 契約 (差分)

- **ReplyForm**: 破棄ハンドラを「ローカル state クリアのみ」→「`dismiss-draft.fn` 呼び出し + ローカルクリア + invalidate」に。draft 取得鍵を conversationId に。
- **DraftBanner**: pending ポーリングを `getDraftStatusFn({ conversationId })` に変更。最大ポーリング時間 (既存 60s) は、デバウンス (最大 20s) + 生成 p95 を見込み据え置き〜微増を検討。
- 連投時の体感: 「最後のメッセージから最大 `DRAFT_DEBOUNCE_SECONDS` 後にまとめて 1 件 pending → ready」。バナー文言で「まとめて下書きを作成中」を示すことを推奨 (任意)。

---

## 7. テスト契約

- **coalesce**: 3 件連投シナリオで、先行 2 件のジョブが `draft_superseded`、最終 1 件のみ生成。
- **未返信抽出**: `extractUnanswered(messages, lastOutboundTs)` が境界・ASC・CAP を満たす純粋関数テスト。
- **空バッチ**: 全 inbound が最後の outbound より古いとき `draft_no_unanswered` + `dismissed`。
- **プロンプト**: `buildUserPrompt(history, unanswered)` に未返信節が含まれ、複数件が列挙される。
- **回帰**: 単発 1 件で従来同等の下書き (SC-003)。
- **DB 制約**: 同一会話に 2 件目の active を作ろうとすると partial unique index で失敗 (integration, SC-005)。
- **送信/破棄**: `send-reply` / `dismiss-draft` 後にアクティブ下書きが `dismissed` (SC-004)。
- **レガシー**: 旧 `{ messageId }` ジョブが新経路に正しく合流する。
