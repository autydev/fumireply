// Main app shell — routing, state, interactions, Tweaks

const TWEAK_DEFAULTS = /*EDITMODE-BEGIN*/{
  "viewport": "desktop",
  "draftPresentation": "inline",
  "approvalFlow": "edit-send",
  "theme": "light",
  "globalShowTranslation": true
}/*EDITMODE-END*/;

function useToasts() {
  const [toasts, setToasts] = React.useState([]);
  const push = (msg, kind = 'success') => {
    const id = Math.random().toString(36).slice(2);
    setToasts(t => [...t, { id, msg, kind }]);
    setTimeout(() => setToasts(t => t.filter(x => x.id !== id)), 3200);
  };
  return [toasts, push];
}

function Toasts({ toasts }) {
  return (
    <div className="toast-container">
      {toasts.map(t => (
        <div key={t.id} className={`toast ${t.kind}`}>
          <span className="check"><Icon.check size={11} stroke={3}/></span>
          {t.msg}
        </div>
      ))}
    </div>
  );
}

function TweaksPanel({ tweaks, setTweaks, visible }) {
  if (!visible) return null;
  const set = (k, v) => {
    setTweaks(t => ({ ...t, [k]: v }));
    window.parent.postMessage({ type: '__edit_mode_set_keys', edits: { [k]: v } }, '*');
  };
  const Seg = ({ k, options }) => (
    <div className="tweak-segment">
      {options.map(o => (
        <button key={o.v} className={tweaks[k] === o.v ? 'active' : ''} onClick={() => set(k, o.v)}>{o.l}</button>
      ))}
    </div>
  );
  return (
    <div className="tweaks-panel">
      <div className="tweaks-header">
        <div className="tweaks-title">Tweaks</div>
        <Icon.sparkle size={14}/>
      </div>
      <div className="tweaks-body">
        <div className="tweak-group">
          <div className="tweak-label">デバイス</div>
          <Seg k="viewport" options={[{v:'desktop',l:'PC'},{v:'mobile',l:'スマホ'}]}/>
        </div>
        <div className="tweak-group">
          <div className="tweak-label">ドラフト提示方法</div>
          <Seg k="draftPresentation" options={[{v:'inline',l:'インライン'},{v:'side',l:'サイドパネル'},{v:'card',l:'カード'}]}/>
        </div>
        <div className="tweak-group">
          <div className="tweak-label">承認フロー</div>
          <Seg k="approvalFlow" options={[{v:'edit-send',l:'編集→送信'},{v:'one-click',l:'ワンクリック'}]}/>
        </div>
        <div className="tweak-group">
          <div className="tweak-label">英語以外に日本語訳を併記</div>
          <Seg k="globalShowTranslation" options={[{v:true,l:'ON'},{v:false,l:'OFF'}]}/>
        </div>
      </div>
    </div>
  );
}

