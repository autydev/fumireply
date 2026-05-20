# Implementation Plan: Draft 操作 UX 強化（再生成・破棄・日本語訳）

**Branch**: `004-draft-actions-and-translation` | **Date**: 2026-05-20 | **Spec**: [spec.md](./spec.md)
**Input**: Feature specification from `/specs/004-draft-actions-and-translation/spec.md`

## Summary

スレッド詳細画面の AI ドラフト表示に「破棄」「再生成」ボタンを追加し、ドラフトの `status` を 3 状態（`pending` / `discarded` / `superseded`）で管理する。同時に Settings ページにグローバルトグル「ドラフトの日本語訳を表示」を追加し、ON のときは DeepL Free API でドラフト本文を和訳して内部表示する。

**アーキテクチャ要点**（詳細は `research.md`）:

- **DB スキーマ拡張**: `ai_drafts` テーブルに 3 列（`lifecycle_status`, `translation_ja`, `translation_status`）を追加。既存の `status` 列（AI 生成進捗: `pending`/`ready`/`failed`）は触らず、ユーザー操作ライフサイクルを別カラムで管理する。`lifecycle_status` 既定値は `active`、既存行も `active` でバックフィル。`tenants` に 1 列（`translation_enabled boolean default false`）追加。新規テーブルなし。
- **新規 Lambda ゼロ**: 翻訳呼び出しは ai-worker の draft job 経路に inline で組み込み。ai-worker から DeepL Free API を `fetch` で叩き、結果を `ai_drafts.translation_ja` に書き戻す。失敗時は `translation_status='failed'` を立てて draft 本体は通常通り保存。
- **破棄・再生成 UI フロー**: スレッド画面の draft 表示に 2 ボタン追加。それぞれサーバ fn 1 本（`discardDraft` / `regenerateDraft`）。`regenerateDraft` は旧 draft を `superseded` に倒し、既存の AI ドラフト生成 SQS キューに新規ジョブを enqueue。
- **既存ドラフト一覧 SELECT の差分**: 既存の `getConversation` / 各種 draft 取得 server fn は `WHERE lifecycle_status='active'` を追加して `discarded` / `superseded` を UI に出さない。SELECT 自体は履歴保持のため許可。
- **翻訳のオン/オフ**: Settings の toggle は ai-worker の draft job 完了直後にチェック。OFF なら DeepL を叩かない。再生成時も同様に毎回 toggle を読む（揮発キャッシュ＝ DB に列はあるが翻訳ロジックは設定状態だけを根拠に再実行）。
- **既存資産再利用**: `withTenant` (RLS)、Drizzle ORM、Paraglide JS (i18n)、spec 003 で導入された Settings ページ枠組み・CustomerPanel 周辺（draft 表示位置）、ai-worker 本体・既存 SQS draft queue・既存 Anthropic クライアント。
- **i18n**: 追加文言（破棄/再生成ボタン、確認テキスト、Settings トグルラベル、翻訳失敗時のエラーバッジ）は Paraglide JS の `en.json` / `ja.json` に各 10 〜 12 キー追加。
- **テスト**: vitest で 3 server fn・ai-worker の翻訳分岐・status フィルタを unit/integration カバー、Playwright で「破棄 → ドラフト消失」「再生成 → 新ドラフト表示」「Settings ON → 翻訳表示」の 3 シナリオを E2E スモーク。

## Technical Context

**Language/Version**: TypeScript 5.x / Node.js 24.x（001/002/003 と同一）
**Package Manager**: npm（lockfile は spec 003 と同じ位置）
**HTTP クライアント方針**: グローバル `fetch` のみ。DeepL Free は `https://api-free.deepl.com/v2/translate` を `POST application/x-www-form-urlencoded` で叩く軽量呼び出し、SDK は使わない。axios 等の新規導入禁止（[[feedback_no_axios]]）

**Primary Dependencies**:
- 既存（変更なし、再利用）: `@tanstack/react-start`, `drizzle-orm`, `@anthropic-ai/sdk`, `@aws-sdk/client-sqs`, `zod`, `@inlang/paraglide-js`
- 新規パッケージ: **なし**

**Infrastructure**:
- 既存 Lambda 構成を維持（**新規 Lambda ゼロ**）
- 既存 ai-draft SQS キューを再利用（再生成は既存キューに再 enqueue するだけ）
- DeepL API キーは新規 SSM Parameter `/fumireply/<env>/deepl_api_key` として保管。ai-worker IAM ロールに `ssm:GetParameter` の許可を追加（既存 SSM 参照と同じパターン）

