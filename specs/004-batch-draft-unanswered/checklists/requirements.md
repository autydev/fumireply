# 品質チェックリスト: 未返信メッセージのバッチ下書き生成

**Feature**: `004-batch-draft-unanswered`
**Date**: 2026-06-20

## 仕様の完全性

- [ ] 課題2 (連投の未返信バッチ) のみにスコープが閉じている (外部送信・再生成は別 Issue)
- [ ] 「最後の自分の返信」の定義が明示されている (最後の outbound timestamp、外部送信非記録の限界も明記)
- [ ] 下書きスコープ転換 (メッセージ単位 → 会話単位) の理由が research に記録されている
- [ ] デバウンス + coalesce による集約方式が contract で規定されている
- [ ] 「会話ごとアクティブ 1 件」が DB 制約 (partial unique index) で保証されている

## データ・移行

- [ ] `ai_drafts` の列追加・制約付け替え・データ移行の順序が data-model に明記
- [ ] partial unique index 作成前に重複 active を superseded へ整理する手順がある
- [ ] backfill 不能な孤児下書きの扱いが定義されている
- [ ] ロールバック SQL が用意されている
- [ ] RLS への影響なし (既存 tenant_id ポリシーが新カラムをカバー) を確認

## 後方互換・安全性

- [ ] 旧 `{ messageId }` 在庫ジョブを処理できるレガシー経路がある (撤去計画付き)
- [ ] 単発メッセージ 1 件で従来同等の下書きが出る (回帰なし, SC-003)
- [ ] SQS at-least-once / 順不同で冪等 (coalesce + unique index + upsert)
- [ ] マルチテナント分離 (withTenant) が enqueue / worker / server fn で維持

## 下書きライフサイクル

- [ ] pending / ready / failed / dismissed / superseded の遷移が定義されている
- [ ] 送信・破棄でアクティブ下書きが dismissed になり再提示されない (SC-004)
- [ ] 未返信バッチが空のとき空振り下書きを出さない (dismissed)
- [ ] 失敗下書き (failed) は次の新着で再生成できる (アクティブ扱いしない)

## 観測性

- [ ] `draft_enqueued` / `draft_superseded` / `draft_no_unanswered` / `draft_batch_composed` / `draft_persisted` を構造化ログに出す
- [ ] 集約率 (生成回数 << メッセージ件数) を計測可能 (SC-002)

## テスト

- [ ] coalesce 判定のユニット (連投で先行ジョブが skip)
- [ ] 未返信バッチ抽出の純粋関数ユニット (境界・ASC・CAP)
- [ ] `buildUserPrompt(history, unanswered)` の合成ユニット
- [ ] 空バッチ → dismissed の経路
- [ ] DB の「アクティブ 1 件」制約違反テスト (integration)
- [ ] 送信/破棄後の非再提示テスト
- [ ] E2E スモーク (連投 3 通 → 1 下書き → 全件言及 → 送信 → 非再提示)

## UI

- [ ] 下書き取得を会話アクティブ下書きに変更 (get-conversation)
- [ ] ポーリングを conversationId 基準に変更 (get-draft-status / DraftBanner)
- [ ] 破棄が dismiss-draft server fn を呼ぶ (ReplyForm)
