/* NA5TY player site. Talks to the same APIs the old dashboard used; Kick Points come from the city (op_rewards). */
(() => {
  'use strict';
  const $ = (s, r = document) => r.querySelector(s);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const ic = (n) => (window.ICONS && window.ICONS[n] ? `<svg class="i" viewBox="0 0 24 24">${window.ICONS[n]}</svg>` : '');
  const fmt = (n) => Number(n || 0).toLocaleString('en-US');
  const hue = (name) => { let h = 0; for (const c of String(name || '?')) h = (h * 31 + c.charCodeAt(0)) % 360; return h; };
  const keyImg = (a) => `/site/art/keys/${a}.webp`;

  const S = { me: null, partners: [], watch: null, chatTimer: null, words: [], tab: null, points: null, check: {} };

  async function api(path, opts = {}) {
    try {
      const r = await fetch(path, { credentials: 'same-origin', headers: opts.body ? { 'Content-Type': 'application/json' } : {}, ...opts, body: opts.body ? JSON.stringify(opts.body) : undefined });
      const data = await r.json().catch(() => ({}));
      return { ok: r.ok && data.success !== false, status: r.status, data };
    } catch (e) { return { ok: false, status: 0, data: { error: 'Network error' } }; }
  }
  function toast(text, type = '') {
    const el = document.createElement('div');
    el.className = `toast ${type}`; el.textContent = text;
    $('#toasts').appendChild(el); setTimeout(() => el.remove(), 3800);
  }
  async function copy(text) {
    try { await navigator.clipboard.writeText(text); return true; } catch (_) {
      const t = document.createElement('textarea'); t.value = text; document.body.appendChild(t); t.select();
      const ok = document.execCommand('copy'); t.remove(); return ok;
    }
  }

  /* ---------------------------------------------------------------- season (same dates as the city) */
  const SEASONS = { 10: ['halloween', 'Happy Halloween'], 11: ['harvest', 'Happy Thanksgiving'], 12: ['holiday', 'Happy Holidays'] };
  const SEASON_KEY = { halloween: 'zombies', harvest: 'turkey', holiday: 'sleigh' };
  const month = Number(new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', month: 'numeric' }).format(new Date()));
  const season = SEASONS[month] || null;
  document.body.className = `season-${season ? season[0] : 'city'}`;
  if (season) $('#step-key').src = keyImg(SEASON_KEY[season[0]]);

  /* ---------------------------------------------------------------- who am I */
  const isKick = () => S.me && S.me.loggedIn && S.me.provider === 'kick';
  const myName = () => (S.me && S.me.profile && S.me.profile.username) || '';
  const TOOL_PAGES = ['widgets', 'bot', 'workout', 'slots', 'lighting', 'stake', 'chat', 'settings', 'drinking', 'rewards', 'leaderboard'];
  const isCreator = () => S.me && S.me.loggedIn && (S.me.isOwner || (S.me.allowedPages || []).some((p) => TOOL_PAGES.includes(p)));

  function renderAuth() {
    const box = $('#auth');
    if (S.me && S.me.loggedIn) {
      const p = S.me.profile || {};
      box.innerHTML = `${isCreator() ? `<a class="btn dark sm" href="/creator">${ic('cog')}<span class="lbl">Creator</span></a>` : ''}
        <a class="chip" href="#me">${p.profileImage ? `<img src="${esc(p.profileImage)}" alt="">` : ''}@${esc(p.username || 'you')}</a>
        <button class="btn dark sm" data-act="logout" title="Sign out">${ic('log-out')}</button>`;
    } else {
      box.innerHTML = `<a class="btn kick sm" href="/auth/kick"><span class="k">K</span><span class="lbl">Sign in with Kick</span></a>`;
    }
    $('#footer-creator').classList.toggle('hidden', !isCreator());
    const signed = Boolean(S.me && S.me.loggedIn);
    document.body.classList.toggle('signed-in', signed);
    $('#perks').classList.toggle('hidden', signed);
    $('#me').classList.toggle('hidden', !signed);
    document.querySelectorAll('.signed-only').forEach((el) => el.classList.toggle('hidden', !signed));
    renderHero();
  }

  /* ---------------------------------------------------------------- hero: join card (visitors) or welcome + setup (signed in) */
  const seasonTag = () => (season ? `<span class="season-tag">${esc(season[1])}</span>` : '');
  function renderHero() {
    const box = $('#hero-text');
    if (!S.me || !S.me.loggedIn) {
      box.innerHTML = `${seasonTag()}
        <h1>Chat on Kick.<br>Hit streamers in the city.</h1>
        <p>OnlyPixels streamers play live in our GTA city. Chat in their Kick chat to earn points, then type a word to send zombies, a blackout or fireworks their way.</p>
        <div class="join">
          <a class="btn kick big" href="/auth/kick"><span class="k">K</span> Sign in with Kick</a>
          <p class="join__note">${ic('check')} Free &nbsp;${ic('check')} Takes 10 seconds &nbsp;${ic('check')} We never see your Kick password</p>
          <div class="join__alt"><a href="#live">${ic('tv')} Just watch who's live</a><span>·</span><a href="/auth/twitch">Twitch instead</a></div>
        </div>`;
      return;
    }
    const p = S.me.profile || {};
    const who = `<div class="welcome">${p.profileImage ? `<img src="${esc(p.profileImage)}" alt="">` : ''}<div><span class="welcome__hi">Welcome back</span><h1>@${esc(p.username || 'you')}</h1></div></div>`;
    if (!isKick()) {
      box.innerHTML = `${seasonTag()}${who}
        <p>Points, chatting from the city and the Discord sub role all come from Kick chat, so they need a Kick sign-in.</p>
        <div class="hero__cta"><a class="btn kick" href="/auth/kick"><span class="k">K</span> Sign in with Kick</a><a class="btn dark" href="#live">${ic('tv')} Watch who's live</a></div>`;
      return;
    }
    const wallets = (S.points && S.points.wallets) || [];
    const total = wallets.reduce((a, w) => a + Number(w.balance || 0), 0);
    const c = S.check;
    const items = [
      ['done', 'Signed in with Kick', true, ''],
      ['points', wallets.length ? `Earning points with ${wallets.length} streamer${wallets.length === 1 ? '' : 's'}` : 'Chat in a live streamer\'s Kick chat', wallets.length > 0, '#live'],
      ['citychat', 'Chat from the city', c.citychat, '#card-citychat'],
      ['discord', 'Discord sub role', c.discord, '#card-discord'],
    ];
    const done = items.filter((i) => i[2] === true).length;
    box.innerHTML = `${seasonTag()}${who}
      <div class="hero-points"><span class="hero-points__n">${fmt(total)}</span><span class="hero-points__l">Kick Points across ${wallets.length || 0} streamer${wallets.length === 1 ? '' : 's'}</span></div>
      <div class="setup"><div class="setup__head"><b>Your setup</b><span>${done} of ${items.length} done</span></div>
        <div class="setup__bar"><i style="width:${done / items.length * 100}%"></i></div>
        ${items.map(([id, label, ok, href]) => `<a class="setup__item ${ok === true ? 'ok' : ''}" ${href ? `href="${href}"` : ''} data-set="${id}">
          <span class="tick">${ok === true ? ic('check') : ''}</span><span>${esc(label)}</span>${ok === true || !href ? '' : `<span class="go">Set up ${ic('chevron-right')}</span>`}</a>`).join('')}
      </div>
      <div class="hero__cta"><a class="btn kick" href="#live">${ic('tv')} Watch who's live</a><a class="btn dark" href="#words">Words to type</a></div>`;
  }

  /* ---------------------------------------------------------------- live TVs + watch */
  async function loadLive() {
    const { ok, data } = await api('/api/rewards/live-partners');
    if (!ok) { $('#live-count').textContent = "Couldn't check right now."; return; }
    S.partners = data.partners || [];
    renderWall();
  }
  function renderWall() {
    const live = S.partners.filter((p) => p.isLive);
    $('#live-count').textContent = live.length ? `${live.length} live right now · ${S.partners.length} streamers in OnlyPixels` : `${S.partners.length} streamers in OnlyPixels`;
    $('#tvwall').innerHTML = live.length ? live.map((p) => {
      const h = hue(p.displayName || p.slug);
      return `<button class="tv ${S.watch === p.slug ? 'sel' : ''}" data-act="watch" data-slug="${esc(p.slug)}" title="Watch @${esc(p.slug)}">
          <div class="screen"><div class="scr-bg" style="background:radial-gradient(circle at 50% 40%,hsl(${h},70%,42%),hsl(${(h + 40) % 360},70%,14%))"></div>
            <div class="scr-name">${esc(p.displayName || p.slug)}</div><div class="scr-sub">tap to watch</div></div>
          <img class="set" src="/site/art/props/tv_on.webp" alt=""><span class="badge">LIVE</span></button>`;
    }).join('') : `<div class="wall-empty"><b>Nobody's live right now.</b><br>Streamers show up here the moment they go live on Kick. Check back soon, or follow <a href="https://kick.com/na5ty" target="_blank" rel="noopener">na5ty on Kick</a>.</div>`;
  }
  function openWatch(slug) {
    const p = S.partners.find((x) => x.slug === slug) || { slug, displayName: slug };
    S.watch = slug;
    renderWall();
    const w = $('#watch');
    w.classList.remove('hidden');
    const pts = S.points && (S.points.wallets || []).find((x) => x.channel === slug);
    w.innerHTML = `<div class="screws"><i></i><i></i><i></i><i></i></div>
      <div class="watch__head"><h3>${esc(p.displayName || slug)}</h3>
        ${isKick() ? `<span class="status ${pts ? 'ok' : ''}">Your Kick Points here: ${fmt(pts ? pts.balance : 0)}</span>` : ''}
        <span class="sp"></span>
        <a class="btn dark sm" href="https://kick.com/${encodeURIComponent(slug)}" target="_blank" rel="noopener">${ic('external-link')} Open on Kick</a>
        <button class="btn dark sm" data-act="closeWatch">${ic('x')}</button></div>
      <div class="player"><iframe src="https://player.kick.com/${encodeURIComponent(slug)}?autoplay=true&muted=true" allow="autoplay; fullscreen; picture-in-picture" allowfullscreen title="${esc(slug)} on Kick"></iframe></div>
      <div class="chatbox"><div class="chatbox__lines" id="chat-lines"><p class="muted" style="padding:8px">${isKick() ? 'Loading chat…' : ''}</p></div>
        ${isKick() ? `<form id="chat-form"><input id="chat-input" maxlength="200" autocomplete="off" placeholder="Chat as @${esc(myName())}…"><button class="btn kick sm" type="submit">${ic('send')}</button></form>`
          : `<div class="chatbox__note"><b>Sign in with Kick</b> to read and send chat here (it counts for points), or just chat on Kick.<div class="row"><a class="btn kick sm" href="/auth/kick"><span class="k">K</span> Sign in</a></div></div>`}</div>`;
    w.scrollIntoView({ behavior: 'smooth', block: 'start' });
    clearInterval(S.chatTimer);
    if (isKick()) { loadChat(); S.chatTimer = setInterval(loadChat, 3500); }
  }
  function closeWatch() { S.watch = null; clearInterval(S.chatTimer); $('#watch').classList.add('hidden'); $('#watch').innerHTML = ''; renderWall(); }
  async function loadChat() {
    if (!S.watch || document.hidden) return;
    const slug = S.watch;
    const { ok, data } = await api(`/api/rewards/live-partners/${encodeURIComponent(slug)}/chat`);
    const box = $('#chat-lines');
    if (!box || S.watch !== slug) return;
    if (!ok) { box.innerHTML = `<p class="muted" style="padding:8px">${esc(data.error || "Chat isn't available right now.")}</p>`; return; }
    const stick = box.scrollHeight - box.scrollTop - box.clientHeight < 40;
    const msgs = data.messages || [];
    box.innerHTML = msgs.length ? msgs.map((m) => {
      const text = m.keyword && String(m.content).trim().toLowerCase() === String(m.keyword).toLowerCase() ? `<span class="w">${esc(m.content)}</span>` : esc(m.content);
      return `<div class="chatbox__line"><b style="color:hsl(${hue(m.username)},70%,68%)">${esc(m.username)}</b>: ${text}</div>`;
    }).join('') : '<p class="muted" style="padding:8px">Chat is quiet. Say hi!</p>';
    if (stick) box.scrollTop = box.scrollHeight;
  }
  async function sendChat(text) {
    const input = $('#chat-input');
    if (!text || !S.watch) return;
    input.disabled = true;
    const { ok, data } = await api(`/api/rewards/live-partners/${encodeURIComponent(S.watch)}/chat`, { method: 'POST', body: { content: text } });
    input.disabled = false;
    if (ok) { input.value = ''; loadChat(); } else toast(data.error || "That didn't send.", 'err');
    input.focus();
  }

  /* ---------------------------------------------------------------- words */
  const SEASON_TAGS = { halloween: 'Halloween', harvest: 'Thanksgiving', holiday: 'Holiday' };
  async function loadWords() {
    const { ok, data } = await api('/api/rewards/words');
    if (!ok) { $('#keys').innerHTML = '<p class="muted">Couldn\'t load the words right now.</p>'; return; }
    S.words = (data.words || []).map((w) => {
      const [label, tag] = String(w.description || w.word).split(' · ');
      return { ...w, label: label || w.word, seasonal: Boolean(tag && Object.values(SEASON_TAGS).includes(tag)) };
    });
    const groups = [];
    if (S.words.some((w) => w.seasonal)) groups.push(['season', season ? season[1].replace('Happy ', '') : 'Season', true]);
    if (S.words.some((w) => w.group === 'troll' && !w.seasonal && w.action !== 'untroll')) groups.push(['troll', 'Trolls']);
    if (S.words.some((w) => w.group === 'movement')) groups.push(['movement', 'Moves']);
    if (S.words.some((w) => w.group === 'rewards')) groups.push(['rewards', 'Free & rewards']);
    S.groups = groups;
    S.tab = S.tab || (groups[0] && groups[0][0]);
    renderWords();
  }
  function renderWords() {
    $('#word-tabs').innerHTML = (S.groups || []).map(([id, label, seasonal]) => `<button class="${S.tab === id ? 'on' : ''} ${seasonal ? 'seasonal' : ''}" data-act="tab" data-tab="${id}">${esc(label)}</button>`).join('');
    const list = S.words.filter((w) => (S.tab === 'season' ? w.seasonal : !w.seasonal && w.group === S.tab && w.action !== 'untroll'));
    $('#keys').innerHTML = list.map((w) => `<button class="key" data-act="copyWord" data-word="${esc(w.word)}" title="Copy &quot;${esc(w.word)}&quot;">
        <img src="${keyImg(w.action)}" alt="" loading="lazy" onerror="this.onerror=null;this.src='${keyImg('fire')}'"><b>${esc(w.label)}</b><code>${esc(w.word)}</code></button>`).join('') || '<p class="muted">Nothing here right now.</p>';
  }

  /* ---------------------------------------------------------------- my stuff */
  async function loadPoints() {
    if (!isKick()) return null;
    const { ok, data } = await api('/api/rewards/my-points');
    S.points = ok ? data : null;
    return S.points;
  }
  async function renderMe() {
    const grid = $('#me-grid');
    if (!S.me || !S.me.loggedIn) { grid.innerHTML = ''; return; }
    if (!isKick()) {
      grid.innerHTML = `<div class="plate wide"><div class="screws"><i></i><i></i><i></i><i></i></div><h3>Kick unlocks the rest</h3>
        <p>Points, chatting from the city and the Discord sub role come from Kick chat, so they need a Kick sign-in.</p>
        <div class="row"><a class="btn kick" href="/auth/kick"><span class="k">K</span> Sign in with Kick</a></div></div>`;
      return;
    }
    grid.innerHTML = ['points', 'citychat', 'discord', 'partner', 'twitch'].map((id) => `<div class="plate ${id === 'points' ? 'wide' : ''}" id="card-${id}"><div class="screws"><i></i><i></i><i></i><i></i></div><p class="muted">Loading…</p></div>`).join('');
    renderPoints(await loadPoints());
    renderHero();
    loadCityChat(); loadDiscord(); loadPartner(); loadTwitch();
  }
  const setCheck = (k, v) => { if (S.check[k] !== v) { S.check[k] = v; renderHero(); } };
  const card = (id, html) => { const el = $(`#card-${id}`); if (el) el.innerHTML = `<div class="screws"><i></i><i></i><i></i><i></i></div>${html}`; };
  const title = (img, h, status) => `<div class="card-title"><img src="${keyImg(img)}" alt=""><h3>${h}</h3>${status || ''}</div>`;

  function renderPoints(pts) {
    const wallets = (pts && pts.wallets) || [];
    const cap = (pts && pts.cap) || 1000;
    card('points', `${title('balance', 'Your Kick Points')}
      <p>Points are per streamer: chat in someone's Kick chat and you earn points to use on them. They roll over, up to ${fmt(cap)} each.</p>
      ${wallets.length ? `<div class="wallets">${wallets.map((w) => `<a class="wallet" href="https://kick.com/${encodeURIComponent(w.channel)}" target="_blank" rel="noopener"><b>@${esc(w.channel)}</b><span>${fmt(w.balance)}</span><div class="bar"><i style="width:${Math.min(100, w.balance / cap * 100)}%"></i></div></a>`).join('')}</div>`
        : `<p class="muted">No points yet. Chat in a live streamer's Kick chat and they'll show up here within a minute.</p>`}`);
  }

  async function loadCityChat(msg) {
    const { ok, data } = await api('/api/rewards/city-chat');
    if (!ok) { card('citychat', `${title('daily', 'Chat from the city')}<p class="muted">${esc(data.error || "Couldn't load this right now.")}</p>`); return; }
    const on = data.enabled;
    setCheck('citychat', Boolean(on && data.gameLinked));
    card('citychat', `${title('daily', 'Chat from the city', on ? (data.gameLinked ? '<span class="status ok">On · linked</span>' : '<span class="status warn">On · not linked yet</span>') : '<span class="status">Off</span>')}
      <p>Send messages to a streamer's Kick chat from the Kick hub in the city, as yourself. Words still work, and the channel's mods and bans apply.</p>
      ${on ? (data.gameLinked ? '<p class="muted">You\'re all set. Open the Kick hub in the city and type under the chat.</p>'
        : `<ol class="steps-mini"><li>In the city, open the Kick hub (<code>/kick</code> or the tablet's Streamer app).</li><li>Pick a channel and type this code under the chat:</li></ol>
           <div class="code-box"><div class="code">${esc(data.linkCode || '------')}</div></div>`) : ''}
      ${data.canChat === false && !on ? '<p class="muted">Sign out and back in with Kick first, so Kick lets us send chat for you.</p>' : ''}
      <div class="row"><button class="btn ${on ? 'dark' : 'kick'}" data-act="cityChat" data-on="${on ? 0 : 1}">${on ? 'Turn off' : 'Turn on'}</button></div>`);
    if (msg) toast(msg, 'ok');
  }

  async function loadDiscord() {
    const { ok, data } = await api('/api/discord/status');
    if (!ok) { card('discord', `${title('donate', 'Discord sub role')}<p class="muted">${esc(data.error || "Couldn't load this right now.")}</p>`); return; }
    if (!data.discordConfigured) { card('discord', `${title('donate', 'Discord sub role')}<p class="muted">Discord isn't set up on the site right now.</p>`); return; }
    const sub = data.activeSubscriber;
    setCheck('discord', Boolean(data.linked));
    card('discord', `${title('donate', 'Discord sub role', data.linked ? `<span class="status ok">${esc(data.discordUsername || 'Linked')}</span>` : '<span class="status">Not linked</span>')}
      <p>Subscribed to na5ty on Kick? Get the sub role in the Discord.</p>
      <p class="muted">${sub ? 'You\'re a subscriber on record.' : 'No sub on record yet. If you just subbed, type once in na5ty\'s Kick chat and try again.'}</p>
      <div class="row">${data.linked ? `<button class="btn discord" data-act="discordClaim" ${sub ? '' : 'disabled'}>Get the sub role</button><button class="btn dark sm" data-act="discordUnlink">Unlink</button>`
        : `<a class="btn discord" href="/auth/discord">Link Discord</a>`}</div>`);
  }

  async function loadPartner() {
    const { ok, data } = await api('/api/rewards/partner-application');
    if (!ok) { card('partner', `${title('tip', 'Stream in the city?')}<p class="muted">Couldn't load this right now.</p>`); return; }
    const a = data.application;
    const st = a && a.status;
    const badge = st === 'approved' ? '<span class="status ok">Partner</span>' : st === 'pending' ? '<span class="status warn">Waiting for staff</span>' : st === 'banned' ? '<span class="status bad">Not approved</span>' : '';
    card('partner', `${title('tip', 'Stream in the city?', badge)}
      ${st === 'approved' ? `<p>You're a partner: your chat can earn points and hit you in the city when you're live.</p>
           <h3 class="sub-h">Your OBS overlay</h3>
           <p>Shows your chat's trolls, pots and tips on stream as they land. In OBS add a <b>Browser</b> source, 1920 × 1080, with this link:</p>
           <div class="row"><input class="field mono" id="ov-url" readonly value="${esc(overlayUrl())}"><button class="btn accent sm" data-act="copyOverlay">${ic('copy')} Copy</button></div>
           <div class="row"><a class="btn dark sm" href="/overlay/city.html?demo=1" target="_blank" rel="noopener">${ic('eye')} Preview it</a></div>`
        : st === 'pending' ? '<p>Your application is in. Staff will review it. You keep everything viewers get in the meantime.</p>'
        : st === 'banned' ? `<p class="muted">${esc(a.reason || 'This application was not approved.')}</p>`
        : `<p>Partners get their own points and trolls in their chat. To apply:</p>
           <ol class="steps-mini"><li>In the city, open the Kick hub and set your account to <b>Streamer</b>.</li><li>Press Apply below. Staff will review it.</li></ol>
           <div class="row"><button class="btn accent" data-act="apply">Apply as a streamer</button></div>`}`);
  }

  async function loadTwitch() {
    const { ok, data } = await api('/api/rewards/twitch-link');
    const el = $('#card-twitch');
    if (!ok || (!data.canLink && !data.twitchUsername)) { if (el) el.remove(); return; }
    card('twitch', `${title('flipcam', 'Also on Twitch?', data.twitchUsername ? `<span class="status ok">twitch.tv/${esc(data.twitchUsername)}</span>` : '')}
      <p>Add your Twitch name so the city knows both. This doesn't change your Kick link.</p>
      <div class="row"><input class="field" id="tw-name" maxlength="40" placeholder="Twitch username" value="${esc(data.twitchUsername || '')}"><button class="btn twitch" data-act="twitch">Save</button></div>`);
  }

  const overlayUrl = () => `${location.origin}/overlay/city.html?channel=${encodeURIComponent(myName().toLowerCase())}`;

  /* ---------------------------------------------------------------- actions */
  const ACT = {
    watch: (el) => openWatch(el.dataset.slug),
    closeWatch,
    tab: (el) => { S.tab = el.dataset.tab; renderWords(); },
    copyOverlay: async () => { if (await copy(overlayUrl())) toast('Overlay link copied. Paste it into an OBS Browser source.', 'ok'); },
    copyWord: async (el) => { if (await copy(el.dataset.word)) toast(`Copied "${el.dataset.word}". Paste it on its own in their Kick chat.`, 'ok'); },
    logout: async () => { await api('/auth/logout', { method: 'POST' }); location.href = '/'; },
    cityChat: async (el) => {
      el.disabled = true;
      const { ok, data } = await api('/api/rewards/city-chat', { method: 'POST', body: { enabled: el.dataset.on === '1' } });
      if (!ok) { toast(data.error || "Couldn't save that.", 'err'); el.disabled = false; return; }
      loadCityChat(data.enabled ? 'Turned on.' : 'Turned off.');
    },
    discordClaim: async (el) => {
      el.disabled = true;
      const { ok, data } = await api('/api/discord/claim', { method: 'POST' });
      toast(ok ? (data.message || 'Role given. Check Discord!') : (data.error || "Couldn't give the role."), ok ? 'ok' : 'err');
      loadDiscord();
    },
    discordUnlink: async () => { await api('/api/discord/unlink', { method: 'POST' }); loadDiscord(); },
    apply: async (el) => {
      el.disabled = true;
      const { ok, data } = await api('/api/rewards/register', { method: 'POST', body: { kickUsername: myName() } });
      toast(ok ? 'Application sent. Staff will review it.' : (data.error || "Couldn't send it."), ok ? 'ok' : 'err');
      loadPartner();
    },
    twitch: async () => {
      const name = ($('#tw-name').value || '').trim().replace(/^@/, '');
      if (!name) return;
      const { ok, data } = await api('/api/rewards/twitch-link', { method: 'POST', body: { twitchUsername: name } });
      toast(ok ? 'Twitch saved.' : (data.error || "Couldn't save it."), ok ? 'ok' : 'err');
      loadTwitch();
    },
  };
  document.addEventListener('click', (ev) => {
    const el = ev.target.closest('[data-act]');
    if (el && ACT[el.dataset.act] && !el.disabled) { ev.preventDefault(); ACT[el.dataset.act](el, ev); }
  });
  document.addEventListener('submit', (ev) => {
    if (ev.target.id === 'chat-form') { ev.preventDefault(); sendChat(($('#chat-input').value || '').trim()); }
  });
  document.addEventListener('keydown', (ev) => { if (ev.key === 'Enter' && ev.target.id === 'tw-name') ACT.twitch(); });

  /* ---------------------------------------------------------------- one page: links scroll, the nav follows what's on screen */
  const ME_ALIASES = ['me', 'discord', 'only-pixels', 'profile'];
  const NAV_IDS = ['home', 'me', 'live', 'how', 'words'];
  const setNav = (id) => document.querySelectorAll('[data-nav]').forEach((a) => a.classList.toggle('on', a.dataset.nav === id));
  function route(smooth = true) {
    let h = (location.hash || '#home').slice(1).split('?')[0];
    if (ME_ALIASES.includes(h)) h = S.me && S.me.loggedIn ? 'me' : 'home';
    const t = document.getElementById(h) || document.getElementById('home');
    if (h === 'home') window.scrollTo({ top: 0, behavior: smooth ? 'smooth' : 'auto' });
    else t.scrollIntoView({ behavior: smooth ? 'smooth' : 'auto', block: 'start' });
    if (NAV_IDS.includes(h)) setNav(h);
  }
  window.addEventListener('hashchange', () => route(true));
  if ('IntersectionObserver' in window) {
    const seen = new Map();
    const io = new IntersectionObserver((entries) => {
      entries.forEach((e) => seen.set(e.target.id, e.isIntersecting ? e.intersectionRatio : 0));
      const best = NAV_IDS.filter((id) => (seen.get(id) || 0) > 0).sort((a, b) => seen.get(b) - seen.get(a))[0];
      if (best) setNav(best);
    }, { threshold: [0, .25, .5, .75], rootMargin: '-70px 0px -35% 0px' });
    NAV_IDS.forEach((id) => { const el = document.getElementById(id); if (el) io.observe(el); });
  }

  (async () => {
    const q = new URLSearchParams(location.search);
    if (q.get('error')) { toast(decodeURIComponent(q.get('error')).replace(/_/g, ' '), 'err'); history.replaceState(null, '', location.pathname + location.hash); }
    const { data } = await api('/api/me');
    S.me = data && typeof data === 'object' ? data : { loggedIn: false };
    renderAuth();
    loadLive(); loadWords();
    if (S.me.loggedIn) await renderMe();
    route(false);
    setInterval(loadLive, 60000);
  })();
})();
