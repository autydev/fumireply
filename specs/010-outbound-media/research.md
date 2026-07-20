# Research: 送信側メディア添付 — オペレーターから顧客への画像送信

**Feature**: 010-outbound-media | **Date**: 2026-07-20 | **Spec**: [spec.md](./spec.md) | **親 Issue**: autydev/fumireply#82

Phase 0 の設計判断。spec の Assumptions で計画フェーズに委譲された論点 (アップロード方式 / Meta への受け渡し方式 / S3 キー構造 / サイズ上限) をここで確定する。

---

## D1: 画像アップロードは「ブラウザ → S3 直接 (presigned PUT)」

**Decision**: 新 server fn `createUploadUrlFn` が S3 キーと presigned PUT URL (有効 300 秒、`ContentType` 固定) を発行し、ブラウザが `fetch` で S3 に直接 PUT する。送信実行時 (`sendReplyFn`) にサーバーが `HeadObject` で実在・ContentType・サイズを再検証する。

**Rationale**:
- app は Lambda 上で動いており、server fn 経由のバイナリ送信は **Lambda invocation payload 上限 (~6MB) + base64 膨張 (×1.37)** で実質 4MB 程度しか通らない。上限 25MB の画像を扱う手段として成立しない。
- presigned PUT は既存の presign 読み取り機構 (`media-url.ts`) と同じ `@aws-sdk/s3-request-presigner` で発行でき、新規依存ゼロ。
- クライアント側でも選択時に型・サイズを即時検証する (FR-002 の一次防御)。

**サイズを S3 側で強制する (悪用/コスト対策 — レビュー中-1)**:
- presigned PUT だけでは本来アップロードサイズを制約できず (単一 PUT は 5GB まで通る)、`HeadObject` 検証は「送信させない」だけでオブジェクトは残置される。認証済みオペレーターやセッション奪取で巨大オブジェクトをバケットに積める余地が残る。
- 対策として **`PutObjectCommand` に `ContentLength` (= クライアント申告 `sizeBytes`、`createUploadUrlFn` が `MAX_ATTACHMENT_BYTES` 以下に制限済み) を含めて署名**する。s3-request-presigner はこれを署名済みヘッダに含め、ブラウザ `fetch` はボディ実バイト数から `Content-Length` を自動設定するため、申告より大きい/小さいボディは S3 が 403 で拒否する。これでサイズは**アップロード時点で S3 が強制**する (Content-Type も同様に署名に含めて型を固定)。
  - 実装上の注意: SDK バージョンによっては `ContentLength` が署名ヘッダに乗らない (hoist される) 場合があるため、実装時に presign 済みリクエストの署名ヘッダを確認する。乗らない場合のフォールバックは presigned POST の `content-length-range` 条件。
