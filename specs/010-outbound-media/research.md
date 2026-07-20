# Research: 送信側メディア添付 — オペレーターから顧客への画像送信

**Feature**: 010-outbound-media | **Date**: 2026-07-20 | **Spec**: [spec.md](./spec.md) | **親 Issue**: autydev/fumireply#82

Phase 0 の設計判断。spec の Assumptions で計画フェーズに委譲された論点 (アップロード方式 / Meta への受け渡し方式 / S3 キー構造 / サイズ上限) をここで確定する。

---

## D1: 画像アップロードは「ブラウザ → S3 直接 (presigned PUT)」

**Decision**: 新 server fn `createUploadUrlFn` が S3 キーと presigned PUT URL (有効 300 秒、`ContentType` 固定) を発行し、ブラウザが `fetch` で S3 に直接 PUT する。送信実行時 (`sendReplyFn`) にサーバーが `HeadObject` で実在・ContentType・サイズを再検証する。

**Rationale**:
- app は Lambda 上で動いており、server fn 経由のバイナリ送信は **Lambda invocation payload 上限 (~6MB) + base64 膨張 (×1.37)** で実質 4MB 程度しか通らない。上限 25MB の画像を扱う手段として成立しない。
- presigned PUT は既存の presign 読み取り機構 (`media-url.ts`) と同じ `@aws-sdk/s3-request-presigner` で発行でき、新規依存ゼロ。
- presigned **POST** (policy 条件で `content-length-range` を強制できる) も検討したが、multipart/form-data の組み立てが増える割に、サイズ超過は送信実行時の `HeadObject` 検証で確実に弾ける (アップロード自体は成功しても**送信はさせない**)。PUT + 送信時検証のほうが実装が薄い。
- クライアント側でも選択時に型・サイズを即時検証する (FR-002 の二重防御)。presigned PUT の Content-Type は署名に含めて固定し、宣言と異なる型のアップロードは S3 が 403 で拒否する。

**Alternatives considered**:
- **server fn に FormData で送る**: Lambda payload 上限で不成立 (上述)。
- **presigned POST (policy 条件付き)**: サイズをアップロード時点で強制できる利点はあるが、実装量と引き換え。送信時 HeadObject 検証で同じ安全性を達成できるため不採用。
- **専用アップロード server route (`createFileRoute` の POST handler)**: 同じ Lambda を経由するため payload 上限問題が解決しない。不採用。

## D2: S3 キーは `{tenantId}/{conversationId}/outbound/{uploadId}/0` (UUID ベース)

**Decision**: 送信側のキー第 3 セグメントは `outbound/` + サーバー生成の UUID (`crypto.randomUUID()`) とする。`index` は MVP では常に `0`。

**Rationale**:
- 受信側キー `{tenantId}/{conversationId}/{base64url(mid)}/{index}` は mid 前提だが、送信時は mid が未確定 (Send API 成功後に判明)。アップロードは送信より前に起きるため mid を使えない。
- 先頭 2 セグメントを受信側と揃えることで、表示側 `get-conversation.fn.ts` の `toUrl` が強制する `${tenantId}/${conversationId}/` プレフィックス検証を**変更なしで**通過する。テナント分離も同じキー構造で担保される。
- 受信側キーとの衝突: 第 3 セグメントが `outbound` になるには mid の base64url エンコードが偶然 `outbound` に一致する必要があり、実際の mid (長い `m_...` 形式) では起こらない。
- UUID はサーバー発行のみ (クライアントに採番させない)。`sendReplyFn` は受け取った `s3Key` が「自会話プレフィックス + `outbound/` + UUID 形式」であることを検証し、帰属外キーの持ち込みを拒否する (FR-010)。

**Alternatives considered**:
- **メッセージ行を先に INSERT して行 UUID をキーに使う**: アップロード時点ではメッセージが存在しない (送信を取りやめるかもしれない) ため、キャンセル時にゴミ行が残る。不採用。
- **アップロード管理テーブルを新設**: 追跡・掃除には便利だが、MVP では「キー形式検証 + HeadObject」で足りる。孤児オブジェクトの掃除は #78 に合流 (spec Assumptions)。YAGNI で不採用。

