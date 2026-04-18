# Handoff: TCG CS System (Messenger/Instagram AI Customer Support)

## Overview

ポケモンカード・TCGセラーが Facebook Messenger / Instagram DM で受ける顧客問い合わせを、Claude AIがドラフト生成→運用者が承認/編集→送信するワークフローを支援するツールです。1人オペレーターで月300件〜を捌くことを想定し、**人間の判断を残したまま省力化する「AIドラフト承認型」** のUIが中心。

**主なユースケース:**
- 受信メッセージのカテゴリ自動分類(価格確認 / 購入意思 / 発送状況 等)
- 顧客履歴・商品DB・過去対応を根拠としたAIドラフト生成
- Meta 24時間ポリシー違反や未返信SLAの可視化・警告
- 顧客ごとのAIトーン/カスタム指示の持ち方(フランク/プロ/簡潔 + 自然言語プロンプト)
- 受信・返信メッセージの日本語訳併記(英語以外の言語対応)

## About the Design Files

このバンドルの `.html` `.jsx` `.css` ファイルは **デザインリファレンス**です。Babel + `type="text/babel"` で動くHTMLプロトタイプで、本番投入するコードではありません。

**タスクは、これらのデザインをターゲットの技術スタック(React + TypeScript + TanStack 推奨 — 下記参照)で再実装することです。**HTMLをそのまま使うのではなく、プロジェクトの既存パターンに沿って書き直してください。

## Fidelity

**High-fidelity (hifi)** — 色・タイポ・スペーシング・インタラクションまで確定しています。ピクセルレベルで再現してください。トークン値は本READMEの「Design Tokens」セクションに全て記載。

## Recommended Stack

ユーザーと合意済み:

```
- Vite + React 18 + TypeScript
- TanStack Router (ファイルベースルーティング)
- TanStack Query (サーバー状態管理、楽観的更新 → ドラフト承認UXに重要)
- TanStack Table (顧客管理テーブル)
- Zustand または Jotai (UIローカル状態)
- Tailwind CSS (現在のCSS変数トークンをそのまま config.theme.extend に移植可能)
- shadcn/ui (Radix primitives ベース、カスタマイズ容易)
- Zod (モックデータスキーマをバリデーションへ転用)
```

**状態管理の指針:**
- ドラフト承認/却下/編集は TanStack Query の mutation + optimistic update
- 新着メッセージは WebSocket/SSE → Query cache invalidation
- フィルタ・選択中会話・Tweaksは Zustand/Jotai ローカル状態(localStorage永続化)

## Screens / Views

### 1. Login
**Purpose:** Google SSOでログイン。MVPは松原さんのみアクセス想定。
**Layout:** センター固定カード (400px幅、背景は warm off-white)。ブランドマーク + タイトル + Google SSOボタン + Slack連携予告テキスト。
**File:** `other-screens.jsx` → `Login` component

### 2. 受信トレイ (Inbox) — **メイン画面**
**Purpose:** 未読・ドラフトあり・VIP・未返信SLA超過 で絞り込みながら会話を捌く。
**Layout (PC, 3-column):**
```
[Sidebar 220px] [InboxList 360px] [ThreadView flex-1] [CustomerPanel 300px]
```
- 画面幅 < 1280px のとき CustomerPanel は drawer化(ThreadView右上の「詳細」ボタンでトグル)
- 画面幅 < 900px (mobile tweak) は InboxList と ThreadView が排他表示 (mobile-thread classで切替)

**Components:**
- **Sidebar**: ロゴ + 4ナビ(受信トレイ / 顧客管理 / 商品管理 / 設定) + 下部にユーザーpill
  - 受信トレイには未読数badge
- **InboxList**:
  - 上部: 検索入力 (placeholder: "顧客名・メッセージ・メモを検索… ⌘K")
  - フィルタ chips: すべて / 未読 / ドラフトあり / VIP / 未返信
  - 会話行: アバター + 名前 + VIPバッジ + プレビュー + 時刻 + カテゴリタグ + SLAバッジ(2h+/4h+/送信失敗/24h迫る) + ドラフトドット + 未読ドット
  - VIPは左側3pxの赤ボーダーアクセント
