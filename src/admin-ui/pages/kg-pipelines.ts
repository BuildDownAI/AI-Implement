import { dispatchLogHtml } from "./pipelines.js";

export const kgPipelinesHtml = `
<section data-page="kg-pipelines" hidden>
  <header class="page-header">
    <div class="page-header-left">
      <h1 class="page-title">Knowledge Graph Pipelines</h1>
      <div class="page-subtitle">Refresh the knowledge graph and watch its runs</div>
    </div>
    <div class="page-header-actions">
      <button class="btn btn-sm" onclick="loadKgStatus(); loadKgExecutionMode(); loadKgMaterializeMode(); loadKgRunProfile(); loadKgSchedule(); loadKgGraphSettings()">&#8635; Refresh</button>
    </div>
  </header>
  <div class="page-body">
    <div id="kg-pipelines-error" hidden></div>

    <div class="card" id="kg-refresh-card" hidden>
      <div class="card-header"><h2 class="card-title">Knowledge graph <span class="badge neutral" id="kg-refresh-badge">—</span></h2></div>
      <div class="card-body">
        <div class="kpi-trend" id="kg-refresh-stamp">Served graph stamp: —</div>
        <div class="kpi-trend text-secondary" id="kg-refresh-last"></div>
        <div class="kpi-trend text-secondary" id="kg-last-steps" hidden></div>
        <div class="kpi-trend text-secondary" id="kg-sidecar-status" hidden></div>
        <div style="margin-top: 12px">
          <button class="btn btn-sm" id="kg-refresh-btn" onclick="window.triggerKgRefresh()">Refresh graph now</button>
          <button class="btn btn-sm" id="kg-accept-btn" onclick="window.decideKgRefresh('accept')" hidden>Accept new baseline &amp; refresh</button>
          <button class="btn btn-sm" id="kg-cancel-btn" onclick="window.decideKgRefresh('cancel')" hidden>Cancel</button>
          <span class="kpi-trend text-secondary" id="kg-refresh-help" style="margin-left: 8px">Refresh fetches the KG source repo's committed snapshot and restarts the sidecar — no deploy, no dispatch pause.</span>
        </div>
        <div class="kpi-trend text-secondary" id="kg-current-run" style="margin-top: 8px" hidden></div>
        <div style="margin-top: 12px; display:flex; align-items:center; gap:12px; flex-wrap:wrap">
          <span class="kpi-trend text-secondary">Backend:</span>
          <span class="seg" id="kg-backend-controls">
            <button class="btn btn-sm" id="btn-kg-backend-gha" data-backend="github-actions" onclick="window.setKgExecutionMode('github-actions')">GitHub Actions</button>
            <button class="btn btn-sm" id="btn-kg-backend-fly" data-backend="fly-machines" onclick="window.setKgExecutionMode('fly-machines')">Fly machines</button>
          </span>
          <span class="kpi-trend text-secondary" id="kg-backend-source"></span>
        </div>
        <div class="kpi-trend text-secondary" id="kg-backend-effective"></div>
        <div style="margin-top: 12px; display:flex; align-items:center; gap:12px; flex-wrap:wrap">
          <span class="kpi-trend text-secondary">Materialize:</span>
          <span class="seg" id="kg-materialize-controls">
            <button class="btn btn-sm" id="btn-kg-materialize-rdflib" data-materialize="rdflib" onclick="window.setKgMaterializeDirect(false)">rdflib</button>
            <button class="btn btn-sm" id="btn-kg-materialize-direct" data-materialize="direct" onclick="window.setKgMaterializeDirect(true)">direct</button>
          </span>
          <span class="kpi-trend text-secondary" id="kg-materialize-source"></span>
        </div>
        <div style="margin-top: 12px; display:flex; align-items:center; gap:12px; flex-wrap:wrap" id="kg-fly-machine-controls">
          <span class="kpi-trend text-secondary">Run profile:</span>
          <span class="seg">
            <button class="btn btn-sm" id="btn-kg-fly-cpu-shared" onclick="window.setKgFlyCpuKind('shared')">shared</button>
            <button class="btn btn-sm" id="btn-kg-fly-cpu-performance" onclick="window.setKgFlyCpuKind('performance')">performance</button>
          </span>
          <label class="kpi-trend text-secondary">CPUs <input type="number" id="kg-fly-cpus" min="1" max="16" step="1" style="width: 70px" oninput="window.refreshKgFlyDirty()"></label>
          <label class="kpi-trend text-secondary">Memory (MB) <input type="number" id="kg-fly-memory-mb" min="256" max="65536" step="1" style="width: 90px" oninput="window.refreshKgFlyDirty()"></label>
          <label class="kpi-trend text-secondary">Idle (hours) <input type="number" id="kg-fly-idle-hours" min="0" step="any" style="width: 80px" oninput="window.refreshKgFlyDirty()"></label>
          <button class="btn btn-sm" id="btn-kg-fly-save" disabled onclick="window.saveKgFlyMachine()">Save</button>
        </div>
        <div class="kpi-trend text-secondary" id="kg-fly-machine-effective"></div>
        <div class="kpi-trend text-secondary" id="kg-run-profile-error" hidden></div>
        <div style="margin-top: 12px; display:flex; align-items:center; gap:12px; flex-wrap:wrap" id="kg-gha-controls" hidden>
          <span class="kpi-trend text-secondary">Run profile:</span>
          <label class="kpi-trend text-secondary">Job timeout (minutes) <input type="number" id="kg-gha-job-timeout" min="10" max="360" step="1" style="width: 80px" oninput="window.refreshKgGhaDirty()"></label>
          <button class="btn btn-sm" id="btn-kg-gha-save" disabled onclick="window.saveKgGhaProfile()">Save</button>
        </div>
        <div class="kpi-trend text-secondary" id="kg-gha-note" hidden>Runner size comes from the KG repo's \`AI_IMPLEMENT_RUNNER_LABEL\` Actions variable. GitHub owns the machines, so there is no kept machine or idle time.</div>
        <div style="margin-top: 12px; display:flex; align-items:center; gap:12px; flex-wrap:wrap" id="kg-schedule-controls">
          <span class="kpi-trend text-secondary">Schedule:</span>
          <label class="kpi-trend text-secondary"><input type="checkbox" id="kg-schedule-enabled" onchange="window.refreshKgScheduleSave()"> On</label>
          <label class="kpi-trend text-secondary">Daily at <input type="time" id="kg-schedule-time" style="width: 110px" oninput="window.refreshKgScheduleSave()"></label>
          <label class="kpi-trend text-secondary">Zone <input type="text" id="kg-schedule-zone" style="width: 200px" oninput="window.refreshKgScheduleSave()"></label>
          <button class="btn btn-sm" id="btn-kg-schedule-save" onclick="window.saveKgSchedule()">Save</button>
          <span class="kpi-trend text-secondary" id="kg-schedule-error" hidden></span>
        </div>
        <div class="kpi-trend text-secondary" id="kg-schedule-next">Next run: —</div>
        <div class="kpi-trend text-secondary" id="kg-schedule-last"></div>
      </div>
    </div>

    <div class="card" id="kg-graph-source-card">
      <div class="card-header"><h2 class="card-title">Graph source</h2></div>
      <div class="card-body">
        <div class="field">
          <label for="kg-graph-source">Graph source</label>
          <div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap">
            <select class="input" id="kg-graph-source" style="flex:1;min-width:180px" onchange="window.saveKgGraphSource()" disabled>
              <option value="sidecar">Sidecar graph</option>
              <option value="stardog_run">Stardog</option>
            </select>
            <span class="kpi-trend text-secondary" id="kg-graph-source-status"></span>
          </div>
          <div id="kg-graph-source-error" class="error" hidden></div>
        </div>
        <div class="kpi-trend text-secondary" id="kg-graph-source-billing-note">Stardog bills each query.</div>
        <div class="kpi-trend text-secondary" id="kg-graph-customer-repo-note" hidden>Only a base-repo refresh loads Stardog. With a customer KG repo, nothing refreshes the Stardog graph.</div>
        <div class="field">
          <label for="kg-stardog-db">Database</label>
          <input class="input" id="kg-stardog-db" placeholder="e.g. builddown-kg">
        </div>
        <div class="field">
          <label for="kg-stardog-endpoint">Endpoint</label>
          <input class="input" id="kg-stardog-endpoint" placeholder="https://tenant.stardog.run/kg">
        </div>
        <div class="field">
          <label for="kg-stardog-console">Console</label>
          <input class="input" id="kg-stardog-console" placeholder="https://console.stardog.run">
        </div>
        <div class="field">
          <label for="kg-stardog-import-host">Import host</label>
          <input class="input" id="kg-stardog-import-host" placeholder="https://app.stardog.run">
          <div class="text-tertiary" style="font-size:11px;margin-top:3px">Empty means https://app.stardog.run.</div>
        </div>
        <div class="field">
          <label for="kg-stardog-token">Token</label>
          <div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap">
            <input class="input" id="kg-stardog-token" type="password" autocomplete="off" placeholder="Leave blank to keep the stored token" style="flex:1;min-width:180px">
            <span class="kpi-trend text-secondary" id="kg-stardog-token-status"></span>
          </div>
          <div class="text-tertiary" style="font-size:11px;margin-top:3px">The token is sent once and never shown again.</div>
        </div>
        <div style="margin-top:12px">
          <button class="btn btn-primary btn-sm" id="btn-kg-stardog-save" onclick="window.saveKgStardog()" disabled>Save Stardog values</button>
          <span class="kpi-trend text-secondary" id="kg-stardog-save-status"></span>
        </div>
        <div id="kg-stardog-error" class="error" hidden></div>
      </div>
    </div>

    <div class="card" id="kg-graph-details-card">
      <div class="card-header"><h2 class="card-title">Graph details</h2></div>
      <div class="card-body">
        <div class="field">
          <label for="kg-namespace">Namespace</label>
          <input class="input" id="kg-namespace" placeholder="https://kg.builddown.dev/">
        </div>
        <div class="field">
          <label for="kg-graph-name">Graph name</label>
          <input class="input" id="kg-graph-name" placeholder="builddown-kg">
        </div>
        <div class="field">
          <label for="kg-code-repo">KG code repo</label>
          <input class="input" id="kg-code-repo" placeholder="owner/name">
        </div>
        <div class="field">
          <label for="kg-graph-label">Graph label</label>
          <input class="input" id="kg-graph-label" maxlength="200">
        </div>
        <div style="margin-top:12px">
          <button class="btn btn-primary btn-sm" id="btn-kg-graph-details-save" onclick="window.saveKgGraphDetails()" disabled>Save</button>
          <span class="kpi-trend text-secondary" id="kg-graph-details-save-status"></span>
        </div>
        <div id="kg-graph-details-error" class="error" hidden></div>
        <div class="kpi-trend text-secondary">The sidecar reads Namespace and Graph name when it starts. Select the graph source again, or restart the orchestrator, to apply a change to them. A change to KG code repo or Graph label needs no restart.</div>
      </div>
    </div>
    ${dispatchLogHtml("kglog", { title: "Runs", emptyText: "No knowledge-graph refresh runs in the selected time range" })}
  </div>
</section>
`;

