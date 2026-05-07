---
description: "Unit-level execution plan for Routine implementer. tasks.md の T### を Unit (1 PR 単位) にまとめた索引。"
updated: 2026-05-06
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
| `automation: manual` | 人間操作必須（外部サービス作成、Meta App 設定、撮影、申請提出 等）。Routine はスキップ |
| `scope` | PR タイトルの conventional commit scope（`frontend` / `backend` / `infra` / `docs`）|
| `deps` | 当該 Unit 着手の前提となる Unit。すべて完了 (or オープン PR 存在) でなければ実行不可 |
| `files` | 想定ファイル数の概算 |

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
| U1.2 | T002–T006 | frontend | U1.1 | ~5 | auto | Paraglide インストール + inlang 設定 + メッセージ JSON 骨格 + predev/prebuild compile スクリプト |
| U1.3 | T007–T009 | infra | none | ~1 | manual | VITE_FB_APP_ID env 設定 + Meta App Settings 確認 + FB Test User 作成 |

## Phase 2: Foundational (Blocking Prerequisites)

| Unit | tasks | scope | deps | files | automation | 概要 |
|------|-------|-------|------|-------|------------|------|
| U2.1 | T010–T013 | frontend | U1.2 | ~4 | auto | Cookie i18n helpers + SSR locale middleware + setLocaleFn server fn |
| U2.2 | T014–T017 | backend | U1.2,U1.3 | ~4 | auto | Facebook JS SDK loader + Graph API wrapper + checkConnectedPages fn + MSW handlers |

## Phase 3: US2 — i18n + LanguageToggle

| Unit | tasks | scope | deps | files | automation | 概要 |
|------|-------|-------|------|-------|------------|------|
| U3.1 | T018–T020 | frontend | U2.1 | ~3 | auto | Cookie helpers / setLocaleFn / SSR locale の Unit テスト |
| U3.2 | T021–T024 | frontend | U2.1 | ~2 | auto | 翻訳キー追加（login/inbox/thread/reply）+ paraglide compile |
| U3.3 | T025–T027 | frontend | U2.1,U3.2 | ~3 | auto | LanguageToggle コンポーネント + Header/Login への挿入 |
| U3.4 | T028–T032 | frontend | U3.2 | ~5 | auto | 既存 JA ハードコード文字列を m.xxx() 呼び出しへ置換 |
| U3.5 | T033 | infra | U3.2 | ~1 | auto | CI に paraglide-js compile diff チェックを追加（未コンパイル状態を PR で検出）|
| U3.6 | T034 | frontend | U3.3,U3.4 | 0 | manual | LanguageToggle screencast 撮影 |

## Phase 4: US1 — Connect Page UI

| Unit | tasks | scope | deps | files | automation | 概要 |
|------|-------|-------|------|-------|------------|------|
| U4.1 | T035–T040 | backend | U2.2 | ~6 | auto | connectPage server fn（exchange/list/subscribe）+ Unit テスト |
| U4.2 | T041 | frontend | U3.2 | ~2 | auto | ConnectPage route + 翻訳キー |
| U4.3 | T042–T043 | backend | U2.2 | ~2 | auto | forward guard (未接続→Connect) + reverse guard (接続済→Inbox) |
| U4.4 | T044–T046 | frontend | U2.2,U4.2 | ~3 | auto | ConnectPage UI（FB Login Button + ページ選択ドロップダウン）|
| U4.5 | T047–T049 | frontend | U4.3,U4.4 | ~3 | auto | guard を route loader に組み込み + E2E-lite テスト |
| U4.6 | T050 | frontend | U4.5 | 0 | manual | Connect Page フロー screencast 撮影 |

## Phase 5: Submission Docs Prep

| Unit | tasks | scope | deps | files | automation | 概要 |
|------|-------|-------|------|-------|------------|------|
| U5.1 | T051–T053 | docs | U3.6,U4.6 | ~3 | manual | screencast 録画 + Data Deletion Callback URL 確認 + プライバシーポリシー確認 |
| U5.2 | T054–T055 | docs | U5.1,U8.2 | 0 | auto | App Review 申請フォーム記入チェック + submission checklist 自動検証 |

## Phase 6: Test User Walkthrough

| Unit | tasks | scope | deps | files | automation | 概要 |
|------|-------|-------|------|-------|------------|------|
| U6.1 | T056–T057 | docs | U5.1 | ~2 | auto | Test User 操作手順書 + 申請テスト手順 |
| U6.2 | T058 | docs | U6.1 | 0 | manual | Meta App Review 申請提出 |

## Phase 7: Screencast Support Scripts

| Unit | tasks | scope | deps | files | automation | 概要 |
|------|-------|-------|------|-------|------------|------|
| U7.1 | T059–T060 | infra | none | ~2 | auto | screencast 補助スクリプト（seed + reset）|
| U7.2 | T061–T062 | infra | U7.1 | ~1 | auto | keep-alive ping スクリプト + cron 設定 |

## Phase 8: Final Review Submission

| Unit | tasks | scope | deps | files | automation | 概要 |
|------|-------|-------|------|-------|------------|------|
| U8.1 | T063–T066 | backend | U3.6,U4.6,U5.1,U6.1,U7.2 | 0 | auto | 本番動作確認スクリプト実行 + ログ確認 |
| U8.2 | T067–T068 | infra | U8.1 | 0 | manual | 本番 terraform apply + DNS / SSL 確認 |
| U8.3 | T069–T072 | docs | U7.1,U8.2 | 0 | manual | App Review 申請書類最終確認 |
| U8.4 | T073–T075 | infra | U8.3,U5.2 | 0 | manual | App Review 申請提出 |
| U8.5 | T076–T077 | docs | U8.4,U6.2 | ~1 | manual | 申請完了通知 + 差し戻し対応準備 |
| U8.6 | T078–T080 | infra | U8.5 | ~1 | manual | 本番リリース後の後処理 |
