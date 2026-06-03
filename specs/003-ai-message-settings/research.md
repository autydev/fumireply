# 調査・設計検討: AI メッセージ生成ガイダンス設定機能

**Feature Branch**: `claude/ai-message-settings-KHp3b`
**Created**: 2026-05-17
**Status**: Research / Design Draft（実装前の調査ドキュメント）
**Input**: 「AI でメッセージを生成させる時に、意識してほしいこと（①どんなビジネスで何をゴールとしたいか ②トーン ③その他注意事項）を事前にセッティングできる機能を追加したい。現リポジトリの構成を踏まえた設計と、類似 AI メッセージ支援アプリの設定構成・会話履歴コンテキスト肥大化対策の事例調査」

> 本ドキュメントはコード実装を含まない**調査・設計検討の成果物**である。実装は本ドキュメントの合意後、別途 spec-kit フロー（spec.md / plan.md / tasks.md）に展開する。

---

## 1. 背景と目的

`001-mvp-app-review` で「Messenger 受信 → AI 下書き生成 → 人間が編集 → 送信」のパイプラインが本番稼働している。現状、AI 下書きの**システムプロンプトは TCG 小売店向けにハードコードされた固定文**であり（`ai-worker/src/prompt.ts:1-14`）、テナント／ページごとに「どんなビジネスか」「ゴール」「トーン」「注意事項」を反映する手段がない。

本機能は、運用者が **ページ単位で AI 生成方針を設定** でき、その内容が下書き生成プロンプトに注入される仕組みを追加することを目的とする。これは `002` ドキュメントが「承認後 Phase 2 / `specs/003-...` 以降に温存」と明示した領域に該当する。

---

## 2. 現状アーキテクチャ調査（コードベース）

### 2.1 AI Worker（下書き生成本体）

| 項目 | 内容 | 参照 |
|---|---|---|
| トリガ | SQS（`messageId` を body に格納） | `ai-worker/src/handler.ts:195-199` |
| モデル | `claude-haiku-4-5-20251001`（env 上書き可） | `ai-worker/src/handler.ts:17` |
| システムプロンプト | **固定定数 `SYSTEM_PROMPT`**（TCG 小売店向け、最大300字、言語ミラーリング等のガイドライン） | `ai-worker/src/prompt.ts:1-14` |
| ユーザープロンプト | `Recent conversation:` + `[customer]/[operator]` 行 + 指示文 | `ai-worker/src/prompt.ts:22-38` |
| 会話履歴 | **固定 5 件のスライディングウィンドウ**、同一会話のみ、`message_type='text'` のみ、timestamp DESC で取得し reverse | `ai-worker/src/handler.ts:19, 122-134` |
| API 呼び出し | `system` を **`cache_control: { type: 'ephemeral' }` で Prompt Caching**、`max_tokens: 300` | `ai-worker/src/handler.ts:50-61` |
| リトライ | 最大3回、指数バックオフ `[1s,3s,9s]`、429/5xx/timeout のみ | `ai-worker/src/handler.ts:42-76` |
| トークン記録 | `input + cache_creation + cache_read` を合算し `ai_drafts.prompt_tokens` 等へ保存 | `ai-worker/src/handler.ts:158-192` |

**重要な制約**: Worker は `messages.id` から `tenant_id` を解決し（`dbAdmin`、RLS バイパス）、その後 `withTenant` 内で message 本文と履歴のみ取得する。**現状 `conversation.page_id`（= どの接続ページか）は取得していない**。ページ単位ガイダンスを注入するには、この lookup を 1 つ追加する必要がある（`ai-worker/src/handler.ts:106-134`）。

### 2.2 データモデルと RLS

スキーマは Drizzle で定義。**`schema.ts` が 3 パッケージに重複している**点が最大の実装上の注意：

- `app/src/server/db/schema.ts`（マイグレーション生成元）
- `webhook/src/db/schema.ts`
- `ai-worker/src/db/schema.ts`

マイグレーション: `app/src/server/db/migrations/0000_ordinary_orphan.sql` + `0001_rls.sql`（RLS ポリシー）。

関連テーブル（`ai-worker/src/db/schema.ts`）:

- `connected_pages`（`:34-49`）— `tenant_id` FK、`page_id`（Meta 数値ID, varchar, UNIQUE）。**1 ページ = 1 ビジネス/ブランドの自然な単位**。
- `conversations`（`:51-73`）— `page_id` FK → `connected_pages.id`（`:58-60`）。Worker でガイダンスを引くための結合キー。
- `ai_drafts`（`:105-127`）— 生成結果。

