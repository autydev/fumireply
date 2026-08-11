# Specification Quality Checklist: 送信側メディア添付 — オペレーターから顧客への画像送信

**Purpose**: Validate specification completeness and quality before proceeding to planning
**Created**: 2026-07-20
**Feature**: [spec.md](../spec.md)

## Content Quality

- [x] No implementation details (languages, frameworks, APIs)
- [x] Focused on user value and business needs
- [x] Written for non-technical stakeholders
- [x] All mandatory sections completed

## Requirement Completeness

- [x] No [NEEDS CLARIFICATION] markers remain
- [x] Requirements are testable and unambiguous
- [x] Success criteria are measurable
- [x] Success criteria are technology-agnostic (no implementation details)
- [x] All acceptance scenarios are defined
- [x] Edge cases are identified
- [x] Scope is clearly bounded
- [x] Dependencies and assumptions identified

## Feature Readiness

- [x] All functional requirements have clear acceptance criteria
- [x] User scenarios cover primary flows
- [x] Feature meets measurable outcomes defined in Success Criteria
- [x] No implementation details leak into specification

## Notes

- 実装方式 (ブラウザ直接アップロード / 参照 URL 受け渡し / Send API) への言及は Assumptions に限定し、要件本文は技術非依存を維持。具体設計は親 Issue autydev/fumireply#82 と計画フェーズ (plan.md) で確定する
- スコープ判断 (画像のみ・1 枚・2 通送信・上限 25MB・#78 への掃除合流) は issue #82 での設計検討で確定済みのため [NEEDS CLARIFICATION] は残していない
- FR-004 の「Messenger」・FR-013 の「CloudWatch Logs Insights」は 009 spec と同様、プロダクトの前提 (配信先チャネル・既存運用基盤) としての言及であり実装選定ではない
- **設計レビュー反映 (2026-07-20)**: plan/research/contracts に対しコード整合・内部整合の 2 面レビューを実施。主な修正 — (1) 時間予算を共有 deadline 方式に作り替え pending 放置を実際に防止、(2) リトライラダーの数値を実コード実測 (~17s/通) に修正、(3) presigned PUT に ContentLength 署名でサイズを S3 強制 (悪用対策)、(4) FR-013 を「アップロード URL 発行 + 送信成否」に修正 (ブラウザ直接アップロードは成否がサーバー非観測のため)、(5) 画像単独送信のため ReplyForm の `!body.trim()` ガード緩和を契約化、(6) `sendError` に新値を足さず timeout→meta_error 写像。詳細は各文書内の「レビュー〇-〇」参照
