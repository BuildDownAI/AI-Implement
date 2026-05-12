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
    const valid = Array.from(document.querySelectorAll('.nav-item')).map(e => e.getAttribute('data-route'));
    return valid.includes(h) ? h : 'overview';
  }

  window.navigate = function (route) { location.hash = '#' + route; };
  window.addEventListener('hashchange', () => show(readHash()));
  document.addEventListener('DOMContentLoaded', () => {
    show(readHash());
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
