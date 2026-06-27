---
description: "Tasks for 006 — 外部送信メッセージを `message_echoes` で取り込み outbound として表示する"
---

# Tasks: 外部送信メッセージを `message_echoes` で取り込む

**Input**: Design documents from `/specs/006-message-echoes-ingest/`
**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/echo-pipeline.md, quickstart.md

**Tests**: 含む。`determineEchoMessageType` の純粋関数 unit、webhook `processMessagingEvent` の echo 8 ケース (INSERT × 3 種別 / UPDATE 確定 / 重複 / 新規会話 / SQS 非起動 / 未知 Page スキップ)、app `send-reply.fn.ts` の UNIQUE 違反 catch + attribute 補正 2 ケース、#004 境界連動の integration 1 ケース、Playwright E2E スモーク 1 本。

**Organization**: User Story 単位でフェーズ分割。US1 (外部送信が outbound として表示) が MVP。US2 (自送信 echo の冪等性) は US1 と同一 UPSERT 実装の派生で、send-reply 側に UNIQUE catch を追加するのみ。US3 (#004 未返信バッチ判定への自然反映) はコード変更ゼロで integration test 1 本のみ。Foundational (Phase 2) で `upsertConversation` 関数抽出 / `determineEchoMessageType` / `isUniqueViolation` ヘルパを完成させ、各 US 実装が helper 呼び出しに集約できる構造にする。

## Format: `[ID] [P?] [Story] Description`

- **[P]**: 並列実行可（異なるファイルで未完依存なし）
- **[Story]**: US1 / US2 / US3（Setup / Foundational / Polish フェーズには付けない）
- 各タスクに具体ファイルパスを含む
- チェックボックス: `[x]` 完了 / `[ ]` 未着手

## Path Conventions

- TanStack Start アプリ本体: `app/src/`、`app/tests/`
- Webhook Lambda: `webhook/src/`、`webhook/src/handler.test.ts`
- AI Worker Lambda: `ai-worker/src/`、`ai-worker/tests/` (本 feature では未変更)
- DB マイグレーション: `app/src/server/db/migrations/` (本 feature では追加なし)
- 運用手順書: `docs/`

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: ブランチ確認のみ。新規 npm / env / IAM / migration はゼロ。

<!-- unit: U1.1 | deps: none | scope: setup | tasks: T001 | files: 0 | automation: auto -->
**Unit U1.1 (Setup PR)**: 依存追加なし。最小レビューでマージ可能 (実質変更なしのため U2.1 と一括化も可)。

- [ ] T001 Verify branch is `006-message-echoes-ingest` (created by /speckit.specify) and run `npm ci` in `app/` and `webhook/` to ensure clean install. 新規パッケージは追加しない (drizzle の `onConflictDoUpdate` / `onConflictDoNothing` を流用)。

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: echo パスと send-reply パスの両方が依存する **3 つの薄いヘルパ** を先に切り出して安全側で再利用可能にする。これらは既存挙動と等価な無害なリファクタで、US1 / US2 の本体 PR を小さく保つための土台。

**⚠️ CRITICAL**: T002〜T004 のいずれかが未完だと、US1 の echo 分岐実装で会話 upsert のコードを inbound から流用できず重複コードになる。

<!-- unit: U2.1 | deps: U1.1 | scope: backend | tasks: T002-T005 | files: 2 | automation: auto -->
**Unit U2.1 (Foundation PR)**: webhook handler 内の inbound 会話 upsert を関数 `upsertConversation` に切り出し、`determineEchoMessageType` と `isUniqueViolation` を新規追加する純粋リファクタ PR。挙動変化ゼロを `npm test` で確認。LOC 概算 ~60。

### webhook: 共通ヘルパの切り出し

- [ ] T002 Refactor `webhook/src/handler.ts` lines 143-155 — extract the existing conversation upsert into a new exported function `upsertConversation(tx, tenantId, pageUuid, customerPsid): Promise<{ id: string; customerName: string | null }>`. Call it from the existing inbound branch unchanged (no behavior change). この関数は US1 で echo 分岐からも呼ばれる。

- [ ] T003 [P] Add NEW pure function `determineEchoMessageType(msg): { messageType: string; body: string }` to `webhook/src/handler.ts` per research.md R5 / Q1: テキスト → `body=msg.text, messageType='text'`、sticker / image / 未知 → `body='', messageType=...`。inbound 用の既存 `determineMessageType` とは別関数として共存させる (inbound 画像経路は URL を body に入れる挙動を維持)。

### app: UNIQUE 違反判定ヘルパ

- [ ] T004 [P] Add NEW helper `isUniqueViolation(err: unknown, constraint: string): boolean` to `app/src/server/db/errors.ts` (NEW file) per contracts/echo-pipeline.md C4. Postgres エラーコード `23505` と `constraint_name === constraint` の両条件で `true`。`postgres` / `drizzle` のエラーオブジェクトの実形を `console.error` のスナップショットで一度確認してから書く。

- [ ] T005 [P] Add a vitest unit test for `determineEchoMessageType` in `webhook/src/handler.test.ts` (or new `webhook/src/determine-echo-message-type.test.ts` if preferred): 4 ケース (text / sticker / image / 未知) で expected `(messageType, body)` を assert。テキストは `body` に Meta テキストがそのまま入ること、それ以外は `body === ''` を確認。

**Checkpoint**: Foundation ready — US1 / US2 / US3 は並列で着手可能。

---

## Phase 3: User Story 1 - 外部アプリで返信した内容が fumireply のスレッドに反映される (Priority: P1) 🎯 MVP

**Goal**: Messenger 公式アプリ等の外部アプリから運営者が顧客に送信したメッセージが、Webhook の `message_echoes` イベント経由で取り込まれ、fumireply のスレッドに `direction='outbound'` として表示される。

**Independent Test**: webhook 単体テストで「`is_echo=true` AND DB に該当 mid 行なし」のペイロードを `processMessagingEvent` に流し、`messages` に行が 1 件 INSERT され、`direction='outbound'`, `metaMessageId=mid`, `sentByAuthUid=null`, `sendStatus='sent'`, `timestamp=event.timestamp` であることを確認。手動検証は quickstart.md §2 の Meta 公式アプリ送信 → CloudWatch Logs `event=external_echo_ingested` → fumireply スレッド画面で目視確認。

<!-- unit: U3.1 | deps: U2.1 | scope: backend | tasks: T006-T011 | files: 2 | automation: auto -->
**Unit U3.1 (US1 PR)**: webhook handler の echo 分岐を UPSERT に書き換え、INSERT 経路 + 構造化ログを追加。同 PR で INSERT 経路の test 4 ケースを追加 (UPDATE / 重複 / 副作用なし は US2 で追加)。LOC 概算 ~50 + tests ~30。

### Tests for User Story 1 ⚠️

> **NOTE: Write these tests FIRST, ensure they FAIL before implementation**

- [ ] T006 [P] [US1] Add vitest test "echo INSERT (text) で新規 outbound 行が作られる" in `webhook/src/handler.test.ts`: setup で connectedPages と空の conversations を用意、`is_echo=true, text='Hello', mid='m_us1_text'` の echo を `processMessagingEvent` に渡す → DB に行 1 件、`(direction, metaMessageId, body, messageType, sendStatus, sentByAuthUid)` を assert。`event.timestamp` が `messages.timestamp` に反映されること。

- [ ] T007 [P] [US1] Add vitest test "echo INSERT (sticker) で body='' / messageType='sticker'" in `webhook/src/handler.test.ts`: sticker_id 入り attachments を持つ echo ペイロードに対し `body === ''` `messageType === 'sticker'` を assert。

- [ ] T008 [P] [US1] Add vitest test "echo INSERT (image) で body='' / messageType='image'" in `webhook/src/handler.test.ts`: type='image' の attachments 入り echo に対し `body === ''` `messageType === 'image'` を assert (注: inbound 画像経路と差分があることを認識する)。

- [ ] T009 [P] [US1] Add vitest test "echo の recipient.id が新規 PSID のとき会話を自動生成する" in `webhook/src/handler.test.ts`: conversations 未設定で `recipient.id='psid_new_us1'` の echo を流す → `conversations` に行 1 件 (page_id, customer_psid)、その上に `messages` 1 件が乗ることを assert。`upsertConversation` 関数経由で動作することの実装確認。

### Implementation for User Story 1

- [ ] T010 [US1] Modify `webhook/src/handler.ts` `processMessagingEvent` — replace the existing 4-line `is_echo` branch (lines 130-138) with the contracts/echo-pipeline.md C3 implementation:
  1. `const psid = event.recipient.id`
  2. `const { messageType, body } = determineEchoMessageType(msg)` (T003 で追加した helper)
  3. `withTenant(tenantId, async tx => {...})` 内で `upsertConversation` (T002) → `messages.insert(...).onConflictDoUpdate({ target: messages.metaMessageId, set: { sendStatus: 'sent' } }).returning({ id, inserted: sql<boolean>\`(xmax = 0)\` })` を実行
  4. `outcome.inserted === true` のとき `console.info('external_echo_ingested', { conversationId, mid, pageId, messageType, bodyLength: body.length, tsMs: ts })` を出力
  5. `return null` (US2 で UPDATE 経路の `self_echo_confirmed` ログを追加するため、ログ分岐は **else 節を最初から書いておく** が UPDATE テストは US2 で追加)
  
  既存 inbound 経路には一切手を入れない。echo は副作用 (SQS / Summary / customerName fetch / lastInboundAt / unreadCount) を呼ばない (FR-009)。

- [ ] T011 [US1] Verify T006〜T009 tests pass (red → green). 念のため `npm test -- handler.test.ts` を実行し、既存テスト (inbound 経路、未知 Page、Signature) もすべて green であることを確認。

**Checkpoint**: US1 完了。Messenger 公式アプリ → fumireply スレッドの外部送信流入が動作する。Meta App 購読フィールド有効化前なら本番デプロイしても挙動変化なし (デプロイ→購読フラグ ON の二段切替)。

---

## Phase 4: User Story 2 - fumireply 経由の送信が echo で二重表示されない (Priority: P1)

**Goal**: fumireply 自身の送信に対する echo を UPSERT の UPDATE 経路で吸収し、メッセージ行を 1 件に保つ。さらに「send-reply の `mid` 書き戻し前に echo が先着」する競合に対しても `messages_meta_message_id_unique` UNIQUE 違反を catch して 1 行に収束させる (attribute 補正)。

**Independent Test**: 
1. webhook 単体テスト: 既に `metaMessageId=X, sentByAuthUid=U` の outbound 行が存在する状態で同 mid の echo を流す → 行数 1 のまま、`sendStatus='sent'`、`timestamp`/`body`/`sentByAuthUid` 不変。
2. app 単体テスト: 既に `metaMessageId=X` の echo INSERT 済み行があり、`send-reply.fn.ts` がその同 mid を `messages.id=R.id` に書き戻そうとする → UNIQUE 違反 catch → `R.id` DELETE + echo 行に `sentByAuthUid` 設定 → 戻り値の `message.id` が echo 行 ID に置き換わる。

<!-- unit: U4.1 | deps: U3.1 | scope: backend | tasks: T012-T017 | files: 2 | automation: auto -->
**Unit U4.1 (US2 PR)**: webhook echo の UPDATE 分岐ログ + 冪等テスト + `send-reply.fn.ts` の UNIQUE catch 実装 + 関連テスト。LOC 概算 ~40 + tests ~30。

### Tests for User Story 2 ⚠️

- [ ] T012 [P] [US2] Add vitest test "echo UPDATE で既存自送信行の sendStatus を 'sent' に確定、他列は不変" in `webhook/src/handler.test.ts`: setup で `(direction='outbound', metaMessageId='m_us2_self', body='Hello self', sendStatus='pending', sentByAuthUid=<UUID>)` を pre-insert → 同 mid の echo を流す → 行数 1、`sendStatus='sent'`、`timestamp`/`body`/`sentByAuthUid`/`messageType` 不変を assert。`event=self_echo_confirmed` ログが出ることも `console.info` の spy で確認。

- [ ] T013 [P] [US2] Add vitest test "同一 mid の echo を 2 連発しても行数は 1 のまま" in `webhook/src/handler.test.ts`: 同 mid の echo を `processMessagingEvent` に 2 回流す → 1 件目は INSERT、2 件目は UPDATE (no-op)、`messages` の総件数が 1 件のまま `sendStatus='sent'` であることを assert。

- [ ] T014 [P] [US2] Add vitest test "echo は SQS 送信 / Summary trigger / customerName fetch を起動しない" in `webhook/src/handler.test.ts`: `sqsClient.send`, `maybeEnqueueSummaryJob`, `fetchCustomerName` を spy しておき、echo 流入時に 0 回呼ばれることを assert。同時に `conversations.lastInboundAt` / `lastMessageAt` / `unreadCount` が **不変**であることも DB を再読みして assert。

- [ ] T015 [P] [US2] Add vitest test "send-reply の mid 書き戻しが UNIQUE 違反になったとき attribute 補正される" in `app/src/routes/(app)/threads/$id/-lib/send-reply.fn.test.ts`: setup で echo 行を pre-insert (`metaMessageId='m_us2_race', sentByAuthUid=null, sendStatus='sent'`)、`sendMessengerReply` を mock して `{ ok: true, messageId: 'm_us2_race' }` を返す → `sendReplyFn` を呼ぶ → TX1 で tentative 行 R が INSERT され、TX2 で UPDATE が UNIQUE 違反、catch 内で R が DELETE、echo 行の `sentByAuthUid` が `context.user.id` に更新、戻り値 `message.id` が echo 行 ID に一致することを assert。`event=echo_send_attribution_recovered` ログ出力も spy で確認。

### Implementation for User Story 2

- [ ] T016 [US2] Modify `webhook/src/handler.ts` `processMessagingEvent` echo branch (T010 で書いた箇所) — `outcome.inserted === false` の else 節に `console.info('self_echo_confirmed', { conversationId, mid, pageId })` を追加。T012〜T014 テストが green になることを `npm test -- handler.test.ts` で確認。

- [ ] T017 [US2] Modify `app/src/routes/(app)/threads/$id/-lib/send-reply.fn.ts` TX2 (現在 line 87-105) — `sendResult.ok` ブロック内の `await tx.update(messages).set({ sendStatus: 'sent', metaMessageId: sendResult.messageId }).where(eq(messages.id, prep.insertedId))` を `try/catch` で包み、`isUniqueViolation(err, 'messages_meta_message_id_unique')` (T004) のとき:
  1. `await tx.delete(messages).where(eq(messages.id, prep.insertedId))`
  2. `const claimed = await tx.update(messages).set({ sentByAuthUid, sendStatus: 'sent' }).where(eq(messages.metaMessageId, sendResult.messageId)).returning({ id: messages.id })`
  3. `finalMessageId = claimed[0]?.id ?? prep.insertedId`
  4. `console.info('echo_send_attribution_recovered', { conversationId: data.conversationId, mid: sendResult.messageId, droppedRowId: prep.insertedId, sentByAuthUid })`
  
  UNIQUE 違反以外の err は throw して既存挙動を維持。戻り値の `message.id` を `prep.insertedId` から `finalMessageId` に置き換える (return オブジェクト構築箇所も合わせて変更)。T015 テストが green になることを `npm test -- send-reply.fn.test.ts` で確認。

**Checkpoint**: US1 + US2 完了。fumireply 経由送信と外部送信が混在する会話で、二重表示も attribute 喪失も発生しない。

---

## Phase 5: User Story 3 - 外部送信が未返信バッチ判定に正しく反映される (Priority: P1)

**Goal**: 外部送信を取り込んだ会話が、#004 未返信バッチ判定 (`MAX(timestamp) WHERE direction='outbound' AND conversation_id=C`) で「返信済み」として正しく扱われ、AI 下書きの余分な生成が止まる。

**Independent Test**: integration テストで「顧客 inbound が 2 通あり最終 outbound なし」の会話に echo INSERT → ai-worker の `processDraftJob` 経路で `unansweredRows = []` になる (echo の timestamp が最後の outbound 境界として効く) ことを assert。**コード変更ゼロ**で成立することを確認するための保険テスト。

<!-- unit: U5.1 | deps: U4.1 | scope: backend | tasks: T018 | files: 1 | automation: auto -->
**Unit U5.1 (US3 PR)**: 連動 integration test 1 本のみ。コード変更なし。

### Tests for User Story 3 ⚠️

- [ ] T018 [US3] Add vitest integration test "echo INSERT 後の会話は #004 未返信バッチ判定で空配列になる" in `webhook/src/handler.test.ts` (既存テストファイル集約。新規ファイルは作らない): setup で conversation に inbound 2 通 (`ts1 < ts2`)、`direction='outbound'` 行ゼロを用意 → echo (`is_echo=true, recipient.id=psid, ts=ts3 > ts2`) を `processMessagingEvent` で取り込み → 同会話に対して #004 と同じクエリ `SELECT MAX(timestamp) FROM messages WHERE conversation_id=C AND direction='outbound'` を実行して `ts3` が返ること、続いて `SELECT * FROM messages WHERE conversation_id=C AND direction='inbound' AND timestamp > <max_outbound>` が **0 行**であることを assert。**実装ファイルは触らない**。

**Checkpoint**: US1〜US3 すべて完了。spec の P1 ストーリー 3 件が全て独立に検証可能。

---

## Phase 6: Polish & Cross-Cutting Concerns

**Purpose**: 運用ドキュメント更新、E2E スモーク、リリース可否確認。

<!-- unit: U6.1 | deps: U5.1 | scope: docs | tasks: T019 | files: 1 | automation: auto -->
**Unit U6.1 (Docs PR)**: 運用手順書の購読フィールド追記のみ。コード変更なし。

- [ ] T019 [P] Modify `docs/resume-webhook-bringup.md` per contracts/echo-pipeline.md C6 — 「Subscription Fields」行を `messages, messaging_postbacks, message_echoes` に書き換え、本文末尾に「2026-06-27 以降の必須設定」セクションを追加 (具体的な購読有効化手順と、未購読時の挙動説明)。`specs/006-message-echoes-ingest/` への参照リンクを含める。

<!-- unit: U6.2 | deps: U5.1 | scope: e2e | tasks: T020-T022 | files: 1 | automation: manual -->
**Unit U6.2 (E2E + Release PR)**: Playwright スモーク 1 本 + CI green 確認 + 本番デプロイ手順チェック + リリース後の SC-001 観測 TODO。

- [ ] T020 [P] Add Playwright E2E スモーク `app/tests/e2e/echo-ingest.spec.ts` (NEW): スレッド画面を開き、(a) ローカル webhook handler に echo ペイロードを直接 POST して外部送信を 1 件挿入、(b) UI を reload しスレッドに当該メッセージが outbound バブルとして表示される、(c) 自送信を UI から 1 通送り、続けて同 mid の echo を POST し、UI 上で 1 件のままであることを assert。Signature verification は既存の test bypass フラグを使用 (`webhook/src/signature.ts` の dev モード参照)。

- [ ] T021 Run final pre-merge gates: `cd app && npm run typecheck && npm run lint && npm test` / `cd webhook && npm run typecheck && npm run lint && npm test`。Stop フック (`.claude/settings.json`) でも自動実行されることを再確認。すべて green の状態で PR を出す。

- [ ] T022 (運用 TODO) **リリース後 24 時間以内** に CloudWatch Logs Insights で quickstart.md §4.4 のクエリ (`@timestamp - tsMs` の p95) を実行し、SC-001 (p95 < 10s) の実測値を記録する。SC-001 は自動テストでは検証できないため、本クエリの結果が一次エビデンスになる。記録先はリリースノート / 運用日報。

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: T001 のみ。即着手可。
- **Foundational (Phase 2)**: Setup 完了後。T002 → T003 / T004 / T005 は並列可。**US1 着手の前提**。
- **User Stories (Phase 3〜5)**: Foundational 完了後。
  - US1 (T006〜T011) が MVP。US2 が依存する UPSERT 本体を含むため US1 を先に完了させる。
  - US2 (T012〜T017) は US1 完了後 (T016 が T010 の echo 分岐実装をベースにするため)。
  - US3 (T018) は US2 完了後でも先でも構わない (コード変更なしの保険テスト)。
- **Polish (Phase 6)**: US1〜US3 のいずれか 1 つ以上完了後に並列可。T019 (docs) と T020 (E2E) は他 PR と並列。

### User Story Dependencies

- **US1 (T006〜T011)**: Foundational (T002〜T005) のみに依存。他 US には依存しない。
- **US2 (T012〜T017)**: US1 (T010 で書いた echo UPSERT 分岐) に依存する **論理的同居** はあるが、テストレベルでは独立に検証可能 (UPDATE 経路と send-reply UNIQUE catch のテストは US1 と別ファイルでも書ける)。
- **US3 (T018)**: 厳密には US1 だけあれば成立 (echo INSERT 後の境界クエリで検証)。US2 を含めるとさらに頑健 (echo UPDATE 経路でも `MAX(timestamp)` 不変)。

### Within Each User Story

- テストを先に書く (T006〜T009 → T010 → T011 が「red → green → 検証」の順)
- US2 も同様 (T012〜T015 → T016/T017 → 各 npm test で green)
- ファイルレベルの並列性は `[P]` マーカで明示済み

### Parallel Opportunities

- T002 完了後、T003 / T004 / T005 は完全並列可 (3 つの異なる関数を別ファイル相当の独立箇所に追加)
- US1 のテスト T006〜T009 は完全並列可 (同じテストファイルだが互いに独立)
- US2 のテスト T012〜T015 も完全並列可
- US3 (T018) は US1 / US2 と並列着手可 (実装変更なしのため)
- Polish 内の T019 (docs) と T020 (E2E) は完全並列

---

## Parallel Example: User Story 1

```bash
# T002 (upsertConversation 抽出) 完了後、以下を並列に走らせる:
Task: "T003 determineEchoMessageType を webhook/src/handler.ts に追加"
Task: "T004 isUniqueViolation を app/src/server/db/errors.ts に追加"
Task: "T005 determineEchoMessageType の vitest を追加"

# US1 のテストファイル内で、4 つの test() ブロックは並列に書ける:
Task: "T006 echo INSERT (text) のテストを追加"
Task: "T007 echo INSERT (sticker) のテストを追加"
Task: "T008 echo INSERT (image) のテストを追加"
Task: "T009 echo の recipient.id 新規 PSID で会話自動生成のテストを追加"
```

---

## Implementation Strategy

### MVP First (User Story 1 Only)

1. **Phase 1** (Setup): T001 — 5 分。新規パッケージなしのため確認のみ。
2. **Phase 2** (Foundational): T002 → T003/T004/T005 並列 — 30 分。挙動変化ゼロのリファクタなので CI green を確認するだけ。
3. **Phase 3** (US1 MVP): T006〜T009 (テスト) → T010 (実装) → T011 (green 確認) — 1〜2 時間。
4. **STOP and VALIDATE**: webhook 単体テストが全て green。手動検証は本番 Meta App で `message_echoes` 購読フィールドを有効化し、Messenger 公式アプリから 1 通送って quickstart.md §2 のシナリオを確認。
5. ここまでで spec User Story 1 の受け入れ条件を満たす。本番デプロイ可。

### Incremental Delivery

1. Phase 1 + 2 完了 → Foundation ready
2. US1 (Phase 3) → MVP デプロイ。Meta App 購読有効化で機能 ON。
3. US2 (Phase 4) → 二重表示 / 競合 race のテスト網羅を完成させる。
4. US3 (Phase 5) → integration test 1 本で #004 連動を保証。
5. Polish (Phase 6) → docs + E2E + 最終 CI gate。

### Parallel Team Strategy

メンバ 1 名でも問題なし (LOC ~150)。複数人なら:
- Dev A: Phase 2 全て → US1 (T006〜T011)
- Dev B: Phase 2 の T004 (UNIQUE helper) を US1 と並行 → US2 の send-reply 側 (T015, T017)
- Dev C: US3 (T018) と Polish (T019, T020) を US2 と並行

---

## Notes

- [P] tasks = different files, no dependencies
- [Story] label maps task to specific user story for traceability
- Each user story should be independently completable and testable
- Verify tests fail before implementing (TDD red → green サイクルを各 US 内で適用)
- Commit after each task or logical group。Unit 単位 (U1.1, U2.1, U3.1, ...) で 1 PR を出すのが推奨
- Stop at any checkpoint to validate story independently
- Avoid: vague tasks, same file conflicts, cross-story dependencies that break independence
- 本 feature は **DB マイグレーション / 新規 npm / 新規 Lambda / 新規 SQS / IAM 変更 / env 追加すべてゼロ**。インフラチームとの調整不要
- リリース順は quickstart.md §5 を厳守: コードデプロイ → Meta App 管理画面で `message_echoes` 購読有効化 → 動作確認の二段切替
- **UI 変更ゼロ (FR-012)**: 既存 `ThreadMessages` は `direction` 列のみでバブル左右を切り替えるため、外部送信が INSERT されるだけで自動的に正しく描画される。UI コンポーネント / Paraglide メッセージの追加・変更は不要。
- **未知 Page × echo の回帰確認 (FR-011)**: 既存 inbound 経路の `unknown_page` 早期 return は echo にもそのまま適用される (`handlePost` のループ前で `if (!page) continue` するため、echo か inbound か関係なく落ちる)。T011 / T021 で既存テストの green を確認すれば回帰なし。明示的な「未知 Page × echo」テストは追加しないが、レビュー時に handler.ts のこの分岐位置を確認すること。
- **UNIQUE 制約名の事前確認 (G2 対応, T004 / T017 着手前)**: `app/src/server/db/migrations/` を grep するか、ローカル DB に `\d+ messages` を流して、`metaMessageId` UNIQUE 制約の実際の名前を確認する。drizzle の自動生成名と `messages_meta_message_id_unique` が異なる場合は T004 の `isUniqueViolation` 第 2 引数を実名に揃える。
- **E2E の署名 bypass 経路の事前確認 (G3 対応, T020 着手前)**: `webhook/src/signature.ts` を読み、dev / test 用の署名検証バイパスがあるか確認。なければ T020 で「テスト用 App Secret から HMAC-SHA256 を計算して `x-hub-signature-256` ヘッダを付与する」方式で書く。
