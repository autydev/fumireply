# Copilot レビュー指針 (autydev/fumireply)

## 応答言語

**すべてのレビューコメントを日本語で記述してください。** PR summary、行コメント、change suggestions の説明文、すべて日本語。コードブロック内のコメント・識別子は元コードに合わせる（既存が英語なら英語のまま）。レビュー対象の文書（spec.md 等）が日本語であるため、レビュー応答も日本語で統一する。

このリポジトリの PR を Copilot がレビューするときの前提と観点。

## このリポについて

- **目的**: Meta App Review 提出向け MVP (Messenger 顧客対応自動化)
- **Stack**: TanStack Start (PWA, file-based routing) on AWS Lambda + Supabase (Postgres + RLS) + Anthropic API (Claude Haiku)
- **Lambda 構成**: `app/` (TanStack Start SSR) / `webhook/` (Meta Webhook 受信) / `ai-worker/` (SQS → Anthropic) / `keep-alive/` (Supabase ping)
- **マルチテナント前提**: 全 DB アクセスは `withTenant(tenantId, fn)` トランザクションで囲み、RLS ポリシー (`tenant_isolation`) を DB レイヤで担保する
- **Page Access Token** は AES-256-GCM で暗号化し `connected_pages.page_access_token_encrypted` (bytea) に保存。マスター鍵は SSM `/fumireply/master-encryption-key`
- **パッケージマネージャは npm のみ** (pnpm/yarn 禁止 per `specs/001-mvp-app-review/plan.md`)
- **HTTP クライアントは fetch のみ** (axios 系の新規導入禁止)
- 詳細仕様は `specs/001-mvp-app-review/{spec,plan,data-model,infrastructure,research,quickstart}.md` および `contracts/` 配下

## 重点的にレビューしてほしい点

### マルチテナント / RLS
- DB アクセスが `withTenant(tenantId, fn)` 経由になっているか
- service role 接続 (`dbAdmin`) の使用が「webhook の page_id → tenant_id 解決」「migration」等のシステム操作に限定されているか
- INSERT 時に `tenant_id` が明示的にセットされているか (RLS の WITH CHECK が通る)
- 別テナントの行を SELECT/UPDATE/DELETE できる経路がないか

### Secret 漏洩
- env var, SSM 値, Page Access Token (復号後の平文), Anthropic API キーが `console.log` / エラーメッセージ / レスポンスボディに含まれていないか
- エラーレスポンスで internal な詳細を露出していないか
- テストで実値を hard-code していないか (`.env.example` の dummy 値を使う)

### 外部 API 呼び出し
- Meta Send API / Anthropic API / Supabase 呼び出しに **timeout** (`AbortSignal.timeout(...)`) があるか
- 指数バックオフ付きリトライがあるか (Meta: 3 回 / Anthropic: 3 回)
- Meta API のエラーコードが `contracts/meta-send-api.md` の分類 (`token_expired` / `outside_window` / `meta_error`) にマップされているか

### Webhook セキュリティ
- HMAC-SHA256 検証で `crypto.timingSafeEqual` を使っているか (`===` での比較は NG)
- `X-Hub-Signature-256` の prefix `sha256=` を取り除いてから比較しているか
- signed_request (data-deletion callback) の署名検証も同様

### Lambda / SSR の特性
- Lambda コンテナ再利用前提でのモジュールレベル状態管理 (SSM キャッシュ等) が race condition に強いか
- `app/src/server/**/*.ts` (server-only) と client/isomorphic コードの境界が守られているか
- TanStack Start の serverFn から secret を返り値に含めていないか

### TanStack Start 固有
- `createFileRoute` の `ssr` オプション (`ssr: false` は login のみ等) が仕様通りか
- `loader` で重い処理を直列にしていないか
- `validateSearch` で zod / valibot を使っているか

## 過剰反応しないでほしい点 (false positive 抑制)

- **zod でバリデーション済み**の値への追加 null / undefined チェック提案
- early return の位置スタイル (fail-fast vs validation accumulation はチームで意図して使い分け)
- import 順序・コメント文言・命名の細かい指摘 (eslint + prettier で別途チェック済み)
- テストファイルの `any` 型 (テストは型より挙動優先)
- `console.log` のテストコード内利用
- "should add try/catch here" 系の汎用提案 (上位で集約処理しているケースが多い)

## レビュー対象外 (触らないでほしい)

- `specs/001-mvp-app-review/**/*.md` (spec 系) — 設計判断は人間が行う領域
- `app/src/routeTree.gen.ts` — TanStack Router 自動生成
- `app/src/server/db/migrations/*.sql` — drizzle-kit 自動生成 (RLS の `0002_rls.sql` は手書きなので別途レビュー対象)
- `terraform/.terraform.lock.hcl`
- `package-lock.json` (各サブパッケージ)

## PR タイトル規約 (参考)

`{type}({scope}): U{phase}.{seq} {日本語タイトル}`

例: `feat(infra): U2.2 Terraform modules 9 種`

`{scope}` = `frontend` / `backend` / `infra` / `docs`。Routine が作る PR は `tasks.md` の `<!-- unit -->` メタデータの `scope` 値を使用。

## Routine 経由の PR について

Claude Routine (`messenger-app-implementer`) が自動実装した PR は、PR 本文に `[review-rounds] N/10` カウンタが入る。Copilot のレビューコメントに対しては Routine が同セッション内で機械的に対応 (修正コミット → 返信 → resolve) するため、以下を意識:

- **本質的な指摘**を優先する (汎用 nit は Routine がそのまま受け入れて 1 ラウンド消費する)
- セキュリティ / マルチテナント分離 / secret 漏洩は厳しく
- 「もっと抽象化したら」「ここを共通化したら」系は Unit スコープ外なので **指摘しない**