## D3: Meta への受け渡しは presigned GET URL を Send API `payload.url` に載せる

**Decision**: `sendMessengerReply` を拡張し、画像は以下のペイロードで送信する:

```json
{
  "recipient": { "id": "<PSID>" },
  "messaging_type": "RESPONSE",
  "message": { "attachment": { "type": "image", "payload": { "url": "<presigned GET URL>", "is_reusable": false } } }
}
```

presigned GET は既存 `media-url.ts` の `getAttachmentUrl` (有効 1h、15 分窓量子化 + キャッシュ) をそのまま使う。

**Rationale**:
- Meta は `payload.url` を送信処理時に即時取得する。有効 1h の presigned URL で十分であり、恒久公開 URL を作らない (FR-011)。
- Attachment Upload API (`/me/message_attachments` → `attachment_id`) は Meta 呼び出しが 2 回になり multipart アップロード実装も増える。同一画像の再利用 (`is_reusable`) も MVP に不要。Meta 側の URL 取得失敗が目立つ場合の将来改善として温存。
- 既存のタイムアウト (5s)・リトライ (3 回, 500/1500/4500ms)・エラーマッピング (`token_expired` / `outside_window` / `meta_error` / `timeout`) をテキスト送信と共用できる。

**Alternatives considered**:
- **Attachment Upload API + attachment_id**: 上述の理由で MVP 不採用。
- **バケットの一部を公開して素の URL を渡す**: FR-011 (認可なし恒久 URL 禁止) に違反。不採用。

## D4: テキスト+画像は「テキスト → 画像」の 2 通逐次送信、全体時間予算で pending 放置を防ぐ

**Decision**: `sendReplyFn` (実体 `handleSendReply`) を「送信パーツの配列 (text?, image?)」を逐次処理する形に拡張する。各パーツは独立に (pending INSERT → Meta 送信 → sent/failed 確定) を実行し、既存の echo レース回復 (`messages_meta_message_id_unique` 衝突 → pending 削除 + echo 行 claim) もパーツ単位でそのまま働く。

追加で**全体時間予算 `SEND_TOTAL_BUDGET_MS = 22_000`** を導入する: 2 通目の Meta 呼び出し開始前に経過時間を確認し、残余が 1 試行分 (5s) に満たない場合は Meta を呼ばずに `failed` (`send_error: 'timeout'`) で確定する。

**Rationale**:
- Meta Send API はテキストと添付を 1 通に同居できないため 2 通送信は必須 (spec 前提)。順序保証はシンプルに「1 通目の結果確定を待ってから 2 通目」で実現する。
- app Lambda timeout は 30s。既存リトライラダー (5s timeout × 3 試行 + backoff 6.5s ≒ 最悪 21.5s) が 2 通ぶん重なると最悪 ~43s となり Lambda が途中死する。その場合 2 通目が `pending` のまま放置される — 008 で潰した「pending 放置」の再発になるため、時間予算で 2 通目を早期に `failed` 確定させる (008 D2 と同じ思想)。
- 1 通目 (テキスト) が失敗しても 2 通目 (画像) は独立に試行する。`outside_window` 等なら同じ失敗になるだけで害はなく、「どこまで届いたか」が行単位で残る (spec US2-3)。部分失敗の自動ロールバックはしない (送信済みメッセージは取り消せないため)。

**Alternatives considered**:
- **1 通目失敗時に 2 通目をスキップ**: 分岐が増える割に、試行しても結果は同等 (同じエラーで failed)。一時エラーではむしろ画像だけ届く可能性を残せる。不採用。
- **2 通を並列送信**: 到着順序 (テキスト → 画像) が保証できない。不採用。
- **クライアントから 2 回 server fn を呼ぶ**: 順序・原子性の制御がクライアント依存になり、タブ閉じで 2 通目が消える。不採用。

