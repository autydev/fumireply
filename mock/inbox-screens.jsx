// Inbox + Thread — the primary CS workspace

function Sidebar({ currentPage, onNav, unreadCount }) {
  const navItems = [
    { key: 'inbox', label: '受信トレイ', icon: 'inbox', badge: unreadCount },
    { key: 'customers', label: '顧客管理', icon: 'users' },
    { key: 'products', label: '商品管理', icon: 'package' },
    { key: 'settings', label: '設定', icon: 'settings' },
  ];
  const categoryNav = [
    { key: 'price', color: 'var(--blue)' },
    { key: 'intent', color: 'var(--green)' },
    { key: 'detail', color: 'var(--violet)' },
    { key: 'shipping', color: 'var(--amber)' },
    { key: 'stock', color: 'oklch(0.62 0.15 200)' },
  ];
  return (
    <div className="sidebar">
      <div className="sidebar-brand">
        <div className="brand-mark">M</div>
        <div>
          <div className="brand-name">Malbek CS</div>
          <div className="brand-sub">v0.1.0</div>
        </div>
      </div>

      <div>
        {navItems.map(n => {
          const I = Icon[n.icon];
          return (
            <div key={n.key} className={`nav-item ${currentPage === n.key ? 'active' : ''}`} onClick={() => onNav(n.key)}>
              <I size={15}/>
              <span>{n.label}</span>
              {n.badge ? <span className="badge">{n.badge}</span> : null}
            </div>
          );
        })}
      </div>

      <div className="nav-section-label">カテゴリ</div>
      <div>
        {categoryNav.map(c => {
          const cat = window.APP_DATA.CATEGORIES[c.key];
          return (
            <div key={c.key} className="nav-item" onClick={() => onNav('inbox', c.key)}>
              <span style={{ width: 7, height: 7, borderRadius: '50%', background: c.color, marginLeft: 3, marginRight: 5 }}/>
              <span>{cat.label}</span>
            </div>
          );
        })}
      </div>

      <div className="nav-section-label">チャネル</div>
      <div>
        <div className="nav-item">
          <div style={{ width: 15, height: 15, borderRadius: 3, background: 'var(--fb)', display:'grid', placeItems:'center', color:'white' }}>
            <Icon.fb size={10}/>
          </div>
          <span>Messenger</span>
          <span className="count">186</span>
        </div>
        <div className="nav-item">
          <div style={{ width: 15, height: 15, borderRadius: 4, background: 'linear-gradient(135deg, #feda77 0%, #f58529 25%, #dd2a7b 50%, #8134af 75%, #515bd4 100%)', display:'grid', placeItems:'center' }}>
            <Icon.ig size={9}/>
          </div>
          <span>Instagram</span>
          <span className="count">119</span>
        </div>
      </div>

      <div className="sidebar-footer">
        <div className="user-chip">
          <div className="avatar">YM</div>
          <div className="user-chip-text">
            <div className="user-chip-name">松原 勇太</div>
            <div className="user-chip-email">malbek.co.jp</div>
          </div>
          <Icon.chevronDown size={12}/>
        </div>
      </div>
    </div>
  );
}

// ---------- SLA helpers ----------
function slaStateFor(conv) {
  if (conv.sendFailed) return 'failed';
  if (conv.sla) return conv.sla === 'overdue' ? 'overdue' : 'policy-warn';
  // Unanswered > 2h = warn; > 4h = overdue
  if (!conv.unread) return null;
  const hrs = (Date.now() - conv.lastInboundAt) / 3600000;
  if (hrs >= 4) return 'overdue';
  if (hrs >= 2) return 'warn';
  return null;
}
function formatSlaBadge(state, isVip) {
  if (state === 'failed') return { label: '送信失敗', cls: 'failed' };
  if (state === 'overdue') return { label: isVip ? 'VIP 4h+' : '4h+', cls: 'overdue' };
  if (state === 'warn') return { label: '2h+', cls: 'warn' };
  if (state === 'policy-warn') return { label: '24h迫る', cls: 'warn' };
  return null;
}

