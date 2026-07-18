# Tasks: AI 下書き生成のクラッシュ修正と失敗時の確実な状態反映

**Input**: Design documents from `/specs/008-fix-ai-worker-timestamp/`
**Prerequisites**: plan.md, spec.md, research.md (D1–D5), data-model.md, contracts/draft-failure-handling.md, quickstart.md

**Tests**: spec FR-005 が回帰テストを必須要件としているため、テストタスクを含む(テスト先行 — 修正前に失敗することを確認)。

**Organization**: user story 単位。US1(P1 根本修正)だけで MVP(バグ解消)として出荷可能。

## Format: `[ID] [P?] [Story] Description`

- **[P]**: 並列実行可(別ファイル・未完了タスクへの依存なし)
- **[Story]**: 対応する user story(US1–US4)

## Path Conventions

既存 ai-worker ワーカーへの修正のみ。実装は `ai-worker/src/handler.ts` 1 ファイル、テストは `ai-worker/src/handler.test.ts` / `ai-worker/src/regenerate.test.ts`。

---

## Phase 1: Setup

**Purpose**: 変更前のベースライン確認(新規セットアップは不要 — 既存プロジェクト)

- [X] T001 Run existing ai-worker test suite (`cd ai-worker && npx vitest run`) and confirm green baseline before any change

---

## Phase 2: Foundational

**Purpose**: なし — 既存ワーカーへの独立した修正のため、全 user story をブロックする前提タスクは存在しない(receiveCount の配線は US2 内で行う)

**Checkpoint**: T001 のベースライン green を確認したら US1 に着手可能

---

## Phase 3: User Story 1 - 返信済み会話でも AI 下書きが生成できる (Priority: P1) 🎯 MVP

**Goal**: 未返信バッチ境界クエリの型不一致 TypeError を解消し、outbound ありの会話で auto 生成/再生成が完走する(contract C1 / research D1)

**Independent Test**: `lastOutboundResult = [{ ts: new Date(...) }]`(outbound あり)のモックで draft が `ready` まで到達すること。実機では outbound のあるスレッドで再生成がタイムアウトしないこと

### Tests for User Story 1(先行 — 修正前に失敗すること)

- [X] T002 [P] [US1] Update `buildReadTx` mock in `ai-worker/src/handler.test.ts` to the new boundary-query chain shape (`select→from→where→orderBy→limit` 終端、research D5-3) and add regression test: outbound あり(`lastOutboundResult = [{ ts: new Date('2026-06-01T00:00:00Z') }]`)の auto 生成で draft が `ready` になり、境界クエリが `orderBy`+`limit(1)` 付き型付き select で発行されること
- [X] T003 [P] [US1] Add regression test in `ai-worker/src/regenerate.test.ts`: outbound ありの会話で regenerate(ワンオフ指示つき含む)が成功し `ready` になること(research D5-2。`buildReadTx` 相当のモックがこのファイルにもあれば同様にチェーン形状を追随)

### Implementation for User Story 1

- [X] T004 [US1] Replace raw `sql<Date | null>\`max(...)\`` boundary query with typed-column select + `orderBy(desc(messages.timestamp))` + `limit(1)` in `ai-worker/src/handler.ts:239-245` per contract C1 (`lastOutboundTs = lastOut?.ts ?? new Date(0)` フォールバックは維持)
- [X] T005 [US1] Run ai-worker test suite (`cd ai-worker && npx vitest run`) — T002/T003 を含め全 green

**Checkpoint**: バグ本体は解消。ここまでで MVP としてデプロイ可能(US2–US4 は堅牢化・運用)

---

## Phase 4: User Story 2 - 生成に失敗したら「生成中」のまま放置されない (Priority: P2)

**Goal**: `processDraftJob` の outer try/catch + `ApproximateReceiveCount` 分岐で、予期しない例外でも終端状態が必ず書かれる(contract C2 / research D2、data-model 遷移 5–7)

**Independent Test**: 読みトランザクションを throw させ、receiveCount=1 では rethrow(draft 書き込みなし)、receiveCount=3 では auto → `failed`+`internal_error` / regenerate → `ready`+`internal_error` が書かれ正常終了すること

### Tests for User Story 2(先行)

- [X] T006 [P] [US2] Add outer-catch tests in `ai-worker/src/handler.test.ts`: (a) `withTenant` が throw + `ApproximateReceiveCount: '1'` → handler が reject し draft 書き込みなし、`draft_job_unexpected_error` (willRetry=true) がログされる; (b) `ApproximateReceiveCount: '3'` → `{ status: 'failed', error: 'internal_error' }` が `status IN ('pending','ready')` 対象で書かれ handler は resolve; (c) 終端書き込み自体も throw する場合は reject(DLQ 行き)
- [X] T007 [P] [US2] Add outer-catch regenerate test in `ai-worker/src/regenerate.test.ts`: `ApproximateReceiveCount: '3'` で `{ status: 'ready', error: 'internal_error' }` が書かれ body/model/tokens に触れないこと(INV-3)

### Implementation for User Story 2

