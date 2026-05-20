# Research: Draft 操作 UX 強化（再生成・破棄・日本語訳）

**Branch**: `004-draft-actions-and-translation` | **Date**: 2026-05-20

Spec 004 で必要となる技術判断を 7 つに整理し、それぞれ「決定 / 根拠 / 検討した代替」を記録する。

## D-001: 翻訳プロバイダ

**Decision**: **DeepL Free API**（`https://api-free.deepl.com/v2/translate`）

**Rationale**:
- 月 50 万文字無料、超過時は 456 を返すのでハンドルが容易
- 認証は API キー 1 つだけ。SSM 1 本で完結
- 翻訳精度は内部確認用としては十分（spec で「精度低めでも OK」が前提）
- 既存 `fetch` のみで叩ける（[[feedback_no_axios]] と整合）
- 顧客送信用ではないため、DeepL の機械翻訳特有の癖は問題にならない

**Alternatives considered**:
- **Chrome 内蔵 Translator API**: Chrome 138+ のみ・Safari 非対応・モバイル不可。PC ブラウザ運用主体でも progressive enhancement 必須となり実装が増える。費用ゼロは魅力だが「シンプルさ」を優先して却下（ユーザー判断、conversation 上で確定）
- **OpenAI / Anthropic 翻訳**: コストが既存 Anthropic 利用に上乗せ。1 ドラフトあたり翻訳トークンが数百〜千程度のオーバーヘッドで、月数万円規模に膨らみうる
- **transformers.js + Helsinki-NLP/opus-mt-en-ja**: ブラウザ実行・サーバ負荷ゼロは魅力だが、初回モデル DL ~200MB がオーナー体験を大きく損なう
- **LibreTranslate セルフホスト**: 運用コストとレイテンシで現フェーズに不向き

## D-002: 翻訳結果の保存方式

**Decision**: **`ai_drafts.translation_ja` カラムに保存（draft 行と 1:1）**

**Rationale**:
- 「揮発キャッシュ＝ DB に書かず毎回叩く」も検討したが、再生成・リロード・他オーナー閲覧のたびに DeepL を叩くのは API 上限を不必要に消費する
- 「draft レコードと一緒に 1 回だけ書く、設定 OFF 時は UI で隠す」が最も単純で API コール最小
- ユーザーが当初「揮発」と言ったのは「翻訳結果用の別キャッシュ層を作らない」という意味で、draft レコードへの保存は OK と確認済（conversation 上で合意）
- 再生成時は新 draft レコードができるので、自動的に新規に翻訳が走る（旧 draft の翻訳は再利用しない＝結果的に揮発に近い意味論）

**Alternatives considered**:
- **別テーブル `draft_translations`**: 1:1 リレーションのため別テーブル化は YAGNI。FR-019 と矛盾
- **完全揮発（DB 保存なし、毎リクエスト DeepL）**: 上限消費が爆発的に増える、リロードのたびに翻訳遅延が乗る、API 障害時の見え方が不安定

## D-003: ai_drafts のライフサイクル状態の表現

**Decision**: **新規列 `lifecycle_status` varchar(20) + CHECK 制約 (`active` | `discarded` | `superseded`)** を追加。既存の `status` 列（AI 生成進捗: `pending` / `ready` / `failed`）は触らない。

**Rationale**:
- 既存 `status` 列は「AI が draft 生成プロセスのどこにいるか」を表現する技術的状態（`pending` = 生成中, `ready` = 生成完了, `failed` = 生成失敗）。spec 004 が必要とするのは「ユーザーがこの draft をどう扱ったか」というライフサイクル状態（`active` / `discarded` / `superseded`）。意味が違うため別列にする
- 既存列に値を相乗りさせると、`status='pending'` が「AI 生成中」なのか「未操作」なのか区別不能になる
- 単純な状態機械（3 値、遷移は `active → discarded` or `active → superseded`）に対し、enum テーブル or 履歴テーブルはオーバーキル
- 将来 spec 005 でフィードバック収集の `accepted` / `discarded_with_reason` を追加する際も CHECK の値を増やすだけ

**Alternatives considered**:
- **既存 `status` 列を拡張（`discarded` / `superseded` を追加）**: 意味が混在する。コード読解時に「`status='ready'` は active のことか？」と毎回戸惑う
- **Postgres enum 型**: 値追加時のマイグレーション制約（`ALTER TYPE ... ADD VALUE` の挙動）が将来の拡張を妨げる
- **bool 2 つ（is_discarded, is_superseded）**: 排他制約が CHECK で書きづらく、UI のフィルタ式が複雑になる
- **separate `draft_events` テーブル**: 履歴と状態を別管理する案。YAGNI

## D-004: 既存行への lifecycle_status バックフィル

