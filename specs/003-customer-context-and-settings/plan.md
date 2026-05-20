# Implementation Plan: 会話コンテキストの永続化と設定の階層化

**Branch**: `003-customer-context-and-settings` | **Date**: 2026-05-20 | **Spec**: [spec.md](./spec.md)
**Input**: Feature specification from `/specs/003-customer-context-and-settings/spec.md`

## Summary

AI ドラフト生成のシステムプロンプトを「ハードコード 1 種類」から「**ベース + ページポリシー + 顧客個別設定 + ローリング要約 + 直近メッセージ**」の 5 段合成に進化させる。同時に、サイドバーで死んでいる Settings リンク (`app/src/routes/(app)/route.tsx:43` で `href='#'`) を実ページ化し、スレッド画面に CustomerPanel (右カラム) を新設する。

**アーキテクチャ要点**（詳細は `research.md`）:

- **DB スキーマ拡張**: `conversations` に 5 列 (`summary`, `last_summarized_at`, `tone_preset`, `custom_prompt`, `note`)、`connected_pages` に 1 列 (`custom_prompt`) を追加。新規テーブルなし。
- **要約パイプライン**: 既存 ai-worker Lambda を再利用。新規 SQS キュー `ai-summary-queue` を 1 本追加し、ai-worker に 2 つ目の SQS event source mapping を追加する。Lambda コードは `handler.ts` に `jobType` (`'draft' | 'summary'`) 分岐を追加。`prompt.ts` は `buildUserPrompt`（draft 用）と `buildSummaryPrompt`（summary 用）に分割。**新規 Lambda はゼロ。新規ファイル/モジュールは Terraform のキュー 1 本のみ。**
- **要約トリガー**: メッセージ INSERT 経路 (webhook Lambda の inbound 受信、app-lambda の outbound `sendReply` server fn) の末尾に共通ヘルパ `maybeEnqueueSummaryJob(conversationId)` を挿入。conversation の `last_summarized_at` 以降の `LENGTH(body)` 累計が 2,000 文字以上なら summary job を enqueue。
- **冪等性**: summary handler は実行時にもう一度しきい値を再計算し、満たさなければスキップ。新規メッセージ未到着での重複 enqueue を吸収する。
- **AI ドラフトプロンプト合成**: ai-worker の draft 経路で `connected_pages.custom_prompt` と `conversations.{tone_preset, custom_prompt, summary, last_summarized_at}` を読み、システムプロンプト末尾に order 通り追加。直近メッセージは「last_summarized_at より新しい text メッセージ、安全キャップ 50 件」とする (要約未生成のフォールバック時のコンテキスト爆発を防ぐ)。
- **UI - Settings**: 新規ルート `/settings` を SSR Lambda に追加。listConnectedPages + updatePageCustomPrompt の 2 server fn。サイドバーリンクの `href` を `'#'` → `'/settings'` に書き換え。
- **UI - CustomerPanel**: スレッド画面のレイアウトを 2 カラム → 3 カラム化。右カラムは新規コンポーネント `CustomerPanel`。更新は単一 server fn `updateConversationSettings`（部分更新可能）。
- **既存資産再利用**: `withTenant` (RLS テナント分離)、`anthropic.ts` ヘルパ (なければ ai-worker の Anthropic client を抜き出し)、Drizzle ORM、Paraglide JS (i18n)、`crypto.ts` (利用しない — 追加カラムはすべて非 PII の運用情報なので平文保存)。
- **i18n**: Settings / CustomerPanel の文言は 002 で導入された Paraglide JS で en/ja を追加。AI プロンプト本文 (Anthropic 渡し) は英語固定 (既存基盤と一致)。
- **テスト**: vitest で server fn・要約閾値判定・プロンプト合成順序・冪等性をカバー、Playwright で Settings 保存 + CustomerPanel 編集 + AI ドラフト反映の E2E スモーク。

## Technical Context

**Language/Version**: TypeScript 5.x / Node.js 24.x（001/002 と同一、`nodejs24.x` Lambda ランタイム）
**Package Manager**: npm（lockfile = `app/package-lock.json`, `ai-worker/package-lock.json`）
**HTTP クライアント方針**: 既存方針継続。グローバル `fetch` のみ使用、axios 系の新規導入禁止。Anthropic SDK (`@anthropic-ai/sdk`) は内部で fetch を使うため OK。

