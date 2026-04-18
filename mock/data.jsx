// Sample data for the Messenger CS tool prototype

const CATEGORIES = {
  price:    { label: '価格確認', cls: 'cat-price' },
  intent:   { label: '購入意思', cls: 'cat-intent' },
  detail:   { label: '商品詳細', cls: 'cat-detail' },
  shipping: { label: '発送状況', cls: 'cat-shipping' },
  stock:    { label: '在庫確認', cls: 'cat-stock' },
  other:    { label: 'その他', cls: 'cat-other' },
};

const AVATAR_COLORS = [
  'linear-gradient(135deg, oklch(0.62 0.15 240) 0%, oklch(0.55 0.17 265) 100%)',
  'linear-gradient(135deg, oklch(0.68 0.13 155) 0%, oklch(0.55 0.12 170) 100%)',
  'linear-gradient(135deg, oklch(0.78 0.12 75) 0%, oklch(0.65 0.18 30) 100%)',
  'linear-gradient(135deg, oklch(0.62 0.17 305) 0%, oklch(0.55 0.19 330) 100%)',
  'linear-gradient(135deg, oklch(0.65 0.18 20) 0%, oklch(0.55 0.2 10) 100%)',
  'linear-gradient(135deg, oklch(0.6 0.14 195) 0%, oklch(0.5 0.15 215) 100%)',
  'linear-gradient(135deg, oklch(0.7 0.1 105) 0%, oklch(0.55 0.13 140) 100%)',
  'linear-gradient(135deg, oklch(0.55 0.2 345) 0%, oklch(0.45 0.2 320) 100%)',
];
const avatarColor = (seed) => AVATAR_COLORS[seed % AVATAR_COLORS.length];
const initials = (name) => name.split(' ').map(w => w[0]).join('').slice(0,2).toUpperCase();

// Extended customer model: language, priority, payment preference, lastContactAt, avgOrder
const CUSTOMERS = [
  { id: 'c1',  name: 'Marcus Thornton',   handle: '@marcus.thornton',   channel: 'fb', tags: ['vip', 'repeat'], orders: 7, ltv: 2840, avgOrder: 406, country: 'US', language: 'en', payment: 'wise',   priority: 'normal',  firstSeen: '2024-08-02', lastContactAt: '2分前',  note: '90年代の日本限定プロモ収集家。EMS希望。Wise決済固定。' },
  { id: 'c2',  name: 'Sofia Alvarez',     handle: '@sofia_a',           channel: 'ig', tags: ['vip'],           orders: 4, ltv: 1620, avgOrder: 405, country: 'MX', language: 'en', payment: 'paypal', priority: 'normal',  firstSeen: '2025-01-14', lastContactAt: '8分前',  note: '短文のやりとりを好む。返信は2-3文推奨。' },
  { id: 'c3',  name: 'Liam O\'Connor',    handle: '@liamoc',            channel: 'fb', tags: ['repeat'],        orders: 3, ltv: 880,  avgOrder: 293, country: 'IE', language: 'en', payment: 'paypal', priority: 'normal',  firstSeen: '2025-03-22', lastContactAt: '1時間前', note: '' },
  { id: 'c4',  name: 'Yuki Tanaka',       handle: '@yukit_cards',       channel: 'ig', tags: ['new'],           orders: 0, ltv: 0,    avgOrder: 0,   country: 'JP', language: 'en', payment: '',       priority: 'normal',  firstSeen: '2026-04-10', lastContactAt: '2時間前', note: '' },
  { id: 'c5',  name: 'Benjamin Price',    handle: '@ben.price',         channel: 'fb', tags: ['repeat'],        orders: 2, ltv: 410,  avgOrder: 205, country: 'GB', language: 'en', payment: 'paypal', priority: 'normal',  firstSeen: '2025-09-08', lastContactAt: '5時間前', note: '' },
  { id: 'c6',  name: 'Chiara Russo',      handle: '@chiarussoart',      channel: 'ig', tags: ['new'],           orders: 0, ltv: 0,    avgOrder: 0,   country: 'IT', language: 'en', payment: '',       priority: 'normal',  firstSeen: '2026-04-17', lastContactAt: '昨日',   note: '' },
  { id: 'c7',  name: 'Daniel Kim',        handle: '@danielkim_tcg',     channel: 'fb', tags: ['vip', 'repeat'], orders: 12, ltv: 5210, avgOrder: 434, country: 'KR', language: 'en', payment: 'wise',   priority: 'normal',  firstSeen: '2024-02-19', lastContactAt: '3時間前', note: '最高LTV顧客。常に24時間以内に支払い。' },
  { id: 'c8',  name: 'Emma Larsen',       handle: '@emma.larsen',       channel: 'ig', tags: ['new'],           orders: 0, ltv: 0,    avgOrder: 0,   country: 'NO', language: 'en', payment: '',       priority: 'normal',  firstSeen: '2026-04-16', lastContactAt: '昨日',   note: '' },
  { id: 'c9',  name: 'Ravi Patel',        handle: '@ravi_patel',        channel: 'fb', tags: ['repeat'],        orders: 5, ltv: 1340, avgOrder: 268, country: 'IN', language: 'en', payment: 'paypal', priority: 'normal',  firstSeen: '2025-05-30', lastContactAt: '昨日',   note: '' },
  { id: 'c10', name: 'Natalie Brooks',    handle: '@natbrooks',         channel: 'ig', tags: [],                orders: 1, ltv: 210,  avgOrder: 210, country: 'CA', language: 'en', payment: 'paypal', priority: 'normal',  firstSeen: '2026-02-11', lastContactAt: '2日前',  note: '' },
  { id: 'c11', name: 'Tomás García',      handle: '@tomasgarcia',       channel: 'fb', tags: ['repeat'],        orders: 2, ltv: 520,  avgOrder: 260, country: 'ES', language: 'en', payment: 'paypal', priority: 'caution', firstSeen: '2025-11-04', lastContactAt: '2日前',  note: '値下げ交渉が多い。前回$40値引き済。' },
  { id: 'c12', name: 'Aiko Watanabe',     handle: '@aikow',             channel: 'ig', tags: ['vip'],           orders: 6, ltv: 2100, avgOrder: 350, country: 'JP', language: 'ja', payment: 'wise',   priority: 'normal',  firstSeen: '2024-12-01', lastContactAt: '3日前',  note: '日本語OK。' },
];