- [X] T008 [US2] Thread `receiveCount` in `ai-worker/src/handler.ts`: parse `record.attributes.ApproximateReceiveCount`(欠損時 1)in `processRecord`, pass to `processDraftJob`(legacy 経路含む)、`MAX_RECEIVE_COUNT = 3` 定数を terraform の `maxReceiveCount` との対応コメント付きで定義(contract C2 シグネチャ)
- [X] T009 [US2] Wrap `processDraftJob` body in outer try/catch in `ai-worker/src/handler.ts` per contract C2: 非最終受信は `draft_job_unexpected_error` (willRetry=true) ログ + rethrow / 最終受信は willRetry=false ログ + 終端状態書き込み(auto: `failed`+`internal_error`, regen: `ready`+`internal_error`, latencyMs null 許容)+ 正常 return / 終端書き込み失敗は rethrow。既存の早期 return(conversation_not_found / superseded / no_unanswered)と内側の Anthropic catch は不変
- [X] T010 [US2] Run ai-worker test suite — T006/T007 を含め全 green

**Checkpoint**: pending 放置が構造的に解消(US1 と独立に検証可能)

---

## Phase 5: User Story 3 - AI 応答が遅くても処理が途中で打ち切られない (Priority: P3)

**Goal**: リトライラダーを最悪 49s に短縮し Lambda timeout 60s 内に収める(contract C3 / research D3)。terraform 変更なし

**Independent Test**: 定数変更後、最悪ケース(全試行タイムアウト)の机上合計が 15×3+1+3=49s であること。既存リトライテスト(429→成功、4xx 即 throw)が新しい試行回数で成立すること

### Implementation for User Story 3

- [X] T011 [US3] Change `ANTHROPIC_TIMEOUT_MS` to `15_000` and `RETRY_DELAYS_MS` to `[1000, 3000]` in `ai-worker/src/handler.ts`, with a comment documenting the worst-case budget (49s + DB/SSM ≒55s < Lambda 60s, contract C3)
- [X] T012 [US3] Update existing retry-ladder tests in `ai-worker/src/handler.test.ts`(および `regenerate.test.ts` に同種があれば): 最大試行回数 4→3 の期待値を更新し、リトライ対象/非対象の判定(429/5xx retry, その他 4xx 即 throw)が不変であることを確認(research D5-6)
- [X] T013 [US3] Run ai-worker test suite — 全 green

**Checkpoint**: 全コード変更完了

---

## Phase 6: User Story 4 - 障害期間中に失敗したジョブの後始末 (Priority: P4)

**Goal**: DLQ redrive の運用手順が実装の最終形と整合した状態で文書化されている(research D4 / quickstart §3)

### Implementation for User Story 4

- [ ] T014 [US4] Verify and finalize the DLQ redrive procedure in `specs/008-fix-ai-worker-timestamp/quickstart.md` against the final implementation(エラーコード `internal_error`・ログイベント名・キュー名が実装と一致すること。redrive 実施自体はデプロイ後の運用判断であり本タスクの対象外)

**Checkpoint**: 全 user story 完了

---

## Phase 7: Polish & Cross-Cutting Concerns

- [ ] T015 Run ai-worker typecheck/lint(`cd ai-worker && npx tsc --noEmit` + リポジトリの lint 手順)and full test suite; fix any fallout
- [ ] T016 Cross-check spec/plan/contracts against the final implementation and sync docs to code where they diverge(コードが正 — feedback_sync_spec_to_impl)。data-model.md の状態遷移表・contract C1–C4 のコード断片が最終実装と一致することを確認

---

## Dependencies & Execution Order

### Phase Dependencies

- **Phase 1 (T001)**: 依存なし — 即着手可
- **Phase 2**: タスクなし
- **US1 (T002–T005)**: T001 後。他 story への依存なし
- **US2 (T006–T010)**: T001 後に着手可能だが、`handler.ts`/テストファイルを US1 と共有するため **US1 完了後の直列実行を推奨**
- **US3 (T011–T013)**: 同上 — US2 完了後を推奨(同一ファイル)
- **US4 (T014)**: T009(エラーコード・ログ名確定)後
- **Polish (T015–T016)**: 全 story 完了後

### Within Each User Story

- テスト先行: T002/T003 → T004、T006/T007 → T008/T009(修正前に失敗することを確認)
- 実装 → suite green 確認(T005/T010/T013)で checkpoint

### Parallel Opportunities

- T002 ∥ T003(別ファイル)、T006 ∥ T007(別ファイル)
- US1–US3 は概念的には独立だが全て `handler.ts` + 同一テストファイルを触るため、単独開発者では P1→P2→P3 の直列が最速(コンフリクト回避)

---

## Implementation Strategy

**MVP first**: T001 → US1 (T002–T005) でバグ本体は解消 — この時点でデプロイすれば issue #75 の主症状(再生成失敗・タイムアウト)は消える。US2/US3 は同種障害の再発防止、US4 は運用文書。単独ブランチで P1→P2→P3→P4→Polish を直列に進め、1 PR で出荷する(いずれも小さく、分割コストの方が高い)。