**Primary Dependencies**:
- 既存（変更なし、再利用）: `@tanstack/react-start`, `@tanstack/react-router`, `drizzle-orm`, `postgres`, `@anthropic-ai/sdk`, `@aws-sdk/client-ssm`, `@aws-sdk/client-sqs`, `zod`, `@inlang/paraglide-js`
- 新規パッケージ: **なし**（ai-worker は既に `@anthropic-ai/sdk` を持っているので要約も同じクライアントで実行）

**Infrastructure**:
- 既存 4 Lambda 構成 (webhook / app / ai-worker / keep-alive) を維持。**新規 Lambda ゼロ**
- 新規 SQS キュー 1 本 (`ai-summary-queue`) を `terraform/modules/queue` の流儀で追加
- ai-worker Lambda に 2 つ目の `aws_lambda_event_source_mapping` (summary queue → 同じ関数) を追加
- 新規 SSM パラメータ・新規 IAM ロール・新規 EventBridge ルールは追加しない (要約は SQS event-driven のみ。cron は使わない — D-001 で確定済)

**Storage**: 既存 Supabase Postgres を再利用。マイグレーション 1 本追加 (`0002_customer_context.sql` 仮称) で 6 列追加 + `tone_preset` の CHECK 制約 + `custom_prompt` の `char_length` 上限 CHECK。RLS ポリシー追加は不要 (既存 `conversations` / `connected_pages` の RLS がそのまま継承)。

**Testing & CI**:
- vitest — 以下を unit/integration カバー:
  - 要約しきい値判定 (`computeAccumulatedCharLength`) のユニット
  - 要約 enqueue 冪等性 (handler が同じ conversation を二重処理しないこと)
  - draft プロンプト合成順序 (5 段合成が仕様通り)
  - settings server fn (listConnectedPages / updatePageCustomPrompt) の RLS + バリデーション (文字数上限)
  - conversation server fn (updateConversationSettings) の RLS + 部分更新
- Playwright E2E スモーク — Settings カスタムプロンプト保存 → CustomerPanel でトーン変更 → 新着 inbound → AI ドラフトに両方の指示が反映、を 1 シナリオで通す
- 既存 ai-worker テスト (`ai-worker/src/handler.test.ts`) に summary job 経路のテストを追記

**Target Platform**: 001/002 と同一（AWS Lambda + API Gateway + S3/CloudFront + SQS + EventBridge / Supabase）。

**Project Type**: Web application（既存 TanStack Start アプリへの追加機能）+ ai-worker Lambda の機能拡張。

**Performance Goals**:
- 要約生成 p95 < 20 秒（同モデル・コンテキスト量から推定。AI ドラフトの 60 秒 SLO とは独立、ユーザー体感に影響しない非同期処理）
- AI ドラフト生成 p95 < 60 秒（既存 SLO を維持。プロンプト合成段数が増えても DB 1 クエリ追加 + プロンプト連結のみで余裕）
- Settings / CustomerPanel の自動保存反映時間 < 1 秒（debounce 500ms + server fn round trip ~300ms 想定）
- 要約により、要約カーソル以降 10,000 文字超の長尺会話で AI ドラフト 1 件あたりの入力トークン数 60% 以上削減（SC-003）

**Constraints**:
- **DB スキーマ追加のみ**: 既存列の型変更・制約変更は行わない。マイグレーションは追加列だけで完結する
- **平文保存**: 追加列はすべて非 PII の運用情報 (要約・トーン・運営者メモ・ショップポリシー) のため平文。`crypto.ts` 列暗号化は使わない
- **マルチテナント安全性**: すべての server fn は JWT から `tenant_id` を解決し `withTenant(tenant_id, fn)` で囲む。要約 Lambda は ai-worker と同様 `dbAdmin` で tenant_id を解決後 `withTenant` トランザクションで更新する
- **要約 API 失敗の隔離**: 要約生成は best-effort。失敗しても AI ドラフト経路は要約なしフォールバックで動作する (FR-024)
- **文字数上限**: ページカスタムプロンプト 2,000 文字 / 顧客カスタムプロンプト 1,000 文字 / 顧客メモ 1,000 文字 (内部メモも上限を設ける) を DB CHECK と Zod バリデーションの両方で強制
- **内部メモを AI プロンプトに含めない**: `note` カラムは ai-worker のいずれのプロンプト合成にも入れない (FR-016)。SELECT 自体は CustomerPanel 表示のため許可されるが、プロンプト合成関数からは除外される設計を unit test で固定
- **公開ページは i18n 対象外**: 既存方針継続。本機能の UI は (app) 配下のみ
- **既存 AI ドラフト経路の後方互換**: 全カラム NULL でも回帰なく動作 (FR-005 / SC-007)

