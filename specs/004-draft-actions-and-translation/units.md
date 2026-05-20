---
description: "Unit-level execution plan for Routine implementer. tasks.md の T### を Unit (1 PR 単位) にまとめた索引。"
updated: 2026-05-20
---

# Units: Draft 操作 UX 強化（再生成・破棄・日本語訳）

## 凡例

| 項目 | 意味 |
|------|------|
| `automation: auto` | Routine が実装する (= 1 Unit = 1 PR) |
| `automation: manual` | 人間操作必須。Routine はスキップ (PR を作らない) |
| `scope` | PR タイトルの conventional commit scope |
| `deps` | 着手前提 Unit |

本機能は **14 つの auto PR + 1 つの manual ステップ**で完結する。Routine playbook が U1.1 → U2.1 → (U2.2 / U2.3) → US 各 Unit → Polish の順で 1 PR ずつ発行する。

## 依存グラフ

```
U1.1 Setup
  └─→ U2.1 Schema+Migration
        ├─→ U2.2 Lifecycle filter ──┬─→ U3.1 → U3.2 (US1)
        │                            └─→ U5.3 (US3 app)
        ├─→ U2.3 ai-worker hookpoint ─→ U5.1 (US3 ai-worker)
        └─→ U5.2 Terraform
                                       ↘
   U3.2 → U4.1 → U4.2 (US2)            ↗
                                       
   U3.2,U4.2,U5.3 ─┬─→ U6.1 (paraglide+typecheck)
                  ├─→ U6.2 (E2E)
                  └─→ U6.3 (docs+SQL)
                          ↓
                       U6.4 manual
```

## Phase 1: Setup

| Unit | tasks | scope | deps | files | automation | 概要 |
|------|-------|-------|------|-------|------------|------|
| U1.1 | T001-T003 | infra | none | ~3 | auto | DeepL env loader + SSM Terraform variable + ドキュメント雛形 |

## Phase 2: Foundational

| Unit | tasks | scope | deps | files | automation | 概要 |
|------|-------|-------|------|-------|------------|------|
| U2.1 | T004-T007,T012 | backend | U1.1 | ~5 | auto | DB マイグレーション 0003 + Drizzle schema 同期 + 動作確認 |
| U2.2 | T008-T010 | frontend | U2.1 | ~4 | auto | lifecycle 定数 + getConversation/getDraftStatus の active フィルタ |
| U2.3 | T011 | backend | U2.1 | ~1 | auto | ai-worker handler に translation hookpoint を準備 |

## Phase 3: User Story 1 (破棄)

| Unit | tasks | scope | deps | files | automation | 概要 |
|------|-------|-------|------|-------|------------|------|
| U3.1 | T013-T014 | frontend | U2.2 | ~2 | auto | US1 統合テスト雛形 (discardDraft + lifecycle filter) |
| U3.2 | T015-T019 | frontend | U3.1 | ~5 | auto | US1 実装 (discardDraft fn + DraftActions 破棄 + i18n + ログ) |

## Phase 4: User Story 2 (再生成)

| Unit | tasks | scope | deps | files | automation | 概要 |
|------|-------|-------|------|-------|------------|------|
| U4.1 | T020-T021 | frontend | U3.2 | ~2 | auto | US2 統合テスト雛形 (regenerateDraft + superseded filter) |
| U4.2 | T022-T026 | frontend | U4.1 | ~5 | auto | US2 実装 (regenerateDraft fn + enqueue helper + DraftActions 拡張) |

## Phase 5: User Story 3 (日本語訳)

| Unit | tasks | scope | deps | files | automation | 概要 |
|------|-------|-------|------|-------|------------|------|
| U5.1 | T027-T028,T030-T032 | backend | U2.3 | ~3 | auto | US3 ai-worker (callDeepL + handler 統合 + SSM fetch + unit tests) |
| U5.2 | T033 | infra | U2.1 | ~2 | auto | US3 Terraform (SSM Parameter + ai-worker IAM 権限追加) |
| U5.3 | T029,T034-T040 | frontend | U2.2 | ~8 | auto | US3 app (TranslationToggle + listSettings 拡張 + DraftTranslation + i18n + integration test) |

## Phase 6: Polish

| Unit | tasks | scope | deps | files | automation | 概要 |
|------|-------|-------|------|-------|------------|------|
| U6.1 | T041,T043 | infra | U3.2,U4.2,U5.3 | 0 | auto | paraglide compile + typecheck/lint sweep |
| U6.2 | T042 | frontend | U3.2,U4.2,U5.3 | ~1 | auto | Playwright E2E spec for draft actions (3 シナリオ) |
| U6.3 | T044-T045 | docs | U3.2,U4.2,U5.3 | ~2 | auto | リリースノート + SC-005 集計 SQL サンプル |
| U6.4 | T046 | infra | U6.1,U6.2,U6.3 | 0 | manual | quickstart §4 の手動動作確認 (5 シナリオ) |

