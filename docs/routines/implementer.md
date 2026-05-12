---
description: "Routine: messenger-app-implementer の画面設定 (名前・トリガー・環境・権限) の正本。指示欄の本体は implementer-prompt.md を参照。"
updated: 2026-04-30
---

# Routine: messenger-app-implementer (設定)

毎晩 02:00 JST に起動し、`tasks.md` の Unit を 1 件選んで実装 → PR 作成 → Copilot レビュー対応までを 1 セッションで完結させる。**1 Routine 実行 = 1 Unit = 1 PR**。

## ⚠️ このファイルは Routines 画面に貼らない

このファイルは **画面の各フィールドに何を入れるか** を説明する設定文書。
画面の「指示」欄に貼るのは [`implementer-prompt.md`](./implementer-prompt.md) の **全文** (フロントマターは除く本文すべて)。**こちらを直接 Claude に渡しても実装は始まらない**。

## 画面項目

| フィールド | 値 |
|---|---|
| 名前 | `messenger-app-implementer` |
| リポジトリ | `autydev/fumireply` |
| モデル | `Claude Opus 4.7 (1M context)` |
| トリガー (Schedule) | `0 17 * * *` (UTC, = JST 02:00) |
| Branch push prefix | `claude/` (デフォルト) |
| **指示** | [`implementer-prompt.md`](./implementer-prompt.md) の全文を **コピペ** |

### コネクター
**GitHub のみ**。Gmail / Notion / Calendar / Drive 等は追加しない (最小権限維持)。

## 動作タブ (Environment)

### Setup script

```bash
set -euo pipefail

node --version
npm --version

# app パッケージ
cd app && npm ci && cd ..

# Lambda サブパッケージ (まだ存在しない時期は skip)
for dir in webhook ai-worker keep-alive; do
  if [ -f "$dir/package.json" ]; then
    (cd "$dir" && npm ci)
  fi
done

gh --version
gh auth status
```

### 環境変数
| Key | 用途 | 備考 |
|-----|------|------|
| `ANTHROPIC_API_KEY` | Routine ランタイム自動 | 手動設定不要 |
| `GH_TOKEN` | gh CLI 認証 | GitHub コネクターが自動注入 |

**入れない**: `META_APP_SECRET`, `SUPABASE_SERVICE_KEY`, `META_PAGE_ACCESS_TOKEN` 等。Routine は本番 SSM や Supabase に接続しない設計。検証用ダミー値が必要なら `app/.env.example` の値で十分。

## 権限タブ (Network allowlist)

```
api.anthropic.com
github.com
api.github.com
codeload.github.com
objects.githubusercontent.com
registry.npmjs.org
*.npmjs.org
nodejs.org
```

**入れない**:
- `*.supabase.co` — DB に接続しない
- `graph.facebook.com` — Meta API を叩かない
- AWS endpoints — terraform apply は人間

外部 API を Routine 中に叩く必要が出たら都度追加するが、原則 **コード生成 + テスト** だけで完結する設計。

---

## 初回起動前のチェックリスト

- [ ] GitHub コネクター追加 (write 権限あり)
- [ ] Copilot Code Review の自動アサイン設定 (リポジトリ設定 UI トグル or workflow)
- [ ] Routines 画面の「指示」欄に `implementer-prompt.md` 全文を貼り付け済み
- [ ] テスト実行: 一度 manual trigger で動かして、U2.2 (Terraform modules) が選定され Bash ツールが即起動することを確認 (= 質問せず実装開始する)
- [ ] 初回 PR のタイトル / 本文 / label / Copilot 自動アサインが期待通りか目視確認

## Routine が選ばない (= 人間がやる) Unit

- U2.1 (Supabase / Anthropic dashboard 操作)
- U2.3 (terraform apply)
- U2.6 (Supabase Auth ユーザー作成)
- U6.1 (動画撮影)
- U7.1 (第三者レビュー)
- U8.2 (audit-runbook 執筆)
- U8.3 (CloudWatch alarms 有効化)
- U8.4 (実機スモーク)
- U8.5 (Meta App Review submit)

これらが完了するたびに `tasks.md` の対応 `- [ ] T###` を `- [x]` に書き換えること。書き換えがないと依存先 Unit が `ready` にならず Routine が止まる。

## Routine の停止条件

以下のとき Routine を一時停止 (画面で disable):
- 仕様の大改訂中 (例: マルチテナント設計の見直し)
- 連続 N 回「実行可能 Unit なし」が出ているのに Unit が消化されていない (人間ボトルネック)

## Routine 設定の更新フロー

1. このファイル or `implementer-prompt.md` を編集
2. PR を切ってマージ
3. Routines 画面に **手動でコピペ反映** (画面側に自動同期はない)
4. PR 本文に「Routines 画面反映済 (yyyy-mm-dd)」を追記