**Decision**: **既存 `ai_drafts` 行はすべて `lifecycle_status='active'` でバックフィル**

**Rationale**:
- マイグレーション時点で UI に出ている draft（既存 `status='ready'`）はすべて「未操作 = active」が自然
- `status='pending'`（生成中）や `status='failed'`（生成失敗）の行も同様に `active` でよい。これらは将来ユーザーが触れる可能性があるが、`status` 側のフィルタで UI 表示は適切に制御されている
- バックフィル SQL は `UPDATE ai_drafts SET lifecycle_status='active' WHERE lifecycle_status IS NULL` の 1 行で済む。マイグレーション中の DEFAULT 適用でも OK
- 過去の old draft（同一 conversation で複数行ある場合）も `active` にしておく。spec 003 までの仕様では「最新 1 件しか UI に出さない」運用なので、複数の `active` 行があっても UI 体験は壊れない（UI 側は `created_at DESC LIMIT 1` で最新だけ取る）

**Alternatives considered**:
- **created_at 順で最新 1 件を `active`、それ以外を `superseded`**: より厳密だが、過去データの状態を推測する作業が増える。実データの行数次第では複雑性に見合わない

## D-005: 翻訳呼び出しの統合ポイント

**Decision**: **ai-worker の draft job 完了直後に inline で DeepL を呼び出し、ai_drafts に書き戻す**

**Rationale**:
- 別 SQS キュー → 別ジョブ → 別 Lambda の構成はオーバーキル。翻訳は draft 1 件あたり 1 API call で完結する軽量処理
- ai-worker は既に Anthropic API を叩く I/O bound 処理を持つ。同関数内に DeepL 呼び出しを追加するのは責務拡張として自然
- 失敗時の影響範囲を限定するため、draft 本体保存 → 翻訳 try（個別 try/catch）→ 翻訳結果 UPDATE の順で実行。翻訳が失敗しても draft 本体には影響しない
- DeepL API は p95 < 1 秒のレイテンシ想定。draft 生成全体 60 秒 SLO に対する寄与は無視可能

**Alternatives considered**:
- **新規 Lambda `translation-worker`**: 単一機能のため新規 Lambda は YAGNI。観測性・デプロイ複雑度が上がる
- **app-lambda 側で server fn から呼ぶ**: draft 生成が非同期（SQS 経由）なので、app-lambda は draft 生成完了を知らない。webhook で polling するのは複雑
- **新規 SQS キュー `translation-queue`**: ai-worker → translation-queue → 同じ ai-worker（2 つ目の event source mapping）。spec 003 と似たパターンだが、翻訳は draft 直後に走らせれば十分なので冗長

## D-006: 翻訳タイミング（同期 vs 並行）

**Decision**: **draft 本体保存 → 翻訳 try → 翻訳結果 UPDATE の順次実行（同期）**

**Rationale**:
- 並行（draft 保存と翻訳 API を Promise.all で並列）にする実装上の利得は < 1 秒。コード複雑度に見合わない
- 順次実行なら「draft 保存成功・翻訳失敗」の状態が DB に確定する瞬間が明確で、`translation_status` 列の整合が取れる
- ユーザー体感は draft 生成全体の SLO に従う。翻訳完了を待たずに UI に draft を出す経路は今回作らない（UX の複雑度を上げないため）

**Alternatives considered**:
- **並行 (`Promise.all`)**: 順次の利得は数百 ms。エラーハンドル複雑度が上がる
- **draft 表示 → 後追いで翻訳を取得（polling）**: UI 側の状態管理が増える。spec 005 でユーザー体感が問題視されたら検討

## D-007: API キー管理

**Decision**: **SSM Parameter Store `/fumireply/<env>/deepl_api_key` + ai-worker IAM 権限追加**

**Rationale**:
- spec 003 で確立した SSM Parameter Store パターン（`/fumireply/<env>/<key>`）を踏襲。Terraform への追加 ~20 行
- env var に直接 API キーを入れない（漏洩リスク・rotation 容易性）
- 環境ごと（review / prod）に別キーを使えるようパス階層に env を含める
- ai-worker Lambda の起動時または初回呼び出し時に SSM から取得・モジュールキャッシュする（既存 Anthropic キーと同じ取り回し）

**Alternatives considered**:
- **平文 env var**: Terraform `tfstate` に API キーが残る。漏洩リスク
- **Secrets Manager**: SSM より高コスト。fumireply は SSM Parameter 統一なので一貫性のために SSM 継続
- **直接コードへ埋め込み**: 論外

## まとめ

7 つの判断はすべて「最も単純な選択肢」+「spec 003 で確立したパターンの踏襲」に揃った。新規 Lambda / 新規キュー / 新規テーブルがゼロ、新規パッケージもゼロ。実装の自由度を残しつつ、運用追加負荷も最小。
