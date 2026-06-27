# Phase 1 — Data Model: echo 取り込みに伴うスキーマ影響

## 結論: スキーマ変更ゼロ

- 新規テーブル: なし
- 新規列: なし
- 新規 index: なし
- 新規 UNIQUE / CHECK 制約: なし
- マイグレーション: なし

既存 `messages` テーブルの列 (`schema.ts:103-131`) と `metaMessageId` の column-level UNIQUE 制約を、本機能の UPSERT パターンにそのまま再利用する。

---

## 影響を受ける既存テーブル

### `messages` (再利用、変更なし)

| 列 | 型 | 役割 (本機能での利用) |
|---|---|---|
| `id` | uuid PK | 既存どおり。echo INSERT 経路でも `defaultRandom()` で採番 |
| `tenant_id` | uuid NOT NULL FK | 既存どおり。echo は `connectedPages.tenantId` 経由で解決 |
| `conversation_id` | uuid NOT NULL FK | `(pageId, recipient.id)` の upsert 結果で取得 |
| `direction` | varchar(10) NOT NULL | echo INSERT は `'outbound'` 固定 |
| `meta_message_id` | varchar(128) **UNIQUE** NULL | **UPSERT のキー**。echo INSERT で必須セット、自送信 INSERT は NULL (後段で書き戻し) |
| `body` | text NOT NULL | テキストは Meta テキスト、非テキストは `''` (Q1) |
| `message_type` | varchar(20) NOT NULL DEFAULT 'text' | `'text' / 'sticker' / 'image' / 'unknown'` |
| `timestamp` | timestamptz NOT NULL | echo の `event.timestamp` を `new Date(ts)` で渡す。INSERT 経路で採用、UPDATE 経路では触らない (Q3) |
| `send_status` | varchar(20) NULL | echo INSERT は `'sent'`、UPDATE 経路は `'sent'` 上書き |
| `send_error` | text NULL | echo 経路では触らない |
| `sent_by_auth_uid` | uuid NULL | 外部送信は `null`。`echo_send_attribution_recovered` 経路でのみ後追い設定 |
| `created_at` | timestamptz NOT NULL DEFAULT now | 既存どおり (INSERT 時自動) |

### `conversations` (再利用、変更なし)

`(page_id, customer_psid)` UNIQUE が UPSERT に既に有効。echo 経路では `customer_psid = event.recipient.id` を渡す ([research.md R2](./research.md#r2-会話解決-recipientid-ベースの-upsert))。`last_inbound_at` / `last_message_at` / `unread_count` / `customer_name` は echo 経路では触らない ([research.md R3](./research.md#r3-echo-経路で発火させない副作用の明示))。

---

## 状態遷移: `messages` 1 行のライフサイクル

本機能で関与する状態遷移を以下に明示する。`mid` = `metaMessageId`、状態は `(direction, sendStatus, metaMessageId, sentByAuthUid)` の 4-tuple。

### A. 自送信パス (echo より TX2 が先に成功する正常系)

```
[start]
  │
  │ send-reply TX1 INSERT
  ▼
(outbound, pending, NULL, U)
  │
  │ send-reply TX2 UPDATE (Meta Send API 成功)
  ▼
(outbound, sent, X, U)        ← この時点で行は確定
  │
  │ echo 到着 → UPSERT ON CONFLICT DO UPDATE SET sendStatus='sent'
  ▼
(outbound, sent, X, U)        ← 変化なし (冪等)
```

### B. echo 先着 → 送信側 UPDATE で UNIQUE 違反 → attribute 補正

```
[start]
  │
  │ send-reply TX1 INSERT
  ▼
(outbound, pending, NULL, U)  ← R.id
  │
  │ echo 到着 (TX2 より先) → UPSERT INSERT (R.id とは別の行 E.id)
  ▼
R.id: (outbound, pending, NULL, U)
E.id: (outbound, sent,    X,    NULL)
  │
  │ send-reply TX2 UPDATE WHERE id=R.id SET mid=X
  │ → UNIQUE 違反 (E.id がすでに X を持つ)
  │ → catch 内で:
  │   ・DELETE WHERE id=R.id
  │   ・UPDATE E.id SET sentByAuthUid=U
  ▼
E.id: (outbound, sent, X, U)  ← 1 行に収束
```

### C. 純粋な外部送信 (fumireply は送っていない、Messenger 公式アプリで返信)

```
[start: messages テーブルに該当 mid の行なし]
  │
  │ echo 到着 → UPSERT INSERT
  ▼
(outbound, sent, X, NULL)     ← 新規行
  │
  │ 同一 echo 再配信 → UPSERT ON CONFLICT DO UPDATE
  ▼
(outbound, sent, X, NULL)     ← 変化なし (冪等)
```

### D. 自送信パスが SendAPI 失敗で `failed` 状態の行を残した後の echo

```
[start]
  │
  │ send-reply TX1 INSERT
  ▼
(outbound, pending, NULL, U)
  │
  │ Meta Send API 失敗 → TX2 で failed セット
  ▼
(outbound, failed, NULL, U)
  │
  │ echo は来ない (Meta が送信できなかったため)
  ▼
変化なし
```

→ 既存挙動と整合。echo は SendAPI 成功時のみ Meta から配信される前提。

---

## 不変条件 (Invariants)

本機能後の `messages` テーブルに対して常に成り立つ:

1. **1 つの `meta_message_id` 値に対し、行は最大 1 件** (UNIQUE 制約による)
2. **`send_status='sent'` AND `metaMessageId IS NULL` の行は存在しない** (送信完了状態は必ず Meta mid を持つ)
3. **`send_status='pending'` の行は `metaMessageId IS NULL`** (TX1 INSERT 直後のみ)
4. **`direction='outbound'` AND `sent_by_auth_uid IS NULL` AND `send_status='sent'`** は「外部送信または attribute 補正前の echo INSERT」を意味する (これらをまとめて「fumireply 経由でない送信」とみなす)
5. **未返信バッチ判定の boundary `MAX(timestamp) WHERE direction='outbound' AND conversation_id=C`** は echo INSERT 行を自然に含む (FR-010)

不変条件 5 は #004 のクエリ (`ai-worker/src/handler.ts:238` 付近) を改変せずに成立する。

---

## 既存 #004 / #005 機能との非干渉確認

| 機能 | 影響 | 説明 |
|---|---|---|
| #004 未返信バッチ判定 | ✅ 改善 | echo INSERT 後の `MAX(timestamp WHERE direction='outbound')` が外部送信を含むため、運営者が外部アプリで返信した会話は自動的にバッチ対象外になる (User Story 3 / SC-004) |
| #005 ワンオフ再生成 | ➖ 影響なし | echo 経路は `ai_drafts` を一切触らない |
| #005 stale-pending guard | ➖ 影響なし | echo 経路は `ai_drafts.status` を読まない・書かない |
| `lastInboundAt` / `unreadCount` | ➖ 影響なし | echo 経路で更新しない (research.md R3) |
| `lastMessageAt` | ⚠️ 注意 | echo INSERT 行は `lastMessageAt` を進めない。「会話一覧の並びが外部送信を反映しない」が今回スコープ外。Issue 化候補 |

---

## マイグレーション

不要。本機能は drizzle スキーマファイル `schema.ts` を変更しない。`drizzle/` ディレクトリへの SQL マイグレーション追加もしない。
