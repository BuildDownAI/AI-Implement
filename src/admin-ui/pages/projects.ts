export const projectsHtml = `
<section data-page="projects" hidden>
  <header class="page-header">
    <div class="page-header-left">
      <h1 class="page-title">Projects</h1>
      <div class="page-subtitle">Linear team &rarr; GitHub repo mappings, with provider, runner, and planning settings</div>
    </div>
    <div class="page-header-actions">
      <button class="btn btn-accent btn-sm" onclick="openNewProjectStepper()">+ New project</button>
    </div>
  </header>
  <div class="page-body">
    <div class="card">
      <div class="card-body tight">
        <table class="tbl" id="mappings-table">
          <thead>
            <tr>
              <th>Team</th><th>Repo</th><th>Runner</th><th>Session</th>
              <th style="text-align:center">Cap</th><th>Planning</th><th>Provider</th><th>Status</th><th></th>
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
      <button class="btn btn-ghost btn-icon" onclick="closeMappingDialog()">&#215;</button>
    </div>
    <input type="hidden" id="md-team-key-orig">
    <div class="md-body">
      <fieldset>
        <legend>Ticketing Provider</legend>
        <div style="display:flex;gap:20px;align-items:flex-start;flex-wrap:wrap">
          <div class="md-field" style="margin-bottom:0;min-width:140px">
            <label>Provider</label>
            <select id="md-ticketing-provider" onchange="onTicketingProviderChange()">
              <option value="linear">Linear</option>
              <option value="jira">Jira</option>
            </select>
          </div>
        </div>
        <div id="md-jira-fields" class="hidden" style="margin-top:12px">
          <div class="md-field">
            <label>Mapping ID</label>
            <input id="md-jira-mapping-id" placeholder="acme/billing">
          </div>
          <div class="md-field">
            <label>JQL</label>
            <textarea id="md-jira-jql" rows="3" placeholder="project = TEST"></textarea>
            <div style="display:flex;gap:8px;align-items:center;margin-top:4px">
              <button type="button" class="btn btn-ghost" onclick="validateJqlButton()">Validate</button>
              <span id="md-jira-jql-status" class="text-tertiary" style="font-size:0.85em"></span>
            </div>
          </div>
          <div class="md-field">
            <label>Status Field</label>
            <select id="md-jira-status-field">
              <option value="">(auto-discover by name "AI-Implement Status")</option>
            </select>
            <div class="text-tertiary" style="font-size:0.85em;margin-top:4px">
              Leave at auto-discover if your Jira instance has a custom field named exactly &ldquo;AI-Implement Status&rdquo;. Otherwise pick the field that holds the workflow status (Ready, Planning, Implementing, etc.).
            </div>
          </div>
          <div class="md-field">
            <label>Repo Field</label>
            <select id="md-jira-repo-field" onchange="onRepoFieldChange()">
              <option value="">(auto-discover by name "AI-Implement Repo")</option>
            </select>
            <div class="text-tertiary" style="font-size:0.85em;margin-top:4px">
              Leave at auto-discover if your Jira instance has a custom field named exactly &ldquo;AI-Implement Repo&rdquo;. Otherwise pick the field that identifies which GitHub repo an issue belongs to.
            </div>
          </div>
          <div class="md-field">
            <label>Repo Field Value</label>
            <select id="md-jira-repo-value">
              <option value="">Select a Repo Field first</option>
            </select>
            <input id="md-jira-repo-value-text" type="text" class="hidden" placeholder="owner/repo">
          </div>
        </div>
      </fieldset>
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
        <legend>Claude Provider</legend>
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
        <button class="btn btn-ghost" onclick="closeMappingDialog()">Cancel</button>
        <button class="btn btn-accent" onclick="saveMappingDialog()">Save Mapping</button>
      </div>
    </div>
  </dialog>
</section>
`;

