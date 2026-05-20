# Quickstart — 003 Customer Context & Settings

**Branch**: `003-customer-context-and-settings`
**Predecessors**: 001 (MVP インフラ) と 002 (Connect Page + i18n) が既にデプロイ済みであること。

本機能は新規 Lambda・新規 SSM・新規 IAM ロール・新規テーブルを必要としない。**変更箇所は最小**で、ローカル開発手順も既存 (001/002) の延長で済む。

---

## 1. 前提

001/002 のローカル開発が動作する状態。具体的には:

- `app/` が `npm run dev` で起動する
- `ai-worker/` が `npm test` でグリーン
- Supabase ローカル DB に 001/002 のマイグレーションが適用済
- `.env` に既存の `ANTHROPIC_API_KEY_SSM_KEY`, `DATABASE_URL`, `SUPABASE_*` が設定済

未設定なら 001/002 の quickstart を先に実行する。

---

## 2. DB マイグレーション

```bash
cd app
# Drizzle で 0002_customer_context.sql を生成 (または手動で作成)
npm run db:generate
# 確認: app/src/server/db/migrations/0002_customer_context.sql が作られている
npm run db:migrate
```

確認クエリ (Supabase Studio または psql で):

```sql
-- 新規列が追加されていること
SELECT column_name, data_type
FROM information_schema.columns
WHERE table_name = 'conversations'
  AND column_name IN ('summary', 'last_summarized_at', 'tone_preset', 'custom_prompt', 'note');

SELECT column_name, data_type
FROM information_schema.columns
WHERE table_name = 'connected_pages'
  AND column_name = 'custom_prompt';

-- CHECK 制約が効くこと
INSERT INTO conversations (id, tenant_id, page_id, customer_psid, tone_preset)
VALUES (gen_random_uuid(), 'YOUR_TENANT_ID', 'YOUR_PAGE_ID', 'test-psid', 'invalid_tone');
-- → ERROR: check constraint "conversations_tone_preset_values" が拒否すること
```

---

## 3. ローカルでの要約パイプライン (Lambda 起動なし)

ローカル開発では SQS を立てない。代わりに以下のいずれか:

### オプション A: 単体テストで完結 (推奨)

`ai-worker/src/summary.test.ts` を vitest で実行。Anthropic SDK は `vi.mock` でモックされるので外部 API 呼び出しは発生しない。

```bash
cd ai-worker
npm test -- summary.test.ts
```

### オプション B: 手動で summary を発火

開発時に SQS なしで要約パイプラインを試したい場合、`app/src/server/services/summary-trigger.ts` の `maybeEnqueueSummaryJob` 内で `process.env.NODE_ENV === 'development'` かつ `AI_SUMMARY_QUEUE_URL` が未設定なら、`ai-worker` の `processSummaryJob` をその場で直接呼ぶ in-process フォールバック経路を用意する (実装時に追加。production では絶対に呼ばない)。

スイッチは `AI_SUMMARY_QUEUE_URL` の有無のみ。`.env` に `AI_SUMMARY_QUEUE_URL=` (空) を入れてローカルでテスト。

---

## 4. ローカル UI 確認

```bash
cd app
npm run dev
```

### 確認手順

1. ログイン (既存 auth フロー)
2. サイドバーの「Settings」リンクが `/settings` に遷移すること (旧 `href='#'` は撤廃)
3. Settings 画面で接続済ページ一覧が表示され、各ページのカスタムプロンプト textarea が出ること
4. テキストを入力 → debounce 500ms 後に AutoSaveBadge が「保存中」→「保存済」に変化すること
5. `/inbox` → 任意のスレッドを開く → 右カラム CustomerPanel が表示されること (デスクトップ幅)
6. CustomerPanel でトーンを切り替え、カスタム指示・内部メモを編集 → 自動保存されること
7. (要約発火確認) `psql` で対象会話の messages テーブルに合計 2,000 文字超の test メッセージを INSERT → ai-worker のテスト相当の処理を手動で起動 → `conversations.summary` と `last_summarized_at` が更新されること

