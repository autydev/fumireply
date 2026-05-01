---
name: sync-merged-tasks
description: マージ済み PR タイトルから Unit 番号 (U<major>.<minor> 形式、例 U2.5 / U3.1 / U4.2 など) を抽出し、対応する tasks.md の T### チェックボックスを [x] に更新する。ユーザーが「マージ済み PR を tasks.md に反映」「タスクのチェックを更新」等と依頼したとき使う。
---

# sync-merged-tasks

このスキルは実作業を `sync-merged-tasks` サブエージェント (Haiku 固定) に委譲する。

## 手順

Agent ツールを以下のパラメータで起動するだけ:

- `subagent_type`: `sync-merged-tasks`
- `description`: `Sync merged PRs to tasks.md`
- `prompt`: `マージ済み PR を走査し、specs/001-mvp-app-review/tasks.md の対応 T### チェックボックスを [x] に更新してください。手順とフォーマットはエージェント定義に従ってください。コミットはしないでください。`

サブエージェントの返却サマリをそのままユーザーに表示する。
