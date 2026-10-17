export const reportsHtml = `
<section data-page="reports" hidden>
  <header class="page-header">
    <div class="page-header-left">
      <h1 class="page-title">Reports</h1>
      <div class="page-subtitle">Fleet outcomes, planning comparison, escape rate, and runaways.</div>
    </div>
    <div class="page-header-actions">
      <select id="reports-days" class="input" onchange="loadReports()">
        <option value="7">Last 7 days</option>
        <option value="30" selected>Last 30 days</option>
        <option value="90">Last 90 days</option>
      </select>
      <button class="btn btn-sm" onclick="loadReports()">&#8635; Refresh</button>
    </div>
  </header>
  <div class="page-body">
    <div class="card">
      <div class="card-header">
        <h2 class="card-title">Fleet by repo</h2>
        <div class="card-subtitle"><span id="reports-repo-count">&mdash;</span></div>
      </div>
      <div class="card-body tight">
        <table class="tbl">
          <thead><tr>
            <th>Repo</th><th>Jobs</th><th>Issues</th><th>Completed</th><th>Failed</th><th>Merged</th><th>Avg passes</th><th>Cost (USD)</th>
          </tr></thead>
          <tbody id="reports-fleet-body"></tbody>
        </table>
        <div id="reports-fleet-empty" class="hidden text-tertiary" style="padding:12px">No data for this period</div>
      </div>
    </div>
    <div class="card">
      <div class="card-header">
        <h2 class="card-title">Outcomes</h2>
        <div class="card-subtitle">Fleet-wide pass rates</div>
      </div>
      <div class="card-body">
        <div class="kpi-grid">
          <div class="kpi" id="reports-kpi-oneshot">
            <div class="kpi-label">One-shot</div>
            <div class="kpi-value"><span id="reports-oneshot">&mdash;</span></div>
            <span class="kpi-trend">Approved on first dispatch</span>
          </div>
          <div class="kpi" id="reports-kpi-eventual">
            <div class="kpi-label">Eventual</div>
            <div class="kpi-value"><span id="reports-eventual">&mdash;</span></div>
            <span class="kpi-trend">Approved across all dispatches</span>
          </div>
          <div class="kpi" id="reports-kpi-escape">
            <div class="kpi-label">Escape rate</div>
            <div class="kpi-value"><span id="reports-escape">&mdash;</span></div>
            <span class="kpi-trend">Human edits after merge</span>
          </div>
        </div>
      </div>
    </div>
    <div class="card">
      <div class="card-header">
        <h2 class="card-title">Planning A/B</h2>
        <div class="card-subtitle">Planned vs. unplanned issues</div>
      </div>
      <div class="card-body tight">
        <table class="tbl">
          <thead><tr>
            <th>Cohort</th><th>Jobs</th><th>One-shot</th><th>Avg passes</th><th>Avg cost</th><th>Merged</th>
          </tr></thead>
          <tbody id="reports-planning-body"></tbody>
        </table>
      </div>
    </div>
    <div class="card">
      <div class="card-header">
        <h2 class="card-title">Runaways</h2>
        <div class="card-subtitle">Issues with 3+ dispatches or 3+ consecutive failures</div>
      </div>
      <div class="card-body tight">
        <table class="tbl">
          <thead><tr>
            <th>Issue</th><th>Repo</th><th>Dispatches</th><th>Consecutive failures</th>
          </tr></thead>
          <tbody id="reports-runaways-body"></tbody>
        </table>
        <div id="reports-runaways-empty" class="hidden text-tertiary" style="padding:12px">No runaways</div>
      </div>
    </div>
    <div class="card">
      <div class="card-header">
        <h2 class="card-title">Agent attribution</h2>
        <div class="card-subtitle">Latest invocation per job &middot; <span id="reports-attr-count">&mdash;</span></div>
      </div>
      <div class="card-body tight">
        <table class="tbl">
          <thead><tr>
            <th>Issue</th><th>Stage</th><th>Agent / provider / model</th><th>Profile / auth</th><th>Outcome</th><th>Limit</th><th>Usage</th><th>Cost</th>
          </tr></thead>
          <tbody id="reports-attr-body"></tbody>
        </table>
        <div id="reports-attr-empty" class="hidden text-tertiary" style="padding:12px">No jobs in this period</div>
        <div id="reports-attr-note" class="hidden text-tertiary" style="padding:12px"></div>
      </div>
    </div>
  </div>
</section>
`;

