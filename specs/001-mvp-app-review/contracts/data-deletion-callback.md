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
| `customer_psid` | `varchar(64)` | NOT NULL |
| `confirmation_code` | `varchar(32)` | UNIQUE NOT NULL |
| `deleted_at` | `timestamptz` | NOT NULL DEFAULT `now()` |

**設計意図**: PSID の削除記録を残し、status endpoint で確認できるようにする。PSID 自体は削除対象ユーザーの ID だが、**削除完了を証明するためには最低限 PSID と削除日時を監査ログとして保持する必要がある**。プライバシーポリシーに「削除監査ログは 7 年間保管」と記載してこの保持を正当化する（GDPR 対応）。

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
