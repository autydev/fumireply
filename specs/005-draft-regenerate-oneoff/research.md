# Research: AI 下書きの条件付き再生成 (ワンオフ指示)

**Feature**: AI 下書きの条件付き再生成
**Branch**: `005-draft-regenerate-oneoff`
**Date**: 2026-06-23

設計判断ログ。各エントリは Decision / Rationale / Alternatives considered。

---

## R-1. ワンオフ指示の保存場所

**Decision**: 永続化しない。SQS payload とプロンプト合成内のみに存在させ、DB には書かない。

**Rationale**:
- spec FR-003 / SC-004 で「会話に永続保存してはならない」「リーク 0 件」を要求。
- 永続化すると 003 で導入済の `conversations.custom_prompt` と用途が二重化し、運用が混乱する。
- 一過性のため監査ログ要件もない (構造化ログに `instruction_length` だけ落として本文は出さない → PII 含む可能性に配慮)。

**Alternatives considered**:
- `ai_drafts.last_instruction` 列を追加し、UI から復元可能にする → 「使い捨て」の意味が崩れ、運営者がうっかり残してしまうリスク。却下。
- `regeneration_jobs` テーブルを新設し履歴管理 → バージョン履歴を持たない方針 (spec) と矛盾、YAGNI。却下。

---

## R-2. app→SQS publish 経路の追加方法

**Decision**: `@aws-sdk/client-sqs` を app に新規追加し、`app/src/server/services/sqs.ts` でクライアントを lazy 初期化。app Lambda 実行ロールに `sqs:SendMessage` (既存 draft キュー宛て) を IaC で付与。

**Rationale**:
- webhook / ai-worker が同 SDK を使用済みでバージョン揃え (`peerDeps` 一致) が容易。
- 既存 draft キューを使い回せば、新規キュー作成・DLQ 設定・モニタリング登録の追加コストがゼロ。
- worker 側は payload の `triggerType` / `instruction` を見るだけで分岐でき、キュー分割は不要。

**Alternatives considered**:
- HTTPS API Gateway 経由で ai-worker を直接同期呼び出し → Anthropic 呼び出しの最大 60 秒を Lambda の同期実行に同期 timeout で受けると app Lambda の課金とコールドスタートが厳しい。却下。
- ai-worker を Step Functions 化して呼び出し → オーバーキル。却下。
- 専用キュー `draft-regenerate-queue` を新設 → 観測性は上がるが、worker のディスパッチ実装と DLQ 監視が二重化する。今後再生成のレート制限を強くする時に分離を検討する余地は残すが、初手では既存キュー流用で十分。却下 (現時点)。

---

## R-3. ai-worker での coalesce 取り扱い

**Decision**: SQS payload に `triggerType: 'regenerate'` を追加し、worker は `triggerType === 'regenerate'` のときだけ "最新インバウンドでなければ skip" の coalesce 判定をスキップする。

**Rationale**:
- 運営者の明示意図 (再生成ボタン押下) は必ず 1 回走らせるべき。auto-batch の coalesce ロジックを再利用しつつ、regenerate だけ抜けられるフラグで最小差分。
- clarify Q3 で「再生成完了後に未取り込みの新着があれば従来の自動再生成が走る」と合意済み。これは regenerate ジョブの後に webhook 由来の auto-batch ジョブが追走する形で自然に成立する。

**Alternatives considered**:
- regenerate ジョブで `triggerMessageId` を「最新 inbound」に上書きしてから enqueue → race で別の inbound が来ると同じ問題が再発。却下。
- 専用キュー化で SQS レベルで完全に分離 → R-2 と同じ理由で却下。

---

## R-4. 再生成失敗時のアクティブ下書きの取扱い

**Decision**: regenerate 経路の失敗 (AI エラー / タイムアウト / バリデーション) では、`ai_drafts.status='ready'` を維持し、`error` 列に失敗理由を書き込み、`body` は触らない (旧本文保持)。auto-batch 経路の失敗は従来通り `status='failed'`。

