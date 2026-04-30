下記の修正事項をみて、それぞれの要件に合うように修正してくれますか?

/Users/ssdef/program/fumireply/specs/001-mvp-app-review/plan.md

##現在の仕様の修正事項

認証: JWT HttpOnly Cookieにした理由、他の選択肢にしなくてもOKか?
- **ユーザー認証**：Cognito User Pool 管理。DB にユーザーテーブル／セッションテーブルを持たず、JWT を HttpOnly Cookie で扱うステートレスセッション。

→この部分ですね。ユーザーテーブル、セッションテーブルをもたせる意味は?
→Lambdaと相性が良いためJWTだがどういうことか?

技術:TypeScript とNode.jsのランタイムは最新か? Terraformのバージョンも適切?
→そういえば、BumとかHonoとかその辺との比較はどうなんだろうか? メリット・デメリットの比較をしたい。

Playwrightがよくわかっていないので、どういうためにするもので、導入の必要があるのかを判断したい。
AIによる仕様駆動開発に役立つのであればいれてOKだし、多少時間かかっても使ってみるのはあり。

SSG,SSR,CSRの違いとなぜこの配置でこのような配置にしているのかを再度理解する。


- `(public)` ルート → SSG で静的 HTML 生成 → S3 アップロード → CloudFront 配信
- `(auth)/login` → CSR で JS バンドル + HTML shell 生成 → S3 アップロード → CloudFront 配信
- `(app)` ルート + `api` ルート + `createServerFn` → Lambda ハンドラとしてビルド → API Gateway 経由

→と分けることのメリットとその必要性はあるのか?
静的なサイトはS3に上げるのはTanstack を使うときの標準?Tanstackそのものにサーバー機能があって、そのままクライアントサイドのレンダリングはできないのか?複雑性が増している気がする。そのメリットは有るのか?


----

Meta の Data Deletion Request Callback 仕様に準拠した JSON レスポンスを返す
→これはどういうことか?アプリ内でそのメッセージのレコードを削除したいときに使う?

短期トークン → 長期ユーザートークン → 長期 Page Access Token の 2 段階交換で取得
→これを理解する必要がある。なんのトークンの話?Metaがユーザー渡すトークン?

## R-008: Use Case 説明文の書き方
→先にAIのリプライ機能を作ったほうが良いのでは?これが機能の目玉である。

別の問題:AIをどの用にインテグレートするか??API?また、どのAIのモデルを使うか?

---
/Users/ssdef/program/fumireply/specs/001-mvp-app-review/contracts/admin-api.md


GET /me?fields=id,name`

Meta の無料枠を圧迫しないよう、サーバー側で 5 分キャッシュする。
→Metaの無料枠は?
→キャッシュ5分は短くない?そういうもの?


----
/Users/ssdef/program/fumireply/specs/001-mvp-app-review/infrastructure.md

NAT Gatewayを使うとコストが膨らむので使わない方針で設計できないか?個人利用のアプリなので月額利用料を高くしたくない。

 
- **NAT Gateway 省略**：Lambda を VPC 外に出し、RDS Proxy で接続 → NAT 不要。ただし RDS Proxy は $15/月。
→という案もあるがRDSProcyなぜ必要ですか?そんなにメッセージが溜まることはない?



