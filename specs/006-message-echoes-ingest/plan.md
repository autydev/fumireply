# Implementation Plan: 外部送信メッセージを `message_echoes` で取り込む

**Branch**: `006-message-echoes-ingest` | **Date**: 2026-06-27 | **Spec**: [spec.md](./spec.md)
**Input**: Feature specification from `/specs/006-message-echoes-ingest/spec.md`

## Summary

#001 以来の Meta Webhook 受信パスを最小拡張し、運営者が **fumireply 以外のアプリ (Messenger 公式アプリ等) から顧客に返信した送信** を、Meta が `message_echoes` 経由で配信するエコーから取り込んで `messages` テーブルに `direction='outbound'` として残す。これにより:

1. スレッド UI 上で外部送信もタイムライン上に表示される (User Story 1)
2. fumireply 自身の送信エコーは冪等更新で 1 行に収束する (User Story 2)
3. #004 の未返信バッチ判定境界 (`MAX(timestamp) WHERE direction='outbound'`) が外部送信を自然に反映する (User Story 3)

**アーキテクチャ要点** (詳細は `research.md` / `contracts/echo-pipeline.md`):

- **新規 Lambda・新規 SQS・DB マイグレーションなし**。既存 `webhook/src/handler.ts` の `is_echo` 分岐の差し替え + `send-reply.fn.ts` の mid 書き戻し UPSERT 化 + Meta App 設定での `message_echoes` フィールド購読 (人手) のみ。
- **echo 取り込みは `(meta_message_id)` UNIQUE 制約上の UPSERT** で実装する: `INSERT ... ON CONFLICT (meta_message_id) DO UPDATE SET sendStatus='sent'`。既存行が存在すれば `sendStatus` のみを更新し `timestamp` / `body` / `sentByAuthUid` は触らない。存在しなければ新規 `outbound` 行を INSERT する。
- **送信側パス `send-reply.fn.ts` の `metaMessageId` 書き戻しを安全化**: UNIQUE 違反 (echo が先着して同 mid で既に行を作っていた) を捕捉し、自分が INSERT した tentative 行を DELETE → echo の作った行に `sentByAuthUid` を attribute する 1 トランザクションで「常に 1 行に収束」を保証する。
- **会話リンク解決**: echo では `event.recipient.id` が顧客 PSID、`event.sender.id` が PageID。 inbound 経路と同じ `(pageId, customerPsid)` UPSERT を `recipient.id` で行う関数 (`resolveConversationForEcho`) に切り出して inbound/echo で共有。
- **echo は AI 下書き / Summary / Customer name fetch を発火させない**: 既存の inbound 経路の副作用は流用せず、echo はメッセージ INSERT/UPDATE と構造化ログのみで完結する。
- **観測性**: `event=external_echo_ingested` (新規 INSERT) / `event=self_echo_confirmed` (既存行 UPDATE) / `event=echo_send_attribution_recovered` (UNIQUE 衝突時の attribute 補正) を CloudWatch Logs に出力。カスタムメトリクスとアラートは追加しない。
- **データモデル変更なし**: `messages` テーブルは #001 のまま。`metaMessageId` の column-level UNIQUE 制約をそのまま UPSERT のターゲットに使う (テナント横断で `mid` は実用上一意、Meta 仕様も同様の保証)。

## Technical Context

**Language/Version**: TypeScript 5.x / Node.js 24.x (`nodejs24.x` Lambda)。001〜005 と同一。
**Package Manager**: npm (`webhook/package-lock.json`, `app/package-lock.json`)。
**HTTP クライアント方針**: グローバル `fetch` のみ、axios 系の新規導入禁止。Meta Send API は既存 `messenger.ts` 経由、変更不要。

**Primary Dependencies**:
- 新規 npm パッケージなし。既存 `drizzle-orm` の `onConflictDoUpdate` / `onConflictDoNothing` を使う。
- 既存依存はそのまま (`@aws-sdk/client-sqs` は echo で増えない・減らない)。

**Infrastructure**:
- 既存 Lambda 構成 (webhook / app / ai-worker / keep-alive) を維持。**新規 Lambda・新規 SQS キュー・新規 SSM パラメタなし**。
- IAM・env も追加なし。`docs/resume-webhook-bringup.md` の手順書に Meta App 管理画面で `message_echoes` 購読フィールドを有効化する作業を追記するのみ (手動作業)。
- CDK/Terraform 等の IaC 更新なし。

