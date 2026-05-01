---
name: sync-merged-tasks
description: マージ済み PR タイトルから Unit 番号 (U<major>.<minor>) を抽出し、specs/001-mvp-app-review/tasks.md の対応 T### チェックボックスを [x] に更新する機械的タスク。
model: haiku
tools: Bash, Read, Edit
---

# sync-merged-tasks (subagent)

## 役割

マージ済み PR を走査し `specs/001-mvp-app-review/tasks.md` の完了チェックを同期する。コミットはしない。

## 前提

- `tasks.md` 内の `<!-- unit: U?.? | ... | tasks: T###-T###[,T###a-T###z] ... -->` コメントが Unit → T### マッピングの正本。
- PR タイトルに `U<major>.<minor>` 形式で Unit 番号が含まれる。
- `gh` CLI 認証済み。

## 手順

1. **マージ済み PR 一覧取得**

   ```bash
   gh pr list --state merged --base main --limit 100 --json number,title,mergedAt
   ```

2. **Unit 番号抽出**
   - 各 PR タイトルから正規表現 `\bU(\d+)\.(\d+)\b` で全 Unit を抽出。
   - 1 PR が複数 Unit を含むケースも全件取得。多桁 (U10.2 等) も同正規表現でカバー。
   - 重複は除去。

3. **Unit → T### レンジ解決**
   - `tasks.md` を読み、`<!-- unit: ... | tasks: ... -->` コメントをパース。
   - `T045-T053` はレンジ展開、`T023,T024` はカンマ分割、`T047a-T047d` はサフィックス付きレンジ展開 (T047a, T047b, T047c, T047d)。
   - PR で検出された Unit が `tasks.md` のコメントに無い場合は警告。

4. **`tasks.md` のチェック更新**
   - 対象 T### を含む行 `- [ ] T### ...` を `- [x] T### ...` に Edit で置換。
   - 既に `[x]` の行はスキップ (カウントのみ)。
   - 行が見つからない T### は警告として列挙。

5. **コミットしない**
   - 変更サマリと未マッチ警告を返却。コミットはユーザー判断。

## 出力フォーマット

```
検出 Unit (マージ済み PR から): U2.2, U2.4, U2.5
- U2.2 (T025-T033): 9 件 [x] 化
- U2.4 (T038-T044): 7 件 [x] 化 (うち X 件は既にチェック済み)
- U2.5 (T045-T053, T047a-T047d): 13 件 [x] 化

未マッチ Unit: なし
未マッチ T###: なし
スキップした PR (Unit 番号なし): #1, #2
```

## 注意

- `tasks.md` 以外のファイルは触らない。
- `[x]` を `[ ]` に戻す逆方向操作は絶対禁止。
