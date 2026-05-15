# Submission Walkthrough — Fumireply Meta App Review

このドキュメントは Meta App Dashboard で **App Review を実際に提出するまで**を、属人性なく順番に実行するためのガイドです。Meta App Dashboard に不慣れな担当者でも、本書だけで提出フォーム送信まで到達できることを目標とします（spec SC-007）。

- 申請対象権限: `pages_show_list` / `pages_manage_metadata` / `pages_read_engagement` / `pages_messaging`
- 貼り付け本文: [`use-case-description.md`](./use-case-description.md)
- reviewer 認証情報・テスト手順: [`reviewer-credentials.md`](./reviewer-credentials.md)
- screencast 台本: [`screencast-script.md`](./screencast-script.md)

> 本書は日本語（運用担当向け）。フォームに貼り付ける本文は use-case-description.md / reviewer-credentials.md の **英語ブロック**を使うこと。

---

## 1. 提出前の前提条件（Pre-submit prerequisites）

提出作業を始める前に、以下がすべて満たされていること:

- [ ] Business Verification が承認済み（または Advanced Access に必要な状態）
- [ ] 本番デプロイ済みで `https://review.fumireply.ecsuite.work` が稼働（Phase 8 / U8.2）
- [ ] `bash scripts/prep-screencast.sh` 実行済み（reviewer 有効化 / `connected_pages` クリア / health 200）
- [ ] screencast を撮影・編集し YouTube 限定公開（Unlisted）にアップロード済み、URL を控えてある
- [ ] 公開ページ 4 種（`/privacy` `/terms` `/data-deletion` および会社情報）が 200
- [ ] Webhook 購読が Meta App Dashboard → Webhooks で緑チェック
- [ ] Anthropic をサブプロセッサとして開示した Privacy Policy が公開済み
- [ ] Supabase keep-alive Lambda が稼働（審査期間中の一時停止回避）
- [ ] 長期 Page Access Token を取得・保存する Connect フローが本番で動作確認済み
- [ ] reviewer 用 App パスワードを SSM から取得できる（または prep スクリプトがクリップボードに取得済み）
- [ ] FB Test User の認証情報（secret `FB_TEST_USER_EMAIL` / `FB_TEST_USER_PASSWORD`）と接続予定 Test Page の数値 Page ID が手元にある

---

## 2. Meta App Dashboard ナビゲーションマップ

```
Meta for Developers (developers.facebook.com)
  └ My Apps → Fumireply（App ID: <<APP ID>>）
      ├ App Review
      │   └ Permissions and Features        ← 権限ごとの Use Case 入力 + screencast
      │       ├ pages_show_list             → Request Advanced Access
      │       ├ pages_manage_metadata       → Request Advanced Access
      │       ├ pages_read_engagement       → Request Advanced Access
      │       └ pages_messaging             → Request Advanced Access
      │   └ Requests                        ← まとめて Submit するページ
      ├ App Settings
      │   ├ Basic                           ← App Domains / Privacy / Terms URL 確認
      │   └ Advanced → Data Deletion Request URL  ← "Send test" で 200 確認
      └ Webhooks                            ← Page 購読が緑チェックか確認
```

各権限は「Permissions and Features」の一覧から該当行の **Request Advanced Access** → 詳細パネルで Use Case 本文・添付（screencast）を入力する。入力後、最後に「Requests」ページで全権限をまとめて Submit する。

---

## 3. 権限ごとの貼り付け内容（Per-permission paste table）

各権限の詳細パネルの "How will your app use this permission?" に、共通プリアンブル + 当該権限の段落を貼る。本文は [`use-case-description.md`](./use-case-description.md) の該当セクションをそのままコピー。

| 権限 | 貼り付け元（use-case-description.md のセクション） | screencast 該当時間 |
|---|---|---|
| `pages_show_list` | Common preamble + Connect flow + `### pages_show_list` | 1:25–1:45 |
| `pages_manage_metadata` | Common preamble + Connect flow + `### pages_manage_metadata` | 1:45–2:00 |
| `pages_read_engagement` | Common preamble + Connect flow + `### pages_read_engagement` | 1:45–2:00 |
| `pages_messaging` | Common preamble + Connect flow + `### pages_messaging` | 2:00–2:30 |