// Conversations — single draft per conversation (no alternatives for MVP)
// lastInboundAt: when customer last messaged — drives 24h Meta policy countdown
const NOW = Date.now();
const hrs = (h) => NOW - h * 3600 * 1000;
const mins = (m) => NOW - m * 60 * 1000;

// tonePreset, customPrompt, translationDefault を各顧客に付与
const TONE_OVERRIDES = {
  c1:  { tone: 'friendly',     cp: '古参VIP。ファーストネーム、絵文字OK。Wise決済前提で進める。' },
  c2:  { tone: 'concise',      cp: '短文推奨。2-3文で収める。' },
  c3:  { tone: 'friendly',     cp: '' },
  c4:  { tone: 'professional', cp: '新規顧客。初回は丁寧めに。商品状態の写真提供OKと伝える。' },
  c5:  { tone: 'friendly',     cp: '' },
  c6:  { tone: 'professional', cp: '新規顧客。フルネーム + 言語確認を含める。' },
  c7:  { tone: 'friendly',     cp: '最高LTV。信頼関係あり。決裁の速さを想定した簡潔な返信。' },
  c8:  { tone: 'professional', cp: '' },
  c9:  { tone: 'friendly',     cp: '' },
  c10: { tone: 'friendly',     cp: '' },
  c11: { tone: 'professional', cp: '値下げ交渉が多い。価格のラインを先に明示、譲歩の余地は小さめ。' },
  c12: { tone: 'friendly',     cp: '日本語OK。日本人収集家。' },
};
CUSTOMERS.forEach(c => {
  const o = TONE_OVERRIDES[c.id] || { tone: 'friendly', cp: '' };
  c.tonePreset = o.tone;
  c.customPrompt = o.cp;
  c.translationDefault = (c.language !== 'en'); // 英語以外はデフォルトで訳併記
  // 最新問い合わせ用のタイムスタンプ(並び替え用)
  const map = { '2分前': 2*60000, '8分前': 8*60000, '1時間前': 3600000, '2時間前': 2*3600000, '3時間前': 3*3600000, '5時間前': 5*3600000, '昨日': 24*3600000, '2日前': 48*3600000, '3日前': 72*3600000 };
  c.lastContactTs = NOW - (map[c.lastContactAt] || 86400000);
});

