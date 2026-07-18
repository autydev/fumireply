# Quickstart: 008-fix-ai-worker-timestamp

env / IAM / SSM / DB マイグレーション: **追加なし**。terraform 変更もなし。ai-worker のコードデプロイのみ。

## 1. デプロイ

通常の ai-worker デプロイフローのまま(ビルド → Lambda 更新)。インフラ差分はないため `terraform apply` は不要。

## 2. 修正の検証(CloudWatch Logs Insights)

ロググループ: `/aws/lambda/fumireply-review-ai-worker`

**(a) TypeError クラッシュが止まったこと** — デプロイ後 0 件になるはず:

```
fields @timestamp, @message
| filter @message like /value.toISOString is not a function/
| sort @timestamp desc
| limit 20
```

**(b) outbound あり会話で draft が完走していること**:

```
fields @timestamp, @message
| filter @message like /draft_persisted/
| sort @timestamp desc
| limit 50
```

**(c) 新設の outer catch の発火状況**(平常時は 0 件のはず):

```
fields @timestamp, @message
| filter @message like /draft_job_unexpected_error/
| sort @timestamp desc
| limit 50
```

実地確認: outbound メッセージのある既存スレッドで「再生成」を実行し、90 秒タイムアウトせずに下書きが更新されること。

## 3. DLQ 滞留ジョブの後始末(運用判断)

対象: `fumireply-review-ai-draft-dlq`(保持 14 日。2026-06-27 以降の失敗分のうち直近 14 日分が残存)

### 3.1 まず滞留内容を確認

```
aws sqs get-queue-attributes --queue-url <DLQ_URL> --attribute-names ApproximateNumberOfMessages
```

```
aws sqs receive-message --queue-url <DLQ_URL> --max-number-of-messages 10 --visibility-timeout 30
```

ボディの `triggerType: "regenerate"` の有無を確認する(下記 3.3 の判断材料)。

### 3.2 redrive する場合(修正デプロイ後のみ)

AWS コンソール(SQS → DLQ → 「Start DLQ redrive」→ 送信先: 元キュー `fumireply-review-ai-draft-queue`)、または:

```
aws sqs start-message-move-task --source-arn <DLQ_ARN>
```

**安全性の根拠**(research.md D4): ジョブは処理時点の DB 状態を再読みするため、
- 新しい inbound が来た会話 → `superseded` で副作用なし
- 返信済みになった会話 → `no_unanswered` で stale な下書きを dismiss(004 の設計どおり)
- いまだ未返信の会話 → 現時点の内容で下書きを生成(redrive の価値があるケース)

### 3.3 注意点

- **regenerate ジョブが滞留に含まれる場合**: coalesce をバイパスするため、古いオペレーター指示で現アクティブ下書きを上書きしうる。件数が多ければ redrive せず purge(`aws sqs purge-queue`)か、放置して 14 日で自然消滅させる
- redrive しない場合の対応は不要(自然消滅)。DLQ アラーム `fumireply-review-ai-worker-dlq-not-empty` は滞留が消えるまで発火し続ける点だけ留意
- redrive 実施時は Anthropic API 呼び出しが滞留件数ぶん発生する(コスト・レート)

## 4. ロールバック

コード変更のみのため、旧バージョンの Lambda へ戻すだけ。ただし旧版は本バグを含むため、ロールバック中は outbound あり会話の下書き生成が再び失敗する。