- **ThreadView**:
  - ThreadHeader: アバター + 顧客名 + ハンドル + ステータス + 詳細パネルトグル
  - PolicyCountdown: Meta 24時間ポリシー残時間バナー(残6時間以下で出現、経過後は送信不可 - 赤背景)
  - メッセージバブル: 受信(左、ニュートラル背景) / 送信(右、primary indigo背景)
    - 受信で msg.lang !== 'en' の場合、バブル下に破線区切りで日本語訳を表示(showInboundTranslation判定時)
    - メタ行に言語タグ(IT/ES/JA等)
    - AI送信済みは checkmark + 「AI承認済」tagを表示
  - SendFailedBanner: `conversation.sendFailed` があるとき、赤アラート + リトライ/ログ確認/Slack共有ボタン
  - DraftComposer:
    - カード状。左borderにprimary accent。
    - 「📝 AIドラフト」ラベル + カテゴリタグ + confidence自然言語(「自信あり」/「確認推奨」)
    - `reasoning` テキスト(なぜこの返信を提案したか)
    - `sources` chips(顧客履歴 / 商品DB / 過去対応 等の根拠)
    - textarea(編集可、オートセーブ表示: 編集中→保存中…→下書き保存済)
    - 翻訳パネル(英語以外のドラフトで showTranslation=true 時、amber accent)
    - フッター: 👍/👎フィードバック + 破棄 / 承認して送信 (⌘↵)
    - 24h経過後は送信ボタンdisabled

- **CustomerPanel (右ペイン)**:
  - 顧客プロフィールヘッダー(アバター + 名前 + VIP/リピーター/新規タグ + 国 + ハンドル)
  - **プロフィール ブロック**: 最新問い合わせ / 国 / 優先度(normal/caution/high) / 決済方法(Wise/PayPal/Bank) / 初回接触日
  - **AIドラフト設定 カード** (新規):
    - トーン セグメントコントロール: フランク / プロ / 簡潔
    - カスタム指示 textarea (例: 「ファーストネーム呼び捨てOK / 値下げ上限-10% / 絵文字なし」)
    - ヘルプテキスト: 「返信言語は受信から自動判定。固定したい場合はカスタム指示に記載。」
    - 日本語訳併記トグル(customer.language !== 'en' 時のみ表示)
  - **メモ**(オートセーブtextarea)
  - **注文履歴**(過去5件、注文番号 + 金額 + 日付 + ステータス)
  - **クイックアクション**(Wise請求リンク/追跡番号送信 — Phase 2でグレーアウト)

**File:** `inbox-screens.jsx` (InboxList / ThreadView / DraftComposer / CustomerPanel / MessageBubble / ThreadHeader / PolicyCountdown / SendFailedBanner / AutoSavePill)

### 3. 顧客管理 (Customers)
**Purpose:** 全顧客のテーブル管理。最新問い合わせ降順ソート。
**Columns:** 顧客(アバター+名前+priority dot+VIP tag+handle+国) / チャネル(FB/IG) / 言語(EN/JA/ES等) / 注文数 / LTV / 最新問い合わせ / メモ / chevronRight
**File:** `other-screens.jsx` → `Customers`

### 4. 商品管理 (Products) — **Phase 2 placeholder**
**Purpose:** 現状Phase 2。スプレッドシート + LINE仕入れ情報への導線のみ。
**Layout:** センター固定カード、アイコン + PHASE 2 ラベル + 説明文 + データソースリンク3本(価格表/在庫DB/LINE仕入)
**File:** `other-screens.jsx` → `Products`

### 5. 設定 (Settings)
**Layout:** 縦積みセクション(連携 / AI / 通知 / アカウント)
**Toggles:**
- Slack連携 / Instagram DM連携 / Facebook Messenger連携(各ON/OFF + 設定アイコン)
- 英語以外の返信に日本語訳を併記(グローバル)
- ワンクリック承認モード
- 夜間サイレント時間
- プロンプト設定 textarea(AIへのシステム指示)
**File:** `other-screens.jsx` → `Settings`

### 削除済み: ダッシュボード
MVPでは運用データが少なすぎて価値が薄いため削除。Phase 2で実データ蓄積後に再設計予定。

## Interactions & Behavior

