# Implementation Plan: AI 下書き生成のクラッシュ修正と失敗時の確実な状態反映

**Branch**: `008-fix-ai-worker-timestamp` | **Date**: 2026-07-18 | **Spec**: [spec.md](spec.md)
**Input**: Feature specification from `/specs/008-fix-ai-worker-timestamp/spec.md`

## Summary

ai-worker の未返信バッチ境界取得(`ai-worker/src/handler.ts:239-245`)が生 SQL `max(${messages.timestamp})` を `sql<Date | null>` の型アサーション付きで select しており、drizzle + postgres-js は生 SQL フラグメントを Date に変換しないため string が返る。その string が `gt(messages.timestamp, lastOutboundTs)` に渡り `PgTimestamp.mapToDriverValue` の `value.toISOString()` で TypeError → Lambda Invoke Error → SQS 3 受信で DLQ 行き、`ai_drafts` は `pending` のまま放置される。outbound が 1 件でもある会話(=実運用のほぼ全会話)で必ず発生する。

修正方針:

1. **P1 根本修正**: 生 `max()` を型付きカラム select + `orderBy(desc(timestamp))` + `limit(1)` に置き換え(drizzle が Date へ正しくマッピング)。境界判定の仕様は不変
2. **P2 pending 放置防止**: `processDraftJob` を outer try/catch で包み、SQS の `ApproximateReceiveCount` を見て非最終受信は rethrow(SQS リトライ温存)、最終受信(3 回目)は失敗状態(auto → `failed` / regenerate → `ready`+error)を書き込んで正常終了
3. **P3 timeout 整合**: リトライラダーを短縮(per-attempt 30s→15s、リトライ 3→2 回)し最悪 49 秒 ≒ 全体 55 秒 < Lambda timeout 60s に収める。terraform 変更なし
4. **P4 DLQ 後始末**: redrive 手順と安全性の根拠を quickstart.md に文書化(運用作業)

## Technical Context

**Language/Version**: TypeScript 5.x / Node.js 22 (Lambda runtime `nodejs22.x`)
**Primary Dependencies**: drizzle-orm (postgres-js driver), @anthropic-ai/sdk, zod, aws-lambda (SQS event)
**Storage**: Supabase Postgres(RLS、`withTenant` トランザクション)。スキーマ変更なし
**Testing**: vitest(`ai-worker/` 単体、tx チェーンをモック)
**Target Platform**: AWS Lambda(SQS イベントソース、batch_size=1)
**Project Type**: バックエンドワーカー(既存 ai-worker への修正のみ)
**Performance Goals**: 下書き生成ジョブの最悪所要時間 ≒55s(Anthropic ラダー 49s + DB/SSM)
**Constraints**: Lambda timeout 60s / SQS visibility 90s / maxReceiveCount 3 / クライアントポーリング上限 regenerate 90s・auto 60s。すべて既存値のまま(terraform 変更なし)
**Scale/Scope**: 変更対象は `ai-worker/src/handler.ts` + テスト 2 ファイル + ドキュメント。DB スキーマ・app・webhook・terraform は変更なし

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

`.specify/memory/constitution.md` は未記入テンプレートのため、固有ゲートなし。従来 feature (004–006) と同様に、コードベース既存の規約をゲートとして適用する:

- [x] 構造化ログ規約(`console.info/error({ event: ... })`)に従う — 新イベント名は research.md で定義
- [x] HTTP クライアントは fetch(axios 禁止)— 本 feature は HTTP クライアント追加なし
- [x] DB スキーマ変更なし・マイグレーション不要
- [x] 既存の失敗時状態遷移仕様(005: regenerate は `ready`+error / auto は `failed`)を変更せず再利用
- [x] spec と実装が食い違った場合はコードが正、spec を同期する

**Post-Phase 1 re-check**: PASS(新規プロジェクト・新規依存・スキーマ変更なし。Complexity Tracking 対象なし)

## Project Structure

### Documentation (this feature)

```text
specs/008-fix-ai-worker-timestamp/
├── plan.md              # This file
├── spec.md              # Feature specification
├── research.md          # Phase 0: 設計判断 (D1–D5)
├── data-model.md        # Phase 1: スキーマ変更ゼロ + ai_drafts 状態遷移
├── quickstart.md        # Phase 1: デプロイ検証 + DLQ redrive 運用手順
├── checklists/
│   └── requirements.md  # spec 品質チェックリスト(全項目パス)
├── contracts/
│   └── draft-failure-handling.md  # 境界クエリ / outer catch / リトライラダー契約
└── tasks.md             # Phase 2 (/speckit.tasks — 未作成)
```

### Source Code (repository root)

```text
ai-worker/
├── src/
│   ├── handler.ts           # [変更] 境界クエリ修正 + outer try/catch + ラダー定数
│   ├── handler.test.ts      # [変更] buildReadTx のクエリ形状追随 + 回帰テスト追加
│   ├── regenerate.test.ts   # [変更] outbound あり会話の regenerate 回帰テスト追加
│   ├── summary.ts           # 変更なし (sql<string> で正しく受けている)
│   └── ...
terraform/
└── modules/
    ├── ai-worker-lambda/main.tf  # 変更なし (timeout 60s のまま — research.md D3)
    └── queue/main.tf             # 変更なし (visibility 90s / maxReceiveCount 3)
```

**Structure Decision**: 既存 ai-worker ワーカーへの最小修正。変更は `handler.ts` 1 ファイル + テスト 2 ファイルに閉じ、インフラ(terraform)・app クライアント・DB スキーマは一切変更しない。app 側 `DraftBanner` は `error` 文字列を透過表示するため、新エラーコード `internal_error` の追加にクライアント変更は不要。

## Complexity Tracking

違反なし(新規プロジェクト・新規依存・スキーマ変更・アーキテクチャ変更のいずれもなし)。
