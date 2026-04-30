---
description: "Unit-level execution plan for Routine implementer. tasks.md の T### を Unit (1 PR 単位) にまとめた索引。"
updated: 2026-04-30
---

# Units: MVP for Meta App Review Submission

このファイルは Claude Routine (`messenger-app-implementer`) が
**1 Routine 実行 = 1 Unit = 1 PR** で消化するための索引である。

各 Unit のメタデータは `tasks.md` 内の `<!-- unit: ... -->` コメントが正。
本ファイルは実行順序の俯瞰と Routine の探索コスト削減のための要約。

## 凡例

| 項目 | 意味 |
|------|------|
| `automation: auto` | Routine が実装する。コード生成・テスト・PR まで一貫 |
| `automation: manual` | 人間操作必須（外部サービス作成、terraform apply、撮影、申請提出 等）。Routine はスキップ |
| `scope` | PR タイトルの conventional commit scope（`frontend` / `backend` / `infra` / `docs`）|
| `deps` | 当該 Unit 着手の前提となる Unit。すべて完了 (or オープン PR 存在) でなければ実行不可 |
| `files` | 想定ファイル数の概算。10 を超える Unit は分割を検討 |

## 状態カラムの規約

- `done` — Unit 内全 T### が `[x]` または対応する merged PR が存在
- `open-pr` — Unit 名 (例 `U2.2`) を含む open PR が存在
- `ready` — `deps` がすべて `done` または `open-pr`、本 Unit に open PR なし
- `blocked` — `deps` のいずれかが未完了かつ open PR なし

Routine は `ready` の中から自動選定する。`manual` は Routine が選ばない。

---

## Phase 2: Foundational

| Unit | tasks | scope | deps | files | automation | 概要 |
|------|-------|-------|------|-------|------------|------|
| U2.1 | T023, T024 | infra | none | 0 | manual | Supabase プロジェクト + Anthropic API キー作成 |
| U2.2 | T025–T033 | infra | U2.1 | ~9 | auto | Terraform modules 9 種（secrets/queue/4 lambda/static-site/oidc/observability）|
| U2.3 | T034–T037 | infra | U2.2 | ~4 | manual | terraform envs/review wiring + bootstrap + SSM 値投入 + apply |
| U2.4 | T038–T044 | backend | U2.1 | ~6 | auto | Drizzle schema (6 entities) + migration 生成 + RLS 0002_rls.sql + seed |
| U2.5 | T045–T053 | backend | U2.4 | ~14 | auto | env / ssm / crypto / withTenant / messenger / auth / anthropic + 各テスト |
| U2.6 | T054 | infra | U2.4 | 0 | manual | Supabase Auth テストユーザー作成（operator/reviewer）|

## Phase 3: US1 Login + Inbox

| Unit | tasks | scope | deps | files | automation | 概要 |
|------|-------|-------|------|-------|------------|------|
| U3.1 | T055–T061 | backend | U2.5 | ~5 | auto | webhook Lambda（signature verify + DB upsert + SQS enqueue）|
| U3.2 | T062–T067 | frontend | U2.5 | ~6 | auto | Login 画面 + serverFn + logout |
| U3.3 | T068–T071 | frontend | U2.5 | ~4 | auto | Inbox 画面（会話一覧 + unread + 24h 窓）|

## Phase 4: US2 AI Draft + Send Reply

| Unit | tasks | scope | deps | files | automation | 概要 |
|------|-------|-------|------|-------|------------|------|
| U4.1 | T072–T076 | backend | U2.5 | ~5 | auto | AI Worker Lambda（SQS → Anthropic → ai_drafts UPDATE）|
| U4.2 | T077–T085 | frontend | U3.3, U4.1 | ~9 | auto | Thread 詳細 + DraftBanner + ReplyForm + sendReply serverFn |
| U4.3 | T086–T088 | frontend | U3.3 | ~3 | auto | Page Access Token 失効バナー |
| U4.4 | T089–T093 | backend | U3.1, U4.1, U4.2 | ~5 | auto | 統合 / E2E / Worker / Webhook テスト + e2e.yml |

## Phase 5: US3 Public pages + Data deletion