export const reportsScript = `
(function () {
  function pct(v) {
    return v == null ? '\u2014' : (v * 100).toFixed(1) + '%';
  }
  function fmtCost(v) {
    return v == null ? '\u2014' : '$' + v.toFixed(2);
  }
  function fmtPasses(v) {
    return v == null ? '\u2014' : v.toFixed(1);
  }

  function fmtLimit(l) {
    if (!l) return '\u2014';
    if (l.kind === 'timeout_ms') return window.esc(l.value + ' ms timeout');
    if (l.kind === 'max_turns') return window.esc(l.value + ' max turns');
    return window.esc(String(l.kind) + ' ' + String(l.value));
  }
  function fmtAttrUsage(u) {
    if (!u) return 'usage unavailable';
    return window.esc(String(u.availability));
  }
  function fmtAttrCost(u) {
    if (!u || u.costStatus !== 'reported' || u.costUsd == null) return 'unavailable';
    const c = '$' + Number(u.costUsd).toFixed(2);
    return u.availability === 'complete' ? c : window.esc(c) + ' (partial cost)';
  }
  function renderAttribution(jobs, note) {
    const body = document.getElementById('reports-attr-body');
    const empty = document.getElementById('reports-attr-empty');
    const noteEl = document.getElementById('reports-attr-note');
    const countEl = document.getElementById('reports-attr-count');
    body.innerHTML = '';
    noteEl.classList.add('hidden');
    empty.classList.add('hidden');
    if (note) {
      noteEl.textContent = note;
      noteEl.classList.remove('hidden');
    }
    if (!jobs || jobs.length === 0) {
      if (!note) empty.classList.remove('hidden');
      if (countEl) countEl.textContent = '(0 jobs)';
      return;
    }
    empty.classList.add('hidden');
    if (countEl) countEl.textContent = '(' + jobs.length + ' jobs)';
    for (const j of jobs) {
      const a = j.attribution;
      const tr = document.createElement('tr');
      const issue = '<td><span class="mono">' + window.esc(j.issueIdentifier || j.issueId || '') + '</span></td>';
      if (!a) {
        tr.innerHTML = issue + '<td colspan="7" class="text-tertiary">No attribution (legacy)</td>';
      } else {
        const u = a.usage;
        const cost = fmtAttrCost(u);
        tr.innerHTML = issue
          + '<td>' + window.esc(a.stage) + '</td>'
          + '<td><span class="mono">' + window.esc(a.agent + '/' + a.provider + '/' + a.model) + '</span></td>'
          + '<td>' + window.esc((a.profileId || 'no profile') + ' \u00b7 ' + a.authMode) + '</td>'
          + '<td>' + window.esc(a.outcome) + '</td>'
          + '<td>' + fmtLimit(a.limit) + '</td>'
          + '<td>' + fmtAttrUsage(u) + '</td>'
          + '<td>' + (cost === 'unavailable' ? 'unavailable' : cost) + '</td>';
      }
      body.appendChild(tr);
    }
  }
  async function loadAttribution(days) {
    try {
      const since = Date.now() - Number(days) * 86400000;
      const res = await window.api('/api/log?since=' + encodeURIComponent(String(since)));
      if (!res.ok) { renderAttribution([], 'Attribution unavailable (' + res.status + ')'); return; }
      renderAttribution(await res.json(), '');
    } catch (err) {
      console.error('loadAttribution failed:', err);
      renderAttribution([], 'Attribution unavailable');
    }
  }

  async function loadReports() {
    const daysEl = document.getElementById('reports-days');
    const days = daysEl ? daysEl.value : '30';
    await loadAttribution(days);
    try {
      const res = await window.api('/api/report?days=' + encodeURIComponent(days));
      if (!res.ok) { console.error('loadReports failed:', res.status); return; }
      const data = await res.json();

      const fleetBody = document.getElementById('reports-fleet-body');
      const fleetEmpty = document.getElementById('reports-fleet-empty');
      const countEl = document.getElementById('reports-repo-count');
      fleetBody.innerHTML = '';
      if (!data.byRepo || data.byRepo.length === 0) {
        fleetEmpty.classList.remove('hidden');
        if (countEl) countEl.textContent = '(0 repos)';
      } else {
        fleetEmpty.classList.add('hidden');
        if (countEl) countEl.textContent = '(' + data.byRepo.length + ' repos)';
        for (const r of data.byRepo) {
          const tr = document.createElement('tr');
          tr.innerHTML = '<td><span class="mono">' + window.esc(r.repo) + '</span></td>'
            + '<td>' + r.jobs + '</td>'
            + '<td>' + r.issues + '</td>'
            + '<td>' + r.completed + '</td>'
            + '<td>' + r.failed + '</td>'
            + '<td>' + r.merged + '</td>'
            + '<td>' + fmtPasses(r.avgPasses) + '</td>'
            + '<td>' + fmtCost(r.costUsd) + '</td>';
          fleetBody.appendChild(tr);
        }
      }

      const oneShotEl = document.getElementById('reports-oneshot');
      const eventualEl = document.getElementById('reports-eventual');
      const escapeEl = document.getElementById('reports-escape');
      if (oneShotEl) oneShotEl.textContent = pct(data.oneShotPct);
      if (eventualEl) eventualEl.textContent = pct(data.eventualPct);
      if (escapeEl) escapeEl.textContent = pct(data.escapeRate);

      const planningBody = document.getElementById('reports-planning-body');
      planningBody.innerHTML = '';
      const cohorts = [['Planned', data.planning && data.planning.planned], ['Unplanned', data.planning && data.planning.unplanned]];
      for (let i = 0; i < cohorts.length; i++) {
        const label = cohorts[i][0];
        const cohort = cohorts[i][1];
        if (!cohort) continue;
        const tr = document.createElement('tr');
        tr.innerHTML = '<td>' + window.esc(label) + '</td>'
          + '<td>' + cohort.jobs + '</td>'
          + '<td>' + pct(cohort.oneShotPct) + '</td>'
          + '<td>' + fmtPasses(cohort.avgPasses) + '</td>'
          + '<td>' + fmtCost(cohort.avgCostUsd) + '</td>'
          + '<td>' + pct(cohort.mergedPct) + '</td>';
        planningBody.appendChild(tr);
      }

      const runaBody = document.getElementById('reports-runaways-body');
      const runaEmpty = document.getElementById('reports-runaways-empty');
      runaBody.innerHTML = '';
      if (!data.runaways || data.runaways.length === 0) {
        runaEmpty.classList.remove('hidden');
      } else {
        runaEmpty.classList.add('hidden');
        for (const r of data.runaways) {
          const tr = document.createElement('tr');
          tr.innerHTML = '<td><a href="#runners" class="text-accent mono">' + window.esc(r.issueIdentifier) + '</a></td>'
            + '<td><span class="mono">' + window.esc(r.repo) + '</span></td>'
            + '<td>' + r.dispatches + '</td>'
            + '<td>' + r.consecutiveFailures + '</td>';
          runaBody.appendChild(tr);
        }
      }
    } catch (err) {
      console.error('loadReports failed:', err);
    }
  }

  window.loadReports = loadReports;

  window.registerPage('reports', function () {
    loadReports();
  });
})();
`;