### i18n 確認

- 言語トグル (002 で追加された LanguageToggle) で en/ja を切替
- Settings / CustomerPanel の各文字列が翻訳されること
- `app/messages/en.json` / `ja.json` に追加した約 25 キーがすべて表示されていること

---

## 5. Terraform プラン (本番デプロイ前)

```bash
cd terraform/envs/review
terraform init
terraform plan
```

期待される差分:

```
# 新規リソース
+ module.ai_summary_queue.aws_sqs_queue.main
+ module.ai_summary_queue.aws_sqs_queue.dlq          # ai-summary-dlq
+ aws_lambda_event_source_mapping.ai_summary_source

# 変更リソース
~ module.ai_worker_lambda.aws_iam_role_policy.main   # SQS receive 権限に新キュー追加
~ module.ai_worker_lambda.aws_lambda_function.main   # 環境変数 AI_SUMMARY_QUEUE_URL / SUMMARY_PIPELINE_ENABLED 追加
~ module.app_lambda.aws_lambda_function.main          # 環境変数 AI_SUMMARY_QUEUE_URL / SUMMARY_TRIGGER_THRESHOLD_CHARS 追加
~ module.app_lambda.aws_iam_role_policy.main          # SQS send 権限に新キュー追加
```

新規 Lambda・新規 SSM パラメータが**ゼロ**であること、既存 4 Lambda 関数本体の差分は環境変数追加のみであることを確認する。

---

## 6. デプロイ手順 (本番)

1. PR をマージ
2. CI で:
   - `app/` と `ai-worker/` の vitest がグリーン
   - `app/` の Playwright E2E (customer-context.spec.ts) がグリーン
   - `terraform plan` の差分が上記期待値に一致
3. `terraform apply` を本番 (review env) に適用 — マイグレーションは自動 (デプロイ pipeline の中で `db:migrate` が走る、既存パターン)
4. デプロイ後の smoke:
   - `/settings` に到達できる
   - 任意のスレッドで CustomerPanel が表示される
   - 新着 inbound 後に AI ドラフトが生成され、ログに `draft_prompt_composed` イベントが出る
   - 既存会話に追加 INSERT して 2,000 文字超 → ログに `summary_started` → `summary_completed` が出る

### ロールバック

問題発生時:

1. **要約のみ無効化**: ai-worker と app-lambda の env `SUMMARY_PIPELINE_ENABLED=false` を Terraform で更新して `apply`。SQS 経路は残るが summary job は no-op で消費される。draft 経路は影響なし
2. **完全ロールバック**: 前バージョンの Lambda image にロールバック → DB マイグレーションを手動逆行 (data-model.md のロールバック SQL 参照)。追加列は NULL のみのため安全に DROP できる

---

## 7. 開発時の Tips

- `connected_pages.custom_prompt` を mock の defaultValue (`mock/design_handoff_tcg_cs_system/other-screens.jsx:249-255`) と同じ内容で投入すると、AI ドラフトの挙動変化を確認しやすい
- `conversations.tone_preset = 'concise'` + custom_prompt = "絵文字なし" を 1 会話に入れ、同じ inbound に対して enum を切り替えながら何度かドラフトを再生成して品質を体感する (Anthropic キャッシュにより 2 回目以降は安く検証できる)
- `note` カラムに何を書いても AI ドラフトに影響しないことを目視確認する (R-008 の設計を運用で再確認)

---

## 8. 既知の制約 / 次フェーズ送り

- 要約への手動操作 (再生成・クリア) なし (FR-OOS-006)
- PII 構造化保存・Wise/PayPal 連携・統計/タグ/購入履歴 (FR-OOS-001 / 002 / 003)
- CustomerPanel のレスポンシブは「狭幅で非表示 + トグル」の最低限のみ
- 要約閾値 2,000 文字は env で調整可能 (`SUMMARY_TRIGGER_THRESHOLD_CHARS`)。本番運用後の最初の 2 週間で生成頻度と品質を観察し、必要に応じてチューニング
