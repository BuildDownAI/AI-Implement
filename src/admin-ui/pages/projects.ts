import { stepperHtml } from "../stepper.js";

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
        <table class="tbl">
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
        <div class="warning">&#9888; Secrets are stored on the shared sessions app and injected into every machine on that app by Fly. The runner entrypoint filters them: each machine sees only its own team&#x27;s secrets under their unprefixed names, and other teams&#x27; secrets are unset before the agent starts. Secrets reach setup, verify, and dependency install only; the agent never sees them. Values are write-only and cannot be read back through the API.</div>
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
    <div style="padding:12px 20px 0">
      <span class="seg" id="md-tabs">
        <button type="button" class="btn btn-sm active" data-md-tab="ticketing" onclick="switchMappingTab('ticketing')">Ticketing</button>
        <button type="button" class="btn btn-sm" data-md-tab="source" onclick="switchMappingTab('source')">Source</button>
        <button type="button" class="btn btn-sm" data-md-tab="context" onclick="switchMappingTab('context')">Context</button>
        <button type="button" class="btn btn-sm" data-md-tab="execution" onclick="switchMappingTab('execution')">Execution</button>
        <button type="button" class="btn btn-sm" data-md-tab="capacity" onclick="switchMappingTab('capacity')">Capacity</button>
        <button type="button" class="btn btn-sm" data-md-tab="guardrails" onclick="switchMappingTab('guardrails')">Guardrails</button>
        <button type="button" class="btn btn-sm" data-md-tab="provider" onclick="switchMappingTab('provider')">Provider</button>
      </span>
    </div>
    <div class="md-body">
      <div data-md-panel="ticketing">
        <h3 style="font-size:13px;font-weight:600;margin:0 0 4px">Ticketing</h3>
        <p style="font-size:12px;color:var(--fg-tertiary);margin:0 0 18px">Where this project&rsquo;s issues come from, and how the orchestrator recognises them.</p>
        <div style="display:grid;gap:12px">
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">
            <div class="field">
              <label class="field-label">Provider</label>
              <select class="select" id="md-ticketing-provider" onchange="onTicketingProviderChange()">
                <option value="linear">Linear</option>
                <option value="jira">Jira</option>
              </select>
            </div>
            <div class="field">
              <label class="field-label">Team Key</label>
              <input class="input mono" id="md-team-key" placeholder="MY_TEAM">
              <div class="field-hint">The tracker team this mapping serves, e.g. ENG. Cannot be changed after creation.</div>
            </div>
          </div>
          <div id="md-jira-fields" class="hidden" style="display:grid;gap:12px">
            <div class="field">
              <label class="field-label">Mapping ID</label>
              <input class="input mono" id="md-jira-mapping-id" placeholder="acme/billing">
            </div>
            <div class="field">
              <label class="field-label">JQL</label>
              <textarea class="textarea" id="md-jira-jql" rows="3" placeholder="project = TEST"></textarea>
              <div style="display:flex;gap:8px;align-items:center;margin-top:2px">
                <button type="button" class="btn btn-sm" onclick="validateJqlButton()">Validate</button>
                <span id="md-jira-jql-status" class="field-hint"></span>
              </div>
              <div class="field-hint">The orchestrator wraps this with its own status filter at query time. Don't include status filters here.</div>
            </div>
            <div class="field">
              <label class="field-label">Status Field</label>
              <select class="select" id="md-jira-status-field">
                <option value="">(auto-discover by name "AI-Implement Status")</option>
              </select>
              <div class="field-hint">Leave at auto-discover if your Jira instance has a custom field named exactly &ldquo;AI-Implement Status&rdquo;. Otherwise pick the field that holds the workflow status (Ready, Planning, Implementing, etc.).</div>
            </div>
            <div class="field">
              <label class="field-label">Repo Field</label>
              <select class="select" id="md-jira-repo-field" onchange="onRepoFieldChange()">
                <option value="">(auto-discover by name "AI-Implement Repo")</option>
              </select>
              <div class="field-hint">Leave at auto-discover if your Jira instance has a custom field named exactly &ldquo;AI-Implement Repo&rdquo;. Otherwise pick the field that identifies which GitHub repo an issue belongs to.</div>
            </div>
            <div class="field">
              <label class="field-label">Profiles Field</label>
              <select class="select" id="md-jira-profiles-field">
                <option value="">(auto-discover by name "AI-Implement Profiles")</option>
              </select>
              <div class="field-hint">Leave at auto-discover if your Jira instance has a custom field named exactly &ldquo;AI-Implement Profiles&rdquo;. Otherwise pick the multi-select field that holds the implementation profiles for an issue.</div>
            </div>
            <div class="field">
              <label class="field-label">Repo Field Value</label>
              <select class="select" id="md-jira-repo-value">
                <option value="">Select a Repo Field first</option>
              </select>
              <input class="input mono hidden" id="md-jira-repo-value-text" type="text" placeholder="owner/repo">
            </div>
          </div>
        </div>
      </div>
      <div data-md-panel="source" hidden>
        <h3 style="font-size:13px;font-weight:600;margin:0 0 4px">Source</h3>
        <p style="font-size:12px;color:var(--fg-tertiary);margin:0 0 18px">The GitHub repository this mapping dispatches against, and how its branches are named.</p>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">
          <div class="field">
            <label class="field-label">Owner</label>
            <input class="input mono" id="md-owner" placeholder="acme-corp">
            <div class="field-hint">Org or user that owns the repo.</div>
          </div>
          <div class="field">
            <label class="field-label">Repo</label>
            <input class="input mono" id="md-repo" placeholder="backend">
            <div class="field-hint">Repository name only, no owner prefix.</div>
          </div>
          <div class="field">
            <label class="field-label">Default Branch</label>
            <input class="input mono" id="md-branch" placeholder="development">
            <div class="field-hint">Base for runner clones and implementation PRs.</div>
          </div>
          <div class="field">
            <label class="field-label">Workflow File</label>
            <input class="input mono" id="md-wf" value="claude-implement.yml">
            <div class="field-hint">Synced into the target repo under .github/workflows/.</div>
          </div>
          <div class="field" style="grid-column:1 / -1">
            <label class="field-label">Branch Prefix</label>
            <input class="input mono" id="md-branch-prefix" placeholder="pr">
            <div class="field-hint">Blank = none.</div>
            <details class="explain">
              <summary>What a prefix changes</summary>
              <div class="explain-body">A run names its branch <span class="mono">ai-implement/&lt;issue-key&gt;-&lt;title-slug&gt;</span>. The prefix is joined in front of that as a leading path segment, so <span class="mono">pr</span> turns <span class="mono">ai-implement/aii-42-add-search</span> into <span class="mono">pr/ai-implement/aii-42-add-search</span>. It may contain <span class="mono">/</span> itself to nest several segments deep.</div>
              <div class="explain-body">Only the first run of an issue is affected. A gap-fill run commits to the pull-request branch that already exists, so setting this later does not rename anything already created.</div>
            </details>
          </div>
        </div>
      </div>
      <div data-md-panel="context" hidden>
        <h3 style="font-size:13px;font-weight:600;margin:0 0 4px">Context</h3>
        <p style="font-size:12px;color:var(--fg-tertiary);margin:0 0 18px">What a run can reach beyond the target repository.</p>
        <div style="display:grid;gap:12px">
          <div class="field">
            <label class="field-label">Skills Repo</label>
            <input class="input mono" id="md-skills-repo" placeholder="owner/skills-repo or https://github.com/owner/skills.git">
            <div class="field-hint">Cloned at dispatch and installed into the runner's ~/.claude/skills. Blank = none. Requires the target repo to re-sync claude-implement.yml.</div>
          </div>
          <div class="field">
            <label class="field-label">Dependency Token Scope</label>
            <select class="select" id="md-dep-token-scope">
              <option value="">Off (default)</option>
              <option value="installation">All repos the App can access (read-only)</option>
            </select>
            <div class="field-hint">Lets the run read private sibling repos while installing dependencies. It can never write to them. Leave off unless builds need it.</div>
            <details class="explain">
              <summary>How the token is scoped</summary>
              <div class="explain-body">The run receives a second token, installation-wide but strictly read-only, fetched over the runner callback and installed as a git credential helper for github.com and as <span class="mono">COMPOSER_AUTH</span>. So private dependencies resolve during the install step, and the run still cannot push anywhere but its own target repository.</div>
              <div class="explain-body">The scope is all-or-nothing: it reads every repository the App installation covers, not a chosen subset. It also needs a publicly reachable orchestrator &mdash; a run dispatched without a progress token skips the fetch and proceeds without private-dependency access rather than failing.</div>
            </details>
          </div>
        </div>
      </div>
      <div data-md-panel="execution" hidden>
        <h3 style="font-size:13px;font-weight:600;margin:0 0 4px">Execution</h3>
        <p style="font-size:12px;color:var(--fg-tertiary);margin:0 0 18px">Where runs execute, and what the runner process receives.</p>
        <div style="display:grid;gap:12px">
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">
            <div class="field">
              <label class="field-label">Mode</label>
              <select class="select" id="md-exec-mode" onchange="onExecModeChange()">
                <option value="github-actions">github-actions</option>
                <option value="fly-machines">fly-machines</option>
              </select>
            </div>
            <div class="field">
              <label class="field-label">Session Mode</label>
              <select class="select" id="md-session-mode">
                <option value="autonomous">autonomous</option>
                <option value="interactive">interactive</option>
                <option value="hybrid">hybrid</option>
              </select>
            </div>
          </div>
          <div id="md-fly-fields" class="hidden" style="display:grid;grid-template-columns:1fr 1fr;gap:12px">
            <div class="field">
              <label class="field-label">CPUs</label>
              <input class="input" id="md-cpus" type="number" min="1" value="2">
            </div>
            <div class="field">
              <label class="field-label">Memory (MB)</label>
              <input class="input" id="md-mem" type="number" min="256" step="256" value="4096">
            </div>
          </div>
          <div class="field">
            <label class="field-label">Extra Env</label>
            <textarea class="textarea" id="md-env" rows="4" placeholder="LOG_LEVEL=debug&#10;FEATURE_FLAG=on"></textarea>
            <div class="field-hint">One KEY=VALUE per line. Unlike secrets, these reach the model process and are visible to the agent.</div>
          </div>
        </div>
      </div>
      <div data-md-panel="capacity" hidden>
        <h3 style="font-size:13px;font-weight:600;margin:0 0 4px">Capacity</h3>
        <p style="font-size:12px;color:var(--fg-tertiary);margin:0 0 18px">How much work this project may have running, and how long each run may take. Every cap applies to re-dispatches as well as initial runs.</p>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">
          <div class="field">
            <label class="field-label">Max AI Issues</label>
            <input class="input" id="md-max-ai" type="number" min="1" value="3">
            <div class="field-hint">Issues in flight at once for this project. Required.</div>
          </div>
          <div class="field">
            <label class="field-label">Max Turns</label>
            <input class="input" id="md-max-turns" type="number" min="1" step="1" placeholder="50">
            <div class="field-hint">Claude turns per implement pass. Blank = 50.</div>
          </div>
          <div class="field">
            <label class="field-label">Max Iterations</label>
            <input class="input" id="md-max-iter" type="number" min="1" step="1" placeholder="3">
            <div class="field-hint">Implement/review cycles. Blank = 2 on bedrock, 3 on anthropic.</div>
          </div>
          <div class="field">
            <label class="field-label">Job Timeout (min)</label>
            <input class="input" id="md-max-job-min" type="number" min="1" step="1" placeholder="90">
            <div class="field-hint">GitHub Actions only. Blank = 90.</div>
          </div>
        </div>
      </div>
      <div data-md-panel="guardrails" hidden>
        <h3 style="font-size:13px;font-weight:600;margin:0 0 4px">Guardrails</h3>
        <p style="font-size:12px;color:var(--fg-tertiary);margin:0 0 18px">Files a run is refused permission to push. AI-Implement already blocks a built-in list; these two settings extend it and carve holes in it.</p>
        <div style="display:grid;gap:12px">
          <div class="field">
            <label class="field-label">Additional protected files</label>
            <textarea class="textarea" id="md-sensitive-add" rows="3" placeholder="infra/**&#10;*.pem&#10;deploy/production.yml"></textarea>
            <div class="field-hint">One file pattern per line, on top of the built-in list. <span class="mono">*</span> matches within one path segment, <span class="mono">**</span> matches across segments. Blank = none.</div>
          </div>
          <div class="field">
            <label class="field-label">Exceptions to those rules</label>
            <textarea class="textarea" id="md-sensitive-allow" rows="3" placeholder="infra/README.md&#10;deploy/example.yml"></textarea>
            <div class="field-hint">One file pattern per line. Same syntax as above.</div>
          </div>
          <div class="alert warn">
            <div class="alert-icon">&#9888;</div>
            <div>
              <div class="alert-title">Exceptions win over every other rule</div>
              <div class="alert-desc">A file matching an exception is pushed even when it also matches the built-in list or a pattern added above.</div>
            </div>
          </div>
        </div>
      </div>
      <div data-md-panel="provider" hidden>
        <h3 style="font-size:13px;font-weight:600;margin:0 0 4px">Provider</h3>
        <p style="font-size:12px;color:var(--fg-tertiary);margin:0 0 18px">Which Claude backend runs this project, and whether it plans before implementing.</p>
        <div style="display:grid;gap:18px">
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">
            <div class="field">
              <label class="field-label">Provider</label>
              <select class="select" id="md-provider" onchange="onProviderChange()">
                <option value="anthropic">anthropic</option>
                <option value="bedrock">bedrock</option>
              </select>
              <div class="field-hint">Bedrock requires the GitHub Actions execution mode.</div>
            </div>
            <div id="md-aws-region-wrap" class="field hidden">
              <label class="field-label">AWS Region</label>
              <input class="input mono" id="md-aws-region" placeholder="us-west-2">
              <div class="field-hint">Where your Bedrock inference profile is deployed.</div>
            </div>
          </div>
          <div>
            <div style="font-size:12px;font-weight:500;color:var(--fg-secondary);margin-bottom:10px">Planning</div>
            <label class="checkbox-row"><input id="md-planning" type="checkbox" onchange="onPlanningChange()"> Enabled &mdash; Claude posts a plan to the ticket before implementing</label>
            <label class="checkbox-row"><input id="md-auto-approve" type="checkbox" checked> Auto-approve plans</label>
            <label class="checkbox-row"><input id="md-auto-merge" type="checkbox"> Auto-merge child PRs into their grouping branch</label>
            <div id="md-planning-wf-wrap" class="field hidden" style="max-width:260px;margin-top:10px">
              <label class="field-label">Planning Workflow File</label>
              <input class="input mono" id="md-planning-wf" value="claude-plan.yml">
            </div>
          </div>
        </div>
      </div>
    </div>
    <div id="md-error" class="error hidden" style="margin:0 20px"></div>
    <div class="md-footer">
      <button class="btn btn-ghost" onclick="closeMappingDialog()">Cancel</button>
      <button id="md-save" class="btn btn-accent" onclick="saveMappingDialog()">Save Mapping</button>
    </div>
  </dialog>

  ${stepperHtml}
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
      const recent = recentSync[key];
      // syncCell built via DOM below (avoids data-* + inline onclick pattern)
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
        + '<td style="white-space:nowrap"></td>';
      const actionCell = tr.lastElementChild;
      const pauseBtn = document.createElement('button');
      pauseBtn.className = 'btn btn-sm';
      pauseBtn.textContent = pauseLabel;
      pauseBtn.addEventListener('click', function() { togglePause(key, m.paused); });
      actionCell.appendChild(pauseBtn);
      actionCell.appendChild(document.createTextNode(' '));
      const editBtn = document.createElement('button');
      editBtn.className = 'btn btn-sm';
      editBtn.textContent = 'Edit';
      editBtn.addEventListener('click', function() { openMappingDialog(key); });
      actionCell.appendChild(editBtn);
      actionCell.appendChild(document.createTextNode(' '));
      const delMappingBtn = document.createElement('button');
      delMappingBtn.className = 'btn btn-sm btn-danger';
      delMappingBtn.textContent = 'Del';
      delMappingBtn.addEventListener('click', function() { delMapping(key); });
      actionCell.appendChild(delMappingBtn);
      actionCell.appendChild(document.createTextNode(' '));
      if (recent && recent.prUrl) {
        const syncLink = document.createElement('a');
        syncLink.className = 'btn btn-sm btn-ghost';
        syncLink.href = window.safeUrl(recent.prUrl);
        syncLink.target = '_blank';
        syncLink.rel = 'noopener noreferrer';
        syncLink.title = 'Workflow sync PR (just created)';
        syncLink.textContent = 'Workflows synced \u2014 PR opened \u2197';
        actionCell.appendChild(syncLink);
        actionCell.appendChild(document.createTextNode(' '));
      } else {
        const syncBtn = document.createElement('button');
        syncBtn.className = 'btn btn-sm btn-ghost';
        syncBtn.dataset.syncBtn = '';
        syncBtn.dataset.key = key;
        syncBtn.textContent = 'Sync workflows';
        syncBtn.addEventListener('click', function() { syncWorkflows(syncBtn); });
        actionCell.appendChild(syncBtn);
        actionCell.appendChild(document.createTextNode(' '));
      }
      const secretsBtn = document.createElement('button');
      secretsBtn.className = 'btn btn-sm btn-ghost';
      secretsBtn.textContent = 'Secrets';
      secretsBtn.addEventListener('click', function() { showSecrets(key); });
      actionCell.appendChild(secretsBtn);
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
    document.getElementById('md-branch').value = m.defaultBranch || '';
    document.getElementById('md-max-ai').value = String(m.maxInProgressAiIssues ?? 3);
    document.getElementById('md-exec-mode').value = m.executionMode || 'github-actions';
    document.getElementById('md-session-mode').value = m.sessionMode || 'autonomous';
    document.getElementById('md-cpus').value = String(m.machineCpus ?? 2);
    document.getElementById('md-mem').value = String(m.machineMemoryMb ?? 4096);
    document.getElementById('md-env').value = envToText(m.extraEnv);
    document.getElementById('md-planning').checked = !!m.planningEnabled;
    document.getElementById('md-auto-approve').checked = m.autoApprovePlans !== false;
    document.getElementById('md-auto-merge').checked = m.autoMerge === true;
    document.getElementById('md-planning-wf').value = m.planningWorkflowFile || 'claude-plan.yml';
    document.getElementById('md-provider').value = m.provider || 'anthropic';
    document.getElementById('md-aws-region').value = m.awsRegion || '';
    document.getElementById('md-max-turns').value = m.maxTurns == null ? '' : String(m.maxTurns);
    document.getElementById('md-max-iter').value = m.maxIterations == null ? '' : String(m.maxIterations);
    document.getElementById('md-max-job-min').value = m.maxJobMinutes == null ? '' : String(m.maxJobMinutes);
    document.getElementById('md-branch-prefix').value = m.branchPrefix || '';
    document.getElementById('md-skills-repo').value = m.skillsRepo || '';
    document.getElementById('md-sensitive-add').value = (m.sensitiveAddPatterns || []).join('\\n');
    document.getElementById('md-sensitive-allow').value = (m.sensitiveAllowPatterns || []).join('\\n');
    document.getElementById('md-dep-token-scope').value = m.dependencyTokenScope || '';

    // Ticketing provider + Jira config
    const tp = m.ticketingProvider || 'linear';
    document.getElementById('md-ticketing-provider').value = tp;
    const tc = (m.ticketingConfig && typeof m.ticketingConfig === 'object') ? m.ticketingConfig : {};
    document.getElementById('md-jira-mapping-id').value = (tp === 'jira' && tc.kind === 'jira') ? (key || '') : '';
    document.getElementById('md-jira-jql').value = (tp === 'jira' && tc.kind === 'jira' && tc.jql) ? tc.jql : '';
    const pendingStatus = (tp === 'jira' && tc.statusFieldOverride) ? tc.statusFieldOverride : '';
    const pendingRepoFld = (tp === 'jira' && tc.repoFieldOverride) ? tc.repoFieldOverride : '';
    const pendingProfilesFld = (tp === 'jira' && tc.profilesFieldOverride) ? tc.profilesFieldOverride : '';
    const statusFldEl = document.getElementById('md-jira-status-field');
    const repoFldEl = document.getElementById('md-jira-repo-field');
    const profilesFldEl = document.getElementById('md-jira-profiles-field');
    statusFldEl.dataset.pendingValue = pendingStatus;
    repoFldEl.dataset.pendingValue = pendingRepoFld;
    profilesFldEl.dataset.pendingValue = pendingProfilesFld;
    statusFldEl.value = pendingStatus;
    repoFldEl.value = pendingRepoFld;
    profilesFldEl.value = pendingProfilesFld;
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
    switchMappingTab('ticketing');

    document.getElementById('mapping-dialog').showModal();
  }
  window.openMappingDialog = openMappingDialog;

  function switchMappingTab(name) {
    for (const panel of document.querySelectorAll('[data-md-panel]')) {
      panel.hidden = panel.dataset.mdPanel !== name;
    }
    for (const btn of document.querySelectorAll('#md-tabs [data-md-tab]')) {
      btn.classList.toggle('active', btn.dataset.mdTab === name);
    }
    // a tall panel leaves the body scrolled; the next one would open part-way down
    const body = document.querySelector('#mapping-dialog .md-body');
    if (body) body.scrollTop = 0;
  }
  window.switchMappingTab = switchMappingTab;

  // Blank means "use the built-in default", which the payload carries as null. Number()
  // rather than parseInt so "1.5" fails validation instead of truncating to 1.
  function optionalCap(id) {
    const v = document.getElementById(id).value.trim();
    return v === '' ? null : Number(v);
  }

  const CAP_FIELDS = [
    ['Max Turns', 'maxTurns'],
    ['Max Iterations', 'maxIterations'],
    ['Job Timeout', 'maxJobMinutes'],
  ];

  function badCap(value) {
    return value !== null && (!Number.isInteger(value) || value < 1);
  }

  // Several save rules span two tabs, so the offending field may be on a hidden panel.
  function showMappingError(message, tab) {
    if (tab) switchMappingTab(tab);
    const errEl = document.getElementById('md-error');
    errEl.textContent = message;
    errEl.classList.remove('hidden');
  }

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
    const profilesSel = document.getElementById('md-jira-profiles-field');
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
      // Restore previously set values (e.g. from openMappingDialog before fields loaded)
      if (statusSel && prevStatus) statusSel.value = prevStatus;
      if (repoSel && prevRepo) repoSel.value = prevRepo;
      if (profilesSel && prevProfiles) profilesSel.value = prevProfiles;
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
    const defaultBranch = document.getElementById('md-branch').value.trim();
    if (!defaultBranch) {
      showMappingError('Default Branch is required.', 'source');
      return;
    }

    const body = {
      teamKey,
      owner: document.getElementById('md-owner').value.trim(),
      repo: document.getElementById('md-repo').value.trim(),
      workflowFile: document.getElementById('md-wf').value.trim(),
      defaultBranch,
      maxInProgressAiIssues: Number(document.getElementById('md-max-ai').value.trim() || NaN),
      executionMode: document.getElementById('md-exec-mode').value,
      sessionMode: document.getElementById('md-session-mode').value,
      machineCpus: parseInt(document.getElementById('md-cpus').value, 10),
      machineMemoryMb: parseInt(document.getElementById('md-mem').value, 10),
      planningEnabled: document.getElementById('md-planning').checked,
      autoApprovePlans: document.getElementById('md-auto-approve').checked,
      autoMerge: document.getElementById('md-auto-merge').checked,
      planningWorkflowFile: document.getElementById('md-planning-wf').value.trim(),
      extraEnv: parseEnvText(document.getElementById('md-env').value),
      provider: document.getElementById('md-provider').value,
      awsRegion: document.getElementById('md-aws-region').value.trim() || null,
      maxTurns: optionalCap('md-max-turns'),
      maxIterations: optionalCap('md-max-iter'),
      maxJobMinutes: optionalCap('md-max-job-min'),
      branchPrefix: (function(){ var v = document.getElementById('md-branch-prefix').value.trim(); return v === '' ? null : v; })(),
      skillsRepo: (function(){ var v = document.getElementById('md-skills-repo').value.trim(); return v === '' ? null : v; })(),
      sensitiveAddPatterns: (function(){ var v = document.getElementById('md-sensitive-add').value.trim(); return v === '' ? null : v; })(),
      sensitiveAllowPatterns: (function(){ var v = document.getElementById('md-sensitive-allow').value.trim(); return v === '' ? null : v; })(),
      dependencyTokenScope: (function(){ var v = document.getElementById('md-dep-token-scope').value; return v === '' ? null : v; })(),
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
      const profilesFieldOverride = document.getElementById('md-jira-profiles-field').value.trim() || null;
      body.ticketingConfig = {
        kind: 'jira',
        jql: jql,
        repoFieldValue: repoFieldValue,
        statusFieldOverride: statusFieldOverride,
        repoFieldOverride: repoFieldOverride,
        profilesFieldOverride: profilesFieldOverride,
      };
    }

    if (!body.teamKey) {
      showMappingError('Team Key is required.', 'ticketing');
      return;
    }
    if (!body.owner || !body.repo) {
      showMappingError('Owner and Repo are required.', 'source');
      return;
    }
    if (!Number.isInteger(body.maxInProgressAiIssues) || body.maxInProgressAiIssues < 1) {
      showMappingError('Max AI Issues must be a positive integer.', 'capacity');
      return;
    }
    for (const cap of CAP_FIELDS) {
      if (badCap(body[cap[1]])) {
        showMappingError(cap[0] + ' must be a positive integer, or blank for the default.', 'capacity');
        return;
      }
    }
    if (body.provider === 'bedrock' && body.executionMode === 'fly-machines') {
      showMappingError('Bedrock is not supported with the fly-machines execution mode. Change one of them.', 'provider');
      return;
    }
    if (body.provider === 'bedrock' && !body.awsRegion) {
      showMappingError('AWS Region is required when provider is bedrock.', 'provider');
      return;
    }
    if (body.planningEnabled && !body.planningWorkflowFile) {
      showMappingError('Planning Workflow File is required when planning is enabled.', 'provider');
      return;
    }

    const saveBtn = document.getElementById('md-save');
    const origSaveLabel = saveBtn ? saveBtn.textContent : '';
    if (saveBtn) { saveBtn.disabled = true; saveBtn.textContent = 'Saving...'; }

    const res = await window.api('/api/mappings', { method: 'POST', body: JSON.stringify(body) });
    let data = {};
    try { data = await res.json(); } catch (_) {}
    if (saveBtn) { saveBtn.disabled = false; saveBtn.textContent = origSaveLabel; }
    if (!res.ok) {
      errEl.textContent = 'Server error: ' + (data.error || 'Unknown error');
      errEl.classList.remove('hidden');
      return;
    }
    closeMappingDialog();
    await loadMappings();
    pollSyncStatus(teamKey, data.syncJobId);
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

  let recentSync = {};
  let syncPollTimers = {};
  const SYNC_POLL_MS = 2000;
  const SYNC_POLL_MAX_ATTEMPTS = 60; // ~2 min, then hand off to the background safety net

  // Poll GET /api/mappings/:teamKey/sync-status/:jobId until the job is terminal
  function pollSyncStatus(teamKey, jobId) {
    if (!jobId) return;
    stopSyncPoll(teamKey); // never run two pollers for one row

    const initialBtn = findSyncBtn(teamKey);
    if (initialBtn) { initialBtn.disabled = true; initialBtn.textContent = 'Syncing...'; }

    let inFlight = false;
    let attempts = 0;
    syncPollTimers[teamKey] = setInterval(async function () {
      if (inFlight) return; // a slow tick must not overlap the next one
      inFlight = true;
      try {
        attempts++;
        if (attempts > SYNC_POLL_MAX_ATTEMPTS) {
          stopSyncPoll(teamKey);
          await loadMappings();
          flashRowSyncStatus(teamKey, 'Still syncing…');
          return;
        }
        const res = await window.api('/api/mappings/' + encodeURIComponent(teamKey) + '/sync-status/' + jobId);
        if (res.status === 404) { stopSyncPoll(teamKey); await loadMappings(); return; }
        if (!res.ok) return; // transient server hiccup — retry next tick
        const job = await res.json();
        if (job.status === 'pending' || job.status === 'running') return; // keep waiting

        stopSyncPoll(teamKey);
        if (job.status === 'completed') {
          noteSyncResult(teamKey, { ok: true, result: job.result });
          await loadMappings();
          if (!(job.result && job.result.prUrl)) flashRowSyncStatus(teamKey, 'Up to date');
        } else { // failed
          await loadMappings();
          const msg = (job.error && job.error.message) || 'Workflow sync did not complete.';
          alert(msg + ' Retry with the Sync workflows button on the project row.');
        }
      } catch (_) {
        // network blip — leave the timer running for the next tick
      } finally {
        inFlight = false;
      }
    }, SYNC_POLL_MS);
  }
  window.pollSyncStatus = pollSyncStatus;
  
  async function syncWorkflows(button) {
    const key = button.dataset.key;
    button.disabled = true;
    button.textContent = 'Syncing...';
    try {
      const res = await window.api('/api/mappings/' + encodeURIComponent(key) + '/sync-workflows', { method: 'POST' });
      let data = {};
      try { data = await res.json(); } catch (_) {}
      if (!res.ok) { throw new Error(data.error || 'Failed to start sync'); }
      pollSyncStatus(key, data.syncJobId);
    } catch (err) {
      button.textContent = 'Sync failed';
      button.disabled = false;
      alert(err && err.message ? err.message : String(err));
      setTimeout(function () { button.textContent = 'Sync workflows'; }, 4000);
    }
  }
  window.syncWorkflows = syncWorkflows;

  // Ephemeral, in-memory record of the most recent auto-sync result per team
  // - written when a mapping is created/edited AND syncing was successful
  // - cleared on page refresh, so the row reverts to the normal button.
  function noteSyncResult(teamKey, sync) {
    if (sync && sync.ok && sync.result && sync.result.prUrl) {
      recentSync[teamKey] = { prUrl: sync.result.prUrl, status: sync.result.status };
    }
  }

  // Transiently label a project row's Sync button
  // - used after a create/edit that returned up-to-date (i.e. no PR to link to)
  function flashRowSyncStatus(teamKey, label) {
    const syncButton = findSyncBtn(teamKey);
    if (syncButton) {
      const originalText = syncButton.textContent;
      syncButton.textContent = label;
      syncButton.disabled = true;
      setTimeout(function () { syncButton.textContent = originalText; syncButton.disabled = false; }, 4000);
    }
  }

  function findSyncBtn(teamKey) {
    const buttons = document.querySelectorAll('#mappings-body button[data-sync-btn]');
    for (const btn of buttons) { if (btn.dataset.key === teamKey) return btn; }
    return null;
  }

  function stopSyncPoll(teamKey) {
    if (syncPollTimers[teamKey]) { clearInterval(syncPollTimers[teamKey]); delete syncPollTimers[teamKey]; }
  }

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
          + '<td></td>';
        const delSecBtn = document.createElement('button');
        delSecBtn.className = 'btn btn-sm btn-danger';
        delSecBtn.textContent = 'Delete';
        delSecBtn.addEventListener('click', function() { delSecret(s.name); });
        tr.lastElementChild.appendChild(delSecBtn);
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
