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

  async function api(path, opts) {
    opts = opts || {};
    const headers = { 'Content-Type': 'application/json' };
    if (token) headers['Authorization'] = 'Bearer ' + token;
    const res = await fetch(API + path, Object.assign({}, opts, { headers }));
    if (res.status === 401) {
      localStorage.removeItem('admin_token');
      token = null;
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
  }
  window.showAdmin = showAdmin;

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
      showAdmin();
    } else {
      const el = document.getElementById('login-error');
      el.textContent = data.error || 'Login failed';
      el.classList.remove('hidden');
    }
  }
  window.login = login;

  function logout() {
    localStorage.removeItem('admin_token');
    token = null;
    showLogin();
  }
  window.logout = logout;

  // Wire up Enter key on login box
  document.addEventListener('DOMContentLoaded', function () {
    const ac = document.getElementById('access-code');
    if (ac) ac.addEventListener('keydown', function (e) { if (e.key === 'Enter') login(); });
    if (token) showAdmin();
  });
})();
`;
