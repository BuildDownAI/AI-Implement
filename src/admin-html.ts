export const adminHtml = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>AI-Implement Admin</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #f5f5f5; color: #333; padding: 20px; max-width: 1280px; margin: 0 auto; }
  h1 { font-size: 1.4em; margin-bottom: 20px; }
  h2 { font-size: 1.1em; margin-bottom: 12px; color: #555; }
  .card { background: #fff; border-radius: 8px; padding: 20px; margin-bottom: 20px; box-shadow: 0 1px 3px rgba(0,0,0,0.1); overflow-x: auto; }
  table { width: 100%; border-collapse: collapse; font-size: 0.85em; }
  th, td { text-align: left; padding: 6px 6px; border-bottom: 1px solid #eee; white-space: nowrap; }
  th { color: #888; font-weight: 500; font-size: 0.8em; text-transform: uppercase; }
  tr:last-child td { border-bottom: none; }
  input, button, select { font-size: 0.85em; padding: 4px 6px; border-radius: 4px; border: 1px solid #ddd; }
  input { width: 100%; }
  button { cursor: pointer; background: #4a90d9; color: #fff; border: none; padding: 4px 10px; }
  button:hover { background: #357abd; }
  button.danger { background: #e74c3c; }
  button.danger:hover { background: #c0392b; }
  button.secondary { background: #95a5a6; }
  button.sm { padding: 3px 8px; font-size: 0.8em; }
  .form-row { display: flex; gap: 6px; margin-top: 10px; align-items: center; }
  .form-row input { flex: 1; min-width: 0; }
  .badge { display: inline-block; padding: 2px 8px; border-radius: 10px; font-size: 0.8em; }
  .badge.active { background: #2ecc71; color: #fff; }
  .badge.mode-default { background: #4a90d9; color: #fff; }
  .badge.mode-gha { background: #2ecc71; color: #fff; }
  .badge.mode-fly { background: #9b59b6; color: #fff; }
  .badge.mode-shadow { background: #e67e22; color: #fff; }
  .status-block { display: flex; align-items: center; gap: 16px; flex-wrap: wrap; }
  .runner-btns button { margin-right: 6px; }
  .runner-btns button.active-mode { box-shadow: 0 0 0 2px #4a90d9; font-weight: bold; }
  .login-wrap { display: flex; justify-content: center; align-items: center; min-height: 60vh; }
  .login-box { width: 320px; }
  .login-box input { margin-bottom: 10px; }
  .login-box button { width: 100%; }
  .error { color: #e74c3c; font-size: 0.85em; margin-top: 6px; }
  .hidden { display: none; }
  .mono { font-family: monospace; font-size: 0.85em; }
  .topbar { display: flex; justify-content: space-between; align-items: center; gap: 12px; margin-bottom: 20px; }
  .warning { background: #fff3cd; border: 1px solid #ffc107; border-radius: 4px; padding: 8px 12px; font-size: 0.85em; color: #856404; margin-bottom: 12px; }
  .last-updated { color: #aaa; font-size: 0.75em; font-weight: normal; margin-left: 8px; }
  .tab-bar { display: flex; gap: 24px; border-bottom: 1px solid #ddd; margin-bottom: 20px; }
  .tab-bar a { padding: 10px 2px; color: #888; text-decoration: none; font-size: 0.9em; border-bottom: 2px solid transparent; margin-bottom: -1px; cursor: pointer; }
  .tab-bar a:hover { color: #555; }
  .tab-bar a.active { color: #333; border-bottom-color: #4a90d9; font-weight: 500; }
  .tab-hidden { display: none !important; }
  details[open] > summary > span:first-child { transform: rotate(90deg); display:inline-block; }
  dialog { border: none; border-radius: 8px; padding: 0; width: 700px; max-width: 95vw; box-shadow: 0 8px 32px rgba(0,0,0,0.2); }
  dialog::backdrop { background: rgba(0,0,0,0.4); }
  .md-header { display: flex; justify-content: space-between; align-items: center; padding: 16px 20px; border-bottom: 1px solid #eee; font-weight: 600; }
  .md-body { padding: 16px 20px; display: flex; flex-direction: column; gap: 12px; max-height: 70vh; overflow-y: auto; }
  .md-cols { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
  .md-footer { padding: 12px 20px; border-top: 1px solid #eee; }
  fieldset { border: 1px solid #e0e0e0; border-radius: 6px; padding: 10px 14px; }
  legend { font-size: 0.8em; font-weight: 600; color: #666; text-transform: uppercase; padding: 0 4px; }
  .md-field { display: flex; flex-direction: column; gap: 3px; margin-bottom: 8px; }
  .md-field:last-child { margin-bottom: 0; }
  .md-field label { font-size: 0.78em; color: #666; font-weight: 500; }
  .md-field input, .md-field select, .md-field textarea { width: 100%; }
  .md-field textarea { font-family: monospace; font-size: 0.82em; resize: vertical; }
</style>
</head>
<body>

<div id="login-page" class="login-wrap">
  <div class="login-box card">
    <h2>Admin Access</h2>
    <input type="password" id="access-code" placeholder="Access code" autofocus>
    <button onclick="login()">Enter</button>
    <div id="login-error" class="error hidden"></div>
  </div>
</div>

<div id="admin-page" class="hidden">
  <div class="topbar">
    <h1 style="margin-bottom: 0;">AI-Implement Admin</h1>
    <button class="secondary" onclick="logout()">Log Out</button>
  </div>

  <nav class="tab-bar" id="tab-bar">
    <a id="tab-link-activity" data-tab="activity" onclick="setActiveTab('activity')">Activity</a>
    <a id="tab-link-mappings" data-tab="mappings" onclick="setActiveTab('mappings')">Mappings</a>
    <a id="tab-link-settings" data-tab="settings" onclick="setActiveTab('settings')">Settings</a>
  </nav>

  <section data-tab="settings" id="tab-settings">
  <div class="card">
    <h2>Settings</h2>
    <div id="settings-env-warning" class="warning hidden">
      &#9888; One or more settings are overridden by environment variables. Changes saved here will take effect on next restart only if the env var is removed.
    </div>

    <fieldset style="margin-bottom:16px">
      <legend>Fly Sessions App</legend>
      <div class="md-field" style="margin-top:8px">
        <label>Sessions App Name</label>
        <div style="display:flex;gap:6px">
          <input id="settings-sessions-app" placeholder="e.g. my-ai-implement-sessions" style="flex:1">
          <button class="sm" onclick="saveSessionsApp()">Save</button>
        </div>
        <div id="settings-sessions-app-source" style="font-size:0.78em;color:#888;margin-top:3px"></div>
      </div>
      <div class="md-field">
        <label>Sessions Region (optional)</label>
        <div style="display:flex;gap:6px">
          <input id="settings-sessions-region" placeholder="e.g. iad" style="flex:1">
          <button class="sm" onclick="saveSessionsRegion()">Save</button>
        </div>
      </div>
      <div id="settings-restart-notice" class="warning hidden" style="margin-top:8px">
        &#9654; Restart the orchestrator for these changes to take effect.
      </div>
      <div id="settings-error" class="error hidden" style="margin-top:6px"></div>
    </fieldset>

    <fieldset>
      <legend>Global Machine Secrets</legend>
      <p style="font-size:0.82em;color:#666;margin:8px 0 12px">
        Secrets stored on the Fly sessions app and injected into every machine as environment variables. Values are write-only &mdash; set them here instead of using the Fly CLI.
      </p>
      <div id="global-secrets-503" class="warning hidden">Fly sessions app is not configured &mdash; configure the Sessions App above first.</div>
      <table id="global-secrets-table" style="margin-bottom:12px">
        <thead><tr><th>Name</th><th>Created</th><th></th></tr></thead>
        <tbody id="global-secrets-body"></tbody>
      </table>
      <div id="global-secrets-empty" class="hidden" style="color:#888;font-size:0.85em;margin-bottom:10px">No global secrets set.</div>
      <div style="display:flex;gap:6px;align-items:flex-end;flex-wrap:wrap">
        <div class="md-field" style="flex:1;min-width:140px;margin-bottom:0">
          <label>Name</label>
          <input id="gs-name" placeholder="ANTHROPIC_API_KEY" style="text-transform:uppercase">
        </div>
        <div class="md-field" style="flex:2;min-width:200px;margin-bottom:0">
          <label>Value</label>
          <input id="gs-value" type="password" placeholder="sk-ant-...">
        </div>
        <button class="sm" onclick="addGlobalSecret()" style="align-self:flex-end">Add Secret</button>
      </div>
      <div id="gs-error" class="error hidden" style="margin-top:6px"></div>
    </fieldset>
  </div>
  </section>

  <section data-tab="activity" id="tab-activity">
    <div id="runner-mode-strip" style="display:flex;align-items:center;gap:16px;flex-wrap:wrap;padding:10px 14px;background:#fff;border:1px solid #eee;border-radius:6px;margin-bottom:20px;font-size:0.9em">
      <span style="color:#888;text-transform:uppercase;font-size:0.78em;font-weight:500">Runner Mode</span>
      <span id="runner-mode-badge" class="badge"></span>
      <span id="runner-mode-source" style="color:#aaa;font-size:0.8em"></span>
      <span class="runner-btns" id="runner-mode-controls">
        <button class="sm" id="btn-mode-default" onclick="setRunnerMode('default')">Default</button>
        <button class="sm" id="btn-mode-gha" onclick="setRunnerMode('gha')">GHA</button>
        <button class="sm" id="btn-mode-fly" onclick="setRunnerMode('fly')">Fly</button>
        <button class="sm" id="btn-mode-shadow" onclick="setRunnerMode('shadow')">Shadow</button>
      </span>
      <span style="flex:1"></span>
      <span id="reaper-status-line" style="color:#555">Reaper: loading&hellip;</span>
      <span id="lu-runner" class="last-updated"></span>
    </div>
    <div id="runner-mode-env-warning" class="error hidden" style="margin:-12px 0 12px">
      &#9888; RUNNER_MODE env var is set &mdash; UI toggle has no effect until it is unset.
    </div>

  <div class="card">
    <h2>Active Fly Sessions<span id="lu-sessions" class="last-updated"></span></h2>
    <table>
      <thead>
        <tr><th>Issue</th><th>Team</th><th>Repo</th><th>Machine</th><th>State</th><th>Duration</th><th></th></tr>
      </thead>
      <tbody id="sessions-body"></tbody>
    </table>
    <div id="sessions-empty" class="hidden" style="color:#888; padding:10px 0;">No active sessions</div>
  </div>

  <div class="card">
    <h2>Jobs<span id="lu-log" class="last-updated"></span></h2>
    <table>
      <thead>
        <tr><th>Time</th><th>#</th><th>Issue</th><th>State</th><th>Team</th><th>Repo</th><th>Runner</th><th>Image</th><th>Status</th><th>PR</th></tr>
      </thead>
      <tbody id="log-body"></tbody>
    </table>
    <div id="log-empty" class="hidden" style="color:#888; padding:10px 0;">No dispatches yet</div>
  </div>

    <details class="card" id="reaper-details">
      <summary style="cursor:pointer;font-size:1.1em;font-weight:500;color:#555;list-style:none">
        <span style="display:inline-block;width:1em">&#9656;</span>
        Reaper actions <span id="reaper-count" style="color:#888;font-weight:normal;font-size:0.85em">(&hellip;)</span>
        <span id="lu-reaper" class="last-updated"></span>
      </summary>
      <div style="margin-top:12px">
        <div id="reaper-summary-block" style="margin-bottom:12px"></div>
        <table>
          <thead>
            <tr><th>Time</th><th>Rule</th><th>Machine</th><th>Tenant</th><th>Issue</th><th>Age (s)</th><th>Mode</th></tr>
          </thead>
          <tbody id="reaper-body"></tbody>
        </table>
        <div id="reaper-empty" class="hidden" style="color:#888;padding:10px 0;">No reaper actions recorded</div>
      </div>
    </details>

    <details class="card" id="dedup-details">
      <summary style="cursor:pointer;font-size:1.1em;font-weight:500;color:#555;list-style:none">
        <span style="display:inline-block;width:1em">&#9656;</span>
        Dedup entries <span id="dedup-count" style="color:#888;font-weight:normal;font-size:0.85em">(&hellip;)</span>
        <span id="lu-dedup" class="last-updated"></span>
      </summary>
      <div style="margin-top:12px">
        <table>
          <thead>
            <tr><th>Issue</th><th>Dispatched At</th><th></th></tr>
          </thead>
          <tbody id="dedup-body"></tbody>
        </table>
        <div id="dedup-empty" class="hidden" style="color:#888; padding:10px 0;">No entries</div>
      </div>
    </details>
  </section>

  <section data-tab="mappings" id="tab-mappings">
  <div class="card">
    <h2>Team &rarr; Repo Mappings</h2>
    <div style="margin-bottom:10px"><button onclick="openMappingDialog(null)">+ Add Mapping</button></div>
    <table>
      <thead>
        <tr><th>Team Key</th><th>Owner / Repo</th><th>Exec Mode</th><th>Session</th><th title="Max concurrent AI issues per team">Max AI</th><th>Planning</th><th title="Claude provider: anthropic (direct API / OAuth) or bedrock (AWS Bedrock via OIDC)">Provider</th><th></th></tr>
      </thead>
      <tbody id="mappings-body"></tbody>
    </table>
  </div>

  <div class="card hidden" id="secrets-panel">
    <h2>Secrets &mdash; <span id="secrets-team-key" class="mono"></span><button class="sm secondary" style="float:right" onclick="document.getElementById('secrets-panel').classList.add('hidden')">&#215;</button></h2>
    <div class="warning">&#9888; Secrets are shared across all machines for this team. Values are write-only and cannot be read back through the API.</div>
    <table>
      <thead>
        <tr><th>Name (suffix)</th><th>Status</th><th></th></tr>
      </thead>
      <tbody id="secrets-body"></tbody>
    </table>
    <div id="secrets-empty" class="hidden" style="color:#888; padding:10px 0;">No secrets set for this team</div>
    <div class="form-row" style="margin-top:12px">
      <input id="s-name" placeholder="Name (e.g. DATABASE_URL)" style="text-transform:uppercase">
      <input id="s-value" type="password" placeholder="Value">
      <button id="btn-add-secret" onclick="addSecret()">Set Secret</button>
    </div>
    <div id="secrets-error" class="error hidden" style="margin-top:6px"></div>
  </div>
  </section>

  <dialog id="mapping-dialog">
    <div class="md-header">
      <span id="md-title">Add Mapping</span>
      <button class="secondary sm" onclick="closeMappingDialog()">&#215;</button>
    </div>
    <input type="hidden" id="md-team-key-orig">
    <div class="md-body">
      <div class="md-cols">
        <fieldset>
          <legend>Basic</legend>
          <div class="md-field"><label>Team Key</label><input id="md-team-key" placeholder="MY_TEAM"></div>
          <div class="md-field"><label>Owner</label><input id="md-owner" placeholder="acme-corp"></div>
          <div class="md-field"><label>Repo</label><input id="md-repo" placeholder="backend"></div>
          <div class="md-field"><label>Workflow File</label><input id="md-wf" value="claude-implement.yml"></div>
          <div class="md-field"><label>Default Branch</label><input id="md-branch" value="main"></div>
          <div class="md-field"><label>Max AI Issues</label><input id="md-max-ai" type="number" min="1" value="3"></div>
        </fieldset>
        <fieldset>
          <legend>Execution</legend>
          <div class="md-field">
            <label>Mode</label>
            <select id="md-exec-mode" onchange="onExecModeChange()">
              <option value="github-actions">github-actions</option>
              <option value="fly-machines">fly-machines</option>
            </select>
          </div>
          <div class="md-field">
            <label>Session Mode</label>
            <select id="md-session-mode">
              <option value="autonomous">autonomous</option>
              <option value="interactive">interactive</option>
              <option value="hybrid">hybrid</option>
            </select>
          </div>
          <div id="md-fly-fields" class="hidden">
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:8px">
              <div class="md-field" style="margin-bottom:0"><label>CPUs</label><input id="md-cpus" type="number" min="1" value="2"></div>
              <div class="md-field" style="margin-bottom:0"><label>Memory (MB)</label><input id="md-mem" type="number" min="256" step="256" value="4096"></div>
            </div>
          </div>
          <div class="md-field">
            <label>Extra Env (KEY=VALUE, one per line)</label>
            <textarea id="md-env" rows="4" placeholder="KEY=VALUE&#10;ANOTHER=value"></textarea>
          </div>
        </fieldset>
      </div>
      <fieldset>
        <legend>Planning</legend>
        <div style="display:flex;gap:20px;align-items:center;flex-wrap:wrap">
          <label style="font-size:0.85em;display:flex;align-items:center;gap:6px;white-space:nowrap"><input id="md-planning" type="checkbox" style="width:auto" onchange="onPlanningChange()"> Enabled</label>
          <label style="font-size:0.85em;display:flex;align-items:center;gap:6px;white-space:nowrap"><input id="md-auto-approve" type="checkbox" style="width:auto" checked> Auto-approve</label>
          <div id="md-planning-wf-wrap" class="md-field hidden" style="flex:1;min-width:160px;margin-bottom:0">
            <label>Planning Workflow File</label><input id="md-planning-wf" value="claude-plan.yml">
          </div>
        </div>
      </fieldset>
      <fieldset>
        <legend>Provider</legend>
        <div style="display:flex;gap:20px;align-items:flex-end;flex-wrap:wrap">
          <div class="md-field" style="margin-bottom:0;min-width:140px">
            <label>Provider</label>
            <select id="md-provider" onchange="onProviderChange()">
              <option value="anthropic">anthropic</option>
              <option value="bedrock">bedrock</option>
            </select>
          </div>
          <div id="md-aws-region-wrap" class="md-field hidden" style="flex:1;min-width:180px;margin-bottom:0">
            <label>AWS Region</label><input id="md-aws-region" placeholder="us-west-2">
          </div>
        </div>
      </fieldset>
    </div>
    <div class="md-footer">
      <div id="md-error" class="error hidden" style="margin-bottom:8px"></div>
      <div style="display:flex;gap:8px;justify-content:flex-end">
        <button class="secondary" onclick="closeMappingDialog()">Cancel</button>
        <button onclick="saveMappingDialog()">Save Mapping</button>
      </div>
    </div>
  </dialog>
</div>

<script>
const API = '';
let token = localStorage.getItem('admin_token');
let mappingsData = {};
window.__intervals = {};

function startPolling(loadFn, intervalMs, key) {
  if (window.__intervals[key]) clearInterval(window.__intervals[key]);
  window.__intervals[key] = setInterval(loadFn, intervalMs);
}

function stopAllPolling() {
  Object.keys(window.__intervals).forEach(function(key) {
    clearInterval(window.__intervals[key]);
    delete window.__intervals[key];
  });
}

function startActivityPolling() {
  startPolling(loadLog, 10000, 'log');
  startPolling(loadSessions, 30000, 'sessions');
  startPolling(loadRunnerMode, 30000, 'runner');
  // Reaper and Dedup pollers are gated by their <details> open state — see startReaperPolling / startDedupPolling.
  if (document.getElementById('reaper-details') && document.getElementById('reaper-details').open) {
    startPolling(loadReaper, 15000, 'reaper');
  }
  if (document.getElementById('dedup-details') && document.getElementById('dedup-details').open) {
    startPolling(loadDedup, 15000, 'dedup');
  }
}

function startMappingsPolling() {
  // Mappings is fetched on tab entry; no recurring poll today.
}

function startSettingsPolling() {
  // Settings + global secrets are one-shot on tab entry; no recurring poll today.
}

function startActiveTabPolling(name) {
  if (name === 'activity') return startActivityPolling();
  if (name === 'mappings') return startMappingsPolling();
  if (name === 'settings') return startSettingsPolling();
}

async function loadActiveTabData(name) {
  if (name === 'activity') {
    await Promise.all([loadLog(), loadSessions(), loadRunnerMode()]).catch(function(err){ console.error('activity load failed:', err); });
    if (document.getElementById('reaper-details') && document.getElementById('reaper-details').open) loadReaper();
    if (document.getElementById('dedup-details') && document.getElementById('dedup-details').open) loadDedup();
  } else if (name === 'mappings') {
    await loadMappings().catch(function(err){ console.error('mappings load failed:', err); });
  } else if (name === 'settings') {
    await Promise.all([loadSettings(), loadGlobalSecrets()]).catch(function(err){ console.error('settings load failed:', err); });
  }
}

function setLastUpdated(id) {
  const el = document.getElementById(id);
  if (el) el.textContent = 'updated ' + new Date().toLocaleTimeString();
}

document.addEventListener('visibilitychange', function() {
  if (document.visibilityState === 'hidden') {
    stopAllPolling();
  } else if (token) {
    const active = localStorage.getItem('admin_active_tab') || 'activity';
    loadActiveTabData(active);
    startActiveTabPolling(active);
  }
});

if (token) { showAdmin(); }

async function api(path, opts = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = 'Bearer ' + token;
  const res = await fetch(API + path, { ...opts, headers });
  if (res.status === 401) { localStorage.removeItem('admin_token'); token = null; showLogin(); throw new Error('Unauthorized'); }
  return res;
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
    showAdmin();
  } else {
    const el = document.getElementById('login-error');
    el.textContent = data.error || 'Login failed';
    el.classList.remove('hidden');
  }
}

document.getElementById('access-code').addEventListener('keydown', e => { if (e.key === 'Enter') login(); });

const TABS = ['activity', 'mappings', 'settings'];

function getInitialTab() {
  const fromHash = (location.hash || '').replace(/^#/, '');
  if (TABS.includes(fromHash)) return fromHash;
  const stored = localStorage.getItem('admin_active_tab');
  if (TABS.includes(stored)) return stored;
  return 'activity';
}

function setActiveTab(name) {
  if (!TABS.includes(name)) name = 'activity';
  for (const t of TABS) {
    const section = document.getElementById('tab-' + t);
    const link = document.getElementById('tab-link-' + t);
    if (section) section.classList.toggle('tab-hidden', t !== name);
    if (link) link.classList.toggle('active', t === name);
  }
  localStorage.setItem('admin_active_tab', name);
  if (location.hash !== '#' + name) {
    history.replaceState(null, '', '#' + name);
  }
  stopAllPolling();
  loadActiveTabData(name);
  startActiveTabPolling(name);
}

function wireDetailsPoller(detailsId, intervalMs, key, loadFn) {
  const el = document.getElementById(detailsId);
  if (!el) return;
  el.addEventListener('toggle', function() {
    if (el.open) {
      loadFn();
      startPolling(loadFn, intervalMs, key);
    } else {
      if (window.__intervals[key]) {
        clearInterval(window.__intervals[key]);
        delete window.__intervals[key];
      }
    }
  });
}

wireDetailsPoller('reaper-details', 15000, 'reaper', loadReaper);
wireDetailsPoller('dedup-details', 15000, 'dedup', loadDedup);

window.addEventListener('hashchange', function() {
  const fromHash = (location.hash || '').replace(/^#/, '');
  if (TABS.includes(fromHash)) setActiveTab(fromHash);
});

function showLogin() {
  document.getElementById('login-page').classList.remove('hidden');
  document.getElementById('admin-page').classList.add('hidden');
  stopAllPolling();
}

function logout() {
  localStorage.removeItem('admin_token');
  token = null;
  showLogin();
}

async function showAdmin() {
  document.getElementById('login-page').classList.add('hidden');
  document.getElementById('admin-page').classList.remove('hidden');
  setActiveTab(getInitialTab());
}

async function loadRunnerMode() {
  try {
    const res = await api('/api/runner-mode');
    const data = await res.json();
    renderRunnerMode(data);
  } catch (err) {
    console.error('loadRunnerMode failed:', err);
  }
}

function renderRunnerMode(data) {
  const badge = document.getElementById('runner-mode-badge');
  const sourceEl = document.getElementById('runner-mode-source');
  const warning = document.getElementById('runner-mode-env-warning');
  const modeClasses = { default: 'mode-default', gha: 'mode-gha', fly: 'mode-fly', shadow: 'mode-shadow' };
  badge.className = 'badge ' + (modeClasses[data.mode] || '');
  badge.textContent = data.mode;
  const sourceLabels = { env: 'env var (locked)', db: 'db', default: 'default' };
  sourceEl.textContent = '(' + (sourceLabels[data.source] || data.source) + ')';
  if (data.source === 'env') {
    warning.classList.remove('hidden');
  } else {
    warning.classList.add('hidden');
  }
  // Highlight active mode button; disable buttons when locked by env var
  for (const m of ['default', 'gha', 'fly', 'shadow']) {
    const btn = document.getElementById('btn-mode-' + m);
    if (!btn) continue;
    btn.classList.toggle('active-mode', data.mode === m);
    btn.disabled = data.source === 'env';
  }
  setLastUpdated('lu-runner');
}

async function setRunnerMode(mode) {
  try {
    const res = await api('/api/runner-mode', { method: 'POST', body: JSON.stringify({ mode }) });
    const data = await res.json();
    renderRunnerMode(data);
  } catch (err) {
    console.error('setRunnerMode failed:', err);
  }
}

async function loadSettings() {
  try {
    const res = await api('/api/settings');
    const data = await res.json();
    const appInfo = data.flySessionsApp;
    const regionInfo = data.flySessionsRegion;
    const appInput = document.getElementById('settings-sessions-app');
    const regionInput = document.getElementById('settings-sessions-region');
    const sourceEl = document.getElementById('settings-sessions-app-source');
    const envWarn = document.getElementById('settings-env-warning');
    appInput.value = appInfo.dbValue || '';
    regionInput.value = regionInfo.dbValue || '';
    const overridden = appInfo.overriddenByEnv || regionInfo.overriddenByEnv;
    envWarn.classList.toggle('hidden', !overridden);
    const srcText = appInfo.runtimeValue
      ? ('Active: ' + esc(appInfo.runtimeValue) + (appInfo.overriddenByEnv ? ' (from env var)' : ' (from DB)'))
      : 'Not configured — add a sessions app name to enable Fly dispatch';
    sourceEl.textContent = srcText;
  } catch (err) {
    console.error('loadSettings failed:', err);
  }
}

async function saveSessionsApp() {
  const val = document.getElementById('settings-sessions-app').value.trim() || null;
  await saveSettings({ flySessionsApp: val });
}

async function saveSessionsRegion() {
  const val = document.getElementById('settings-sessions-region').value.trim() || null;
  await saveSettings({ flySessionsRegion: val });
}

async function saveSettings(payload) {
  const errEl = document.getElementById('settings-error');
  errEl.classList.add('hidden');
  try {
    const res = await api('/api/settings', { method: 'POST', body: JSON.stringify(payload) });
    const data = await res.json();
    if (!res.ok) { errEl.textContent = data.error || 'Failed to save settings.'; errEl.classList.remove('hidden'); return; }
    const noticeEl = document.getElementById('settings-restart-notice');
    noticeEl.classList.toggle('hidden', !data.restartRequired);
    await loadSettings();
  } catch (err) {
    errEl.textContent = String(err);
    errEl.classList.remove('hidden');
  }
}

async function loadGlobalSecrets() {
  const tbody = document.getElementById('global-secrets-body');
  const empty = document.getElementById('global-secrets-empty');
  const table = document.getElementById('global-secrets-table');
  const warn503 = document.getElementById('global-secrets-503');
  try {
    const res = await api('/api/global-secrets');
    if (res.status === 503) {
      warn503.classList.remove('hidden');
      table.classList.add('hidden');
      empty.classList.add('hidden');
      return;
    }
    warn503.classList.add('hidden');
    table.classList.remove('hidden');
    const data = await res.json();
    tbody.innerHTML = '';
    if (data.length === 0) {
      empty.classList.remove('hidden');
    } else {
      empty.classList.add('hidden');
      for (const s of data) {
        const tr = document.createElement('tr');
        const dt = s.createdAt ? new Date(s.createdAt).toLocaleString() : '—';
        tr.innerHTML = '<td class="mono">' + esc(s.name) + '</td>'
          + '<td style="color:#888;font-size:0.85em">' + dt + '</td>'
          + '<td><button class="sm danger" data-name="' + esc(s.name) + '" onclick="deleteGlobalSecret(this.dataset.name)">Delete</button></td>';
        tbody.appendChild(tr);
      }
    }
  } catch (err) {
    console.error('loadGlobalSecrets failed:', err);
  }
}

async function addGlobalSecret() {
  const nameEl = document.getElementById('gs-name');
  const valEl = document.getElementById('gs-value');
  const errEl = document.getElementById('gs-error');
  const name = nameEl.value.trim().toUpperCase();
  const value = valEl.value;
  errEl.classList.add('hidden');
  if (!name || !value) { errEl.textContent = 'Name and value are required.'; errEl.classList.remove('hidden'); return; }
  try {
    const res = await api('/api/global-secrets', { method: 'POST', body: JSON.stringify({ name, value }) });
    const data = await res.json();
    if (!res.ok) { errEl.textContent = data.error || 'Failed to add secret.'; errEl.classList.remove('hidden'); return; }
    nameEl.value = '';
    valEl.value = '';
    await loadGlobalSecrets();
  } catch (err) {
    errEl.textContent = String(err);
    errEl.classList.remove('hidden');
  }
}

async function deleteGlobalSecret(name) {
  if (!confirm('Delete secret ' + name + '? This cannot be undone.')) return;
  const errEl = document.getElementById('gs-error');
  errEl.classList.add('hidden');
  try {
    const res = await api('/api/global-secrets/' + encodeURIComponent(name), { method: 'DELETE' });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      errEl.textContent = data.error || 'Failed to delete secret.';
      errEl.classList.remove('hidden');
      return;
    }
    await loadGlobalSecrets();
  } catch (err) {
    errEl.textContent = String(err);
    errEl.classList.remove('hidden');
  }
}

async function loadLog() {
  try {
    const res = await api('/api/log');
    const data = await res.json();
    const tbody = document.getElementById('log-body');
    const empty = document.getElementById('log-empty');
    tbody.innerHTML = '';
    if (data.length === 0) { empty.classList.remove('hidden'); setLastUpdated('lu-log'); return; }
    empty.classList.add('hidden');

    const statusColors = {unknown:'#bdc3c7',dispatched:'#95a5a6',running:'#3498db',completed:'#2ecc71',failed:'#e74c3c',timed_out:'#f39c12'};
    const execColors = {gha:'#27ae60',fly:'#8e44ad',plan:'#2980b9'};

    function makeBadge(color, text) {
      return '<span class="badge" style="background:' + color + ';color:#fff">' + esc(text) + '</span>';
    }
    function statusBadge(status) {
      return makeBadge(statusColors[status] || '#95a5a6', status || 'dispatched');
    }
    function execBadge(mode, runnerMode) {
      const short = mode === 'fly-machines' ? 'fly' : mode === 'planning' ? 'plan' : 'gha';
      return makeBadge(execColors[short] || '#7f8c8d', short)
        + (short !== 'plan' && runnerMode ? ' <span style="color:#888;font-size:0.85em">(' + esc(runnerMode) + ')</span>' : '');
    }

    // Group planning + implement phases that belong to the same job:
    // a planning dispatch (dn=N) followed by an implement dispatch (dn=N+1) for the same issue.
    const consumed = new Set();
    const grouped = [];
    for (let i = 0; i < data.length; i++) {
      if (consumed.has(i)) continue;
      const e = data[i];
      if (e.executionMode !== 'planning') {
        const dn = e.dispatchNumber || 1;
        const planIdx = data.findIndex((p, j) =>
          !consumed.has(j) && j !== i &&
          p.issueId === e.issueId &&
          p.executionMode === 'planning' &&
          (p.dispatchNumber || 1) === dn - 1
        );
        if (planIdx !== -1) {
          grouped.push({ type: 'group', plan: data[planIdx], impl: e });
          consumed.add(i);
          consumed.add(planIdx);
          continue;
        }
      }
      grouped.push({ type: 'single', entry: e });
      consumed.add(i);
    }

    for (const item of grouped) {
      const tr = document.createElement('tr');
      if (item.type === 'group') {
        const { plan, impl } = item;
        const dt = new Date(plan.dispatchedAt).toLocaleString();
        const issueLabel = (impl.issueIdentifier || impl.issueId) + (impl.issueTitle ? ': ' + esc(impl.issueTitle) : '');
        const dn = plan.dispatchNumber || 1;
        const isRedispatch = dn > 1;
        if (isRedispatch) tr.style.backgroundColor = '#fff3cd';
        const dnBadge = isRedispatch
          ? '<span style="color:#d63384;font-weight:bold" title="Re-dispatch">' + dn + '</span>'
          : '' + dn;
        const runnerCell = execBadge('planning') + ' <span style="color:#aaa">→</span> ' + execBadge(impl.executionMode, impl.runnerMode);
        const imageCell = impl.sessionImage
          ? '<td class="mono" title="' + esc(impl.sessionImage) + '">' + esc(impl.sessionImage.split('/').pop()) + '</td>'
          : '<td style="color:#aaa">\\u2014</td>';
        const combinedStatus = statusBadge(plan.status) + ' <span style="color:#aaa;font-size:0.8em">→</span> ' + statusBadge(impl.status);
        const prLink = impl.prUrl ? '<a href="' + esc(impl.prUrl) + '" target="_blank">View</a>' : '—';
        tr.innerHTML = '<td style="white-space:nowrap">' + dt + '</td>'
          + '<td style="text-align:center">' + dnBadge + '</td>'
          + '<td class="mono">' + issueLabel + '</td>'
          + '<td class="mono">' + esc(impl.issueState || '—') + '</td>'
          + '<td class="mono">' + esc(impl.teamKey || '—') + '</td>'
          + '<td class="mono">' + esc(impl.repo || '—') + '</td>'
          + '<td>' + runnerCell + '</td>'
          + imageCell
          + '<td>' + combinedStatus + '</td>'
          + '<td>' + prLink + '</td>';
      } else {
        const e = item.entry;
        const dt = new Date(e.dispatchedAt).toLocaleString();
        const issueLabel = (e.issueIdentifier || e.issueId) + (e.issueTitle ? ': ' + esc(e.issueTitle) : '');
        const dn = e.dispatchNumber || 1;
        const isRedispatch = dn > 1;
        if (isRedispatch) tr.style.backgroundColor = '#fff3cd';
        const dnBadge = isRedispatch
          ? '<span style="color:#d63384;font-weight:bold" title="Re-dispatch">' + dn + '</span>'
          : '' + dn;
        const runnerCell = execBadge(e.executionMode, e.runnerMode);
        const imageCell = e.sessionImage
          ? '<td class="mono" title="' + esc(e.sessionImage) + '">' + esc(e.sessionImage.split('/').pop()) + '</td>'
          : '<td style="color:#aaa">\\u2014</td>';
        tr.innerHTML = '<td style="white-space:nowrap">' + dt + '</td>'
          + '<td style="text-align:center">' + dnBadge + '</td>'
          + '<td class="mono">' + issueLabel + '</td>'
          + '<td class="mono">' + esc(e.issueState || '—') + '</td>'
          + '<td class="mono">' + esc(e.teamKey || '—') + '</td>'
          + '<td class="mono">' + esc(e.repo || '—') + '</td>'
          + '<td>' + runnerCell + '</td>'
          + imageCell
          + '<td>' + statusBadge(e.status) + '</td>'
          + '<td>' + (e.prUrl ? '<a href="' + esc(e.prUrl) + '" target="_blank">View</a>' : '—') + '</td>';
      }
      tbody.appendChild(tr);
    }
    setLastUpdated('lu-log');
  } catch (err) {
    console.error('loadLog failed:', err);
  }
}

async function loadMappings() {
  const res = await api('/api/mappings');
  mappingsData = await res.json();
  const tbody = document.getElementById('mappings-body');
  tbody.innerHTML = '';
  for (const [key, m] of Object.entries(mappingsData)) {
    const tr = document.createElement('tr');
    const ek = esc(key);
    const execBadge = m.executionMode === 'fly-machines'
      ? '<span class="badge" style="background:#9b59b6;color:#fff">fly</span>'
      : '<span class="badge" style="background:#27ae60;color:#fff">gha</span>';
    const planBadge = m.planningEnabled
      ? '<span class="badge" style="background:#3498db;color:#fff">on</span>'
      : '<span style="color:#aaa">off</span>';
    const providerBadge = m.provider === 'bedrock'
      ? '<span class="badge" style="background:#e67e22;color:#fff">bedrock</span>'
      : '<span style="color:#888;font-size:0.85em">anthropic</span>';
    tr.innerHTML = '<td class="mono">' + ek + '</td>'
      + '<td class="mono">' + esc(m.owner) + '/' + esc(m.repo) + '</td>'
      + '<td>' + execBadge + '</td>'
      + '<td style="color:#666;font-size:0.85em">' + esc(m.sessionMode || 'autonomous') + '</td>'
      + '<td style="text-align:center">' + esc(String(m.maxInProgressAiIssues ?? 3)) + '</td>'
      + '<td>' + planBadge + '</td>'
      + '<td>' + providerBadge + '</td>'
      + '<td style="white-space:nowrap">'
        + '<button class="sm" data-key="' + ek + '" onclick="openMappingDialog(this.dataset.key)">Edit</button> '
        + '<button class="sm danger" data-key="' + ek + '" onclick="delMapping(this.dataset.key)">Del</button> '
        + '<button class="sm secondary" data-key="' + ek + '" onclick="showSecrets(this.dataset.key)">Secrets</button>'
      + '</td>';
    tbody.appendChild(tr);
  }
}

function openMappingDialog(key) {
  const isNew = !key;
  document.getElementById('md-title').textContent = isNew ? 'Add Mapping' : 'Edit Mapping: ' + key;
  document.getElementById('md-team-key-orig').value = key || '';
  document.getElementById('md-team-key').disabled = !isNew;
  document.getElementById('md-error').classList.add('hidden');

  const m = key ? (mappingsData[key] || {}) : {};
  document.getElementById('md-team-key').value = key || '';
  document.getElementById('md-owner').value = m.owner || '';
  document.getElementById('md-repo').value = m.repo || '';
  document.getElementById('md-wf').value = m.workflowFile || 'claude-implement.yml';
  document.getElementById('md-branch').value = m.defaultBranch || 'main';
  document.getElementById('md-max-ai').value = String(m.maxInProgressAiIssues ?? 3);
  document.getElementById('md-exec-mode').value = m.executionMode || 'github-actions';
  document.getElementById('md-session-mode').value = m.sessionMode || 'autonomous';
  document.getElementById('md-cpus').value = String(m.machineCpus ?? 2);
  document.getElementById('md-mem').value = String(m.machineMemoryMb ?? 4096);
  document.getElementById('md-env').value = envToText(m.extraEnv);
  document.getElementById('md-planning').checked = !!m.planningEnabled;
  document.getElementById('md-auto-approve').checked = m.autoApprovePlans !== false;
  document.getElementById('md-planning-wf').value = m.planningWorkflowFile || 'claude-plan.yml';
  document.getElementById('md-provider').value = m.provider || 'anthropic';
  document.getElementById('md-aws-region').value = m.awsRegion || '';

  onExecModeChange();
  onProviderChange();
  onPlanningChange();

  document.getElementById('mapping-dialog').showModal();
}

function closeMappingDialog() {
  document.getElementById('mapping-dialog').close();
}

function onExecModeChange() {
  const isFly = document.getElementById('md-exec-mode').value === 'fly-machines';
  document.getElementById('md-fly-fields').classList.toggle('hidden', !isFly);
}

function onProviderChange() {
  const isBedrock = document.getElementById('md-provider').value === 'bedrock';
  document.getElementById('md-aws-region-wrap').classList.toggle('hidden', !isBedrock);
}

function onPlanningChange() {
  const enabled = document.getElementById('md-planning').checked;
  document.getElementById('md-planning-wf-wrap').classList.toggle('hidden', !enabled);
}

async function saveMappingDialog() {
  const errEl = document.getElementById('md-error');
  errEl.classList.add('hidden');

  const origKey = document.getElementById('md-team-key-orig').value;
  const isNew = !origKey;
  const teamKey = isNew ? document.getElementById('md-team-key').value.trim() : origKey;

  const body = {
    teamKey,
    owner: document.getElementById('md-owner').value.trim(),
    repo: document.getElementById('md-repo').value.trim(),
    workflowFile: document.getElementById('md-wf').value.trim(),
    defaultBranch: document.getElementById('md-branch').value.trim(),
    maxInProgressAiIssues: parseInt(document.getElementById('md-max-ai').value, 10),
    executionMode: document.getElementById('md-exec-mode').value,
    sessionMode: document.getElementById('md-session-mode').value,
    machineCpus: parseInt(document.getElementById('md-cpus').value, 10),
    machineMemoryMb: parseInt(document.getElementById('md-mem').value, 10),
    planningEnabled: document.getElementById('md-planning').checked,
    autoApprovePlans: document.getElementById('md-auto-approve').checked,
    planningWorkflowFile: document.getElementById('md-planning-wf').value.trim(),
    extraEnv: parseEnvText(document.getElementById('md-env').value),
    provider: document.getElementById('md-provider').value,
    awsRegion: document.getElementById('md-aws-region').value.trim() || null,
  };

  if (!body.teamKey || !body.owner || !body.repo) {
    errEl.textContent = 'Team Key, Owner, and Repo are required.';
    errEl.classList.remove('hidden');
    return;
  }
  if (!Number.isFinite(body.maxInProgressAiIssues) || body.maxInProgressAiIssues < 1) {
    errEl.textContent = 'Max AI Issues must be a positive integer.';
    errEl.classList.remove('hidden');
    return;
  }
  if (body.provider === 'bedrock' && body.executionMode === 'fly-machines') {
    errEl.textContent = 'Bedrock provider is not supported with fly-machines execution mode.';
    errEl.classList.remove('hidden');
    return;
  }
  if (body.provider === 'bedrock' && !body.awsRegion) {
    errEl.textContent = 'AWS Region is required when provider is bedrock.';
    errEl.classList.remove('hidden');
    return;
  }
  if (body.planningEnabled && !body.planningWorkflowFile) {
    errEl.textContent = 'Planning Workflow File is required when planning is enabled.';
    errEl.classList.remove('hidden');
    return;
  }

  const res = await api('/api/mappings', { method: 'POST', body: JSON.stringify(body) });
  if (!res.ok) {
    const msg = await res.text().catch(() => 'Unknown error');
    errEl.textContent = 'Server error: ' + msg;
    errEl.classList.remove('hidden');
    return;
  }
  closeMappingDialog();
  await loadMappings();
}

async function delMapping(key) {
  if (!confirm('Delete mapping for ' + key + '?')) return;
  await api('/api/mappings/' + encodeURIComponent(key), { method: 'DELETE' });
  if (currentSecretsTeam === key) {
    document.getElementById('secrets-panel').classList.add('hidden');
    currentSecretsTeam = null;
  }
  await loadMappings();
}

async function loadDedup() {
  try {
    const res = await api('/api/dedup');
    const data = await res.json();
    const countEl = document.getElementById('dedup-count');
    if (countEl) countEl.textContent = '(' + (Array.isArray(data) ? data.length : 0) + ')';
    const tbody = document.getElementById('dedup-body');
    const empty = document.getElementById('dedup-empty');
    tbody.innerHTML = '';
    if (data.length === 0) { empty.classList.remove('hidden'); setLastUpdated('lu-dedup'); return; }
    empty.classList.add('hidden');
    for (const e of data) {
      const tr = document.createElement('tr');
      const dt = new Date(e.dispatchedAt).toLocaleString();
      const issueLabel = (e.issueIdentifier || e.issueId) + (e.issueTitle ? ': ' + e.issueTitle : '');
      tr.innerHTML = '<td><span class="mono">' + esc(issueLabel) + '</span></td>'
        + '<td>' + dt + '</td>'
        + '<td><button class="danger" data-issue-id="' + esc(e.issueId) + '" onclick="delDedup(this.dataset.issueId)">Delete</button></td>';
      tbody.appendChild(tr);
    }
    setLastUpdated('lu-dedup');
  } catch (err) {
    console.error('loadDedup failed:', err);
  }
}

async function delDedup(id) {
  await api('/api/dedup/' + encodeURIComponent(id), { method: 'DELETE' });
  await loadDedup();
}

function fmtDuration(ms) {
  const s = Math.floor(ms / 1000);
  if (s < 60) return s + 's';
  const m = Math.floor(s / 60);
  if (m < 60) return m + 'm ' + (s % 60) + 's';
  const h = Math.floor(m / 60);
  return h + 'h ' + (m % 60) + 'm';
}

// Track machines destroyed via the UI so we can filter them out of subsequent
// loadSessions() calls until Fly's API catches up. Entries expire after 60s.
const destroyedMachineIds = new Map();

function pruneDestroyed() {
  const now = Date.now();
  for (const [id, ts] of destroyedMachineIds) {
    if (now - ts > 60000) destroyedMachineIds.delete(id);
  }
}

async function loadSessions() {
  try {
    pruneDestroyed();
    const res = await api('/api/sessions');
    const raw = await res.json();
    const data = Array.isArray(raw) ? raw.filter((s) => !destroyedMachineIds.has(s.machineId)) : [];
    const tbody = document.getElementById('sessions-body');
    const empty = document.getElementById('sessions-empty');
    tbody.innerHTML = '';
    if (data.length === 0) {
      empty.classList.remove('hidden');
      setLastUpdated('lu-sessions');
      return;
    }
    empty.classList.add('hidden');
    for (const s of data) {
      const tr = document.createElement('tr');
      const createdMs = s.createdAt ? new Date(s.createdAt).getTime() : (s.dispatchedAt || Date.now());
      const duration = fmtDuration(Date.now() - createdMs);
      const issueLabel = s.issueIdentifier
        ? (s.issueTitle ? s.issueIdentifier + ': ' + s.issueTitle : s.issueIdentifier)
        : '—';
      const issueHtml = s.issueIdentifier
        ? '<a href="https://linear.app/issue/' + esc(s.issueIdentifier) + '" target="_blank">' + esc(issueLabel) + '</a>'
        : '<span class="mono">—</span>';
      tr.innerHTML = '<td>' + issueHtml + '</td>'
        + '<td class="mono">' + esc(s.teamKey || '—') + '</td>'
        + '<td class="mono">' + esc(s.repo || '—') + '</td>'
        + '<td class="mono" title="' + esc(s.machineId) + '">' + esc(s.machineName || s.machineId.slice(0, 10)) + '</td>'
        + '<td>' + esc(s.state) + '</td>'
        + '<td>' + duration + '</td>'
        + '<td><button class="sm danger" data-mid="' + esc(s.machineId) + '" onclick="destroySession(this.dataset.mid)">Destroy</button></td>';
      tbody.appendChild(tr);
    }
    setLastUpdated('lu-sessions');
  } catch (err) {
    console.error('loadSessions failed:', err);
  }
}

async function destroySession(machineId) {
  if (!confirm('Destroy machine ' + machineId + '? This will also reset the Linear issue.')) return;

  // Mark as destroyed so loadSessions() filters it out even if Fly's API
  // still reports it as active for a while.
  destroyedMachineIds.set(machineId, Date.now());

  try {
    await api('/api/sessions/' + encodeURIComponent(machineId), { method: 'DELETE' });
  } catch (err) {
    console.error('destroy failed:', err);
    destroyedMachineIds.delete(machineId);
    alert('Failed to destroy machine. Reloading list.');
  }

  await Promise.all([loadSessions(), loadLog()]);
}

// ── Secrets management ─────────────────────────────────────────────────────

let currentSecretsTeam = null;

async function showSecrets(teamKey) {
  currentSecretsTeam = teamKey;
  document.getElementById('secrets-team-key').textContent = teamKey;
  document.getElementById('secrets-panel').classList.remove('hidden');
  document.getElementById('secrets-error').classList.add('hidden');
  document.getElementById('s-name').value = '';
  document.getElementById('s-value').value = '';
  await loadSecrets();
}

async function loadSecrets() {
  if (!currentSecretsTeam) return;
  const tbody = document.getElementById('secrets-body');
  const empty = document.getElementById('secrets-empty');
  tbody.innerHTML = '';
  try {
    const res = await api('/api/mappings/' + encodeURIComponent(currentSecretsTeam) + '/secrets');
    if (res.status === 503) {
      empty.classList.remove('hidden');
      empty.textContent = 'Fly sessions not configured — secrets management unavailable.';
      return;
    }
    const data = await res.json();
    if (!Array.isArray(data) || data.length === 0) {
      empty.classList.remove('hidden');
      empty.textContent = 'No secrets set for this team.';
      return;
    }
    empty.classList.add('hidden');
    for (const s of data) {
      const tr = document.createElement('tr');
      tr.innerHTML = '<td class="mono">' + esc(s.name) + '</td>'
        + '<td><span class="badge active">Set</span></td>'
        + '<td><button class="sm danger" data-name="' + esc(s.name) + '" onclick="delSecret(this.dataset.name)">Delete</button></td>';
      tbody.appendChild(tr);
    }
  } catch (err) {
    console.error('loadSecrets failed:', err);
  }
}

async function addSecret() {
  const name = document.getElementById('s-name').value.trim().toUpperCase();
  const value = document.getElementById('s-value').value;
  const errEl = document.getElementById('secrets-error');
  const btn = document.getElementById('btn-add-secret');
  errEl.classList.add('hidden');
  if (!name || !value) { errEl.textContent = 'Name and value are required.'; errEl.classList.remove('hidden'); return; }
  if (!/^[A-Z0-9_]+$/.test(name)) { errEl.textContent = 'Name must contain only letters, digits, and underscores.'; errEl.classList.remove('hidden'); return; }
  if (btn) btn.disabled = true;
  try {
    const res = await api('/api/mappings/' + encodeURIComponent(currentSecretsTeam) + '/secrets', {
      method: 'POST',
      body: JSON.stringify({ name, value }),
    });
    if (!res.ok) {
      const data = await res.json();
      errEl.textContent = data.error || 'Failed to set secret.';
      errEl.classList.remove('hidden');
      return;
    }
    document.getElementById('s-name').value = '';
    document.getElementById('s-value').value = '';
    await loadSecrets();
  } catch (err) {
    console.error('addSecret failed:', err);
  } finally {
    if (btn) btn.disabled = false;
  }
}

async function delSecret(name) {
  const errEl = document.getElementById('secrets-error');
  errEl.classList.add('hidden');
  if (!confirm('Delete secret ' + name + ' for team ' + currentSecretsTeam + '?')) return;
  try {
    const res = await api('/api/mappings/' + encodeURIComponent(currentSecretsTeam) + '/secrets/' + encodeURIComponent(name), {
      method: 'DELETE',
    });
    if (!res.ok) {
      const data = await res.json();
      errEl.textContent = data.error || 'Failed to delete secret.';
      errEl.classList.remove('hidden');
      return;
    }
    await loadSecrets();
  } catch (err) {
    console.error('delSecret failed:', err);
    errEl.textContent = 'Failed to delete secret.';
    errEl.classList.remove('hidden');
  }
}

// ── Reaper ─────────────────────────────────────────────────────────────────

async function loadReaper() {
  try {
    const [summaryRes, recentRes] = await Promise.all([
      api('/api/reaper/summary'),
      api('/api/reaper/recent?limit=20'),
    ]);
    const summary = await summaryRes.json();
    const recent = await recentRes.json();
    renderReaper(summary, recent);
    const countEl = document.getElementById('reaper-count');
    if (countEl) countEl.textContent = '(' + (Array.isArray(recent) ? recent.length : 0) + ')';
  } catch (err) {
    console.error('loadReaper failed:', err);
  }
}

function renderReaper(summary, recent) {
  const statusEl = document.getElementById('reaper-status-line');
  if (statusEl) {
    const count = summary.total24h ?? 0;
    const lastSweepStr = summary.lastSweepAt ? fmtAgo(summary.lastSweepAt) : 'never';
    statusEl.textContent = 'Reaper: ' + count + ' destroyed in last 24h \\u00b7 last sweep ' + lastSweepStr;
  }

  const summaryEl = document.getElementById('reaper-summary-block');
  if (summaryEl) {
    const byRule = summary.byRule || {};
    const rules = ['orphan', 'stale-terminal-job', 'max-age-exceeded', 'issue-terminal'];
    let html = '<div style="display:flex;gap:20px;flex-wrap:wrap;font-size:0.9em">';
    html += '<span><b>24h total: ' + (summary.total24h ?? 0) + '</b></span>';
    for (const rule of rules) {
      html += '<span style="color:#555">' + esc(rule) + ': <b>' + (byRule[rule] || 0) + '</b></span>';
    }
    html += '</div>';
    summaryEl.innerHTML = html;
  }

  const tbody = document.getElementById('reaper-body');
  const empty = document.getElementById('reaper-empty');
  if (!tbody || !empty) return;
  tbody.innerHTML = '';
  if (!Array.isArray(recent) || recent.length === 0) {
    empty.classList.remove('hidden');
    setLastUpdated('lu-reaper');
    return;
  }
  empty.classList.add('hidden');
  for (const r of recent) {
    const tr = document.createElement('tr');
    if (r.dryRun) tr.style.backgroundColor = '#f8f9fa';
    const dt = new Date(r.createdAt).toLocaleString();
    const modeBadge = r.dryRun
      ? '<span class="badge" style="background:#6c757d;color:#fff">dry-run</span>'
      : '<span class="badge" style="background:#e74c3c;color:#fff">destroyed</span>';
    tr.innerHTML = '<td style="white-space:nowrap">' + dt + '</td>'
      + '<td class="mono">' + esc(r.ruleMatched) + '</td>'
      + '<td class="mono" title="' + esc(r.machineId) + '">' + esc(r.machineId.slice(0, 12)) + '</td>'
      + '<td class="mono">' + esc(r.tenantId || '\\u2014') + '</td>'
      + '<td class="mono">' + esc(r.issueIdentifier || '\\u2014') + '</td>'
      + '<td>' + (r.ageSeconds != null ? r.ageSeconds : '\\u2014') + '</td>'
      + '<td>' + modeBadge + '</td>';
    tbody.appendChild(tr);
  }
  setLastUpdated('lu-reaper');
}

function fmtAgo(ts) {
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60) return s + 's ago';
  const m = Math.floor(s / 60);
  if (m < 60) return m + 'm ago';
  const h = Math.floor(m / 60);
  return h + 'h ago';
}

function esc(s) { const d = document.createElement('div'); d.textContent = s; return d.innerHTML; }

function parseEnvText(text) {
  const obj = {};
  for (const line of text.split('\\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const idx = trimmed.indexOf('=');
    if (idx < 1) continue;
    obj[trimmed.slice(0, idx).trim()] = trimmed.slice(idx + 1);
  }
  return obj;
}

function envToText(env) {
  if (!env || typeof env !== 'object') return '';
  return Object.entries(env).map(([k, v]) => k + '=' + v).join('\\n');
}
</script>
</body>
</html>`;
