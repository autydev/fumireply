# Quickstart: 送信側メディア添付

**Feature**: 010-outbound-media | **Date**: 2026-07-20

## 前提

- 009 (受信側メディア) がデプロイ済み: `fumireply-review-media` バケット、`MEDIA_BUCKET_NAME` env が app / webhook 両 Lambda に設定済み
- 新規の env 変数・SSM パラメタ・Meta App 管理画面の作業は**なし**
- DB マイグレーションは**なし** (`messages.attachments` は 009 で追加済み)

## デプロイ順序

1. **terraform apply** (`terraform/envs/review`)
   - app-lambda IAM に `s3:PutObject` 追加
   - media バケットに CORS 設定追加 (PUT / アプリドメイン origin)
2. **app デプロイ** (通常の CI/CD)

逆順でも安全: コードが先に出た場合、presigned PUT の発行は成功するがブラウザの PUT が CORS で失敗し、添付は「アップロード失敗」表示になるだけ。テキスト送信は無影響。

ロールバック: app コードを戻せば旧挙動 (テキストのみ) に完全復帰。IAM / CORS は残っても参照されないだけで無害。

## 手動検証チェックリスト

1. **画像のみ送信** (US1): jpeg を添付 → 送信 → 顧客側 Messenger に画像到着 / 自社スレッド outbound バブルにサムネイル表示 / クリックで原寸モーダル
2. **形式別の送信確認 (リリース直後に最優先)**: png / gif / **webp** をそれぞれ送信し顧客側で表示されること。**webp が Meta 側で拒否される場合は `ALLOWED_IMAGE_TYPES` から除外して再デプロイ** (research D5)。判明までの間 webp 送信は「アップロード成功 → 送信 meta_error」という分かりにくい失敗になるため優先確認する
3. **テキスト+画像** (US2): 両方入力して送信 → 顧客側にテキスト → 画像の順で 2 通 / 自社スレッドにも 2 メッセージ
4. **バリデーション** (US3): pdf 選択 → 選択時エラー / **30MB 画像** (25 MiB=26,214,400B を明確に超過) → 選択時エラー / devtools で client 検証を迂回して過大ファイルを PUT しても S3 が署名済み `ContentLength` で 403 拒否 / 過大 s3Key を sendReplyFn に渡してもサーバーが拒否
5. **24h ウィンドウ外**: 期限切れ会話で添付ボタンが無効 / 直接 fn を叩いても `outside_window`
6. **echo 整合** (FR-012): 画像送信後 7 秒ポーリング数回 + リロードで二重表示なし・画像表示が安定していること
7. **失敗表示**: ネットワーク遮断等で送信失敗させ、failed 表示と再送が機能すること
8. **ポーリング安定性**: スレッドを開いたまま 15 分以上放置し、画像の `<img>` が壊れないこと (presign 量子化キャッシュの回帰)

## CloudWatch Logs Insights 検証クエリ

アップロード URL 発行数 / 送信失敗の内訳 (app Lambda ロググループ):

```
fields @timestamp, event, reason, s3Key
| filter event in ["outbound_upload_url_issued", "outbound_attachment_send_failed", "outbound_attachment_key_rejected"]
| stats count() by event, reason
```

画像送信の成功数 (参考 — DB 側): `direction='outbound' AND message_type='image' AND send_status='sent'` を集計。

## 孤児オブジェクトの目視確認 (任意)

```
aws s3 ls s3://fumireply-review-media/ --recursive | grep "/outbound/"
```

送信済み行の s3Key と突き合わせて未参照キーが孤児。掃除は #78 のライフサイクル検討に合流 (本機能では対応しない)。