**Scale/Scope**:
- 想定アクセス: 001/002 と同一（reviewer + operator 計 3 名）。テナント数は MVP では 1 だが、将来複数テナントを前提
- 追加コード LOC 目安: ~900 行
  - DB マイグレーション 80 行
  - schema.ts 追記 30 行
  - ai-worker handler 分岐 + summary prompt 150 行
  - Settings 画面 + 2 server fn 200 行
  - CustomerPanel + 1 server fn + 既存 getConversation.fn.ts 修正 250 行
  - サイドバーリンク + ガード/redirect 20 行
  - i18n キー追加 (en/ja 各 25 文字列) 50 行
  - 共通ヘルパ (要約 enqueue / 文字数計測) 50 行
  - テスト 70 行
- Terraform 追加: queue モジュール呼び出し 1 ブロック + ai-worker への event source mapping 1 ブロック (~30 行)
- 翻訳キー: 約 25 本 (Settings 10 + CustomerPanel 15)

## Constitution Check

*GATE: Phase 0 研究の前に必ずパス、Phase 1 設計後に再チェック。*

**プロジェクト憲法の状態**: `.specify/memory/constitution.md` は未ラティファイ（テンプレートのまま）。本プランでは 001/002 と同様の業界標準ゲートを暫定適用する。

| ゲート | 判定 | 根拠 |
|---|---|---|
| **YAGNI** | ✅ PASS | スコープは「AI 動作のカスタマイズ + コンテキスト永続化」の最小機能に限定。PII 構造化保存・Wise/PayPal 連携・統計/タグ/購入履歴・ナイトモード/翻訳併記/ワンクリック承認・Instagram/Slack/商品管理はすべて明示的に除外 (FR-OOS-001〜FR-OOS-005)。要約手動操作 UI も次フェーズ送り (FR-OOS-006)。|
| **単一責任** | ✅ PASS | 3 User Story がそれぞれ独立にテスト・デモ可能 (spec の Independent Test 節)。Story 1 (Settings) は Story 2/3 がなくても出荷可能、Story 2 (CustomerPanel) も Story 1/3 から独立。Story 3 (要約) は Story 1/2 を破壊せず重ねて投入可能。|
| **テスト可能性** | ✅ PASS | server fn は Drizzle + tenant コンテキストで unit/integration テスト可能。要約閾値判定は純粋関数 (`computeAccumulatedCharLength(messages, cursor)`)。プロンプト合成は純粋関数 (`buildUserPrompt(...)`, `buildSummaryPrompt(...)`)。E2E は Playwright で UI 経路を 1 本通す。|
| **シンプル優先** | ✅ PASS | 新規 Lambda ゼロ。既存 ai-worker に jobType 分岐を 1 か所追加するだけ。新規テーブルゼロ・新規 SSM ゼロ・新規 IAM ロールゼロ。新規 Terraform 追加は SQS キュー 1 本と event source mapping 1 本のみ。|
| **観測性** | ✅ PASS | summary job 実行は構造化ログで「fetch_conversation / build_prompt / call_anthropic / persist_summary」の各段階を出す。draft 経路にも「page_prompt_present / convo_settings_present / summary_present / messages_count」を出してプロンプト合成段階を可視化する。Settings / CustomerPanel server fn は既存ログ方針 (request_id + tenant_id + entity_id) を踏襲。|
| **可逆性** | ✅ PASS | スキーマ変更は追加カラムのみ (NULL 許可)。ロールバックはマイグレーション逆行で安全に列を落とせる (データは捨てる前提)。要約 Lambda 分岐は env フラグ (`SUMMARY_PIPELINE_ENABLED=false`) でオフにできる設計とし、障害時に既存 draft 経路だけにフォールバック可能。Settings / CustomerPanel UI 追加は既存ルートに干渉しない。|

**複雑性の正当化**: 不要。本機能で複雑な分散構成や非同期パターンは追加しない (summary は既存 SQS パターンの再利用、新規 Lambda ゼロ)。

