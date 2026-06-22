# Data Model: AI 下書きの条件付き再生成 (ワンオフ指示)

**Feature**: AI 下書きの条件付き再生成
**Branch**: `005-draft-regenerate-oneoff`
**Date**: 2026-06-23

## サマリ

**スキーマ変更ゼロ**。`ai_drafts` の構造は #004 で確立した形のまま。本機能は既存列の状態遷移を拡張するだけで実現する。

---

## 影響テーブル: `ai_drafts` (変更なし、参考のみ)

| 列 | 型 | 制約 | 005 での扱い |
|---|---|---|---|
| `id` | uuid | PK | 変更なし |
| `tenant_id` | uuid | NOT NULL FK→tenants | RLS 経由でアクセス制御 |
| `conversation_id` | uuid | NOT NULL FK→conversations | partial unique index `ai_drafts_active_per_conversation` で `status IN ('pending','ready')` のとき会話ごと 1 件保証 (#004) |
| `message_id` | uuid | NULL FK→messages | regenerate では更新しない (auto-batch 由来の anchor を維持) |
| `status` | varchar(20) | NOT NULL | `pending` / `ready` / `failed` / `dismissed` / `superseded` の値域そのまま |
| `body` | text | NULL | regenerate 中 (`pending`) は旧本文を **保持** (失敗復帰のための soft snapshot) |
| `model` | varchar(64) | NULL | regenerate 成功時に新モデル名で上書き |
| `error` | text | NULL | **用途拡張**: regenerate 失敗時にも書く (status は `ready` のまま) |
| `prompt_tokens` / `completion_tokens` / `latency_ms` | int | NULL | regenerate 成功時に上書き |
| `created_at` / `updated_at` | timestamptz | NOT NULL | webhook STALE_PENDING_GUARD で `updated_at` を見る |

**変更点**: なし (列追加・型変更・制約変更すべてゼロ)。

---

## 状態遷移 (拡張)

#004 から導入された下書きライフサイクルに、regenerate 経路の遷移を追記する (新規状態の追加なし)。

```
                                  [regenerate fn]
                                          │
                                          ▼
              ┌──────────────────►  pending  ◄───────── [webhook auto enqueue]
              │ (regen success)         │                       │
              │                         ▼                       │
              │                  [worker: ok]                   │
              │                         │                       │
              │                         ▼                       │
              └─────────────────────►  ready  ───────[send-reply / dismiss]──► dismissed
                                          ▲
                                          │ (regen failure path: status=ready, error=set, body=unchanged)
                                          │
                                  [worker: regen fail]
                                          │
                                          └── (auto-batch failure path: status=failed)
                                                                    │
                                                                    └─►  failed
```

**重要な差分**:

1. **regenerate 経路の失敗**: `pending → ready` に戻し、`error` 列を書く (body はそのまま)。`failed` には遷移しない。
2. **auto-batch 経路の失敗**: 従来通り `pending → failed` (`error` も書く)。
3. **`pending` 中の body 列**: regenerate 開始時に旧本文を **触らない**。worker 失敗時に旧本文を見せ続けるために必要。worker 成功時のみ新本文で上書き。
4. **`error` 列のクリア**: regenerate-draft.fn.ts が active draft を `pending` に戻すタイミングで `error=null` に明示的にリセットする (新サイクルの開始マーカー)。

---

## 状態遷移トリガ一覧

| トリガ | 主体 | 影響行 | 遷移 |
|---|---|---|---|
| webhook 新着 inbound テキスト | webhook | active row があれば update / なければ insert | `*` → `pending` (or no-op if regenerating & not stale) |
| `regenerateDraftFn` 実行 | app server fn | active row | `ready` → `pending` (error=null) |
| worker: regenerate 成功 | ai-worker | active row | `pending` → `ready` (body=new, error=null) |
| worker: regenerate 失敗 | ai-worker | active row | `pending` → `ready` (body=旧, error=理由) |
| worker: auto-batch 成功 | ai-worker | active row | `pending` → `ready` (body=new) |
| worker: auto-batch 失敗 | ai-worker | active row | `pending` → `failed` (error=理由, body=旧) |
| worker: 未返信なし | ai-worker | active row | `pending` → `dismissed` |
| worker: coalesce skip | ai-worker | (なし) | 状態変化なし |
| send-reply 成功 | app server fn | active row | `pending/ready` → `dismissed` |
| dismiss-draft 実行 | app server fn | active row | `pending/ready` → `dismissed` |

**冪等性**: partial unique index `ai_drafts_active_per_conversation` により、`pending`/`ready` を持つ行は会話ごと最大 1 件。webhook の `pending` upsert と regenerate の `pending` 更新は互いに同じ行を更新するだけで重複行を作らない。

---

## ワンオフ指示 (Operator Instruction) のライフサイクル

DB に出現しない一過性データ。次のライフサイクルを取る:

```
[UI textarea]
     │
     │ regenerateDraftFn 呼び出し (zod max 1000 通過)
     ▼
[SQS message body の instruction フィールド]
     │
     │ ai-worker が DRAFT_BODY_SCHEMA で受領
     ▼
[ai-worker メモリ内: processDraftJob のローカル変数]
     │
     │ buildOperatorInstructionBlock(instruction) でプロンプト合成
     ▼
[Anthropic API リクエストの system blocks の 1 要素]
     │
     │ SQS message が削除されメモリも GC
     ▼
[消滅]  ← DB には何も残らない (FR-003 / SC-004)
```

構造化ログには **本文を出さず `instruction_length: number` のみ**を出す (PII 含む可能性に配慮)。

---

## 関連エンティティ (参照のみ、変更なし)

| エンティティ | 関係 | 備考 |
|---|---|---|
| `conversations` | active draft の親 | 003 で導入された `custom_prompt`, `tone_preset`, `summary` を **そのまま** プロンプト合成に使う (永続層) |
| `connected_pages` | conversation の親 | 003 で導入された `custom_prompt` (shop policy) を使う |
| `messages` | active draft の anchor | regenerate では触らない |

---

## マイグレーション

**なし**。`0003_conversation_scoped_drafts.sql` (#004) を最後に、本フィーチャでは追加 SQL を発行しない。
