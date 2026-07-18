# Feature Specification: Ingest External Outbound Messages via `message_echoes`

**Feature Branch**: `006-message-echoes-ingest`
**Created**: 2026-06-27
**Status**: Draft
**Input**: User description: 外部送信メッセージ (Messenger アプリ等) を `message_echoes` 経由で取り込み、スレッドに `outbound` として表示する。fumireply 経由の送信は冪等更新、外部送信は新規 INSERT。未返信バッチ判定 (#004) の境界が外部送信を正しく反映する。親 Issue: autydev/fumireply#65

## Clarifications

### Session 2026-06-27

- Q: 非テキストの外部送信 echo を取り込むとき、本文 (`body`) には何を保存するか → A: 本文は空文字 (`''`) とし、メッセージ種別 (`messageType`) のみを設定する。UI 側は種別から表示を生成する
- Q: fumireply 経由送信の `mid` 書き戻しが完了する前に echo が先着した場合、どう冪等性を担保するか → A: echo 取り込みも fumireply 送信パスの `mid` 書き戻しも `metaMessageId` の一意性に基づく UPSERT で実装し、到着順に依らず最終的に 1 行に収束させる (現スキーマでは `messages.metaMessageId` の単一列 UNIQUE 制約を UPSERT のターゲットに使う。`tenantId` はテナント横断 mid 衝突防御のため WHERE で残す)
- Q: 既存メッセージ行に対する echo の UPDATE 時、`timestamp` を上書きするか → A: UPDATE では `timestamp` を変更しない。echo の `timestamp` は新規 INSERT (外部送信の取り込み) のときだけ採用する
- Q: 外部送信取り込みのオブザーバビリティをどこまで持つか → A: 構造化ログのみ追加。「外部 echo INSERT」と「自送信 echo UPDATE」を区別できるキー (例: `event=external_echo_ingested` / `event=self_echo_confirmed`) を出力し、CloudWatch Logs Insights で集計可能にする。カスタムメトリクスやアラートは追加しない

## User Scenarios & Testing *(mandatory)*

### User Story 1 - 外部アプリで返信した内容が fumireply のスレッドに反映される (Priority: P1)

運営者は普段 fumireply で返信しているが、外出先で Meta 公式 Messenger アプリから顧客に直接返信することがある。現状、その送信は fumireply には届かず、スレッドが歯抜けになる。本ストーリーでは、外部アプリで送った返信が fumireply のスレッド上に **自分側 (outbound) のバブル**として表示されるようにする。

**Why this priority**: スレッドの完全性が崩れていると、運営者は fumireply に戻った時に「今どこまで返信したか」を把握できず、二重返信や見落としが発生する。本機能なしには fumireply を「一次窓口」として使えないため P1。

**Independent Test**: Webhook 購読を有効にした状態で Messenger 公式アプリから顧客に 1 通返信し、fumireply のスレッド画面を開いたときに、その送信が `outbound` メッセージとして表示されることを目視で確認できる。

**Acceptance Scenarios**:

1. **Given** ある会話が存在し fumireply からの送信履歴がある、**When** 運営者が Meta 公式 Messenger アプリで同じ顧客に新規メッセージを送信する、**Then** その送信メッセージが該当スレッドの末尾に `outbound` として表示される
2. **Given** 過去に fumireply で会話したことがない新規顧客に外部アプリから返信した、**When** その echo が Webhook で届く、**Then** 該当 Page と顧客 PSID の組で会話が新規作成され、その送信がスレッドに表示される
3. **Given** 外部アプリから同じ送信について Meta が同じ `mid` でエコーを再送した、**When** 2 度目のエコーが届く、**Then** スレッド上のメッセージは増えず 1 件のままである (冪等)

---

### User Story 2 - fumireply 経由の送信が echo で二重表示されない (Priority: P1)

fumireply 自身が顧客に送信したメッセージも `message_echoes` で同じ Webhook に戻ってくる。すでに DB に存在する送信行を新規 INSERT してしまうと、スレッドに同じ内容が 2 件表示されてしまう。本ストーリーでは、自己送信のエコーは**冪等に既存行の送信状態を確定させる**だけにとどめ、新規行は作らない。

**Why this priority**: User Story 1 を実装するときに必ず一緒に成立させる必要がある冪等性。崩れるとスレッド上で送信が重複し、運営者が混乱する。

**Independent Test**: fumireply UI から返信を 1 通送信し、Webhook 経由でその echo が届いた後、スレッド上の対応する送信メッセージが 1 件のまま、かつ送信ステータスが「送信済み」になっていることを確認できる。

**Acceptance Scenarios**:

1. **Given** fumireply から送信した直後の送信行が「送信中」状態で DB に 1 件存在する、**When** Meta から同じ `mid` の echo が届く、**Then** その行が「送信済み」に確定し、新規行は作成されない
2. **Given** 何らかの理由で echo が複数回届いた、**When** 同じ `mid` のエコーを再受信する、**Then** スレッド上の送信件数は 1 件のままで状態も「送信済み」のまま

---

### User Story 3 - 外部送信が未返信バッチ判定に正しく反映される (Priority: P1)

未返信バッチ下書き機能 (#004) は「顧客から最後の返信以降に運営者が一度も返していない会話」を抽出する。外部アプリで返信したのに fumireply がそれを認識できないと、本来「返信済み」の会話まで未返信バッチに混入し、AI 下書きが余計に生成されてしまう。本ストーリーは User Story 1 の自然な帰結として、外部送信を取り込んだ会話が **未返信バッチの対象外**になることを保証する。

**Why this priority**: User Story 1 だけだとスレッド表示は直るが、AI 下書きが余計に出続けると運営コストが下がらない。一連の課題解決の本丸なので P1。

**Independent Test**: 顧客からの未返信メッセージが 1 件ある状態で、外部アプリから返信を 1 通送り、その後に未返信バッチ生成のトリガーを発火させたとき、その会話に対して新しい AI 下書きが生成されないことを確認できる。

**Acceptance Scenarios**:

1. **Given** 顧客から未返信のメッセージがあり、運営者は fumireply で返信していない、**When** 運営者が外部アプリで返信し、その echo が Webhook で取り込まれた、**Then** 続く未返信バッチ判定でその会話は対象外になる
2. **Given** 顧客から未返信のメッセージがあり、運営者がまだどこからも返信していない、**When** 未返信バッチ判定が走る、**Then** その会話は変わらず未返信として AI 下書きが生成される

---

### Edge Cases

- 外部送信の echo に含まれるメッセージタイプがテキスト以外 (画像、スタンプ、添付など) の場合、本文は空文字 (`body=''`) として保存し、メッセージ種別だけを実際のタイプに設定する。UI 上は他の同タイプメッセージと同じ表示にする。**(009 で更新)**: 種別記録に加えて添付メディアの保存も試みるようになった (`messages.attachments` JSONB)。詳細は specs/009-media-attachments/spec.md FR-009
- echo の `timestamp` が極端に古い / 未来である場合、そのまま保存する (Meta の値を信頼)。未返信バッチ判定への影響も自然に追随する
- 同じ `mid` の echo が、自己送信の既存行が **まだ `mid` を書き込めていない状態**で到着した競合 — echo 取り込みも fumireply 送信パスの `mid` 書き戻しも `(tenantId, metaMessageId)` をキーとする UPSERT で実装するため、どちらが先着しても DB 上は 1 行に収束する
- echo の `recipient.id` (顧客 PSID) に紐づく会話が存在しない場合 (fumireply 接続後 / 過去取り込みなし) — 新規に会話を作成して取り込む
- echo の Page が現テナントに接続されていない (未知の Page) — 現状の Webhook と同じく取り込まずスキップ
- AI 下書き生成は echo (= 自分側の送信) では発火しない — 顧客発話ではないため
- 過去 (Webhook 購読開始前) に外部送信されたメッセージの遡及取り込みは行わない

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: Meta Webhook の購読フィールドに `message_echoes` を含めるよう、設定手順ドキュメントを更新する
- **FR-002**: システムは Webhook で受信したイベントが echo (運営者側からの送信) であることを判別できる
- **FR-003**: echo を受信した際、その送信を Meta が発行した一意な送信 ID で既存メッセージと突合する
- **FR-004**: 既存メッセージが見つかった場合、システムは送信ステータスを「送信済み」として確定し、新規メッセージを作成しない (冪等)。この際、メッセージ行の `timestamp` は上書きしない (既存の値を保持)
- **FR-005**: 既存メッセージが見つからなかった場合、システムは新規の運営者側送信メッセージ (`outbound`) を該当スレッドに追加する。テキスト以外の種別の echo を新規取り込みする際は、本文を空文字 (`''`) として保存し、メッセージ種別だけを実際のタイプ (画像/スタンプ等) に設定する。新規行の `timestamp` には echo に含まれる Meta 確定時刻をそのまま採用する。**(009 で更新)**: 種別記録は維持しつつ、添付メディア (画像/動画/音声/ファイル) は S3 への保存も試み `messages.attachments` に記録する (specs/009-media-attachments/spec.md FR-009)
- **FR-006**: 外部送信を新規取り込みする際、「fumireply の特定の運営者が送信した」とは記録しない (送信者情報は未設定とする)
- **FR-007**: 外部送信の取り込み先スレッドは、Page と顧客 PSID の組み合わせで一意に解決される。該当スレッドが存在しなければ新規作成する
- **FR-008**: 同一の送信 ID を持つ echo が複数回到着しても、システムは合計 1 件のメッセージだけがスレッドに表示される状態を保つ
- **FR-008a**: echo 受信処理と fumireply 経由送信での送信 ID 書き戻し処理は、いずれも **送信 ID の一意性に基づく UPSERT** として実装し、どちらが先に DB に到達してもメッセージ行は 1 件に収束する (実装上は `messages.metaMessageId` の単一列 UNIQUE 制約をターゲットにする)
- **FR-009**: echo の受信は AI 下書き生成パイプラインを発火させない
- **FR-010**: 外部送信を `outbound` として取り込んだことが、未返信バッチ判定における「直近の運営者返信時刻」に自動的に反映される
- **FR-011**: 受信した echo の Page が現テナントに接続されていない場合、システムはそのイベントを無視する (現行の未知 Page と同じ扱い)
- **FR-012**: 取り込んだ外部送信は、fumireply 経由の送信と同じ視覚表現でスレッド上に表示する (本リリースで運営者は両者を見分ける必要はない)
- **FR-013**: echo の取り込み処理は、新規 INSERT (外部送信の取り込み) と既存行 UPDATE (fumireply 自送信の確定) を区別できる構造化ログを出力する。CloudWatch Logs Insights で「外部送信取り込み件数」と「自送信確定件数」を別個に集計可能にする。本機能ではカスタムメトリクスとアラートは追加しない

### Key Entities *(include if feature involves data)*

- **メッセージ (Message)**: 1 つの会話に属する 1 通の送受信記録。方向 (inbound/outbound)、本文、種別 (テキスト/スタンプ/画像 など)、Meta 側の一意な送信 ID、送信ステータス、タイムスタンプ、送信した運営者の識別子 (外部送信時は未設定) を持つ
- **会話 (Conversation / Thread)**: あるテナントの 1 つの Page と 1 人の顧客 (PSID) の対の組み合わせで一意に識別される、メッセージ列の入れ物
- **Webhook イベント (echo)**: Meta から届く、Page → 顧客への送信イベント通知。送信元アプリ ID、送信 ID、Page ID、顧客 PSID、本文、種別、タイムスタンプを含む

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: 外部アプリから運営者が返信した送信は、Meta が echo を発行してから 10 秒以内に fumireply のスレッドに表示される (Webhook 配信の通常 SLA を前提)
- **SC-002**: fumireply 経由の送信 1 件あたりに対し、スレッド上の対応メッセージは常に 1 件のみである (重複表示率 0%)
- **SC-003**: 同一 echo を 2 回以上受信した場合でも、スレッド上のメッセージ件数は 1 件のままである (冪等違反 0 件)
- **SC-004**: 外部送信を行った会話のうち、その後すぐに走った未返信バッチ判定で「未返信」として誤抽出される割合が 0% である
- **SC-005**: 本機能リリース後、運営者が「外部アプリで返信したのに fumireply に出ない」起因の問い合わせ件数が 0 件になる (リリース後 30 日の観測)
- **SC-006**: CloudWatch Logs Insights クエリで「外部送信取り込み件数」が日次・テナント別に取得でき、SC-005 の裏付けに利用できる

## Assumptions

- Meta App の管理画面で `message_echoes` 購読フィールドを手動で有効化する作業は、運用ドキュメントに従って人間が実施する (本機能のスコープはドキュメント更新と受信処理側のみ)
- Webhook 購読開始以前に外部アプリから送信されたメッセージの遡及取り込みは行わない (Meta は基本的に過去イベントを再配信しないため)
- 外部送信を「具体的にどの運営者が送ったか」までは特定しない。送信元アプリ ID (`app_id`) を将来の改善で参照する余地はあるが、本機能では保存対象としない
- 外部送信と fumireply 経由送信を UI 上で視覚的に区別する要件はない
- 既存の Webhook 受信パスとデータ保存層は再利用する。新たな購読チャネルやメッセージ保管先を追加しない
- 取り込んだ外部送信は、既存の `outbound` メッセージ表示・並び順ルール (タイムスタンプ昇順) に従う
