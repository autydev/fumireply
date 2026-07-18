# Data Model: 008-fix-ai-worker-timestamp

**DB スキーマ変更: ゼロ。** マイグレーションなし。既存の `ai_drafts` / `messages` をそのまま使う。

## 関与エンティティ

### messages(読み取りのみ)

- `timestamp` — `timestamp with time zone`(schema.ts:116)。型付きカラム select で drizzle が `Date` にマッピングする(本 feature の根本修正はこの性質に依存)
- `direction` — `'inbound' | 'outbound'`。未返信バッチ境界 = 最後の `outbound` の `timestamp`
- 使用 index: `messages_tenant_id_conversation_id_timestamp_idx`(`ORDER BY timestamp DESC LIMIT 1` が `max()` と同等コストになる根拠)

### ai_drafts(状態のみ更新)

列変更なし。`error` 列に新しい値 **`internal_error`**(予期しない内部例外)が入りうる。`error` は自由文字列としてクライアントに透過されるため、スキーマ・クライアント変更は不要。

## ai_drafts 状態遷移(本 feature 後の全体像)

既存遷移(004/005)は不変。**太字**が本 feature で追加される遷移。

| # | 契機 | 現在状態 | 遷移後 |
|---|------|----------|--------|
| 1 | 生成成功 | pending / ready | ready (body 更新, error=null) |
| 2 | Anthropic 失敗 (auto) | pending / ready | failed (error=コード) |
| 3 | Anthropic 失敗 (regenerate) | pending / ready | ready (body 保持, error=コード) |
| 4 | 未返信なし (auto) | pending / ready | dismissed |
| 5 | **予期しない例外・最終受信 (auto)** | pending / ready | **failed (error='internal_error')** |
| 6 | **予期しない例外・最終受信 (regenerate)** | pending / ready | **ready (body 保持, error='internal_error')** |
| 7 | **予期しない例外・非最終受信** | pending | **pending のまま(書き込みなし、SQS 再配信待ち)** |

## 不変条件

- **INV-1**: ジョブが SQS から消える(正常終了 or DLQ 行き)時点で、対応する draft は `pending` のままではない — ただし DLQ 行きは終端書き込み失敗(DB 断)時のみで、このとき draft の状態は保証できない(既存挙動から悪化はしない)
- **INV-2**: 成功書き込み・失敗書き込みとも対象は `status IN ('pending','ready')` の行のみ。`failed`/`dismissed`/確定済みの行を後から書き換えない(非最終受信で終端状態を書かない理由)
- **INV-3**: regenerate の失敗経路は body/model/tokens に触れない(005 の「前の下書きを見せ続ける」保証を `internal_error` 経路にも適用)
- **INV-4**: 未返信バッチ境界の判定結果(どの inbound が未返信扱いになるか)は修正前後で同一
