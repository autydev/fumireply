---
description: "Unit-level execution plan for Routine implementer. tasks.md の T### を 4 つの auto PR Unit にまとめた索引 (+ 1 manual ステップ)。"
updated: 2026-05-20
---

# Units: 会話コンテキストの永続化と設定の階層化

## 凡例

| 項目 | 意味 |
|------|------|
| `automation: auto` | Routine が実装する (= 1 Unit = 1 PR) |
| `automation: manual` | 人間操作必須。Routine はスキップ (PR を作らない) |
| `scope` | PR タイトルの conventional commit scope |
| `deps` | 着手前提 Unit |

本機能は **4 つの auto PR + 1 つの manual ステップ**で完結する。Routine playbook が U1.1 → U2.1 / U3.1 (並列可) → U4.1 → U5.1 (manual) の順で 1 PR ずつ発行する。

## 依存グラフ

```
U1.1 Foundation
  ├─→ U2.1 Settings (US1)        [並列可]
  └─→ U3.1 CustomerPanel (US2)   [並列可]
              └─→ U4.1 Summary Pipeline + Polish (US3)
                       └─→ U5.1 Manual verification (out-of-PR)
```

## Unit 一覧

| Unit | tasks | scope | deps | files | automation | 概要 |
|------|-------|-------|------|-------|------------|------|
| U1.1 | T001-T017 | backend | none | ~10 | auto | Foundation: DB マイグレーション 6 列 + ai-worker prompt 5 段合成リファクタ + UI 共通部品 (AutoSaveBadge / i18n キー雛形 / 3 カラム CSS) + 回帰テスト |
| U2.1 | T018-T027 | frontend | U1.1 | ~7 | auto | Settings PR: listSettings/updatePagePrompt server fn + `/settings` route + 4 components + サイドバーリンク差替 + 翻訳 + E2E |
| U3.1 | T028-T039 | frontend | U1.1 | ~9 | auto | CustomerPanel PR: getConversation 拡張 + updateConversationSettings fn + 5 components + threads 3 カラム化 + 翻訳 + E2E |
| U4.1 | T040-T055,T058-T060 | backend | U1.1,U3.1 | ~13 | auto | Summary Pipeline PR: Terraform SQS + IAM/env + maybeEnqueueSummaryJob + buildSummaryPrompt + processSummaryJob + AiPersonaSummary 本実装 + E2E + 一括 polish (lint/typecheck/test/paraglide/docs) |
| U5.1 | T056-T057 | infra | U4.1 | 0 | manual | Manual verification: terraform plan 目視 + SC-007 (全 NULL 回帰) 手動確認。Routine はスキップ、運用者が U4.1 マージ後に個別実施 |

## PR 順序 (推奨)

1. **U1.1 (Foundation)** — 必ず最初。クリティカルパス
2. **U2.1 (Settings)** または **U3.1 (CustomerPanel)** — どちらからでも可、並列マージも可能
3. **U4.1 (Summary Pipeline + Polish)** — U3.1 マージ後 (AiPersonaSummary placeholder 必須)
4. **U5.1 (Manual)** — U4.1 マージ後、運用者の手動操作

## サイズ目安

| Unit | LOC 概算 | 主な touch エリア |
|------|---------|------|
| U1.1 | ~500 | `app/src/server/db/`, `ai-worker/src/`, `app/src/lib/`, `app/src/routes/(app)/-components/`, `app/messages/` |
| U2.1 | ~250 | `app/src/routes/(app)/settings/`, `app/src/routes/(app)/route.tsx`, `app/messages/`, `app/tests/` |
| U3.1 | ~350 | `app/src/routes/(app)/threads/$id/`, `app/messages/`, `app/tests/` |
| U4.1 | ~450 | `terraform/`, `ai-worker/src/`, `webhook/src/`, `app/src/server/`, `app/src/routes/(app)/threads/$id/-components/`, `docs/`, `app/tests/` |

各 PR が 250-500 LOC の範囲に収まり、レビュアビリティを担保する。

## 注意点

- **U4.1 の deps**: `U1.1, U3.1` と書いているが、厳密には `U1.1` のみ + 「U3.1 のうち `AiPersonaSummary.tsx` の placeholder が touch されていること」が条件。Routine playbook は単純な Unit 単位依存しか扱わないため U3.1 全体に依存させる保守的な指定にしている
- **U2.1 と U3.1 の並列マージ**: 両者は touch ファイル群が完全分離 (Settings 配下 / threads 配下) で衝突しない。ただし `app/messages/{en,ja}.json` を両者が編集するため、後マージ側で軽い conflict 解消が必要になる可能性あり。Routine の通常運用ではマージ順を逐次化する方が安全
- **U5.1 (manual)**: Routine playbook の `automation: manual はスキップ` 規則に従い PR を作らない。`terraform plan` の出力差分検証と SC-007 (全 NULL でのドラフト回帰) を手動で確認する手順は `quickstart.md §5` と `spec.md §SC-007` を参照