テナント分離は `withTenant(tenantId, fn)` が `SET LOCAL app.tenant_id` を実行し、全 RLS ポリシーが `tenant_id = current_setting('app.tenant_id', true)::uuid` で照合する方式。新テーブルにも同型の RLS ポリシーが必須。

### 2.3 アプリ（設定 UI を置く場所）

TanStack Start ファイルベースルーティング。既存の `app/src/routes/(app)/onboarding/connect-page/` が設定系 UI の踏襲すべきパターン：

- サーバ関数を `-lib/*.fn.ts` に配置（`createServerFn` + `authMiddleware` + `withTenant`、Zod で入出力検証）
- i18n は Paraglide（`app/messages/en.json` / `ja.json`、`import { m } from '~/paraglide/messages'`）
- 認証ミドルウェアが `context.user.tenantId` を供給

---

## 3. 類似 AI メッセージ支援サービスの設定構成（Web 調査）

主要 CX/AI 返信プラットフォームが「事前にセッティングさせている項目」は概ね収斂している：

| サービス | 設定項目の構成 |
|---|---|
| **Intercom Fin** | トーンプリセット（Professional / Friendly / Matter-of-fact / Neutral / Humorous）、回答の長さ（簡潔↔詳細）、**Fin Guidance**（自然文での方針・ポリシー指示）、ナレッジ（Content Library）、`{First name}` 等プレースホルダ、オーディエンス/ペルソナ別出し分け |
| **Gorgias** | Tone of Voice、Language 設定、ブランドルール、返信を送信前に微修正し学習 |
| **Zendesk（2026 CX Trends）** | ペルソナ、トーン、**敬称/フォーマリティ（pronoun formality）**。「72% の CX リーダーが AI をブランドの延長と期待」 |
| **HubSpot / Attentive** | AI による Brand Voice セットアップ（語彙・文体の定義） |
| **AI ペルソナ設計のベストプラクティス（汎用）** | **role/identity・goal/purpose・audience・tone（肯定例＋否定例で定義）・behavioral boundaries（やってはいけない/言ってはいけない）・knowledge limits・escalation/fallback** |

**設計への示唆**：

1. 業界標準は「**構造化フィールド ＋ 自由記述**」のハイブリッド。完全自由記述だけだと品質がぶれ、プリセットだけだとブランド固有性を表現できない（Intercom のプリセット限界が指摘されている）。
2. トーンは「**プリセット enum ＋ 否定例（言ってはいけない事）**」の併用が最も効果的。
3. ユーザー要望の ①ビジネス/ゴール ②トーン ③注意事項 は、業界の `business context` / `tone` / `guardrails(do-not)` にそのまま対応する。

---

## 4. 会話履歴のコンテキスト肥大化対策（Web 調査 ＋ 現状評価）

### 4.1 業界の標準パターン

| 戦略 | 概要 | 適性 |
|---|---|---|
| **Sliding Window** | 直近 N 件（or N トークン）のみ送信 | 短い会話。実装容易だが古い重要情報を落とす |
| **Rolling Summarization** | 古い発話を要約に圧縮し、直近は逐語保持（例: `ConversationSummaryBufferMemory`、`max_token_limit`） | 長い会話で序盤情報が効くケース |
| **RAG / Semantic Retrieval** | 現クエリに関連する過去ターンのみ意味検索で投入 | 大量履歴。Mem0 等はトークン 80-90% 削減を主張 |
| **Hybrid** | 直近=逐語、中間=要約、全履歴=ベクタ検索、送信前にトークン上限を強制 | 本番グレードの定番 |
| **Token-based truncation** | 件数でなくトークン数で打ち切り、超過時は最古から落とす。落とした区間をログ化（observability） | コスト/品質の制御に有効 |

加えて Anthropic **Prompt Caching**（`cache_control: ephemeral`）：安定プレフィックス（システムプロンプト＋履歴）を再利用しコスト最大 90% 減・レイテンシ最大 85% 減。キャッシュ書込は基準入力 +25%、読込は基準の 10%。

### 4.2 本アプリの現状評価

現状は **固定 5 件・会話スコープ・テキストのみのスライディングウィンドウ**（`HISTORY_LIMIT=5`）。Haiku 4.5 ＋ `max_tokens:300` のため**現スケールではコンテキスト肥大は実害になっていない**。ただし本機能でガイダンス（固定数百トークン）をシステムプロンプトに足すと、システム側が常時膨らむ。よって対策の主眼は「履歴側」より「**ガイダンス側のトークン上限管理とキャッシュ設計**」になる。

### 4.3 本アプリ向け推奨（段階的）