**Phase 1 設計後の再チェック (2026-05-20)**: 全 6 ゲート PASS 維持。
- YAGNI: contracts/ 4 本はいずれもスコープ外機能 (Wise/PayPal、統計、購入履歴) を含まない
- 単一責任: 4 contracts はそれぞれ独立 (settings-fns, conversation-fns, summary-job, prompt-composition)
- テスト可能性: `buildAdditionalSystemPrompt` / `buildSummaryPrompt` / `computeAccumulatedCharLength` は純粋関数として切り出され unit test 容易
- シンプル優先: data-model.md 確定で新規テーブル・新規インデックス・新規 RLS ポリシーゼロを再確認
- 観測性: 4 contracts で構造化ログイベント名を全て明示
- 可逆性: data-model.md にロールバック SQL を含め、`SUMMARY_PIPELINE_ENABLED` env スイッチを設計

## Project Structure

### Documentation (this feature)

```text
specs/003-customer-context-and-settings/
├── spec.md              # 仕様書 (確定済)
├── plan.md              # 本ファイル
├── research.md          # Phase 0 成果物 (技術選定・閾値根拠・既存資産再利用ログ)
├── data-model.md        # Phase 1 成果物 (DB 列追加と CHECK 制約)
├── quickstart.md        # Phase 1 成果物 (ローカル開発手順、Anthropic API キー、SQS LocalStack 不要の判断)
├── contracts/           # Phase 1 成果物
│   ├── settings-fns.md            # listConnectedPages / updatePageCustomPrompt
│   ├── conversation-fns.md        # updateConversationSettings / getConversation の差分
│   ├── summary-job.md             # SQS メッセージ契約 (summary job) + ai-worker 内 jobType 分岐契約
│   └── prompt-composition.md      # 5 段合成順序 + 直近メッセージ抽出ルール
├── checklists/
│   └── requirements.md  # 品質チェックリスト (確定済)
└── tasks.md             # /speckit.tasks で生成 (本コマンドでは未生成)
```

### Source Code (repository root)

001/002 の構成を踏襲。追加・変更ファイルを中心に示す。

