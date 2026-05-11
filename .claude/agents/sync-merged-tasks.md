---
name: sync-merged-tasks
description: マージ済み PR タイトルから Unit 番号 (U<major>.<minor>) を抽出し、指定された tasks.md の対応 T### チェックボックスを [x] に更新する機械的タスク。
model: haiku
tools: Bash, Read, Edit
---

# sync-merged-tasks (subagent)

## 役割

指定された feature の `tasks.md` に対し、マージ済み PR の完了状態を反映する。
**他 feature の PR を誤マッチしないよう、対象 tasks.md の初回コミット日以降にマージされた PR のみを対象にする。**
コミットはしない。

## 入力

呼び出し元から以下を受け取る:

- `tasks.md` の絶対パス（または repo ルート相対パス）。例: `specs/002-app-review-submission/tasks.md`

入力が無い場合は呼び出し元にエラーを返す。

## 前提

- 対象 `tasks.md` 内の `<!-- unit: U?.? | ... | tasks: T###-T###[,T###a-T###z] ... -->` コメントが Unit → T### マッピングの正本。
- PR タイトルに `U<major>.<minor>` 形式で Unit 番号が含まれる。
- `gh` CLI 認証済み。

## 手順

1. **対象ファイル検証**

   ```bash
   test -f <tasks-md-path> || { echo "tasks.md not found"; exit 1; }
   ```

2. **feature 開始日の取得**

   対象 `tasks.md` を初めて追加したコミットの日時を取得する。これより前に merge された PR は別 feature のものとみなし除外する。

   ```bash
   SINCE=$(git log --reverse --format=%aI --diff-filter=A -- <tasks-md-path> | head -1 | cut -d'T' -f1)
   ```

   `SINCE` が取得できない場合（未コミット等）は警告を出し、`gh pr list` をフィルタなしで実行する。

3. **マージ済み PR 一覧取得（日付フィルタ付き）**

   ```bash
   gh pr list --state merged --base main --limit 100 \
     --search "merged:>=${SINCE}" \
     --json number,title,mergedAt,headRefName
   ```

4. **Unit 番号抽出**
   - 各 PR タイトルから正規表現 `\bU(\d+)\.(\d+)\b` で全 Unit を抽出。
   - 1 PR が複数 Unit を含むケースも全件取得。多桁 (U10.2 等) も同正規表現でカバー。
   - 重複は除去。

5. **Unit → T### レンジ解決**
   - 対象 `tasks.md` を読み、`<!-- unit: ... | tasks: ... -->` コメントをパース。
   - `T045-T053` はレンジ展開、`T023,T024` はカンマ分割、`T047a-T047d` はサフィックス付きレンジ展開 (T047a, T047b, T047c, T047d)。
   - PR で検出された Unit が `tasks.md` のコメントに無い場合は「未マッピング Unit」として警告に記録（更新はスキップ）。

6. **`tasks.md` のチェック更新**
   - 対象 T### を含む行 `- [ ] T### ...` を `- [x] T### ...` に Edit で置換。
   - 既に `[x]` の行はスキップ（カウントのみ）。
   - 行が見つからない T### は警告として列挙。

7. **コミットしない**
   - 変更サマリと未マッチ警告を返却。コミットはユーザー判断。

## 出力フォーマット

```
対象ファイル: specs/002-app-review-submission/tasks.md
feature 開始日: 2026-05-06 (この日以降にマージされた PR のみ対象)

検出 Unit (マージ済み PR から): U1.2, U2.1, U3.1, U3.2, U3.3
- U1.2 (T002-T006): 5 件 [x] 化（既に 3 件チェック済み、新規 2 件）
- U2.1 (T010-T013): 4 件 [x] 化（全て新規）
- U3.1 (T018-T020): 3 件 [x] 化（全て新規）
- U3.2 (T021-T024): 4 件 [x] 化（全て新規）
- U3.3 (T025-T027): 3 件 [x] 化（全て新規）

未マッピング Unit (tasks.md にコメントが無い): なし
未マッチ T###: なし
スキップした PR (Unit 番号なし): #19, #18
除外した PR (feature 開始日より前にマージ): 13 件
```

## 注意

- 対象 `tasks.md` 以外のファイルは触らない。
- `[x]` を `[ ]` に戻す逆方向操作は絶対禁止。
- feature 開始日フィルタが効くため、同名 Unit 番号（U2.2 等）が別 feature にあっても誤マッチしない。
- それでも稀に「feature 開始後にマージされた別 feature の PR」が混入する可能性がある場合は、出力の `スキップした PR` 欄を確認し、ユーザーに目視チェックを促す。
