export const modelsAndProvidersHtml = `
<section data-page="models" hidden>
  <header class="page-header">
    <div class="page-header-left">
      <h1 class="page-title">Models & providers</h1>
      <div class="page-subtitle" id="mp-subtitle">—</div>
    </div>
    <div class="page-header-actions">
      <button class="btn btn-sm" onclick="loadModelsAndProviders()">↻ Refresh</button>
    </div>
  </header>
  <div class="page-body">
    <div id="mp-error" class="alert fail" hidden></div>

    <div class="alert info">
      <div style="flex:1">
        <div class="alert-title">How models are configured</div>
        <div class="alert-desc">Orchestrator defaults below choose the agent, provider, model, account profile and limit for planning, implementation and review, without a repository change. Projects opt in separately; a legacy project keeps its current behavior, including the model in its <span class="mono">WORKFLOW.md</span> front matter. Saved changes apply to the next run, not to a run already in flight.</div>
      </div>
    </div>

    <div class="card" id="mp-stage-card">
      <div class="card-header">
        <h2 class="card-title">Orchestrator stage defaults</h2>
        <div class="card-subtitle" id="mp-stage-mode">—</div>
      </div>
      <div class="card-body">
        <table class="tbl">
          <thead>
            <tr><th>Stage</th><th>Agent</th><th>Provider</th><th>Model</th><th>Account profile</th><th>Elapsed time limit (ms)</th></tr>
          </thead>
          <tbody id="mp-stage-rows"></tbody>
        </table>
        <div class="text-tertiary" style="font-size:11px;margin-top:6px">Blank fields inherit. The limit is an elapsed time in milliseconds for either agent. Claude turn caps are separate: Max Turns per project, and Review Max Turns under Retry Policy on the Settings page.</div>
        <div id="mp-stage-hints" class="text-tertiary" style="font-size:11px;margin-top:6px"></div>
        <div id="mp-stage-actions" style="display:flex;gap:6px;margin-top:8px">
          <button class="btn btn-primary btn-sm" onclick="saveStageDefaults()">Save</button>
          <button class="btn btn-sm" onclick="resetStageDefaults()">Discard edits</button>
        </div>
        <div id="mp-stage-error" class="error hidden"></div>
      </div>
    </div>

    <div class="card">
      <div class="card-header">
        <h2 class="card-title">Account profiles</h2>
        <div class="card-subtitle">API keys are write-only: you can set or remove one here, but a saved value is never shown.</div>
      </div>
      <div class="card-body tight">
        <table class="tbl">
          <thead>
            <tr><th>Profile</th><th>Identity</th><th>Agent</th><th>Provider</th><th>Authentication</th><th>Permitted projects</th><th>Profile</th><th>Readiness</th><th>Busy / recovery</th><th>API key</th></tr>
          </thead>
          <tbody id="mp-account-rows"></tbody>
        </table>
        <div id="mp-account-empty" class="hidden text-tertiary" style="padding:12px">No account profiles yet. An operator provisions accounts on the host; see the instructions below.</div>
        <div id="mp-account-error" class="error hidden" style="padding:0 12px"></div>
        <div id="mp-account-form" class="hidden" style="padding:12px">
          <h3 style="font-size:13px;margin:0 0 6px">Add account profile</h3>
          <div style="display:flex;gap:6px;flex-wrap:wrap">
            <input class="input" id="mp-new-profileId" placeholder="profileId">
            <input class="input" id="mp-new-identity" placeholder="identity">
            <select class="input" id="mp-new-agent"><option value="claude">claude</option><option value="codex">codex</option></select>
            <select class="input" id="mp-new-provider"><option value="anthropic">anthropic</option><option value="openai">openai</option><option value="bedrock">bedrock</option></select>
            <select class="input" id="mp-new-authMode"><option value="anthropic-api-key">anthropic-api-key</option><option value="openai-api-key">openai-api-key</option><option value="codex-subscription">codex-subscription</option><option value="claude-subscription">claude-subscription</option><option value="bedrock">bedrock</option></select>
            <input class="input" id="mp-new-allowedProjectKeys" placeholder="allowed project keys (comma-separated)">
            <button class="btn btn-primary btn-sm" onclick="mpAddAccount()">Add account profile</button>
          </div>
        </div>
        <div class="text-tertiary" style="font-size:11.5px;padding:12px">
          <div><strong>Provisioning.</strong> Add a profile above and set an API key per profile; a key is encrypted on save and never shown again. Subscription sign-ins and Bedrock credentials are provisioned on the host.</div>
          <div>ChatGPT plan, <em>sign-in required</em> or <em>missing</em>: run <span class="mono">node dist/chatgpt-plan-login.js login</span>, or import an existing sign-in with <span class="mono">chatgpt-import</span>.</div>
          <div>Readiness is checked against the profile's first permitted project, so a profile with no permitted project shows <em>unknown</em>; that is not a credential fault.</div>
        </div>
      </div>
    </div>

    <div class="kpi-grid" id="mp-kpis" hidden>
      <div class="kpi"><div class="kpi-label">Projects</div><div class="kpi-value" id="kpi-mp-projects">0</div></div>
      <div class="kpi"><div class="kpi-label">Anthropic</div><div class="kpi-value" id="kpi-mp-anthropic">0</div></div>
      <div class="kpi"><div class="kpi-label">Bedrock</div><div class="kpi-value" id="kpi-mp-bedrock">0</div></div>
      <div class="kpi"><div class="kpi-label">Bedrock regions</div><div class="kpi-value" id="kpi-mp-regions">0</div></div>
    </div>

    <div class="card">
      <div class="card-header">
        <h2 class="card-title">Per-project providers</h2>
        <div class="card-subtitle">Edit a row's provider on the Projects page.</div>
      </div>
      <div class="card-body tight">
        <table class="tbl">
          <thead>
            <tr><th>Team</th><th>Repo</th><th>Provider</th><th>Region</th><th>Planning</th><th>Runner</th></tr>
          </thead>
          <tbody id="mp-rows"></tbody>
        </table>
        <div id="mp-empty" class="hidden text-tertiary" style="padding:12px">No projects configured. Add one on the Projects page.</div>
      </div>
    </div>
  </div>
</section>`;