```text
app/                              # TanStack Start アプリ
├── src/
│   ├── routes/
│   │   ├── (app)/
│   │   │   ├── route.tsx                    # MODIFY: サイドバー Settings リンクの href を /settings に
│   │   │   ├── settings/                    # NEW
│   │   │   │   ├── index.tsx                # NEW: ルート本体 (loader で connected_pages 一覧 + 各 custom_prompt をロード)
│   │   │   │   ├── -components/
│   │   │   │   │   ├── ConnectedPagesList.tsx        # NEW
│   │   │   │   │   ├── PageCustomPromptEditor.tsx    # NEW: textarea + autosave + 残り文字数表示
│   │   │   │   │   └── EmptyState.tsx                # NEW: ページ 0 件時の導線
│   │   │   │   └── -lib/
│   │   │   │       ├── list-settings.fn.ts           # NEW: server fn (GET): connected_pages + custom_prompt
│   │   │   │       └── update-page-prompt.fn.ts      # NEW: server fn (POST): { pageId, customPrompt }
│   │   │   └── threads/$id/
│   │   │       ├── index.tsx                # MODIFY: レイアウトを 2 カラム → 3 カラム化、CustomerPanel 配置
│   │   │       ├── -components/
│   │   │       │   ├── CustomerPanel.tsx              # NEW: 右カラム全体
│   │   │       │   ├── CustomerPanelHeader.tsx        # NEW: アバター + 名前 + PSID
│   │   │       │   ├── AiPersonaSummary.tsx           # NEW: AI 要約表示 + 注意書き
│   │   │       │   ├── DraftSettingsEditor.tsx        # NEW: トーン 3 択 + custom_prompt textarea
│   │   │       │   ├── InternalNoteEditor.tsx         # NEW: 内部メモ textarea
│   │   │       │   └── AutoSaveBadge.tsx              # NEW: 共通 (Settings / CustomerPanel で再利用)
│   │   │       └── -lib/
│   │   │           ├── get-conversation.fn.ts         # MODIFY: SELECT に summary / tone_preset / custom_prompt / note / last_summarized_at を追加
│   │   │           └── update-conversation-settings.fn.ts  # NEW: server fn (POST): 部分更新
│   ├── server/
│   │   ├── services/
│   │   │   ├── summary-trigger.ts           # NEW: maybeEnqueueSummaryJob(conversationId, tx) — 文字数判定 + SQS send
│   │   │   └── sqs.ts                       # NEW or MODIFY: 既存 SQS client があれば再利用、なければ薄いラッパ
│   │   └── fns/
│   │       └── send-reply.fn.ts             # MODIFY (既存があれば): outbound 送信成功後に summary-trigger を呼ぶ
│   ├── lib/
│   │   └── settings/                        # NEW
│   │       └── char-limits.ts               # NEW: { PAGE_PROMPT_MAX: 2000, CUSTOMER_PROMPT_MAX: 1000, NOTE_MAX: 1000 } + Zod スキーマ
│   └── styles.css                           # MODIFY: 3 カラムレイアウト + CustomerPanel スタイル
├── messages/
│   ├── en.json                              # MODIFY: 約 25 キー追加 (settings_*, customer_panel_*)
│   └── ja.json                              # MODIFY: 同上
└── tests/
    ├── integration/
    │   ├── settings-page.test.ts            # NEW: server fn + RLS + 文字数バリデーション
    │   ├── customer-panel.test.ts           # NEW: 部分更新 / トーン enum / 内部メモが AI に渡らないこと
    │   └── summary-trigger.test.ts          # NEW: 閾値判定 + 冪等性
    └── e2e/
        └── customer-context.spec.ts         # NEW: Settings 保存 → CustomerPanel 編集 → AI ドラフト反映

ai-worker/                                   # AI 処理 Lambda
├── src/
│   ├── handler.ts                           # MODIFY: SQS message に `jobType` を含める前提で分岐 (draft / summary)
│   ├── prompt.ts                            # MODIFY: SYSTEM_PROMPT を分解、buildSystemPrompt(parts) を追加、buildSummaryPrompt 新設
│   ├── summary.ts                           # NEW: processSummaryJob(conversationId) — fetch + Anthropic + persist
│   └── db/
│       └── schema.ts                        # MODIFY: app 側と同期 (新規 5 列 + 1 列)
└── tests/
    ├── handler.test.ts                      # MODIFY: summary job 経路を追加
    └── summary.test.ts                      # NEW

app/src/server/db/
├── schema.ts                                # MODIFY: 5 + 1 列追加、tone_preset の Drizzle 型 (`pgEnum` ではなく varchar+CHECK)
└── migrations/
    └── 0002_customer_context.sql            # NEW: ALTER TABLE 2 本 (connected_pages, conversations) + CHECK 制約

terraform/
├── envs/review/                             # MODIFY
│   └── main.tf                              # MODIFY: queue モジュール呼び出し + ai-worker への event source mapping
└── modules/
    ├── queue/                               # 既存。再利用 (新インスタンスを envs から作る)
    └── ai-worker-lambda/                    # MODIFY: 2 つ目の event_source_mapping 入力変数を受け付ける
```

**Structure Decision**: 既存 TanStack Start モノレポと ai-worker Lambda の両方に**最小増分**で機能を追加する。

- **新規 Lambda・新規テーブルゼロ**。ai-worker に jobType 分岐を 1 か所、Terraform に SQS 1 本と event source mapping 1 本を追加するだけ。
- スレッド画面は 2 カラム (Inbox + Thread) から 3 カラム (Inbox + Thread + CustomerPanel) に拡張。狭幅では CustomerPanel を折りたたみ可能 (今フェーズの最低限のレスポンシブ対応)。
- Settings は単一ルート `/settings` 配下にまとめ、ページ詳細などのサブルートは作らない (FR-OOS-004 によりトグル・モード類はスコープ外なので階層化不要)。
- ai-worker は draft / summary の 2 jobType を扱う単一関数に進化させる。今後さらに job 種別を増やす場合に備え、handler.ts は最初から dispatch 形式で書く (`processRecord` 内で jobType を見て `processDraftJob` / `processSummaryJob` を呼ぶ)。
- 文字数上限は `app/src/lib/settings/char-limits.ts` の 1 か所で定数化し、Zod スキーマ・DB CHECK 制約・UI の残り文字数表示の 3 か所から参照する。

## Complexity Tracking

> 不要（Constitution Check で違反なし）。
