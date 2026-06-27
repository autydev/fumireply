# Quickstart: echo 取り込みの有効化 / 検証 / 観測

## 1. 環境変数・IAM・SSM

**追加なし**。

| 項目 | 変更 |
|---|---|
| env var | 追加なし。`SQS_QUEUE_URL`, `AWS_REGION` 等は既存のまま |
| IAM ポリシー | 追加なし |
| SSM パラメタ | 追加なし |
| Lambda / API Gateway | 追加なし |
| npm 依存 | 追加なし |

→ デプロイは通常の webhook / app コードデプロイのみ。インフラ作業ゼロ。

---

## 2. Meta App 管理画面での `message_echoes` 購読有効化

本機能は **コードデプロイ後に手動でフィールド購読を追加する** 二段切替で運用する。

### 手順 (1 回限り、リリース時)

1. https://developers.facebook.com/apps/ にアクセスし、本番 App を開く
2. 左メニュー「Messenger」→「Settings」を開く
3. 「Webhooks」セクションで現在の Callback URL に対する「Edit」を押す
4. **Subscription Fields** ダイアログで `message_echoes` のチェックを ON にする (既存: `messages`, `messaging_postbacks` はそのまま)
5. 「Save」を押す

### 動作確認 (即時)

1. 本番運営者の Facebook 個人アカウントで **Messenger 公式アプリ** を開く
2. fumireply 接続済み Page → 任意の既存会話で 1 通テスト送信 (`echo test 2026-06-27` 等)
3. 数秒以内に CloudWatch Logs (`/aws/lambda/<webhook-fn>`) に `external_echo_ingested` イベントが出ることを確認:

```text
{ "event": "external_echo_ingested", "conversationId": "...", "mid": "m_...", "pageId": "...", "messageType": "text", "bodyLength": 21, "tsMs": 1719... }
```

4. fumireply の管理画面で同会話のスレッドを開き、テスト送信がスレッド末尾に表示されていることを目視確認
5. fumireply 経由で 1 通送信し、CloudWatch Logs に `self_echo_confirmed` が 1 度だけ出る (= 既存自送信行 1 件に対する UPDATE) ことを確認

### 失敗時の緊急ロールバック

- Meta App 管理画面で `message_echoes` のチェックを OFF にする → Meta から echo 配信停止
- コード側は最後の inbound 経路と互換 (echo イベントが来ないので新コードは未実行)。デプロイ巻き戻し不要

---

## 3. ローカル / Staging 検証

### 3.1 webhook 単体テスト

```bash
cd webhook
npm test -- handler.test.ts
```

新規追加テストケース ([research.md R8](./research.md#r8-テスト戦略)) が全てパスすること。

### 3.2 send-reply UNIQUE 違反シミュレーション

```bash
cd app
npm test -- send-reply.fn.test.ts
```

attribute 補正テストが PASS すること。

### 3.3 ローカル webhook シミュレーション

`webhook/scripts/sim-echo.ts` (実装時に追加) で echo ペイロードを生成し、ローカルの webhook handler に直接渡す方式を取る。Meta App の購読有効化なしで開発確認できる。

ペイロード例 (テキスト echo):

```json
{
  "object": "page",
  "entry": [{
    "id": "<page_meta_id>",
    "time": 1719500000000,
    "messaging": [{
      "sender":    { "id": "<page_meta_id>" },
      "recipient": { "id": "<customer_psid>" },
      "timestamp": 1719500000000,
      "message": {
        "mid": "m_localtest_001",
        "is_echo": true,
        "text": "Hello from external app"
      }
    }]
  }]
}
```

---

## 4. 観測 (CloudWatch Logs Insights クエリ例)

### 4.1 日次の外部送信取り込み件数 (SC-006)

```text
fields @timestamp, conversationId, mid, pageId, messageType, bodyLength
| filter event = "external_echo_ingested"
| stats count() as ingestedCount by bin(1d), pageId
| sort @timestamp desc
```

### 4.2 fumireply 自送信の echo 確認数 (健全性監視)

```text
filter event = "self_echo_confirmed"
| stats count() as confirmedCount by bin(1h)
```

`confirmedCount` が日常的に send-reply 成功数とおおよそ一致すれば echo 配信が健全。乖離が大きい場合は Meta 側の遅延 or `message_echoes` 購読外れの疑い。

### 4.3 attribute 補正の頻度 (送信パスの健全性)

```text
filter event = "echo_send_attribution_recovered"
| stats count() by bin(1d), conversationId
```

通常レアイベント。頻発する場合は Meta echo 配信が極端に高速になっているか、send-reply の TX2 が遅延している可能性 (DB 接続混雑) を疑う。

### 4.4 SC-001 (10 秒以内反映) のサンプリング

```text
filter event = "external_echo_ingested"
| fields @timestamp - tsMs as deliveryLagMs
| stats avg(deliveryLagMs), pct(deliveryLagMs, 95)
```

p95 が 10000ms 以内であれば SC-001 達成。

---

## 5. リリース順 (推奨)

1. **PR レビュー → main マージ → 本番デプロイ** (コード変更のみ。Meta App は未設定なので挙動変化ゼロ)
2. **Meta App 管理画面で `message_echoes` 購読を有効化** (人手、2 分)
3. **動作確認** (Section 2 の確認手順)
4. **運営者へ周知**: 「Messenger 公式アプリでの返信も fumireply に反映されるようになりました」
5. **30 日後の SC-005 確認**: 「外部アプリで返信したのに出ない」起因の問い合わせ件数を運用ログから集計

---

## 6. トラブルシューティング

| 症状 | 原因の可能性 | 対応 |
|---|---|---|
| `external_echo_ingested` が一度も出ない | Meta App 購読フィールドが未追加 | Section 2 の手動設定を再確認 |
| `external_echo_ingested` が出るが UI に出ない | フロント側のキャッシュ・rerender 漏れ | スレッドをリロード、TanStack Query の invalidate を確認 |
| `echo_send_attribution_recovered` が高頻度 | DB UPDATE 遅延、Meta echo 配信が send-reply TX2 より先着 | DB 接続プール状況確認、長期化するなら send-reply を `INSERT … ON CONFLICT` 統合へ再設計検討 |
| 自送信が 2 件に増えた | UPSERT 制約名ミスマッチ or `metaMessageId` UNIQUE が外れている | `messages_meta_message_id_unique` の存在確認、`\d+ messages` で UNIQUE 列確認 |
| 未知 Page エラーで echo が捨てられる | echo の `pageId` (Meta の Page ID) が `connected_pages.page_id` に未登録 | `connected_pages` を確認、page 接続が外れていないか確認 |
