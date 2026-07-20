# Data Model: 送信側メディア添付

**Feature**: 010-outbound-media | **Date**: 2026-07-20 | **Input**: [spec.md](./spec.md), [research.md](./research.md)

## DB スキーマ変更: **ゼロ**

009 で追加済みの `messages.attachments jsonb` と `MessageAttachment` 型をそのまま使う。マイグレーションなし。

## エンティティ

### メッセージ (messages) — 既存、値パターンが増える

送信側 (direction='outbound') メッセージが送信時点で `attachments` を持てるようになる。

| 送信内容 | 生成される行 | messageType | body | attachments | sendStatus |
|---|---|---|---|---|---|
| テキストのみ (従来) | 1 行 | `text` | 入力テキスト | NULL | pending→sent/failed |
| 画像のみ | 1 行 | `image` | `''` | `[{index:0, type:'image', s3Key, contentType, sizeBytes}]` | pending→sent/failed |
| テキスト+画像 | 2 行 (text 行 → image 行の順) | `text` / `image` | テキスト / `''` | NULL / 上記 | 行ごとに独立 |

- `attachments` の要素形式は 009 の `MessageAttachment` と完全互換 (`index` / `type` / `s3Key` / `contentType` / `sizeBytes`)。送信側では `s3Key` は必ず非 null (アップロード済みでなければ送信させないため)、`contentType` / `sizeBytes` は HeadObject の検証値を記録する
- 「添付ゼロは NULL、空配列 `[]` は書かない」という 009 の規約を維持する
- `sentByAuthUid` は従来どおり送信オペレーターの UID。`metaMessageId` は Send API 成功後に設定
- image 行の `timestamp` は text 行より後になる (逐次送信のため自然に単調増加。同値衝突を避けるため 2 通目は 1 通目確定後に `new Date()` を取り直す)

### 状態遷移 (画像メッセージ行)

```
(なし) --sendReplyFn TX: pending INSERT (attachments 込み)--> pending
pending --Send API 成功--> sent (+ metaMessageId)
pending --Send API 失敗/時間予算切れ--> failed (+ sendError)
pending --mid unique 衝突 (echo 先行)--> 行 DELETE、echo 行を claim (sentByAuthUid + sendStatus='sent')
```

009/006 から変わらない遷移。「時間予算切れ」(research D4) は `failed` + `sendError:'timeout'` に写像する。

### 事前アップロード (Pre-upload) — **DB エンティティなし (S3 のみ)**

アップロード管理テーブルは作らない (research D2)。事前アップロードの実体は S3 オブジェクトそのもの:

```
キー: {tenantId}/{conversationId}/outbound/{uploadId(uuid)}/0
メタ: ContentType (allowlist 4 種) / ContentLength (≤ 25MiB)
```

- **帰属検証はキー構造で行う**: `sendReplyFn` は s3Key が `^{authのtenantId}/{指定のconversationId}/outbound/{uuid}/0$` に一致することを検証し、さらに `HeadObject` で実在・ContentType・サイズを確認する
- 送信されなかったオブジェクトは孤児として残る (掃除は #78)
- `uploadId` の一意性はサーバー採番の UUID で担保。同一 s3Key の再送信 (再送 UI) は同じオブジェクトを参照する 2 行になり得るが無害 (削除がないため)

## 不変条件

1. **INV-1**: direction='outbound' かつ `attachments` 非 NULL の行では、全要素の `s3Key` が `{tenantId}/{conversationId}/outbound/` プレフィックスを持つ (受信側は mid ベースの第 3 セグメント)。表示側の `toUrl` プレフィックス検証は両者を同一に扱える
2. **INV-2**: 画像メッセージ行が `sent` になるのは Send API が message_id を返した後のみ。`attachments` は pending INSERT 時点から不変 (echo upsert は sendStatus しか触らない — FR-012)
3. **INV-3**: 1 回の送信操作で作られる行は最大 2 (text, image)。互いに FK 等の関連は持たず、成否は完全に独立 (spec US2)
4. **INV-4**: `MEDIA_BUCKET_NAME` 未設定環境では attachments 付き outbound 行は新規に生まれない (createUploadUrlFn / sendReplyFn 双方が拒否)
5. **INV-5**: 009 の不変条件 (NULL/非空配列規約、テナント分離キー構造、恒久公開 URL なし) はすべて維持
