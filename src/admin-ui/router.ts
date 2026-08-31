export const routerJs = `
(function () {
  const inits = {};
  window.registerPage = function (key, fn) { inits[key] = fn; };

  function show(route) {
    document.querySelectorAll('[data-page]').forEach(el => {
      el.hidden = el.getAttribute('data-page') !== route;
    });
    document.querySelectorAll('.nav-item').forEach(el => {
      el.classList.toggle('active', el.getAttribute('data-route') === route);
    });
    if (inits[route]) { inits[route](); inits[route] = null; /* once */ }
  }

  function readHash() {
    const h = (location.hash || '').replace(/^#/, '');
    // auth.js hides the nav items for ungranted pages, so typing the hash gains nothing over clicking.
    const valid = Array.from(document.querySelectorAll('.nav-item:not([hidden])')).map(e => e.getAttribute('data-route'));
    if (valid.includes(h)) return h;
    if (valid.includes('overview')) return 'overview';
    // A user granted nothing has an empty nav; 'no-access' is the section that explains why.
    return valid[0] || 'no-access';
  }

  // Held until auth.js knows the role: a page's init runs once, so routing against an unknown
  // identity renders it wrong permanently.
  let routing = false;

  window.navigate = function (route) { location.hash = '#' + route; };
  window.addEventListener('hashchange', () => { if (routing) show(readHash()); });

  /** Called by auth.js once the session identity has resolved, and not before. */
  window.startRouting = function () { routing = true; show(readHash()); };

  document.addEventListener('DOMContentLoaded', () => {
    // One-time fetch so any page (drawer, etc.) can build provider-aware URLs.
    if (window.api) {
      window.api('/api/admin/config-status').then(function (res) {
        if (!res.ok) return res.json().catch(function () { return {}; }).then(function () {});
        return res.json().then(function (status) {
          if (status && status.jiraSiteUrl) window.jiraSiteUrl = status.jiraSiteUrl;
        });
      }).catch(function () {});
    }
  });
})();
`;
