# Quickstart: 受信画像・添付メディアの永続保存とスレッド表示 (009)

## 前提

- Meta App 管理画面の作業は **不要** (添付は既存 `messages` 購読フィールドに含まれる)
- SSM パラメタの追加は **不要**
- 新規に必要なのは: S3 バケット + IAM + Lambda env (Terraform)、DB マイグレーション 1 本、コードデプロイ

## デプロイ手順 (この順序)

### 1. Terraform apply (バケット / IAM / env / Lambda リソース)

```bash
cd terraform/envs/review
terraform plan
terraform apply
```

追加・変更されるもの:
- `aws_s3_bucket.media` (`fumireply-review-media`) + Public Access Block + SSE-S3
- webhook Lambda: `s3:PutObject` 権限、env `MEDIA_BUCKET_NAME`、memory 1024MB、timeout 20s
- app Lambda: `s3:GetObject` 権限、env `MEDIA_BUCKET_NAME`

### 2. DB マイグレーション

```bash
cd app
npm run db:migrate
```

- `messages.attachments jsonb` 追加
- レガシー inbound 画像の `body` から失効 CDN URL を除去 (FR-004a)。適用前に対象件数を確認したい場合:

```sql
SELECT count(*) FROM messages WHERE message_type = 'image' AND body LIKE 'http%';
```

### 3. コードデプロイ

通常の CI (GitHub Actions → `aws lambda update-function-code`) で webhook / app を更新。

> 順序が前後しても受信メッセージは失われない: コード先行時は `MEDIA_BUCKET_NAME` 未設定として添付保存をスキップ (種別記録は行う)、インフラ先行時は旧コードが従来どおり動くだけ。

## 手動検証

1. **画像**: 顧客役アカウントから Messenger で画像を送信 → スレッドに `<img>` 表示 → クリックで原寸表示 → S3 コンソールで `{tenantId}/{conversationId}/{mid}/0` を確認
2. **複数画像**: 1 通で 2 枚送信 → 両方表示される
3. **動画 / 音声 / ファイル**: それぞれ送信 → 空バブルでなく種別ラベル表示、S3 にオブジェクトあり
4. **スタンプ**: 送信 → スタンプラベル表示、S3 保存なし
5. **レガシー行**: マイグレーション後、過去の画像メッセージが生 URL でなく「画像 (取得不可)」表示
6. **URL 失効後の表示**: 受信から 7 日以上経過後にスレッドを開き画像が表示される (SC-001)
7. **echo 添付**: Meta 公式アプリから Page として画像を送信 → outbound バブルに画像表示

## CloudWatch Logs Insights クエリ例

ロググループ: `/aws/lambda/fumireply-review-webhook`

保存成功/失敗の日次集計 (SC-005):

```
fields @timestamp, event, tenantId, type, reason
| filter event in ["attachment_stored", "attachment_download_failed", "attachment_skipped_oversize"]
| stats count() by event, bin(1d)
```

失敗理由の内訳:

```
fields @timestamp, reason, type, mid
| filter event = "attachment_download_failed"
| stats count() by reason
```

テナント別の保存量 (概算, bytes):

```
fields tenantId, sizeBytes
| filter event = "attachment_stored"
| stats sum(sizeBytes) by tenantId, bin(30d)
```

## ロールバック

- コード: 旧バージョンへ `update-function-code` で戻すだけ (添付が無視される旧挙動に復帰)。`attachments` 列は旧コードに無害
- Terraform: メモリ/timeout/IAM/env を戻す。バケットは中身があるため destroy せず放置 (参照されなくなるだけ)
- マイグレーションの UPDATE (body クリーンアップ) のみ不可逆 — 対象は失効済み URL 文字列 (spec Q3 で承認済み)

## 関連 Issue

- 実装対象: autydev/fumireply#73
- 保持期間・ライフサイクルの将来検討: autydev/fumireply#78
