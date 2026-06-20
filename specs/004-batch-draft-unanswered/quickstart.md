# Quickstart: 未返信メッセージのバッチ下書き生成

**Feature**: `004-batch-draft-unanswered`
**前提**: 003 (会話コンテキスト永続化) がデプロイ済み。ローカル開発環境は 001〜003 と同一。

本機能は新規インフラを追加しない。003 からの差分は **DB マイグレーション 1 本** と **既存 SQS への DelaySeconds 付与** のみ。

---

## 1. セットアップ差分 (vs 003)

| 項目 | 変更 |
|---|---|
| DB マイグレーション | `0003_conversation_scoped_drafts.sql` を 1 本追加 (ai_drafts の会話スコープ化) |
| SQS キュー | **追加なし**。既存 draft キューに `DelaySeconds` を付けるのみ |
| SSM / IAM / EventBridge | **追加なし** |
| env / 定数 | `DRAFT_DEBOUNCE_SECONDS` (既定 20)、`UNANSWERED_CAP` (既定 30)。webhook と ai-worker で参照 |
| 新規パッケージ | なし |

---

## 2. マイグレーション適用

```bash
cd app
# Drizzle のマイグレーション生成/適用フロー (001〜003 と同一手順)
npm run db:migrate   # 0003_conversation_scoped_drafts.sql を適用
```

適用後の確認:

```sql
-- conversation_id 列と partial unique index が存在するか
\d ai_drafts
-- → ai_drafts_active_per_conversation (conversation_id) WHERE status IN ('pending','ready')
```

---

## 3. ローカルでの動作確認

### 連投の集約 (Story 1)

1. ローカルで会話を 1 件用意し、inbound テキストを 3 通、数秒以内に投入する (webhook を直接叩く / シードスクリプト)。
2. ai-worker のログを観察:
   - 先行 2 ジョブ: `event: 'draft_superseded'`
   - 最終 1 ジョブ: `event: 'draft_batch_composed'` (`unanswered_count: 3`) → `draft_persisted`
3. `ai_drafts` を確認: その会話に **active 行が 1 件** のみ、`body` が 3 件すべてに言及。

```sql
SELECT conversation_id, status, left(body, 80)
FROM ai_drafts
WHERE conversation_id = '<id>' AND status IN ('pending','ready');
-- 1 行のみ
```

### 空バッチ (運営者が先に返信)

1. inbound 1 通 → デバウンス待機中に outbound を送信。
2. ログ: `event: 'draft_no_unanswered'`、下書きは `dismissed`。

### 送信/破棄後の非再提示 (Story 2)

1. ready 下書きを送信 → 画面再読み込み。
2. `latest_draft` が null (再提示されない)。`ai_drafts` の該当行が `dismissed`。

### デバウンス無効化 (退避)

即時生成に戻したい場合:

```bash
DRAFT_DEBOUNCE_SECONDS=0   # webhook の enqueue が遅延なしになる
```

---

## 4. 確認用クエリ集

```sql
-- 会話のアクティブ下書き
SELECT * FROM ai_drafts
WHERE conversation_id = $1 AND status IN ('pending','ready');

-- 未返信バッチの境界 (最後の outbound)
SELECT MAX(timestamp) FROM messages
WHERE conversation_id = $1 AND direction = 'outbound';

-- 未返信バッチ
SELECT body, timestamp FROM messages
WHERE conversation_id = $1 AND direction='inbound' AND message_type='text'
  AND timestamp > COALESCE((SELECT MAX(timestamp) FROM messages
      WHERE conversation_id=$1 AND direction='outbound'), '1970-01-01'::timestamptz)
ORDER BY timestamp ASC;
```

---

## 5. 既知の限界 (本フェーズ)

- **外部送信は境界に反映されない**: 運営者が Messenger アプリ等から返信した場合、その返信は DB に記録されず (`message_echoes` 未購読)、未返信バッチに混入しうる。**外部送信取り込み Issue** の解決で完全になる。それまでは fumireply 経由の送信を前提とする。
- **デバウンス遅延**: 単発でも最大 `DRAFT_DEBOUNCE_SECONDS` の表示遅延。連投品質を優先した意図的トレードオフ。
