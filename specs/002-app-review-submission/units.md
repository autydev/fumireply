---
description: "Unit-level execution plan for Routine implementer. tasks.md の T### を Unit (1 PR 単位) にまとめた索引。"
updated: 2026-05-06
---

# Units: App Review Submission Readiness

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

## Phase 1: Setup (Shared Infrastructure)

| Unit | tasks | scope | deps | files | automation | 概要 |
|------|-------|-------|------|-------|------------|------|
| U1.1 | T001 | infra | none | 0 | auto | ブランチ確認 + npm ci |
| U1.2 | T002–T006 | frontend | U1.1 | ~5 | auto | Paraglide JS インストール + inlang settings + Vite plugin 設定 |
| U1.3 | T007–T009 | infra | none | ~1 | manual | FB App ID env 追加 + Meta App Settings 確認 + Test User 作成 |

## Phase 2: Foundational (Blocking Prerequisites)

| Unit | tasks | scope | deps | files | automation | 概要 |
|------|-------|-------|------|-------|------------|------|
| U2.1 | T010–T013 | frontend | U1.2 | ~4 | auto | Cookie helpers + SSR locale middleware + setLocaleFn |
| U2.2 | T014–T017 | backend | U1.2,U1.3 | ~4 | auto | FB JS SDK loader + Graph API ラッパー + checkConnectedPagesFn + MSW handlers |

## Phase 3: User Story 2 — i18n + LanguageToggle

| Unit | tasks | scope | deps | files | automation | 概要 |
|------|-------|-------|------|-------|------------|------|
| U3.1 | T018–T020 | frontend | U2.1 | ~3 | auto | Cookie helpers / setLocaleFn / SSR locale の統合テスト |
| U3.2 | T021–T024 | frontend | U2.1 | ~2 | auto | 翻訳キー追加（login/inbox/thread/reply）+ Paraglide compile |
| U3.3 | T025–T027 | frontend | U2.1,U3.2 | ~3 | auto | LanguageToggle コンポーネント + Header/Login 組み込み |
| U3.4 | T028–T032 | frontend | U3.2 | ~5 | auto | 既存 JA 文字列を Paraglide m.xxx() 呼び出しに置換 |
| U3.5 | T033 | infra | U3.2 | ~1 | auto | CI に Paraglide compile diff チェック追加 |
| U3.6 | T034 | frontend | U3.3,U3.4 | 0 | manual | EN/JA 切替の手動確認 + screencast スコープ全画面チェック |

## Phase 4: User Story 1 — Connect Facebook Page UI

| Unit | tasks | scope | deps | files | automation | 概要 |
|------|-------|-------|------|-------|------------|------|
| U4.1 | T035–T040 | backend | U2.2 | ~6 | auto | exchangeAndListFn / connectPageFn / guard の統合テスト + E2E |
| U4.2 | T041 | frontend | U3.2 | ~2 | auto | onboarding 翻訳キー追加 + Paraglide compile |
| U4.3 | T042–T043 | backend | U2.2 | ~2 | auto | exchangeAndListFn + connectPageFn server fn 実装 |
| U4.4 | T044–T046 | frontend | U2.2,U4.2 | ~3 | auto | ConnectFacebookButton / PageList / ConnectErrorPanel 実装 |
| U4.5 | T047–T049 | frontend | U4.3,U4.4 | ~3 | auto | /onboarding/connect-page ルート + forward/reverse guard |
| U4.6 | T050 | frontend | U4.5 | 0 | manual | Connect Page フロー手動確認（forward redirect → FB.login → UPSERT → /inbox）|

## Phase 5: User Story 3 — Submission documentation

| Unit | tasks | scope | deps | files | automation | 概要 |
|------|-------|-------|------|-------|------------|------|
| U5.1 | T051–T053 | docs | U3.6,U4.6 | ~3 | manual | use-case-description / screencast-script / reviewer-credentials 最終化 |
| U5.2 | T054–T055 | docs | U5.1,U8.2 | 0 | auto | プレースホルダー残存チェック + URL 200 検証 |

## Phase 6: User Story 4 — Submission walkthrough

| Unit | tasks | scope | deps | files | automation | 概要 |
|------|-------|-------|------|-------|------------|------|
| U6.1 | T056–T057 | docs | U5.1 | ~2 | auto | submission-walkthrough.md 作成 + クロスリンク |
| U6.2 | T058 | docs | U6.1 | 0 | manual | 社内レビュー（第三者ウォークスルー）|

## Phase 7: User Story 5 — Recording prep automation

| Unit | tasks | scope | deps | files | automation | 概要 |
|------|-------|-------|------|-------|------------|------|
| U7.1 | T059–T060 | infra | none | ~2 | auto | prep-screencast.sh + post-screencast.sh |
| U7.2 | T061–T062 | infra | U7.1 | ~1 | auto | 実行テスト + quickstart.md §6 更新 |

## Phase 8: Polish, Deploy, Submit

| Unit | tasks | scope | deps | files | automation | 概要 |
|------|-------|-------|------|-------|------------|------|
| U8.1 | T063–T066 | backend | U3.6,U4.6,U5.1,U6.1,U7.2 | 0 | auto | 全テスト実行 + E2E + CI + Constitution Check |
| U8.2 | T067–T068 | infra | U8.1 | 0 | manual | 本番デプロイ + スモークテスト |
| U8.3 | T069–T072 | docs | U7.1,U8.2 | 0 | manual | prep スクリプト実行 + screencast 撮影 + 編集 + アップロード |
| U8.4 | T073–T075 | infra | U8.3,U5.2 | 0 | manual | URL 200 再確認 + Webhook 確認 + 認証情報確認 |
| U8.5 | T076–T077 | docs | U8.4,U6.2 | ~1 | manual | 申請フォーム提出 + submission ID 記録 |
| U8.6 | T078–T080 | infra | U8.5 | ~1 | manual | post-screencast 実行 + アラーム確認 + レビュータイムライン記録 |

---

## 推奨実行順序 (Routine 選定優先度)

`deps` を満たす ready かつ auto の Unit のうち、以下の優先度で選定:

1. **Critical path 上**: U1.1 → U1.2 → U2.1 → U2.2 → U3.x → U4.x → U5.2 → U6.1 → U7.x → U8.1
2. **並列可能** (deps が同時に解ける): U2.1 と U2.2（deps が異なる）、U3.1/U3.2/U3.3/U3.4/U3.5、U4.1/U4.2/U4.3 等
3. **同点の場合**: Unit ID 昇順

## 自動化スコープ外の Unit (manual)

以下は **Routine が一切触らない**:

- U1.3: FB App Settings 確認 + Test User 作成（外部サービス操作）
- U3.6: EN/JA 手動確認（ブラウザ操作）
- U4.6: Connect Page フロー手動確認
- U5.1: ドキュメント最終化（実装を見てから書く）
- U6.2: 社内レビュー受領
- U8.2: 本番デプロイ（terraform apply 相当）
- U8.3: 撮影・編集
- U8.4: 最終確認（手動操作）
- U8.5: 申請フォーム submit
- U8.6: 後処理（post-screencast + アラーム確認）

これらの Unit は `[ ] T###` のまま残っていても Routine は選定しない。
人間が完了させ `[x]` に書き換える。