**Storage**: 既存 Supabase Postgres。**マイグレーションなし**。`messages.metaMessageId` の column-level UNIQUE 制約 (`schema.ts:114`) を UPSERT ターゲットに再利用。

**Testing & CI**:
- vitest (webhook):
  - echo + 既存自送信 (pending) 行あり → UPDATE 経路: `sendStatus='sent'` に確定、`timestamp`/`body`/`sentByAuthUid` 不変、行数 1
  - echo + 既存行なし → INSERT 経路: `direction='outbound'`, `sentByAuthUid=null`, `sendStatus='sent'`, `messageType='text'`, `body=テキスト` / 非テキストは `body=''` + `messageType=sticker|image|unknown`
  - 同一 mid の echo 2 回 → 行数 1 のまま、状態 `sent` 維持
  - 未知 Page → 既存どおり skip
  - 会話未存在 (新規 PSID) → `(pageId, recipient.id)` UPSERT で会話自動生成
  - echo で `lastInboundAt` / `unreadCount` は変化しない (副作用なし)
  - echo は SQS 送信 / Summary trigger / Name fetch を呼ばない
  - 構造化ログ: INSERT 経路で `event=external_echo_ingested`、UPDATE 経路で `event=self_echo_confirmed`
- vitest (app, send-reply):
  - mid 書き戻し時に UNIQUE 違反が起きたら: tentative 行を DELETE + 既存行に `sentByAuthUid` を attribute、戻り値の `message.id` は **収束後の存続行 ID** を返す
  - 通常時 (echo 先着なし) の挙動回帰 (PASS そのまま)
- Playwright E2E スモーク: 既存スレッド画面に自送信 + (mock した) echo INSERT 経路の outbound が両方表示され、二重表示しないこと

**Target Platform**: 001〜005 と同一 (AWS Lambda + API Gateway / Supabase)。

**Project Type**: 既存 webhook Lambda + app server fn の機能拡張。

**Performance Goals**:
- SC-001: echo 受信から DB 反映まで p95 < 10 秒 (Webhook 通常 SLA 内)。UPSERT 1 文・トランザクション 1 個・追加の外部 I/O ゼロ。
- 既存 inbound 経路に対する追加コスト・レイテンシゼロ (echo 分岐は inbound と独立)。

**Constraints**:
- **マルチテナント安全性**: `metaMessageId` の column-level UNIQUE はテナント横断。echo の入口で `pageId → connectedPages.tenantId` を解決済みのため、UPSERT が他テナントの行を触る経路は理論上ない (Meta が他テナントの Page と同じ mid を発行する確率はゼロに近く、しても `tenantId` を ON CONFLICT 後の `WHERE` で防御する)。
- **冪等性**: Meta は echo を再送しうる前提 (FR-008)。UPSERT の `DO UPDATE SET sendStatus='sent'` は何度実行しても結果同じ。`timestamp` は UPDATE 経路で触らないので、自送信パスが書いた送信時刻 (`now()`) を Meta 確定時刻で上書きしない (Q3)。
- **send-reply の attribute 補正トランザクション**: UNIQUE 違反 catch → DELETE + UPDATE を 1 つの `withTenant` 内で実行。`messages.id` の見え方が変わるが、`get-conversation.fn.ts` は `metaMessageId` ではなく `id` で参照される箇所がないため UI 表示順は保たれる (timestamp 順)。
- **後方互換**: 既存 echo 分岐は単に UPDATE のみだったため、新コードは「既存挙動 + INSERT 経路」のスーパーセット。fumireply 経由送信 echo の挙動は変わらない。
- **`message_echoes` 未購読時の振る舞い**: フィールドを Meta App 管理画面で有効化するまで本機能のコード変更は無害 (echo イベントが届かない)。デプロイ → 購読有効化の順で安全に切替可能。

**Scale/Scope**:
- 追加・変更コード LOC 目安: ~150 行
  - `webhook/src/handler.ts` (MODIFY: echo 分岐を INSERT+UPDATE UPSERT に置換、会話解決を recipient.id ベースで実装、構造化ログ追加) 60 行
  - `webhook/src/handler.test.ts` (NEW テストケース 6 件追加) 40 行
  - `app/src/routes/(app)/threads/$id/-lib/send-reply.fn.ts` (MODIFY: mid 書き戻しの UNIQUE 違反 catch + attribute 補正) 30 行
  - `app/src/routes/(app)/threads/$id/-lib/send-reply.fn.test.ts` (NEW テストケース 2 件追加) 15 行
  - `docs/resume-webhook-bringup.md` (MODIFY: 購読フィールドに `message_echoes` を追記、運用手順) 5 行
  - スキーマ・IaC・env: 変更なし