**Storage**: 既存 Supabase Postgres を再利用。マイグレーション 1 本追加（`0003_draft_actions_and_translation.sql` 仮称）で `ai_drafts` に 3 列、Settings 保存箇所に 1 列追加。`status` の CHECK 制約 (`pending`/`discarded`/`superseded`)、`translation_status` の CHECK 制約 (`pending`/`ok`/`failed`/`skipped`)。RLS ポリシー追加不要（既存 `ai_drafts` の RLS をそのまま継承）。

**Testing & CI**:
- vitest — 以下を unit/integration カバー:
  - `discardDraft` server fn の RLS + lifecycle 遷移（`active` → `discarded` のみ許可）
  - `regenerateDraft` server fn の RLS + 旧 draft `superseded` 化 + 新 enqueue
  - `getConversation` の lifecycle フィルタ（`active` のみ返す）
  - ai-worker の翻訳分岐: 設定 ON で DeepL 呼び出し、OFF でスキップ、API 失敗時に `translation_status='failed'` 保存
  - Settings toggle 更新の RLS
- Playwright E2E スモーク — 3 シナリオ
  1. 破棄: ドラフト表示 → 破棄押下 → 表示消失 → リロード後も消失
  2. 再生成: ドラフト表示 → 再生成押下 → 「生成中」表示 → 新ドラフト表示
  3. 翻訳 ON: Settings で ON → 新着メッセージ → ドラフトに日本語訳併記表示
- 既存 ai-worker テストに翻訳分岐の小ケースを追記

**Target Platform**: 001/002/003 と同一（AWS Lambda + Supabase）

**Project Type**: Web application（既存 TanStack Start アプリ）+ ai-worker Lambda の機能拡張

**Performance Goals**:
- 破棄ボタン押下から UI 反映まで p95 < 1 秒（server fn 単発、DB UPDATE のみ）
- 再生成押下から新ドラフト表示まで p95 < 15 秒（spec 003 のドラフト生成 SLO + UI 表示まで。spec 003 が 60 秒 SLO なら spec 004 もそれに従属）
- 翻訳 API 呼び出しはドラフト生成時間に対し +2 秒以内（DeepL Free p95 < 1 秒の実測値想定、本体生成と並行も可）
- 翻訳失敗が draft 本体生成の成功率に影響しない（成功率の純粋分離）

**Constraints**:
- **DB スキーマ追加のみ**: 既存列の型変更なし。マイグレーションは追加列＋ CHECK 制約のみで完結
- **平文保存**: 追加列はすべて運用情報・公開可能テキスト（draft 本文の和訳）のため平文。`crypto.ts` 列暗号化は使わない
- **マルチテナント安全性**: discardDraft / regenerateDraft / 翻訳結果書き戻しはすべて `withTenant(tenant_id, fn)` 経由
- **翻訳の隔離**: DeepL 失敗・タイムアウト（5 秒）はドラフト保存をブロックしない。本体 SAVE → 翻訳 try → 失敗時は `translation_status='failed'` のみ更新
- **DeepL Free の制約**: 月 50 万文字。超過時は API が 456 を返すので `translation_status='failed'` でハンドル
- **既存 UI/契約の後方互換**: 既存の ai-worker SQS メッセージ形式は変更しない。translation_enabled は ai-worker が DB から再読する設計（メッセージで渡さない）
- **非アクティブドラフトの UI 非表示**: 全 SELECT 経路に `lifecycle_status='active'` フィルタ必須。`discarded` / `superseded` は履歴として残るが UI に出さない

**Scale/Scope**:
- 想定アクセス: 001/002/003 と同一
- 追加コード LOC 目安: ~700 行
  - DB マイグレーション 40 行
  - schema.ts 追記 20 行
  - ai-worker 翻訳分岐 + DeepL クライアント 120 行
  - discardDraft / regenerateDraft server fn 各 60 行 + 共通 helper 30 行
  - getConversation 等の status フィルタ修正 40 行
  - Settings toggle UI + server fn 100 行
  - 破棄 / 再生成 / 翻訳表示の UI 部品 150 行
  - i18n キー追加 30 行
  - テスト 110 行
- Terraform 追加: SSM Parameter 1 本 + IAM 追加権限（~20 行）
- 翻訳キー: 約 12 本

## Constitution Check

*GATE: Phase 0 研究の前にパス、Phase 1 設計後に再チェック。*

