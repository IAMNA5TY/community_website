/* Kick hub look for creator pages. <script src="/site/theme.js" data-kind="creator|panel"></script> in <head>.
   Sets the season (same dates as the city), the backdrop, and the way back to the player site. */
(() => {
  const script = document.currentScript;
  const kind = (script && script.dataset.kind) || 'panel';
  const SEASONS = { 10: 'halloween', 11: 'harvest', 12: 'holiday' };
  let month = new Date().getMonth() + 1;
  try { month = Number(new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', month: 'numeric' }).format(new Date())); } catch (_) { /* old browser */ }
  const root = document.documentElement;
  const embedded = window.self !== window.top;           // control panels shown inside the dashboard
  root.classList.add('hub-theme', `hub-${kind}`, `season-${SEASONS[month] || 'city'}`);
  if (embedded) root.classList.add('hub-embed');

  function ready() {
    const body = document.body;
    if (!body) return;
    if (embedded || body.classList.contains('embed')) return;   // the dashboard around it already has the look
    const scene = document.createElement('div');
    scene.className = 'hub-scene';
    body.prepend(scene);
    if (kind === 'creator') {
      const top = document.querySelector('.sidebar-top');
      if (top && !document.querySelector('.hub-back')) {
        const a = document.createElement('a');
        a.className = 'hub-back'; a.href = '/'; a.innerHTML = '<span>←</span> na5ty.com';
        top.insertAdjacentElement('afterend', a);
      }
      topTabs();
    } else {
      const strip = document.createElement('div');
      strip.className = 'hub-strip';
      strip.innerHTML = '<a class="hub-strip__brand" href="/">NA5TY</a><span class="hub-strip__sp"></span>'
        + '<a class="hub-strip__link" href="/">na5ty.com</a><a class="hub-strip__link main" href="/creator">Creator tools</a>';
      body.prepend(strip);
    }
  }
  /* creator: on a desktop the sidebar becomes a top bar of tabs like the player site.
     Community and Account become dropdowns; More tools opens as a dropdown too. Phones keep the slide-out menu. */
  function topTabs() {
    document.documentElement.classList.add('hub-tabs');
    const tag = document.querySelector('.sidebar-brand__tag');
    if (tag) tag.textContent = 'Creator';
    const nav = document.getElementById('main-nav');
    if (!nav || nav.dataset.hubTabs) return;
    nav.dataset.hubTabs = '1';
    const chev = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.4" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>';
    const groups = nav.querySelectorAll('.nav-group');
    groups.forEach((g) => {
      if (g.classList.contains('nav-group--tools')) return;
      const isAccount = g.classList.contains('nav-group--other');
      g.classList.add('hub-dd');
      const btn = document.createElement('button');
      btn.type = 'button'; btn.className = 'hub-dd__btn';
      btn.innerHTML = isAccount
        ? '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><circle cx="12" cy="9" r="3.5"/><path d="M5 19c1.8-3 4.2-4.5 7-4.5S16.2 16 18 19"/></svg><span>Account</span>' + chev
        : `<span>Community</span>${chev}`;
      const menu = document.createElement('div');
      menu.className = 'hub-dd__menu';
      [...g.children].forEach((c) => { if (!c.classList.contains('nav-group__label')) menu.appendChild(c); });
      if (isAccount) {
        g.classList.add('hub-dd--right');
        const panel = document.getElementById('public-tabs-panel');
        if (panel) menu.appendChild(panel);        // owner's public-tabs picker lives in the Account menu
      }
      g.append(btn, menu);
    });
    const more = document.getElementById('nav-more-tools');
    if (more) more.classList.add('hub-dd');
    const closeAll = (except) => nav.querySelectorAll('.hub-dd.dd-open').forEach((d) => { if (d !== except) d.classList.remove('dd-open'); });
    nav.addEventListener('click', (ev) => {
      const t = ev.target.closest('.hub-dd__btn, .nav-more__toggle');
      if (t) {
        const dd = t.closest('.hub-dd');
        closeAll(dd);
        dd.classList.toggle('dd-open');
        return;
      }
      if (ev.target.closest('.nav-link')) closeAll();
    });
    document.addEventListener('click', (ev) => { if (!ev.target.closest('#main-nav')) closeAll(); });
    document.addEventListener('keydown', (ev) => { if (ev.key === 'Escape') closeAll(); });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', ready); else ready();
})();