## D5: 対応形式は jpeg/png/gif/webp、サイズ上限 25MB (受信側と同一)

**Decision**: allowlist は `image/jpeg`, `image/png`, `image/gif`, `image/webp` の 4 種、上限は `MAX_ATTACHMENT_BYTES = 26_214_400` (25 MiB、009 の定数を共用) とする。定数は 1 箇所 (`media-upload.ts`) に置き、client / `createUploadUrlFn` / `sendReplyFn` の三層で同じ値を参照する。

**Rationale**:
- Meta の公開情報では Send API の添付上限は 25MB、画像解像度上限は 85 メガピクセル。受信側 (009) の保存上限 25MB とも揃い、境界がひとつで済む。
- webp は Meta ドキュメント上で明示的な言及を確認できなかったため、**quickstart の手動検証項目**とする。実機で Meta が拒否する場合は allowlist 定数から 1 行外すだけ (spec Assumptions の「判明した場合は引き下げ」に相当する運用)。

**Alternatives considered**:
- **上限 8MB 等へ予防的に引き下げ**: 根拠となる公式記述を確認できず、受信側との整合 (25MB) を優先。実機検証で問題が出た場合のみ調整。

## D6: 機能の有効/無効はサーバー主導のフラグで UI に伝える

**Decision**: `getConversationFn` のレスポンスに `mediaUploadEnabled: boolean` (実体は `MEDIA_BUCKET_NAME` が設定済みか) を追加し、未設定環境では ReplyForm が添付ボタンを描画しない。`createUploadUrlFn` / `sendReplyFn` もサーバー側で未設定なら拒否する (UI 迂回への防御)。

**Rationale**: 009 と同じフェイルセーフ方針 (`MEDIA_BUCKET_NAME` 未設定 → 機能を静かに無効化し、テキスト送信は無影響)。クライアントに env を直接見せない。

## D7: echo との整合は既存機構で成立する (変更なし、テストで固定)

**Decision**: webhook 側のコード変更はしない。以下の既存挙動を前提とし、回帰テストで固定する:

- echo upsert (`webhook/src/handler.ts`) は mid 衝突時 `set: { sendStatus: 'sent' }` のみ更新 → 送信時に書いた `attachments` は上書きされない (FR-012 の「添付消失なし」)
- mid 既存チェックにより再配信時のダウンロードはスキップされる
- echo が先に INSERT した場合の claim 経路 (006) では、claim した echo 行が webhook のダウンロードした添付 (mid キー) を持つため表示は正常。送信時にアップロードした `outbound/{uuid}` 側は孤児化するが許容 (#78)

**Rationale**: 調査の結果、009/006 の設計がそのまま送信側添付と両立する。変更しないことが最小リスク。

## D8: 観測性 — 構造化ログ 3 イベント追加

**Decision**: 既存規約 (`event=` 付き JSON) で以下を追加する。カスタムメトリクス・アラームなし (FR-013)。

| event | level | 発生箇所 | 主なフィールド |
|---|---|---|---|
| `outbound_upload_url_issued` | info | `createUploadUrlFn` | tenantId, conversationId, s3Key, contentType, sizeBytes |
| `outbound_attachment_send_failed` | warn | `sendReplyFn` | tenantId, conversationId, messageId, s3Key, reason (meta_error/timeout/budget_exceeded/…) |
| `outbound_attachment_key_rejected` | warn | `sendReplyFn` | tenantId, conversationId, 提示された s3Key (FR-010 の拒否監査) |

送信成功は既存のメッセージ行 (`sendStatus='sent'` + `messageType='image'`) で集計できるため専用イベントは追加しない。

---

## 未解決事項

なし。webp の実機可否のみ quickstart の手動検証項目として繰り越す (結果により allowlist 定数を調整)。

**参考情報源**: Meta Messenger Platform ドキュメント (Send API / Attachment Upload API) は 2026-07-20 時点でページ本文の機械取得が不安定なため、上限値 (25MB / 85MP) は検索結果経由で確認した。実装時の実機検証 (quickstart) で最終確認する。