### ドラフト承認フロー
- **編集→送信モード** (デフォルト): textareaで編集してから「承認して送信」
- **ワンクリックモード**: 承認ボタンで即送信(textareaは参照のみ)
- ⌘↵ (Cmd+Enter) / Ctrl+Enter で承認ショートカット
- 承認後: 下書き消失 → 送信済バブルに差し替え(`aiSent: true`でAI承認済tag)
- 👍/👎 フィードバックボタン: 送信時にAIプロンプト改善用のシグナルを記録

### オートセーブ
- ドラフトtextarea/メモtextarea/カスタムプロンプトtextarea: 600ms debounce → "編集中" → "保存中…" → "下書き保存済" ピル表示
- ピルはfade遷移

### 検索 (⌘K)
- オーバーレイ(半透明backdrop + 中央モーダル)
- 顧客名・ハンドル・メモ・メッセージ本文の全文検索、結果にハイライト(`<mark>`)
- 結果クリックで該当会話/顧客画面へ遷移

### Meta 24時間ポリシー
- `lastInboundAt` から24時間の残時間をカウントダウン
- 残り6時間以下: amber bannerで警告表示
- 経過後: 赤banner + 送信ボタン disabled + `sendFailed` 状態へ(実運用ではGraph API `#10`/`#200` エラーを検知)

### SLAバッジ
`slaStateFor(conv)` で判定:
- `normal`: 2時間未満
- `warn` (2h+): amber tag
- `overdue` (4h+): 赤tag、VIPは「VIP 4h+」と強調
- `policy-warn` (24h迫る)
- `failed` (送信失敗)

### 新着メッセージアニメーション
- 45秒ごとにランダム顧客から新着mock(prototypeのみ)
- 対象の `.conv-item` が `slide-in-new` keyframes で top に挿入 + primary-soft背景ハイライト
- トーストで通知

### モバイル(tweakable: viewport)
- Sidebar非表示、InboxListとThreadViewが排他表示
- 会話選択で thread へ、戻るボタンで inbox へ

### Tweaks機能
`/*EDITMODE-BEGIN*/{...}/*EDITMODE-END*/` ブロックで宣言:
- viewport: desktop/mobile
- draftPresentation: inline (固定、将来side/cardも候補)
- approvalFlow: edit-send / one-click
- globalShowTranslation: true/false

本番では設定ページにグローバル設定を持つ。Tweaksはprototypeのみ。

## State Management

### サーバー状態(TanStack Query推奨)
- `useConversations({ filter })` — inbox list
- `useConversation(id)` — single thread + messages
- `useCustomer(id)` — customer profile
- `useCustomers({ sort: 'lastContactTs', order: 'desc' })` — customer list
- `useApproveDraft()` (mutation、楽観的更新) — 即座にbubble追加、失敗時ロールバック
- `useRejectDraft()` (mutation)
- `useRetryStoppedSend()` (mutation) — Graph API再送
- `useUpdateCustomer()` (mutation、debounced) — tonePreset / customPrompt / translationDefault / note

### ローカル状態(Zustand/Jotai)
- `selectedConversationId`
- `filter` (all / unread / draft / vip / overdue)
- `searchOpen`
- `panelDrawer` (narrow viewportのCustomerPanelドロワー)
- `mobileView` (inbox / thread)
- `tweaks` (persist to localStorage)

### WebSocket/SSE想定
- 新着メッセージ受信 → conversation cache invalidate + toast表示
- 送信ステータス更新(Meta Graph API webhook)

## Data Models (from `data.jsx`)