- **Phase 1（本機能）**: スライディングウィンドウは 5 件のまま据え置き。代わりに **ガイダンス各フィールドに文字数上限**を設け、システムプロンプト総量を予測可能に保つ。Prompt Caching を**2 ブロック構成**にして無駄な再課金を防ぐ（§5.3）。
- **Phase 2（将来・必要時）**: 履歴を件数ベース→**トークン予算ベース**に変更。超過時は最古から落とし、落とした件数を `ai_drafts` のメタ（or ログ）に記録（observability）。
- **Phase 3（将来・長尺会話が増えたら）**: 古い区間の **Rolling Summary** を `conversations` に永続化し、要約＋直近逐語のハイブリッドへ。RAG は現状のドメイン（短い問い合わせ）では過剰と判断。

---

## 5. 設計提案

### 5.1 設定スキーマ（構造化フィールド）

ユーザー要望＋業界標準を踏まえた最小構成。ページ単位（1 行 = 1 `connected_pages`）。

| フィールド | 型 | 内容 | 例 | 上限(案) |
|---|---|---|---|---|
| `business_description` | text | ①どんなビジネスか | 「東京の TCG 小売。日本語カード中心」 | 600字 |
| `goals` | text | ①ゴール | 「在庫/価格問い合わせに即答し購入につなげる」 | 600字 |
| `tone_preset` | varchar(32) | ②トーン（enum） | `friendly` / `professional` / `casual` / `formal` | — |
| `tone_notes` | text | ②トーン補足（自由記述） | 「絵文字は控えめ、敬語ベース」 | 400字 |
| `do_not` | text | ③注意事項（否定例＝言ってはいけない事） | 「在庫を断定しない／値引き約束をしない」 | 600字 |
| `additional_notes` | text | ③その他 | 任意の補足 | 600字 |

> 否定例（`do_not`）を独立フィールドにするのは、トーンを肯定/否定例で定義するのが最も効果的という調査結果に基づく。

### 5.2 DB スキーマ（新テーブル）

`ai_guidance_settings`（仮）。`connected_pages` と 1:1（`page_id` UNIQUE）。**3 つの `schema.ts` すべてに同一定義を追加する**こと（重複同期が漏れると Worker かアプリのどちらかで型不整合になる）。

```text
ai_guidance_settings
  id            uuid PK
  tenant_id     uuid NOT NULL FK -> tenants(id)        -- RLS フィルタ
  page_id       uuid NOT NULL UNIQUE FK -> connected_pages(id)
  business_description text
  goals                text
  tone_preset          varchar(32)
  tone_notes           text
  do_not               text
  additional_notes     text
  created_at    timestamptz NOT NULL default now()
  updated_at    timestamptz NOT NULL default now()
  index (tenant_id)
```

新規マイグレーション（`drizzle-kit generate`）＋ `0001_rls.sql` 同型の RLS ポリシー（`USING/WITH CHECK tenant_id = current_setting('app.tenant_id', true)::uuid`）を追加。

### 5.3 プロンプト注入設計（Prompt Caching 2 ブロック）

`ai-worker/src/prompt.ts` の `SYSTEM_PROMPT` 定数を `buildSystemPrompt(guidance?)` に拡張し、Anthropic 呼び出しの `system` を **2 つの text ブロック**に分割してそれぞれ `cache_control` を付与する：

1. **ブロック A（全テナント共通の基盤指示）**: 「人間レビュー前提」「最大300字」「言語ミラーリング」等の不変ルール → グローバルにキャッシュヒット。
2. **ブロック B（ページ別ガイダンス）**: 上記設定をテンプレ展開。ページ単位で安定なので**そのページの連続リクエスト間でキャッシュヒット**。ガイダンス編集時のみ当該ページのキャッシュが再生成される（許容範囲）。

これにより「ガイダンスを足してもキャッシュ効率を大きく損なわない」設計になる。各フィールドは §5.1 の文字数上限でクランプし、システム総トークンを予測可能に保つ。設定が無いページは従来どおりブロック A のみで動作（後方互換）。

### 5.4 Worker 変更点

`ai-worker/src/handler.ts:106-134` の `withTenant` ブロック内で、message → `conversation_id` → `conversations.page_id` を取得し、`ai_guidance_settings` を `page_id` で 1 行 lookup。取得した guidance を `buildSystemPrompt()` に渡す。DB 読みは API 呼び出し前のトランザクション内（既存方針＝接続を API レイテンシ中に保持しない）に収める。

### 5.5 設定 UI / サーバ関数 / i18n

`app/src/routes/(app)/settings/ai-guidance/`（または既存 onboarding 配下）に、`connect-page` と同型で：

