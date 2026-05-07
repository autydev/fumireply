---
description: "Unit-level execution plan for Routine implementer. tasks.md の T### を Unit (1 PR 単位) にまとめた索引。"
updated: 2026-05-07
---

# Units: App Review Submission Readiness

このファイルは Claude Routine が
**1 Routine 実行 = 1 Unit = 1 PR** で消化するための索引である。

各 Unit のメタデータは `tasks.md` 内の `<!-- unit: ... -->` コメントが正。
本ファイルは実行順序の俯瞰と Routine の探索コスト削減のための要約。

## 凡例

| 項目 | 意味 |
|------|------|
| `automation: auto` | Routine が実装する。コード生成・テスト・PR まで一貫 |
| `automation: manual` | 人間操作必須（外部サービス作成、撮影、申請提出 等）。Routine はスキップ |
| `scope` | PR タイトルの conventional commit scope（`frontend` / `backend` / `infra` / `docs`）|
| `deps` | 当該 Unit 着手の前提となる Unit。すべて完了 (or オープン PR 存在) でなければ実行不可 |
| `files` | 想定ファイル数の概算 |

## Phase 1: Setup (Shared Infrastructure)

| Unit | tasks | scope | deps | files | automation | 概要 |
|------|-------|-------|------|-------|------------|------|
| U1.1 | T001 | infra | none | 0 | auto | ブランチ確認 + npm ci |
| U1.2 | T002-T006 | frontend | U1.1 | ~5 | auto | Paraglide インストール + project.inlang 設定 + messages スケルトン + Vite plugin |
| U1.3 | T007-T009 | infra | none | ~1 | manual | FB App ID env 追加 + Meta App Settings 確認 + Test User/Page 作成 |

## Phase 2: Core Infrastructure (i18n + FB SDK)

| Unit | tasks | scope | deps | files | automation | 概要 |
|------|-------|-------|------|-------|------------|------|
| U2.1 | T010-T013 | frontend | U1.2 | ~4 | auto | Cookie locale helpers + SSR middleware + setLocaleFn server fn |
| U2.2 | T014-T017 | backend | U1.2,U1.3 | ~4 | auto | Facebook JS SDK loader + Graph API wrapper + checkConnectedPagesFn + MSW handlers |

## Phase 3: Tests + Translation Keys + LanguageToggle

| Unit | tasks | scope | deps | files | automation | 概要 |
|------|-------|-------|------|-------|------------|------|
| U3.1 | T018-T020 | frontend | U2.1 | ~3 | auto | i18n テスト（Cookie helpers / setLocaleFn / SSR locale 解決）|
| U3.2 | T021-T024 | frontend | U2.1 | ~2 | auto | 翻訳キー追加（login / inbox / thread+reply）+ paraglide compile |
| U3.3 | T025-T027 | frontend | U2.1,U3.2 | ~3 | auto | LanguageToggle コンポーネント + Header/Login 挿入 |
| U3.4 | T028-T032 | frontend | U3.2 | ~5 | auto | 既存画面の JA ハードコード文字列を Paraglide calls に置換 |
| U3.5 | T033 | infra | U3.2 | ~1 | auto | CI に Paraglide compile diff チェック追加 |
| U3.6 | T034 | frontend | U3.3,U3.4 | 0 | manual | 手動テスト: EN/JA toggle 全画面検証 |

## Phase 4: Connect Page UI (US1)

| Unit | tasks | scope | deps | files | automation | 概要 |
|------|-------|-------|------|-------|------------|------|
| U4.1 | T035-T040 | backend | U2.2 | ~6 | auto | Connect Page server fn テスト群（exchangeAndList / connectPage / guard / cross-tenant / E2E）|
| U4.2 | T041 | frontend | U3.2 | ~2 | auto | onboarding 翻訳キー追加 + compile |
| U4.3 | T042-T043 | backend | U2.2 | ~2 | auto | exchangeAndListFn + connectPageFn 実装 |
| U4.4 | T044-T046 | frontend | U2.2,U4.2 | ~3 | auto | ConnectFacebookButton / PageList / ConnectErrorPanel コンポーネント |
| U4.5 | T047-T049 | frontend | U4.3,U4.4 | ~3 | auto | /onboarding/connect-page route + forward/reverse guard |
| U4.6 | T050 | frontend | U4.5 | 0 | manual | 手動テスト: onboarding フロー全体確認 |

