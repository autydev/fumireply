---
description: "Unit-level execution plan for Routine implementer. tasks.md の T### を Unit (1 PR 単位) にまとめた索引。"
updated: 2026-05-07
---

# Units: App Review Submission Readiness

## 凡例

| 項目 | 意味 |
|------|------|
| `automation: auto` | Routine が実装する |
| `automation: manual` | 人間操作必須。Routine はスキップ |
| `scope` | PR タイトルの conventional commit scope |
| `deps` | 着手前提 Unit |

## Phase 1: Setup

| Unit | tasks | scope | deps | files | automation | 概要 |
|------|-------|-------|------|-------|------------|------|
| U1.1 | T001 | infra | none | 0 | auto | npm ci verify |
| U1.2 | T002-T006 | frontend | U1.1 | ~5 | auto | Paraglide JS セットアップ |
| U1.3 | T007-T009 | infra | none | ~1 | manual | FB App 設定 + Test User 作成 |

## Phase 2: Foundational

| Unit | tasks | scope | deps | files | automation | 概要 |
|------|-------|-------|------|-------|------------|------|
| U2.1 | T010-T013 | frontend | U1.2 | ~4 | auto | Cookie locale helpers + SSR middleware + setLocaleFn |
| U2.2 | T014-T017 | backend | U1.2,U1.3 | ~4 | auto | FB JS SDK + Graph API wrapper + guard fn + MSW handlers |

## Phase 3: US2 — i18n + LanguageToggle

| Unit | tasks | scope | deps | files | automation | 概要 |
|------|-------|-------|------|-------|------------|------|
| U3.1 | T018-T020 | frontend | U2.1 | ~3 | auto | locale i18n integration tests |
| U3.2 | T021-T024 | frontend | U2.1 | ~2 | auto | 翻訳キー追加（login/inbox/thread/reply）|
| U3.3 | T025-T027 | frontend | U2.1,U3.2 | ~3 | auto | LanguageToggle component + Header/Login 挿入 |
| U3.4 | T028-T032 | frontend | U3.2 | ~5 | auto | JA strings → Paraglide m.xxx() calls |
| U3.5 | T033 | infra | U3.2 | ~1 | auto | Paraglide compile diff check を CI に追加 |
| U3.6 | T034 | frontend | U3.3,U3.4 | 0 | manual | EN/JA 手動動作確認 |

## Phase 4: US1 — Connect Facebook Page UI

| Unit | tasks | scope | deps | files | automation | 概要 |
|------|-------|-------|------|-------|------------|------|
| U4.1 | T035-T040 | backend | U2.2 | ~6 | auto | server fn integration + E2E tests |
| U4.2 | T041 | frontend | U3.2 | ~2 | auto | onboarding 翻訳キー追加 |
| U4.3 | T042-T043 | backend | U2.2 | ~2 | auto | exchangeAndListFn + connectPageFn server fns |
| U4.4 | T044-T046 | frontend | U2.2,U4.2 | ~3 | auto | ConnectFacebookButton + PageList + ConnectErrorPanel |
| U4.5 | T047-T049 | frontend | U4.3,U4.4 | ~3 | auto | onboarding route + guards |
| U4.6 | T050 | frontend | U4.5 | 0 | manual | 手動動作確認 |

## Phase 5: US3 — Submission documentation

| Unit | tasks | scope | deps | files | automation | 概要 |
|------|-------|-------|------|-------|------------|------|
| U5.1 | T051-T053 | docs | U3.6,U4.6 | ~3 | manual | use-case-description + screencast-script + reviewer-credentials 最終化 |
| U5.2 | T054-T055 | docs | U5.1,U8.2 | 0 | auto | placeholder 0件確認 + URL 200 確認 |

## Phase 6: US4 — Submission walkthrough

| Unit | tasks | scope | deps | files | automation | 概要 |
|------|-------|-------|------|-------|------------|------|
| U6.1 | T056-T057 | docs | U5.1 | ~2 | auto | submission-walkthrough.md 作成 + クロスリンク |
| U6.2 | T058 | docs | U6.1 | 0 | manual | 内部レビュー |

## Phase 7: US5 — Recording prep automation

| Unit | tasks | scope | deps | files | automation | 概要 |
|------|-------|-------|------|-------|------------|------|
| U7.1 | T059-T060 | infra | none | ~2 | auto | prep/post-screencast bash scripts |
| U7.2 | T061-T062 | infra | U7.1 | ~1 | auto | test-prep.sh + quickstart §6 ドキュメント |

## Phase 8: Polish, Deploy, Submit

| Unit | tasks | scope | deps | files | automation | 概要 |
|------|-------|-------|------|-------|------------|------|
| U8.1 | T063-T066 | backend | U3.6,U4.6,U5.1,U6.1,U7.2 | 0 | auto | 全テスト実行 + CI 確認 + Constitution Check |
| U8.2 | T067-T068 | infra | U8.1 | 0 | manual | Deploy + production smoke |
| U8.3 | T069-T072 | docs | U7.1,U8.2 | 0 | manual | prep script 実行 + screencast 撮影・編集 |
| U8.4 | T073-T075 | infra | U8.3,U5.2 | 0 | manual | 最終 pre-submit 確認 |
| U8.5 | T076-T077 | docs | U8.4,U6.2 | ~1 | manual | Meta App Review submit |
| U8.6 | T078-T080 | infra | U8.5 | ~1 | manual | post-submit 後処理 |
