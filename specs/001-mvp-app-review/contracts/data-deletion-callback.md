# Contract: Meta Data Deletion Callback

**Endpoint**: `POST /api/data-deletion`, `GET /api/data-deletion/status/:code`
**Spec reference**: FR-012, FR-014
**External spec**: https://developers.facebook.com/docs/development/create-an-app/app-dashboard/data-deletion-callback

Meta がユーザーデータ削除リクエストを送るためのコールバック。App Dashboard の「Data Deletion Request URL」フィールドに `POST /api/data-deletion` を登録する。

---

## POST `/api/data-deletion` — Delete Request

### Request (from Meta)

#### Body (form-urlencoded)

| Field | Type | Notes |
|-------|------|-------|
| `signed_request` | string | Base64URL(signature).Base64URL(payload) の形式 |

`payload` を base64url デコードすると以下の JSON：

```json
{
  "algorithm": "HMAC-SHA256",
  "issued_at": 1713630000,
  "user_id": "<PSID>"
}
```

#### 署名検証

```
expected = HMAC-SHA256(APP_SECRET, base64url_encoded_payload)
received = base64url_decode(signature)
timingSafeEqual(expected, received)
```

- `APP_SECRET` は SSM から取得
- 不一致の場合 **即 400 + `Invalid signature`**

### 処理フロー

1. `signed_request` を署名検証
2. payload から `user_id`（PSID）を抽出
3. `conversations.customer_psid = <PSID>` の行を検索
4. 該当会話の `messages` を DELETE
5. `conversations` を DELETE
6. `confirmation_code` を生成（UUID v4 → 先頭 16 文字）
7. `deletion_log` テーブルに記録（監査用、本 MVP では簡略化：`deletion_log(id, psid, deleted_at, confirmation_code)`）
8. レスポンス JSON を返す

### Response

```json
{
  "url": "https://<domain>/api/data-deletion/status/<confirmation_code>",
  "confirmation_code": "<confirmation_code>"
}
```

| Status | 条件 |
|--------|------|
| 200 | 削除成功 |
| 400 | 署名検証失敗 |
| 500 | DB エラー（Meta に再送してもらう） |

---

## GET `/api/data-deletion/status/:code` — Status Check

削除状況の確認 URL。ユーザーまたは Meta が削除の完了を確認する。

### Request

- Path: `/api/data-deletion/status/<confirmation_code>`
- No auth required（公開）

### Response

| Status | Body | 条件 |
|--------|------|------|
| 200 | `Deleted`（text/html、ユーザー向け簡易ページ）| `deletion_log` に該当 code あり |
| 404 | `Not found` | 該当 code なし |

**ページ内容**（英語 + 日本語）:

```
Data Deletion Confirmed

Your customer data associated with this confirmation code
has been permanently deleted from our system on <deleted_at>.

Confirmation Code: <confirmation_code>

If you have questions, please contact: <support email>
```

---

## 追加テーブル: `deletion_log`

| Column | Type | Constraints |
|--------|------|-------------|
| `id` | `uuid` | PK |
| `psid_hash` | `varchar(64)` | NOT NULL（SHA-256 ハッシュ、平文 PSID は保存しない）|
| `confirmation_code` | `varchar(32)` | UNIQUE NOT NULL |
| `deleted_at` | `timestamptz` | NOT NULL DEFAULT `now()` |

**設計意図**: 削除完了を証明する監査要件は「この PSID に対する削除を処理した事実」の記録で足りるため、**平文 PSID は保持しない**。ハッシュ化により漏洩時の個人情報露出を最小化する。

**ハッシュ計算**:
```
psid_hash = SHA-256(salt || psid_raw)
```
- `salt` は SSM Parameter Store `/fumireply/review/deletion-log/hash-salt` で管理する 32 バイトのランダム文字列
- salt 付与により、Meta 側データベースとの突合攻撃（rainbow table / brute force）を無効化

**保存期間**: **3 年間**（当初 7 年案から GDPR の最小化原則に合わせて短縮）。プライバシーポリシーに「削除監査ログは 3 年間 SHA-256 ハッシュ化形式で保管」と記載する。

**自動削除の実装タイミング**: MVP では自動 cleanup バッチを実装せず、`docs/operations/audit-runbook.md` に記載した手動 cleanup 手順で運用する。Phase 2 で cron / EventBridge Scheduled Rule ベースの自動削除バッチを追加する（`data-model.md` § `deletion_log` と整合）。

**処理フローの更新**:
1. `signed_request` を署名検証
2. payload から PSID（平文）を抽出
3. `conversations.customer_psid = <PSID>` の行を検索（**平文のまま検索**、messages / conversations は平文 PSID で保持中）
4. 該当 conversation.id に紐づく `messages` を DELETE
5. `conversations` を DELETE
6. `psid_hash = SHA-256(salt || PSID)` を計算
7. `deletion_log` に INSERT（平文 PSID は**ここで破棄**、ハッシュのみ保存）
8. `confirmation_code` を Meta に返す

**status endpoint のセキュリティ考慮**: 現状通り認証なしで `Deleted` 文言のみを返す。`confirmation_code` が漏洩しても、漏洩先からは PSID は逆引き不可能（UUID ベースでハッシュとの関連もない）。

---

## テスト

| Test | Type | Approach |
|------|------|----------|
| 正常系（署名正）| integration | 事前に conversation + messages を投入 → POST → 削除確認 |
| 異常系（署名不正）| unit | 400、データは削除されない |
| 存在しない PSID | integration | 200（Meta 仕様、存在しなくても成功扱い）, confirmation_code 発行 |
| status endpoint（存在）| integration | 200 + `Deleted` ページ |
| status endpoint（不存在）| integration | 404 |
| Meta App Dashboard のテストボタンから疎通 | manual | 申請前に実施 |
