# Implementation Plan: 未返信メッセージのバッチ下書き生成

**Branch**: `004-batch-draft-unanswered` | **Date**: 2026-06-20 | **Spec**: [spec.md](./spec.md)
**Input**: Feature specification from `/specs/004-batch-draft-unanswered/spec.md`

## Summary

AI 下書きを「inbound メッセージ 1 件 = 下書き 1 件」から「**会話 1 件 = アクティブ下書き 1 件**」へ転換する。webhook の enqueue を **デバウンス遅延** 付きにし、ai-worker 側で「最新メッセージ起点でないジョブはスキップ」する coalesce 判定を入れることで、連投をちょうど 1 回の生成に集約する。生成時は「最後の outbound 以降の inbound テキスト」を**未返信バッチ**として抽出し、AI に「1 通で全件に答える」よう指示する。

**アーキテクチャ要点** (詳細は `research.md`):

- **DB スキーマ拡張**: `ai_drafts` に `conversation_id` を追加、`message_id` の UNIQUE を廃止し nullable 化、`status` の値域に `dismissed` / `superseded` を追加、partial unique index で「会話ごとアクティブ 1 件」を保証。新規テーブルなし。マイグレーション 1 本 (`0003_conversation_scoped_drafts.sql`)。
- **webhook (enqueue 経路)**: inbound テキスト受信時、(a) 会話のアクティブ下書きを `pending` に upsert (anchor = 当該メッセージ)、(b) `{ jobType:'draft', conversationId, triggerMessageId, triggerTimestamp, enqueuedAt }` を `DelaySeconds = DRAFT_DEBOUNCE_SECONDS` で enqueue。従来の「メッセージごと INSERT + `{ messageId }` enqueue」を置き換える。
- **ai-worker (`processDraftJob` の再設計)**: 入力を `conversationId` ベースに変更。
  1. conversationId → tenant 解決。
  2. 最新 inbound テキストを取得し、`triggerMessageId` が最新でなければ **skip** (coalesce)。
  3. 最後の outbound timestamp を境界に未返信バッチを抽出 (空なら下書きを `dismissed` にして終了)。
  4. 文脈履歴 (要約カーソル以降, 50 件) を取得 → 003 のプロンプト合成 + 未返信バッチ明示。
  5. Anthropic 呼び出し → 会話のアクティブ下書き行に ready/failed を書き込む。
- **プロンプト**: `prompt.ts` の `buildUserPrompt(history)` を `buildUserPrompt(history, unanswered)` に拡張。未返信メッセージを列挙し「1 通で全件に対応」と指示する節を追加。システムプロンプト合成 (BASE + additional + LANGUAGE_DIRECTIVE) は 003 のまま不変。
- **UI**: `get-conversation.fn.ts` の `latest_draft` 取得を「最新 inbound 紐付き」から「会話のアクティブ下書き」へ。`get-draft-status.fn.ts` の引数を messageId → conversationId へ。`send-reply` 成功後にアクティブ下書きを `dismissed` に。破棄用に薄い `dismiss-draft.fn.ts` を追加。ReplyForm / DraftBanner のポーリング鍵を conversationId に変更。
- **設定値**: `DRAFT_DEBOUNCE_SECONDS = 20`、`UNANSWERED_CAP = 30`、既存 `RECENT_MESSAGES_CAP = 50` を維持。webhook 側にも同名の遅延定数を持つ。
- **既存資産再利用**: `withTenant` (RLS)、`dbAdmin` (tenant 解決)、Anthropic client、SQS client、Drizzle。新規パッケージ・新規 Lambda・新規キューなし。

## Technical Context

**Language/Version**: TypeScript 5.x / Node.js 24.x (`nodejs24.x` Lambda)。001〜003 と同一。
**Package Manager**: npm (`app/package-lock.json`, `ai-worker/package-lock.json`, `webhook/package-lock.json`)。
**HTTP クライアント方針**: グローバル `fetch` のみ、axios 系の新規導入禁止。Anthropic SDK は内部 fetch のため OK。

**Primary Dependencies**: 既存のみ (`@tanstack/react-start`, `drizzle-orm`, `postgres`, `@anthropic-ai/sdk`, `@aws-sdk/client-sqs`, `@aws-sdk/client-ssm`, `zod`)。**新規パッケージなし**。

**Infrastructure**:
- 既存 Lambda 構成 (webhook / app / ai-worker / keep-alive) を維持。**新規 Lambda・新規 SQS キューなし**。
- 既存の draft SQS キューをそのまま使い、`SendMessageCommand` に `DelaySeconds` を付けるだけ。
- 新規 SSM / IAM / EventBridge は追加しない。

