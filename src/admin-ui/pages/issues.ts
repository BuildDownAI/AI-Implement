export const issuesHtml = `
<section data-page="issues" hidden>
  <header class="page-header">
    <div class="page-header-left">
      <h1 class="page-title">Issues</h1>
      <div class="page-subtitle" id="issues-subtitle">—</div>
    </div>
    <div class="page-header-actions">
      <button class="btn btn-sm" onclick="loadIssues()">↻ Refresh</button>
    </div>
  </header>
  <div class="page-body">
    <div id="issues-error" class="alert fail" hidden></div>

    <div class="card">
      <div class="card-header">
        <h2 class="card-title">Inbox</h2>
        <div class="card-subtitle"><span id="issues-count">—</span></div>
      </div>
      <div class="card-body tight">
        <table class="tbl">
          <thead><tr><th>Issue</th><th>Team</th><th>State</th><th>Plan</th><th></th></tr></thead>
          <tbody id="issues-body"></tbody>
        </table>
        <div id="issues-empty" class="hidden text-tertiary" style="padding:12px">No AI-Implement labeled issues found in Linear.</div>
      </div>
    </div>

    <div class="card">
      <div class="card-header"><h2 class="card-title">In progress by team</h2></div>
      <div class="card-body tight">
        <table class="tbl">
          <thead><tr><th>Team</th><th style="text-align:right">Currently implementing</th></tr></thead>
          <tbody id="issues-progress-body"></tbody>
        </table>
        <div id="issues-progress-empty" class="hidden text-tertiary" style="padding:12px">No teams currently working.</div>
      </div>
    </div>
  </div>
</section>
`;

export const issuesScript = `
(function () {
  function stateBadgeKind(stateType) {
    if (stateType === 'started') return 'running';
    if (stateType === 'completed') return 'success';
    if (stateType === 'cancelled') return 'warn';
    return 'neutral';
  }

  function renderInbox(issues) {
    const countEl = document.getElementById('issues-count');
    const tbody = document.getElementById('issues-body');
    const emptyEl = document.getElementById('issues-empty');
    countEl.textContent = issues.length + ' matched';
    tbody.innerHTML = '';
    if (issues.length === 0) {
      emptyEl.classList.remove('hidden');
      tbody.closest('table').style.display = 'none';
      return;
    }
    emptyEl.classList.add('hidden');
    tbody.closest('table').style.display = '';
    for (const issue of issues) {
      const tr = document.createElement('tr');
      const stateKind = stateBadgeKind(issue.stateType);
      const planBadge = issue.bucket === 'ready'
        ? '<span class="badge success"><span class="dot"></span>Ready</span>'
        : '<span class="badge info"><span class="dot"></span>Plan pending</span>';
      tr.innerHTML = '<td><span class="mono">' + window.esc(issue.identifier) + '</span> ' + window.esc(issue.title) + '</td>'
        + '<td><span class="mono">' + window.esc(issue.teamKey) + '</span></td>'
        + '<td><span class="badge ' + stateKind + '">' + window.esc(issue.stateName) + '</span></td>'
        + '<td>' + planBadge + '</td>'
        + '<td><a class="text-accent" href="https://linear.app/issue/' + window.esc(issue.identifier) + '" target="_blank">Open ↗</a></td>';
      tbody.appendChild(tr);
    }
  }

  function renderProgress(counts) {
    const tbody = document.getElementById('issues-progress-body');
    const emptyEl = document.getElementById('issues-progress-empty');
    tbody.innerHTML = '';
    const entries = Object.entries(counts).filter(function (pair) { return pair[1] > 0; });
    entries.sort(function (a, b) { return a[0].localeCompare(b[0]); });
    if (entries.length === 0) {
      emptyEl.classList.remove('hidden');
      tbody.closest('table').style.display = 'none';
      return;
    }
    emptyEl.classList.add('hidden');
    tbody.closest('table').style.display = '';
    for (const pair of entries) {
      const teamKey = pair[0];
      const count = pair[1];
      const tr = document.createElement('tr');
      tr.innerHTML = '<td class="mono">' + window.esc(teamKey) + '</td>'
        + '<td style="text-align:right" class="mono text-secondary">' + count + '</td>';
      tbody.appendChild(tr);
    }
  }

  function renderSubtitle(issues, counts) {
    const inProgress = Object.values(counts).reduce(function (a, b) { return a + b; }, 0);
    const el = document.getElementById('issues-subtitle');
    if (el) el.textContent = issues.length + ' matched \xb7 ' + inProgress + ' currently implementing';
  }

  async function loadIssues() {
    const errorEl = document.getElementById('issues-error');
    errorEl.hidden = true;
    const res = await window.api('/api/linear/issues');
    if (!res.ok) {
      let errorMsg = 'Unknown error';
      try {
        const errBody = await res.json();
        errorMsg = errBody.error || errorMsg;
      } catch (_) { /* ignore parse errors */ }
      errorEl.innerHTML = '<div style="flex:1"><div class="alert-title">Failed to load Linear issues</div><div class="alert-desc">' + window.esc(errorMsg) + '</div></div>';
      errorEl.hidden = false;
      document.getElementById('issues-body').innerHTML = '';
      document.getElementById('issues-progress-body').innerHTML = '';
      document.getElementById('issues-count').textContent = '—';
      document.getElementById('issues-subtitle').textContent = '—';
      return;
    }
    const data = await res.json();
    renderInbox(data.issues);
    renderProgress(data.inProgressCountsByTeam);
    renderSubtitle(data.issues, data.inProgressCountsByTeam);
  }

  window.loadIssues = loadIssues;
  window.registerPage('issues', function () { loadIssues(); setInterval(loadIssues, 60000); });
}());
`;
