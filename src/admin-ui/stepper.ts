export const stepperHtml = `
<div id="np-stepper-wrap" class="modal" hidden>
  <div class="modal-backdrop" onclick="closeNewProjectStepper()"></div>
  <div class="modal-card" style="display:flex;flex-direction:column;max-height:90vh">
    <div style="padding:18px 24px 14px;border-bottom:1px solid var(--border-subtle);display:flex;justify-content:space-between;align-items:center">
      <div>
        <h2 style="font-size:15px;font-weight:600;margin:0">New project</h2>
        <div style="font-size:12px;color:var(--fg-tertiary);margin-top:2px">Bind a ticketing system to a GitHub repo and configure how AI-Implement runs against it.</div>
      </div>
      <button class="btn btn-ghost btn-icon" onclick="closeNewProjectStepper()" title="Close">&times;</button>
    </div>

    <div class="stepper" id="np-stepper-rail"></div>

    <div id="np-step-body" style="padding:24px;flex:1;overflow-y:auto;min-height:360px">
      <div data-step="0">
        <h3 style="font-size:13px;font-weight:600;margin:0 0 4px">Ticketing System</h3>
        <p style="font-size:12px;color:var(--fg-tertiary);margin:0 0 20px">Choose where this mapping&rsquo;s issues come from. Each ticketing system has different config requirements on the next step.</p>
        <div class="field" style="max-width:240px">
          <label class="field-label">Ticketing System</label>
          <select class="input" id="np-ticketing-provider" onchange="onStepperTicketingProviderChange()">
            <option value="linear">Linear</option>
            <option value="jira">Jira</option>
          </select>
          <div class="field-hint">Jira requires JIRA_TOKEN + JIRA_SITE_URL, plus either JIRA_EMAIL (Basic auth) or JIRA_CLOUD_ID (OAuth) env vars on the orchestrator.</div>
        </div>
      </div>

      <div data-step="1" hidden>
        <h3 style="font-size:13px;font-weight:600;margin:0 0 4px">Ticketing Config</h3>
        <p style="font-size:12px;color:var(--fg-tertiary);margin:0 0 20px" id="np-ticketing-desc">Provider-specific configuration.</p>

        <div id="np-linear-config" hidden>
          <div class="field">
            <label class="field-label">Linear Team Key</label>
            <input class="input mono" id="np-teamKey" placeholder="MY_TEAM" autocomplete="off" oninput="updateStepperNextButton()">
            <div class="field-hint">The uppercase identifier for your Linear team (e.g. ENG, BACKEND).</div>
          </div>
        </div>

        <div id="np-jira-config" hidden>
          <div class="field">
            <label class="field-label">JQL</label>
            <textarea class="input mono" id="np-jira-jql" rows="3" placeholder="project = TEST" oninput="updateStepperNextButton()"></textarea>
            <div style="display:flex;gap:8px;align-items:center;margin-top:6px">
              <button type="button" class="btn btn-sm" onclick="stepperValidateJql()">Validate</button>
              <span id="np-jira-jql-status" style="font-size:12px;color:var(--fg-tertiary)"></span>
            </div>
            <div class="field-hint">Scope only (e.g. &ldquo;project = TEST&rdquo;). The orchestrator adds the status filter and matches the repo field itself, so don&rsquo;t include status or repo clauses here.</div>
          </div>
          <div class="field">
            <label class="field-label">Status Field</label>
            <select class="input" id="np-jira-status-field">
              <option value="">(auto-discover by name "AI-Implement Status")</option>
            </select>
            <div class="field-hint">Leave at auto-discover if your Jira instance has a custom field named exactly &ldquo;AI-Implement Status&rdquo;. Otherwise pick the field that holds the workflow status (Ready, Planning, Implementing, etc.).</div>
          </div>
          <div class="field">
            <label class="field-label">Repo Field</label>
            <select class="input" id="np-jira-repo-field">
              <option value="">(auto-discover by name "AI-Implement Repo")</option>
            </select>
            <div class="field-hint">Leave at auto-discover if your Jira instance has a custom field named exactly &ldquo;AI-Implement Repo&rdquo;. Otherwise pick the field that identifies which GitHub repo an issue belongs to. Issues are matched on this field holding the repo you enter on the next step; if your options are labelled differently, set an explicit Repo Field Value after saving, in Edit.</div>
          </div>
          <div class="field">
            <label class="field-label">Profiles Field</label>
            <select class="input" id="np-jira-profiles-field">
              <option value="">(auto-discover by name "AI-Implement Profiles")</option>
            </select>
            <div class="field-hint">Leave at auto-discover if your Jira instance has a custom field named exactly &ldquo;AI-Implement Profiles&rdquo;. Otherwise pick the multi-select field that holds the implementation profiles for an issue.</div>
          </div>
        </div>
      </div>

      <div data-step="2" hidden>
        <h3 style="font-size:13px;font-weight:600;margin:0 0 4px">Source</h3>
        <p style="font-size:12px;color:var(--fg-tertiary);margin:0 0 20px">Connect to the GitHub repository this mapping dispatches against.</p>
        <div class="alert info" style="margin-bottom:18px">
          <div class="alert-icon">&#8505;</div>
          <div style="flex:1">
            <div class="alert-title">GitHub App required</div>
            <div class="alert-desc">The AI-Implement GitHub App must be installed on the target repo before it can sync. Enter the repository, then check the installation.</div>
            <div id="np-install-state" style="margin-top:10px;font-size:12px"></div>
            <div class="alert-actions" style="margin-top:10px">
              <button type="button" class="btn btn-sm" id="np-install-check" onclick="checkInstallState()">Check installation</button>
            </div>
          </div>
        </div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">
          <div class="field" style="grid-column:1 / -1">
            <label class="field-label">GitHub Repository</label>
            <input class="input mono" id="np-github-repo" placeholder="acme-corp/backend" autocomplete="off" oninput="updateStepperNextButton()">
            <div class="field-hint">Owner and repository name, slash-separated. This is the only place the repo is entered - it also identifies the project and matches the Jira repo field.</div>
          </div>
          <div class="field" style="grid-column:1 / -1">
            <label class="field-label">Default Branch</label>
            <input class="input mono" id="np-defaultBranch" placeholder="development" autocomplete="off" oninput="updateStepperNextButton()">
            <div class="field-hint">Branch used for workflow dispatches, runner clones, and implementation PR bases.</div>
          </div>
          <div class="field" style="grid-column:1 / -1">
            <label class="field-label">Skills Repo <span style="font-weight:400;color:var(--text-tertiary)">(optional)</span></label>
            <input class="input mono" id="np-skills-repo" placeholder="owner/skills-repo or https://github.com/owner/skills.git" autocomplete="off">
            <div class="field-hint">Cloned at dispatch and installed into the runner's ~/.claude/skills. Blank = none. Requires the target repo to re-sync claude-implement.yml.</div>
          </div>
          <div class="field" style="grid-column:1 / -1">
            <label class="field-label">Additional sensitive patterns <span style="font-weight:400;color:var(--text-tertiary)">(optional)</span></label>
            <textarea class="input mono" id="np-sensitive-add" rows="3" placeholder="one glob per line" autocomplete="off"></textarea>
            <div class="field-hint">Extra file globs to protect in addition to the built-in sensitive-files list. One glob per line. Blank = none.</div>
          </div>
          <div class="field" style="grid-column:1 / -1">
            <label class="field-label">Allowed exceptions <span style="font-weight:400;color:var(--text-tertiary)">(optional)</span></label>
            <textarea class="input mono" id="np-sensitive-allow" rows="3" placeholder="one glob per line" autocomplete="off"></textarea>
            <div class="field-hint" style="color:var(--st-warn-fg,#c80)">Files matching these globs bypass the sensitive-files guardrail for this project.</div>
          </div>
          <div class="field" style="grid-column:1 / -1">
            <label class="field-label">Dependency Token Scope <span style="font-weight:400;color:var(--text-tertiary)">(optional)</span></label>
            <select class="input" id="np-dep-token-scope">
              <option value="">Off (default)</option>
              <option value="installation">All repos the App can access (read-only)</option>
            </select>
            <div class="field-hint">Grants the implementer read access to every repository this GitHub App installation can see. The run can read those repos but never write to them. Leave off unless builds fetch private dependencies from sibling repos. When enabled, the runner mounts a scoped installation token as a git credential helper and sets <code>COMPOSER_AUTH</code>, so private dependencies resolve automatically during the install step.</div>
          </div>
        </div>
      </div>

      <div data-step="3" hidden>
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

      <div data-step="4" hidden>
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
          <label style="display:flex;align-items:center;gap:8px;font-size:12.5px;cursor:pointer">
            <input type="checkbox" id="np-autoMerge" style="width:auto">
            Auto-merge child PRs — automatically merge child PRs into their grouping branch once checks pass.
          </label>
        </div>
      </div>

      <div data-step="5" hidden>
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

      <div data-step="6" hidden>
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

      <div data-step="7" hidden>
        <h3 style="font-size:13px;font-weight:600;margin:0 0 4px">Review</h3>
        <p style="font-size:12px;color:var(--fg-tertiary);margin:0 0 20px">Confirm your settings before creating the project.</p>
        <div style="display:flex;flex-direction:column">
          <div class="np-review-row">
            <div class="np-review-label">Ticketing</div>
            <div data-review="ticketing"></div>
          </div>
          <div class="np-review-row">
            <div class="np-review-label">Ticketing Config</div>
            <div data-review="ticketingConfig"></div>
          </div>
          <div class="np-review-row">
            <div class="np-review-label">Team Key</div>
            <div data-review="teamKey" class="mono"></div>
          </div>
          <div class="np-review-row">
            <div class="np-review-label">Repository</div>
            <div data-review="repo" class="mono"></div>
          </div>
          <div class="np-review-row">
            <div class="np-review-label">Default branch</div>
            <div data-review="defaultBranch" class="mono"></div>
          </div>
          <div class="np-review-row">
            <div class="np-review-label">Skills Repo</div>
            <div data-review="skillsRepo" class="mono"></div>
          </div>
          <div class="np-review-row">
            <div class="np-review-label">Sensitive add patterns</div>
            <div data-review="sensitiveAddPatterns"></div>
          </div>
          <div class="np-review-row">
            <div class="np-review-label">Allowed exceptions</div>
            <div data-review="sensitiveAllowPatterns"></div>
          </div>
          <div class="np-review-row">
            <div class="np-review-label">Dep. Token Scope</div>
            <div data-review="dependencyTokenScope"></div>
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
  const LAST_STEP = 7;
  const STEP_LABELS = ['Ticketing', 'Config', 'Source', 'Runner', 'Provider', 'Capacity', 'Secrets', 'Review'];
  const data = {
    ticketingProvider: 'linear',
    jiraJql: '',
    jiraStatusFieldOverride: '',
    jiraRepoFieldOverride: '',
    jiraProfilesFieldOverride: '',
    teamKey: '', owner: '', repo: '', defaultBranch: '', skillsRepo: '', sensitiveAddPatterns: '', sensitiveAllowPatterns: '', dependencyTokenScope: null,
    executionMode: 'github-actions', machineCpus: 2, machineMemoryMb: 4096, sessionMode: 'autonomous',
    provider: 'anthropic', awsRegion: '',
    planningEnabled: true, autoApprovePlans: true, autoMerge: false,
    maxInProgressAiIssues: 3,
    secrets: [],
  };
  let jiraFieldsLoaded = false;

  function openNewProjectStepper() {
    // Reset state
    step = 0;
    data.ticketingProvider = 'linear';
    data.jiraJql = '';
    data.jiraStatusFieldOverride = '';
    data.jiraRepoFieldOverride = '';
    data.jiraProfilesFieldOverride = '';
    data.teamKey = '';
    data.owner = '';
    data.repo = '';
    data.defaultBranch = '';
    data.skillsRepo = '';
    data.sensitiveAddPatterns = '';
    data.sensitiveAllowPatterns = '';
    data.dependencyTokenScope = null;
    data.executionMode = 'github-actions';
    data.machineCpus = 2;
    data.machineMemoryMb = 4096;
    data.sessionMode = 'autonomous';
    data.provider = 'anthropic';
    data.awsRegion = '';
    data.planningEnabled = true;
    data.autoApprovePlans = true;
    data.autoMerge = false;
    data.maxInProgressAiIssues = 3;
    data.secrets = [];

    // Clear inputs
    const toClear = ['np-teamKey', 'np-github-repo', 'np-defaultBranch', 'np-skills-repo', 'np-sensitive-add', 'np-sensitive-allow', 'np-awsRegion'];
    const depScopeEl = document.getElementById('np-dep-token-scope');
    if (depScopeEl) depScopeEl.value = '';
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
    const amEl = document.getElementById('np-autoMerge');
    if (amEl) amEl.checked = false;

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

    // Reset Ticketing step
    const tpEl = document.getElementById('np-ticketing-provider');
    if (tpEl) tpEl.value = 'linear';
    const jqlEl = document.getElementById('np-jira-jql');
    if (jqlEl) jqlEl.value = '';
    const statusFldEl = document.getElementById('np-jira-status-field');
    if (statusFldEl) statusFldEl.value = '';
    const repoFldEl = document.getElementById('np-jira-repo-field');
    if (repoFldEl) repoFldEl.value = '';
    const profilesFldEl = document.getElementById('np-jira-profiles-field');
    if (profilesFldEl) profilesFldEl.value = '';
    const jqlStatus = document.getElementById('np-jira-jql-status');
    if (jqlStatus) { jqlStatus.textContent = ''; jqlStatus.style.color = ''; }
    const linearCfg = document.getElementById('np-linear-config');
    if (linearCfg) linearCfg.setAttribute('hidden', '');
    const jiraCfg = document.getElementById('np-jira-config');
    if (jiraCfg) jiraCfg.setAttribute('hidden', '');

    // Hide error
    const errEl = document.getElementById('np-error');
    if (errEl) { errEl.textContent = ''; errEl.classList.add('hidden'); }

    renderRail();
    showStep(0);
    applyStepperConfigStatus();
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

  function applyTicketingConfigStepVisibility() {
    const provEl = document.getElementById('np-ticketing-provider');
    const provider = provEl ? provEl.value : 'linear';
    const linearSection = document.getElementById('np-linear-config');
    const jiraSection = document.getElementById('np-jira-config');
    const descEl = document.getElementById('np-ticketing-desc');
    if (provider === 'jira') {
      if (linearSection) linearSection.setAttribute('hidden', '');
      if (jiraSection) jiraSection.removeAttribute('hidden');
      if (descEl) descEl.textContent = 'Configure the JQL scope and field mappings for this Jira mapping.';
      stepperLoadJiraFields();
    } else {
      if (linearSection) linearSection.removeAttribute('hidden');
      if (jiraSection) jiraSection.setAttribute('hidden', '');
      if (descEl) descEl.textContent = 'Configure the Linear team this mapping operates on.';
    }
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

    if (n === 1) applyTicketingConfigStepVisibility();

    const backBtn = document.getElementById('np-back');
    const nextBtn = document.getElementById('np-next');
    const createBtn = document.getElementById('np-create');

    if (backBtn) { if (n === 0) backBtn.setAttribute('hidden', ''); else backBtn.removeAttribute('hidden'); }
    if (nextBtn) { if (n === LAST_STEP) nextBtn.setAttribute('hidden', ''); else nextBtn.removeAttribute('hidden'); }
    if (createBtn) { if (n === LAST_STEP) createBtn.removeAttribute('hidden'); else createBtn.setAttribute('hidden', ''); }

    renderRail();
    updateStepperNextButton();
    if (n === LAST_STEP) populateReview();
  }

  // Parses the single "owner/repo" input into its two stored halves. Returns null
  // when the value isn't exactly one slash with both sides non-empty, so callers
  // can treat "unparseable" and "empty" the same way. A pasted GitHub URL is
  // accepted, since that is what a browser hands you when you copy a repo.
  function splitGithubRepo(raw) {
    let v = String(raw == null ? '' : raw).trim();
    v = v.replace(/^https?:\\/\\/(?:www\\.)?github\\.com\\//i, '').replace(/\\.git$/i, '');
    v = v.replace(/^\\/+/, '').replace(/\\/+$/, '');
    const parts = v.split('/');
    if (parts.length !== 2) return null;
    const owner = parts[0].trim();
    const repo = parts[1].trim();
    if (!owner || !repo) return null;
    return { owner: owner, repo: repo };
  }

  function updateStepperNextButton() {
    const nextBtn = document.getElementById('np-next');
    if (!nextBtn) return;
    let ok = true;
    if (step === 0) {
      // provider always has a default
    } else if (step === 1) {
      const provEl = document.getElementById('np-ticketing-provider');
      const provider = provEl ? provEl.value : 'linear';
      if (provider === 'jira') {
        const jql = (document.getElementById('np-jira-jql') || {}).value || '';
        if (!jql.trim()) ok = false;
      } else {
        const tk = (document.getElementById('np-teamKey') || {}).value || '';
        if (!tk.trim()) ok = false;
      }
    } else if (step === 2) {
      const gh = splitGithubRepo((document.getElementById('np-github-repo') || {}).value || '');
      const br = (document.getElementById('np-defaultBranch') || {}).value || '';
      if (!gh || !br.trim()) ok = false;
      resetInstallState();
    }
    if (ok) nextBtn.removeAttribute('disabled');
    else nextBtn.setAttribute('disabled', '');
  }

  async function checkInstallState() {
    const parsed = splitGithubRepo((document.getElementById('np-github-repo') || {}).value || '');
    const owner = parsed ? parsed.owner : '';
    const repo = parsed ? parsed.repo : '';
    const out = document.getElementById('np-install-state');
    const btn = document.getElementById('np-install-check');
    if (!out || !btn) return;
    if (!owner || !repo) {
      out.innerHTML = '<span style="color:var(--fg-tertiary)">Enter the repository as owner/repo first.</span>';
      return;
    }
    btn.disabled = true;
    btn.textContent = 'Checking…';
    out.innerHTML = '';
    try {
      const res = await window.api('/api/admin/github-install-state?owner=' + encodeURIComponent(owner) + '&repo=' + encodeURIComponent(repo));
      const data = await res.json();
      if (!res.ok) {
        out.innerHTML = '<span style="color:var(--st-fail-fg)">Could not check: ' + window.esc(data.error || 'unknown error') + '</span>';
        return;
      }
      out.innerHTML = renderInstallState(data);
    } catch (_) {
      out.innerHTML = '<span style="color:var(--st-fail-fg)">Could not check installation.</span>';
    } finally {
      btn.disabled = false;
      btn.textContent = 'Re-check';
    }
  }
  
  function renderInstallState(data) {
    const state = data.state;
    if (state === 'ready') {
      return '<span class="badge success">Ready</span> The App is installed and can access this repo.';
    }
    if (state === 'app-not-installed') {
      return '<span class="badge warn">Action needed</span> The App is not installed on this owner. '
        + '<a class="text-accent" href="' + window.safeUrl(data.installUrl) + '" target="_blank" rel="noopener noreferrer">Install the App &#8599;</a> then Re-check.';
    }
    if (state === 'repo-not-selected') {
      return '<span class="badge warn">Action needed</span> The App is installed, but this repo is not in its selected repositories. '
      + '<a class="text-accent" href="' + window.safeUrl(data.installUrl) + '" target="_blank" rel="noopener noreferrer">Add this repo &#8599;</a> then Re-check.';
    }
    return '';
  }

  // Clears a stale probe result when owner/repo change, so a "Ready" for the old repo can't linger.
  function resetInstallState() {
    const out = document.getElementById('np-install-state');
    const btn = document.getElementById('np-install-check');
    if (out) out.innerHTML = '';
    if (btn) btn.textContent = 'Check installation';
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
      const provEl = document.getElementById('np-ticketing-provider');
      if (provEl) data.ticketingProvider = provEl.value;
    } else if (n === 1) {
      if (data.ticketingProvider === 'jira') {
        const jqlEl = document.getElementById('np-jira-jql');
        if (jqlEl) data.jiraJql = jqlEl.value;
        const sf = document.getElementById('np-jira-status-field');
        const rf = document.getElementById('np-jira-repo-field');
        const pf = document.getElementById('np-jira-profiles-field');
        if (sf) data.jiraStatusFieldOverride = sf.value.trim();
        if (rf) data.jiraRepoFieldOverride = rf.value.trim();
        if (pf) data.jiraProfilesFieldOverride = pf.value.trim();
      } else {
        const tkEl = document.getElementById('np-teamKey');
        if (tkEl) data.teamKey = tkEl.value.trim();
      }
    } else if (n === 2) {
      const ghEl = document.getElementById('np-github-repo');
      const brEl = document.getElementById('np-defaultBranch');
      const srEl = document.getElementById('np-skills-repo');
      const saEl = document.getElementById('np-sensitive-add');
      const salEl = document.getElementById('np-sensitive-allow');
      if (ghEl) {
        const parts = splitGithubRepo(ghEl.value);
        data.owner = parts ? parts.owner : '';
        data.repo = parts ? parts.repo : '';
      }
      if (brEl) data.defaultBranch = brEl.value.trim();
      if (srEl) data.skillsRepo = srEl.value.trim();
      if (saEl) data.sensitiveAddPatterns = saEl.value.trim();
      if (salEl) data.sensitiveAllowPatterns = salEl.value.trim();
      const dtsEl = document.getElementById('np-dep-token-scope');
      if (dtsEl) data.dependencyTokenScope = dtsEl.value || null;
    } else if (n === 3) {
      const smEl = document.getElementById('np-sessionMode');
      const cpEl = document.getElementById('np-cpus');
      const memEl = document.getElementById('np-mem');
      if (smEl) data.sessionMode = smEl.value;
      if (cpEl) data.machineCpus = parseInt(cpEl.value, 10) || 2;
      if (memEl) data.machineMemoryMb = parseInt(memEl.value, 10) || 4096;
    } else if (n === 4) {
      const arEl = document.getElementById('np-awsRegion');
      const plEl = document.getElementById('np-planning');
      const aaEl = document.getElementById('np-autoApprove');
      const amEl = document.getElementById('np-autoMerge');
      if (arEl) data.awsRegion = arEl.value.trim();
      if (plEl) data.planningEnabled = plEl.checked;
      if (aaEl) data.autoApprovePlans = aaEl.checked;
      if (amEl) data.autoMerge = amEl.checked;
    } else if (n === 5) {
      const maxEl = document.getElementById('np-maxAi');
      if (maxEl) data.maxInProgressAiIssues = parseInt(maxEl.value, 10);
    } else if (n === 6) {
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
      // always valid
    } else if (n === 1) {
      if (data.ticketingProvider === 'jira') {
        if (!data.jiraJql.trim()) { showError('JQL is required for Jira.'); return false; }
      } else {
        if (!data.teamKey) { showError('Linear Team Key is required.'); return false; }
      }
    } else if (n === 2) {
      if (!data.owner || !data.repo) {
        showError('GitHub Repository is required, as owner/repo (e.g. acme-corp/backend).');
        return false;
      }
      if (!data.defaultBranch) { showError('Default Branch is required.'); return false; }
    } else if (n === 3) {
      // executionMode is set via card selection — always valid
    } else if (n === 4) {
      if (data.provider === 'bedrock' && data.executionMode === 'fly-machines') {
        showError('AWS Bedrock cannot be used with the Fly Machines runner. Please change the runner or provider.');
        return false;
      }
      if (data.provider === 'bedrock' && !data.awsRegion) {
        showError('AWS Region is required when using the Bedrock provider.');
        return false;
      }
    } else if (n === 5) {
      if (!Number.isFinite(data.maxInProgressAiIssues) || data.maxInProgressAiIssues < 1) {
        showError('Max parallel AI issues must be a positive integer.');
        return false;
      }
    }
    return true;
  }

  function effectiveTeamKey() {
    if (data.ticketingProvider === 'jira') {
      return (data.owner && data.repo) ? (data.owner + '/' + data.repo) : '';
    }
    return data.teamKey;
  }

  function populateReview() {
    const set = function (attr, html) {
      const el = document.querySelector('[data-review="' + attr + '"]');
      if (el) el.innerHTML = html;
    };

    set('ticketing', window.esc(data.ticketingProvider));

    let cfgText;
    if (data.ticketingProvider === 'jira') {
      const jqlPreview = data.jiraJql.length > 80 ? data.jiraJql.substring(0, 80) + '...' : data.jiraJql;
      cfgText = 'JQL: ' + (window.esc(jqlPreview) || '&mdash;') + ' &middot; repo field=' + (window.esc(effectiveTeamKey()) || '&mdash;');
      if (data.jiraStatusFieldOverride) cfgText += ' &middot; statusField=' + window.esc(data.jiraStatusFieldOverride);
      if (data.jiraRepoFieldOverride) cfgText += ' &middot; repoField=' + window.esc(data.jiraRepoFieldOverride);
      if (data.jiraProfilesFieldOverride) cfgText += ' &middot; profilesField=' + window.esc(data.jiraProfilesFieldOverride);
    } else {
      cfgText = 'team=' + (window.esc(data.teamKey) || '&mdash;');
    }
    set('ticketingConfig', cfgText);

    set('teamKey', window.esc(effectiveTeamKey()) || '&mdash;');
    set('repo', window.esc(data.owner) + '/' + window.esc(data.repo));
    set('defaultBranch', window.esc(data.defaultBranch) || '&mdash;');
    set('skillsRepo', data.skillsRepo ? window.esc(data.skillsRepo) : '&mdash;');
    set('sensitiveAddPatterns', data.sensitiveAddPatterns ? (data.sensitiveAddPatterns.split('\\n').filter(function(l){return l.trim();}).length + ' pattern(s)') : '&mdash;');
    set('sensitiveAllowPatterns', data.sensitiveAllowPatterns ? (data.sensitiveAllowPatterns.split('\\n').filter(function(l){return l.trim();}).length + ' exception(s)') : '&mdash;');
    set('dependencyTokenScope', data.dependencyTokenScope ? window.esc(data.dependencyTokenScope) : '&mdash;');

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

  function onStepperTicketingProviderChange() {
    const provEl = document.getElementById('np-ticketing-provider');
    const provider = provEl ? provEl.value : 'linear';
    data.ticketingProvider = provider;
    // If we're already on the Ticketing Config step, re-apply visibility immediately.
    if (step === 1) applyTicketingConfigStepVisibility();
    updateStepperNextButton();
  }

  async function stepperLoadJiraFields() {
    const statusSel = document.getElementById('np-jira-status-field');
    const repoSel = document.getElementById('np-jira-repo-field');
    const profilesSel = document.getElementById('np-jira-profiles-field');
    if (jiraFieldsLoaded) return;
    if (!statusSel && !repoSel && !profilesSel) return;
    try {
      const res = await window.api('/api/jira/fields');
      if (!res.ok) return;
      const fields = await res.json();
      fields.sort(function (a, b) {
        return a.name.toLowerCase().localeCompare(b.name.toLowerCase());
      });
      const prevStatus = statusSel ? (statusSel.value || statusSel.dataset.pendingValue || '') : '';
      const prevRepo = repoSel ? (repoSel.value || repoSel.dataset.pendingValue || '') : '';
      const prevProfiles = profilesSel ? (profilesSel.value || profilesSel.dataset.pendingValue || '') : '';
      const statusPlaceholder = statusSel && statusSel.options[0] ? statusSel.options[0] : null;
      const repoPlaceholder = repoSel && repoSel.options[0] ? repoSel.options[0] : null;
      const profilesPlaceholder = profilesSel && profilesSel.options[0] ? profilesSel.options[0] : null;
      if (statusSel) statusSel.innerHTML = '';
      if (repoSel) repoSel.innerHTML = '';
      if (profilesSel) profilesSel.innerHTML = '';
      if (statusSel && statusPlaceholder) statusSel.appendChild(statusPlaceholder);
      if (repoSel && repoPlaceholder) repoSel.appendChild(repoPlaceholder);
      if (profilesSel && profilesPlaceholder) profilesSel.appendChild(profilesPlaceholder);
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
        if (profilesSel) {
          const o3 = document.createElement('option');
          o3.value = f.id;
          o3.textContent = labelText;
          profilesSel.appendChild(o3);
        }
      }
      if (statusSel && prevStatus) statusSel.value = prevStatus;
      if (repoSel && prevRepo) repoSel.value = prevRepo;
      if (profilesSel && prevProfiles) profilesSel.value = prevProfiles;
      jiraFieldsLoaded = true;
    } catch (err) {
      console.error('stepperLoadJiraFields failed:', err);
    }
  }

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

  async function stepperValidateJql() {
    const jqlEl = document.getElementById('np-jira-jql');
    const statusFieldEl = document.getElementById('np-jira-status-field');
    const status = document.getElementById('np-jira-jql-status');
    if (!jqlEl || !status) return;
    const jql = jqlEl.value;
    const statusFieldOverride = statusFieldEl ? statusFieldEl.value : '';
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
        status.style.color = 'var(--st-fail-fg, #c33)';
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
      status.style.color = 'var(--st-fail-fg, #c33)';
    }
  }

  async function applyStepperConfigStatus() {
    try {
      const res = await window.api('/api/admin/config-status');
      if (!res.ok) return;
      const cfg = await res.json();
      const select = document.getElementById('np-ticketing-provider');
      if (!select) return;
      for (const opt of Array.from(select.options)) {
        if (opt.value === 'linear' && !cfg.linear) {
          opt.disabled = true;
          opt.textContent = 'Linear (not configured)';
        }
        if (opt.value === 'jira' && !cfg.jira) {
          opt.disabled = true;
          opt.textContent = 'Jira (not configured)';
        }
      }
      if (!cfg.linear && cfg.jira) {
        select.value = 'jira';
        onStepperTicketingProviderChange();
      }
    } catch (err) {
      console.error('applyStepperConfigStatus failed:', err);
    }
  }

  async function stepperSubmit() {
    // Collect any final values from secrets step
    collectStep(6);

    // Validate all non-secret/non-review steps (0..5)
    for (let i = 0; i < 6; i++) {
      collectStep(i);
      if (!validateStep(i)) return;
    }

    const teamKey = effectiveTeamKey();

    const body = {
      teamKey: teamKey,
      owner: data.owner,
      repo: data.repo,
      workflowFile: 'claude-implement.yml',
      defaultBranch: data.defaultBranch,
      maxInProgressAiIssues: data.maxInProgressAiIssues,
      executionMode: data.executionMode,
      sessionMode: data.sessionMode,
      machineCpus: data.machineCpus,
      machineMemoryMb: data.machineMemoryMb,
      planningEnabled: data.planningEnabled,
      autoApprovePlans: data.autoApprovePlans,
      autoMerge: data.autoMerge ?? false,
      planningWorkflowFile: 'claude-plan.yml',
      extraEnv: {},
      provider: data.provider,
      awsRegion: data.provider === 'bedrock' ? (data.awsRegion || null) : null,
      skillsRepo: data.skillsRepo || null,
      sensitiveAddPatterns: data.sensitiveAddPatterns || null,
      sensitiveAllowPatterns: data.sensitiveAllowPatterns || null,
      dependencyTokenScope: data.dependencyTokenScope || null,
      ticketingProvider: data.ticketingProvider,
      ticketingConfig: data.ticketingProvider === 'jira'
        ? {
            kind: 'jira',
            jql: data.jiraJql,
            // Derived from owner/repo by the orchestrator. Only the Edit dialog
            // can set an explicit override, for instances whose repo-field
            // options are labelled with something other than owner/repo.
            repoFieldValue: null,
            statusFieldOverride: data.jiraStatusFieldOverride || null,
            repoFieldOverride: data.jiraRepoFieldOverride || null,
            profilesFieldOverride: data.jiraProfilesFieldOverride || null,
          }
        : { kind: 'linear' },
    };

    const createBtn = document.getElementById('np-create');
    const origCreateLabel = createBtn ? createBtn.textContent : '';
    if (createBtn) { createBtn.disabled = true; createBtn.textContent = 'Creating...'; }
    
    const res = await window.api('/api/mappings', { method: 'POST', body: JSON.stringify(body) });
    let resData = {};
    try { resData = await res.json(); } catch (_) {}
    if (createBtn) { createBtn.disabled = false; createBtn.textContent = origCreateLabel; }
    if (!res.ok) {
      showError('Failed to create project: ' + (resData.error || 'Unknown error'));
      return;
    }

    // Seed secrets
    const validSecrets = data.secrets.filter(function (s) { return s.name && s.value; });
    let secretFailures = 0;
    for (const s of validSecrets) {
      try {
        const sr = await window.api(
          '/api/mappings/' + encodeURIComponent(teamKey) + '/secrets',
          { method: 'POST', body: JSON.stringify({ name: s.name, value: s.value }) }
        );
        if (!sr.ok) secretFailures++;
      } catch (_) {
        secretFailures++;
      }
    }

    closeNewProjectStepper();
    if (window.loadMappings) await window.loadMappings();
    if (window.pollSyncStatus) window.pollSyncStatus(teamKey, resData.syncJobId);

    // Project was created but some secrets failed — warn but don't block.
    const notices = [];
    if (secretFailures > 0) {
      notices.push(secretFailures + ' secret(s) failed to save. Add them via the Secrets button on the Projects page.');
    }
    if (notices.length) {
      // Use a brief timeout so the modal closes first
      setTimeout(function () { alert('Project created.\\n\\n' + notices.join('\\n\\n')); }, 100);
    }
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
  window.onStepperTicketingProviderChange = onStepperTicketingProviderChange;
  window.stepperValidateJql = stepperValidateJql;
  window.updateStepperNextButton = updateStepperNextButton;
  window.checkInstallState = checkInstallState;
})();
`;