export const kgPipelinesScript = `
(function () {
  // A local copy of the Deployments page's showMessage; the message box here is #kg-pipelines-error.
  function showMessage(kind, text) {
    const el = document.getElementById('kg-pipelines-error');
    el.className = kind;
    el.textContent = text;
    el.hidden = false;
  }

  async function loadKgStatus() {
    const card = document.getElementById('kg-refresh-card');
    try {
      const res = await window.api('/api/kg/status');
      if (res.status === 409) {
        const held = await res.json().catch(() => ({}));
        if (held.error === 'deploy-in-progress') {
          card.hidden = false;
          ['kg-refresh-btn', 'kg-accept-btn', 'kg-cancel-btn'].forEach(function (id) {
            const b = document.getElementById(id);
            if (b) b.disabled = true;
          });
          document.getElementById('kg-refresh-last').textContent =
            'A deploy is in progress \u2014 the refresh status returns after it completes.';
          return;
        }
      }
      if (!res.ok) { card.hidden = true; return; }
      const data = await res.json();
      card.hidden = false;
      const badge = document.getElementById('kg-refresh-badge');
      // Use the stage field for fine-grained badge states; fall back to running for
      // older orchestrator responses that lack it.
      const stage = data.stage || (data.running ? 'checking' : 'idle');
      if (stage === 'checking') {
        window.setStatusBadge(badge, 'running', 'checking');
      } else if (stage === 'ingest-running') {
        window.setStatusBadge(badge, 'running', 'running');
      } else if (stage === 'snapshot-landed') {
        window.setStatusBadge(badge, 'running', 'landing');
      } else if (stage === 'staging') {
        window.setStatusBadge(badge, 'running', 'staging');
      } else if (stage === 'awaiting-decision') {
        window.setStatusBadge(badge, 'warn', 'awaiting decision');
      } else if (stage === 'serving') {
        window.setStatusBadge(badge, 'success', 'serving');
      } else if (stage === 'reverted') {
        window.setStatusBadge(badge, 'warn', 'reverted');
      } else if (stage === 'failed') {
        const concl = data.lastRefresh && data.lastRefresh.conclusion;
        if (concl === 'operator_cancelled') window.setStatusBadge(badge, 'neutral', 'cancelled');
        else if (concl === 'decision_timeout') window.setStatusBadge(badge, 'warn', 'timed out');
        else window.setStatusBadge(badge, 'fail', 'failed');
      } else if (data.kgDegraded) {
        window.setStatusBadge(badge, 'warn', 'degraded');
      } else if (data.lastRefresh?.gate === 'ingest-needed') {
        window.setStatusBadge(badge, 'neutral', 'stale');
      } else {
        window.setStatusBadge(badge, 'success', 'serving');
      }
      document.getElementById('kg-refresh-stamp').textContent =
        'Served graph stamp: ' + (data.servedStamp || 'baked image graph');
      // Stage-specific in-progress text, otherwise show last-refresh summary.
      let progressText = '';
      if (stage === 'checking') progressText = 'Checking KG source repo for a newer snapshot\u2026';
      else if (stage === 'ingest-running') progressText = 'Runner job dispatched \u2014 waiting for snapshot commit\u2026';
      else if (stage === 'snapshot-landed') progressText = 'Snapshot commit confirmed \u2014 starting local staging\u2026';
      else if (stage === 'staging') progressText = 'Staging new graph overlay\u2026';
      const last = data.lastRefresh;
      let lastText;
      if (!last) lastText = 'No refresh has run since boot.';
      else if (last.gate === 'ingest-needed') lastText = 'Last refresh: ' + last.detail;
      else if (last.conclusion === 'operator_cancelled') lastText = 'Last refresh: cancelled by operator';
      else if (last.conclusion === 'decision_timeout') lastText = 'Last refresh: no decision within 24 h \u2014 the held PR was closed';
      else lastText = 'Last refresh: ' + (last.ok ? (last.warnings && last.warnings.length > 0 ? 'completed with warnings' : 'passed') : 'failed' + (last.gate ? ' at gate "' + last.gate + '"' : '')) + ' \u2014 ' + last.detail;
      // A run in flight owns the line: the previous run's result must never show beside it.
      if (data.currentRun && !progressText) {
        progressText = stage === 'awaiting-decision'
          ? 'Held for a decision \u2014 see the current run below'
          : 'Run in flight' + (data.currentRun.step ? ': ' + data.currentRun.step : '') + ' \u2014 see the current run below';
      }
      const deployNotice = 'A deploy is in progress \u2014 you can still decide a held run; Refresh graph now returns after it completes.';
      document.getElementById('kg-refresh-last').textContent =
        data.deployHeld ? deployNotice + ' ' + (progressText || lastText) : (progressText || lastText);
      // AII-650: surface the sidecar liveness probe (AII-648) next to the stage-based badge —
      // a sidecar can be "serving" per the stage above while the probe shows it rejecting calls.
      const sidecarEl = document.getElementById('kg-sidecar-status');
      if (data.kgUnavailable) {
        sidecarEl.textContent = '⚠️ KG sidecar not serving — ' + ((data.sidecar && data.sidecar.lastError) || 'unknown error');
        sidecarEl.hidden = false;
      } else if (data.sidecar && data.sidecar.checkedAt) {
        sidecarEl.textContent = 'KG sidecar: reachable';
        sidecarEl.hidden = false;
      } else {
        sidecarEl.hidden = true;
      }
      renderKgLastSteps(data.currentRun ? null : last);
      renderKgCurrentRun(data.currentRun, stage);
      const busy = !!data.running || !!data.deployHeld;
      document.getElementById('kg-refresh-btn').disabled = busy;
      // A 409 deploy-in-progress poll disables these; a successful poll re-enables them.
      document.getElementById('kg-accept-btn').disabled = false;
      document.getElementById('kg-cancel-btn').disabled = false;
    } catch (e) { card.hidden = true; }
  }

  // A held snapshot is reported as a coded failure, so its push step reads failed; show held.
  function stepLabel(step, outcome) {
    if (outcome && outcome.held && step.id === 'kg-snapshot-push' && step.status === 'failed') return 'held';
    return step.status;
  }
  window.kgStepLabel = stepLabel;

  function renderKgLastSteps(last) {
    const el = document.getElementById('kg-last-steps');
    el.textContent = '';
    const steps = last && Array.isArray(last.steps) ? last.steps : [];
    el.hidden = steps.length === 0;
    steps.forEach(function (st) {
      const row = document.createElement('div');
      row.textContent = st.id + ': ' + stepLabel(st, last);
      el.appendChild(row);
    });
  }

  // The kg-pipelines page is admin-only, as is the /ui/ proxy, so the link needs no role check.
  function appendRestateLink(el, run) {
    if (!run.triggerId) return;
    const link = document.createElement('a');
    link.href = '/ui/workflows/KgRefresh/' + encodeURIComponent(run.triggerId);
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    link.style.display = 'block';
    link.textContent = 'Open in Restate UI';
    el.appendChild(link);
  }

  // The card shows the one current run: its step, and a button per open decision. Cells are
  // set with textContent, never innerHTML; the PR link goes through safeUrl().
  // The held view last rendered, so the Accept prompt reads the cause without another request.
  let renderedHeld = null;
  // The trigger id of that hold, so a decision names the hold the page shows (AII-1489).
  let renderedHeldTrigger = null;

  function heldTeams(held) {
    return Array.isArray(held && held.failedTeams) ? held.failedTeams.map(String) : [];
  }

  function heldWhy(held) {
    if (held.cause === 'source-failed') {
      const failed = (Array.isArray(held.sources) ? held.sources : []).filter(function (s) { return s.status === 'failed' && s.kind !== 'tracker'; }).map(function (s) { return String(s.source); });
      return 'Why: ' + (failed.length ? failed.join(', ') : 'a source') + ' failed, so the graph may be partial. Accept is blocked.';
    }
    if (held.cause !== 'tracker-missing') return 'Why: a snapshot part shrank past the guard.';
    const teams = heldTeams(held);
    return teams.length
      ? 'Why: tracker data could not be read for ' + teams.join(', ') + '. The tracker parts of this snapshot are missing or reduced.'
      : 'Why: tracker data was not fetched this run.';
  }

  function renderKgCurrentRun(run, stage) {
    renderedHeld = null;
    renderedHeldTrigger = null;
    const el = document.getElementById('kg-current-run');
    const decisions = run && Array.isArray(run.decisions) ? run.decisions : [];
    document.getElementById('kg-refresh-btn').hidden = !!run;
    document.getElementById('kg-refresh-help').hidden = !!run;
    document.getElementById('kg-accept-btn').hidden = decisions.indexOf('accept') < 0;
    document.getElementById('kg-cancel-btn').hidden = !run;
    el.textContent = '';
    if (!run) { el.hidden = true; return; }
    el.hidden = false;
    const held = stage === 'awaiting-decision' && run.held ? run.held : null;
    const head = document.createElement('div');
    if (!held) {
      head.textContent = 'Run in flight' + (run.step ? ': ' + run.step : '');
      el.appendChild(head);
      appendRestateLink(el, run);
      return;
    }
    renderedHeld = held;
    renderedHeldTrigger = run.triggerId || null;
    head.textContent = 'Held for a decision until ' + new Date(held.decideBy).toLocaleString();
    el.appendChild(head);
    const why = document.createElement('div');
    why.textContent = heldWhy(held);
    el.appendChild(why);
    appendRestateLink(el, run);
    if (held.snapshotPrUrl) {
      const link = document.createElement('a');
      link.href = window.safeUrl(held.snapshotPrUrl);
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      link.textContent = 'Held PR #' + held.snapshotPr;
      el.appendChild(link);
    }
    const rows = Array.isArray(held.partTable) ? held.partTable : [];
    if (!rows.length) return;
    const table = document.createElement('table');
    table.className = 'table';
    table.style.marginTop = '6px';
    const thead = document.createElement('thead');
    const hr = document.createElement('tr');
    ['part', 'previous', 'new', 'delta'].forEach(function (h) {
      const th = document.createElement('th'); th.textContent = h; hr.appendChild(th);
    });
    thead.appendChild(hr);
    table.appendChild(thead);
    const tbody = document.createElement('tbody');
    rows.forEach(function (r) {
      const tr = document.createElement('tr');
      const prev = parseInt(r.prev, 10);
      const next = parseInt(r.new, 10);
      const delta = (isNaN(prev) || isNaN(next)) ? '' : ((next - prev >= 0 ? '+' : '') + String(next - prev));
      [r.part, r.prev, r.new, delta].forEach(function (v) {
        const td = document.createElement('td'); td.textContent = v == null ? '' : String(v); tr.appendChild(td);
      });
      tbody.appendChild(tr);
    });
    table.appendChild(tbody);
    el.appendChild(table);
  }

  window.triggerKgRefresh = async function () {
    const btn = document.getElementById('kg-refresh-btn');
    btn.disabled = true;
    try {
      const res = await window.api('/api/kg/refresh', { method: 'POST' });
      if (!res.ok) showKgRefreshRefusal(res, await res.json().catch(function () { return {}; }));
    } catch (err) { showMessage('warning', 'Refresh failed \u2014 ' + String(err)); }
    setTimeout(loadKgStatus, 1000);
  };

  // The refresh button's refusal-to-message mapping: callback-unconfigured, deploy-in-progress, already-running.
  function showKgRefreshRefusal(res, body) {
    if (res.status === 422 && body.precondition === 'callback-unconfigured') {
      showMessage('warning', 'Refresh requires a configured runner callback \u2014 set RUNNER_CALLBACK_BASE_URL and RUNNER_TOKEN_SECRET on the orchestrator.');
    } else if (res.status === 409 && body.error === 'deploy-in-progress') {
      showMessage('warning', 'A deploy is in progress \u2014 try again after it completes.');
    } else if (res.status === 409) {
      showMessage('warning', 'A refresh is already in progress.');
    } else {
      showMessage('warning', 'Refresh refused \u2014 ' + (body.error || String(res.status)));
    }
  }

  // A decision names the hold the page shows, so a stale page cannot decide a newer hold; with no hold shown it acts on the current run.
  window.decideKgRefresh = async function (action) {
    const missing = renderedHeld && renderedHeld.cause === 'tracker-missing';
    const teams = missing ? heldTeams(renderedHeld) : [];
    const acceptPrompt = missing
      ? 'Accept the new baseline? This serves a graph whose tracker parts are missing or reduced' + (teams.length ? ' for ' + teams.join(', ') : '') + '. Review the part table first.'
      : 'Accept the new baseline? This lands the held snapshot even though a tracked part shrank, overriding the zero-shrink/50% guard for this run. Review the part table first.';
    const prompt = action === 'accept'
      ? acceptPrompt
      : 'Cancel the current refresh? The run stops, and a held PR, if there is one, is closed.';
    if (!confirm(prompt)) return;
    const accept = document.getElementById('kg-accept-btn');
    const cancel = document.getElementById('kg-cancel-btn');
    accept.disabled = true;
    cancel.disabled = true;
    try {
      const res = await window.api('/api/tools/decide_kg_refresh', { method: 'POST', body: JSON.stringify({ args: renderedHeldTrigger ? { action: action, triggerId: renderedHeldTrigger } : { action: action } }) });
      const out = unwrapToolAnswer(res, await res.json().catch(function () { return {}; }));
      if (out.status === 403) showMessage('warning', 'admin only');
      else if (!out.ok) showMessage('warning', 'Could not ' + action + ' the refresh \u2014 ' + (out.body.error || out.status));
      else document.getElementById('kg-pipelines-error').hidden = true;
    } catch (err) { showMessage('warning', 'Could not ' + action + ' the refresh \u2014 ' + String(err)); }
    accept.disabled = false;
    cancel.disabled = false;
    await loadKgStatus();
  };

  async function loadKgExecutionMode() {
    try {
      const res = await window.api('/api/kg/execution-mode');
      if (!res.ok) return;
      const data = await res.json();
      document.getElementById('btn-kg-backend-gha').classList.toggle('btn-primary', data.mode === 'github-actions');
      document.getElementById('btn-kg-backend-fly').classList.toggle('btn-primary', data.mode === 'fly-machines');
      document.getElementById('kg-backend-source').textContent = '(' + data.source + ')';
    } catch (e) { /* transient \u2014 next poll retries */ }
  }

  window.setKgExecutionMode = async function (mode) {
    try {
      const res = await window.api('/api/kg/execution-mode', { method: 'POST', body: JSON.stringify({ mode: mode }) });
      if (!res.ok && res.status !== 401) {
        const body = await res.json().catch(function () { return {}; });
        showMessage('warning', 'Could not change the KG backend \u2014 ' + (body.error || res.status));
      }
    } catch (err) {
      showMessage('warning', 'Could not change the KG backend \u2014 ' + String(err));
    }
    loadKgExecutionMode();
    loadKgRunProfile();
  };

  var KG_BACKEND_LABELS = { 'github-actions': 'GitHub Actions', 'fly-machines': 'Fly machines', 'local-docker': 'local Docker' };

  // The effective line comes from get_kg_status.executionMode; the run-profile row follows get_kg_status.runProfile.
  function renderKgExecutionMode(em) {
    const effectiveEl = document.getElementById('kg-backend-effective');
    if (!em) { effectiveEl.textContent = ''; return; }
    const label = KG_BACKEND_LABELS[em.effective] || em.effective;
    let why;
    if (em.source === 'kg-setting') why = 'KG setting';
    else if (em.source === 'fly-unconfigured') why = 'Fly not configured';
    else if (em.source === 'runner-mode') {
      const rm = em.effective === 'fly-machines' ? 'fly' : em.effective === 'local-docker' ? 'local' : 'gha';
      why = 'runner mode ' + rm + (em.effective === em.setting ? '' : ' overrides the KG setting');
    } else why = em.source;
    effectiveEl.innerHTML = window.esc('next run: ' + label + ' (' + why + ')');
  }

  async function loadKgMaterializeMode() {
    try {
      const res = await window.api('/api/kg/materialize-mode');
      if (!res.ok) return;
      const data = await res.json();
      const direct = !!data.direct;
      document.getElementById('btn-kg-materialize-rdflib').classList.toggle('btn-primary', !direct);
      document.getElementById('btn-kg-materialize-direct').classList.toggle('btn-primary', direct);
      document.getElementById('kg-materialize-source').textContent = '(' + data.source + ')';
    } catch (e) { /* transient \u2014 next poll retries */ }
  }

  // AII-1975: the graph source is what answers the next kg_* call; the Backend controls
  // above only choose where a refresh runs. Keep the two surfaces apart.
  let kgGraphSourceSaved = null;
  let kgGraphSourceBusy = false;
  let kgGraphSettingsLoaded = false;
  let kgStardogBusy = false;
  let kgStardogSaved = null;
  let kgGraphDetailsBusy = false;
  let kgGraphDetailsSaved = null;

  function kgGraphSourceLabel(value) {
    return value === 'stardog_run' ? 'Stardog' : 'Sidecar graph';
  }

  function kgShowGraphSourceStatus(text) {
    document.getElementById('kg-graph-source-status').textContent = text || '';
  }

  function kgShowGraphSourceError(text) {
    const el = document.getElementById('kg-graph-source-error');
    el.textContent = text || '';
    el.hidden = !text;
  }

  function kgPaintGraphSource(value) {
    const select = document.getElementById('kg-graph-source');
    select.value = value === 'stardog_run' ? 'stardog_run' : 'sidecar';
    select.disabled = kgGraphSourceBusy || !kgGraphSettingsLoaded;
  }

  function kgStardogInputs() {
    return {
      db: document.getElementById('kg-stardog-db').value,
      endpoint: document.getElementById('kg-stardog-endpoint').value,
      console: document.getElementById('kg-stardog-console').value,
      importHost: document.getElementById('kg-stardog-import-host').value,
    };
  }

  function kgStardogDirty() {
    if (!kgStardogSaved) return false;
    const now = kgStardogInputs();
    return now.db !== kgStardogSaved.db || now.endpoint !== kgStardogSaved.endpoint
      || now.console !== kgStardogSaved.console || now.importHost !== kgStardogSaved.importHost;
  }

  function kgPaintStardogSave() {
    document.getElementById('btn-kg-stardog-save').disabled = kgStardogBusy || !kgGraphSettingsLoaded;
  }

  function kgGraphDetailsInputs() {
    return {
      namespace: document.getElementById('kg-namespace').value,
      graphName: document.getElementById('kg-graph-name').value,
      codeRepo: document.getElementById('kg-code-repo').value,
      graphLabel: document.getElementById('kg-graph-label').value,
    };
  }

  function kgGraphDetailsDirty() {
    if (!kgGraphDetailsSaved) return false;
    const now = kgGraphDetailsInputs();
    return now.namespace !== kgGraphDetailsSaved.namespace || now.graphName !== kgGraphDetailsSaved.graphName
      || now.codeRepo !== kgGraphDetailsSaved.codeRepo || now.graphLabel !== kgGraphDetailsSaved.graphLabel;
  }

  function kgPaintGraphDetailsSave() {
    document.getElementById('btn-kg-graph-details-save').disabled = kgGraphDetailsBusy || !kgGraphSettingsLoaded;
  }

  async function loadKgGraphSettings() {
    try {
      const res = await window.api('/api/settings');
      if (!res.ok) return;
      const data = await res.json();
      if (!data || typeof data !== 'object' || Array.isArray(data)) return;
      const source = data.kgGraphSource === 'stardog_run' ? 'stardog_run' : 'sidecar';
      kgGraphSourceSaved = source;
      const importHost = document.getElementById('kg-stardog-import-host');
      if (!kgStardogDirty()) {
        document.getElementById('kg-stardog-db').value = data.kg_stardog_db || '';
        document.getElementById('kg-stardog-endpoint').value = data.kg_stardog_run_endpoint || '';
        document.getElementById('kg-stardog-console').value = data.kg_stardog_run_console || '';
        importHost.value = data.kg_stardog_run_platform || 'https://app.stardog.run';
        kgStardogSaved = kgStardogInputs();
      }
      if (!kgGraphDetailsDirty()) {
        document.getElementById('kg-namespace').value = data.kg_namespace || '';
        document.getElementById('kg-graph-name').value = data.kg_graph_name || '';
        document.getElementById('kg-code-repo').value = data.kg_code_repo || '';
        document.getElementById('kg-graph-label').value = data.kg_graph_label || '';
        kgGraphDetailsSaved = kgGraphDetailsInputs();
      }
      document.getElementById('kg-stardog-token-status').textContent =
        data.stardogTokenSet ? 'Token set' : 'Token not set';
      document.getElementById('kg-graph-customer-repo-note').hidden = !data.kgCustomerRepo;
      kgGraphSettingsLoaded = true;
      kgPaintStardogSave();
      kgPaintGraphDetailsSave();
      if (!kgGraphSourceBusy) kgPaintGraphSource(source);
    } catch (e) { /* transient — next poll retries */ }
  }

  function kgIdempotencyKey() {
    if (window.crypto && typeof window.crypto.randomUUID === 'function') {
      return 'kg-source-' + window.crypto.randomUUID();
    }
    const bytes = [];
    for (let i = 0; i < 16; i++) bytes.push(Math.floor(Math.random() * 256).toString(16).padStart(2, '0'));
    return 'kg-source-' + bytes.join('');
  }

  // The 60 s call limit answers 503. Re-send with the same key so the retry attaches to
  // the switch already running; at most 10 total calls, and only a 503 is retried.
  window.saveKgGraphSource = async function () {
    if (kgGraphSourceBusy) return;
    if (!kgGraphSettingsLoaded) {
      kgShowGraphSourceStatus('');
      kgShowGraphSourceError('Load the graph settings before switching the source.');
      return;
    }
    const select = document.getElementById('kg-graph-source');
    const previous = kgGraphSourceSaved || 'sidecar';
    const source = select.value === 'stardog_run' ? 'stardog_run' : 'sidecar';
    kgShowGraphSourceError('');
    kgGraphSourceBusy = true;
    select.disabled = true;
    kgShowGraphSourceStatus(source === 'stardog_run'
      ? 'Switching\\u2026 Stardog can take up to 5 minutes to wake.'
      : 'Switching\\u2026');
    const key = kgIdempotencyKey();
    let out = null;
    try {
      for (let attempt = 1; attempt <= 10; attempt++) {
        const res = await window.api('/api/tools/set_kg_graph_source', {
          method: 'POST',
          headers: { 'Idempotency-Key': key },
          body: JSON.stringify({ args: { source: source } }),
        });
        if (res.status === 503) {
          if (attempt < 10) continue;
          out = { ok: false, status: 503, body: {} };
          break;
        }
        out = unwrapToolAnswer(res, await res.json().catch(function () { return {}; }));
        break;
      }
      if (!out || out.status === 503) {
        kgGraphSourceBusy = false;
        kgPaintGraphSource(previous);
        kgShowGraphSourceStatus('The switch may still be running. Reload the page to see the source.');
        return;
      }
      if (out.status === 403) {
        kgGraphSourceBusy = false;
        kgPaintGraphSource(previous);
        kgShowGraphSourceStatus('');
        kgShowGraphSourceError('admin only');
        return;
      }
      if (!out.ok || out.body.switched !== true) {
        kgGraphSourceBusy = false;
        kgPaintGraphSource(previous);
        kgShowGraphSourceStatus('');
        const reason = out.body.error || out.body.message || out.status;
        const detail = out.body.message && out.body.message !== reason ? ' \\u2014 ' + out.body.message : '';
        kgShowGraphSourceError('Switch failed \\u2014 ' + reason + detail);
        return;
      }
      kgGraphSourceBusy = false;
      kgGraphSourceSaved = out.body.source === 'stardog_run' ? 'stardog_run' : source;
      kgPaintGraphSource(kgGraphSourceSaved);
      kgShowGraphSourceStatus('Now answering from ' + kgGraphSourceLabel(kgGraphSourceSaved) + '.');
    } catch (err) {
      kgGraphSourceBusy = false;
      kgPaintGraphSource(previous);
      kgShowGraphSourceStatus('');
      kgShowGraphSourceError('Switch failed \\u2014 ' + String(err));
    }
  };

  window.saveKgStardog = async function () {
    const status = document.getElementById('kg-stardog-save-status');
    const error = document.getElementById('kg-stardog-error');
    const input = document.getElementById('kg-stardog-token');
    if (kgStardogBusy) return;
    if (!kgGraphSettingsLoaded) {
      status.textContent = '';
      error.textContent = 'Load the Stardog values before saving.';
      error.hidden = false;
      return;
    }
    const token = input.value;
    error.hidden = true;
    error.textContent = '';
    status.textContent = 'Saving\\u2026';
    kgStardogBusy = true;
    kgPaintStardogSave();
    let tokenSaved = false;
    let valuesSaved = false;
    try {
      const values = {
        kg_stardog_db: document.getElementById('kg-stardog-db').value.trim(),
        kg_stardog_run_endpoint: document.getElementById('kg-stardog-endpoint').value.trim(),
        kg_stardog_run_console: document.getElementById('kg-stardog-console').value.trim(),
        kg_stardog_run_platform: document.getElementById('kg-stardog-import-host').value.trim(),
      };
      const res = await window.api('/api/settings', { method: 'POST', body: JSON.stringify(values) });
      const data = await res.json().catch(function () { return {}; });
      if (!res.ok) throw new Error(data.error || String(res.status));
      valuesSaved = true;
      if (token) {
        const tokenRes = await window.api('/api/kg/stardog', { method: 'POST', body: JSON.stringify({ token: token }) });
        const tokenBody = await tokenRes.json().catch(function () { return {}; });
        // Clear the browser copy as soon as the request is answered; the value stays only
        // on the server, encrypted, and a failure below still leaves no credential on screen.
        input.value = '';
        if (!tokenRes.ok) throw new Error(tokenBody.error || String(tokenRes.status));
        tokenSaved = true;
      }
      kgStardogSaved = null;
      await loadKgGraphSettings();
      status.textContent = tokenSaved ? 'Saved, including the token.' : 'Saved.';
    } catch (err) {
      // Never echo the field back into an error: it may be the credential the save was carrying.
      input.value = '';
      status.textContent = '';
      error.textContent = (valuesSaved ? 'Stardog values saved, but the token could not be saved' : 'Could not save the Stardog values') + ' \\u2014 ' + String(err);
      error.hidden = false;
    } finally {
      kgStardogBusy = false;
      kgPaintStardogSave();
    }
  };

  window.saveKgGraphDetails = async function () {
    const status = document.getElementById('kg-graph-details-save-status');
    const error = document.getElementById('kg-graph-details-error');
    if (kgGraphDetailsBusy) return;
    if (!kgGraphSettingsLoaded) {
      status.textContent = '';
      error.textContent = 'Load the graph details before saving.';
      error.hidden = false;
      return;
    }
    const values = kgGraphDetailsInputs();
    error.hidden = true;
    error.textContent = '';
    status.textContent = 'Saving\\u2026';
    kgGraphDetailsBusy = true;
    kgPaintGraphDetailsSave();
    try {
      const res = await window.api('/api/settings', {
        method: 'POST',
        body: JSON.stringify({
          kg_namespace: values.namespace.trim(),
          kg_graph_name: values.graphName.trim(),
          kg_code_repo: values.codeRepo.trim(),
          kg_graph_label: values.graphLabel.trim(),
        }),
      });
      const data = await res.json().catch(function () { return {}; });
      if (!res.ok) throw new Error(data.error || String(res.status));
      kgGraphDetailsSaved = null;
      await loadKgGraphSettings();
      status.textContent = 'Saved.';
    } catch (err) {
      status.textContent = '';
      error.textContent = 'Could not save the graph details \\u2014 ' + String(err);
      error.hidden = false;
    } finally {
      kgGraphDetailsBusy = false;
      kgPaintGraphDetailsSave();
    }
  };

  window.setKgMaterializeDirect = async function (direct) {
    try {
      const res = await window.api('/api/kg/materialize-mode', { method: 'POST', body: JSON.stringify({ direct: direct }) });
      if (!res.ok && res.status !== 401) {
        const body = await res.json().catch(function () { return {}; });
        showMessage('warning', 'Could not change materialize mode \u2014 ' + (body.error || res.status));
      }
    } catch (err) {
      showMessage('warning', 'Could not change materialize mode \u2014 ' + String(err));
    }
    loadKgMaterializeMode();
  };

  // AII-1245: the run-profile row. One row for the effective backend: Fly machine controls,
  // a GitHub Actions job timeout, or nothing for local Docker.
  // AII-1116: the kg-refresh FlyMachineProfile. Reads and writes go through the tools route;
  // a tool answer is { content: [{ text }], isError }, with a 400 carried inside the text.
  let savedFlyProfile = null;
  let flyCpuKind = null;
  let savedKgGha = null;
  let kgProfileBackend = null;

  function unwrapToolAnswer(res, body) {
    let status = res.status;
    let data = body;
    if (res.ok && body && Array.isArray(body.content)) {
      const text = body.content[0] && body.content[0].text;
      let parsed = null;
      try { parsed = JSON.parse(text); } catch (e) { /* plain-text error */ }
      if (body.isError) {
        status = /^forbidden/.test(String(text)) ? 403 : 500;
        data = { error: String(text) };
      } else if (parsed && parsed.status && parsed.body) {
        status = parsed.status;
        data = parsed.body;
      } else {
        data = parsed || {};
      }
    }
    return { ok: status >= 200 && status < 300, status: status, body: data || {} };
  }

  function formatKgIdle(ms) {
    const hours = ms / 3600000;
    if (hours >= 24 && hours % 24 === 0) return (hours / 24) + ' d';
    if (hours >= 1 && Number.isInteger(hours)) return hours + ' h';
    return Math.round(ms / 60000) + ' min';
  }

  function kgFlyInputs() {
    return {
      cpuKind: flyCpuKind,
      cpus: Number(document.getElementById('kg-fly-cpus').value),
      memoryMb: Number(document.getElementById('kg-fly-memory-mb').value),
      idleTimeoutMs: Math.round(Number(document.getElementById('kg-fly-idle-hours').value) * 3600000),
    };
  }

  function kgFlyChanges() {
    if (!savedFlyProfile) return {};
    const now = kgFlyInputs();
    const changes = {};
    ['cpuKind', 'cpus', 'memoryMb', 'idleTimeoutMs'].forEach(function (k) {
      if (now[k] !== savedFlyProfile[k]) changes[k] = now[k];
    });
    return changes;
  }

  function refreshKgFlyDirty() {
    document.getElementById('btn-kg-fly-save').disabled = Object.keys(kgFlyChanges()).length === 0;
  }

  function paintKgFlyKind() {
    document.getElementById('btn-kg-fly-cpu-shared').classList.toggle('btn-primary', flyCpuKind === 'shared');
    document.getElementById('btn-kg-fly-cpu-performance').classList.toggle('btn-primary', flyCpuKind === 'performance');
  }

  async function loadKgRunProfile() {
    try {
      const res = await window.api('/api/tools/get_kg_status', { method: 'POST', body: JSON.stringify({ args: {} }) });
      const out = unwrapToolAnswer(res, await res.json().catch(function () { return {}; }));
      if (!out.ok) {
        ['kg-fly-machine-controls', 'kg-fly-machine-effective', 'kg-gha-controls', 'kg-gha-note'].forEach(function (id) {
          document.getElementById(id).hidden = true;
        });
        const errEl = document.getElementById('kg-run-profile-error');
        errEl.textContent = 'run profile unavailable (' + (out.status === 403 ? 'admin only' : out.status) + ')';
        errEl.hidden = false;
        return;
      }
      document.getElementById('kg-run-profile-error').hidden = true;
      renderKgExecutionMode(out.body.executionMode);
      const rp = out.body.runProfile;
      const backend = rp && rp.config ? rp.backend : null;
      const isFly = backend === 'fly-machines';
      const isGha = backend === 'github-actions';
      document.getElementById('kg-fly-machine-controls').hidden = !isFly;
      document.getElementById('kg-fly-machine-effective').hidden = !isFly;
      document.getElementById('kg-gha-controls').hidden = !isGha;
      document.getElementById('kg-gha-note').hidden = !isGha;
      // A backend switch drops any half-typed edit that belonged to the other backend.
      if (backend !== kgProfileBackend) { savedFlyProfile = null; savedKgGha = null; kgProfileBackend = backend; }
      if (isGha) {
        const cfg = rp.config;
        if (typeof cfg.jobTimeoutMinutes !== 'number') return;
        if (savedKgGha && Object.keys(kgGhaChanges()).length) return;
        savedKgGha = { jobTimeoutMinutes: cfg.jobTimeoutMinutes };
        document.getElementById('kg-gha-job-timeout').value = String(cfg.jobTimeoutMinutes);
        refreshKgGhaDirty();
        return;
      }
      if (!isFly) return;
      const fm = rp.config;
      if (typeof fm.cpus !== 'number') return;
      document.getElementById('kg-fly-machine-effective').textContent =
        'next Fly run: ' + fm.cpuKind + ', ' + fm.cpus + ' CPU / ' + fm.memoryMb + ' MB, idle '
        + formatKgIdle(fm.idleTimeoutMs) + ' (' + rp.source + ')';
      // A poll must not overwrite values the admin is mid-edit on.
      if (savedFlyProfile && Object.keys(kgFlyChanges()).length) return;
      savedFlyProfile = { cpuKind: fm.cpuKind, cpus: fm.cpus, memoryMb: fm.memoryMb, idleTimeoutMs: fm.idleTimeoutMs };
      flyCpuKind = fm.cpuKind;
      paintKgFlyKind();
      document.getElementById('kg-fly-cpus').value = String(fm.cpus);
      document.getElementById('kg-fly-memory-mb').value = String(fm.memoryMb);
      document.getElementById('kg-fly-idle-hours').value = String(fm.idleTimeoutMs / 3600000);
      refreshKgFlyDirty();
    } catch (e) { /* transient \u2014 next poll retries */ }
  }

  window.setKgFlyCpuKind = function (kind) {
    flyCpuKind = kind;
    paintKgFlyKind();
    refreshKgFlyDirty();
  };
  window.refreshKgFlyDirty = refreshKgFlyDirty;

  async function saveKgRunProfile(backend, patch) {
    try {
      const args = { pipeline: 'kg-refresh', backend: backend, patch: patch };
      const res = await window.api('/api/tools/set_run_profile', { method: 'POST', body: JSON.stringify({ args: args }) });
      const out = unwrapToolAnswer(res, await res.json().catch(function () { return {}; }));
      if (out.status === 403) { showMessage('warning', 'admin only'); return; }
      if (!out.ok) {
        showMessage('warning', 'Could not change the run profile \u2014 ' + (out.body.error || out.status));
        return;
      }
      document.getElementById('kg-pipelines-error').hidden = true;
      savedFlyProfile = null;
      savedKgGha = null;
      loadKgRunProfile();
    } catch (err) {
      showMessage('warning', 'Could not change the run profile \u2014 ' + String(err));
    }
  }

  window.saveKgFlyMachine = function () {
    const changes = kgFlyChanges();
    if (!Object.keys(changes).length) return Promise.resolve();
    return saveKgRunProfile('fly-machines', changes);
  };

  function kgGhaChanges() {
    if (!savedKgGha) return {};
    const raw = document.getElementById('kg-gha-job-timeout').value;
    const v = raw === '' ? NaN : Number(raw);
    return v === savedKgGha.jobTimeoutMinutes ? {} : { jobTimeoutMinutes: v };
  }

  function refreshKgGhaDirty() {
    const changes = kgGhaChanges();
    const v = changes.jobTimeoutMinutes;
    const valid = Number.isInteger(v) && v >= 10 && v <= 360;
    document.getElementById('btn-kg-gha-save').disabled = !(valid);
  }
  window.refreshKgGhaDirty = refreshKgGhaDirty;

  window.saveKgGhaProfile = function () {
    const changes = kgGhaChanges();
    if (!Number.isInteger(changes.jobTimeoutMinutes)) return Promise.resolve();
    return saveKgRunProfile('github-actions', changes);
  };

  // AII-1434: the daily refresh schedule, read and written through the PipelineSchedule tools.
  // A poll repaints only while the inputs match what was last painted, so a typed or
  // just-rejected edit survives.
  let savedKgSchedule = null;
  let kgScheduleHeld = false;

  function kgScheduleInputs() {
    return {
      enabled: document.getElementById('kg-schedule-enabled').checked,
      time: document.getElementById('kg-schedule-time').value,
      zone: document.getElementById('kg-schedule-zone').value.trim(),
    };
  }

  function kgScheduleDirty() {
    if (!savedKgSchedule) return false;
    const now = kgScheduleInputs();
    return now.enabled !== savedKgSchedule.enabled || now.time !== savedKgSchedule.time || now.zone !== savedKgSchedule.zone;
  }

  function refreshKgScheduleSave() {
    document.getElementById('btn-kg-schedule-save').disabled = kgScheduleHeld;
  }
  window.refreshKgScheduleSave = refreshKgScheduleSave;

  function showKgScheduleError(text) {
    const el = document.getElementById('kg-schedule-error');
    el.textContent = text || '';
    el.hidden = !text;
  }

  var KG_DEPLOY_HELD_TEXT = 'A deploy is in progress — try again after it completes.';

  function renderKgScheduleResult(schedule, nextOccurrence) {
    document.getElementById('kg-schedule-next').textContent =
      'Next run: ' + (nextOccurrence ? new Date(nextOccurrence).toLocaleString() : 'Off');
    const lastEl = document.getElementById('kg-schedule-last');
    const lr = schedule && schedule.lastResult;
    if (!lr) { lastEl.textContent = 'Last result: none yet'; return; }
    let text = 'Last result: ' + lr.outcome + ' at ' + new Date(lr.at).toLocaleString();
    if (lr.outcome === 'refused') text += ' — ' + (lr.detail || '');
    else if (lr.runId) text += ' — run ' + lr.runId;
    else if (lr.detail) text += ' — ' + lr.detail;
    lastEl.textContent = text;
  }

  async function loadKgSchedule() {
    try {
      const res = await window.api('/api/tools/get_pipeline_schedule', { method: 'POST', body: JSON.stringify({ args: { pipeline: 'kg-refresh' } }) });
      const out = unwrapToolAnswer(res, await res.json().catch(function () { return {}; }));
      if (out.status === 409 && out.body.error === 'deploy-in-progress') {
        kgScheduleHeld = true;
        refreshKgScheduleSave();
        showKgScheduleError(KG_DEPLOY_HELD_TEXT);
        return;
      }
      if (!out.ok) {
        showKgScheduleError('schedule unavailable (' + (out.status === 403 ? 'admin only' : out.status) + ')');
        return;
      }
      kgScheduleHeld = false;
      refreshKgScheduleSave();
      if (!kgScheduleDirty()) showKgScheduleError('');
      const schedule = out.body.schedule || null;
      renderKgScheduleResult(schedule, out.body.nextOccurrence);
      if (kgScheduleDirty()) return;
      const browserZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
      savedKgSchedule = {
        enabled: !!(schedule && schedule.enabled),
        time: (schedule && schedule.time) || '',
        zone: (schedule && schedule.zone) || browserZone || '',
      };
      document.getElementById('kg-schedule-enabled').checked = savedKgSchedule.enabled;
      document.getElementById('kg-schedule-time').value = savedKgSchedule.time;
      document.getElementById('kg-schedule-zone').value = savedKgSchedule.zone;
    } catch (e) { /* transient — next poll retries */ }
  }

  window.saveKgSchedule = async function () {
    if (kgScheduleHeld) return;
    const patch = kgScheduleInputs();
    try {
      const args = { pipeline: 'kg-refresh', patch: patch };
      const res = await window.api('/api/tools/set_pipeline_schedule', { method: 'POST', body: JSON.stringify({ args: args }) });
      const out = unwrapToolAnswer(res, await res.json().catch(function () { return {}; }));
      if (out.status === 409 && out.body.error === 'deploy-in-progress') {
        kgScheduleHeld = true;
        refreshKgScheduleSave();
        showKgScheduleError(KG_DEPLOY_HELD_TEXT);
        return;
      }
      if (out.status === 403) { showKgScheduleError('admin only'); return; }
      if (!out.ok) {
        showKgScheduleError(String(out.body.error || out.status));
        return;
      }
      showKgScheduleError('');
      savedKgSchedule = null;
      await loadKgSchedule();
    } catch (err) {
      showKgScheduleError('Could not save the schedule — ' + String(err));
    }
  };

  window.loadKgSchedule = loadKgSchedule;
  window.loadKgStatus = loadKgStatus;
  window.loadKgExecutionMode = loadKgExecutionMode;
  window.loadKgMaterializeMode = loadKgMaterializeMode;
  window.loadKgRunProfile = loadKgRunProfile;
  window.loadKgGraphSettings = loadKgGraphSettings;

  window.registerPage('kg-pipelines', function () {
    loadKgStatus();
    loadKgExecutionMode();
    loadKgMaterializeMode();
    loadKgRunProfile();
    loadKgSchedule();
    loadKgGraphSettings();
    setInterval(loadKgSchedule, 15000);
    setInterval(loadKgStatus, 15000);
    setInterval(loadKgExecutionMode, 15000);
    setInterval(loadKgMaterializeMode, 15000);
    setInterval(loadKgRunProfile, 15000);
    setInterval(function () { if (!kgGraphSourceBusy && !kgStardogBusy) loadKgGraphSettings(); }, 15000);
    // createDispatchLog comes from the Pipelines page script; the card works without it.
    if (window.createDispatchLog) window.createDispatchLog('kglog', { filter: function (e) { return e.phase === 'kg-refresh'; } }).start();
  });
})();
`;
