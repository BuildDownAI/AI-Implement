export const stepperHtml = `
<div id="np-stepper-wrap" class="modal" hidden>
  <div class="modal-backdrop" onclick="closeNewProjectStepper()"></div>
  <div class="modal-card" style="display:flex;flex-direction:column;max-height:90vh">
    <div style="padding:18px 24px 14px;border-bottom:1px solid var(--border-subtle);display:flex;justify-content:space-between;align-items:center">
      <div>
        <h2 style="font-size:15px;font-weight:600;margin:0">New project</h2>
        <div style="font-size:12px;color:var(--fg-tertiary);margin-top:2px">Bind a Linear team to a GitHub repo and configure how AI-Implement runs against it.</div>
      </div>
      <button class="btn btn-ghost btn-icon" onclick="closeNewProjectStepper()" title="Close">&times;</button>
    </div>

    <div class="stepper" id="np-stepper-rail"></div>

    <div id="np-step-body" style="padding:24px;flex:1;overflow-y:auto;min-height:360px">
      <div data-step="0">
        <h3 style="font-size:13px;font-weight:600;margin:0 0 4px">Source</h3>
        <p style="font-size:12px;color:var(--fg-tertiary);margin:0 0 20px">Connect a Linear team to its GitHub repository.</p>
        <div class="alert info" style="margin-bottom:18px">
          <div class="alert-icon">&#8505;</div>
          <div style="flex:1">
            <div class="alert-title">GitHub App required</div>
            <div class="alert-desc">Make sure the AI-Implement GitHub App is installed on the target repository before creating this project.</div>
          </div>
        </div>
        <div class="field">
          <label class="field-label">Linear Team Key</label>
          <input class="input mono" id="np-teamKey" placeholder="MY_TEAM" autocomplete="off">
          <div class="field-hint">The uppercase identifier for your Linear team (e.g. ENG, BACKEND).</div>
        </div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">
          <div class="field">
            <label class="field-label">GitHub Owner</label>
            <input class="input mono" id="np-owner" placeholder="acme-corp" autocomplete="off">
            <div class="field-hint">Org or user that owns the repo.</div>
          </div>
          <div class="field">
            <label class="field-label">Repository Name</label>
            <input class="input mono" id="np-repo" placeholder="backend" autocomplete="off">
            <div class="field-hint">Repository name only (no owner prefix).</div>
          </div>
        </div>
      </div>

      <div data-step="1" hidden>
        <h3 style="font-size:13px;font-weight:600;margin:0 0 4px">Runner</h3>
        <p style="font-size:12px;color:var(--fg-tertiary);margin:0 0 20px">Choose where AI-Implement executes implementation runs.</p>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:18px">
          <div class="runner-card active" data-runner="github-actions" onclick="selectExecutionMode('github-actions')">
            <div style="font-size:13px;font-weight:600;margin-bottom:4px">GitHub Actions</div>
            <div style="font-size:12px;color:var(--fg-secondary)">Run Claude via GitHub-hosted or self-hosted runners. Zero infrastructure overhead.</div>
          </div>
          <div class="runner-card" data-runner="fly-machines" onclick="selectExecutionMode('fly-machines')">
            <div style="font-size:13px;font-weight:600;margin-bottom:4px">Fly Machines</div>
            <div style="font-size:12px;color:var(--fg-secondary)">Run Claude on dedicated Fly.io VMs. Persistent sessions and interactive mode support.</div>
          </div>
        </div>
        <div id="np-fly-fields" hidden style="margin-bottom:18px">
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">
            <div class="field">
              <label class="field-label">CPUs</label>
              <input class="input" id="np-cpus" type="number" min="1" value="2">
            </div>
            <div class="field">
              <label class="field-label">Memory (MB)</label>
              <input class="input" id="np-mem" type="number" min="256" step="256" value="4096">
            </div>
          </div>
        </div>
        <div class="field">
          <label class="field-label">Session Mode</label>
          <select class="input" id="np-sessionMode">
            <option value="autonomous">autonomous &mdash; fully automated, no human input</option>
            <option value="interactive">interactive &mdash; Claude pauses for feedback</option>
            <option value="hybrid">hybrid &mdash; starts autonomous, escalates when stuck</option>
          </select>
        </div>
      </div>

      <div data-step="2" hidden>
        <h3 style="font-size:13px;font-weight:600;margin:0 0 4px">Provider</h3>
        <p style="font-size:12px;color:var(--fg-tertiary);margin:0 0 20px">Select the AI provider and configure planning behaviour.</p>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:18px">
          <div class="runner-card active" data-provider="anthropic" onclick="selectProvider('anthropic')">
            <div style="font-size:13px;font-weight:600;margin-bottom:4px">Anthropic API</div>
            <div style="font-size:12px;color:var(--fg-secondary)">Use the Anthropic API directly. Set ANTHROPIC_API_KEY or CLAUDE_CODE_OAUTH_TOKEN in Secrets.</div>
          </div>
          <div class="runner-card" data-provider="bedrock" onclick="selectProvider('bedrock')">
            <div style="font-size:13px;font-weight:600;margin-bottom:4px">AWS Bedrock</div>
            <div style="font-size:12px;color:var(--fg-secondary)">Use Claude via AWS Bedrock with OIDC role-based auth. Requires GitHub Actions runner.</div>
          </div>
        </div>
        <div id="np-bedrock-fly-warn" class="alert warn" hidden style="margin-bottom:14px">
          <div class="alert-icon">&#9888;</div>
          <div style="flex:1">
            <div class="alert-title">Unsupported combination</div>
            <div class="alert-desc">AWS Bedrock cannot be used with the Fly Machines runner. Switch to GitHub Actions on the Runner step, or choose Anthropic API.</div>
          </div>
        </div>
        <div id="np-bedrock-region-wrap" hidden style="margin-bottom:18px">
          <div class="field">
            <label class="field-label">AWS Region</label>
            <input class="input mono" id="np-awsRegion" placeholder="us-west-2">
            <div class="field-hint">The AWS region where your Bedrock inference profile is deployed.</div>
          </div>
        </div>
        <div style="margin-top:4px">
          <div style="font-size:12px;font-weight:500;color:var(--fg-secondary);margin-bottom:10px">Planning</div>
          <label style="display:flex;align-items:center;gap:8px;font-size:12.5px;margin-bottom:8px;cursor:pointer">
            <input type="checkbox" id="np-planning" checked style="width:auto">
            Enable planning — Claude analyses the codebase and posts a structured plan to Linear before implementing.
          </label>
          <label style="display:flex;align-items:center;gap:8px;font-size:12.5px;cursor:pointer">
            <input type="checkbox" id="np-autoApprove" checked style="width:auto">
            Auto-approve plans — skip the manual approval step and proceed to implementation automatically.
          </label>
        </div>
      </div>

      <div data-step="3" hidden>
        <h3 style="font-size:13px;font-weight:600;margin:0 0 4px">Capacity</h3>
        <p style="font-size:12px;color:var(--fg-tertiary);margin:0 0 20px">Limit how many AI issues run concurrently for this project.</p>
        <div class="alert warn" style="margin-bottom:18px">
          <div class="alert-icon">&#9888;</div>
          <div style="flex:1">
            <div class="alert-title">Affects billing and noise</div>
            <div class="alert-desc">Each in-progress issue consumes API quota and spawns at least one GitHub Actions run or Fly Machine. Keep low (1&ndash;3) while evaluating.</div>
          </div>
        </div>
        <div class="field" style="max-width:180px">
          <label class="field-label">Max parallel AI issues</label>
          <input class="input" type="number" id="np-maxAi" min="1" value="3">
          <div class="field-hint">Must be a positive integer.</div>
        </div>
      </div>

      <div data-step="4" hidden>
        <h3 style="font-size:13px;font-weight:600;margin:0 0 4px">Secrets</h3>
        <p style="font-size:12px;color:var(--fg-tertiary);margin:0 0 20px">Optionally seed one or more secrets for this project now. You can always add or update secrets later via the Secrets button on the Projects page.</p>
        <div class="alert info" style="margin-bottom:18px">
          <div class="alert-icon">&#8505;</div>
          <div style="flex:1">
            <div class="alert-title">Write-only</div>
            <div class="alert-desc">Secrets are stored encrypted and cannot be read back. Each secret is a name&thinsp;+&thinsp;value pair stored under this team key.</div>
          </div>
        </div>
        <div id="np-secrets-list" style="display:flex;flex-direction:column;gap:8px;margin-bottom:12px"></div>
        <button class="btn btn-sm" onclick="addSecretRow()">+ Add secret</button>
      </div>

      <div data-step="5" hidden>
        <h3 style="font-size:13px;font-weight:600;margin:0 0 4px">Review</h3>
        <p style="font-size:12px;color:var(--fg-tertiary);margin:0 0 20px">Confirm your settings before creating the project.</p>
        <div style="display:flex;flex-direction:column">
          <div class="np-review-row">
            <div class="np-review-label">Team Key</div>
            <div data-review="teamKey" class="mono"></div>
          </div>
          <div class="np-review-row">
            <div class="np-review-label">Repository</div>
            <div data-review="repo" class="mono"></div>
          </div>
          <div class="np-review-row">
            <div class="np-review-label">Runner</div>
            <div data-review="runner"></div>
          </div>
          <div class="np-review-row">
            <div class="np-review-label">Session mode</div>
            <div data-review="session"></div>
          </div>
          <div class="np-review-row">
            <div class="np-review-label">Provider</div>
            <div data-review="provider"></div>
          </div>
          <div class="np-review-row">
            <div class="np-review-label">Planning</div>
            <div data-review="planning"></div>
          </div>
          <div class="np-review-row">
            <div class="np-review-label">Capacity</div>
            <div data-review="cap"></div>
          </div>
          <div class="np-review-row">
            <div class="np-review-label">Secrets</div>
            <div data-review="secrets"></div>
          </div>
        </div>
      </div>
    </div>

    <div id="np-error" class="error hidden" style="margin:0 24px"></div>

    <div style="padding:14px 24px;border-top:1px solid var(--border-subtle);display:flex;justify-content:space-between;gap:8px">
      <button class="btn btn-sm" onclick="closeNewProjectStepper()">Cancel</button>
      <div style="display:flex;gap:6px">
        <button id="np-back" class="btn btn-sm" onclick="stepperBack()" hidden>Back</button>
        <button id="np-next" class="btn btn-primary btn-sm" onclick="stepperNext()">Continue &rarr;</button>
        <button id="np-create" class="btn btn-accent btn-sm" onclick="stepperSubmit()" hidden>Create project</button>
      </div>
    </div>
  </div>
</div>
`;

