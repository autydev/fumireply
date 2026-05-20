---
name: add-routine-units
description: tasks.md の各サブセクションに Claude Routines playbook 用の `<!-- unit: ... -->` HTML コメントを付与し、同ディレクトリに units.md 索引を生成する。`/add-routine-units` または「Routine 用の Unit メタを付与」「units.md を作って」等の依頼で呼ぶ。`/speckit-tasks` で tasks.md を作った直後に走らせると、Claude Routines が 1 Unit = 1 PR 単位で自動実装を回せるようになる。
---

# add-routine-units

このスキルは、`/speckit-tasks` で生成された `tasks.md` を Claude Routines playbook が解釈できる形に拡張する後処理ステップを行う。具体的には:

1. tasks.md のサブセクション (`### ...` ヘッダ単位) ごとに `<!-- unit: U<phase>.<seq> | deps: ... | scope: ... | tasks: T###-T### | files: ~N | automation: auto|manual -->` を直前に挿入する
2. 同じディレクトリに `units.md` 索引ファイル (Phase 単位の Markdown テーブル) を生成する

Routines playbook は次の点に依存している:

- `<!-- unit: ... -->` メタデータが tasks.md にあること
- `units.md` 索引が同ディレクトリにあること (slug 生成と読みやすい一覧のため)
- 各 Unit が `automation: auto` または `automation: manual` のいずれかであること (`mixed` は禁止 — Unit を分割する)

これら 3 点を満たすように tasks.md / units.md を編集することが本スキルの責務である。

---

## 1. 対象 tasks.md パスを解決

優先順位:

1. **`ARGUMENTS` に明示されていれば最優先**
   - 例: `/add-routine-units specs/003-customer-context-and-settings/tasks.md`
   - 渡されたパスが存在しなければエラーを返す。

2. **`.specify/feature.json` の `feature_directory` を使う**
   - Bash で `jq -r '.feature_directory' .specify/feature.json` を取得 → `<feature_directory>/tasks.md` を対象とする
   - そのファイルが存在しなければ次へ

3. **`CLAUDE.md` の "Active feature plan" から導出**
   - `grep -E 'Active feature plan.*specs/[^/]+/plan\.md' CLAUDE.md` で行を取得
   - `specs/<feature>/tasks.md` を対象とする
   - そのファイルが存在しなければエラー

4. **どれもなければ `specs/` 配下を探索**
   - 1 件しかなければそれを採用。複数あればユーザーに質問し、勝手に選ばない

---

## 2. Unit 境界の決定ルール

tasks.md は通常以下の構造になっている:

```
## Phase 1: Setup
- [ ] T001 ...
- [ ] T002 ...

## Phase 2: Foundational

### サブセクション A
- [ ] T003 ...
- [ ] T004 ...

### サブセクション B
- [ ] T005 ...
...
```

### Unit 区切りの優先ルール

1. **サブセクション (`### ...`) を 1 Unit にまとめる** のが基本
2. サブセクションが無い `## Phase` 直下の `- [ ]` 群はその Phase 全体で 1 Unit
3. **`automation` が auto / manual で混在する場合は Unit を分割する**
   - 例: 1 つのサブセクション内で「ローカルで自動実行」「人間が GUI 操作」が混ざる → 別 Unit
4. Unit 内のファイル数が多すぎる場合 (>10 ファイル目安) は分割を検討
5. 異なる scope (frontend / backend / infra / docs) が同 Unit に混ざる場合は分割する。Routine の PR が綺麗な scope で切れる方が重要

### 番号付け

- `U<phase>.<seq>` 形式。`phase` は ## Phase 番号、`seq` は Phase 内の Unit 連番 (1 始まり)
- Polish フェーズなど "Phase N" 表記の場合は phase 番号を 6 などに固定する (006 / 007 等の予約番号があれば避ける)
- 既存の Unit メタデータが既にあれば**番号を維持する** (新規追加・分割の差分のみ更新)

### `deps` 推定

- 同 Phase 内の前 Unit を deps に入れる: 自然な実装順
- 前 Phase の末尾 Unit を依存元にする (Phase 跨ぎの土台)
- `### Tests for ...` セクションは原則前段の実装サブセクションに依存
- `none` は Setup Phase の最初の Unit のみ

確信が持てない場合は最も近い直前 Unit を deps に置く保守設計でよい。後で人間が編集できる。

### `scope` 推定

タスク本文に含まれるパスから推定:

| パスの prefix | scope |
|---|---|
| `app/`, `messages/`, `project.inlang/` | `frontend` |
| `ai-worker/`, `webhook/`, `keep-alive/`, `app/src/server/db/` | `backend` |
| `terraform/`, env 設定、CI workflow | `infra` |
| `docs/`, `README.md`, `specs/` | `docs` |
| `scripts/` | `infra` |
| cross-cutting (lint + typecheck + paraglide compile 等) | `infra` |

混在する場合は最も多いものを採用。Unit 分割で揃えるのが理想。

### `files` 推定

タスク本文に登場する**新規作成ファイルパス + 編集ファイルパス**の概数を `~N` 形式で記載。0 ファイル (verify / npm ci 系) なら `0`、1 ファイルなら `1`、複数なら `~3` `~6` 等。厳密でなくてよい。

