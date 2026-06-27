# Implementation Plan: AI 下書きの条件付き再生成 (ワンオフ指示)

**Branch**: `005-draft-regenerate-oneoff` | **Date**: 2026-06-23 | **Spec**: [spec.md](./spec.md)
**Input**: Feature specification from `/specs/005-draft-regenerate-oneoff/spec.md`

## Summary

#004 で確立された「会話 = アクティブ下書き 1 件」モデルの上に、運営者が **その回限りの追加指示 (ワンオフ指示)** を付けて再生成できる経路を被せる。下書きエンティティの構造は変えない。

**アーキテクチャ要点** (詳細は `research.md` / `contracts/`):

- **新しい入口は server fn 1 本**: `regenerate-draft.fn.ts` (`{ conversationId, instruction? }`) が会話のアクティブ下書きを `pending` に戻し、`{ jobType:'draft', triggerType:'regenerate', conversationId, instruction? }` を **既存の draft SQS キューに `DelaySeconds=0` で即時 enqueue** する。
- **app に SQS publish 経路を追加** (#004 までは webhook のみが publish): `app/src/server/services/sqs.ts` を新設、`@aws-sdk/client-sqs` を app に追加、`SQS_QUEUE_URL` / `AWS_REGION` を app env に追加、app Lambda IAM に `sqs:SendMessage` を付与。
- **ai-worker `processDraftJob` を最小拡張**: SQS payload に `triggerType?: 'regenerate'` と `instruction?: string` を追加。`triggerType==='regenerate'` のときは (a) coalesce 判定をスキップ (運営者の明示意図は常に走らせる)、(b) **失敗時は `status='ready'` のまま `error` 列を埋めて旧本文を保持** (auto-batch 経路はこれまで通り `failed`)。
- **プロンプト合成にワンオフ層を追加**: 003 の `BASE + additional + LANGUAGE_DIRECTIVE` を `BASE + additional + OPERATOR_INSTRUCTION + LANGUAGE_DIRECTIVE` に拡張。ワンオフ指示は LANGUAGE_DIRECTIVE 直前に置き、`custom_prompt` / tone / page_prompt / summary より優先される最後段コンテンツ指示として作用する (LANGUAGE_DIRECTIVE は変更しない)。
- **同時実行抑制**: 再生成中の自動バッチ抑制は **`ai_drafts.status='pending'` の存在チェックを webhook 側に追加**して実現。webhook は新着 inbound 受信時にアクティブ下書きが既に `pending` ならば SQS 送信をスキップし、`message_id` の更新だけ行う (進行中の再生成完了後の auto-batch 復活は ai-worker が「未取り込み新着」を検知して再 enqueue)。
- **UI**: `DraftCard` (現在の `ReplyForm` 内 + `DraftBanner` 共存領域) に「再生成」ボタンと 1000 文字カウンタ付きの instruction textarea を追加。`regenerateDraftFn` 呼び出し後 `DraftBanner` のポーリングを引き継ぐ。ポーリングはクライアント側で **再生成中のみ 90 秒タイムアウト** (auto-batch のときは #004 の 60 秒を維持) を持ち、失敗/タイムアウト時は trans-toast + ボタン再活性化 + instruction 保持。タイムアウト切替は `DraftBanner` に新規 `mode?: 'auto' | 'regenerate'` prop を追加し、`ReplyForm` が `isRegenerating` から派生して渡す。
- **データモデル変更なし**: `ai_drafts` の列は #004 から不変。ワンオフ指示は SQS payload とプロンプト合成のみに存在し、DB に保存しない。
- **観測性**: 新規イベント `draft_regenerate_requested` (server fn) / `draft_regenerate_started` (worker, coalesce bypass マーカー) / `draft_regenerate_failed` (旧本文保持パス) / `draft_persisted` (既存) を発火。

## Technical Context

**Language/Version**: TypeScript 5.x / Node.js 24.x (`nodejs24.x` Lambda)。001〜004 と同一。
**Package Manager**: npm (`app/package-lock.json`, `ai-worker/package-lock.json`, `webhook/package-lock.json`)。
**HTTP クライアント方針**: グローバル `fetch` のみ、axios 系の新規導入禁止。SQS は AWS SDK の内部 HTTP 経由なので OK。

**Primary Dependencies**:
- **新規 (app のみ)**: `@aws-sdk/client-sqs` (既に webhook / ai-worker で使用中。バージョンを合わせて app に追加)。
- それ以外は既存のまま (`@tanstack/react-start`, `drizzle-orm`, `postgres`, `@anthropic-ai/sdk`, `zod`)。
- 新規 npm パッケージは `@aws-sdk/client-sqs` 1 つだけ。

**Infrastructure**:
- 既存 Lambda 構成 (webhook / app / ai-worker / keep-alive) を維持。**新規 Lambda・新規 SQS キューなし**。
- app Lambda の IAM role に `sqs:SendMessage` (既存 draft キュー宛て) を付与。CDK/Terraform 等の IaC 更新が必要。
- `keep-alive` Lambda は別 SQS を持たない、変更不要。

**Storage**: 既存 Supabase Postgres。**マイグレーションなし**。`ai_drafts` テーブルは #004 のままで、再生成は既存列の状態遷移として表現する (`error` 列は #004 から存在、用途を拡張)。

**Testing & CI**:
- vitest (ai-worker):
  - `triggerType:'regenerate'` の coalesce bypass (新着インバウンドがあっても skip しない)
  - 再生成失敗時に `status='ready'` 維持 + `error` 列セット + 旧 `body` 保持
  - 再生成成功時に `error` 列が null クリアされる
  - プロンプト合成: `OPERATOR_INSTRUCTION` ブロックが additional と LANGUAGE_DIRECTIVE の間に挟まる
  - `instruction` が空文字 / undefined の場合は OPERATOR_INSTRUCTION ブロックを出さない (回帰)
- vitest (app):
  - `regenerateDraftFn` が `withTenant` 内で active draft を `pending` に戻し、`error` を null にし、`SendMessage` を呼ぶ
  - `instruction` が 1001 文字以上で zod validation エラー
  - 自分のテナントでない conversationId へのアクセスが RLS で弾かれる
- vitest (webhook):
  - active draft が `pending` のとき新着 inbound テキストで SQS 送信を skip (既存 upsert は実行) — 進行中再生成抑制の挙動
- Playwright E2E スモーク: 下書きが ready の会話 → 「再生成」展開 → instruction 入力 → 実行 → pending バナー → ready で新本文 → instruction 欄が空。

**Target Platform**: 001〜004 と同一 (AWS Lambda + API Gateway + SQS + S3/CloudFront / Supabase)。

**Project Type**: 既存 TanStack Start アプリ + webhook Lambda + ai-worker Lambda の機能追加。

**Performance Goals**:
- SC-002: 再生成 P50 30s 以内 (Anthropic 単発呼び出し相当)。SQS DelaySeconds=0 で即時起動。
- SC-001: UI 操作開始から再生成ボタン押下まで 15 秒以内 (テキスト 1000 字以内の手入力を許容)。
- 既存単発フローの p95 < 60s 維持。

**Constraints**:
- **マルチテナント安全性**: `regenerateDraftFn` は `authMiddleware` + `withTenant`。SQS payload の `conversationId` は app fn 内で tenant 検証済みのものだけを乗せる (ai-worker 側でも改めて tenant 解決するので二重防御)。
- **冪等性**: SQS at-least-once 前提。再生成ジョブが重複配信されても worker は同じ active draft を上書きするだけで害がない (副作用は Anthropic コスト 2 倍化のみ)。発生頻度は低い。
- **後方互換**: 既存 SQS message 形式は維持。`triggerType` / `instruction` は optional 追加で旧形式の auto-batch ジョブはそのまま処理される。
- **同時実行抑制の限界**: webhook 側の `pending` チェックは worker クラッシュで `pending` が滞留すると新着自動バッチを永久に抑制する。これに対しては `ai_drafts.updated_at` が古い (例: > 5 min) ものは `pending` でも auto-batch 復活させる "stale guard" を webhook に入れる (本変更内)。
- **ワンオフ指示の上限**: 1000 文字 (UTF-16 code units)。zod `z.string().max(1000)` で server fn が、UI 側カウンタが揃って弾く。
- **クライアントタイムアウト**: 90 秒で failure 扱い (FR-011)。ローカル state のみで実現 (サーバ書き込みなし)。

**Scale/Scope**:
- 追加・変更コード LOC 目安: ~400 行
  - `app/src/server/services/sqs.ts` (NEW) 40 行
  - `app/src/server/env.ts` (MODIFY: SQS_QUEUE_URL, AWS_REGION 追加) 5 行
  - `app/src/routes/(app)/threads/$id/-lib/regenerate-draft.fn.ts` (NEW) 70 行
  - `app/src/routes/(app)/threads/$id/-components/RegeneratePanel.tsx` (NEW) 80 行
  - `app/src/routes/(app)/threads/$id/-components/ReplyForm.tsx` (MODIFY: instruction state + ボタン配置) 30 行
  - `app/src/routes/(app)/threads/$id/-lib/get-draft-status.fn.ts` (MODIFY: error 列を返す) 5 行
  - `app/src/routes/(app)/threads/$id/-components/DraftBanner.tsx` (MODIFY: `mode?: 'auto' | 'regenerate'` で 60s/90s 切替、失敗トースト) 25 行
  - `ai-worker/src/handler.ts` (MODIFY: triggerType + instruction + 失敗時の ready 維持) 50 行
  - `ai-worker/src/prompt.ts` (MODIFY: OPERATOR_INSTRUCTION ブロック) 25 行
  - `webhook/src/handler.ts` (MODIFY: pending 中は SQS skip + stale guard) 30 行
  - `app/src/server/db/schema.ts` (変更なし)
  - テスト 50 行

## Constitution Check

*GATE: Phase 0 前にパス、Phase 1 設計後に再チェック。*

**プロジェクト憲法の状態**: `.specify/memory/constitution.md` 未ラティファイ。001〜004 同様、業界標準ゲートを暫定適用する。

| ゲート | 判定 | 根拠 |
|---|---|---|
| **YAGNI** | ✅ PASS | スコープは「運営者の使い捨て指示で再生成」に限定。バージョン履歴・指示の永続保存・指示テンプレ機能は明示除外 (Assumptions)。|
| **単一責任** | ✅ PASS | Story 1 (指示付き再生成)、Story 2 (素の再生成)、Story 3 (状態可視化) は同一導線の段階機能で、いずれも独立にテスト可能。|
| **テスト可能性** | ✅ PASS | プロンプト合成 / 失敗時の状態遷移 / coalesce bypass を純粋関数または短いハンドラ単位で unit test。E2E はスモーク 1 本。|
| **シンプル優先** | ✅ PASS | DB マイグレーション 0 本。新規 Lambda・新規キュー・新規 SSM ゼロ。新規 npm 1 個 (`@aws-sdk/client-sqs`、既に他プロセスで使用中)。|
| **観測性** | ✅ PASS | `draft_regenerate_requested` / `draft_regenerate_started` / `draft_regenerate_failed` / 既存 `draft_persisted` を構造化ログ。`instruction_length` をログに含めて運用観測 (本文は出さない)。|
| **可逆性** | ✅ PASS | スキーマ変更なし、env 追加 2 つ + IAM 追加のみで巻き戻し可能。最悪時は UI から再生成導線を非表示にすれば既存挙動に戻る。|

**複雑性の正当化**: 不要。新規構成要素は server fn 1 本 + service 1 本 + UI コンポーネント 1 本 + env 2 個 + IAM 1 行。

**Phase 1 設計後の再チェック (2026-06-23)**: 全 6 ゲート PASS 維持。data-model 再確認で DB 列追加ゼロ。contracts で SQS payload 拡張・プロンプト合成順序・state 機械を明示。

## Project Structure

### Documentation (this feature)

```text
specs/005-draft-regenerate-oneoff/
├── spec.md                 # 仕様書 (clarify 後)
├── plan.md                 # 本ファイル
├── research.md             # Phase 0 (app→SQS 経路 / coalesce bypass / 失敗時の状態維持の根拠)
├── data-model.md           # Phase 1 (ai_drafts 列再確認: 変更なし / 状態遷移)
├── quickstart.md           # Phase 1 (env 追加・IAM 付与・ローカル検証手順)
├── contracts/
│   └── regenerate-pipeline.md  # SQS payload 拡張 + プロンプト合成 + server fn 契約 + UI 契約
└── checklists/
    └── requirements.md     # 品質チェックリスト (specify で作成済み)
```

### Source Code (変更/追加ファイル中心)

```text
app/                                       # TanStack Start アプリ + Lambda
├── package.json                           # MODIFY: @aws-sdk/client-sqs 追加 (webhook/ai-worker と同 major)
├── src/
│   ├── server/
│   │   ├── env.ts                         # MODIFY: SQS_QUEUE_URL, AWS_REGION (default ap-northeast-1) 追加
│   │   └── services/
│   │       └── sqs.ts                     # NEW: SQSClient lazy init + enqueueDraftJob({ conversationId, triggerType, instruction? })
│   └── routes/(app)/threads/$id/
│       ├── -lib/
│       │   ├── regenerate-draft.fn.ts     # NEW: server fn (authMiddleware + withTenant + zod 1000) → ai_drafts pending 更新 + SQS 送信
│       │   └── get-draft-status.fn.ts     # MODIFY: 戻り値に `error: string | null` を追加
│       └── -components/
│           ├── RegeneratePanel.tsx        # NEW: instruction textarea (1000 cap) + 再生成ボタン + 失敗トースト UI
│           ├── ReplyForm.tsx              # MODIFY: RegeneratePanel を draft ready 時にマウント、isRegenerating state を所有
│           └── DraftBanner.tsx            # MODIFY: 90s タイムアウト、失敗/タイムアウト時の onError コールバック追加

ai-worker/
├── src/
│   ├── handler.ts                         # MODIFY: DRAFT_BODY_SCHEMA に triggerType / instruction、coalesce bypass、失敗時 ready 維持 (regen のみ)、error null クリア (成功時)
│   └── prompt.ts                          # MODIFY: OPERATOR_INSTRUCTION ブロック生成関数 + buildSystemBlocks 呼び出し点の整理
└── tests/
    └── regenerate.test.ts (NEW)           # NEW: coalesce bypass / 失敗時 ready / プロンプト挟込位置 / instruction 未指定回帰

webhook/
├── src/
│   └── handler.ts                         # MODIFY: active draft が `pending` かつ updated_at < STALE_PENDING_GUARD_SECONDS なら SQS skip (message_id だけ更新)
```

**Structure Decision**: 既存の 3 プロセス (app / webhook / ai-worker) に、新しい SQS publish 経路を **app 側に開ける** ことで「運営者起点の再生成」を表現する。DB スキーマと SQS キューはそのまま、payload に optional フィールドを増やすだけ。UI は既存の `DraftBanner` ポーリング機構を流用し、再生成ボタンと instruction 入力欄を新コンポーネント (`RegeneratePanel.tsx`) として切り出す。

## Complexity Tracking

> 不要 (Constitution Check で違反なし)。