export const projectsScript = `
(function () {
  let mappingsData = {};
  let currentSecretsTeam = null;
  let pendingJiraRepoFieldValue = '';
  let jiraFieldsLoaded = false;

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
        ? '<span class="badge info">fly</span>'
        : '<span class="badge neutral">gha</span>';
      const planBadge = m.planningEnabled
        ? '<span class="badge success">on</span>'
        : '<span class="text-tertiary">off</span>';
      const providerBadge = m.provider === 'bedrock'
        ? '<span class="badge warn">bedrock</span>'
        : '<span class="text-tertiary" style="font-size:0.85em">anthropic</span>';
      const statusBadge = m.paused
        ? '<span class="badge warn">paused</span>'
        : '<span class="badge success">active</span>';
      const pauseLabel = m.paused ? 'Resume' : 'Pause';
      tr.innerHTML = '<td class="mono">' + ek + '</td>'
        + '<td class="mono">' + window.esc(m.owner) + '/' + window.esc(m.repo) + '</td>'
        + '<td>' + execBadge + '</td>'
        + '<td style="color:#666;font-size:0.85em">' + window.esc(m.sessionMode || 'autonomous') + '</td>'
        + '<td style="text-align:center">' + window.esc(String(m.maxInProgressAiIssues ?? 3)) + '</td>'
        + '<td>' + planBadge + '</td>'
        + '<td>' + providerBadge + '</td>'
        + '<td>' + statusBadge + '</td>'
        + '<td style="white-space:nowrap">'
          + '<button class="btn btn-sm" data-key="' + ek + '" data-paused="' + (m.paused ? '1' : '0') + '" onclick="togglePause(this.dataset.key, this.dataset.paused === \\'1\\')">' + pauseLabel + '</button> '
          + '<button class="btn btn-sm" data-key="' + ek + '" onclick="openMappingDialog(this.dataset.key)">Edit</button> '
          + '<button class="btn btn-sm btn-danger" data-key="' + ek + '" onclick="delMapping(this.dataset.key)">Del</button> '
          + '<button class="btn btn-sm btn-ghost" data-key="' + ek + '" onclick="syncWorkflows(this)">Sync workflows</button> '
          + '<button class="btn btn-sm btn-ghost" data-key="' + ek + '" onclick="showSecrets(this.dataset.key)">Secrets</button>'
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

    // Ticketing provider + Jira config
    const tp = m.ticketingProvider || 'linear';
    document.getElementById('md-ticketing-provider').value = tp;
    const tc = (m.ticketingConfig && typeof m.ticketingConfig === 'object') ? m.ticketingConfig : {};
    document.getElementById('md-jira-mapping-id').value = (tp === 'jira' && tc.kind === 'jira') ? (key || '') : '';
    document.getElementById('md-jira-jql').value = (tp === 'jira' && tc.kind === 'jira' && tc.jql) ? tc.jql : '';
    const pendingStatus = (tp === 'jira' && tc.statusFieldOverride) ? tc.statusFieldOverride : '';
    const pendingRepoFld = (tp === 'jira' && tc.repoFieldOverride) ? tc.repoFieldOverride : '';
    const statusFldEl = document.getElementById('md-jira-status-field');
    const repoFldEl = document.getElementById('md-jira-repo-field');
    statusFldEl.dataset.pendingValue = pendingStatus;
    repoFldEl.dataset.pendingValue = pendingRepoFld;
    statusFldEl.value = pendingStatus;
    repoFldEl.value = pendingRepoFld;
    // Repo field value: stash for after the dropdown loads
    const pendingRepoVal = (tp === 'jira' && tc.kind === 'jira' && tc.repoFieldValue) ? tc.repoFieldValue : '';
    const sel = document.getElementById('md-jira-repo-value');
    const txt = document.getElementById('md-jira-repo-value-text');
    sel.innerHTML = '<option value="">Select a Repo Field first</option>';
    sel.value = '';
    txt.value = pendingRepoVal;
    sel.classList.toggle('hidden', tp === 'jira' && !!pendingRepoVal);
    txt.classList.toggle('hidden', !(tp === 'jira' && !!pendingRepoVal));
    document.getElementById('md-jira-jql-status').textContent = '';
    pendingJiraRepoFieldValue = pendingRepoVal;

    onExecModeChange();
    onProviderChange();
    onPlanningChange();
    onTicketingProviderChange();

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

  function onTicketingProviderChange() {
    const provider = document.getElementById('md-ticketing-provider').value;
    const jiraFields = document.getElementById('md-jira-fields');
    if (provider === 'jira') {
      jiraFields.classList.remove('hidden');
      loadJiraFields();
      preloadRepoFieldOptions();
    } else {
      jiraFields.classList.add('hidden');
    }
  }
  window.onTicketingProviderChange = onTicketingProviderChange;

  async function loadJiraFields() {
    const statusSel = document.getElementById('md-jira-status-field');
    const repoSel = document.getElementById('md-jira-repo-field');
    if (jiraFieldsLoaded) return;
    try {
      const res = await window.api('/api/jira/fields');
      if (!res.ok) return;
      const fields = await res.json();
      fields.sort(function (a, b) {
        return a.name.toLowerCase().localeCompare(b.name.toLowerCase());
      });
      const prevStatus = statusSel ? (statusSel.value || statusSel.dataset.pendingValue || '') : '';
      const prevRepo = repoSel ? (repoSel.value || repoSel.dataset.pendingValue || '') : '';
      const statusPlaceholder = statusSel && statusSel.options[0] ? statusSel.options[0] : null;
      const repoPlaceholder = repoSel && repoSel.options[0] ? repoSel.options[0] : null;
      if (statusSel) statusSel.innerHTML = '';
      if (repoSel) repoSel.innerHTML = '';
      if (statusSel && statusPlaceholder) statusSel.appendChild(statusPlaceholder);
      if (repoSel && repoPlaceholder) repoSel.appendChild(repoPlaceholder);
      for (const f of fields) {
        const labelText = f.name + ' (' + f.id + ')';
        if (statusSel) {
          const o1 = document.createElement('option');
          o1.value = f.id;
          o1.textContent = labelText;
          statusSel.appendChild(o1);
        }
        if (repoSel) {
          const o2 = document.createElement('option');
          o2.value = f.id;
          o2.textContent = labelText;
          repoSel.appendChild(o2);
        }
      }
      // Restore previously set values (e.g. from openMappingDialog before fields loaded)
      if (statusSel && prevStatus) statusSel.value = prevStatus;
      if (repoSel && prevRepo) repoSel.value = prevRepo;
      jiraFieldsLoaded = true;
    } catch (err) {
      console.error('loadJiraFields failed:', err);
    }
  }

  async function preloadRepoFieldOptions() {
    const repoFieldInput = document.getElementById('md-jira-repo-field');
    if (repoFieldInput.value) {
      // explicit override — let onRepoFieldChange handle population
      onRepoFieldChange();
      return;
    }
    try {
      const res = await window.api('/api/jira/fields?name=' + encodeURIComponent('AI-Implement Repo'));
      if (!res.ok) return;
      const fields = await res.json();
      if (Array.isArray(fields) && fields.length === 1) {
        await populateRepoValueOptions(fields[0].id);
      }
    } catch (err) {
      console.error('preloadRepoFieldOptions failed:', err);
    }
  }

  async function populateRepoValueOptions(fieldId) {
    const select = document.getElementById('md-jira-repo-value');
    const text = document.getElementById('md-jira-repo-value-text');
    try {
      const res = await window.api('/api/jira/field-options?fieldId=' + encodeURIComponent(fieldId));
      if (!res.ok) throw new Error('fetch failed');
      const options = await res.json();
      if (!Array.isArray(options) || options.length === 0) {
        // fall back to text input
        select.classList.add('hidden');
        text.classList.remove('hidden');
        if (pendingJiraRepoFieldValue) text.value = pendingJiraRepoFieldValue;
        return;
      }
      let html = '<option value="">(select)</option>';
      for (const o of options) {
        const v = window.esc(o.value);
        html += '<option value="' + v + '">' + v + '</option>';
      }
      select.innerHTML = html;
      select.classList.remove('hidden');
      text.classList.add('hidden');
      // Try to apply pending value
      if (pendingJiraRepoFieldValue) {
        const has = Array.from(select.options).some(function (o) { return o.value === pendingJiraRepoFieldValue; });
        if (has) {
          select.value = pendingJiraRepoFieldValue;
        } else {
          select.classList.add('hidden');
          text.classList.remove('hidden');
          text.value = pendingJiraRepoFieldValue;
        }
      }
    } catch (err) {
      console.error('populateRepoValueOptions failed:', err);
      select.classList.add('hidden');
      text.classList.remove('hidden');
      if (pendingJiraRepoFieldValue) text.value = pendingJiraRepoFieldValue;
    }
  }

  async function onRepoFieldChange() {
    const fieldId = document.getElementById('md-jira-repo-field').value;
    const select = document.getElementById('md-jira-repo-value');
    const text = document.getElementById('md-jira-repo-value-text');
    if (!fieldId) {
      select.innerHTML = '<option value="">Select a Repo Field first</option>';
      select.classList.remove('hidden');
      text.classList.add('hidden');
      return;
    }
    await populateRepoValueOptions(fieldId);
  }
  window.onRepoFieldChange = onRepoFieldChange;

  function detectStatusFilterInJql(jql, statusFieldOverride) {
    // Returns a warning string if the JQL looks like it references the AI-Implement Status
    // field. The orchestrator wraps the user's JQL with its own status filter, so any
    // status clause here will conflict with status transitions.
    if (/ai[\\s\\-_]?implement[\\s\\-_]?status/i.test(jql)) {
      return 'JQL appears to reference the AI-Implement Status field. ' +
        'The orchestrator adds its own status filter at query time — including one in ' +
        'your JQL will prevent the issue from being picked up after status transitions ' +
        '(e.g. Plan Approved → Implementing won\\'t flow). Remove status filters from this JQL.';
    }
    if (statusFieldOverride) {
      const idPattern = new RegExp('\\\\b' + statusFieldOverride.replace(/[^a-zA-Z0-9_]/g, '') + '\\\\b');
      if (idPattern.test(jql)) {
        return 'JQL appears to reference customfield ' + statusFieldOverride + ' (your status field). ' +
          'The orchestrator adds its own status filter at query time — remove the status clause here.';
      }
    }
    return null;
  }

  async function validateJqlButton() {
    const jql = document.getElementById('md-jira-jql').value;
    const statusFieldOverride = document.getElementById('md-jira-status-field').value;
    const status = document.getElementById('md-jira-jql-status');
    status.textContent = 'Validating...';
    status.style.color = '';
    try {
      const res = await window.api('/api/jira/validate-jql', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jql: jql }),
      });
      if (!res.ok) {
        let errMsg = 'unknown error';
        try { const err = await res.json(); errMsg = err.error || errMsg; } catch (_) {}
        status.textContent = 'Invalid: ' + errMsg;
        status.style.color = 'var(--st-fail-fg)';
        return;
      }
      await res.json();
      const warning = detectStatusFilterInJql(jql, statusFieldOverride);
      if (warning) {
        status.textContent = '⚠ Valid but: ' + warning;
        status.style.color = 'var(--st-warn-fg, #c80)';
      } else {
        status.textContent = 'Valid';
        status.style.color = 'var(--st-ok-fg, #2a8)';
      }
    } catch (err) {
      status.textContent = 'Error: ' + (err && err.message ? err.message : String(err));
      status.style.color = 'var(--st-fail-fg)';
    }
  }
  window.validateJqlButton = validateJqlButton;

  async function applyConfigStatus() {
    try {
      const res = await window.api('/api/admin/config-status');
      if (!res.ok) return;
      const status = await res.json();
      if (status.jiraSiteUrl) window.jiraSiteUrl = status.jiraSiteUrl;
      const select = document.getElementById('md-ticketing-provider');
      for (const opt of Array.from(select.options)) {
        if (opt.value === 'linear' && !status.linear) {
          opt.disabled = true;
          opt.textContent = 'Linear (not configured)';
        }
        if (opt.value === 'jira' && !status.jira) {
          opt.disabled = true;
          opt.textContent = 'Jira (not configured)';
        }
      }
    } catch (err) {
      console.error('applyConfigStatus failed:', err);
    }
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

    const ticketingProvider = document.getElementById('md-ticketing-provider').value;
    body.ticketingProvider = ticketingProvider;
    if (ticketingProvider === 'linear') {
      body.ticketingConfig = { kind: 'linear' };
    } else if (ticketingProvider === 'jira') {
      const jql = document.getElementById('md-jira-jql').value;
      const sel = document.getElementById('md-jira-repo-value');
      const txt = document.getElementById('md-jira-repo-value-text');
      const repoFieldValue = sel.classList.contains('hidden') ? txt.value.trim() : sel.value.trim();
      const statusFieldOverride = document.getElementById('md-jira-status-field').value.trim() || null;
      const repoFieldOverride = document.getElementById('md-jira-repo-field').value.trim() || null;
      body.ticketingConfig = {
        kind: 'jira',
        jql: jql,
        repoFieldValue: repoFieldValue,
        statusFieldOverride: statusFieldOverride,
        repoFieldOverride: repoFieldOverride,
      };
    }

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

  async function togglePause(key, currentlyPaused) {
    const nextPaused = !currentlyPaused;
    const res = await window.api('/api/mappings/' + encodeURIComponent(key), {
      method: 'PATCH',
      body: JSON.stringify({ paused: nextPaused }),
    });
    if (!res.ok) {
      alert('Failed to ' + (nextPaused ? 'pause' : 'resume') + ' project');
      return;
    }
    await loadMappings();
  }
  window.togglePause = togglePause;

  async function syncWorkflows(button) {
    const key = button.dataset.key;
    const original = button.textContent;
    button.disabled = true;
    button.textContent = 'Syncing...';
    try {
      const res = await window.api('/api/mappings/' + encodeURIComponent(key) + '/sync-workflows', {
        method: 'POST',
      });
      let data = {};
      try { data = await res.json(); } catch (_) {}
      if (!res.ok) {
        throw new Error(data.error || 'Failed to sync workflows');
      }
      const labels = {
        'up-to-date': 'Up to date',
        'pr-existing': 'PR exists',
        'pr-opened': 'PR opened',
        'pr-updated': 'PR updated',
      };
      button.textContent = labels[data.status] || 'Synced';
      if (data.prUrl) {
        button.title = data.prUrl;
        window.open(data.prUrl, '_blank', 'noopener,noreferrer');
      }
      setTimeout(function () {
        button.textContent = original;
        button.disabled = false;
      }, 4000);
    } catch (err) {
      button.textContent = 'Sync failed';
      button.disabled = false;
      alert(err && err.message ? err.message : String(err));
      setTimeout(function () { button.textContent = original; }, 4000);
    }
  }
  window.syncWorkflows = syncWorkflows;

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
          + '<td><span class="badge success">Set</span></td>'
          + '<td><button class="btn btn-sm btn-danger" data-name="' + window.esc(s.name) + '" onclick="delSecret(this.dataset.name)">Delete</button></td>';
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

  window.loadMappings = loadMappings;
  window.registerPage('projects', function () { loadMappings(); applyConfigStatus(); });
})();
`;