const CONVERSATIONS = [
  {
    id: 'conv1', customerId: 'c1', unread: true, time: '2分前', lastAt: mins(2), lastInboundAt: mins(2),
    category: 'intent',
    preview: "Hey! I\u2019m really interested in the Charizard 1st edition you posted last week. Is it still available?",
    hasDraft: true,
    messages: [
      { id: 'm1-1', from: 'in', text: "Hey man, it\u2019s been a while! Hope you\u2019re doing well.", time: '10:42' },
      { id: 'm1-2', from: 'in', text: "I\u2019m really interested in the Charizard 1st edition Japanese you posted last week. Is it still available?", time: '10:43' },
      { id: 'm1-3', from: 'in', text: "Also — price in USD would be great, and can you do Wise invoice again like last time?", time: '10:43' },
    ],
    draft: {
      category: 'intent', confidence: 0.94,
      reasoning: "過去7回すべてWise決済。直近購入は2026-03-18 ($420)。VIP顧客のため価格交渉の余地を含めた返信を推奨。商品DB照合済 — 該当商品は在庫あり (SKU: CHAR-1ED-JP-023)。",
      sources: [
        { label: '顧客履歴', detail: 'Wise決済 7/7回' },
        { label: '商品DB', detail: 'CHAR-1ED-JP-023 · 在庫1点' },
      ],
      text: "Hey Marcus, good to hear from you! Yes, the Charizard 1st Ed JP is still available. Price is $890 USD shipped with EMS + insurance. I'll send you a Wise invoice today. Let me know if you'd like me to hold it for you.",
      translation: "Marcusさん、お久しぶり!Charizard 1st Ed JPはまだ在庫ありますよ。EMS + 保険込みで$890 USDです。本日Wiseで請求書を送ります。取り置きが必要なら教えてください。",
    },
  },
  {
    id: 'conv2', customerId: 'c2', unread: true, time: '8分前', lastAt: mins(8), lastInboundAt: mins(8),
    category: 'price',
    preview: "Hi! How much is the Umbreon VMAX Alt Art you listed on Insta? ✨",
    hasDraft: true,
    messages: [
      { id: 'm2-1', from: 'in', text: "Hi! How much is the Umbreon VMAX Alt Art you listed on Insta? ✨", time: '10:36' },
    ],
    draft: {
      category: 'price', confidence: 0.88,
      reasoning: "価格表参照: Umbreon VMAX Alt Art = $680。Sofiaは過去VIP、前回$420購入。",
      sources: [{ label: '商品DB', detail: 'UMBR-VMAX-ALT-002 · $680' }, { label: '顧客履歴', detail: 'LTV $1,620' }],
      text: "Hi Sofia! The Umbreon VMAX Alt Art is $680 USD shipped worldwide. Condition is NM, comes with toploader + bubble mailer + tracking. Happy to send a PayPal invoice whenever you\u2019re ready.",
      translation: "Sofiaさん!Umbreon VMAX Alt Artは送料込みで$680 USDです。状態はNM、トップローダー + バブルメーラー + 追跡番号付きでお送りします。準備できたらPayPal請求書を送りますね。",
    },
  },
  {
    id: 'conv3', customerId: 'c3', unread: false, time: '1時間前', lastAt: hrs(1), lastInboundAt: hrs(1),
    category: 'shipping',
    preview: "Sorry to bother you — any update on tracking? It\u2019s been 3 days since you sent the invoice confirmation.",
    hasDraft: true,
    messages: [
      { id: 'm3-1', from: 'in', text: "Hey! Sorry to bother you — any update on the tracking number? It\u2019s been 3 days since the payment.", time: '9:48' },
    ],
    draft: {
      category: 'shipping', confidence: 0.91,
      reasoning: "注文 #ORD-2026-0418 確認済。4月17日発送、EMS追跡番号 EE123456789JP。追跡番号を自動挿入。",
      sources: [{ label: '注文DB', detail: '#ORD-2026-0418' }, { label: 'EMS追跡', detail: 'EE123456789JP' }],
      text: "Hi Liam! Sorry for the delay — shipped yesterday (4/17). EMS tracking: EE123456789JP. Should arrive in 5-7 business days. Let me know when it lands!",
      translation: "Liamさん、遅れてすみません — 昨日(4/17)発送しました。EMS追跡番号: EE123456789JP。5-7営業日で届きます。受け取り次第お知らせください!",
    },
  },
  {
    id: 'conv4', customerId: 'c4', unread: true, time: '2時間前', lastAt: hrs(2), lastInboundAt: hrs(2),
    category: 'detail',
    preview: "Hello! Can I ask about the condition of the Mew V SAR? Any scratches or whitening on the edges?",
    hasDraft: true,
    messages: [
      { id: 'm4-1', from: 'in', text: "Hello! Can I ask about the condition of the Mew V SAR you posted?", time: '8:52' },
      { id: 'm4-2', from: 'in', text: "Any scratches or whitening on the edges? Also — is it the Japanese version or English?", time: '8:52' },
    ],
    draft: {
      category: 'detail', confidence: 0.82,
      reasoning: "新規顧客。商品DB: Mew V SAR (SKU: MEW-V-SAR-JP-004) — 状態NM、日本語版。",
      sources: [{ label: '商品DB', detail: 'MEW-V-SAR-JP-004 · NM' }],
      text: "Hi Yuki! The Mew V SAR is in NM condition — no scratches, very minor handling on one corner (basically invisible). It\u2019s the Japanese version. I can send additional close-up photos if that helps!",
      translation: "Yukiさん!Mew V SARはNM状態、傷なし、角に微細な取り扱い跡が1箇所(ほぼ見えないレベル)。日本語版です。近接写真の追加送付も可能です。",
    },
  },
  {
    id: 'conv5', customerId: 'c7', unread: false, time: '3時間前', lastAt: hrs(3), lastInboundAt: hrs(3.2),
    category: 'intent',
    preview: "I'll take all three Gold Stars. Please send the invoice.",
    hasDraft: false,
    messages: [
      { id: 'm5-1', from: 'in', text: "Those three Gold Stars you posted — are they still available as a lot?", time: '7:32' },
      { id: 'm5-2', from: 'out', text: "Hi Daniel! Yes all three are available. $1,840 for the lot + $50 EMS shipping.", time: '7:41', aiSent: true },
      { id: 'm5-3', from: 'in', text: "I'll take all three. Please send the Wise invoice.", time: '7:45' },
      { id: 'm5-4', from: 'out', text: "Just sent — check your email (same as last time). Thanks Daniel!", time: '7:48' },
    ],
  },
  {
    id: 'conv6', customerId: 'c5', unread: false, time: '5時間前', lastAt: hrs(5), lastInboundAt: hrs(5),
    category: 'stock',
    preview: "Do you have any Iono SR in stock? Can wait a few weeks if you\u2019re restocking.",
    hasDraft: true,
    messages: [
      { id: 'm6-1', from: 'in', text: "Hey! Do you have any Iono SR in stock? Can wait a few weeks if you\u2019re restocking.", time: '5:14' },
    ],
    draft: {
      category: 'stock', confidence: 0.76,
      reasoning: "Iono SR (SKU: IONO-SR-JP-099) は現在在庫切れ。LINE仕入れ情報では4月下旬入荷予定。",
      sources: [{ label: '商品DB', detail: 'IONO-SR-JP-099 · 在庫切れ' }, { label: 'LINE仕入', detail: '4月下旬入荷予定' }],
      text: "Hi Ben! Currently out of stock on Iono SR but I\u2019m expecting a small batch around end of April. Want me to put you on the notify list? First come first served.",
      translation: "Benさん!現在Iono SRは在庫切れですが、4月末に小ロット入荷予定です。入荷通知リストに登録しますか?先着順です。",
    },
  },
  {
    id: 'conv7', customerId: 'c8', unread: true, time: '5時間前', lastAt: hrs(5.2), lastInboundAt: hrs(5.2),
    category: 'shipping',
    preview: "Hei! Do you ship to Norway? And what would the shipping cost be?",
    hasDraft: true,
    sla: 'overdue',
    messages: [
      { id: 'm7-1', from: 'in', text: "Hei! Do you ship to Norway? And what would shipping cost be for something like the Lugia V SAR?", time: '昨日 23:12' },
    ],
    draft: {
      category: 'shipping', confidence: 0.85,
      reasoning: "発送料金表: Norway EMS = $38 (up to 500g)。Lugia V SAR価格 $320。合計$358。",
      sources: [{ label: '発送料金表', detail: 'NO EMS · $38' }, { label: '商品DB', detail: 'LUGIA-V-SAR-017 · $320' }],
      text: "Hi Emma! Yes, I ship to Norway. For the Lugia V SAR it would be $320 + $38 EMS = $358 USD total, fully tracked and insured. Should take about 7-10 business days.",
      translation: "Emmaさん!ノルウェーへ発送可能です。Lugia V SARの場合$320 + EMS $38 = 合計$358 USD、追跡・保険込みです。7-10営業日で届く予定です。",
    },
  },
  {
    id: 'conv8', customerId: 'c9', unread: false, time: '昨日', lastAt: hrs(22), lastInboundAt: hrs(22),
    category: 'shipping',
    preview: "Package arrived! Everything perfect as always. Thanks Yuta 🙏",
    hasDraft: false,
    messages: [
      { id: 'm8-1', from: 'in', text: "Package arrived! Everything perfect as always. Thanks Yuta 🙏", time: '昨日' },
      { id: 'm8-2', from: 'out', text: "Awesome! Glad it got there safely. Enjoy 🔥", time: '昨日' },
    ],
  },
  {
    id: 'conv9', customerId: 'c6', unread: true, time: '23h前', lastAt: hrs(23.5), lastInboundAt: hrs(23.5),
    category: 'detail',
    preview: "Ciao! Is that Rayquaza Amazing Rare English or Japanese? I collect only EN.",
    hasDraft: true,
    sla: 'policy-warn', // 24時間ポリシー間近
    messages: [
      { id: 'm9-1', from: 'in', text: "Ciao! Is that Rayquaza Amazing Rare English or Japanese? I collect only EN.", time: '昨日', lang: 'it', translation: "こんにちは!そのRayquaza Amazing Rareは英語版ですか、それとも日本語版ですか?英語版しか集めていません。" },
    ],
    draft: {
      category: 'detail', confidence: 0.93,
      reasoning: "商品DB: Rayquaza Amazing Rare (SKU: RAYQ-AR-025) — 日本語版のみ保有。英語版は在庫なし。",
      sources: [{ label: '商品DB', detail: 'RAYQ-AR-025 · JP版のみ' }],
      text: "Ciao Chiara! That one is the Japanese version. Unfortunately I don\u2019t have the English version in stock right now — but I can let you know if one comes in. Would that work?",
      translation: "Chiaraさん!それは日本語版です。申し訳ないですが、英語版は現在在庫切れです — 入荷時にお知らせすることは可能ですが、いかがでしょうか?",
    },
  },
  {
    id: 'conv10', customerId: 'c10', unread: false, time: '2日前', lastAt: hrs(48), lastInboundAt: hrs(48),
    category: 'other', preview: "Just wanted to say hi — saw your new Insta post, looks great!", hasDraft: false,
    messages: [
      { id: 'm10-1', from: 'in', text: "Just wanted to say hi — saw your new Insta post, looks great!", time: '2日前' },
      { id: 'm10-2', from: 'out', text: "Thank you so much Natalie! 🙏", time: '2日前' },
    ],
  },
  {
    id: 'conv11', customerId: 'c11', unread: false, time: '2日前', lastAt: hrs(60), lastInboundAt: hrs(60),
    category: 'price', preview: "Hola! Would you take $200 for the Zoroark V Alt?", hasDraft: true,
    sendFailed: { reason: '24h policy', message: 'Meta 24時間ポリシー: 最後のユーザーメッセージから24時間経過。送信不可。' },
    messages: [
      { id: 'm11-1', from: 'in', text: "Hola! Would you take $200 for the Zoroark V Alt?", time: '2日前', lang: 'es', translation: "こんにちは!Zoroark V Altを$200でどうですか?" },
    ],
    draft: {
      category: 'price', confidence: 0.68,
      reasoning: "Zoroark V Alt 表示価格$240。Tomásは過去2回$520購入。-17%オファーは大きすぎるため$220でカウンター推奨。",
      sources: [{ label: '商品DB', detail: 'ZORO-V-ALT-011 · $240' }, { label: '顧客履歴', detail: '過去2回 · 値下げ交渉多' }],
      text: "Hola Tomás! I can meet you in the middle at $220 + shipping — that\u2019s about the best I can do on this one. Let me know!",
      translation: "Tomásさん!このカードは中間の$220 + 送料で対応できます — この商品ではこれが限界です。ご検討ください!",
    },
  },
  {
    id: 'conv12', customerId: 'c12', unread: false, time: '3日前', lastAt: hrs(72), lastInboundAt: hrs(72),
    category: 'intent', preview: "請求書確認しました。Wiseで支払い済みです！", hasDraft: false,
    messages: [
      { id: 'm12-1', from: 'in', text: "請求書確認しました。Wiseで支払い済みです！", time: '3日前', lang: 'ja' },
      { id: 'm12-2', from: 'out', text: "Thanks Aiko! 決済確認できました。明日発送します 📦", time: '3日前' },
    ],
  },
];

const CATEGORY_DIST = [
  { key: 'price', count: 94, pct: 31 },
  { key: 'intent', count: 71, pct: 23 },
  { key: 'detail', count: 58, pct: 19 },
  { key: 'shipping', count: 42, pct: 14 },
  { key: 'stock', count: 28, pct: 9 },
  { key: 'other', count: 12, pct: 4 },
];

window.APP_DATA = { CATEGORIES, CUSTOMERS, CONVERSATIONS, CATEGORY_DIST, avatarColor, initials };
