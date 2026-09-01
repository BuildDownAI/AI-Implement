// Shared auth utilities injected into every admin page as a script block.
// Provides: token, API, api(), esc(), login(), showAdmin(), showLogin(), logout()
export const authJs = `
(function () {
  const API = '';
  let token = localStorage.getItem('admin_token');

  function esc(s) {
    const d = document.createElement('div');
    d.textContent = String(s == null ? '' : s);
    return d.innerHTML;
  }
  window.esc = esc;

  function escAttr(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#x27;');
  }
  window.escAttr = escAttr;

  // Validates URL scheme; returns '#' for javascript:, data:, etc.
  // Relative URLs (/path, ./path, #fragment) and http/https/mailto pass through.
  function safeUrl(s) {
    if (s == null) return '#';
    const str = String(s);
    if (!str) return '';
    if (str[0] === '#' || str[0] === '/' || str[0] === '.' || !str.includes(':')) return str;
    try {
      const url = new URL(str);
      if (url.protocol === 'http:' || url.protocol === 'https:' || url.protocol === 'mailto:') return str;
    } catch (_) { /* malformed URL with colon — block it */ }
    return '#';
  }
  window.safeUrl = safeUrl;

  function raw(s) {
    return { __raw: true, value: String(s == null ? '' : s) };
  }
  window.raw = raw;

  // Tagged template that escapes every interpolation with escAttr() by default.
  // For href/src attributes, also validates the URL scheme via safeUrl().
  // Wrap a value with raw() to inject pre-built markup without escaping.
  // Residual: does not detect URL context when the attribute is split across
  // multiple interpolations or the URL is built in a variable before the template.
  function html(strings, ...values) {
    let result = '';
    for (let i = 0; i < strings.length; i++) {
      result += strings[i];
      if (i < values.length) {
        const v = values[i];
        if (v && typeof v === 'object' && v.__raw) {
          result += v.value;
        } else {
          const inUrlAttr = /(?:href|src)\s*=\s*["']?$/i.test(strings[i]);
          result += escAttr(inUrlAttr ? safeUrl(v) : v);
        }
      }
    }
    return result;
  }
  window.html = html;

  // Brand marks for the provider tiles; unknown providers render label-only.
  var PROVIDER_ICONS = {
    google: '<svg viewBox="0 0 48 48"><path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"/><path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"/><path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.28-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"/><path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"/></svg>',
    microsoft: '<svg viewBox="0 0 21 21"><rect x="1" y="1" width="9" height="9" fill="#f25022"/><rect x="11" y="1" width="9" height="9" fill="#7fba00"/><rect x="1" y="11" width="9" height="9" fill="#00a4ef"/><rect x="11" y="11" width="9" height="9" fill="#ffb900"/></svg>'
  };

  async function api(path, opts) {
    opts = opts || {};
    const headers = { 'Content-Type': 'application/json' };
    if (token) headers['Authorization'] = 'Bearer ' + token;
    // credentials:'include' so the httpOnly session cookie rides along with every API call.
    const res = await fetch(API + path, Object.assign({}, opts, { headers, credentials: 'include' }));
    if (res.status === 401) {
      localStorage.removeItem('admin_token');
      token = null;
      await renderLogin();
      showLogin();
      throw new Error('Unauthorized');
    }
    return res;
  }
  window.api = api;

  function showLogin() {
    document.getElementById('login-page').classList.remove('hidden');
    document.getElementById('admin-page').classList.add('hidden');
  }
  window.showLogin = showLogin;

  function showAdmin() {
    document.getElementById('login-page').classList.add('hidden');
    document.getElementById('admin-page').classList.remove('hidden');
    // Releases the router, which ignores every hashchange until this point — a page's init runs
    // once, and before here the role it renders against is not yet known.
    window.startRouting();
  }
  window.showAdmin = showAdmin;

  // Login screen is built from server config: 
  // (which SSO providers exist + whether the deprecated access-code box still applies)
  async function renderLogin() {
    let providers = [], accessCode = true, noAdmin = false;
    try {
      const res = await fetch(API + '/api/auth/providers', { credentials: 'include' });
      const data = await res.json();
      providers = data.providers || [];
      accessCode = !!data.accessCode;
      noAdmin = data.noAdmin === true;
    } catch (e) { /* leave defaults so the access-code fallback stays reachable */ }

    var ssoButtons = document.getElementById('sso-buttons');
    if (ssoButtons) ssoButtons.innerHTML = providers.map(function (p) {
      return '<a class="sso-tile" href="' + API + '/api/auth/' + encodeURIComponent(p.id) + '/start">' +
             (PROVIDER_ICONS[p.id] || '') + '<span>' + esc(p.label) + '</span></a>';
    }).join('');

    var hasSso = providers.length > 0;
    var elNoAdmin = document.getElementById('no-admin-notice');
    var elSsoLabel = document.getElementById('sso-label');
    var elDivider = document.getElementById('login-divider');
    var elCodeNotice = document.getElementById('access-code-notice');
    var elCodeBox = document.getElementById('access-code-box');
    if (elNoAdmin) elNoAdmin.classList.toggle('hidden', !noAdmin);
    if (elSsoLabel) elSsoLabel.classList.toggle('hidden', !hasSso);
    if (elDivider) elDivider.classList.toggle('hidden', !(hasSso && accessCode));
    if (elCodeNotice) elCodeNotice.classList.toggle('hidden', !(accessCode && !hasSso));
    if (elCodeBox) elCodeBox.classList.toggle('hidden', !accessCode);
  }

  // Generic banner for the callback's ?auth_error=... redirect. The specific reason stays server-side
  function showAuthError() {
    const err = new URLSearchParams(location.search).get('auth_error');
    if (!err) return;
    const messages = {
      denied: "This account isn't authorized for the admin UI.",
      expired: 'Your sign-in expired. Please try again.',
      failed: 'Sign-in failed. Please try again.'
    };
    const el = document.getElementById('auth-error');
    el.textContent = messages[err] || messages.failed;
    el.classList.remove('hidden');
    history.replaceState(null, '', location.pathname + location.hash); // drop the query so a refresh won't re-show it
  }

  let sessionIdentity = null;

  // Doubles as the sign-in probe: a 200 means the session is live. 401 if not
  async function loadSessionIdentity() {
    const headers = {};
    if (token) headers['Authorization'] = 'Bearer ' + token;
    try {
      const res = await fetch(API + '/api/session-identity', { credentials: 'include', headers });
      if (!res.ok) return null;
      return await res.json();
    } catch (e) { return null; }
  }
  // Withholds admin-only controls inside a page a user can otherwise open. Cosmetic: every such
  // route is refused at the server gate, so a call site that forgets this yields a 403, not a leak.
  window.isAdmin = function () { return !!sessionIdentity && sessionIdentity.role === 'admin'; };

  // Hidden rather than removed, so an access-code sign-in later in the same page load restores the
  // full nav. The router reads visibility, so a hidden page is unreachable by hash as well.
  function applyNavVisibility(s) {
    var granted = s.grantedPages || [];
    document.querySelectorAll('.nav-item').forEach(function (el) {
      el.hidden = s.role !== 'admin' && granted.indexOf(el.getAttribute('data-route')) === -1;
    });
    document.querySelectorAll('.nav-section').forEach(function (sec) {
      sec.hidden = !sec.querySelector('.nav-item:not([hidden])');
    });
  }

  function applySessionIdentity(s) {
    applyNavVisibility(s);
    // The bright slot always carries the most identifying value we have.
    const primary = s.name || s.email || 'Access code';
    const secondary = s.name ? (s.email || '') : '';
    const nameEl = document.getElementById('session-name');
    const emailEl = document.getElementById('session-email');
    const avatarEl = document.getElementById('session-avatar');
    if (nameEl) { nameEl.textContent = primary; nameEl.title = primary; }
    if (emailEl) {
      emailEl.textContent = secondary;
      emailEl.hidden = !secondary;
      emailEl.title = secondary;
    }
    if (avatarEl) avatarEl.textContent = primary.charAt(0).toUpperCase();
  }

  async function login() {
    const code = document.getElementById('access-code').value;
    const res = await fetch(API + '/api/auth', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code })
    });
    const data = await res.json();
    if (data.token) {
      token = data.token;
      localStorage.setItem('admin_token', token);
      sessionIdentity = await loadSessionIdentity();
      if (sessionIdentity) applySessionIdentity(sessionIdentity);
      showAdmin();
    } else {
      const el = document.getElementById('login-error');
      el.textContent = data.error || 'Login failed';
      el.classList.remove('hidden');
    }
  }
  window.login = login;

  async function logout() {
    try { await fetch(API + '/api/auth/logout', { method: 'POST', credentials: 'include' }); } catch (e) { /* ignore */ }
    localStorage.removeItem('admin_token');
    token = null;
    sessionIdentity = null;
    await renderLogin(); // repaint the buttons — bootstrap skipped them when we were authed
    showLogin();
  }
  window.logout = logout;

  document.addEventListener('DOMContentLoaded', async function () {
    // Wire up Enter key on login box
    const ac = document.getElementById('access-code');
    if (ac) ac.addEventListener('keydown', function (e) { if (e.key === 'Enter') login(); });

    showAuthError();
    sessionIdentity = await loadSessionIdentity();
    if (sessionIdentity) {
      applySessionIdentity(sessionIdentity);
      showAdmin();
    } else {
      await renderLogin();
      showLogin();
    }
  });
})();
`;