```ts
type Category = 'price' | 'intent' | 'detail' | 'shipping' | 'stock' | 'other';
type Channel = 'fb' | 'ig';
type Priority = 'normal' | 'caution' | 'high';
type TonePreset = 'friendly' | 'professional' | 'concise';
type Language = 'en' | 'ja' | 'es' | 'it' | 'no' | 'pt' | string;

type Customer = {
  id: string;
  name: string;
  handle: string;
  channel: Channel;
  tags: ('vip' | 'repeat' | 'new')[];
  orders: number;
  ltv: number;
  avgOrder: number;
  country: string;          // ISO country code
  language: Language;       // 主要言語(AUTO判定の初期値)
  payment: 'wise' | 'paypal' | 'bank' | '';
  priority: Priority;
  firstSeen: string;        // ISO date
  lastContactAt: string;    // 表示用(「2分前」等)
  lastContactTs: number;    // ソート用epoch ms
  note: string;
  // AI設定
  tonePreset: TonePreset;
  customPrompt: string;     // フリーフォーム自然言語指示
  translationDefault: boolean;  // 日本語訳併記(受信・ドラフト両方)
};

type Message = {
  id: string;
  from: 'in' | 'out';
  text: string;
  time: string;
  lang?: Language;          // 'en'以外のとき言語タグ + 翻訳表示
  translation?: string;     // 日本語訳(受信のみ)
  aiSent?: boolean;         // AI承認済フラグ(送信のみ)
};

type Draft = {
  category: Category;
  confidence: number;       // 0-1 — UIでは「自信あり/確認推奨」に自然言語化
  reasoning: string;        // 「なぜこの返信?」
  sources: { label: string; detail: string }[];
  text: string;
  translation?: string;     // 日本語訳
  lang?: Language;
};

type Conversation = {
  id: string;
  customerId: string;
  unread: boolean;
  time: string;
  lastAt: number;
  lastInboundAt: number;    // Meta 24hポリシー計算用
  category: Category;
  preview: string;
  hasDraft: boolean;
  messages: Message[];
  draft?: Draft;
  sla?: 'overdue' | 'policy-warn';
  sendFailed?: { reason: string; message: string };
};
```

## Design Tokens

`styles.css` の `:root` からそのまま移植。全て `oklch()` で定義しており、Tailwind `theme.extend.colors` に CSS variables として渡すのが最適。

### Colors

| Token | Value | Usage |
|---|---|---|
| `--bg` | `oklch(0.985 0.003 90)` | ページ背景(warm off-white) |
| `--bg-sunken` | `oklch(0.965 0.004 90)` | セクション背景 |
| `--bg-raised` | `oklch(1 0 0)` | カード/パネル背景 |
| `--bg-hover` | `oklch(0.955 0.005 260)` | hover state |
| `--bg-active` | `oklch(0.93 0.01 260)` | selected state |
| `--ink` | `oklch(0.22 0.015 260)` | 主要テキスト |
| `--ink-2` | `oklch(0.38 0.012 260)` | 副次テキスト |
| `--ink-3` | `oklch(0.55 0.01 260)` | キャプション |
| `--ink-4` | `oklch(0.72 0.008 260)` | disabled/placeholder |
| `--line` | `oklch(0.91 0.005 260)` | 区切り線 |
| `--line-strong` | `oklch(0.85 0.007 260)` | 強調区切り |
| `--primary` | `oklch(0.55 0.16 265)` | indigo / CTA |
| `--primary-hover` | `oklch(0.48 0.17 265)` | |
| `--primary-soft` | `oklch(0.95 0.03 265)` | AI関連ハイライト |
| `--primary-ink` | `oklch(0.35 0.14 265)` | AI text on soft bg |
| `--amber` | `oklch(0.78 0.13 75)` | warning/policy |
| `--amber-soft` | `oklch(0.95 0.04 75)` | |
| `--amber-ink` | `oklch(0.48 0.12 60)` | |
| `--rose` | `oklch(0.65 0.2 15)` | error / VIP accent / overdue |
| `--rose-soft` | `oklch(0.95 0.03 15)` | |
| `--rose-ink` | `oklch(0.45 0.18 15)` | |
| `--green` | `oklch(0.62 0.14 150)` | success |
| `--green-soft` | `oklch(0.94 0.04 150)` | |
| `--green-ink` | `oklch(0.42 0.12 150)` | |
| `--fb` | `oklch(0.52 0.17 260)` | Facebook/Messenger brand |

### Typography

```css
--font-ui: "Plus Jakarta Sans", system-ui, sans-serif;
--font-jp: "Noto Sans JP", "Plus Jakarta Sans", sans-serif;
--font-mono: "JetBrains Mono", ui-monospace, monospace;
```

- UI英字・数字: `--font-ui`
- 日本語・混在: `--font-jp`
- メタデータ・SKU・時刻: `--font-mono`

スケール(12~26px):
- `11px` メタ/キャプション
- `12.5px` 標準
- `13px` リスト項目
- `14px` ボタン/ラベル
- `16px` メッセージ本文
- `18-22px` h3/h2
- `26px` h1

### Spacing

- 4/6/8/10/12/14/16/20/24/28/32px — 2/4の倍数基調

### Radius

