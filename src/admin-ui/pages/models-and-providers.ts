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
        <div class="alert-desc">Orchestrator defaults below choose the agent, provider, model, account profile and limit for planning, implementation and review, without a repository change. New projects start configured when defaults are on; existing projects keep their mode. A legacy project keeps its current behavior, including the model in its <span class="mono">WORKFLOW.md</span> front matter. Saved changes apply to the next run, not to a run already in flight.</div>
      </div>
    </div>

    <div class="card" id="mp-stage-card">
      <div class="card-header">
        <h2 class="card-title">Orchestrator stage defaults</h2>
        <div class="card-subtitle" id="mp-stage-mode">—</div>
      </div>
      <div class="card-body">
        <div style="overflow-x:auto">
        <table class="tbl">
          <thead>
            <tr><th>Stage</th><th>Agent</th><th>Provider</th><th>Fallback model</th><th>Accounts (in order)</th><th>Elapsed time limit (ms)</th></tr>
          </thead>
          <tbody id="mp-stage-rows"></tbody>
        </table>
        </div>
        <div class="text-tertiary" style="font-size:11px;margin-top:6px">Blank fields inherit. The limit is an elapsed time in milliseconds for either agent. Claude turn caps are separate: Max Turns per project, and Review Max Turns under Retry Policy on the Settings page.</div>
        <div class="field-hint">The first account is the stage account; later accounts are fallbacks. A fallback model may be blank only when its profile uses the same agent as the first account.</div>
        <div class="field-hint">A project that overrides the account profile on its Agents tab runs without these fallbacks.</div>
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
        <div style="overflow-x:auto">
        <table class="tbl">
          <thead>
            <tr><th>Name</th><th>Agent</th><th>Provider</th><th>Authentication</th><th>Status</th><th>Readiness</th><th>API key</th></tr>
          </thead>
          <tbody id="mp-account-rows"></tbody>
        </table>
        </div>
        <div id="mp-account-empty" class="hidden text-tertiary" style="padding:12px">No account profiles yet. An operator provisions accounts on the host; see the instructions below.</div>
        <div id="mp-account-error" class="error hidden" style="padding:0 12px"></div>
        <div id="mp-account-notice" class="text-tertiary hidden" style="padding:0 12px"></div>
        <div id="mp-pairing" class="hidden" style="padding:12px"></div>
        <div id="mp-account-form" class="hidden" style="padding:12px">
          <h3 style="font-size:13px;margin:0 0 6px">Add account profile</h3>
          <div style="display:flex;gap:10px;flex-wrap:wrap;align-items:center">
            <span style="display:inline-flex;gap:6px;align-items:center"><label for="mp-new-name">Name</label><input class="input" id="mp-new-name" placeholder="Name"></span>
            <span style="display:inline-flex;gap:6px;align-items:center"><label for="mp-new-agent">Agent</label><select class="input" id="mp-new-agent"><option value="claude">claude</option><option value="codex">codex</option></select></span>
            <span style="display:inline-flex;gap:6px;align-items:center"><label for="mp-new-provider">Provider</label><select class="input" id="mp-new-provider"><option value="anthropic">anthropic</option><option value="openai">openai</option><option value="bedrock">bedrock</option></select></span>
            <span style="display:inline-flex;gap:6px;align-items:center"><label for="mp-new-authMode">Authentication</label><select class="input" id="mp-new-authMode"><option value="anthropic-api-key">anthropic-api-key</option><option value="openai-api-key">openai-api-key</option><option value="codex-subscription">codex-subscription</option><option value="claude-subscription">claude-subscription</option><option value="bedrock">bedrock</option></select></span>
            <button class="btn btn-primary btn-sm" onclick="mpAddAccount()">Add account profile</button>
            <button class="btn btn-sm" id="mp-import-credential" onclick="mpImportCredential()">Import orchestrator credential</button>
          </div>
          <div class="text-tertiary" style="font-size:11px;margin-top:6px">Import copies the credential the orchestrator uses for legacy runs. Legacy projects keep reading the environment variable until an admin changes their mode with set_project_agent_mode.</div>
        </div>
        <div class="text-tertiary" style="font-size:11.5px;padding:12px">
          <div><strong>Provisioning.</strong> Add a profile above and set an API key or Claude subscription setup-token per profile; a key is encrypted on save and never shown again. Connect a ChatGPT plan from a laptop with a pairing code; Bedrock credentials are provisioned on the host.</div>
          <div>ChatGPT plan, <em>sign-in required</em> or <em>missing</em>: run <span class="mono">node dist/chatgpt-plan-login.js login</span>, or import an existing sign-in with <span class="mono">chatgpt-import</span>.</div>
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
  let mpDefaults = { mode: 'legacy', stages: {} };
  let mpAccounts = [];
  const mpAccountEdits = new Map();

  function mpProfileIdFromName(name, existingIds) {
    const base = String(name).toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').replace(/^[^a-z0-9]+/, '').slice(0, 64) || 'account';
    let id = base;
    let n = 2;
    while (existingIds.indexOf(id) !== -1) {
      const suffix = '-' + n++;
      id = base.slice(0, 64 - suffix.length) + suffix;
    }
    return id;
  }

  // The pairing code lives only here: it is never written to storage and loadStageConfig does not re-render it.
  let mpPairing = null;
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


  function mpProfileSelect(stage, current) {
    const list = mpAccounts.filter(function (a) { return a.profileStatus === 'active'; });
    let html = '<select class="input" aria-label="Account profile for ' + window.escAttr(stage) + '" data-stage="' + window.escAttr(stage) + '" data-field="accountProfileId"' + (mpCanEdit() ? '' : ' disabled') + '><option value="">(inherit)</option>';
    let seen = false;
    for (const a of list) {
      if (a.profileId === current) seen = true;
      html += '<option value="' + window.escAttr(a.profileId) + '"' + (a.profileId === current ? ' selected' : '') + '>' + window.esc(a.identity + ' (' + a.profileId + ')') + '</option>';
    }
    if (current && !seen) {
      html += '<option value="' + window.escAttr(current) + '" selected>' + window.esc(current + ' (not active)') + '</option>';
    }
    return html + '</select>';
  }

  function mpAccountRow(stage, entry) {
    const row = document.createElement('div');
    row.setAttribute('data-account-row', '');
    row.innerHTML = mpProfileSelect(stage, entry.accountProfileId || '') +
      '<input class="input" data-stage="' + window.escAttr(stage) + '" data-field="model" aria-label="Account model for ' + window.escAttr(stage) + '" value="' + window.escAttr(entry.model || '') + '" placeholder="model"' + (mpCanEdit() ? '' : ' disabled') + '>' +
      ['up', 'down', 'remove'].map(function (action) {
        return '<button class="btn btn-sm" data-account-action="' + window.escAttr(action) + '">' + window.esc({ up: 'Move up', down: 'Move down', remove: 'Remove' }[action]) + '</button>';
      }).join('');
    return row;
  }

  function mpUpdateAccountButtons(list) {
    const rows = Array.from(list.children);
    rows.forEach(function (row, index) {
      row.querySelector('[data-account-action="up"]').disabled = !mpCanEdit() || index === 0;
      row.querySelector('[data-account-action="down"]').disabled = !mpCanEdit() || index === rows.length - 1;
      row.querySelector('[data-account-action="remove"]').disabled = !mpCanEdit() || rows.length === 1;
    });
  }

  function mpSyncStageProfile(stage) {
    const list = document.querySelector('[data-account-list="' + stage + '"]');
    const profileId = list.querySelector('[data-field="accountProfileId"]').value;
    const profile = mpAccounts.find(function (a) { return a.profileId === profileId; });
    const saved = (mpDefaults.stages || {})[stage] || {};
    for (const field of ['agent', 'provider']) {
      const display = document.querySelector('#mp-stage-rows [data-stage="' + stage + '"][data-profile-field="' + field + '"]');
      display.textContent = (profile ? profile[field] : saved[field]) || 'inherit';
    }
  }

  function mpReadForm() {
    const stages = {};
    for (const stage of MP_STAGES) {
      mpSyncStageProfile(stage);
      const saved = (mpDefaults.stages || {})[stage] || {};
      const firstProfileId = document.querySelector('[data-account-list="' + stage + '"] [data-field="accountProfileId"]').value;
      const firstProfile = mpAccounts.find(function (a) { return a.profileId === firstProfileId; });
      const patch = {
        agent: (firstProfile ? firstProfile.agent : saved.agent) || null,
        provider: (firstProfile ? firstProfile.provider : saved.provider) || null
      };
      for (const el of document.querySelectorAll('#mp-stage-rows [data-stage="' + stage + '"][data-field]')) {
        if (el.closest('[data-account-row]')) continue;
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
      const accounts = Array.from(document.querySelectorAll('[data-account-list="' + stage + '"] [data-account-row]')).map(function (row) {
        return { accountProfileId: row.querySelector('[data-field="accountProfileId"]').value.trim(), model: row.querySelector('[data-field="model"]').value.trim() };
      });
      if (accounts.length > 1) patch.accounts = accounts;
      else {
        patch.accountProfileId = accounts[0].accountProfileId || null;
        patch.model = accounts[0].model || null;
        const profile = mpAccounts.find(function (a) { return a.profileId === patch.accountProfileId; });
        if (profile) { patch.agent = profile.agent; patch.provider = profile.provider; }
      }
      stages[stage] = patch;
    }
    return { stages: stages };
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
      html += '<tr>' +
        '<td><span class="mono">' + window.esc(stage) + '</span></td>' +
        '<td><span ' + attr + ' data-profile-field="agent"></span></td>' +
        '<td><span ' + attr + ' data-profile-field="provider"></span></td>' +
        '<td><input class="input" ' + attr + ' data-field="fallbackModel" aria-label="Fallback model for ' + window.escAttr(stage) + '" value="' + window.escAttr(sel.fallbackModel || '') + '" placeholder="none"' + dis + '><div class="field-hint">Used for the rest of the run after this stage&#39;s model reports it is at capacity.</div></td>' +
        '<td><div data-account-list="' + window.escAttr(stage) + '"></div><button class="btn btn-sm" data-account-action="add" data-stage="' + window.escAttr(stage) + '"' + dis + '>Add account</button></td>' +
        '<td><input class="input" type="number" min="1" step="1" ' + attr + ' data-field="invocationTimeoutMs" value="' + window.escAttr(limit) + '" placeholder="inherit"' + dis + '></td>' +
        '</tr>';
    }
    rowsEl.innerHTML = html;
    for (const stage of MP_STAGES) {
      const sel = stages[stage] || {};
      const list = rowsEl.querySelector('[data-account-list="' + stage + '"]');
      const accounts = sel.accounts && sel.accounts.length ? sel.accounts : [{ accountProfileId: sel.accountProfileId, model: sel.model }];
      accounts.forEach(function (entry) { list.appendChild(mpAccountRow(stage, entry)); });
      mpUpdateAccountButtons(list);
      mpSyncStageProfile(stage);
    }
    document.getElementById('mp-stage-hints').textContent = hints.join(' ');
    document.getElementById('mp-stage-actions').classList.toggle('hidden', !edit);
    const modeEl = document.getElementById('mp-stage-mode');
    modeEl.textContent = mpDefaults.mode === 'configured'
      ? 'Defaults are active for configured projects and for new projects'
      : 'Defaults are saved but off (legacy). Turn them on in Settings.';
  }

  // Refresh profile choices in place so credential imports and polling preserve unsaved account order and models.
  function mpRerenderWithCompat() {
    for (const stage of MP_STAGES) {
      const list = document.querySelector('[data-account-list="' + stage + '"]');
      if (!list) continue;
      for (const select of list.querySelectorAll('[data-field="accountProfileId"]')) {
        const holder = document.createElement('div');
        holder.innerHTML = mpProfileSelect(stage, select.value);
        select.innerHTML = holder.firstElementChild.innerHTML;
      }
      mpSyncStageProfile(stage);
    }
  }

  function mpWatchDirty() {
    const rowsEl = document.getElementById('mp-stage-rows');
    rowsEl.oninput = rowsEl.onchange = function (event) {
      const stage = event.target.getAttribute('data-stage');
      if (stage) mpSyncStageProfile(stage);
      mpDirty = true;
    };
    rowsEl.onclick = function (event) {
      const button = event.target.closest('[data-account-action]');
      if (!button || button.disabled || !mpCanEdit()) return;
      const action = button.getAttribute('data-account-action');
      const row = button.closest('[data-account-row]');
      const list = row ? row.parentElement : rowsEl.querySelector('[data-account-list="' + button.getAttribute('data-stage') + '"]');
      if (action === 'add') list.appendChild(mpAccountRow(button.getAttribute('data-stage'), {}));
      if (action === 'remove' && list.children.length > 1) row.remove();
      if (action === 'up' && row.previousElementSibling) list.insertBefore(row, row.previousElementSibling);
      if (action === 'down' && row.nextElementSibling) list.insertBefore(row.nextElementSibling, row);
      mpUpdateAccountButtons(list);
      mpSyncStageProfile(list.getAttribute('data-account-list'));
      mpDirty = true;
    };
  }

  function mpRenderAccounts() {
    const rowsEl = document.getElementById('mp-account-rows');
    const emptyEl = document.getElementById('mp-account-empty');
    emptyEl.classList.toggle('hidden', mpAccounts.length > 0);
    let html = '';
    for (const a of mpAccounts) {
      const account = a.account || {};
      const label = mpReadinessLabel(account.readiness);
      let readyCell = '<span class="badge ' + mpReadinessKind(label) + '">' + window.esc(label) + '</span>';
      if (a.authMode === 'codex-subscription' && (label === 'sign-in required' || label === 'missing')) {
        readyCell += '<div class="text-tertiary" style="font-size:11px">Run <span class="mono">node dist/chatgpt-plan-login.js login</span> or <span class="mono">chatgpt-import</span> on the host.</div>';
      }
      let keyCell = '<span class="text-tertiary">—</span>';
      if (a.authMode === 'openai-api-key' || a.authMode === 'anthropic-api-key' || a.authMode === 'claude-subscription') {
        const pid = window.escAttr(a.profileId);
        keyCell = '<span class="badge ' + (a.credentialSet ? 'success' : 'neutral') + '">' + (a.credentialSet ? 'set' : 'not set') + '</span>' +
          (mpCanEdit()
            ? '<div style="display:flex;gap:4px;margin-top:4px"><input class="input" type="password" autocomplete="off" data-key-for="' + pid + '" placeholder="' + (a.authMode === 'claude-subscription' ? 'setup-token' : 'API key') + '">' +
              '<button class="btn btn-sm" data-act="set-key" data-profile="' + pid + '">Set key</button>' +
              '<button class="btn btn-sm" data-act="remove-key" data-profile="' + pid + '">Remove key</button></div>'
            : '');
      }
      if (a.authMode === 'codex-subscription' && a.profileStatus === 'active' && mpCanEdit()) {
        keyCell = '<button class="btn btn-sm" data-act="pair" data-profile="' + window.escAttr(a.profileId) + '">Connect ChatGPT plan</button>';
      }
      const draft = mpCanEdit() && mpAccountEdits.get(a.profileId);
      const pid = window.escAttr(a.profileId);
      const disabled = draft && draft.saving ? ' disabled' : '';
      const action = function (act, text) { return '<button class="btn btn-sm" data-act="' + window.escAttr(act) + '" data-profile="' + pid + '"' + disabled + '>' + window.esc(text) + '</button>'; };
      const nameCell = draft
        ? '<input class="input" aria-label="Name" data-edit-name="' + pid + '" value="' + window.escAttr(draft.identity) + '"' + disabled + '>'
        : window.esc(a.identity);
      const statusCell = draft
        ? '<select class="input" aria-label="Status" data-edit-status="' + pid + '"' + disabled + '>' + ['active', 'disabled', 'archived'].map(function (status) {
            return '<option value="' + window.escAttr(status) + '"' + (status === draft.status ? ' selected' : '') + '>' + window.esc(status) + '</option>';
          }).join('') + '</select>'
        : '<span class="badge ' + (a.profileStatus === 'active' ? 'success' : 'neutral') + '">' + window.esc(a.profileStatus || 'unknown') + '</span>';
      html += '<tr>' +
        '<td>' + nameCell + '<div class="mono text-tertiary" style="font-size:11px">' + window.esc(a.profileId) + '</div>' +
          (mpCanEdit() ? '<div>' + (draft ? action('save-profile', 'Save') + action('cancel-profile', 'Cancel') : action('edit-profile', 'Edit')) + '</div>' : '') + '</td>' +
        '<td>' + window.esc(a.agent) + '</td>' +
        '<td>' + window.esc(a.provider) + '</td>' +
        '<td>' + window.esc(mpAuthLabel(a.authMode)) + '</td>' +
        '<td>' + statusCell + '</td>' +
        '<td>' + readyCell + '</td>' +
        '<td>' + keyCell + '</td>' +
        '</tr>';
    }
    // Carry unsubmitted keys and focused editing controls across the rebuild.
    const typed = {};
    rowsEl.querySelectorAll('input[data-key-for]').forEach(function (inp) {
      if (inp.value) typed[inp.getAttribute('data-key-for')] = inp.value;
    });
    const active = document.activeElement;
    const focusAttribute = ['data-key-for', 'data-edit-name', 'data-edit-status'].find(function (attr) {
      return active && rowsEl.contains(active) && active.hasAttribute(attr);
    });
    const focused = focusAttribute ? active.getAttribute(focusAttribute) : null;
    const selection = focusAttribute === 'data-edit-name'
      ? [active.selectionStart, active.selectionEnd, active.selectionDirection] : null;
    rowsEl.innerHTML = html;
    rowsEl.querySelectorAll('input[data-key-for]').forEach(function (inp) {
      const id = inp.getAttribute('data-key-for');
      if (Object.prototype.hasOwnProperty.call(typed, id)) inp.value = typed[id];
    });
    if (focusAttribute) {
      rowsEl.querySelectorAll('[' + focusAttribute + ']').forEach(function (control) {
        if (control.getAttribute(focusAttribute) !== focused) return;
        control.focus();
        if (selection) control.setSelectionRange(selection[0], selection[1], selection[2]);
      });
    }
    document.getElementById('mp-account-form').classList.toggle('hidden', !mpCanEdit());
  }

  function mpAccountError(msg) {
    const el = document.getElementById('mp-account-error');
    el.textContent = msg || '';
    el.classList.toggle('hidden', !msg);
  }

  function mpAccountNotice(msg) {
    const el = document.getElementById('mp-account-notice');
    el.textContent = msg || '';
    el.classList.toggle('hidden', !msg);
  }

  function mpRenderPairing() {
    const el = document.getElementById('mp-pairing');
    if (!mpPairing) { el.classList.add('hidden'); el.textContent = ''; return; }
    el.classList.remove('hidden');
    el.textContent = '';
    const add = function (tag, text, cls) {
      const n = document.createElement(tag);
      n.textContent = text;
      if (cls) n.className = cls;
      el.appendChild(n);
      return n;
    };
    add('div', 'Connect ChatGPT plan: ' + mpPairing.profileId);
    if (mpPairing.code) {
      add('div', 'Shown once. Paste the code when the command asks for it; it works once for the next 15 minutes and is not stored in readable form.', 'text-tertiary');
      add('div', mpPairing.code, 'mono');
      add('div', 'Run on the laptop, from a repo checkout after npm run build:', 'text-tertiary');
      add('div', mpPairing.command, 'mono');
    }
    if (mpPairing.status) add('div', 'Status: ' + mpPairing.status, 'text-tertiary');
    const check = add('button', 'Check status', 'btn btn-sm');
    check.setAttribute('data-act', 'pair-check');
    const close = add('button', 'Dismiss', 'btn btn-sm');
    close.setAttribute('data-act', 'pair-close');
  }

  async function mpPairingMint(profileId) {
    mpAccountError('');
    try {
      const res = await window.api('/api/model-accounts/' + encodeURIComponent(profileId) + '/chatgpt-pairing', { method: 'POST' });
      if (!res.ok) { mpAccountError(await mpErrorText(res, 'Failed to create a pairing code')); return; }
      const data = await res.json();
      mpPairing = { profileId: profileId, code: String(data.code || ''), command: String(data.command || ''), status: '' };
    } catch (err) {
      mpAccountError('Failed to create a pairing code');
      return;
    }
    mpRenderPairing();
  }

  async function mpPairingCheck() {
    if (!mpPairing) return;
    const profileId = mpPairing.profileId;
    await loadStageConfig(false);
    const found = mpAccounts.filter(function (a) { return a.profileId === profileId; })[0];
    let label = found && found.account ? mpReadinessLabel(found.account.readiness) : 'unknown';
    try {
      const res = await window.api('/api/model-accounts/' + encodeURIComponent(profileId) + '/chatgpt-status');
      const st = res.ok ? await res.json() : null;
      if (st && st.connected) {
        label += ' | Email: ' + (st.email || '-') + ' | Seconds left: ' + (st.secondsLeft === null ? '-' : st.secondsLeft) + ' | Last refresh: ' + (st.lastRefresh || 'unknown');
      } else if (st) {
        label += ' | Not connected yet | Last refresh: ' + (st.lastRefresh || 'unknown');
      }
    } catch (e) { /* keep the readiness label */ }
    if (mpPairing && mpPairing.profileId === profileId) mpPairing.status = label;
    mpRenderPairing();
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

  async function mpImportCredential() {
    if (!mpCanEdit()) return;
    mpAccountError('');
    mpAccountNotice('');
    try {
      const res = await window.api('/api/tools/import_environment_credential', {
        method: 'POST', body: JSON.stringify({ args: {} }),
      });
      const body = await res.json().catch(function () { return {}; });
      if (!res.ok) { mpAccountError(body.error || 'Import failed (HTTP ' + res.status + ')'); return; }
      const text = body.content && body.content[0] ? body.content[0].text : 'Import failed';
      let result = null;
      try { result = JSON.parse(text); } catch (_) { /* plain-text role error */ }
      if (!result || (result.status !== 201 && result.status !== 200)) {
        mpAccountError(result && result.body ? result.body.error : text);
        return;
      }
      const accRes = await window.api('/api/model-accounts');
      if (!accRes.ok) { mpAccountError(await mpErrorText(accRes, 'Failed to load account profiles')); return; }
      const data = await accRes.json();
      mpAccounts = Array.isArray(data.accounts) ? data.accounts : [];
      mpRenderAccounts();
      mpRerenderWithCompat();
      mpAccountNotice(result.body.profileId + ': ' + (result.status === 201 ? 'created' : 'already imported'));
    } catch (err) {
      mpAccountError('Import failed: ' + String(err));
    }
  }

  async function mpAddAccount() {
    if (!mpCanEdit()) return;
    mpAccountError('');
    const val = function (id) { return String(document.getElementById('mp-new-' + id).value || '').trim(); };
    const name = val('name');
    const body = { profileId: mpProfileIdFromName(name, mpAccounts.map(function (a) { return a.profileId; })), identity: name, agent: val('agent'), provider: val('provider'), authMode: val('authMode') };
    try {
      const res = await window.api('/api/model-accounts', { method: 'POST', body: JSON.stringify(body) });
      if (!res.ok) { mpAccountError(await mpErrorText(res, 'Failed to add account profile')); return; }
    } catch (err) {
      mpAccountError('Failed to add account profile');
      return;
    }
    document.getElementById('mp-new-name').value = '';
    await loadStageConfig(false);
  }

  async function mpSaveProfile(profileId) {
    const draft = mpAccountEdits.get(profileId);
    if (!draft || draft.saving) return;
    const body = {};
    if (draft.identity !== draft.originalIdentity) body.identity = draft.identity;
    if (draft.status !== draft.originalStatus) body.status = draft.status;
    mpAccountError('');
    if (Object.keys(body).length) {
      draft.saving = true;
      mpRenderAccounts();
      try {
        const res = await window.api('/api/model-accounts/' + encodeURIComponent(profileId), { method: 'PATCH', body: JSON.stringify(body) });
        if (!res.ok) { mpAccountError(await mpErrorText(res, 'Failed to update account profile')); return; }
        mpAccountEdits.delete(profileId);
        await loadStageConfig(false);
      } catch (_) { mpAccountError('Failed to update account profile'); return; }
      finally { draft.saving = false; mpRenderAccounts(); }
      return;
    }
    mpAccountEdits.delete(profileId);
    await loadStageConfig(false);
  }

  function mpWatchKeys() {
    const updateDraft = function (e) {
      const nameId = e.target.getAttribute('data-edit-name');
      const statusId = e.target.getAttribute('data-edit-status');
      const draft = mpAccountEdits.get(nameId || statusId);
      if (draft && !draft.saving) draft[nameId !== null ? 'identity' : 'status'] = e.target.value;
    };
    document.getElementById('mp-account-rows').oninput = updateDraft;
    document.getElementById('mp-account-rows').onchange = updateDraft;
    document.getElementById('mp-pairing').onclick = function (e) {
      const btn = e.target && e.target.closest ? e.target.closest('button[data-act]') : null;
      if (!btn) return;
      const act = btn.getAttribute('data-act');
      if (act === 'pair-close') { mpPairing = null; mpRenderPairing(); }
      else if (act === 'pair-check') { mpPairingCheck(); }
    };
    document.getElementById('mp-account-rows').onclick = async function (e) {
      const btn = e.target && e.target.closest ? e.target.closest('button[data-act]') : null;
      if (!btn || btn.disabled || !mpCanEdit()) return;
      const profileId = btn.getAttribute('data-profile');
      const act = btn.getAttribute('data-act');
      if (act === 'edit-profile') {
        const a = mpAccounts.find(function (a) { return a.profileId === profileId; });
        if (!a) return;
        mpAccountEdits.set(profileId, { identity: a.identity, status: a.profileStatus, originalIdentity: a.identity, originalStatus: a.profileStatus });
        mpRenderAccounts();
        return;
      }
      if (act === 'cancel-profile') { mpAccountEdits.delete(profileId); mpAccountError(''); mpRenderAccounts(); return; }
      if (act === 'save-profile') { await mpSaveProfile(profileId); return; }
      if (act === 'pair') { await mpPairingMint(profileId); return; }
      if (act === 'remove-key') { await mpCredentialCall(profileId, 'DELETE'); return; }
      if (act !== 'set-key') return;
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
      mpRenderAccounts();
      if (mpDirty && !force) { mpRerenderWithCompat(); return; }
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
    mpDirty = true;
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
    await loadStageConfig(false);

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
  window.mpImportCredential = mpImportCredential;
  window.mpProfileIdFromName = mpProfileIdFromName;
  window.resetStageDefaults = resetStageDefaults;
  window.registerPage('models', function () { mpWatchDirty(); mpWatchKeys(); loadModelsAndProviders(); setInterval(loadModelsAndProviders, 60000); });
})();`;
