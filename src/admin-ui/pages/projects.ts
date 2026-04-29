export const projectsHtml = `
<section data-page="projects" hidden>
  <header class="page-header">
    <div class="page-header-left">
      <h1 class="page-title">Projects</h1>
      <div class="page-subtitle">Linear team &rarr; GitHub repo mappings, with provider, runner, and planning settings</div>
    </div>
    <div class="page-header-actions">
      <button class="btn btn-accent btn-sm" onclick="openMappingDialog(null)">+ New project</button>
    </div>
  </header>
  <div class="page-body">
    <div class="card">
      <div class="card-body tight">
        <table class="tbl" id="mappings-table">
          <thead>
            <tr>
              <th>Team</th><th>Repo</th><th>Runner</th><th>Session</th>
              <th style="text-align:center">Cap</th><th>Planning</th><th>Provider</th><th></th>
            </tr>
          </thead>
          <tbody id="mappings-body"></tbody>
        </table>
        <div id="mappings-empty" class="hidden text-tertiary" style="padding:12px">No projects configured yet.</div>
      </div>
    </div>

    <div class="card hidden" id="secrets-panel">
      <div class="card-header" style="display:flex;align-items:center;justify-content:space-between">
        <h2 class="card-title">Secrets &mdash; <span id="secrets-team-key" class="mono"></span></h2>
        <button class="btn btn-sm" style="margin-left:auto" onclick="document.getElementById('secrets-panel').classList.add('hidden')">&#215;</button>
      </div>
      <div class="card-body">
        <div class="warning">&#9888; Secrets are shared across all machines for this team. Values are write-only and cannot be read back through the API.</div>
        <table class="tbl">
          <thead>
            <tr><th>Name (suffix)</th><th>Status</th><th></th></tr>
          </thead>
          <tbody id="secrets-body"></tbody>
        </table>
        <div id="secrets-empty" class="hidden text-tertiary" style="padding:10px 0">No secrets set for this team</div>
        <div style="display:flex;gap:6px;align-items:flex-end;flex-wrap:wrap;margin-top:12px">
          <div class="field" style="flex:1;min-width:160px">
            <label>Name</label>
            <input class="input" id="s-name" placeholder="Name (e.g. DATABASE_URL)" style="text-transform:uppercase">
          </div>
          <div class="field" style="flex:2;min-width:200px">
            <label>Value</label>
            <input class="input" id="s-value" type="password" placeholder="Value">
          </div>
          <button class="btn btn-primary btn-sm" id="btn-add-secret" onclick="addSecret()" style="align-self:flex-end">Set Secret</button>
        </div>
        <div id="secrets-error" class="error hidden" style="margin-top:6px"></div>
      </div>
    </div>
  </div>

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
</section>
`;

export const projectsScript = `
(function () {
  let mappingsData = {};
  let currentSecretsTeam = null;

  async function loadMappings() {
    const res = await window.api('/api/mappings');
    mappingsData = await res.json();
    const tbody = document.getElementById('mappings-body');
    const emptyEl = document.getElementById('mappings-empty');
    tbody.innerHTML = '';
    const keys = Object.keys(mappingsData);
    if (keys.length === 0) {
      if (emptyEl) emptyEl.classList.remove('hidden');
      return;
    }
    if (emptyEl) emptyEl.classList.add('hidden');
    for (const [key, m] of Object.entries(mappingsData)) {
      const tr = document.createElement('tr');
      const ek = window.esc(key);
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
        + '<td class="mono">' + window.esc(m.owner) + '/' + window.esc(m.repo) + '</td>'
        + '<td>' + execBadge + '</td>'
        + '<td style="color:#666;font-size:0.85em">' + window.esc(m.sessionMode || 'autonomous') + '</td>'
        + '<td style="text-align:center">' + window.esc(String(m.maxInProgressAiIssues ?? 3)) + '</td>'
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
  window.openMappingDialog = openMappingDialog;

  function closeMappingDialog() {
    document.getElementById('mapping-dialog').close();
  }
  window.closeMappingDialog = closeMappingDialog;

  function onExecModeChange() {
    const isFly = document.getElementById('md-exec-mode').value === 'fly-machines';
    document.getElementById('md-fly-fields').classList.toggle('hidden', !isFly);
  }
  window.onExecModeChange = onExecModeChange;

  function onProviderChange() {
    const isBedrock = document.getElementById('md-provider').value === 'bedrock';
    document.getElementById('md-aws-region-wrap').classList.toggle('hidden', !isBedrock);
  }
  window.onProviderChange = onProviderChange;

  function onPlanningChange() {
    const enabled = document.getElementById('md-planning').checked;
    document.getElementById('md-planning-wf-wrap').classList.toggle('hidden', !enabled);
  }
  window.onPlanningChange = onPlanningChange;

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

    const res = await window.api('/api/mappings', { method: 'POST', body: JSON.stringify(body) });
    if (!res.ok) {
      const msg = await res.text().catch(() => 'Unknown error');
      errEl.textContent = 'Server error: ' + msg;
      errEl.classList.remove('hidden');
      return;
    }
    closeMappingDialog();
    await loadMappings();
  }
  window.saveMappingDialog = saveMappingDialog;

  async function delMapping(key) {
    if (!confirm('Delete mapping for ' + key + '?')) return;
    await window.api('/api/mappings/' + encodeURIComponent(key), { method: 'DELETE' });
    if (currentSecretsTeam === key) {
      document.getElementById('secrets-panel').classList.add('hidden');
      currentSecretsTeam = null;
    }
    await loadMappings();
  }
  window.delMapping = delMapping;

  async function showSecrets(teamKey) {
    currentSecretsTeam = teamKey;
    document.getElementById('secrets-team-key').textContent = teamKey;
    document.getElementById('secrets-panel').classList.remove('hidden');
    document.getElementById('secrets-error').classList.add('hidden');
    document.getElementById('s-name').value = '';
    document.getElementById('s-value').value = '';
    await loadSecrets();
  }
  window.showSecrets = showSecrets;

  async function loadSecrets() {
    if (!currentSecretsTeam) return;
    const tbody = document.getElementById('secrets-body');
    const empty = document.getElementById('secrets-empty');
    tbody.innerHTML = '';
    try {
      const res = await window.api('/api/mappings/' + encodeURIComponent(currentSecretsTeam) + '/secrets');
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
        tr.innerHTML = '<td class="mono">' + window.esc(s.name) + '</td>'
          + '<td><span class="badge active">Set</span></td>'
          + '<td><button class="sm danger" data-name="' + window.esc(s.name) + '" onclick="delSecret(this.dataset.name)">Delete</button></td>';
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
      const res = await window.api('/api/mappings/' + encodeURIComponent(currentSecretsTeam) + '/secrets', {
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
  window.addSecret = addSecret;

  async function delSecret(name) {
    const errEl = document.getElementById('secrets-error');
    errEl.classList.add('hidden');
    if (!confirm('Delete secret ' + name + ' for team ' + currentSecretsTeam + '?')) return;
    try {
      const res = await window.api('/api/mappings/' + encodeURIComponent(currentSecretsTeam) + '/secrets/' + encodeURIComponent(name), {
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
  window.delSecret = delSecret;

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

  window.registerPage('projects', function () { loadMappings(); });
})();
`;