- 二重防御として `outbound/` プレフィックスに**短期ライフサイクル (未参照掃除ではなく期限失効)** を Terraform で設定する余地を残す (下記 D9 / #78 と連携)。送信済みオブジェクトも失効するが、送信済みメッセージの再表示は presign 再発行時に S3 に実体が必要なため、ライフサイクル日数は保持期間ポリシー (#78) の決定に委ねる。MVP では最低限のガードとして「アップロード時サイズ強制」を必須、ライフサイクルは #78 送りとする。

**Alternatives considered**:
- **server fn に FormData で送る**: Lambda payload 上限で不成立 (上述)。
- **presigned POST (policy `content-length-range`)**: サイズ帯を強制でき堅牢だが multipart/form-data の組み立てが増える。今回は `sizeBytes` を事前に確定できる (file.size) ため PUT + `ContentLength` 署名で厳密一致を強制でき、実装が薄い方を採用。署名ヘッダが機能しない場合の第一フォールバックとして温存。
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

presigned GET は既存 `media-url.ts` の `getAttachmentUrl` (有効 1h、15 分窓量子化 + キャッシュ、残余有効期間は最短 45 分) をそのまま使う。Meta の即時取得には十分。

**Rationale**:
- Meta は `payload.url` を送信処理時に即時取得する。有効 1h の presigned URL で十分であり、恒久公開 URL を作らない (FR-011)。
- Attachment Upload API (`/me/message_attachments` → `attachment_id`) は Meta 呼び出しが 2 回になり multipart アップロード実装も増える。同一画像の再利用 (`is_reusable`) も MVP に不要。Meta 側の URL 取得失敗が目立つ場合の将来改善として温存。
- 既存のタイムアウト・リトライ・エラーマッピングをテキスト送信と共用できる。**実コード `messenger.ts` の挙動 (レビュー高-2 で確認)**: `MAX_RETRIES=3` (= 3 試行) で backoff は attempt>0 のみ発生し実際は **500ms + 1500ms の 2 回だけ** (`500*3^(attempt-1)`; 4500ms は 4 試行目の前でしか起きず到達しない)。timeout 経路は `if (attempt < 1) continue` で **1 回だけ再試行**し、2 回目の timeout は即 `meta_server_error` を返す。エラー union は `token_expired | outside_window | permission_denied | invalid_request | meta_server_error | timeout`。
  - 1 通あたりの現実的な最悪所要時間: 5xx 連続で `5 + 0.5 + 5 + 1.5 + 5 = 17s`、timeout 経路で `5 + 0.5 + 5 = 10.5s`。← D4 の時間予算はこの実測値に基づいて再導出する。

**Alternatives considered**:
- **Attachment Upload API + attachment_id**: 上述の理由で MVP 不採用。
- **バケットの一部を公開して素の URL を渡す**: FR-011 (認可なし恒久 URL 禁止) に違反。不採用。

## D4: テキスト+画像は「テキスト → 画像」の 2 通逐次送信。共有 deadline を Meta 送信に渡してリトライを切り詰め、pending 放置を防ぐ

**Decision**: `sendReplyFn` を「送信パーツの配列 (text?, image?)」を逐次処理する形に拡張する。各パーツは独立に (pending INSERT → Meta 送信 → sent/failed 確定) を実行し、既存の echo レース回復 (`messages_meta_message_id_unique` 衝突 → pending 削除 + echo 行 claim) もパーツ単位でそのまま働く。

pending 放置を防ぐ仕組みは **009 の `MEDIA_TOTAL_BUDGET_MS` と同じ「共有 deadline をダウンストリームに渡して試行ごとに切り詰める」方式**を採る (レビュー高-1 の修正)。単なる「開始前チェック」では、一度 Meta 送信を始めた後のリトライラダーを止められず放置を防げないため:

1. handler 冒頭 (attachment ありのとき) で `deadlineMs = Date.now() + SEND_TOTAL_BUDGET_MS` を **1 回だけ**計算し、両パーツの `sendMessengerReply` に同じ `deadlineMs` を渡す (予算は 2 通で共有)。
2. `sendMessengerReply` に optional `deadlineMs?: number` を追加する。各試行の前に `remaining = deadlineMs - Date.now()` を計算し、
   - `remaining < SEND_MIN_ATTEMPT_MS` なら以降の試行を打ち切り `{ ok:false, error:'timeout' }` を返す (それ以上 Meta を呼ばない)、
   - そうでなければ当該試行の fetch timeout を `min(TIMEOUT_MS, remaining)` にクランプする。
3. `deadlineMs` 省略時 (テキストのみ送信) は現行と完全に同一挙動 (後方互換)。テキストのみは 1 通・最悪 17s < 30s で予算不要。

**定数** (実測ラダーから再導出 — research D3):
- `SEND_TOTAL_BUDGET_MS = 25_000`: Lambda timeout 30s から TX1/SSM/decrypt/HeadObject/presign/2×TX2 のオーバーヘッド ~5s を引いた、2 通の Meta 呼び出し合計の上限。
- `SEND_MIN_ATTEMPT_MS = 1_500`: これ未満の残余では意味のある 1 試行が入らないため打ち切る下限。

**Rationale**:
- Meta Send API はテキストと添付を 1 通に同居できないため 2 通送信は必須 (spec 前提)。順序保証は「1 通目の結果確定を待ってから 2 通目」で実現する。
- 共有 deadline により **2 通の Meta 呼び出し合計が必ず `SEND_TOTAL_BUDGET_MS` 以内**に収まる。予算が尽きた時点で走行中パーツの試行が打ち切られ terminal failure を返すため、`pending` のまま放置される行が出ない (008 で潰した障害の再発防止)。
- **予算切れ・timeout は既存の `meta_error` に写像**する (レビュー中-3 の修正)。`sendMessengerReply` の `timeout` は send-reply 側の既存マッピングで `meta_error` に落ちるため、DB の `sendError` union (`outside_window|token_expired|meta_error|validation_failed`) や ReplyForm の i18n に**新値を足さない**。「既存枠組みで記録 (FR-008)」と整合する。
- 1 通目 (テキスト) が失敗しても 2 通目 (画像) は独立に試行する。「どこまで届いたか」が行単位で残る (spec US2-3)。部分失敗の自動ロールバックはしない (送信済みメッセージは取り消せないため)。

**トレードオフ (明示)**: 予算は 2 通で共有するため、1 通目が予算の大半を消費 (Meta が 5xx を連続で返す等) すると 2 通目は実質 1 試行未満しか得られず `meta_error` になり得る。ただしテキストと画像は同一ページ・同一エンドポイントに送るため、テキストが 5xx を返す状況では画像も失敗する公算が高く、実害は小さい。パーツごとに予算を等分する案 (各パーツに `BUDGET/2` を割り当て) は 2 通目の最低試行を保証できるが、片方しか送らない一般ケースで予算を無駄にするため MVP では共有方式を採る。

**Alternatives considered**:
- **開始前チェックのみ (deadline を渡さない)**: 走行中のラダーを止められず、1 通目が閾値ぎりぎりで終わると 2 通目のフルラダーで Lambda を超過し pending 放置になる (レビュー高-1)。不採用。
- **2 通を並列送信**: 到着順序 (テキスト → 画像) が保証できない。不採用。
- **クライアントから 2 回 server fn を呼ぶ**: 順序・原子性の制御がクライアント依存になり、タブ閉じで 2 通目が消える。不採用。

## D5: 対応形式は jpeg/png/gif/webp、サイズ上限 25MB (受信側と同一)

**Decision**: allowlist は `image/jpeg`, `image/png`, `image/gif`, `image/webp` の 4 種、上限は `MAX_ATTACHMENT_BYTES = 26_214_400` (25 MiB、009 の定数を共用) とする。定数は 1 箇所 (`media-upload.ts`) に置き、client / `createUploadUrlFn` / `sendReplyFn` の三層で同じ値を参照する。

**Rationale**:
- Meta の公開情報では Send API の添付上限は 25MB、画像解像度上限は 85 メガピクセル。受信側 (009) の保存上限 25MB とも揃い、境界がひとつで済む。
- webp は Meta ドキュメント上で明示的な言及を確認できなかったため、**quickstart の手動検証項目 (リリース直後に最優先)** とする。実機で Meta が拒否する場合は allowlist 定数から 1 行外すだけ (spec Assumptions の「判明した場合は引き下げ」に相当する運用)。判明までの間、webp 送信は「アップロード成功 → 送信 meta_error」という分かりにくい失敗になる点に留意する。
- **境界の注意**: 上限は 25 MiB = 26,214,400 bytes。一方 Meta の「25MB」が 10 進 (26,000,000 bytes) の可能性があり、`25.0M〜26.2M bytes` の帯は自側検証を通過するが Meta 側で拒否されうる。009 は保存のみでこの帯が無害だったが、010 は Meta 境界を跨ぐため、実機検証で拒否が出たら `MAX_ATTACHMENT_BYTES` を Meta 実測境界まで引き下げる (定数一元化で 1 箇所修正)。

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
- **例外 (レビュー低-3)**: 上記 claim 経路で webhook のダウンロードが失敗していた場合、echo 行の添付は `s3Key: null` (取得不可) で確定するため、正本が `outbound/{uuid}` にあるのに UI がプレースホルダ表示になり FR-012 の「添付情報が失われない」の例外になる。発生条件は「送信成功したのに webhook の再ダウンロードが失敗」で稀。MVP では**稀ケースとして許容**し、回帰テストで挙動を固定する (claim 時に pending 行の `outbound/{uuid}` を echo 行へ引き継ぐ改善は将来検討)。

**Rationale**: 調査の結果、009/006 の設計がそのまま送信側添付と両立する。変更しないことが最小リスク。

## D8: 観測性 — 構造化ログ 3 イベント追加

**Decision**: 既存規約 (`event=` 付き JSON) で以下を追加する。カスタムメトリクス・アラームなし (FR-013)。

| event | level | 発生箇所 | 主なフィールド |
|---|---|---|---|
| `outbound_upload_url_issued` | info | `createUploadUrlFn` | tenantId, conversationId, s3Key, contentType, sizeBytes |
| `outbound_attachment_send_failed` | warn | `sendReplyFn` | tenantId, conversationId, messageId, s3Key, reason (meta_error/timeout/budget_exceeded/…) |
| `outbound_attachment_key_rejected` | warn | `sendReplyFn` | tenantId, conversationId, 提示された s3Key (FR-010 の拒否監査) |

送信成功は既存のメッセージ行 (`sendStatus='sent'` + `messageType='image'`) で集計できるため専用イベントは追加しない。

**アップロード成否のログ可観測性 (レビュー中-2)**: アップロードはブラウザ → S3 直接のため、**S3 PUT の成否はサーバーに届かない**。サーバーが観測できるのは「URL 発行」と「送信の成否」のみ。これに合わせて **spec FR-013 の文言を「アップロード URL 発行と送信の成否」に修正済み** ("spec は実装に合わせる" 方針)。アップロード失敗そのものの集計が将来必要になれば、クライアントから完了/失敗を報告する軽量イベントを別途足す (現状は YAGNI で不要)。

---

## 未解決事項

なし。webp の実機可否のみ quickstart の手動検証項目として繰り越す (結果により allowlist 定数を調整)。

**参考情報源**: Meta Messenger Platform ドキュメント (Send API / Attachment Upload API) は 2026-07-20 時点でページ本文の機械取得が不安定なため、上限値 (25MB / 85MP) は検索結果経由で確認した。実装時の実機検証 (quickstart) で最終確認する。