function InboxList({ conversations, selectedId, onSelect, activeFilter, onFilter, onOpenSearch }) {
  const { CATEGORIES, CUSTOMERS } = window.APP_DATA;
  const filters = [
    { key: 'all', label: 'すべて', n: conversations.length },
    { key: 'unread', label: '未読', n: conversations.filter(c => c.unread).length },
    { key: 'draft', label: 'ドラフトあり', n: conversations.filter(c => c.hasDraft).length },
    { key: 'vip', label: 'VIP', n: conversations.filter(c => CUSTOMERS.find(u => u.id === c.customerId)?.tags.includes('vip')).length },
    { key: 'overdue', label: '未返信', n: conversations.filter(c => slaStateFor(c) === 'overdue' || slaStateFor(c) === 'warn').length },
  ];

  return (
    <div className="inbox-col">
      <div className="inbox-header">
        <div className="inbox-title-row">
          <div className="inbox-title">受信トレイ</div>
          <div className="inbox-count">{conversations.length} 会話</div>
        </div>
        <div className="search-box" onClick={onOpenSearch} style={{ cursor: 'text' }}>
          <Icon.search/>
          <input
            placeholder="顧客・メッセージを検索…"
            readOnly
            style={{ cursor: 'text' }}
            onFocus={(e) => { e.target.blur(); onOpenSearch(); }}
          />
          <span className="kbd" style={{ position: 'absolute', right: 8, top: '50%', transform: 'translateY(-50%)' }}>⌘K</span>
        </div>
      </div>

      <div className="filter-chips">
        {filters.map(f => (
          <button key={f.key} className={`chip ${activeFilter === f.key ? 'active' : ''}`} onClick={() => onFilter(f.key)}>
            {f.label}<span className="n">{f.n}</span>
          </button>
        ))}
      </div>

      <div className="conv-list">
        {conversations.map((c, i) => {
          const customer = CUSTOMERS.find(u => u.id === c.customerId);
          const sla = slaStateFor(c);
          const isVip = customer.tags.includes('vip');
          const badge = formatSlaBadge(sla, isVip);
          return (
            <div key={c.id}
              className={`conv-item ${c.unread ? 'unread' : ''} ${selectedId === c.id ? 'selected' : ''} ${c.isNew ? 'new-arrival' : ''} ${sla === 'overdue' ? 'overdue' : ''}`}
              onClick={() => onSelect(c.id)}>
              {c.unread && <div className="unread-dot"/>}
              <Avatar name={customer.name} size={36} seed={i} channel={customer.channel}/>
              <div className="conv-body">
                <div className="conv-line1">
                  <span className="conv-name">{customer.name}</span>
                  {isVip && <span className="conv-vip">VIP</span>}
                  <span className="conv-time">{c.time}</span>
                </div>
                <div className="conv-preview">{c.preview}</div>
                <div className="conv-meta">
                  <CategoryTag cat={c.category}/>
                  {c.hasDraft && !c.sendFailed && (
                    <span className="draft-indicator">
                      <span className="pulse"/>AIドラフト
                    </span>
                  )}
                  {badge && <span className={`sla-badge ${badge.cls}`}><Icon.clock size={9}/>{badge.label}</span>}
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function MessageBubble({ msg, customer, isFirst, showTranslation }) {
  if (msg.from === 'in') {
    const hasTranslation = msg.translation && showTranslation;
    return (
      <div className="msg-row">
        {isFirst && <Avatar name={customer.name} size={26} seed={customer.id.charCodeAt(1)}/>}
        {!isFirst && <div style={{ width: 26 }}/>}
        <div>
          <div className="bubble in">
            {msg.text}
            {hasTranslation && (
              <div className="bubble-translation">
                <span className="bubble-translation-label"><Icon.globe size={9}/>日本語訳</span>
                {msg.translation}
              </div>
            )}
          </div>
          <div className="bubble-meta">
            {msg.lang && msg.lang !== 'en' && <span className="lang-tag">{msg.lang.toUpperCase()}</span>}
            {msg.time}
          </div>
        </div>
      </div>
    );
  }
  return (
    <div className="msg-row out">
      <div>
        <div className={`bubble out ${msg.aiSent ? 'ai-sent' : ''}`}>{msg.text}</div>
        <div className="bubble-meta">
          {msg.aiSent && <span className="ai-tag"><Icon.sparkle size={9}/>AI承認済</span>}
          <span>{msg.time}</span>
          <Icon.check size={12} stroke={2}/>
          <Icon.check size={12} stroke={2} style={{ marginLeft: -8 }}/>
        </div>
      </div>
    </div>
  );
}

function ThreadHeader({ customer, onTogglePanel }) {
  return (
    <div className="thread-header">
      <Avatar name={customer.name} size={36} seed={customer.id.charCodeAt(1)} channel={customer.channel}/>
      <div className="thread-customer-info">
        <div className="thread-customer-name">
          {customer.name}
          {customer.tags.includes('vip') && <span className="conv-vip">VIP</span>}
        </div>
        <div className="thread-customer-meta">
          <span>{customer.handle}</span>
          <span className="dot-sep"/>
          <span>{customer.country}</span>
          <span className="dot-sep"/>
          <span>{customer.orders} 注文 · ${customer.ltv.toLocaleString()} LTV</span>
        </div>
      </div>
      <button className="icon-btn"><Icon.star size={16}/></button>
      <button className="icon-btn"><Icon.refresh size={16}/></button>
      {onTogglePanel && <button className="icon-btn" onClick={onTogglePanel} title="顧客情報"><Icon.users size={16}/></button>}
      <button className="icon-btn"><Icon.moreH/></button>
    </div>
  );
}

// 24時間ポリシーのカウントダウン
function PolicyCountdown({ lastInboundAt }) {
  const [now, setNow] = React.useState(Date.now());
  React.useEffect(() => {
    const iv = setInterval(() => setNow(Date.now()), 30000);
    return () => clearInterval(iv);
  }, []);
  const elapsed = (now - lastInboundAt) / 3600000; // hours
  const remaining = 24 - elapsed;
  if (remaining > 6) return null; // show only when <= 6h left
  if (remaining <= 0) {
    return (
      <div className="policy-banner expired">
        <Icon.alertTri/>
        <div>
          <strong>Meta 24時間ポリシー: 送信不可</strong>
          <div style={{ fontSize: 11, marginTop: 2, opacity: 0.85 }}>
            最後のユーザーメッセージから24時間経過しました。Message Tagの使用を検討してください。
          </div>
        </div>
        <span className="countdown">+{Math.abs(remaining).toFixed(1)}h経過</span>
      </div>
    );
  }
  const hrs = Math.floor(remaining);
  const mins = Math.floor((remaining - hrs) * 60);
  return (
    <div className="policy-banner warn">
      <Icon.clock/>
      <div>
        <strong>Meta 24時間ポリシー · 返信期限迫る</strong>
        <span style={{ marginLeft: 6, opacity: 0.85, fontSize: 11 }}>過ぎると標準返信ができなくなります</span>
      </div>
      <span className="countdown spacer-btn">残り {hrs}h {mins}m</span>
    </div>
  );
}

// 送信失敗バナー
function SendFailedBanner({ reason, message, onRetry }) {
  return (
    <div className="send-failed-banner">
      <div className="ico"><Icon.alert size={14}/></div>
      <div style={{ flex: 1 }}>
        <div className="title">送信に失敗しました · {reason}</div>
        <div>{message}</div>
        <div className="actions">
          <button className="btn btn-secondary" onClick={onRetry}><Icon.refresh/>リトライ</button>
          <button className="btn btn-ghost">ログを確認</button>
          <button className="btn btn-ghost">Slackで共有</button>
        </div>
      </div>
    </div>
  );
}

function AutoSavePill({ state }) {
  // state: 'editing' | 'saving' | 'saved'
  if (state === 'saving') return <span className="autosave-pill"><span className="ring"/>保存中…</span>;
  if (state === 'saved') return <span className="autosave-pill saved"><span className="ring"/>下書き保存済</span>;
  return null;
}

function DraftComposer({ conversation, customer, onApprove, onReject, onRetry, autoApprove, globalShowTranslation }) {
  const [text, setText] = React.useState(conversation.draft?.text || '');
  const [edited, setEdited] = React.useState(false);
  const [saveState, setSaveState] = React.useState('saved'); // editing | saving | saved
  const [feedback, setFeedback] = React.useState(null); // 'up' | 'down' | null
  const [showTranslation, setShowTranslation] = React.useState(false);
  const saveTimer = React.useRef(null);

  // 英語以外の顧客 + 設定/顧客別で翻訳デフォルトON
  const draftLang = conversation.draft?.lang || customer?.language || 'en';
  const translationEligible = draftLang !== 'en' || (conversation.draft?.translation && (globalShowTranslation || customer?.translationDefault));

  React.useEffect(() => {
    setText(conversation.draft?.text || '');
    setEdited(false);
    setSaveState('saved');
    setFeedback(null);
    // 初期表示: 英語以外 → 常に表示、英語 → グローバル/顧客別設定に従う
    const d = conversation.draft;
    if (!d) { setShowTranslation(false); return; }
    const nonEng = (d.lang || customer?.language || 'en') !== 'en';
    if (nonEng) setShowTranslation(true);
    else setShowTranslation(!!customer?.translationDefault || !!globalShowTranslation);
  }, [conversation.id, customer?.id, globalShowTranslation]);

  React.useEffect(() => {
    return () => clearTimeout(saveTimer.current);
  }, []);

  const onChange = (v) => {
    setText(v);
    setEdited(v !== (conversation.draft?.text || ''));
    setSaveState('editing');
    clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      setSaveState('saving');
      setTimeout(() => setSaveState('saved'), 450);
    }, 600);
  };

  if (!conversation.draft) {
    return (
      <div className="draft-composer">
        <div style={{
          display: 'flex', alignItems: 'center', gap: 10,
          background: 'var(--bg-sunken)', borderRadius: 12, padding: '10px 14px',
          border: '1px solid var(--line)'
        }}>
          <input
            placeholder="メッセージを入力…"
            style={{ flex: 1, border: 'none', background: 'transparent', outline: 'none', fontSize: 14 }}
          />
          <button className="btn btn-ghost"><Icon.sparkle size={14}/>AIでドラフト生成</button>
          <button className="btn btn-primary"><Icon.send/>送信</button>
        </div>
      </div>
    );
  }

  const d = conversation.draft;
  const confClass = d.confidence > 0.85 ? '' : d.confidence > 0.7 ? 'med' : 'low';
  const policyExpired = (Date.now() - conversation.lastInboundAt) / 3600000 >= 24;

  return (
    <div className="draft-composer">
      {conversation.sendFailed && (
        <SendFailedBanner reason={conversation.sendFailed.reason} message={conversation.sendFailed.message} onRetry={onRetry}/>
      )}
      <div className="draft-card">
        <div className="draft-header">
          <span className="draft-badge">
            <Icon.sparkle/>Claude ドラフト
          </span>
          <CategoryTag cat={d.category}/>
          <span className="confidence-meter">
            信頼度
            <span className="confidence-bar"><span className={`confidence-bar-fill ${confClass}`} style={{ width: `${d.confidence*100}%` }}/></span>
            <span style={{ fontWeight: 600, color: 'var(--ink)' }}>{Math.round(d.confidence*100)}%</span>
          </span>

          <div className="feedback-row" title="今後のプロンプト改善に使用">
            <button
              className={`fb-btn up ${feedback === 'up' ? 'active' : ''}`}
              onClick={() => setFeedback(feedback === 'up' ? null : 'up')}
              title="このドラフトは良い"
            ><Icon.thumbUp/></button>
            <button
              className={`fb-btn down ${feedback === 'down' ? 'active' : ''}`}
              onClick={() => setFeedback(feedback === 'down' ? null : 'down')}
              title="このドラフトは悪い"
            ><Icon.thumbDown/></button>
          </div>

          <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 8 }}>
            {conversation.draft.translation && (
              <button
                className={`translation-toggle-btn ${showTranslation ? 'active' : ''}`}
                onClick={() => setShowTranslation(v => !v)}
                title="日本語訳の表示切替"
              >
                <Icon.globe size={11}/>訳
              </button>
            )}
            {edited && <AutoSavePill state={saveState}/>}
          </div>
        </div>

        <div className="draft-reasoning">
          <strong>なぜこの返信？ </strong>{d.reasoning}
        </div>

        {d.sources && d.sources.length > 0 && (
          <div className="source-chips">
            {d.sources.map((s, i) => (
              <span key={i} className="source-chip">
                <span className="lbl">{s.label}</span>
                <span>{s.detail}</span>
              </span>
            ))}
          </div>
        )}

        <textarea
          className="draft-textarea"
          value={text}
          onChange={e => onChange(e.target.value)}
          rows={3}
          disabled={policyExpired}
        />

        {showTranslation && d.translation && (
          <div className="translation-panel">
            <div className="label"><Icon.globe size={10}/>日本語訳 · 内容確認用</div>
            {d.translation}
          </div>
        )}

        <div className="draft-actions">
          {autoApprove && !policyExpired ? (
            <>
              <button className="btn btn-ghost" onClick={onReject}>
                <Icon.x/>破棄
              </button>
              <button className="btn btn-secondary">
                <Icon.edit/>編集
              </button>
              <div className="spacer"/>
              <span style={{ fontSize: 11, color: 'var(--ink-3)', marginRight: 6, fontFamily: 'var(--font-mono)' }}>ワンクリック承認</span>
              <button className="btn btn-primary" onClick={() => onApprove(text, { feedback, edited })}>
                <Icon.check size={14}/>承認して送信
                <span className="kbd" style={{ background: 'rgba(255,255,255,0.2)', color: 'white', border: '1px solid rgba(255,255,255,0.3)', marginLeft: 4 }}>⌘↵</span>
              </button>
            </>
          ) : (
            <>
              <button className="btn btn-ghost" onClick={onReject}><Icon.x/>破棄</button>
              <button className="btn btn-ghost"><Icon.sparkle size={13}/>再生成</button>
              <button className="btn btn-ghost" disabled style={{ opacity: 0.55, cursor: 'not-allowed' }}><Icon.link/>請求リンク挿入<span className="phase-tag" style={{ marginLeft: 6, fontSize: 9.5, padding: '1px 5px', borderRadius: 3, background: 'var(--bg-sunken)', color: 'var(--ink-3)', fontFamily: 'var(--font-mono)', letterSpacing: '0.04em', fontWeight: 700 }}>PHASE 2</span></button>
              <div className="spacer"/>
              <button
                className="btn btn-primary"
                onClick={() => onApprove(text, { feedback, edited })}
                disabled={policyExpired}
                style={policyExpired ? { opacity: 0.4, cursor: 'not-allowed' } : {}}
              >
                <Icon.send/>送信
                <span className="kbd" style={{ background: 'rgba(255,255,255,0.2)', color: 'white', border: '1px solid rgba(255,255,255,0.3)', marginLeft: 4 }}>⌘↵</span>
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

const LANG_LABEL = { en: 'EN', ja: 'JA', es: 'ES' };
const PRIORITY_LABEL = { normal: '通常', caution: '要注意', block: 'ブロック' };
const PAYMENT_LABEL = { wise: 'Wise', paypal: 'PayPal', '': '未設定' };

function CustomerPanel({ customer, onNoteChange, onCustomerChange }) {
  const [noteValue, setNoteValue] = React.useState(customer?.note || '');
  const [noteState, setNoteState] = React.useState('saved');
  const saveTimer = React.useRef(null);

  // AI指示のローカルステート
  const [tone, setTone] = React.useState(customer?.tonePreset || 'friendly');
  const [lang, setLang] = React.useState(customer?.language || 'en');
  const [customPrompt, setCustomPrompt] = React.useState(customer?.customPrompt || '');
  const [translationPref, setTranslationPref] = React.useState(customer?.translationDefault ?? false);
  const [promptState, setPromptState] = React.useState('saved');
  const promptTimer = React.useRef(null);

  React.useEffect(() => {
    setNoteValue(customer?.note || '');
    setNoteState('saved');
    setTone(customer?.tonePreset || 'friendly');
    setLang(customer?.language || 'en');
    setCustomPrompt(customer?.customPrompt || '');
    setTranslationPref(customer?.translationDefault ?? false);
    setPromptState('saved');
  }, [customer?.id]);

  const commitInstruction = (field, value) => {
    setPromptState('editing');
    clearTimeout(promptTimer.current);
    promptTimer.current = setTimeout(() => {
      setPromptState('saving');
      setTimeout(() => {
        setPromptState('saved');
        onCustomerChange?.(customer.id, { [field]: value });
      }, 300);
    }, 500);
  };

  const onNote = (v) => {
    setNoteValue(v);
    setNoteState('editing');
    clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      setNoteState('saving');
      setTimeout(() => {
        setNoteState('saved');
        onNoteChange?.(customer.id, v);
      }, 400);
    }, 700);
  };

  const purchases = [
    { title: 'Charizard VMAX Rainbow Rare', date: '2026-03-18', price: 420 },
    { title: 'Pikachu VMAX (HR)', date: '2026-01-02', price: 310 },
    { title: 'Mew EX Special Set', date: '2025-10-14', price: 580 },
  ];

  if (!customer) return null;

  return (
    <div className="customer-panel">
      <div className="cp-customer-card">
        <div className="cp-customer-top">
          <div className="cp-big-avatar" style={{ background: window.APP_DATA.avatarColor(customer.id.charCodeAt(1)) }}>
            {window.APP_DATA.initials(customer.name)}
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div className="cp-customer-name">{customer.name}</div>
            <div className="cp-customer-handle">{customer.handle}</div>
            <div className="cp-tags" style={{ marginTop: 6 }}>
              {customer.tags.includes('vip') && <span className="cp-tag vip">⭐ VIP</span>}
              {customer.tags.includes('repeat') && <span className="cp-tag repeat">リピーター</span>}
              {customer.tags.includes('new') && <span className="cp-tag new">新規</span>}
              {customer.priority === 'caution' && <span className="cp-tag" style={{ color: 'var(--amber-ink)', background: 'var(--amber-soft)', borderColor: 'oklch(0.78 0.13 75 / 0.3)' }}>要注意</span>}
            </div>
          </div>
        </div>
        <div className="cp-stats">
          <div className="cp-stat">
            <div className="cp-stat-label">注文</div>
            <div className="cp-stat-value">{customer.orders}</div>
          </div>
          <div className="cp-stat">
            <div className="cp-stat-label">LTV</div>
            <div className="cp-stat-value">${customer.ltv.toLocaleString()}</div>
          </div>
          <div className="cp-stat">
            <div className="cp-stat-label">平均注文</div>
            <div className="cp-stat-value">${customer.avgOrder || 0}</div>
          </div>
          <div className="cp-stat">
            <div className="cp-stat-label">初回</div>
            <div className="cp-stat-value" style={{ fontSize: 12 }}>{customer.firstSeen}</div>
          </div>
        </div>
      </div>

      <div className="cp-section-label">プロフィール</div>
      <div style={{ background: 'var(--bg-raised)', border: '1px solid var(--line)', borderRadius: 10, padding: '2px 12px' }}>
        <div className="cp-meta-row">
          <span className="k">最新問い合わせ</span>
          <span className="v">{customer.lastContactAt || '—'}</span>
        </div>
        <div className="cp-meta-row">
          <span className="k">対応言語</span>
          <span className="v"><span className="lang-pill">{LANG_LABEL[customer.language] || customer.language}</span></span>
        </div>
        <div className="cp-meta-row">
          <span className="k">決済方法</span>
          <span className="v">{PAYMENT_LABEL[customer.payment] ?? customer.payment}</span>
        </div>
        <div className="cp-meta-row">
          <span className="k">優先度</span>
          <span className="v">
            <span className={`priority-dot ${customer.priority || 'normal'}`}/>
            {PRIORITY_LABEL[customer.priority || 'normal']}
          </span>
        </div>
        <div className="cp-meta-row">
          <span className="k">国 / 地域</span>
          <span className="v">{customer.country}</span>
        </div>
      </div>

      <div className="cp-section-label">
        AIドラフト設定
        <AutoSavePill state={promptState === 'editing' ? null : promptState}/>
      </div>
      <div className="ai-instructions-card">
        <div className="ai-inst-row">
          <Icon.sparkle size={11}/>トーン
        </div>
        <div className="tone-segment">
          <button className={tone === 'friendly' ? 'active' : ''} onClick={() => { setTone('friendly'); commitInstruction('tonePreset', 'friendly'); }}>フランク</button>
          <button className={tone === 'professional' ? 'active' : ''} onClick={() => { setTone('professional'); commitInstruction('tonePreset', 'professional'); }}>プロ</button>
          <button className={tone === 'concise' ? 'active' : ''} onClick={() => { setTone('concise'); commitInstruction('tonePreset', 'concise'); }}>簡潔</button>
        </div>

        <div className="ai-inst-row">カスタム指示</div>
        <textarea
          className="ai-prompt-textarea"
          value={customPrompt}
          onChange={e => { setCustomPrompt(e.target.value); commitInstruction('customPrompt', e.target.value); }}
          placeholder="例: ファーストネーム呼び捨てOK / 値下げ上限-10% / 返信は英語で固定 / 絵文字なし"
        />
        <div style={{ fontSize: 10.5, color: 'var(--ink-4)', marginTop: 6, lineHeight: 1.45 }}>
          返信言語は受信から自動判定。固定したい場合はカスタム指示に記載。
        </div>

        {customer?.language !== 'en' && (
          <div className="translation-pref-row">
            <span style={{ color: 'var(--ink-2)', display: 'inline-flex', alignItems: 'center', gap: 5 }}>
              <Icon.globe size={11}/>日本語訳を併記(受信・返信)
            </span>
            <div
              className={`toggle ${translationPref ? 'on' : ''}`}
              style={{ width: 32, height: 18 }}
              onClick={() => { const v = !translationPref; setTranslationPref(v); commitInstruction('translationDefault', v); }}
            />
          </div>
        )}
      </div>

      <div className="cp-section-label">
        メモ
        <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <AutoSavePill state={noteState === 'editing' ? null : noteState}/>
        </span>
      </div>
      <div className="cp-note">
        <textarea
          className="cp-note-textarea"
          value={noteValue}
          onChange={e => onNote(e.target.value)}
          placeholder="この顧客についての内部メモ…&#10;例: 好みの商品カテゴリ、交渉スタイル、注意点など"
        />
      </div>

      {customer.orders > 0 && (
        <>
          <div className="cp-section-label">購入履歴<span className="more">すべて見る</span></div>
          {purchases.slice(0, Math.min(3, customer.orders)).map((p, i) => (
            <div key={i} className="cp-purchase">
              <div className="cp-purchase-title">{p.title}</div>
              <div className="cp-purchase-meta">
                <span>{p.date}</span>
                <span>${p.price}</span>
              </div>
            </div>
          ))}
        </>
      )}

      <div className="cp-section-label">クイックアクション</div>
      <button className="quick-action-btn" disabled>
        <Icon.link size={13}/>Wise請求リンクを作成
        <span className="phase-tag">PHASE 2</span>
      </button>
      <button className="quick-action-btn" disabled>
        <Icon.package size={13}/>追跡番号を送信
        <span className="phase-tag">PHASE 2</span>
      </button>
      <button className="btn btn-secondary" style={{ width: '100%', justifyContent: 'center', marginTop: 4 }}>
        <Icon.plus/>VIPタグを{customer.tags.includes('vip') ? '外す' : '追加'}
      </button>
    </div>
  );
}

function ThreadView({ conversation, customer, onApprove, onReject, onRetry, autoApprove, isMobile, onBack, onTogglePanel, onNoteChange, globalShowTranslation }) {
  const messagesRef = React.useRef(null);
  React.useEffect(() => {
    if (messagesRef.current) {
      messagesRef.current.scrollTop = messagesRef.current.scrollHeight;
    }
  }, [conversation?.id, conversation?.messages.length]);

  if (!conversation) {
    return <div className="thread-col"><div className="empty">会話を選択してください</div></div>;
  }

  // 受信メッセージの翻訳表示: グローバル設定 OR 顧客個別設定がONならON
  // (個々のメッセージに lang フィールドがあり、'en'以外なら翻訳表示)
  const showInboundTranslation = (customer?.translationDefault) || globalShowTranslation;

  return (
    <div className="thread-col">
      {isMobile && (
        <div style={{ padding: '8px 12px', borderBottom: '1px solid var(--line)', background: 'var(--bg-raised)' }}>
          <button className="btn btn-ghost" onClick={onBack}><Icon.chevronLeft/>受信トレイへ</button>
        </div>
      )}
      <ThreadHeader customer={customer} onTogglePanel={onTogglePanel}/>
      <PolicyCountdown lastInboundAt={conversation.lastInboundAt}/>
      <div className="messages" ref={messagesRef}>
        <div className="date-divider">2026年4月18日</div>
        {conversation.messages.map((m, i) => {
          const prev = conversation.messages[i - 1];
          const isFirst = !prev || prev.from !== m.from;
          return <MessageBubble key={m.id} msg={m} customer={customer} isFirst={isFirst} showTranslation={showInboundTranslation}/>;
        })}
      </div>
      <DraftComposer
        conversation={conversation}
        customer={customer}
        onApprove={onApprove}
        onReject={onReject}
        onRetry={onRetry}
        autoApprove={autoApprove}
        globalShowTranslation={globalShowTranslation}
      />
    </div>
  );
}

Object.assign(window, { Sidebar, InboxList, ThreadView, CustomerPanel, slaStateFor });