- `-lib/get-ai-settings.fn.ts`（read: 接続ページ一覧＋各ページの設定）
- `-lib/save-ai-settings.fn.ts`（upsert: `onConflictDoUpdate` on `page_id`）
- いずれも `createServerFn` + `authMiddleware` + `withTenant` + Zod（サーバ側でも文字数上限を検証）
- フォーム文言は `app/messages/en.json` / `ja.json` にキー追加（`settings_ai_guidance_*`）

### 5.6 トークン／コスト影響

- ガイダンス全体を上限合計 ≈ 3,400字（≒ 数百〜1.5k トークン）に制約 → Haiku 4.5 ではコスト影響は軽微。
- Prompt Caching によりページ別ブロックは 2 回目以降 10% 課金。
- 履歴は据え置き 5 件のため肥大リスクは Phase 1 では発生しない。

---

## 6. 段階的実装ロードマップ

| Phase | 内容 | スコープ |
|---|---|---|
| **P1** | `ai_guidance_settings` テーブル＋RLS、3 スキーマ同期、`buildSystemPrompt` 2 ブロック化、Worker lookup、設定 UI/サーバ関数/i18n、Zod 文字数検証 | 本機能 |
| **P2** | 履歴をトークン予算ベースに変更＋落とした区間の observability | 必要時 |
| **P3** | 長尺会話向け Rolling Summary 永続化（要約＋直近逐語ハイブリッド） | 長尺増加時 |

---

## 7. 未決事項・論点（実装前に要合意）

1. **粒度**: ページ単位のみとするか、テナント既定値＋ページ上書きの 2 階層にするか。→ MVP はページ単位 1:1 を推奨（最小・自然）。
2. **トーンプリセットの語彙**: enum 値の確定（Intercom 準拠 5 種 or 日本語商習慣向けに敬語/カジュアル軸）。
3. **`do_not` の安全性**: 否定指示はプロンプトインジェクション面・過剰拒否のリスクがあるため、サーバ側でサニタイズ＋長さ制限。
4. **スキーマ重複の恒久対策**: 3 つの `schema.ts` を共有パッケージ化すべきか（本機能の範囲外だが負債として記録）。
5. **既存下書きへの影響**: 設定変更は新規生成のみに反映（過去 `ai_drafts` は再生成しない）で良いか。
6. **多言語**: ガイダンス本文は運用者が任意言語で記述。出力言語は既存の「顧客言語ミラーリング」を維持。

---

## 8. 参考リンク（Web 調査ソース）

設定構成・ペルソナ設計:
- [Fin AI Agent explained — Intercom](https://www.intercom.com/help/en/articles/7120684-fin-ai-agent-explained)
- [Provide Fin AI Agent with specific guidance — Intercom](https://www.intercom.com/help/en/articles/10210126-provide-fin-ai-agent-with-specific-guidance)
- [Customize AI Agent's tone of voice — Gorgias](https://docs.gorgias.com/en-US/customize-ai-agents-tone-of-voice-5413645)
- [Customizing the persona and tone of voice — Zendesk](https://support.zendesk.com/hc/en-us/articles/8357758773658-Customizing-the-persona-and-tone-of-voice-for-your-advanced-AI-agent)
- [Set up brand voice using AI — HubSpot](https://knowledge.hubspot.com/branding/set-up-brand-voice-using-ai)
- [Designing AI Agent Personas: System Prompts — Mindra](https://mindra.co/blog/designing-ai-agent-personas-system-prompts-enterprise)
- [How to write effective AI prompts — Formaloo](https://help.formaloo.com/en/articles/9797669-how-to-write-effective-ai-prompts)
- [Top 6 AI Reply Generator Tools for 2026 — reply.io](https://reply.io/blog/ai-reply-generator-tools/)

会話履歴コンテキスト管理:
- [LLM Chat History Summarization: Best Practices (2025) — mem0](https://mem0.ai/blog/llm-chat-history-summarization-guide-2025)
- [Context Window Management Strategies — apxml](https://apxml.com/courses/langchain-production-llm/chapter-3-advanced-memory-management/context-window-management)
- [Context Window Management Strategies for Long-Context Agents — getmaxim](https://www.getmaxim.ai/articles/context-window-management-strategies-for-long-context-ai-agents-and-chatbots/)
- [Top techniques to Manage Context Lengths in LLMs — agenta](https://agenta.ai/blog/top-6-techniques-to-manage-context-length-in-llms)

Prompt Caching（コスト対策）:
- [Prompt caching — Claude API Docs](https://platform.claude.com/docs/en/build-with-claude/prompt-caching)
- [Prompt caching with Claude — Anthropic](https://claude.com/blog/prompt-caching)
</content>
</invoke>
