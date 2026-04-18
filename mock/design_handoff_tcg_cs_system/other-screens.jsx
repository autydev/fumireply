// Other screens: Dashboard, Customers, Settings, Products, Login

function TopBar({ pageLabel, liveMode, onToggleLive }) {
  return (
    <div className="topbar">
      <div className="topbar-crumbs">
        <span>Malbek CS</span>
        <Icon.chevronRight size={12}/>
        <strong>{pageLabel}</strong>
      </div>
      <div className="live-pill">
        <span className="dot"/>
        LIVE · 30秒ポーリング
      </div>
    </div>
  );
}

/* ============== Dashboard ============== */
function Dashboard() {
  const { CATEGORIES, CATEGORY_DIST } = window.APP_DATA;
  const catColor = { price: 'var(--blue)', intent: 'var(--green)', detail: 'var(--violet)', shipping: 'var(--amber)', stock: 'oklch(0.62 0.15 200)', other: 'var(--ink-3)' };

  const kpis = [
    { label: 'メッセージ数 (今月)', value: '305', delta: '+12% vs 先月' },
    { label: '平均応答時間', value: '4.2分', delta: '-68% vs 先月' },
    { label: '対応時間 (月)', value: '3.1h', delta: '目標 3h を達成' },
    { label: '自動化率', value: '87%', delta: '+4% vs 先週' },
  ];

  return (
    <div className="dashboard-shell">
      <div className="dash-title-row">
        <div>
          <div className="dash-title">ダッシュボード</div>
          <div className="dash-sub">過去30日間 · 2026-03-19 → 2026-04-18</div>
        </div>
        <button className="btn btn-secondary">
          期間: 過去30日<Icon.chevronDown/>
        </button>
      </div>

      <div className="kpi-grid">
        {kpis.map((k, i) => (
          <div key={i} className="kpi-card">
            <div className="kpi-label">{k.label}</div>
            <div className="kpi-value">{k.value}</div>
            <div className="kpi-delta">{k.delta}</div>
          </div>
        ))}
      </div>

      <div className="dash-card">
        <div className="dash-card-title">
          カテゴリ分布
          <span className="sub">{CATEGORY_DIST.reduce((s, c) => s + c.count, 0)}件</span>
        </div>
        {CATEGORY_DIST.map(c => (
          <div key={c.key} className="bar-row">
            <div className="bar-label">
              <span className="category-tag" style={{ padding: '1px 7px', fontSize: 10.5 }}>
                <span style={{ width: 6, height: 6, borderRadius: '50%', background: catColor[c.key], display: 'inline-block', marginRight: 3 }}/>
                {CATEGORIES[c.key].label}
              </span>
            </div>
            <div className="bar-track">
              <div className="bar-fill" style={{ width: `${c.pct * 2.5}%`, background: catColor[c.key] }}/>
            </div>
            <div className="bar-val">{c.count}</div>
          </div>
        ))}
      </div>

      <div className="dash-card">
        <div className="dash-card-title">AIドラフト承認の内訳<span className="sub">先週</span></div>
        <div style={{ display: 'flex', gap: 14 }}>
          {[
            { label: 'そのまま承認', n: 156, pct: 51, color: 'var(--green)' },
            { label: '軽微な編集後', n: 89, pct: 29, color: 'var(--primary)' },
            { label: '大幅に編集', n: 42, pct: 14, color: 'var(--amber)' },
            { label: '破棄・手動返信', n: 18, pct: 6, color: 'var(--rose)' },
          ].map((s, i) => (
            <div key={i} style={{ flex: 1, padding: 14, borderRadius: 10, background: 'var(--bg-sunken)', border: '1px solid var(--line)' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
                <span style={{ width: 8, height: 8, borderRadius: '50%', background: s.color }}/>
                <span style={{ fontSize: 11.5, fontWeight: 600, color: 'var(--ink-2)' }}>{s.label}</span>
              </div>
              <div style={{ fontSize: 22, fontWeight: 800, letterSpacing: '-0.02em' }}>{s.n}<span style={{ fontSize: 12, color: 'var(--ink-3)', fontFamily: 'var(--font-mono)', fontWeight: 500, marginLeft: 4 }}>/ {s.pct}%</span></div>
              <div style={{ height: 4, background: 'var(--line)', borderRadius: 2, marginTop: 8, overflow: 'hidden' }}>
                <div style={{ height: '100%', width: `${s.pct}%`, background: s.color, borderRadius: 2 }}/>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

/* ============== Customers ============== */
function Customers() {
  const { CUSTOMERS, CATEGORIES, avatarColor, initials } = window.APP_DATA;
  const sorted = React.useMemo(() => {
    return [...CUSTOMERS].sort((a, b) => (b.lastContactTs || 0) - (a.lastContactTs || 0));
  }, [CUSTOMERS]);
  return (
    <div className="customers-shell">
      <div className="dash-title-row">
        <div>
          <div className="dash-title">顧客管理</div>
          <div className="dash-sub">{CUSTOMERS.length}人 · 過去12ヶ月</div>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <div className="search-box" style={{ width: 280 }}>
            <Icon.search/>
            <input placeholder="顧客を検索…"/>
          </div>
          <button className="btn btn-secondary"><Icon.filter/>フィルタ</button>
          <button className="btn btn-primary"><Icon.plus/>追加</button>
        </div>
      </div>

      <div className="cust-table">
        <div className="cust-row header extended">
          <div>顧客</div>
          <div>チャネル</div>
          <div>言語</div>
          <div>注文数</div>
          <div>LTV</div>
          <div>最新問い合わせ</div>
          <div>メモ</div>
          <div></div>
        </div>
        {sorted.map((c, i) => {
          const LANG = { en: 'EN', ja: 'JA', es: 'ES' };
          return (
          <div key={c.id} className="cust-row extended">
            <div className="cust-name-cell">
              <div className="avatar-sm" style={{ background: avatarColor(i) }}>{initials(c.name)}</div>
              <div style={{ minWidth: 0 }}>
                <div className="name">
                  <span className={`priority-dot ${c.priority || 'normal'}`}/>
                  {c.name}
                  {c.tags.includes('vip') && <span className="cp-tag vip" style={{ marginLeft: 6, fontSize: 9.5, padding: '0 5px' }}>VIP</span>}
                </div>
                <div className="handle">{c.handle} · {c.country}</div>
              </div>
            </div>
            <div>
              {c.channel === 'fb' ? (
                <span style={{ display:'inline-flex', alignItems:'center', gap:5, fontSize:11.5 }}>
                  <span style={{ color: 'var(--fb)' }}><Icon.fb size={13}/></span>MSG
                </span>
              ) : (
                <span style={{ display:'inline-flex', alignItems:'center', gap:5, fontSize:11.5 }}>
                  <span style={{ width: 13, height: 13, borderRadius: 3, background: 'linear-gradient(135deg, #feda77 0%, #f58529 25%, #dd2a7b 50%, #8134af 75%, #515bd4 100%)', display:'inline-grid', placeItems:'center' }}><Icon.ig size={8}/></span>IG
                </span>
              )}
            </div>
            <div><span className="lang-pill">{LANG[c.language] || c.language}</span></div>
            <div style={{ fontFamily: 'var(--font-mono)', fontSize: 12.5 }}>{c.orders}</div>
            <div style={{ fontFamily: 'var(--font-mono)', fontSize: 12.5, fontWeight: 600 }}>${c.ltv.toLocaleString()}</div>
            <div style={{ fontSize: 11.5, color: 'var(--ink-3)', fontFamily: 'var(--font-mono)' }}>{c.lastContactAt || '—'}</div>
            <div style={{
              fontSize: 11, color: c.note ? 'var(--ink-2)' : 'var(--ink-4)',
              overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
              fontStyle: c.note ? 'normal' : 'italic',
            }}>{c.note || 'メモなし'}</div>
            <div><Icon.chevronRight/></div>
          </div>
        );})}
      </div>
    </div>
  );
}

/* ============== Settings ============== */
function Settings() {
  const [slackOn, setSlackOn] = React.useState(true);
  const [autoApprove, setAutoApprove] = React.useState(false);
  const [igOn, setIgOn] = React.useState(true);
  const [fbOn, setFbOn] = React.useState(true);
  const [quietHours, setQuietHours] = React.useState(false);
  const [globalTranslation, setGlobalTranslation] = React.useState(true);

  return (
    <div className="settings-shell">
      <div className="dash-title-row">
        <div>
          <div className="dash-title">設定</div>
          <div className="dash-sub">tenant: malbek-main · 最終保存 2分前</div>
        </div>
      </div>

      <div className="settings-section">
        <div className="settings-h">チャネル接続</div>
        <div className="settings-row">
          <div className="left">
            <div className="title" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{ color: 'var(--fb)' }}><Icon.fb size={16}/></span>
              Facebook Messenger
              <span className="cp-tag repeat">接続済</span>
            </div>
            <div className="desc">Malbek TCG Shop ページ · Meta Business Verified</div>
          </div>
          <div className="toggle on" onClick={() => setFbOn(!fbOn)}/>
        </div>
        <div className="settings-row">
          <div className="left">
            <div className="title" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{ width: 16, height: 16, borderRadius: 4, background: 'linear-gradient(135deg, #feda77 0%, #f58529 25%, #dd2a7b 50%, #8134af 75%, #515bd4 100%)', display: 'inline-grid', placeItems: 'center' }}><Icon.ig size={10}/></span>
              Instagram DM
              <span className="cp-tag repeat">接続済</span>
            </div>
            <div className="desc">@malbek.tcg · 承認済み権限: instagram_manage_messages</div>
          </div>
          <div className={`toggle ${igOn ? 'on' : ''}`} onClick={() => setIgOn(!igOn)}/>
        </div>
        <div className="settings-row">
          <div className="left">
            <div className="title" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <Icon.slack/>Slack Incoming Webhook
              <span className="cp-tag repeat">接続済</span>
            </div>
            <div className="desc">#cs-inbox に新着通知を送信 · v2でBlock Kit承認ボタンを追加予定</div>
          </div>
          <div className={`toggle ${slackOn ? 'on' : ''}`} onClick={() => setSlackOn(!slackOn)}/>
        </div>
      </div>

      <div className="settings-section">
        <div className="settings-h">AIドラフト</div>
        <div className="settings-row" style={{ flexDirection: 'column', alignItems: 'stretch', gap: 12 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
            <div className="left">
              <div className="title">カスタムプロンプト</div>
              <div className="desc">Claudeに送る分類 + ドラフト生成の指示</div>
            </div>
            <span className="cp-tag repeat">テナント別</span>
          </div>
          <textarea
            style={{
              width: '100%', minHeight: 140, padding: 12,
              border: '1px solid var(--line)', borderRadius: 10,
              fontFamily: 'var(--font-mono)', fontSize: 12, lineHeight: 1.5,
              background: 'var(--bg-sunken)', outline: 'none', resize: 'vertical',
              color: 'var(--ink)',
            }}
            defaultValue={`You are a customer service assistant for Malbek TCG Shop, a Japanese Pokémon card seller.
- Reply in the language of the incoming message (default English).
- Be warm but concise. Max 3 sentences.
- Cite prices from the product DB in USD.
- Offer Wise invoice for repeat customers, PayPal for new ones.
- For shipping questions, reference the latest tracking number if available.
- If uncertain, flag for human review (confidence < 0.7).`}
          />
        </div>
        <div className="settings-row">
          <div className="left">
            <div className="title">英語以外の返信に日本語訳を併記</div>
            <div className="desc">受信が英語以外(es/it/ja等)のときAIが日本語訳も自動生成 · 顧客ごとに個別オーバーライド可</div>
          </div>
          <div className={`toggle ${globalTranslation ? 'on' : ''}`} onClick={() => setGlobalTranslation(!globalTranslation)}/>
        </div>
        <div className="settings-row">
          <div className="left">
            <div className="title">ワンクリック承認モード</div>
            <div className="desc">信頼度90%以上かつ価格・追跡カテゴリのドラフトは承認ボタン1つで即送信</div>
          </div>
          <div className={`toggle ${autoApprove ? 'on' : ''}`} onClick={() => setAutoApprove(!autoApprove)}/>
        </div>
        <div className="settings-row">
          <div className="left">
            <div className="title">ナイトモード (送信停止)</div>
            <div className="desc">22:00 - 7:00 JST はドラフト生成のみ、送信は翌朝まで保留</div>
          </div>
          <div className={`toggle ${quietHours ? 'on' : ''}`} onClick={() => setQuietHours(!quietHours)}/>
        </div>
      </div>

      <div className="settings-section">
        <div className="settings-h">インフラ</div>
        <div className="settings-row">
          <div className="left">
            <div className="title" style={{ fontFamily: 'var(--font-mono)', fontSize: 12.5 }}>AWS ap-northeast-1</div>
            <div className="desc">Webhook Lambda · 分類 Lambda · TanStack Start Lambda · RDS Postgres db.t4g.micro</div>
          </div>
          <span className="cp-tag repeat">healthy</span>
        </div>
      </div>
    </div>
  );
}

/* ============== Products — Phase 2 placeholder ============== */
function Products() {
  return (
    <div className="placeholder-shell">
      <div className="placeholder-card">
        <div className="placeholder-icon"><Icon.package size={26}/></div>
        <div className="placeholder-phase-label">PHASE 2 · 未実装</div>
        <div className="placeholder-title" style={{ marginTop: 12 }}>商品管理はまだUIを作りません</div>
        <div className="placeholder-desc">
          商品マスタは現状スプレッドシート + LINE仕入れ情報に分散しており、
          Phase 2で Shopify API へ統合する予定です。MVPではUIを作らず、
          既存のデータソースへのリンクで十分と判断しました。
        </div>
        <div className="placeholder-source-list">
          <div className="placeholder-source-item">
            <span className="dot" style={{ background: 'var(--green)' }}/>
            <Icon.link size={12}/>
            <span style={{ fontFamily: 'var(--font-mono)', fontSize: 12 }}>価格表 (Google Sheet)</span>
            <span style={{ marginLeft: 'auto', fontSize: 10.5, color: 'var(--ink-3)', fontFamily: 'var(--font-mono)' }}>最終更新 · 2h前</span>
          </div>
          <div className="placeholder-source-item">
            <span className="dot" style={{ background: 'var(--primary)' }}/>
            <Icon.link size={12}/>
            <span style={{ fontFamily: 'var(--font-mono)', fontSize: 12 }}>在庫DB (Google Sheet)</span>
            <span style={{ marginLeft: 'auto', fontSize: 10.5, color: 'var(--ink-3)', fontFamily: 'var(--font-mono)' }}>32 SKU</span>
          </div>
          <div className="placeholder-source-item">
            <span className="dot" style={{ background: 'var(--amber)' }}/>
            <Icon.link size={12}/>
            <span style={{ fontFamily: 'var(--font-mono)', fontSize: 12 }}>LINE仕入れ情報</span>
            <span style={{ marginLeft: 'auto', fontSize: 10.5, color: 'var(--ink-3)', fontFamily: 'var(--font-mono)' }}>手動参照</span>
          </div>
        </div>
        <div style={{ marginTop: 20, fontSize: 11.5, color: 'var(--ink-3)', fontFamily: 'var(--font-mono)' }}>
          Phase 2: Shopify API + 統合商品DB + 自動同期
        </div>
      </div>
    </div>
  );
}

/* ============== Login ============== */
function Login({ onLogin }) {
  return (
    <div className="login-shell">
      <div className="login-card">
        <div className="login-brand">
          <div className="brand-mark">M</div>
        </div>
        <div className="login-title">Malbek CS</div>
        <div className="login-sub">Messenger + Instagram DM を半自動で。</div>

        <div className="login-field">
          <label>メールアドレス</label>
          <input type="email" defaultValue="yuta@malbek.co.jp"/>
        </div>
        <div className="login-field">
          <label>パスワード</label>
          <input type="password" defaultValue="••••••••••••"/>
        </div>
        <button className="login-submit" onClick={onLogin}>ログイン</button>

        <div className="login-divider">または</div>

        <button className="login-oauth" onClick={onLogin}>
          <Icon.fb size={14}/>Meta Business アカウントで続行
        </button>

        <div style={{ textAlign: 'center', fontSize: 11, color: 'var(--ink-3)', marginTop: 18, fontFamily: 'var(--font-mono)' }}>
          Amazon Cognito · Meta OAuth Provider
        </div>
      </div>
    </div>
  );
}

Object.assign(window, { TopBar, Dashboard, Customers, Settings, Products, Login });
