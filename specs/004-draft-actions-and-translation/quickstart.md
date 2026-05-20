# Quickstart: spec 004 ローカル開発セットアップ

**Branch**: `004-draft-actions-and-translation` | **Date**: 2026-05-20

spec 003 までの開発環境が動いている前提で、004 の追加で必要な作業のみを記す。

## 0. 前提

- spec 003 がローカルでマージ済み（DB マイグレーション 0002 までが適用済み）
- `app/` で `npm run dev` が立ち上がる状態
- `ai-worker/` のローカル実行（LocalStack or SQS 接続）が動く状態

## 1. DeepL Free API キーの取得（5 分）

1. https://www.deepl.com/pro-api?cta=header-pro-api/ にアクセス
2. 「Free」プランで無料アカウントを作成（クレジットカード登録あり、月 50 万文字までは課金なし）
3. アカウントダッシュボードで API キーをコピー（形式: `<UUID>:fx`）

> 注: Free プランでも CC 登録が必須。チーム共有用の Free アカウントを 1 つ用意する運用を想定。Pro 切替は spec 005 以降。

## 2. ローカル env 設定

`app/.env.local` および `ai-worker/.env.local` に追加:

```env
DEEPL_API_KEY=xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx:fx
```

> 本番（review / prod env）では SSM Parameter Store 経由になるが、ローカルでは env で直接読む（spec 003 の Anthropic API キーと同じ運用）。

ai-worker の env loader が SSM パス（`DEEPL_API_KEY_SSM_PATH`）よりも env (`DEEPL_API_KEY`) を優先するロジックは spec 003 と同じパターンで実装する。

## 3. DB マイグレーション 0003 適用

```
cd app
npm run db:migrate
```

確認:

```sql
-- tenants に translation_enabled が存在し、デフォルト false
SELECT column_name, data_type, column_default
FROM information_schema.columns
WHERE table_name = 'tenants' AND column_name = 'translation_enabled';

-- ai_drafts に 3 列追加されている
SELECT column_name, data_type, column_default
FROM information_schema.columns
WHERE table_name = 'ai_drafts'
  AND column_name IN ('lifecycle_status', 'translation_ja', 'translation_status');

-- CHECK 制約 2 本
SELECT constraint_name, check_clause
FROM information_schema.check_constraints
WHERE constraint_name LIKE 'ai_drafts_%_values';

-- partial unique index
SELECT indexname, indexdef FROM pg_indexes WHERE indexname = 'ai_drafts_message_id_active_unique';

-- 既存行が全部 active になっている
SELECT lifecycle_status, COUNT(*) FROM ai_drafts GROUP BY lifecycle_status;
-- → 'active' のみが出るはず
```

## 4. 動作確認

### 4a. 破棄

1. `npm run dev` → ログイン → 任意のスレッドで draft 待ち
2. draft が表示された後、「破棄」ボタンを押下
3. UI から draft 表示が即座に消える
4. DB 確認: `SELECT id, lifecycle_status FROM ai_drafts ORDER BY created_at DESC LIMIT 1` → `discarded`

### 4b. 再生成

1. draft が表示されている状態で「再生成」ボタン押下
2. UI が「生成中」表示に切り替わる
3. 数秒〜十数秒で新 draft が表示される
4. DB 確認: 同じ message_id に対し 2 行存在、旧が `superseded`、新が `active` + `status='ready'`

### 4c. 翻訳 ON

1. `/settings` を開き、「ドラフトの日本語訳を表示」をオン
2. AutoSaveBadge で「保存しました」が出ることを確認
3. 顧客から新着メッセージを送る or 既存 draft の再生成を実行
4. draft 表示エリアに英語本文と並んで日本語訳が表示される
5. DB 確認: `SELECT translation_ja, translation_status FROM ai_drafts ORDER BY created_at DESC LIMIT 1` → `'...日本語...'`, `'ok'`

### 4d. 翻訳 OFF → 過去翻訳は非表示

1. 4c の続きで `/settings` のトグルを OFF に戻す
2. 同じスレッドをリロード → 既存 draft の和訳が UI に出ないことを確認
3. DB 確認: `translation_ja` カラムは依然として値が入っている（消えない）

### 4e. 翻訳失敗の表示

1. ai-worker の env で `DEEPL_API_KEY` を不正値に書き換え（例: `invalid:fx`）→ ai-worker 再起動
2. 翻訳 ON 状態で新規 draft を生成
3. draft 本文は通常通り表示、和訳欄に「取得失敗」相当のバッジ
4. DB: `translation_status='failed'`、`translation_ja=NULL`

## 5. テスト実行

```
cd app
npm run typecheck
npm run lint
npm run test -- discard-draft regenerate-draft conversation-status-filter translation-toggle
npm run test:e2e -- draft-actions
```

```
cd ../ai-worker
npm test -- translation
```

## 6. 既知の制約

- DeepL Free は **PC ブラウザ運用想定の英語ドラフトに対し日本語訳を出す内部表示**。顧客への送信文は常に元の英語本文（FR の Assumptions と整合）
- 翻訳結果のキャッシュは「draft レコードと 1:1」なので、再生成で新 draft 行ができれば必ず新規翻訳が走る
- 月 500,000 文字の上限到達後は `translation_status='failed'` で縮退、運用者が DeepL のダッシュボードで残量を確認する。アラート連携は本 spec のスコープ外
- spec 004 はオーナーロール権限のチェックを既存 middleware に委ねる。読み取り専用ユーザーには破棄・再生成ボタンを表示しないが、表示制御の権限フックは spec 003 までで決まったパターンを踏襲（明示的に追加実装しない）

## 7. デプロイ前チェック

- [ ] Terraform で SSM Parameter `/fumireply/review/deepl_api_key` が作成されている
- [ ] ai-worker IAM ロールに `ssm:GetParameter` の追加 ARN が含まれる
- [ ] ai-worker の env var `DEEPL_API_KEY_SSM_PATH` がデプロイ済み
- [ ] DB マイグレーション 0003 が本番 DB に適用済み
- [ ] 既存 ai-worker テストが全部 green（翻訳分岐追加で既存テストが壊れていない）