## Phase 5: Submission Docs Verification (US3)

| Unit | tasks | scope | deps | files | automation | 概要 |
|------|-------|-------|------|-------|------------|------|
| U5.1 | T051-T053 | docs | U3.6,U4.6 | ~3 | manual | 申請ドキュメント更新（use-case-description / screencast-script / reviewer-credentials）|
| U5.2 | T054-T055 | docs | U5.1,U8.2 | 0 | auto | プレースホルダー残存チェック + URL 200 確認 |

## Phase 6: Submission Walkthrough Doc (US4)

| Unit | tasks | scope | deps | files | automation | 概要 |
|------|-------|-------|------|-------|------------|------|
| U6.1 | T056-T057 | docs | U5.1 | ~2 | auto | submission-walkthrough.md 作成 + quickstart.md / reviewer-credentials.md クロスリンク |
| U6.2 | T058 | docs | U6.1 | 0 | manual | 社内レビュー（Meta App Dashboard ウォークスルー）|

## Phase 7: Screencast Prep Scripts (US5)

| Unit | tasks | scope | deps | files | automation | 概要 |
|------|-------|-------|------|-------|------------|------|
| U7.1 | T059-T060 | infra | none | ~2 | auto | prep-screencast.sh + post-screencast.sh 作成 |
| U7.2 | T061-T062 | infra | U7.1 | ~1 | auto | --dry-run テスト + quickstart.md ドキュメント |

## Phase 8: Final Verification & Submission

| Unit | tasks | scope | deps | files | automation | 概要 |
|------|-------|-------|------|-------|------------|------|
| U8.1 | T063-T066 | backend | U3.6,U4.6,U5.1,U6.1,U7.2 | 0 | auto | 全テスト実行確認 + CI 通過 + Constitution Check |
| U8.2 | T067-T068 | infra | U8.1 | 0 | manual | 本番デプロイ + スモークテスト |
| U8.3 | T069-T072 | docs | U7.1,U8.2 | 0 | manual | prep-screencast.sh 本番実行 + 撮影 + 編集 + YouTube アップロード |
| U8.4 | T073-T075 | infra | U8.3,U5.2 | 0 | manual | URL 200 再確認 + E2E 再実行 + 手動スモーク |
| U8.5 | T076-T077 | docs | U8.4,U6.2 | ~1 | manual | Meta App Dashboard フォーム入力 + Submit |
| U8.6 | T078-T080 | infra | U8.5 | ~1 | manual | post-screencast.sh 実行 + 申請後 audit |

---

## 推奨実行順序 (Routine 選定優先度)

`deps` を満たす ready かつ auto の Unit のうち、以下の優先度で選定:

1. **Critical path 上**: U1.1 → U1.2 → U2.1 → U3.2 → U3.1/U3.3/U3.4/U3.5 → U4.1/U4.2/U4.3 → U4.4 → U4.5 → U8.1
2. **並列可能**: U2.1 と U2.2、U3.1/U3.2 同士、U4.1/U4.2/U4.3 同士
3. **同点の場合**: Unit ID 昇順

## 自動化スコープ外の Unit (manual)

- U1.3: Meta App Settings 手動確認 + Test User/Page 作成
- U3.6: 手動ブラウザテスト
- U4.6: 手動テスト（FB Test User 実機確認）
- U5.1: ドキュメント更新（人間が書く）
- U6.2: 社内レビュー
- U8.2: 本番デプロイ（state を mutate するため人間トリガ必須）
- U8.3: 撮影・編集
- U8.4: 実機スモーク
- U8.5: 申請フォーム入力 + submit
- U8.6: 申請後 audit

## メタデータ書式 (tasks.md 内 HTML コメント)

```
<!-- unit: U{phase}.{seq} | deps: U{...},U{...} or none | scope: frontend|backend|infra|docs | tasks: T{NNN}-T{NNN} or T{NNN},T{NNN} | files: ~N or 0 | automation: auto|manual -->
```