## Constitution Check

*GATE: Phase 0 前にパス、Phase 1 設計後に再チェック。*

**プロジェクト憲法の状態**: `.specify/memory/constitution.md` 未ラティファイ (テンプレ状態)。001〜005 同様、業界標準ゲートを暫定適用する。

| ゲート | 判定 | 根拠 |
|---|---|---|
| **YAGNI** | ✅ PASS | スコープは echo の取り込みに限定。app_id による送信元アプリ追跡、UI 上の自/外区別、過去送信遡及取り込みは明示除外 (spec Assumptions)。 |
| **単一責任** | ✅ PASS | Story 1〜3 は UPSERT 1 つの帰結。テスト粒度も 1 機能内で完結。 |
| **テスト可能性** | ✅ PASS | echo 分岐は純粋に `messagingEvent → DB 状態遷移` の関数。fixture を 6 パターン用意するだけで網羅可能。 |
| **シンプル優先** | ✅ PASS | DB マイグレーション 0 本、新規 Lambda・SQS・SSM・npm 0 件、env 追加 0 件、IAM 追加 0 件。Meta App 設定 1 項目の手動有効化のみ。 |
| **観測性** | ✅ PASS | `external_echo_ingested` / `self_echo_confirmed` / `echo_send_attribution_recovered` を構造化ログで出力。 CloudWatch Logs Insights で集計可能 (SC-006)。 |
| **可逆性** | ✅ PASS | スキーマ変更なし。コードロールバックで完全な旧挙動に戻る。`message_echoes` 購読を解除すれば Meta 側の配信も止まる。 |

**複雑性の正当化**: 不要。

**Phase 1 設計後の再チェック (2026-06-27)**: 全 6 ゲート PASS 維持。data-model 再確認で DB 列・index・制約追加ゼロ。contracts でログイベント名と UPSERT ターゲット (`meta_message_id`) を明示。

## Project Structure

### Documentation (this feature)

```text
specs/006-message-echoes-ingest/
├── spec.md                       # 仕様書 (clarify 後)
├── plan.md                       # 本ファイル
├── research.md                   # Phase 0 (UPSERT 戦略 / attribute 補正 / 会話解決の根拠)
├── data-model.md                 # Phase 1 (messages 列再確認: 変更なし / 状態遷移表)
├── quickstart.md                 # Phase 1 (Meta App 購読有効化手順 + CloudWatch Logs Insights クエリ例)
├── contracts/
│   └── echo-pipeline.md          # Webhook 購読フィールド + echo handler 契約 + send-reply UPSERT 契約 + log イベントキー
└── checklists/
    └── requirements.md           # 品質チェックリスト (specify で作成済み)
```

### Source Code (変更/追加ファイル中心)

```text
webhook/                                       # Meta Webhook 受信 Lambda
├── src/
│   ├── handler.ts                             # MODIFY: is_echo 分岐を UPSERT + 会話解決 + 構造化ログに置換
│   └── handler.test.ts                        # MODIFY: echo INSERT / UPDATE / 重複 / 非テキスト / 会話自動生成 / 副作用なし テスト追加

app/                                           # TanStack Start アプリ + Lambda
├── src/
│   └── routes/(app)/threads/$id/-lib/
│       ├── send-reply.fn.ts                   # MODIFY: mid 書き戻しを try/catch UNIQUE で attribute 補正 (DELETE + UPDATE)
│       └── send-reply.fn.test.ts              # MODIFY: UNIQUE 違反 catch 経路のテスト追加

docs/
└── resume-webhook-bringup.md                  # MODIFY: 購読フィールドに `message_echoes` を追記、運用切替手順
```

**Structure Decision**: 既存の echo 分岐 (4 行) を「会話解決 → UPSERT → ログ」のミニパイプラインに置換し、 inbound 経路の副作用 (SQS / Summary / Name fetch) は流用しない。送信側パスの `metaMessageId` 書き戻しは UPSERT 化ではなく **既存 UPDATE + UNIQUE 違反時の attribute 補正** で対称性を取る (echo が DB に書き込むより前に `id` を確定済みのため UPDATE 経路の方が自然)。スキーマ・IaC・env はゼロ変更を維持。

## Complexity Tracking

> 不要 (Constitution Check で違反なし)。