**プロジェクト憲法の状態**: `.specify/memory/constitution.md` は未ラティファイ（テンプレートのまま）。003 と同じ業界標準ゲートを適用する。

| ゲート | 判定 | 根拠 |
|---|---|---|
| **YAGNI** | ✅ PASS | スコープは破棄・再生成・翻訳の 3 機能のみ。フィードバック理由収集、編集距離計測、信頼度スコア、A/B 複数案、自動プロンプト改善は明示的に Out of Scope（spec の Assumptions 節）。翻訳のページ別・会話別上書きもスコープ外 |
| **単一責任** | ✅ PASS | 3 User Story が独立にテスト・デモ可能。US1 破棄は単独で出荷可能、US2 再生成は US1 がなくても動く（旧 draft を superseded にするだけ）、US3 翻訳は US1/US2 に依存しない |
| **テスト可能性** | ✅ PASS | 各 server fn は単一責務で unit/integration テスト容易。翻訳分岐は ai-worker の純粋関数（`translateDraftIfEnabled(text, settings)`）で切り出し可能。Status フィルタは Drizzle クエリのみで網羅可能 |
| **シンプル優先** | ✅ PASS | 新規 Lambda・新規キュー・新規テーブルゼロ。既存 ai-draft SQS キューに再 enqueue するだけ。Terraform 追加は SSM Parameter 1 本のみ |
| **観測性** | ✅ PASS | discardDraft / regenerateDraft 実行は構造化ログ（`request_id` + `tenant_id` + `draft_id` + `action`）。ai-worker 翻訳分岐は `translation_enabled` / `deepl_status` / `chars_billed` を出す。Settings toggle 更新も既存方針踏襲 |
| **可逆性** | ✅ PASS | スキーマ変更は追加列のみ。ロールバックはマイグレーション逆行で安全。`translation_enabled` はデフォルト OFF なので、機能投入時点でアクティブ振る舞いに変更なし。破棄・再生成ボタンは UI を隠せば即無効化できる |

**複雑性の正当化**: 不要。

**Phase 1 設計後の再チェック (2026-05-20)**: 全 6 ゲート PASS 維持。
- YAGNI: contracts/ 4 本がすべてスコープ内
- 単一責任: 4 contracts が独立（discard-fn / regenerate-fn / translation-pipeline / settings-toggle）
- テスト可能性: `translateDraftIfEnabled` / status フィルタ / 状態遷移バリデーションがすべて純粋関数 or 単一クエリで切り出し済
- シンプル優先: data-model.md で追加列 4 本以内・新規テーブルゼロを再確認
- 観測性: 4 contracts でログイベント名を全て明示
- 可逆性: data-model.md にロールバック SQL を含め、`TRANSLATION_ENABLED_DEFAULT=false` 不変条件を明文化

## Project Structure

### Documentation (this feature)

```text
specs/004-draft-actions-and-translation/
├── spec.md              # 仕様書 (確定済)
├── plan.md              # 本ファイル
├── research.md          # Phase 0 成果物 (DeepL Free 採用根拠、status 列 vs 新テーブル比較、ai-worker への翻訳統合方式)
├── data-model.md        # Phase 1 成果物 (ai_drafts 3 列追加 + Settings 1 列追加 + CHECK 制約)
├── quickstart.md        # Phase 1 成果物 (DeepL API キー取得、SSM 登録、env 設定、ローカルでの翻訳 ON 確認手順)
├── contracts/           # Phase 1 成果物
│   ├── discard-fn.md            # discardDraft server fn の I/O とエラー
│   ├── regenerate-fn.md         # regenerateDraft server fn の I/O と enqueue 仕様
│   ├── translation-pipeline.md  # ai-worker の翻訳分岐 + DeepL API 呼び出し契約
│   └── settings-toggle.md       # Settings の translation_enabled トグル更新契約
├── checklists/
│   └── requirements.md  # 品質チェックリスト (確定済)
└── tasks.md             # /speckit.tasks で生成 (本コマンドでは未生成)
```

### Source Code (repository root)

001/002/003 の構成を踏襲。追加・変更ファイルを中心に示す。

