# Audit Runbook — Fumireply Review Operations

本番 review 環境に対する運用操作の監査ログ兼ランブック。`scripts/prep-screencast.sh` /
`scripts/post-screencast.sh` が実行のたびに下表へ監査行を追記する。手動で本番を操作した
場合も同じ形式で 1 行追記すること。

## 想定審査タイムライン

- Meta App Review の標準的な所要: 通常 5〜10 営業日
- 提出〜結果通知の期間中は reviewer パスワード / 接続ページ / Webhook を変更しない
  （変更すると "Cannot reproduce" 差し戻しの原因になる）

## ロールバック方針

- 差し戻し時: `screencast-script.md` の指摘箇所を修正 → 再撮影 → 再提出
- reviewer 誤無効化時: `bash scripts/prep-screencast.sh` で即時再有効化
- 接続データ破損時: 撮影中に Connect フローで再接続（DB seed には戻さない）

## Submission 記録

提出時に Submission ID と日時をここへ追記する（T077）。

| Submission ID | 提出 UTC | 対象権限 | メモ |
|---|---|---|---|
| _(提出後に記入)_ | | pages_show_list / pages_manage_metadata / pages_read_engagement / pages_messaging | |

## 監査ログ

| UTC timestamp | actor | action |
|---|---|---|