function SearchOverlay({ open, onClose, conversations, onSelect, onNav }) {
  const [q, setQ] = React.useState('');
  const [focused, setFocused] = React.useState(0);
  const inputRef = React.useRef(null);
  const { CUSTOMERS, CATEGORIES } = window.APP_DATA;

  React.useEffect(() => {
    if (open) {
      setQ('');
      setFocused(0);
      setTimeout(() => inputRef.current?.focus(), 50);
    }
  }, [open]);

  if (!open) return null;

  const query = q.trim().toLowerCase();
  const customerHits = query ? CUSTOMERS.filter(c =>
    c.name.toLowerCase().includes(query) || c.handle.toLowerCase().includes(query) || (c.note || '').toLowerCase().includes(query)
  ).slice(0, 5) : [];
  const messageHits = query ? conversations.flatMap(conv =>
    conv.messages.filter(m => m.text.toLowerCase().includes(query))
      .map(m => ({ conv, msg: m, customer: CUSTOMERS.find(c => c.id === conv.customerId) }))
  ).slice(0, 8) : [];

  const highlight = (text) => {
    if (!query) return text;
    const idx = text.toLowerCase().indexOf(query);
    if (idx < 0) return text;
    return <>
      {text.slice(0, idx)}<mark>{text.slice(idx, idx + query.length)}</mark>{text.slice(idx + query.length)}
    </>;
  };

  return (
    <div className="search-overlay" onClick={onClose}>
      <div className="search-panel" onClick={e => e.stopPropagation()}>
        <div className="search-input">
          <Icon.search/>
          <input ref={inputRef} value={q} onChange={e => setQ(e.target.value)} placeholder="顧客名・メッセージ・メモを検索…"/>
          <span className="kbd">ESC</span>
        </div>
        <div className="search-results">
          {!query && (
            <div className="search-empty">
              <div style={{ fontSize: 13, marginBottom: 4 }}>会話・顧客・メモを全文検索</div>
              <div style={{ fontSize: 11, fontFamily: 'var(--font-mono)', color: 'var(--ink-4)' }}>例: "charizard", "marcus", "wise"</div>
            </div>
          )}
          {query && customerHits.length === 0 && messageHits.length === 0 && (
            <div className="search-empty">結果なし</div>
          )}
          {customerHits.length > 0 && <div className="search-group-label">顧客</div>}
          {customerHits.map((c, i) => (
            <div key={c.id} className="search-result" onClick={() => { onNav('customers'); onClose(); }}>
              <div className="avatar-sm" style={{ background: window.APP_DATA.avatarColor(i) }}>{window.APP_DATA.initials(c.name)}</div>
              <div style={{ minWidth: 0, flex: 1 }}>
                <div className="title">{highlight(c.name)}{c.tags.includes('vip') && <span className="cp-tag vip" style={{ marginLeft: 6, fontSize: 9.5 }}>VIP</span>}</div>
                <div className="snippet">{highlight(c.handle)} · {c.note ? highlight(c.note) : `${c.orders}注文 · $${c.ltv}`}</div>
              </div>
              <span className="meta">{c.country}</span>
            </div>
          ))}
          {messageHits.length > 0 && <div className="search-group-label">メッセージ</div>}
          {messageHits.map((h, i) => (
            <div key={h.conv.id + h.msg.id} className="search-result" onClick={() => { onSelect(h.conv.id); onClose(); }}>
              <div style={{
                width: 30, height: 30, borderRadius: '50%', flexShrink: 0,
                background: window.APP_DATA.avatarColor(h.customer.id.charCodeAt(1)),
                color: 'white', display: 'grid', placeItems: 'center',
                fontSize: 11, fontWeight: 700, letterSpacing: '-0.01em',
              }}>{window.APP_DATA.initials(h.customer.name)}</div>
              <div style={{ minWidth: 0, flex: 1 }}>
                <div className="title">{h.customer.name} <span style={{ fontWeight: 400, color: 'var(--ink-3)', fontSize: 11 }}>· {CATEGORIES[h.conv.category].label}</span></div>
                <div className="snippet">{highlight(h.msg.text)}</div>
              </div>
              <span className="meta">{h.msg.time}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function App() {
  const [tweaks, setTweaks] = React.useState(() => {
    try { return JSON.parse(localStorage.getItem('malbek-tweaks')) || TWEAK_DEFAULTS; }
    catch { return TWEAK_DEFAULTS; }
  });
  React.useEffect(() => { localStorage.setItem('malbek-tweaks', JSON.stringify(tweaks)); }, [tweaks]);

  const [tweaksVisible, setTweaksVisible] = React.useState(false);
  React.useEffect(() => {
    const handler = (e) => {
      if (e.data?.type === '__activate_edit_mode') setTweaksVisible(true);
      if (e.data?.type === '__deactivate_edit_mode') setTweaksVisible(false);
    };
    window.addEventListener('message', handler);
    window.parent.postMessage({ type: '__edit_mode_available' }, '*');
    return () => window.removeEventListener('message', handler);
  }, []);

  const [loggedIn, setLoggedIn] = React.useState(() => {
    return localStorage.getItem('malbek-logged-in') === 'true';
  });
  React.useEffect(() => { localStorage.setItem('malbek-logged-in', loggedIn); }, [loggedIn]);

  const [page, setPage] = React.useState(() => localStorage.getItem('malbek-page') || 'inbox');
  React.useEffect(() => { localStorage.setItem('malbek-page', page); }, [page]);

  const [conversations, setConversations] = React.useState(window.APP_DATA.CONVERSATIONS);
  const [selectedId, setSelectedId] = React.useState(() => localStorage.getItem('malbek-selected') || 'conv1');
  React.useEffect(() => { localStorage.setItem('malbek-selected', selectedId); }, [selectedId]);

  const [filter, setFilter] = React.useState('all');
  const [searchOpen, setSearchOpen] = React.useState(false);
  const [mobileView, setMobileView] = React.useState('inbox'); // 'inbox' | 'thread'
  const [panelDrawer, setPanelDrawer] = React.useState(false);
  const [isNarrow, setIsNarrow] = React.useState(() => window.innerWidth < 1280);
  React.useEffect(() => {
    const on = () => setIsNarrow(window.innerWidth < 1280);
    window.addEventListener('resize', on);
    return () => window.removeEventListener('resize', on);
  }, []);
  const [toasts, pushToast] = useToasts();

  const { CUSTOMERS } = window.APP_DATA;

  const filtered = React.useMemo(() => {
    return conversations.filter(c => {
      if (filter === 'unread') return c.unread;
      if (filter === 'draft') return c.hasDraft;
      if (filter === 'vip') {
        const u = CUSTOMERS.find(cu => cu.id === c.customerId);
        return u?.tags.includes('vip');
      }
      if (filter === 'overdue') {
        const s = window.slaStateFor(c);
        return s === 'overdue' || s === 'warn' || s === 'failed';
      }
      return true;
    });
  }, [conversations, filter]);

  const selected = conversations.find(c => c.id === selectedId);
  const selectedCustomer = selected ? CUSTOMERS.find(u => u.id === selected.customerId) : null;
  const unreadCount = conversations.filter(c => c.unread).length;

  // Simulate new message arrival every 45s
  React.useEffect(() => {
    if (page !== 'inbox') return;
    const iv = setInterval(() => {
      const nextTexts = [
        { cid: 'c10', text: 'Hey, still thinking about that Mewtwo ex I saw 🤔', cat: 'intent' },
        { cid: 'c8',  text: 'Quick Q — do you have any Gengar V Alt in stock?', cat: 'stock' },
        { cid: 'c11', text: 'What\u2019s the price on the Charizard ex Obsidian Flames?', cat: 'price' },
      ];
      const pick = nextTexts[Math.floor(Math.random() * nextTexts.length)];
      setConversations(curr => {
        const existing = curr.find(c => c.customerId === pick.cid);
        if (!existing) return curr;
        const updated = {
          ...existing,
          unread: true,
          time: 'たった今',
          lastAt: Date.now(),
          preview: pick.text,
          isNew: true,
          messages: [...existing.messages, { id: 'new-' + Date.now(), from: 'in', text: pick.text, time: 'now' }],
        };
        return [updated, ...curr.filter(c => c.id !== existing.id)];
      });
      setTimeout(() => {
        setConversations(curr => curr.map(c => c.customerId === pick.cid ? { ...c, isNew: false } : c));
      }, 800);
      pushToast('新着メッセージ · ' + CUSTOMERS.find(u=>u.id===pick.cid).name);
    }, 45000);
    return () => clearInterval(iv);
  }, [page]);

  const handleApprove = (text, meta) => {
    if (!selected) return;
    setConversations(curr => curr.map(c => c.id === selected.id ? {
      ...c,
      unread: false,
      hasDraft: false,
      draft: undefined,
      sendFailed: undefined,
      messages: [...c.messages, { id: 'sent-' + Date.now(), from: 'out', text, time: 'たった今', aiSent: true }],
    } : c));
    if (meta?.feedback === 'up') pushToast('フィードバック記録: 👍 ドラフト良好');
    else if (meta?.feedback === 'down') pushToast('フィードバック記録: 👎 プロンプト改善に使用');
    else pushToast('送信しました → ' + selectedCustomer.name);
  };

  const handleRetry = () => {
    if (!selected) return;
    setConversations(curr => curr.map(c => c.id === selected.id ? { ...c, sendFailed: undefined } : c));
    pushToast('再送を試みています…');
  };

  const handleNoteChange = (customerId, note) => {
    const idx = window.APP_DATA.CUSTOMERS.findIndex(c => c.id === customerId);
    if (idx >= 0) window.APP_DATA.CUSTOMERS[idx].note = note;
  };

  const [customerVersion, setCustomerVersion] = React.useState(0);
  const handleCustomerChange = (customerId, patch) => {
    const idx = window.APP_DATA.CUSTOMERS.findIndex(c => c.id === customerId);
    if (idx >= 0) {
      Object.assign(window.APP_DATA.CUSTOMERS[idx], patch);
      setCustomerVersion(v => v + 1);
    }
  };

  const handleReject = () => {
    if (!selected) return;
    setConversations(curr => curr.map(c => c.id === selected.id ? { ...c, hasDraft: false, draft: undefined } : c));
    pushToast('ドラフトを破棄', 'success');
  };

  const handleSelect = (id) => {
    setSelectedId(id);
    setConversations(curr => curr.map(c => c.id === id ? { ...c, unread: false } : c));
    setMobileView('thread');
  };

  // Keyboard shortcut
  React.useEffect(() => {
    const handler = (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
        if (selected?.draft) {
          handleApprove(selected.draft.text, { edited: false });
          e.preventDefault();
        }
      }
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        setSearchOpen(true);
        e.preventDefault();
      }
      if (e.key === 'Escape') setSearchOpen(false);
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [selected]);

  if (!loggedIn) {
    return <>
      <Login onLogin={() => setLoggedIn(true)}/>
      <TweaksPanel tweaks={tweaks} setTweaks={setTweaks} visible={tweaksVisible}/>
    </>;
  }

  const pageLabels = {
    inbox: '受信トレイ', customers: '顧客管理', products: '商品管理',
    settings: '設定',
  };

  const isMobile = tweaks.viewport === 'mobile';
  const showMobileThread = isMobile && mobileView === 'thread';
  const autoApprove = tweaks.approvalFlow === 'one-click';

  const renderMain = () => {
    if (page === 'inbox') {
      return (
        <>
          <InboxList
            conversations={filtered}
            selectedId={selectedId}
            onSelect={handleSelect}
            activeFilter={filter}
            onFilter={setFilter}
            onOpenSearch={() => setSearchOpen(true)}
          />
          <ThreadView
            conversation={selected}
            customer={selectedCustomer}
            onApprove={handleApprove}
            onReject={handleReject}
            onRetry={handleRetry}
            autoApprove={autoApprove}
            isMobile={isMobile}
            onBack={() => setMobileView('inbox')}
            onTogglePanel={!isMobile && isNarrow ? () => setPanelDrawer(d => !d) : undefined}
            globalShowTranslation={tweaks.globalShowTranslation}
          />
          {!isMobile && !isNarrow && <CustomerPanel customer={selectedCustomer} onNoteChange={handleNoteChange} onCustomerChange={handleCustomerChange}/>}
          {!isMobile && isNarrow && panelDrawer && (
            <>
              <div className="drawer-backdrop" onClick={() => setPanelDrawer(false)}/>
              <div className="customer-panel drawer"><CustomerPanel customer={selectedCustomer} onNoteChange={handleNoteChange} onCustomerChange={handleCustomerChange}/></div>
            </>
          )}
        </>
      );
    }
    if (page === 'customers') return <Customers/>;
    if (page === 'products') return <Products/>;
    if (page === 'settings') return <Settings/>;
    return null;
  };

  return (
    <>
      <div className={`app ${isMobile ? 'mobile' : ''} ${showMobileThread ? 'mobile-thread' : ''}`}>
        {!isMobile && <Sidebar currentPage={page} onNav={(p) => setPage(p)} unreadCount={unreadCount}/>}
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0 }}>
          {!isMobile && <TopBar pageLabel={pageLabels[page]}/>}
          <div style={{ flex: 1, display: 'flex', minHeight: 0, position: 'relative' }}>
            {renderMain()}
          </div>
        </div>
      </div>
      <Toasts toasts={toasts}/>
      <SearchOverlay
        open={searchOpen}
        onClose={() => setSearchOpen(false)}
        conversations={conversations}
        onSelect={handleSelect}
        onNav={setPage}
      />
      <TweaksPanel tweaks={tweaks} setTweaks={setTweaks} visible={tweaksVisible}/>
    </>
  );
}

ReactDOM.createRoot(document.getElementById('root')).render(<App/>);