```text
app/                              # TanStack Start アプリ
├── src/
│   ├── routes/
│   │   ├── (app)/
│   │   │   ├── settings/                           # spec 003 で導入
│   │   │   │   ├── index.tsx                       # MODIFY: TranslationToggle セクション追加
│   │   │   │   ├── -components/
│   │   │   │   │   └── TranslationToggle.tsx       # NEW: 単一トグル + 説明文 + 月次上限注意書き
│   │   │   │   └── -lib/
│   │   │   │       ├── list-settings.fn.ts         # MODIFY: translation_enabled を返す
│   │   │   │       └── update-translation-toggle.fn.ts  # NEW: server fn (POST): { enabled: boolean }
│   │   │   └── threads/$id/
│   │   │       ├── index.tsx                       # MODIFY (or 子コンポーネント側): draft 表示エリアに 2 ボタン
│   │   │       ├── -components/
│   │   │       │   ├── DraftActions.tsx            # NEW: 「破棄」「再生成」ボタンと「生成中」フィードバック
│   │   │       │   └── DraftTranslation.tsx        # NEW: translation_ja があれば表示、translation_status='failed' なら失敗バッジ
│   │   │       └── -lib/
│   │   │           ├── discard-draft.fn.ts         # NEW: server fn (POST): { draftId } → status='discarded'
│   │   │           ├── regenerate-draft.fn.ts      # NEW: server fn (POST): { draftId } → 旧 superseded + 新 enqueue
│   │   │           └── get-conversation.fn.ts      # MODIFY: latest_draft SELECT に status='pending' フィルタ + translation_ja / translation_status 取得
│   ├── server/
│   │   └── services/
│   │       └── enqueue-draft-job.ts                # MODIFY or NEW: 既存 draft enqueue を helper 化し regenerate-draft.fn からも呼ぶ
│   └── lib/
│       └── drafts/                                 # NEW
│           └── status.ts                           # NEW: { DRAFT_STATUS: ['pending','discarded','superseded'] as const } + Zod スキーマ
├── messages/
│   ├── en.json                                     # MODIFY: 約 12 キー追加
│   └── ja.json                                     # MODIFY: 同上
└── tests/
    ├── integration/
    │   ├── discard-draft.test.ts                   # NEW
    │   ├── regenerate-draft.test.ts                # NEW
    │   ├── conversation-status-filter.test.ts      # NEW: discarded/superseded が UI 取得経路から除外されること
    │   └── translation-toggle.test.ts              # NEW
    └── e2e/
        └── draft-actions.spec.ts                   # NEW: 3 シナリオ

ai-worker/                                          # AI 処理 Lambda
├── src/
│   ├── handler.ts                                  # MODIFY: draft job 完了直後に translateDraftIfEnabled を呼ぶ
│   ├── translation.ts                              # NEW: translateDraftIfEnabled / callDeepL / classifyDeepLError
│   └── db/
│       └── schema.ts                               # MODIFY: ai_drafts に 3 列追加（app 側と同期）
└── tests/
    └── translation.test.ts                         # NEW: 設定 ON/OFF・API 成功/失敗・上限到達ケース

app/src/server/db/
├── schema.ts                                       # MODIFY: ai_drafts に 3 列、Settings 保存箇所に 1 列追加
└── migrations/
    └── 0003_draft_actions_and_translation.sql      # NEW: ALTER TABLE 2 本 + CHECK 制約 2 本 + 既存行 status バックフィル

terraform/
├── envs/review/                                    # MODIFY
│   └── main.tf                                     # MODIFY: SSM Parameter `/fumireply/review/deepl_api_key` 追加
└── modules/
    └── ai-worker-lambda/                           # MODIFY: env var `DEEPL_API_KEY_SSM_PATH` 追加（既存 SSM 参照パターン踏襲）
```

**Structure Decision**: 既存 TanStack Start モノレポ + ai-worker Lambda の両方に最小増分で機能を追加する。

- **新規 Lambda・新規キュー・新規テーブルゼロ**。ai-worker に翻訳分岐を 1 か所、Terraform に SSM Parameter 1 本を追加するだけ
- 破棄・再生成 UI は既存 draft 表示位置（spec 003 で固まったレイアウト）に 2 ボタン追加。新規レイアウト変更なし
- Settings は spec 003 で導入した `/settings` ルートに翻訳トグル 1 セクションを追加するだけ。サブルートは作らない
- `lifecycle_status` 列は将来「フィードバック収集（破棄理由 / 編集距離）」を spec 005 で拡張する際にも `accepted` / `discarded_with_reason` 等を追加しやすい設計にする（CHECK 制約に値を足すだけ）
- 翻訳 API キーは SSM Parameter で管理し、env var はパス参照のみ。spec 003 で確立した SSM Parameter 命名・読み込みパターンを踏襲

## Complexity Tracking

> 不要（Constitution Check で違反なし）