**Rationale**:
- spec の clarify Q2 で「旧本文保持 + ready 復帰 + 一過性エラー表示」を採用。
- 既存 worker の失敗パスは `set({ status: 'failed', error })` で body 列を触らないため、`status` を `ready` に置き換えるだけで旧本文保持が成り立つ (実装コスト極小)。
- `ai_drafts.error` 列は #004 から存在し既に使われている。regenerate 失敗時は同列を再利用し、`get-draft-status` の戻り値に `error` を追加するだけで client にも伝搬する。

**Alternatives considered**:
- 失敗専用 boolean 列 `regenerate_failed` を追加 → 列追加が必要で migration 1 本必要。`error` 列で十分。却下。
- `ready` 維持ではなく `failed` 維持で UI 側で旧本文を表示用 cache する → `get-conversation` の loader が `failed` を返さないので reload で消える。設計の凝集度が下がる。却下。

---

## R-5. プロンプト合成順序とワンオフ指示ブロック

**Decision**: 既存の `BASE_SYSTEM_PROMPT` → `buildAdditionalSystemPrompt({ pagePrompt, tonePreset, customerPrompt, summary })` → **NEW: `OPERATOR_INSTRUCTION` ブロック** → `LANGUAGE_DIRECTIVE` の順で system blocks を構築。OPERATOR_INSTRUCTION は instruction が空文字 / undefined のときは追加しない。

```
[BASE]                            (cache_control: ephemeral, 既存)
[additional]                      (page/tone/customer/summary, 既存)
[OPERATOR_INSTRUCTION]            (NEW, instruction が空でないときのみ)
[LANGUAGE_DIRECTIVE]              (既存、最後段で言語ルール固定)
```

OPERATOR_INSTRUCTION の中身 (英語固定、既存方針一致):

```
## Operator instruction for this draft
Apply this one-off instruction with HIGHEST priority over the shop policy, tone, customer instructions, and conversation summary above. The customer has NOT seen this instruction — do not quote it or refer to it.

{instruction}
```

**Rationale**:
- LLM プロンプトでは後段の指示が支配的になる経験則に従う。LANGUAGE_DIRECTIVE は「言語選択」専用の最終層として温存し、コンテンツ側の優先順位 (page < tone < customer < operator) を確立する。
- spec FR-005「ワンオフ指示は永続 custom_prompt や未返信メッセージのバッチ要件より優先」を満たす。
- BASE ブロックの `cache_control` (prompt caching) は触らず、コスト効率を維持。