export const modelsAndProvidersScript = `(function () {
  const MP_STAGES = ['planning', 'implementation', 'review'];
  const MP_AGENTS = ['claude', 'codex'];
  const MP_PROVIDERS = ['anthropic', 'bedrock', 'openai'];
  let mpDefaults = { mode: 'legacy', stages: {} };
  let mpAccounts = [];
  let mpDirty = false;

  function mpCanEdit() {
    return typeof window.isAdmin === 'function' && window.isAdmin();
  }

  function mpAuthLabel(authMode) {
    return authMode === 'codex-subscription' ? 'ChatGPT plan' : String(authMode || '');
  }

  function mpReadinessLabel(r) {
    if (r === 'refresh failed (transient)') return 'refresh failed';
    return r || 'unknown';
  }

  function mpReadinessKind(label) {
    if (label === 'ready') return 'success';
    if (label === 'unknown') return 'neutral';
    return 'fail';
  }

  async function mpErrorText(res, fallback) {
    try {
      const data = await res.json();
      if (data && data.error) return fallback + ': ' + data.error;
    } catch (_) {}
    return fallback + ' (HTTP ' + res.status + ')';
  }

  function mpShowStageError(msg) {
    const el = document.getElementById('mp-stage-error');
    if (!el) return;
    el.textContent = msg || '';
    el.classList.toggle('hidden', !msg);
  }

  function mpOptions(values, current, labelOf) {
    let html = '<option value="">(inherit)</option>';
    const all = values.slice();
    if (current && all.indexOf(current) === -1) all.push(current);
    for (const v of all) {
      html += '<option value="' + window.escAttr(v) + '"' + (v === current ? ' selected' : '') + '>' + window.esc(labelOf ? labelOf(v) : v) + '</option>';
    }
    return html;
  }

  function mpCompatibleProfiles(agent, provider) {
    return mpAccounts.filter(function (a) {
      if (a.profileStatus && a.profileStatus !== 'active') return false;
      if (agent && a.agent !== agent) return false;
      if (provider && a.provider !== provider) return false;
      return true;
    });
  }

  function mpProfileSelect(stage, agent, provider, current) {
    const list = mpCompatibleProfiles(agent, provider);
    let html = '<select class="input" data-stage="' + window.escAttr(stage) + '" data-field="accountProfileId"' + (mpCanEdit() ? '' : ' disabled') + '><option value="">(inherit)</option>';
    let seen = false;
    for (const a of list) {
      if (a.profileId === current) seen = true;
      html += '<option value="' + window.escAttr(a.profileId) + '"' + (a.profileId === current ? ' selected' : '') + '>' + window.esc(a.identity + ' (' + a.profileId + ', ' + mpAuthLabel(a.authMode) + ')') + '</option>';
    }
    if (current && !seen) {
      html += '<option value="' + window.escAttr(current) + '" selected>' + window.esc(current + ' (not compatible or not active)') + '</option>';
    }
    return html + '</select>';
  }

  function mpReadForm() {
    const stages = {};
    for (const stage of MP_STAGES) {
      const patch = {};
      for (const el of document.querySelectorAll('#mp-stage-rows [data-stage="' + stage + '"]')) {
        const field = el.getAttribute('data-field');
        const raw = String(el.value || '').trim();
        if (raw === '') { patch[field] = null; continue; }
        if (field === 'invocationTimeoutMs') {
          const n = Number(raw);
          if (!Number.isSafeInteger(n) || n <= 0) return { error: stage + ': the elapsed time limit must be a positive whole number of milliseconds.' };
          patch[field] = n;
        } else {
          patch[field] = raw;
        }
      }
      stages[stage] = patch;
    }
    return { stages: stages };
  }

  function mpSnapshotForm() {
    const snap = {};
    for (const el of document.querySelectorAll('#mp-stage-rows [data-stage]')) {
      snap[el.getAttribute('data-stage') + '.' + el.getAttribute('data-field')] = el.value;
    }
    return snap;
  }

  function mpRenderStages() {
    const rowsEl = document.getElementById('mp-stage-rows');
    const stages = (mpDefaults && mpDefaults.stages) || {};
    const edit = mpCanEdit();
    const dis = edit ? '' : ' disabled';
    const hints = [];
    let html = '';
    for (const stage of MP_STAGES) {
      const sel = stages[stage] || {};
      const limit = sel.invocationTimeoutMs === null || sel.invocationTimeoutMs === undefined ? '' : String(sel.invocationTimeoutMs);
      const attr = 'data-stage="' + window.escAttr(stage) + '"';
      if (mpCompatibleProfiles(sel.agent || '', sel.provider || '').length === 0) {
        hints.push(stage + ': no compatible active account profile' + (sel.agent || sel.provider ? ' for ' + [sel.agent, sel.provider].filter(Boolean).join('/') : '') + '. Provision one on the host or change the agent or provider.');
      }
      html += '<tr>' +
        '<td><span class="mono">' + window.esc(stage) + '</span></td>' +
        '<td><select class="input" ' + attr + ' data-field="agent"' + dis + '>' + mpOptions(MP_AGENTS, sel.agent || '') + '</select></td>' +
        '<td><select class="input" ' + attr + ' data-field="provider"' + dis + '>' + mpOptions(MP_PROVIDERS, sel.provider || '') + '</select></td>' +
        '<td><input class="input" ' + attr + ' data-field="model" value="' + window.escAttr(sel.model || '') + '" placeholder="inherit"' + dis + '></td>' +
        '<td>' + mpProfileSelect(stage, sel.agent || '', sel.provider || '', sel.accountProfileId || '') + '</td>' +
        '<td><input class="input" type="number" min="1" step="1" ' + attr + ' data-field="invocationTimeoutMs" value="' + window.escAttr(limit) + '" placeholder="inherit"' + dis + '></td>' +
        '</tr>';
    }
    rowsEl.innerHTML = html;
    document.getElementById('mp-stage-hints').textContent = hints.join(' ');
    document.getElementById('mp-stage-actions').classList.toggle('hidden', !edit);
    const modeEl = document.getElementById('mp-stage-mode');
    modeEl.textContent = mpDefaults.mode === 'configured'
      ? 'Defaults are active for projects that opt in'
      : 'Defaults are saved but off (legacy). Turn them on in Settings.';
  }

  function mpRerenderKeepingEdits() {
    const snap = mpSnapshotForm();
    mpRenderStages();
    for (const el of document.querySelectorAll('#mp-stage-rows [data-stage]')) {
      const key = el.getAttribute('data-stage') + '.' + el.getAttribute('data-field');
      if (Object.prototype.hasOwnProperty.call(snap, key)) el.value = snap[key];
    }
  }

  function mpWatchDirty() {
    const rowsEl = document.getElementById('mp-stage-rows');
    const mark = function (e) {
      mpDirty = true;
      // Changing agent or provider changes which profiles are compatible.
      const f = e.target && e.target.getAttribute && e.target.getAttribute('data-field');
      if (f === 'agent' || f === 'provider') mpRerenderWithCompat();
    };
    rowsEl.oninput = mark;
    rowsEl.onchange = mark;
  }

  function mpRerenderWithCompat() {
    const form = mpReadForm();
    if (form.error) { mpRerenderKeepingEdits(); return; }
    const saved = mpDefaults;
    mpDefaults = { mode: saved.mode, stages: form.stages, revision: saved.revision };
    mpRenderStages();
    mpDefaults = saved;
  }

  function mpRenderAccounts() {
    const rowsEl = document.getElementById('mp-account-rows');
    const emptyEl = document.getElementById('mp-account-empty');
    emptyEl.classList.toggle('hidden', mpAccounts.length > 0);
    let html = '';
    for (const a of mpAccounts) {
      const projects = (a.allowedProjectKeys || []).map(function (k) { return '<span class="mono">' + window.esc(k) + '</span>'; }).join(', ') || '<span class="text-tertiary">none</span>';
      const account = a.account || {};
      let readyCell;
      let recoveryCell = '<span class="text-tertiary">—</span>';
      if (a.authMode === 'claude-subscription') {
        readyCell = '<span class="text-tertiary">—</span>';
        const rec = account.sessionRecovery;
        recoveryCell = rec
          ? window.esc(rec.state) + (rec.recoveryRequired ? ' <span class="badge fail">recovery required</span>' : '')
          : '<span class="text-tertiary">idle</span>';
      } else {
        const label = mpReadinessLabel(account.readiness);
        readyCell = '<span class="badge ' + mpReadinessKind(label) + '">' + window.esc(label) + '</span>';
        if (a.authMode === 'codex-subscription' && (label === 'sign-in required' || label === 'missing')) {
          readyCell += '<div class="text-tertiary" style="font-size:11px">Run <span class="mono">node dist/chatgpt-plan-login.js login</span> or <span class="mono">chatgpt-import</span> on the host.</div>';
        }
      }
      let keyCell = '<span class="text-tertiary">—</span>';
      if (a.authMode === 'openai-api-key' || a.authMode === 'anthropic-api-key') {
        const pid = window.escAttr(a.profileId);
        keyCell = '<span class="badge ' + (a.credentialSet ? 'success' : 'neutral') + '">' + (a.credentialSet ? 'set' : 'not set') + '</span>' +
          (mpCanEdit()
            ? '<div style="display:flex;gap:4px;margin-top:4px"><input class="input" type="password" autocomplete="off" data-key-for="' + pid + '" placeholder="API key">' +
              '<button class="btn btn-sm" data-act="set-key" data-profile="' + pid + '">Set key</button>' +
              '<button class="btn btn-sm" data-act="remove-key" data-profile="' + pid + '">Remove key</button></div>'
            : '');
      }
      html += '<tr>' +
        '<td><span class="mono">' + window.esc(a.profileId) + '</span></td>' +
        '<td>' + window.esc(a.identity) + '</td>' +
        '<td>' + window.esc(a.agent) + '</td>' +
        '<td>' + window.esc(a.provider) + '</td>' +
        '<td>' + window.esc(mpAuthLabel(a.authMode)) + '</td>' +
        '<td>' + projects + '</td>' +
        '<td><span class="badge ' + (a.profileStatus === 'active' ? 'success' : 'neutral') + '">' + window.esc(a.profileStatus || 'unknown') + '</span></td>' +
        '<td>' + readyCell + '</td>' +
        '<td>' + recoveryCell + '</td>' +
        '<td>' + keyCell + '</td>' +
        '</tr>';
    }
    rowsEl.innerHTML = html;
    document.getElementById('mp-account-form').classList.toggle('hidden', !mpCanEdit());
  }

  function mpAccountError(msg) {
    const el = document.getElementById('mp-account-error');
    el.textContent = msg || '';
    el.classList.toggle('hidden', !msg);
  }

  async function mpCredentialCall(profileId, method, apiKey) {
    mpAccountError('');
    const url = '/api/model-accounts/' + encodeURIComponent(profileId) + '/credential';
    try {
      const res = await window.api(url, method === 'PUT' ? { method: method, body: JSON.stringify({ apiKey: apiKey }) } : { method: method });
      if (!res.ok) { mpAccountError(await mpErrorText(res, 'Failed to update the key')); return; }
    } catch (err) {
      mpAccountError('Failed to update the key');
      return;
    }
    await loadStageConfig(false);
  }

  async function mpAddAccount() {
    if (!mpCanEdit()) return;
    mpAccountError('');
    const val = function (id) { return String(document.getElementById('mp-new-' + id).value || '').trim(); };
    const keys = val('allowedProjectKeys').split(',').map(function (k) { return k.trim(); }).filter(Boolean);
    const body = { profileId: val('profileId'), identity: val('identity'), agent: val('agent'), provider: val('provider'), authMode: val('authMode'), allowedProjectKeys: keys };
    try {
      const res = await window.api('/api/model-accounts', { method: 'POST', body: JSON.stringify(body) });
      if (!res.ok) { mpAccountError(await mpErrorText(res, 'Failed to add account profile')); return; }
    } catch (err) {
      mpAccountError('Failed to add account profile');
      return;
    }
    document.getElementById('mp-new-profileId').value = '';
    document.getElementById('mp-new-identity').value = '';
    document.getElementById('mp-new-allowedProjectKeys').value = '';
    await loadStageConfig(false);
  }

  function mpWatchKeys() {
    document.getElementById('mp-account-rows').onclick = async function (e) {
      const btn = e.target && e.target.closest ? e.target.closest('button[data-act]') : null;
      if (!btn) return;
      const profileId = btn.getAttribute('data-profile');
      if (btn.getAttribute('data-act') === 'remove-key') { await mpCredentialCall(profileId, 'DELETE'); return; }
      const inputs = document.querySelectorAll('#mp-account-rows input[data-key-for]');
      let input = null;
      for (const el of inputs) { if (el.getAttribute('data-key-for') === profileId) input = el; }
      if (!input || !input.value) { mpAccountError('Enter an API key first.'); return; }
      const value = input.value;
      input.value = '';
      await mpCredentialCall(profileId, 'PUT', value);
    };
  }

  async function loadStageConfig(force) {
    if (mpDirty && !force) return;
    const accountErr = document.getElementById('mp-account-error');
    accountErr.classList.add('hidden');
    try {
      const accRes = await window.api('/api/model-accounts');
      if (accRes.ok) {
        const data = await accRes.json();
        mpAccounts = Array.isArray(data.accounts) ? data.accounts : [];
      } else {
        accountErr.textContent = await mpErrorText(accRes, 'Failed to load account profiles');
        accountErr.classList.remove('hidden');
      }
      const defRes = await window.api('/api/agent-defaults');
      if (defRes.ok) {
        if (mpDirty && !force) return;
        mpDefaults = await defRes.json();
        mpDirty = false;
        mpShowStageError('');
      } else {
        mpShowStageError(await mpErrorText(defRes, 'Failed to load stage defaults'));
      }
    } catch (err) {
      mpShowStageError('Failed to load stage defaults: ' + String(err));
    }
    if (mpDirty && !force) return;
    mpRenderStages();
    mpRenderAccounts();
  }

  async function saveStageDefaults() {
    if (!mpCanEdit()) return;
    mpShowStageError('');
    const form = mpReadForm();
    if (form.error) { mpShowStageError(form.error); return; }
    try {
      const res = await window.api('/api/agent-defaults', {
        method: 'PUT',
        body: JSON.stringify({ mode: mpDefaults.mode === 'configured' ? 'configured' : 'legacy', stages: form.stages }),
      });
      if (!res.ok) {
        mpShowStageError(await mpErrorText(res, 'Failed to save stage defaults'));
        return;
      }
      mpDefaults = await res.json();
      mpDirty = false;
      mpRenderStages();
    } catch (err) {
      mpShowStageError('Failed to save stage defaults: ' + String(err));
    }
  }

  async function resetStageDefaults() {
    mpDirty = false;
    await loadStageConfig(true);
  }

  async function loadModelsAndProviders() {
    const errorEl = document.getElementById('mp-error');
    const kpisEl = document.getElementById('mp-kpis');
    const emptyEl = document.getElementById('mp-empty');
    const rowsEl = document.getElementById('mp-rows');
    const subtitleEl = document.getElementById('mp-subtitle');

    errorEl.hidden = true;
    loadStageConfig(false);

    const res = await window.api('/api/mappings');
    if (!res.ok) {
      let msg = 'Failed to load mappings';
      try {
        const data = await res.json();
        if (data && data.error) msg += ': ' + data.error;
      } catch (_) {}
      errorEl.innerHTML = '<div class="alert-title">Failed to load mappings</div><div class="alert-desc">' + window.esc(msg) + '</div>';
      errorEl.hidden = false;
      kpisEl.hidden = true;
      emptyEl.classList.add('hidden');
      rowsEl.innerHTML = '';
      subtitleEl.textContent = '—';
      return;
    }

    const mappings = await res.json();
    renderKpis(mappings);
    renderRows(mappings);
    const count = Object.keys(mappings).length;
    renderSubtitle(count);
  }

  function renderKpis(mappings) {
    const entries = Object.values(mappings);
    const total = entries.length;
    const anthropic = entries.filter(function (m) { return m.provider !== 'bedrock'; }).length;
    const bedrock = entries.filter(function (m) { return m.provider === 'bedrock'; }).length;
    const regions = new Set(entries.filter(function (m) { return m.provider === 'bedrock' && m.awsRegion; }).map(function (m) { return m.awsRegion; })).size;

    document.getElementById('kpi-mp-projects').textContent = String(total);
    document.getElementById('kpi-mp-anthropic').textContent = String(anthropic);
    document.getElementById('kpi-mp-bedrock').textContent = String(bedrock);
    document.getElementById('kpi-mp-regions').textContent = String(regions);
    document.getElementById('mp-kpis').hidden = false;
  }

  function renderRows(mappings) {
    const entries = Object.entries(mappings).sort(function (a, b) { return a[0].localeCompare(b[0]); });
    const emptyEl = document.getElementById('mp-empty');
    const rowsEl = document.getElementById('mp-rows');

    if (entries.length === 0) {
      emptyEl.classList.remove('hidden');
    } else {
      emptyEl.classList.add('hidden');
    }

    rowsEl.innerHTML = '';
    for (const [teamKey, m] of entries) {
      let regionCell;
      if (m.provider === 'bedrock' && m.awsRegion) {
        regionCell = '<td class="mono text-secondary">' + window.esc(m.awsRegion) + '</td>';
      } else if (m.provider === 'bedrock') {
        regionCell = '<td><span class="badge fail">missing</span></td>';
      } else {
        regionCell = '<td><span class="text-tertiary">—</span></td>';
      }

      const planningKind = m.planningEnabled ? 'success' : 'neutral';
      const planningLabel = m.planningEnabled ? 'enabled' : 'disabled';
      const autoText = (m.planningEnabled && m.autoApprovePlans)
        ? '<span class="text-tertiary" style="margin-left:6px;font-size:11.5px">· auto-approve</span>'
        : '';

      const runnerKind = m.executionMode === 'fly-machines' ? 'success' : 'info';

      const tr = document.createElement('tr');
      tr.innerHTML =
        '<td><span class="mono">' + window.esc(teamKey) + '</span></td>' +
        '<td><span class="mono">' + window.esc(m.owner) + '/' + window.esc(m.repo) + '</span></td>' +
        '<td><span class="badge ' + (m.provider === 'bedrock' ? 'warn' : 'info') + '">' + window.esc(m.provider) + '</span></td>' +
        regionCell +
        '<td><span class="badge ' + planningKind + '">' + planningLabel + '</span>' + autoText + '</td>' +
        '<td><span class="badge ' + runnerKind + '">' + window.esc(m.executionMode) + '</span></td>';
      rowsEl.appendChild(tr);
    }
  }

  function renderSubtitle(count) {
    const subtitleEl = document.getElementById('mp-subtitle');
    subtitleEl.textContent = count + ' project' + (count === 1 ? '' : 's') + ' configured';
  }

  window.loadModelsAndProviders = loadModelsAndProviders;
  window.saveStageDefaults = saveStageDefaults;
  window.mpAddAccount = mpAddAccount;
  window.resetStageDefaults = resetStageDefaults;
  window.registerPage('models', function () { mpWatchDirty(); mpWatchKeys(); loadModelsAndProviders(); setInterval(loadModelsAndProviders, 60000); });
})();`;
