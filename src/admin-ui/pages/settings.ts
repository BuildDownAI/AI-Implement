export const settingsHtml = `
<section data-page="settings" hidden>
  <header class="page-header">
    <div class="page-header-left">
      <h1 class="page-title">Settings</h1>
      <div class="page-subtitle">Sessions app, region, retry policy, and global machine secrets</div>
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
      <div class="card-header"><h2 class="card-title">KG Refresh</h2></div>
      <div class="card-body">
        <div class="field">
          <label>Failure Report Issue</label>
          <div style="display:flex;gap:6px">
            <input class="input" id="settings-kg-report-issue" placeholder="e.g. AII-496" style="flex:1">
            <button class="btn btn-primary btn-sm" onclick="saveKgRefreshReportIssue()">Save</button>
          </div>
          <div class="text-tertiary" style="font-size:11px;margin-top:3px">Linear issue identifier that receives a comment on each kg-refresh failure. Leave blank to skip the comment.</div>
        </div>
        <div class="field">
          <label>Base template repo</label>
          <div style="display:flex;gap:6px">
            <input class="input" id="settings-kg-base-repo" placeholder="e.g. BuildDownAI/bd-knowledge-graph-base" style="flex:1">
            <button class="btn btn-primary btn-sm" onclick="saveKgBaseRepo()">Save</button>
          </div>
          <div class="text-tertiary" style="font-size:11px;margin-top:3px">owner/repo watched by the PR-triggered kg-refresh dry-run check, alongside the bound KG source repo. Leave blank to check only the KG source repo.</div>
        </div>
        <div id="settings-kg-error" class="error hidden"></div>
      </div>
    </div>

    <div class="card">
      <div class="card-header"><h2 class="card-title">Retry Policy</h2></div>
      <div class="card-body">
        <p class="text-secondary" style="margin-bottom:12px">Global retry/backoff policy and post-push reviewer turn cap. Blank fields fall back to the default shown as a placeholder.</p>
        <div class="field">
          <label>Request Retries <span class="text-tertiary">(re-spawns of one Claude invocation)</span></label>
          <input class="input" id="rp-requestRetries" type="number" min="0" max="10" step="1">
        </div>
        <div class="field">
          <label>Stage Retries <span class="text-tertiary">(re-runs of a whole implement/review stage)</span></label>
          <input class="input" id="rp-stageRetries" type="number" min="0" max="10" step="1">
        </div>
        <div class="field">
          <label>Push Retries</label>
          <input class="input" id="rp-pushRetries" type="number" min="0" max="10" step="1">
        </div>
        <div class="field">
          <label>Backoff Initial (ms)</label>
          <input class="input" id="rp-backoffInitialMs" type="number" min="1000" max="600000" step="1">
        </div>
        <div class="field">
          <label>Backoff Max (ms)</label>
          <input class="input" id="rp-backoffMaxMs" type="number" min="1000" step="1">
        </div>
        <div class="field">
          <label>Backoff Jitter <span class="text-tertiary">(fraction subtracted, 0 = none, 1 = up to &minus;100%)</span></label>
          <input class="input" id="rp-backoffJitter" type="number" min="0" max="1" step="0.05">
        </div>
        <div class="field">
          <label>Review Max Turns <span class="text-tertiary">(post-push reviewer)</span></label>
          <input class="input" id="rp-reviewMaxTurns" type="number" min="5" max="200" step="1">
        </div>
        <div style="display:flex;gap:6px;margin-top:8px">
          <button class="btn btn-primary btn-sm" onclick="saveRetryPolicy()">Save</button>
          <button class="btn btn-sm" onclick="resetRetryPolicy()">Reset to defaults</button>
        </div>
        <div id="retry-policy-error" class="error hidden"></div>
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
  var RETRY_POLICY_FIELDS = ['requestRetries', 'stageRetries', 'pushRetries', 'backoffInitialMs', 'backoffMaxMs', 'backoffJitter', 'reviewMaxTurns'];

  function populateRetryPolicy(policy, defaults) {
    RETRY_POLICY_FIELDS.forEach(function (field) {
      var input = document.getElementById('rp-' + field);
      if (!input) return;
      input.placeholder = String(defaults[field]);
      input.value = policy && policy[field] !== defaults[field] ? policy[field] : '';
    });
  }

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
      const kgReportInput = document.getElementById('settings-kg-report-issue');
      kgReportInput.value = (data.kgRefreshReportIssue && data.kgRefreshReportIssue.value) || '';
      const kgBaseRepoInput = document.getElementById('settings-kg-base-repo');
      kgBaseRepoInput.value = (data.kgBaseRepo && data.kgBaseRepo.value) || '';
      const overridden = appInfo.overriddenByEnv || regionInfo.overriddenByEnv;
      envWarn.classList.toggle('hidden', !overridden);
      const srcText = appInfo.runtimeValue
        ? ('Active: ' + window.esc(appInfo.runtimeValue) + (appInfo.overriddenByEnv ? ' (from env var)' : ' (from DB)'))
        : 'Not configured — add a sessions app name to enable Fly dispatch';
      sourceEl.textContent = srcText;
      populateRetryPolicy(data.retryPolicy, data.retryPolicyDefaults);
    } catch (err) {
      console.error('loadSettings failed:', err);
    }
  }

  async function saveRetryPolicy() {
    const errEl = document.getElementById('retry-policy-error');
    errEl.classList.add('hidden');
    const patch = {};
    for (const field of RETRY_POLICY_FIELDS) {
      const raw = document.getElementById('rp-' + field).value.trim();
      if (raw === '') continue;
      const num = Number(raw);
      if (!Number.isFinite(num)) { errEl.textContent = field + ' must be a number.'; errEl.classList.remove('hidden'); return; }
      patch[field] = num;
    }
    await saveSettings({ retryPolicy: patch }, errEl);
  }
  window.saveRetryPolicy = saveRetryPolicy;

  async function resetRetryPolicy() {
    const errEl = document.getElementById('retry-policy-error');
    errEl.classList.add('hidden');
    await saveSettings({ retryPolicy: null }, errEl);
  }
  window.resetRetryPolicy = resetRetryPolicy;

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

  async function saveKgRefreshReportIssue() {
    const val = document.getElementById('settings-kg-report-issue').value.trim() || null;
    const errEl = document.getElementById('settings-kg-error');
    errEl.classList.add('hidden');
    try {
      const res = await window.api('/api/settings', { method: 'POST', body: JSON.stringify({ kgRefreshReportIssue: val }) });
      const data = await res.json();
      if (!res.ok) { errEl.textContent = data.error || 'Failed to save setting.'; errEl.classList.remove('hidden'); return; }
      await loadSettings();
    } catch (err) {
      errEl.textContent = String(err);
      errEl.classList.remove('hidden');
    }
  }
  window.saveKgRefreshReportIssue = saveKgRefreshReportIssue;

  async function saveKgBaseRepo() {
    const val = document.getElementById('settings-kg-base-repo').value.trim() || null;
    const errEl = document.getElementById('settings-kg-error');
    errEl.classList.add('hidden');
    try {
      const res = await window.api('/api/settings', { method: 'POST', body: JSON.stringify({ kgBaseRepo: val }) });
      const data = await res.json();
      if (!res.ok) { errEl.textContent = data.error || 'Failed to save setting.'; errEl.classList.remove('hidden'); return; }
      await loadSettings();
    } catch (err) {
      errEl.textContent = String(err);
      errEl.classList.remove('hidden');
    }
  }
  window.saveKgBaseRepo = saveKgBaseRepo;

  async function saveSettings(payload, errEl) {
    errEl = errEl || document.getElementById('settings-error');
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
            + '<td></td>';
          const delSecretBtn = document.createElement('button');
          delSecretBtn.className = 'sm danger';
          delSecretBtn.textContent = 'Delete';
          delSecretBtn.addEventListener('click', function() { deleteGlobalSecret(s.name); });
          tr.lastElementChild.appendChild(delSecretBtn);
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
