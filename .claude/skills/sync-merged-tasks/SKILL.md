---
name: sync-merged-tasks
description: マージ済み PR タイトルから Unit 番号 (U<major>.<minor> 形式、例 U2.5 / U3.1 / U4.2 など) を抽出し、対応する tasks.md の T### チェックボックスを [x] に更新する。ユーザーが「マージ済み PR を tasks.md に反映」「タスクのチェックを更新」等と依頼したとき使う。
---

# sync-merged-tasks

このスキルは実作業を `sync-merged-tasks` サブエージェント (Haiku 固定) に委譲する。
**重要**: 過去 feature の PR が現 feature の同名 Unit 番号に誤マッチしないよう、対象 `tasks.md` の初回コミット日でフィルタする。エージェント側でその処理を行うので、呼び出し元は対象 `tasks.md` のパスを正しく渡すだけでよい。

## 手順

### 1. 対象 tasks.md パスを解決

優先順位:

1. **`ARGUMENTS` に明示されていれば最優先**
   - 例: `/sync-merged-tasks specs/002-app-review-submission/tasks.md`
   - 渡されたパスが存在しなければエラーを返す。

2. **CLAUDE.md の "Active feature plan" から導出**
   - `grep -E 'Active feature plan.*specs/[^/]+/plan\.md' CLAUDE.md` で行を取得
   - その行から `specs/<feature>/plan.md` を抽出し、`specs/<feature>/tasks.md` をパスとする。
   - そのファイルが存在しなければエラー。

3. **どちらも無ければ `specs/` 配下を探索**
   - `ls specs/` で 1 件しかなければそれを採用。複数あれば「どの feature を対象にするか」をユーザーに質問し、勝手に選ばない。

### 2. Agent を起動

解決したパスを `<tasks-md-path>` として埋め込み、Agent ツールを以下のパラメータで起動する:

- `subagent_type`: `sync-merged-tasks`
- `description`: `Sync merged PRs to tasks.md`
- `prompt`:
  ```
  対象 tasks.md: <tasks-md-path>

  上記の tasks.md に対してマージ済み PR を走査し、対応 T### チェックボックスを [x] に更新してください。
  feature 開始日（対象 tasks.md の初回コミット日）以降にマージされた PR のみを対象とし、
  それ以前のマージは除外してください。手順とフォーマットはエージェント定義に従ってください。
  コミットはしないでください。
  ```

### 3. サマリ表示

サブエージェントの返却サマリをそのままユーザーに表示する。
ユーザーが diff を見たい場合は `git diff <tasks-md-path>` を案内する。コミットは自動で行わない。

## トラブルシュート

- **マージ済み PR が 1 件もマッチしない**: 対象 tasks.md の初回コミットがまだローカルにあるだけで push されていない可能性。`git log -- <tasks-md-path>` で確認。
- **誤マッチが出る**: feature 開始日フィルタを通っても同 Unit 番号が衝突する場合は、出力の「除外した PR」と「対象に含めた PR」をユーザーに目視確認してもらう。逆方向（[x] → [ ]）の自動補正はしない。
- **`gh` 未認証**: `gh auth status` をユーザーに案内。