### `automation` 判定

- タスク本文に「手動」「manual」「ブラウザで」「GUI で」「Meta App Settings に」「画面で確認」等が含まれる → `manual`
- npm run / vitest / Drizzle migrate / Terraform CLI 等のコマンドのみで完結 → `auto`
- 迷ったら `auto` (Routine 側で sandbox 失敗時に手動エスカレできる)

---

## 3. tasks.md への注入

各サブセクションの `### ヘッダ` の直後 (本文の `- [ ]` が始まる直前) に空行を挟んで以下を 1 行で挿入:

```
<!-- unit: U<P>.<S> | deps: <list|none> | scope: <s> | tasks: T###-T###[,T### ...] | files: <~N|0> | automation: auto|manual -->
```

注意:

- 既存の `<!-- unit: ... -->` がある場合は**上書きせず**、内容が現状の tasks.md と整合しているか確認するのみ。整合しなければ差分を提案として表示し、ユーザー確認後に編集
- タスク範囲は `tasks` フィールドに範囲表記 (`T001-T005`) またはカンマ列挙 (`T001,T003,T005`) で書く。連続なら範囲、飛び石ならカンマ。混在は `T001-T003,T007` のように
- 1 つの ## Phase に sub-section が複数あれば各々に Unit メタを付ける
- Polish フェーズの「auto/manual 混在」を見つけたらタスク順を再編成して Unit を分割する (上記ルール 3 番)。これにより各 Unit が 1 種類の automation で揃う

---

## 4. units.md の生成

`tasks.md` と同じディレクトリに `units.md` を生成する (既存なら更新):

```markdown
---
description: "Unit-level execution plan for Routine implementer. tasks.md の T### を Unit (1 PR 単位) にまとめた索引。"
updated: <YYYY-MM-DD>
---

# Units: <Feature 名>

## 凡例

| 項目 | 意味 |
|------|------|
| `automation: auto` | Routine が実装する |
| `automation: manual` | 人間操作必須。Routine はスキップ |
| `scope` | PR タイトルの conventional commit scope |
| `deps` | 着手前提 Unit |

## Phase 1: <Phase 名>

| Unit | tasks | scope | deps | files | automation | 概要 |
|------|-------|-------|------|-------|------------|------|
| U1.1 | T001 | infra | none | 0 | auto | <Unit 概要 1 行> |
...
```

各 Phase ごとに 1 テーブル。Unit 概要は tasks.md のサブセクションヘッダ (例: `### DB スキーマ`) または最初のタスク本文から 1 文に要約する。Routine playbook が `grep -oE "$UID[^|]*" units.md` で slug 生成に使うので、Unit 概要は kebab-case 化しやすい簡潔な日本語/英語フレーズが望ましい (絵文字・記号は避ける)。

Feature 名は対象 `<feature_dir>/spec.md` の `# Feature Specification: ...` ヘッダから抽出する。

`updated` フィールドは現在日付 (YYYY-MM-DD)。

---

## 5. 検証

書き換え後に以下を確認:

1. tasks.md に `<!-- unit:` が 1 つ以上含まれる
2. すべての `<!-- unit:` の `tasks:` 値が tasks.md 内の実在する T### を指す
3. すべての `automation` 値が `auto` または `manual` (mixed なし)
4. すべての `deps` 値が `none` または、参照先 Unit が tasks.md 内に存在する
5. `units.md` の各 Unit 行の列数が一致 (Markdown テーブルが壊れていない)
6. tasks.md 上の各 T### がいずれかの Unit (の `tasks:` 範囲) に必ず属する (孤立タスクなし)

これらが満たされなければ修正してから完了とする。

---

## 6. 完了報告

ユーザーへの報告は以下の形式:

- 編集したファイル: `<paths>`
- 新規追加された Unit: `U1.1, U2.1, ...`
- 既存から変更された Unit: なし / `U2.3 (deps 修正)`
- automation 別の Unit 数: auto N 件 / manual M 件
- 注意点: deps 推定で曖昧なものがあれば列挙

ユーザーが Routine を回し始める前に units.md / tasks.md を目視確認するよう促す 1 文を末尾に添える。

---

## トラブルシュート

- **tasks.md が `### サブセクション` を持たない場合**: Phase ヘッダ直下の全 `- [ ]` を 1 Unit として扱う。Polish Phase でよく発生
- **同じファイルを複数 Unit が同時編集する場合**: 並列実装するとマージ競合の原因。tasks.md 上で Unit を直列化するよう deps を強化 (片方を依存に追加)
- **既に units.md が存在し競合する場合**: 既存ファイルを diff 提示し、ユーザー確認なしに上書きしない
- **`automation: mixed` を発見した場合**: 必ず Unit 分割する。「auto と manual のタスクが同居する PR」は Routine が処理できない

---

## このスキルを使わない場合

- tasks.md がまだ無いとき → 先に `/speckit-tasks` を実行する
- 別 feature の units.md を流用するとき → 手動で必要な箇所だけコピーする
- Routine playbook を使う予定がないとき → 本スキルは不要 (`<!-- unit: ... -->` も不要)