**Storage**: 既存 Supabase Postgres。マイグレーション 1 本 (`0003_conversation_scoped_drafts.sql`): `ai_drafts` への列追加 + 制約付け替え + データ移行 + partial unique index。RLS ポリシー変更なし (既存 `ai_drafts` の tenant_id RLS が新カラムも自動カバー)。

**Testing & CI**:
- vitest (ai-worker):
  - coalesce 判定 (最新メッセージ起点でないジョブをスキップ) のユニット
  - 未返信バッチ抽出 (`extractUnanswered(messages, lastOutboundTs)`) の純粋関数ユニット
  - 未返信バッチ空 → 下書き `dismissed` 経路
  - `buildUserPrompt(history, unanswered)` の合成 (未返信節が含まれ、文脈節と分離されていること)
  - 単発メッセージ回帰 (1 件でも従来同等の下書き)
- vitest (app):
  - `get-conversation` の latest_draft が会話アクティブ下書きを返す
  - `send-reply` / `dismiss-draft` がアクティブ下書きを消化済みにする
  - 「会話ごとアクティブ 1 件」制約の違反が DB で弾かれる (integration)
- 既存 `ai-worker/src/handler.test.ts` を会話スコープ前提に更新。
- Playwright E2E スモーク: 連投 3 通 → デバウンス後に 1 件の下書き → 3 件すべてに言及 → 送信 → 再読み込みで非再提示。

**Target Platform**: 001〜003 と同一 (AWS Lambda + API Gateway + SQS + S3/CloudFront / Supabase)。

**Project Type**: 既存 TanStack Start アプリ + webhook Lambda + ai-worker Lambda の機能改修。

**Performance Goals**:
- 連投 K 件あたりの Anthropic 呼び出しを 1〜2 回に集約 (SC-002)。
- デバウンスによる下書き表示遅延は最大 `DRAFT_DEBOUNCE_SECONDS` (20s) + 既存生成 p95。連投運用では「最後の 1 通から 20s 後にまとめて 1 件」を許容 UX とする。
- 既存単発フローの生成 p95 < 60s を維持。

**Constraints**:
- **マルチテナント安全性**: ai-worker は `dbAdmin` で tenant 解決後 `withTenant` 内で読み書き。app server fn は JWT から tenant 解決し `withTenant` で囲む。
- **冪等性**: SQS at-least-once 前提。coalesce 判定 + partial unique index + upsert で重複配信を吸収。
- **後方互換 (移行期)**: 旧 `{ messageId }` 形式の在庫ジョブが SQS に残っていても処理できるよう、ai-worker は messageId → conversationId 解決のレガシー経路を一時的に残す (data-model / contract 参照)。デプロイ後にレガシー経路は撤去予定。
- **外部送信非記録の既知限界**: 「最後の outbound」は DB の outbound 行に依存。外部送信取り込み (別 Issue) 未了の間は境界がずれうることを許容し、ログで観測する。

**Scale/Scope**:
- 追加・変更コード LOC 目安: ~500 行
  - マイグレーション 60 行 / schema.ts (app + ai-worker + webhook 同期) 30 行
  - webhook enqueue 改修 (upsert + DelaySeconds) 80 行
  - ai-worker `processDraftJob` 再設計 + coalesce + 未返信抽出 150 行
  - prompt.ts (未返信節) 40 行
  - app server fn (get-conversation / get-draft-status / send-reply / dismiss-draft) 90 行
  - テスト 50 行

## Constitution Check

*GATE: Phase 0 前にパス、Phase 1 設計後に再チェック。*

**プロジェクト憲法の状態**: `.specify/memory/constitution.md` 未ラティファイ。001〜003 同様、業界標準ゲートを暫定適用する。

| ゲート | 判定 | 根拠 |
|---|---|---|
| **YAGNI** | ✅ PASS | スコープは「連投の未返信バッチを 1 下書きに集約」に限定。外部送信取り込み・条件付き再生成・下書きバージョン履歴は明示的に除外 (FR-OOS-001〜003)。|
| **単一責任** | ✅ PASS | Story 1 (バッチ下書き) と Story 2 (送信/破棄ライフサイクル) は独立にテスト可能。下書きスコープ転換という単一の関心に閉じる。|
| **テスト可能性** | ✅ PASS | coalesce 判定・未返信バッチ抽出・プロンプト合成を純粋関数として切り出し unit test。DB 制約 (アクティブ 1 件) は integration。|
| **シンプル優先** | ✅ PASS | 新規 Lambda・新規キュー・新規 SSM ゼロ。既存 SQS に `DelaySeconds` を付けるだけ。スキーマは `ai_drafts` 1 テーブルの列追加 + index。|
| **観測性** | ✅ PASS | `draft_enqueued` / `draft_superseded`(coalesce skip) / `draft_no_unanswered` / `draft_batch_composed`(未返信件数 + 文脈件数) / `draft_persisted` を構造化ログに出す。集約率を計測可能。|
| **可逆性** | ✅ PASS | 列追加 + index 追加のみで、ロールバック SQL を data-model に用意。デバウンス秒数・各 CAP は env / 定数で調整可能。最悪時は `DRAFT_DEBOUNCE_SECONDS=0` で即時生成に戻せる。|

