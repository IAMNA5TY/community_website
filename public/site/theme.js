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
        a.className = 'hub-back'; a.href = '/'; a.textContent = '← Back to na5ty.com';
        top.insertAdjacentElement('afterend', a);
      }
    } else {
      const strip = document.createElement('div');
      strip.className = 'hub-strip';
      strip.innerHTML = '<a class="hub-strip__brand" href="/">NA5TY</a><span class="hub-strip__sp"></span>'
        + '<a class="hub-strip__link" href="/">na5ty.com</a><a class="hub-strip__link main" href="/creator">Creator tools</a>';
      body.prepend(strip);
    }
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', ready); else ready();
})();
