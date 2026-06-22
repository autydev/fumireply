# Quickstart: AI 下書きの条件付き再生成 (005)

**Feature**: AI 下書きの条件付き再生成 (ワンオフ指示)
**Branch**: `005-draft-regenerate-oneoff`
**Date**: 2026-06-23

#004 までのローカル環境が動いている前提。ここでは 005 のデルタだけを書く。

---

## 1. 環境変数の追加 (app のみ)

`app/.env.local` (および本番 Lambda の env) に以下を追加:

```bash
# 005 で追加: app から既存の draft SQS キューに publish するため
SQS_QUEUE_URL=https://sqs.ap-northeast-1.amazonaws.com/123456789012/fumireply-draft-queue
AWS_REGION=ap-northeast-1
```

`SQS_QUEUE_URL` は webhook / ai-worker 環境で既に使っている `SQS_QUEUE_URL` と **同じキュー** を指す。新規キューは作らない。

webhook / ai-worker / keep-alive の env は変更不要。

---

## 2. npm パッケージの追加 (app のみ)

```bash
cd app
npm install @aws-sdk/client-sqs
```

バージョンは webhook / ai-worker と揃える (`package.json` の `dependencies` を相互確認)。`package-lock.json` を含めてコミット。

---

## 3. IAM 権限の付与 (本番デプロイ前)

app Lambda の実行ロールに以下を追加 (IaC で管理):

```jsonc
{
  "Effect": "Allow",
  "Action": "sqs:SendMessage",
  "Resource": "arn:aws:sqs:ap-northeast-1:123456789012:fumireply-draft-queue"
}
```

ローカル開発時は AWS_PROFILE / 一時クレデンシャルで同等権限を付ける。

---

## 4. データベースマイグレーション

**なし**。`ai_drafts` 列は #004 (`0003_conversation_scoped_drafts.sql`) のまま。

---

## 5. ローカル動作確認 (手動)

前提: webhook / app / ai-worker / Supabase ローカル / SQS (LocalStack or AWS dev queue) が立ち上がっている。

1. ブラウザで `/threads/<conversationId>` を開く。下書きが `ready` 状態であること。
2. 下書きカード下に「再生成」ボタンが表示されることを確認。
3. ボタンクリック → instruction textarea が展開、残り文字数 (1000) が表示される。
4. instruction に「テスト指示: 必ず『005 テスト』という語を含めて」と入力 (残り文字数が減ることを確認)。
5. 「実行」ボタンクリック。
6. 即座に「下書き再生成中」バナーが表示される (DraftBanner pending)。
7. 数秒〜30 秒以内に textarea が新本文 (「005 テスト」を含むはず) に置き換わる。instruction 欄が空になる。
8. ブラウザを再読み込み。textarea には新本文が残り、instruction 欄は空のまま (永続化リーク 0 件)。

### 失敗系の確認

- Anthropic API キーを意図的に無効化して同じ操作 → トースト「再生成に失敗しました」+ 旧本文が textarea に残る + instruction が入力欄に残る + 「再生成」ボタンが押せる状態に戻る。

### タイムアウト系の確認

- ai-worker を一時停止して同じ操作 → 90 秒後にトースト「再生成がタイムアウトしました」+ instruction 残存 + ボタン再活性化。

### 同時実行の確認

- 再生成中に同じ会話宛の Messenger inbound webhook を手動で叩く (curl) → サーバログに `draft_enqueue_skipped_fresh_pending` が出る。再生成完了後に未取り込み新着が反映された 2 つ目の下書き (instruction なし) が生成される。

---

## 6. テスト実行

```bash
# ai-worker のユニット
cd ai-worker
npm test -- regenerate

# app のユニット (server fn)
cd ../app
npm test -- regenerate-draft

# webhook の stale-guard ユニット
cd ../webhook
npm test -- handler

# E2E スモーク (Playwright)
cd ../app
npm run test:e2e -- regenerate
```

---

## 7. 既存挙動への影響確認 (回帰)

- 新着インバウンド → 20 秒後にバッチ下書きが生成される (#004 既存)。
- 下書きの送信 → active draft が dismissed (#004 既存)。
- 連投 3 通 → coalesce で 1 件にまとまる (#004 既存)。

すべて 005 適用後も同じ挙動になることをスモークで確認。

---

## 8. デプロイ順序

1. ai-worker をデプロイ (新スキーマ `triggerType` / `instruction` を受理できる状態にする)。後方互換あり、旧 payload も処理可。
2. webhook をデプロイ (stale-pending guard を有効化)。
3. app をデプロイ (`SQS_QUEUE_URL` env / IAM 権限・新規 server fn / UI)。

順序を守れば任意のタイミングで roll-back 可能 (UI を消すだけで運営者からは見えなくなる)。