| Unit | tasks | scope | deps | files | automation | 概要 |
|------|-------|-------|------|-------|------------|------|
| U5.1 | T094–T098 | frontend | U2.5 | ~5 | auto | 4 公開ページ + SSG prerender 設定 |
| U5.2 | T099–T103 | backend | U2.4 | ~5 | auto | データ削除コールバック (signed_request) + status ページ |
| U5.3 | T104 | infra | U2.3, U3.1, U4.1 | ~1 | auto | deploy-app.yml（4 Lambda + S3 sync + CloudFront invalidation）|

## Phase 6: US4 Screencast

| Unit | tasks | scope | deps | files | automation | 概要 |
|------|-------|-------|------|-------|------------|------|
| U6.1 | T105–T108 | docs | U3.2, U3.3, U4.2 | ~2 | manual | screencast-script.md + reviewer-credentials.md + 撮影 + 編集 |

## Phase 7: US5 Use Case description

| Unit | tasks | scope | deps | files | automation | 概要 |
|------|-------|-------|------|-------|------------|------|
| U7.1 | T109–T110 | docs | U2.5 | ~1 | manual | use-case-description.md（英語、第三者レビュー込み）|

## Phase 8: Polish & Submission

| Unit | tasks | scope | deps | files | automation | 概要 |
|------|-------|-------|------|-------|------------|------|
| U8.1 | T111 | backend | U2.3 | ~3 | auto | keep-alive Lambda（postgres SELECT 1 + リトライ + SNS）|
| U8.2 | T112 | docs | U2.5 | ~1 | manual | audit-runbook.md（マスター鍵紛失復旧含む）|
| U8.3 | T113–T114 | infra | U2.2 | ~1 | manual | CloudWatch alarms 有効化 + terraform-apply.yml |
| U8.4 | T115–T122 | infra | U5.3, U4.4 | 0 | manual | テスト FB ページ + 長期トークン取得 + 手動スモーク + SLA 検証 + RLS 検証 + URL 検証 |
| U8.5 | T123–T125 | docs | U8.4 | ~1 | manual | 24/7 稼働集計 + quickstart チェック更新 + Meta App Review submit |

---

## 推奨実行順序 (Routine 選定優先度)

`deps` を満たす ready かつ auto の Unit のうち、以下の優先度で選定:

1. **Critical path 上**: U2.2 → U2.4 → U2.5 → U3.1/U3.2/U3.3 → U4.1 → U4.2 → U4.4 → U5.3
2. **並列可能** (deps が同時に解ける): U2.4 と U2.2、U3.x 同士、U4.1 と U4.3 と U5.x 等
3. **同点の場合**: Unit ID 昇順

Routine は `tasks.md` の `[x]` マーカーから完了集合を構築し、上記 ready 判定 + 優先度で
1 件選定して実装する。

## 自動化スコープ外の Unit (manual)

以下は **Routine が一切触らない**:

- U2.1: 外部 SaaS の dashboard 操作（Supabase / Anthropic）
- U2.3: terraform apply の実行 (state を mutate するため人間トリガ必須)
- U2.6: Supabase Admin API でのユーザー作成（パスワードハンドリング）
- U6.1: 動画撮影・編集
- U7.1: 第三者レビュー受領
- U8.2: ランブック（運用知見の言語化、人間が書く）
- U8.3: 本番アラート有効化（誤発火を避けるため人間が判断）
- U8.4: 実機スモーク + 長期トークン取得
- U8.5: 申請フォーム入力 + submit

これらの Unit は `[ ] T###` のまま残っていても Routine は選定しない。
人間が完了させ `[x]` に書き換える。

## Unit 分割・追加のガイドライン

- 1 Unit の実装で **PR diff が +600 行を超えそう** な場合は事前に分割
- `files: ~10` を超える Unit は分割候補
- 新しいタスクを `tasks.md` に追加する場合、既存 Unit に入るか新 Unit を作るか判断し
  対応する `<!-- unit: ... -->` を追加。本ファイルも同期更新する
- `deps` は **逆向き循環禁止**。新規 Unit 追加時は本ファイルで全体を見渡して整合性確認

## メタデータ書式 (tasks.md 内 HTML コメント)

```
<!-- unit: U{phase}.{seq} | deps: U{...},U{...} or none | scope: frontend|backend|infra|docs | tasks: T{NNN}-T{NNN} or T{NNN},T{NNN} | files: ~N or 0 | automation: auto|manual -->
```

- パイプ `|` 区切り、空白許容
- `deps: none` で先行依存なし
- `tasks:` は範囲 (`T025-T033`) または列挙 (`T023,T024`)
- このコメントを書き換えるのは人間のみ。Routine は読み取り専用