- `4px` タグ/バッジ
- `6-7px` 小ボタン/pill
- `8-10px` カード
- `12-14px` 大カード/モーダル
- `50%` アバター/ドット

### Shadows

```
--shadow-sm: 0 1px 2px oklch(0.22 0.015 260 / 0.06);
--shadow-md: 0 2px 8px oklch(0.22 0.015 260 / 0.08), 0 1px 2px oklch(0.22 0.015 260 / 0.06);
--shadow-lg: 0 12px 32px oklch(0.22 0.015 260 / 0.12), 0 4px 12px oklch(0.22 0.015 260 / 0.08);
```

## Assets

- **ブランドマーク**: HTML `<div class="brand-mark">M</div>` の簡易グラデーション(indigo→rose)。正式ロゴは別途用意想定。
- **アイコン**: 全て stroke SVG inline。Lucide React を推奨(同等のアイコンセット)。`components.jsx` の `Icon` オブジェクト参照。
- **アバター**: イニシャル + グラデーション背景(8色パレットをseed hashで選択)。`avatarColor(seed)` 関数参照。
- **画像**: 商品写真はMVP時点ではモックなし(テクスチャパターンで代替)。Shopify API連携後に実画像。
- **フォント**: Google Fonts (`Plus Jakarta Sans`, `Noto Sans JP`, `JetBrains Mono`) — self-host推奨。

## Files

本handoff folderに含まれるデザイン参照ファイル:

- `Malbek CS.html` — エントリーHTML(script読み込み順序の参考)
- `styles.css` — 全スタイル(CSS変数トークン + コンポーネントスタイル)
- `data.jsx` — モックデータ(Customer/Conversation/Draft等の実データ構造)
- `components.jsx` — Iconセット + 共通コンポーネント
- `inbox-screens.jsx` — InboxList / ThreadView / DraftComposer / CustomerPanel / MessageBubble
- `other-screens.jsx` — Customers / Settings / Products / Login / TopBar
- `app.jsx` — App shell / routing / state / TweaksPanel / SearchOverlay
- `lib/ios-frame.jsx` — iOSモバイルフレーム(モバイルプレビュー用、本番では不要)

## Implementation Notes & Gotchas

1. **Meta 24時間ポリシーは必ず実装**: Graph APIから `#10`/`#200` エラーが返る。運用者が気付けないとBAN risk。PolicyCountdown + 送信ボタンdisabled は必須。

2. **オートセーブは必須**: 運用者が編集中にタブ切替したり別会話に移ったりする。debounceは500-800msが快適。

3. **ドラフト1案のみ**: MVPでは代替案UIを出さない。もし欲しければ設定で有効化する形。

4. **confidence値の表示**: 数値(0.87等)ではなく自然言語(「自信あり」/「確認推奨」)。ユーザーがパーセント表示の意味を問い合わせたため。

5. **言語はAUTO判定**: 顧客レコードに `language` は持つが、UIから手動選択させない。意図と違う場合はカスタム指示に自然言語で書く(例: 「返信は英語で固定」)。

6. **日本語訳併記は2系統**: (a) グローバル設定、(b) 顧客個別トグル。顧客個別がONまたはグローバルON → 受信・ドラフト両方に日本語訳表示(英語以外のテキストのみ)。

7. **受信メッセージの翻訳タイミング**: 実装時はAI Lambda側でメッセージ保存時に `message.translation` を生成しておくと、UIでは表示判定のみで済む(追加APIコール不要)。

8. **VIP扱い**: `tags: ['vip']` は手動運用。自動判定(LTV閾値等)はMVPではしない。

9. **IDサンプル**: モックのconversation/customer IDは `conv1`〜`conv12`, `c1`〜`c12`。本番ではUUID想定。

10. **商品管理はPhase 2**: UIを作らず、既存データソース(Google Sheet/LINE)への導線のみ。Shopify API統合はPhase 2。

## Out of Scope (Phase 2)

- ダッシュボード(応答時間・カテゴリ分布の統計)
- 商品管理UI(Shopify連携後)
- Wise請求リンク自動生成(ドラフト内「請求リンク挿入」・クイックアクション)
- 追跡番号送信の自動化
- 複数オペレーター対応(権限管理、担当割り振り)
- AIの学習ループ(フィードバック蓄積 → プロンプト自動改善)
- 多チャネル化(LINE / WhatsApp 等)
