export const settingsHtml = `
<section data-page="settings" hidden>
  <header class="page-header">
    <div class="page-header-left">
      <h1 class="page-title">Settings</h1>
      <div class="page-subtitle">Sessions app, region, and global machine secrets</div>
    </div>
  </header>
  <div class="page-body">
    <div class="card">
      <div class="card-header"><h2 class="card-title">Fly Sessions App</h2></div>
      <div class="card-body">
        <div id="settings-env-warning" class="warning hidden">&#x26A0; One or more settings are overridden by environment variables. Changes saved here take effect on next restart only if the env var is removed.</div>
        <div class="field">
          <label>Sessions App Name</label>
          <div style="display:flex;gap:6px">
            <input class="input" id="settings-sessions-app" placeholder="e.g. my-ai-implement-sessions" style="flex:1">
            <button class="btn btn-primary btn-sm" onclick="saveSessionsApp()">Save</button>
          </div>
          <div id="settings-sessions-app-source" class="text-tertiary" style="font-size:11px;margin-top:3px"></div>
        </div>
        <div class="field">
          <label>Sessions Region (optional)</label>
          <div style="display:flex;gap:6px">
            <input class="input" id="settings-sessions-region" placeholder="e.g. iad" style="flex:1">
            <button class="btn btn-primary btn-sm" onclick="saveSessionsRegion()">Save</button>
          </div>
        </div>
        <div id="settings-restart-notice" class="warning hidden">&#x25B6; Restart the orchestrator for these changes to take effect.</div>
        <div id="settings-error" class="error hidden"></div>
      </div>
    </div>

    <div class="card">
      <div class="card-header"><h2 class="card-title">Global Machine Secrets</h2></div>
      <div class="card-body">
        <p class="text-secondary" style="margin-bottom:12px">Secrets stored on the Fly sessions app and injected into every machine as environment variables. Values are write-only &#x2014; set them here instead of using the Fly CLI.</p>
        <div id="global-secrets-503" class="warning hidden">Fly sessions app is not configured &#x2014; configure the Sessions App above first.</div>
        <table class="tbl" id="global-secrets-table">
          <thead><tr><th>Name</th><th>Created</th><th></th></tr></thead>
          <tbody id="global-secrets-body"></tbody>
        </table>
        <div id="global-secrets-empty" class="hidden text-tertiary">No global secrets set.</div>
        <div style="display:flex;gap:6px;align-items:flex-end;flex-wrap:wrap;margin-top:8px">
          <div class="field" style="flex:1;min-width:140px">
            <label>Name</label>
            <input class="input" id="gs-name" placeholder="ANTHROPIC_API_KEY" style="text-transform:uppercase">
          </div>
          <div class="field" style="flex:2;min-width:200px">
            <label>Value</label>
            <input class="input" id="gs-value" type="password" placeholder="sk-ant-...">
          </div>
          <button class="btn btn-primary btn-sm" onclick="addGlobalSecret()" style="align-self:flex-end">Add Secret</button>
        </div>
        <div id="gs-error" class="error hidden"></div>
      </div>
    </div>
  </div>
</section>
`;

export const settingsScript = `
(function () {
  async function loadSettings() {
    try {
      const res = await window.api('/api/settings');
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
        ? ('Active: ' + window.esc(appInfo.runtimeValue) + (appInfo.overriddenByEnv ? ' (from env var)' : ' (from DB)'))
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
  window.saveSessionsApp = saveSessionsApp;

  async function saveSessionsRegion() {
    const val = document.getElementById('settings-sessions-region').value.trim() || null;
    await saveSettings({ flySessionsRegion: val });
  }
  window.saveSessionsRegion = saveSessionsRegion;

  async function saveSettings(payload) {
    const errEl = document.getElementById('settings-error');
    errEl.classList.add('hidden');
    try {
      const res = await window.api('/api/settings', { method: 'POST', body: JSON.stringify(payload) });
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
      const res = await window.api('/api/global-secrets');
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
          tr.innerHTML = '<td class="mono">' + window.esc(s.name) + '</td>'
            + '<td style="color:#888;font-size:0.85em">' + dt + '</td>'
            + '<td><button class="sm danger" data-name="' + window.esc(s.name) + '" onclick="deleteGlobalSecret(this.dataset.name)">Delete</button></td>';
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
      const res = await window.api('/api/global-secrets', { method: 'POST', body: JSON.stringify({ name, value }) });
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
  window.addGlobalSecret = addGlobalSecret;

  async function deleteGlobalSecret(name) {
    if (!confirm('Delete secret ' + name + '? This cannot be undone.')) return;
    const errEl = document.getElementById('gs-error');
    errEl.classList.add('hidden');
    try {
      const res = await window.api('/api/global-secrets/' + encodeURIComponent(name), { method: 'DELETE' });
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
  window.deleteGlobalSecret = deleteGlobalSecret;

  window.registerPage('settings', function () { loadSettings(); loadGlobalSecrets(); });
})();
`;