**複雑性の正当化**: 不要。分散構成・新規非同期パターンは追加しない (既存 SQS の DelaySeconds 利用のみ)。

**Phase 1 設計後の再チェック (2026-06-20)**: 全 6 ゲート PASS 維持。data-model 確定で新規テーブル・新規 RLS ゼロを再確認。contract で SQS メッセージ契約・ライフサイクル状態遷移・プロンプト合成差分を明示。

## Project Structure

### Documentation (this feature)

```text
specs/004-batch-draft-unanswered/
├── spec.md                 # 仕様書
├── plan.md                 # 本ファイル
├── research.md             # Phase 0 (デバウンス方式・coalesce 方式・スコープ転換の根拠)
├── data-model.md           # Phase 1 (ai_drafts 列追加 + 制約 + データ移行 + index)
├── quickstart.md           # Phase 1 (ローカル検証手順・デバウンスの動作確認)
├── contracts/
│   └── draft-pipeline.md   # SQS メッセージ契約 + ai_drafts ライフサイクル + プロンプト合成差分 + server fn 差分
└── checklists/
    └── requirements.md     # 品質チェックリスト
```

### Source Code (変更/追加ファイル中心)

```text
webhook/                                   # 受信 + enqueue Lambda
├── src/
│   ├── handler.ts                         # MODIFY: inbound テキスト時に (a) 会話アクティブ下書きを pending upsert、(b) DelaySeconds 付き conversationId ジョブを enqueue
│   ├── config.ts (新規 or 既存)            # MODIFY/NEW: DRAFT_DEBOUNCE_SECONDS
│   └── db/schema.ts                       # MODIFY: ai_drafts スキーマ同期 (conversation_id 等)

ai-worker/                                 # 生成 Lambda
├── src/
│   ├── handler.ts                         # MODIFY: processDraftJob を conversationId ベースに再設計 (coalesce + 未返信抽出 + 会話アクティブ下書きへ書込)。レガシー { messageId } 解決経路を一時併設
│   ├── prompt.ts                          # MODIFY: buildUserPrompt(history, unanswered) に拡張、未返信節を追加
│   ├── config.ts                          # MODIFY: UNANSWERED_CAP 追加 (RECENT_MESSAGES_CAP は維持)
│   └── db/schema.ts                       # MODIFY: ai_drafts スキーマ同期
└── tests/
    ├── handler.test.ts                    # MODIFY: 会話スコープ前提・coalesce・未返信空経路
    └── unanswered.test.ts (NEW)           # NEW: extractUnanswered / buildUserPrompt のユニット

app/
├── src/
│   ├── routes/(app)/threads/$id/
│   │   ├── -lib/
│   │   │   ├── get-conversation.fn.ts     # MODIFY: latest_draft を会話アクティブ下書きから取得
│   │   │   ├── get-draft-status.fn.ts     # MODIFY: 引数 messageId → conversationId
│   │   │   ├── send-reply.server.ts       # MODIFY: 送信成功後にアクティブ下書きを dismissed に
│   │   │   └── dismiss-draft.fn.ts (NEW)  # NEW: 破棄でアクティブ下書きを dismissed にする server fn
│   │   └── -components/
│   │       ├── ReplyForm.tsx              # MODIFY: 破棄ハンドラで dismiss-draft を呼ぶ / draft の取得鍵を conversationId に
│   │       └── DraftBanner.tsx            # MODIFY: pending ポーリングを conversationId 基準に
│   └── server/db/schema.ts                # MODIFY: ai_drafts 列追加 + index
└── src/server/db/migrations/
    └── 0003_conversation_scoped_drafts.sql # NEW
```

**Structure Decision**: webhook (enqueue) と ai-worker (生成) と app (表示/送信) の 3 箇所に最小増分で改修を入れる。中核は `ai_drafts` の会話スコープ化 1 点で、それに合わせて enqueue・worker・UI 取得経路を会話単位に揃える。新規インフラ・新規パッケージはゼロ。

## Complexity Tracking

> 不要 (Constitution Check で違反なし)。