> 各権限の文字数は Meta の上限（おおむね 1000〜2000 字）に収まることを貼付後に確認する。超過した場合は Common preamble を 1 段落に圧縮する。

---

## 4. screencast のアップロード手順

Meta は同一の screencast を全 4 権限に添付してよい。手順:

1. 各権限の詳細パネルに動画アップロード欄（または "Add a screencast URL"）がある
2. **同一 MP4 ファイルを 4 権限すべてにアップロード**する（推奨）。または YouTube 限定公開 URL を 4 か所すべてに貼る
3. どちらの方式でも、4 権限すべてに screencast が紐づいた状態にすること（1 つでも欠けると差し戻し）
4. 動画は ≤100MB / ≤4 分 / 英語 UI / 英語字幕焼き込み（screencast-script.md 準拠）

---

## 5. reviewer 認証情報の記入箇所

"App Review → Requests"（または各権限詳細）の **"Provide detailed steps..."** / "Test user / credentials" 欄に、[`reviewer-credentials.md`](./reviewer-credentials.md) §3 の英語ブロックを貼る。

- `<<APP PASSWORD>>` は SSM から取得した値に差し替え
- `<<FB TEST USER EMAIL / PASSWORD>>` は secret から差し替え
- `<<TEST PAGE NAME / NUMERIC PAGE ID>>` は接続予定 Test Page の実値に差し替え
- 貼付後、`grep -rn "<<.*>>" docs/review-submission/` 相当でプレースホルダ残存ゼロを最終確認（T054）

---

## 6. 提出前チェックリスト（Pre-submit checklist）

送信ボタンを押す前に、以下すべてにチェック:

- [ ] Business Verification 承認済み
- [ ] 公開ページ 4 種が HTTPS 200（`/privacy` `/terms` `/data-deletion` + 会社情報）
- [ ] Webhook 購読が緑チェック（Meta App Dashboard → Webhooks）
- [ ] Data Deletion Request URL の "Send test" が 200
- [ ] reviewer の `banned_until` が NULL（有効化済み）
- [ ] reviewer 用 App パスワードが SSM 最新値と一致（reviewer-credentials.md と整合）
- [ ] Connect フローが本番で動作（Login for Business 同意 → Page ID 入力 → /inbox）
- [ ] 長期 Page Access Token が暗号化保存される（短期トークンは永続化されない）
- [ ] Privacy Policy に Anthropic サブプロセッサ開示が含まれる
- [ ] Supabase keep-alive Lambda 稼働
- [ ] 4 権限すべてに Use Case 本文 + screencast が添付済み
- [ ] reviewer 認証情報欄にプレースホルダ残存ゼロ
- [ ] screencast が Unlisted で第三者から再生可能（incognito 確認）

10 項目以上を満たしていること。1 つでも未達なら提出しない。

---

## 7. 提出ボタン押下 + Submission ID 記録

1. "App Review → Requests" ページで、対象 4 権限がすべて "Ready to submit" 状態であることを確認
2. **Submit for Review** をクリック
3. 確認ダイアログで送信を確定
4. 送信完了画面に表示される **Submission ID（または Request ID）と送信日時**を控える
5. 次節の handoff に従い記録する

---

## 8. 提出後の引き継ぎ（Post-submit handoff）

- Submission ID + 送信日時を `docs/operations/audit-runbook.md` に追記（T077）。同ファイルは prep/post スクリプトが監査行を追記する運用ログ
- 提出後 `bash scripts/post-screencast.sh` を実行し reviewer を再無効化（必要ならパスワードローテーション）（T078）
- 既存 CloudWatch アラーム（001）が運用メール + Slack に届くことを確認（T079）
- 想定審査期間（通常 5〜10 営業日）とロールバック手順を `docs/operations/audit-runbook.md` に記載（T080）
- **審査期間中（提出〜結果通知まで）は reviewer パスワード・接続ページ・Webhook を変更しないこと**（"Cannot reproduce" 差し戻し回避）

詳細な運用手順は `docs/operations/audit-runbook.md` を参照。