## PR 順序 (推奨)

1. **U1.1 (Setup)** — 最初。後続全てが依存
2. **U2.1 (Schema+Migration)** — Foundational のクリティカルパス
3. **U2.2 / U2.3 / U5.2 (並列可)** — U2.1 完了後にこの 3 つは独立に進められる
4. **US1 (U3.1 → U3.2)** — MVP ライン
5. **US2 (U4.1 → U4.2)** — U3.2 後 (DraftActions 拡張のため)
6. **US3 ai-worker (U5.1)** — U2.3 完了後
7. **US3 app (U5.3)** — U2.2 完了後 (U5.1 とは独立に進められる)
8. **Polish (U6.1 / U6.2 / U6.3 並列可)** — 全 US 完了後
9. **U6.4 (manual)** — Routine スキップ、運用者が個別実施

## サイズ目安

| Unit | LOC 概算 | 主な touch エリア |
|------|---------|------|
| U1.1 | ~80 | `ai-worker/src/env.ts`, `terraform/modules/ai-worker-lambda/variables.tf`, `docs/deepl-setup.md` |
| U2.1 | ~150 | `app/src/server/db/migrations/`, `app/src/server/db/schema.ts`, `ai-worker/src/db/schema.ts` |
| U2.2 | ~80 | `app/src/lib/drafts/lifecycle.ts`, `app/src/routes/(app)/threads/$id/-lib/*.ts` |
| U2.3 | ~30 | `ai-worker/src/handler.ts` |
| U3.1 | ~70 | `app/tests/integration/discard-draft.test.ts`, `app/tests/integration/conversation-status-filter.test.ts` |
| U3.2 | ~180 | `app/src/routes/(app)/threads/$id/-lib/discard-draft.fn.ts`, `app/src/routes/(app)/threads/$id/-components/DraftActions.tsx`, `app/messages/{en,ja}.json` |
| U4.1 | ~70 | `app/tests/integration/regenerate-draft.test.ts` |
| U4.2 | ~200 | `app/src/routes/(app)/threads/$id/-lib/regenerate-draft.fn.ts`, `app/src/server/services/enqueue-draft-job.ts`, `app/src/routes/(app)/threads/$id/-components/DraftActions.tsx` |
| U5.1 | ~180 | `ai-worker/src/translation.ts`, `ai-worker/src/handler.ts`, `ai-worker/src/env.ts`, `ai-worker/tests/translation.test.ts` |
| U5.2 | ~30 | `terraform/envs/review/main.tf`, `terraform/modules/ai-worker-lambda/main.tf` |
| U5.3 | ~250 | `app/src/routes/(app)/settings/`, `app/src/routes/(app)/threads/$id/-components/DraftTranslation.tsx`, `app/messages/{en,ja}.json`, `app/tests/integration/translation-toggle.test.ts` |
| U6.1 | 0 | コマンド実行のみ (paraglide compile, typecheck, lint) |
| U6.2 | ~80 | `app/tests/e2e/draft-actions.spec.ts` |
| U6.3 | ~80 | `docs/` or `README.md` + `specs/004-.../analytics-queries.sql` |
| U6.4 | 0 | 手動動作確認のみ |

各 PR が 30-250 LOC の範囲に収まり、レビュアビリティを担保する。U5.3 (app の翻訳 UI 一式) が最大、それ以外は ~200 LOC 以下。

## 注意点

- **U2.1 の tasks 非連続**: tasks.md 上で T004-T007 と T012 は T008-T011 を挟んで分かれている。Routine は `tasks: T004-T007,T012` フィールドを尊重して 5 タスクを 1 PR にまとめる。実装順序は T004 → T005 → T006 → T007 → T012（migration 適用検証は schema 同期の最後に実施）が自然
- **U5.1 / U5.3 の tasks 非連続**: 同様に scope 分離のため非連続範囲を採用。U5.1 (ai-worker) は T027,T028,T030-T032、U5.3 (app) は T029,T034-T040。Routine は `tasks:` フィールドのカンマ列挙を読んで正しい範囲をピックアップする
- **U6.1 の tasks 非連続**: T041 (paraglide) と T043 (typecheck/lint) は T042 (E2E spec) を挟む。3 件とも独立コマンドで衝突しないが、Routine の PR では U6.1 と U6.2 を分けることでスコープを純化
- **U3.2 と U4.2 の同一ファイル衝突**: 両 Unit が `DraftActions.tsx` を編集する。U3.2 マージ後に U4.2 着手する直列運用が安全。並列実装する場合は U4.2 担当が新規ファイル `DraftActionsRegenerate.tsx` を作る逃げ道を採るか、後マージ側で手動コンフリクト解消
- **U6.4 (manual)**: Routine playbook の `automation: manual はスキップ` 規則に従い PR を作らない。`terraform plan` の出力差分検証や DeepL Free 動作の手動確認は `quickstart.md §4` を参照