export const stepperScript = `
(function () {
  let step = 0;
  const STEP_LABELS = ['Source', 'Runner', 'Provider', 'Capacity', 'Secrets', 'Review'];
  const data = {
    teamKey: '', owner: '', repo: '',
    executionMode: 'github-actions', machineCpus: 2, machineMemoryMb: 4096, sessionMode: 'autonomous',
    provider: 'anthropic', awsRegion: '',
    planningEnabled: true, autoApprovePlans: true,
    maxInProgressAiIssues: 3,
    secrets: [],
  };

  function openNewProjectStepper() {
    // Reset state
    step = 0;
    data.teamKey = '';
    data.owner = '';
    data.repo = '';
    data.executionMode = 'github-actions';
    data.machineCpus = 2;
    data.machineMemoryMb = 4096;
    data.sessionMode = 'autonomous';
    data.provider = 'anthropic';
    data.awsRegion = '';
    data.planningEnabled = true;
    data.autoApprovePlans = true;
    data.maxInProgressAiIssues = 3;
    data.secrets = [];

    // Clear inputs
    const toClear = ['np-teamKey', 'np-owner', 'np-repo', 'np-awsRegion'];
    for (const id of toClear) {
      const el = document.getElementById(id);
      if (el) el.value = '';
    }
    const cpusEl = document.getElementById('np-cpus');
    if (cpusEl) cpusEl.value = '2';
    const memEl = document.getElementById('np-mem');
    if (memEl) memEl.value = '4096';
    const maxAiEl = document.getElementById('np-maxAi');
    if (maxAiEl) maxAiEl.value = '3';
    const sessionEl = document.getElementById('np-sessionMode');
    if (sessionEl) sessionEl.value = 'autonomous';
    const planningEl = document.getElementById('np-planning');
    if (planningEl) planningEl.checked = true;
    const autoApproveEl = document.getElementById('np-autoApprove');
    if (autoApproveEl) autoApproveEl.checked = true;

    // Reset runner cards
    for (const card of document.querySelectorAll('[data-runner]')) {
      card.classList.toggle('active', card.dataset.runner === 'github-actions');
    }
    const flyFields = document.getElementById('np-fly-fields');
    if (flyFields) flyFields.setAttribute('hidden', '');

    // Reset provider cards
    for (const card of document.querySelectorAll('[data-provider]')) {
      card.classList.toggle('active', card.dataset.provider === 'anthropic');
    }
    const bedrockWrap = document.getElementById('np-bedrock-region-wrap');
    if (bedrockWrap) bedrockWrap.setAttribute('hidden', '');
    const bedrockWarn = document.getElementById('np-bedrock-fly-warn');
    if (bedrockWarn) bedrockWarn.setAttribute('hidden', '');

    // Clear secrets list
    const secretsList = document.getElementById('np-secrets-list');
    if (secretsList) secretsList.innerHTML = '';

    // Hide error
    const errEl = document.getElementById('np-error');
    if (errEl) { errEl.textContent = ''; errEl.classList.add('hidden'); }

    renderRail();
    showStep(0);
    document.getElementById('np-stepper-wrap').removeAttribute('hidden');
    document.body.style.overflow = 'hidden';
  }

  function closeNewProjectStepper() {
    const wrap = document.getElementById('np-stepper-wrap');
    if (wrap) wrap.setAttribute('hidden', '');
    document.body.style.overflow = '';
    const errEl = document.getElementById('np-error');
    if (errEl) errEl.classList.add('hidden');
  }

  function renderRail() {
    const rail = document.getElementById('np-stepper-rail');
    if (!rail) return;
    let html = '';
    for (let i = 0; i < STEP_LABELS.length; i++) {
      const cls = i === step ? 'active' : i < step ? 'done' : '';
      const numContent = i < step ? '&#10003;' : String(i + 1);
      html += '<div class="stepper-step ' + cls + '"><div class="num">' + numContent + '</div>' + STEP_LABELS[i] + '</div>';
      if (i < STEP_LABELS.length - 1) {
        html += '<div class="stepper-divider"></div>';
      }
    }
    rail.innerHTML = html;
  }

  function showStep(n) {
    const body = document.getElementById('np-step-body');
    if (!body) return;
    for (const block of body.querySelectorAll('[data-step]')) {
      const blockStep = parseInt(block.dataset.step, 10);
      if (blockStep === n) {
        block.removeAttribute('hidden');
      } else {
        block.setAttribute('hidden', '');
      }
    }

    const backBtn = document.getElementById('np-back');
    const nextBtn = document.getElementById('np-next');
    const createBtn = document.getElementById('np-create');

    if (backBtn) { if (n === 0) backBtn.setAttribute('hidden', ''); else backBtn.removeAttribute('hidden'); }
    if (nextBtn) { if (n === 5) nextBtn.setAttribute('hidden', ''); else nextBtn.removeAttribute('hidden'); }
    if (createBtn) { if (n === 5) createBtn.removeAttribute('hidden'); else createBtn.setAttribute('hidden', ''); }

    renderRail();
    if (n === 5) populateReview();
  }

  function stepperBack() {
    collectStep(step);
    step--;
    showStep(step);
  }

  function stepperNext() {
    collectStep(step);
    if (validateStep(step)) {
      step++;
      showStep(step);
    }
  }

  function collectStep(n) {
    if (n === 0) {
      const tkEl = document.getElementById('np-teamKey');
      const owEl = document.getElementById('np-owner');
      const reEl = document.getElementById('np-repo');
      if (tkEl) data.teamKey = tkEl.value.trim();
      if (owEl) data.owner = owEl.value.trim();
      if (reEl) data.repo = reEl.value.trim();
    } else if (n === 1) {
      const smEl = document.getElementById('np-sessionMode');
      const cpEl = document.getElementById('np-cpus');
      const memEl = document.getElementById('np-mem');
      if (smEl) data.sessionMode = smEl.value;
      if (cpEl) data.machineCpus = parseInt(cpEl.value, 10) || 2;
      if (memEl) data.machineMemoryMb = parseInt(memEl.value, 10) || 4096;
    } else if (n === 2) {
      const arEl = document.getElementById('np-awsRegion');
      const plEl = document.getElementById('np-planning');
      const aaEl = document.getElementById('np-autoApprove');
      if (arEl) data.awsRegion = arEl.value.trim();
      if (plEl) data.planningEnabled = plEl.checked;
      if (aaEl) data.autoApprovePlans = aaEl.checked;
    } else if (n === 3) {
      const maxEl = document.getElementById('np-maxAi');
      if (maxEl) data.maxInProgressAiIssues = parseInt(maxEl.value, 10);
    } else if (n === 4) {
      const secrets = [];
      const list = document.getElementById('np-secrets-list');
      if (list) {
        for (const row of list.querySelectorAll('[data-secret-row]')) {
          const nameEl = row.querySelector('.np-secret-name');
          const valEl = row.querySelector('.np-secret-value');
          if (nameEl && valEl) {
            const name = nameEl.value.trim();
            const value = valEl.value;
            secrets.push({ name, value });
          }
        }
      }
      data.secrets = secrets;
    }
  }

  function showError(msg) {
    const errEl = document.getElementById('np-error');
    if (errEl) { errEl.textContent = msg; errEl.classList.remove('hidden'); }
  }

  function hideError() {
    const errEl = document.getElementById('np-error');
    if (errEl) errEl.classList.add('hidden');
  }

  function validateStep(n) {
    hideError();
    if (n === 0) {
      if (!data.teamKey) { showError('Team Key is required.'); return false; }
      if (!data.owner) { showError('GitHub Owner is required.'); return false; }
      if (!data.repo) { showError('Repository Name is required.'); return false; }
    } else if (n === 1) {
      // executionMode is set via card selection — always valid
    } else if (n === 2) {
      if (data.provider === 'bedrock' && data.executionMode === 'fly-machines') {
        showError('AWS Bedrock cannot be used with the Fly Machines runner. Please change the runner or provider.');
        return false;
      }
      if (data.provider === 'bedrock' && !data.awsRegion) {
        showError('AWS Region is required when using the Bedrock provider.');
        return false;
      }
    } else if (n === 3) {
      if (!Number.isFinite(data.maxInProgressAiIssues) || data.maxInProgressAiIssues < 1) {
        showError('Max parallel AI issues must be a positive integer.');
        return false;
      }
    }
    return true;
  }

  function populateReview() {
    const set = function (attr, html) {
      const el = document.querySelector('[data-review="' + attr + '"]');
      if (el) el.innerHTML = html;
    };

    set('teamKey', window.esc(data.teamKey) || '&mdash;');
    set('repo', window.esc(data.owner) + '/' + window.esc(data.repo));

    let runnerText = window.esc(data.executionMode);
    if (data.executionMode === 'fly-machines') {
      runnerText += ' &middot; ' + data.machineCpus + 'cpu / ' + data.machineMemoryMb + ' MB';
    }
    set('runner', runnerText);

    set('session', window.esc(data.sessionMode));

    let providerText = window.esc(data.provider);
    if (data.provider === 'bedrock') {
      providerText += ' &middot; ' + window.esc(data.awsRegion);
    }
    set('provider', providerText);

    let planningText = data.planningEnabled ? 'enabled' : 'disabled';
    if (data.planningEnabled && data.autoApprovePlans) {
      planningText += ' &middot; auto-approve';
    }
    set('planning', planningText);

    set('cap', data.maxInProgressAiIssues + ' parallel');

    const validSecrets = data.secrets.filter(function (s) { return s.name && s.value; });
    set('secrets', validSecrets.length + ' configured');
  }

  function selectExecutionMode(mode) {
    data.executionMode = mode;
    for (const card of document.querySelectorAll('[data-runner]')) {
      card.classList.toggle('active', card.dataset.runner === mode);
    }
    const flyFields = document.getElementById('np-fly-fields');
    if (flyFields) {
      if (mode === 'fly-machines') flyFields.removeAttribute('hidden');
      else flyFields.setAttribute('hidden', '');
    }
    // Refresh bedrock+fly warning if on provider step
    const bedrockWarn = document.getElementById('np-bedrock-fly-warn');
    if (bedrockWarn) {
      if (data.provider === 'bedrock' && mode === 'fly-machines') {
        bedrockWarn.removeAttribute('hidden');
      } else {
        bedrockWarn.setAttribute('hidden', '');
      }
    }
  }

  function selectProvider(p) {
    data.provider = p;
    for (const card of document.querySelectorAll('[data-provider]')) {
      card.classList.toggle('active', card.dataset.provider === p);
    }
    const bedrockWrap = document.getElementById('np-bedrock-region-wrap');
    if (bedrockWrap) {
      if (p === 'bedrock') bedrockWrap.removeAttribute('hidden');
      else bedrockWrap.setAttribute('hidden', '');
    }
    const bedrockWarn = document.getElementById('np-bedrock-fly-warn');
    if (bedrockWarn) {
      if (p === 'bedrock' && data.executionMode === 'fly-machines') {
        bedrockWarn.removeAttribute('hidden');
      } else {
        bedrockWarn.setAttribute('hidden', '');
      }
    }
  }

  function addSecretRow() {
    const list = document.getElementById('np-secrets-list');
    if (!list) return;
    const row = document.createElement('div');
    row.setAttribute('data-secret-row', '');
    row.style.cssText = 'display:flex;gap:8px;align-items:center';
    row.innerHTML = '<input class="input mono np-secret-name" placeholder="ANTHROPIC_API_KEY" style="flex:1">'
      + '<input class="input np-secret-value" type="password" placeholder="value" style="flex:2">'
      + '<button class="btn btn-ghost btn-icon" onclick="removeSecretRow(this)" title="Remove">&times;</button>';
    list.appendChild(row);
  }

  function removeSecretRow(btnEl) {
    const row = btnEl.closest('[data-secret-row]');
    if (row) row.remove();
  }

  async function stepperSubmit() {
    // Collect any final values from step 4 (secrets are already collected on back/next, but collect once more to be safe)
    collectStep(4);

    // Validate all non-secret steps
    for (let i = 0; i < 4; i++) {
      collectStep(i);
      if (!validateStep(i)) return;
    }

    const body = {
      teamKey: data.teamKey,
      owner: data.owner,
      repo: data.repo,
      workflowFile: 'claude-implement.yml',
      defaultBranch: 'main',
      maxInProgressAiIssues: data.maxInProgressAiIssues,
      executionMode: data.executionMode,
      sessionMode: data.sessionMode,
      machineCpus: data.machineCpus,
      machineMemoryMb: data.machineMemoryMb,
      planningEnabled: data.planningEnabled,
      autoApprovePlans: data.autoApprovePlans,
      planningWorkflowFile: 'claude-plan.yml',
      extraEnv: {},
      provider: data.provider,
      awsRegion: data.provider === 'bedrock' ? (data.awsRegion || null) : null,
    };

    const res = await window.api('/api/mappings', { method: 'POST', body: JSON.stringify(body) });
    if (!res.ok) {
      const msg = await res.text().catch(function () { return 'Unknown error'; });
      showError('Failed to create project: ' + msg);
      return;
    }

    // Seed secrets
    const validSecrets = data.secrets.filter(function (s) { return s.name && s.value; });
    let secretFailures = 0;
    for (const s of validSecrets) {
      try {
        const sr = await window.api(
          '/api/mappings/' + encodeURIComponent(data.teamKey) + '/secrets/' + encodeURIComponent(s.name),
          { method: 'POST', body: JSON.stringify({ value: s.value }) }
        );
        if (!sr.ok) secretFailures++;
      } catch (_) {
        secretFailures++;
      }
    }

    closeNewProjectStepper();
    if (secretFailures > 0) {
      // Project was created but some secrets failed — warn but don't block
      // Use a brief timeout so the modal closes first
      setTimeout(function () {
        alert('Project created, but ' + secretFailures + ' secret(s) failed to save. You can add them via the Secrets button on the Projects page.');
      }, 100);
    }
    if (window.loadMappings) window.loadMappings();
  }

  window.openNewProjectStepper = openNewProjectStepper;
  window.closeNewProjectStepper = closeNewProjectStepper;
  window.stepperBack = stepperBack;
  window.stepperNext = stepperNext;
  window.stepperSubmit = stepperSubmit;
  window.selectExecutionMode = selectExecutionMode;
  window.selectProvider = selectProvider;
  window.addSecretRow = addSecretRow;
  window.removeSecretRow = removeSecretRow;
})();
`;