**Alternatives considered**:
- ユーザープロンプトの先頭に置く → `buildUserPrompt` (#004) の構造を壊し、コア生成プロンプトと混在。テストが汚くなる。却下。
- LANGUAGE_DIRECTIVE より後に置く → 言語ルールを上書きするリスク (operator が日本語指示を英語で書いた場合に出力言語が崩れる)。却下。
- 永続 custom_prompt とワンオフ指示を 1 つのブロックに合成 → ソースを区別できなくなり、デバッグ困難。却下。

---

## R-6. webhook 側での「再生成中の自動バッチ抑制」

**Decision**: webhook の inbound 取り込み内で、active draft が `status='pending'` かつ `updated_at` が `STALE_PENDING_GUARD_SECONDS` (= 120 秒) より新しいなら **SQS 送信のみスキップ** (DB の `message_id` 更新は実行)。古い `pending` (worker クラッシュ等で滞留) は通常通り enqueue して復旧経路を確保する。

**Rationale**:
- clarify Q3 で「進行中の再生成ジョブを優先し、新着到来時の自動バッチ再生成は抑制」決定済。
- worker の coalesce 判定だけだと、新着が来た瞬間に active draft の `message_id` も書き換わり、regenerate ジョブが自身を skip してしまう (regen は coalesce bypass で守るが、auto-batch は逆方向に regen の結果を上書きする risk)。webhook 側の SQS skip でこの auto-batch を抑制する方が安全。
- 120 秒は SC-002 (P50 30s) と FR-011 タイムアウト (90s) を上回る安全値。それより古い `pending` は worker 異常 = 復旧優先。

**Alternatives considered**:
- ai_drafts に `regenerating: boolean` 列を追加 → migration 必要で R-1 / R-4 のデータモデル変更ゼロ方針と矛盾。却下。
- すべての `pending` 中は SQS skip → worker クラッシュで永久に止まる。却下。
- webhook 側で何もせず worker の coalesce だけに任せる → 上記の race が残る。却下。

---

## R-7. クライアントタイムアウトの実装層

**Decision**: クライアント (`DraftBanner` + 親 `ReplyForm`) でローカル `setTimeout(90_000)` を持ち、タイムアウト時にポーリングを停止し、`onError(reason: 'timeout')` を発火。サーバ側のレコード状態には触らない。

**Rationale**:
- 「再生成のボタン抑制 = client local state」「DB 状態は worker 起因でしか変わらない」と責任分離した方が単純。
- worker の遅延・SQS の DLQ 引き取りの遅さで `pending` が一時的に滞留しても、client はタイムアウトでボタンを再活性化でき、再試行時に新しい SQS msg が積まれて自然に更新される。
- spec FR-011 と clarify Q4 (90s) に一致。

**Alternatives considered**:
- サーバ側に "stale pending を auto-revert" cron / EventBridge schedule → 単純な機能のために定常運用部品が増える。却下 (今は webhook の STALE_PENDING_GUARD で十分)。
- SSE / WebSocket で push 通知 → 既存はポーリング、機能の本質に対してオーバー。却下。

---

## R-8. UI: 再生成ボタンと instruction 入力の配置

**Decision**: 下書きカード (`ReplyForm` 内、draft が `ready` のとき表示される領域) の下に折り畳み式の `RegeneratePanel` を置く。最初は「再生成」ボタンのみ表示し、クリックで textarea が展開、実行ボタンで送信。1000 文字カウンタと残り文字数表示を常時表示。

**Rationale**:
- 通常運用 (ワンオフ指示なしで素の再生成) を 2 クリックで完了させる。
- 折り畳みにより通常の編集 / 送信操作の邪魔をしない。
- DraftBanner (pending 中) との同居領域に置くことで「下書きに関する操作」の凝集度が高い。

**Alternatives considered**:
- ヘッダのアイコンボタン → instruction 入力欄を置く場所が遠くなり SC-001 (15 秒以内起動) を厳しくする。却下。
- 別モーダル → モーダルでの編集は会話履歴を見ながら入力しにくい。却下。

---

## R-9. テナント安全性とバリデーション境界

**Decision**: `regenerate-draft.fn.ts` は `authMiddleware` + `withTenant(tenantId)` 内で `conversationId` の存在と active draft の存在を確認し、確認後に SQS publish。worker 側は payload の `conversationId` から再度 `tenantId` を解決して `withTenant` で書く。

**Rationale**:
- SQS は queue 内のメッセージにテナント情報を埋め込んでも、ai-worker は payload を信用せず DB で再解決すべき (defense in depth)。これは #001 / #004 と同方針。
- server fn 側で active draft 存在チェックを行うことで、ボタンが UI 上消えているはずなのに発火された場合に no-op + 構造化ログ。

**Alternatives considered**:
- worker 側で payload の tenantId を信用する → 不正 SQS publish (内部不正利用) を防げない。却下。

---

## R-10. SC 達成可能性の見立て

| SC | 目標 | 達成戦略 |
|---|---|---|
| SC-001 | 起動 15s 以内 | `RegeneratePanel` 展開 1 クリック + 1000 字 textarea。typing 中は楽観的に server fn 不可。問題なし。|
| SC-002 | P50 30s | DelaySeconds=0 + 既存 Anthropic 呼び出し 8〜15s の実績 (003 計測)。タイムアウト 90s なら P95 もカバー。|
| SC-003 | 具体値反映率 95% | OPERATOR_INSTRUCTION ブロックを LANGUAGE_DIRECTIVE 直前に配置し最強の content priority とする。プロンプト合成のユニットでブロックが含まれることを担保。|
| SC-004 | 永続化リーク 0 | DB 列追加ゼロ、SQS payload はメッセージ消化で揮発、構造化ログは本文を出さず長さのみ → 構造的にリーク経路がない。回帰テスト 1 本で担保。|
| SC-005 | 手書き置換 -20% | 機能リリース後の指標 (現状の `draft_persisted` ログから引ける)。本仕様の範囲は実装まで。|
