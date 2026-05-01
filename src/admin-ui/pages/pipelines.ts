export const pipelinesHtml = `
<section data-page="jobs" hidden>
  <header class="page-header">
    <div class="page-header-left">
      <h1 class="page-title">Pipelines</h1>
      <div class="page-subtitle">Recent dispatches — running pipelines appear at the top</div>
    </div>
    <div class="page-header-actions">
      <button class="btn btn-sm" onclick="loadLog()">&#8635; Refresh</button>
    </div>
  </header>
  <div class="page-body">
    <div class="card">
      <div class="card-header">
        <h2 class="card-title">Jobs</h2>
        <div class="card-subtitle"><span id="log-count">&mdash;</span> &middot; <span id="lu-log" class="text-tertiary"></span></div>
      </div>
      <div class="card-body tight">
        <table class="tbl">
          <thead><tr><th>Time</th><th>#</th><th>Issue</th><th>State</th><th>Team</th><th>Repo</th><th>Runner</th><th>Image</th><th>Status</th><th>PR</th></tr></thead>
          <tbody id="log-body"></tbody>
        </table>
        <div id="log-empty" class="hidden text-tertiary" style="padding:12px">No dispatches yet</div>
      </div>
    </div>
  </div>
</section>
`;

export const pipelinesScript = `
(function () {
  function setLastUpdated(id) {
    const el = document.getElementById(id);
    if (el) el.textContent = 'updated ' + new Date().toLocaleTimeString();
  }

  async function loadLog() {
    try {
      const res = await window.api('/api/log');
      const data = await res.json();
      const tbody = document.getElementById('log-body');
      const empty = document.getElementById('log-empty');
      const countEl = document.getElementById('log-count');
      tbody.innerHTML = '';
      if (data.length === 0) {
        empty.classList.remove('hidden');
        if (countEl) countEl.textContent = '0 jobs';
        setLastUpdated('lu-log');
        return;
      }
      empty.classList.add('hidden');

      const statusColors = {
        unknown: '#bdc3c7',
        dispatched: '#95a5a6',
        running: '#3498db',
        completed: '#2ecc71',
        failed: '#e74c3c',
        timed_out: '#f39c12'
      };
      const execColors = { gha: '#27ae60', fly: '#8e44ad', plan: '#2980b9' };

      function makeBadge(color, text) {
        return '<span class="badge" style="background:' + color + ';color:#fff">' + window.esc(text) + '</span>';
      }
      function statusBadge(status) {
        return makeBadge(statusColors[status] || '#95a5a6', status || 'dispatched');
      }
      function execBadge(mode, runnerMode) {
        const short = mode === 'fly-machines' ? 'fly' : mode === 'planning' ? 'plan' : 'gha';
        return makeBadge(execColors[short] || '#7f8c8d', short)
          + (short !== 'plan' && runnerMode ? ' <span style="color:#888;font-size:0.85em">(' + window.esc(runnerMode) + ')</span>' : '');
      }

      // Group planning + implement phases that belong to the same job:
      // a planning dispatch (dn=N) followed by an implement dispatch (dn=N+1) for the same issue.
      const consumed = new Set();
      const grouped = [];
      for (let i = 0; i < data.length; i++) {
        if (consumed.has(i)) continue;
        const e = data[i];
        if (e.executionMode !== 'planning') {
          const dn = e.dispatchNumber || 1;
          const planIdx = data.findIndex(function (p, j) {
            return !consumed.has(j) && j !== i &&
              p.issueId === e.issueId &&
              p.executionMode === 'planning' &&
              (p.dispatchNumber || 1) === dn - 1;
          });
          if (planIdx !== -1) {
            grouped.push({ type: 'group', plan: data[planIdx], impl: e });
            consumed.add(i);
            consumed.add(planIdx);
            continue;
          }
        }
        grouped.push({ type: 'single', entry: e });
        consumed.add(i);
      }

      if (countEl) countEl.textContent = grouped.length + ' job' + (grouped.length === 1 ? '' : 's');

      for (const item of grouped) {
        const tr = document.createElement('tr');
        tr.setAttribute('data-job-id', String(item.type === 'group' ? item.impl.id : item.entry.id));
        if (item.type === 'group') {
          const plan = item.plan;
          const impl = item.impl;
          const dt = new Date(plan.dispatchedAt).toLocaleString();
          const issueLabel = (impl.issueIdentifier || impl.issueId) + (impl.issueTitle ? ': ' + window.esc(impl.issueTitle) : '');
          const dn2 = plan.dispatchNumber || 1;
          const isRedispatch = dn2 > 1;
          if (isRedispatch) tr.style.backgroundColor = '#fff3cd';
          const dnBadge = isRedispatch
            ? '<span style="color:#d63384;font-weight:bold" title="Re-dispatch">' + dn2 + '</span>'
            : '' + dn2;
          const runnerCell = execBadge('planning') + ' <span style="color:#aaa">→</span> ' + execBadge(impl.executionMode, impl.runnerMode);
          const imageCell = impl.sessionImage
            ? '<td class="mono" title="' + window.esc(impl.sessionImage) + '">' + window.esc(impl.sessionImage.split('/').pop()) + '</td>'
            : '<td style="color:#aaa">—</td>';
          const combinedStatus = statusBadge(plan.status) + ' <span style="color:#aaa;font-size:0.8em">→</span> ' + statusBadge(impl.status);
          const prLink = impl.prUrl ? '<a href="' + window.esc(impl.prUrl) + '" target="_blank">View</a>' : '—';
          tr.innerHTML = '<td style="white-space:nowrap">' + dt + '</td>'
            + '<td style="text-align:center">' + dnBadge + '</td>'
            + '<td class="mono">' + issueLabel + '</td>'
            + '<td class="mono">' + window.esc(impl.issueState || '—') + '</td>'
            + '<td class="mono">' + window.esc(impl.teamKey || '—') + '</td>'
            + '<td class="mono">' + window.esc(impl.repo || '—') + '</td>'
            + '<td>' + runnerCell + '</td>'
            + imageCell
            + '<td>' + combinedStatus + '</td>'
            + '<td>' + prLink + '</td>';
        } else {
          const entry = item.entry;
          const dt = new Date(entry.dispatchedAt).toLocaleString();
          const issueLabel = (entry.issueIdentifier || entry.issueId) + (entry.issueTitle ? ': ' + window.esc(entry.issueTitle) : '');
          const dn3 = entry.dispatchNumber || 1;
          const isRedispatch = dn3 > 1;
          if (isRedispatch) tr.style.backgroundColor = '#fff3cd';
          const dnBadge = isRedispatch
            ? '<span style="color:#d63384;font-weight:bold" title="Re-dispatch">' + dn3 + '</span>'
            : '' + dn3;
          const runnerCell = execBadge(entry.executionMode, entry.runnerMode);
          const imageCell = entry.sessionImage
            ? '<td class="mono" title="' + window.esc(entry.sessionImage) + '">' + window.esc(entry.sessionImage.split('/').pop()) + '</td>'
            : '<td style="color:#aaa">—</td>';
          tr.innerHTML = '<td style="white-space:nowrap">' + dt + '</td>'
            + '<td style="text-align:center">' + dnBadge + '</td>'
            + '<td class="mono">' + issueLabel + '</td>'
            + '<td class="mono">' + window.esc(entry.issueState || '—') + '</td>'
            + '<td class="mono">' + window.esc(entry.teamKey || '—') + '</td>'
            + '<td class="mono">' + window.esc(entry.repo || '—') + '</td>'
            + '<td>' + runnerCell + '</td>'
            + imageCell
            + '<td>' + statusBadge(entry.status) + '</td>'
            + '<td>' + (entry.prUrl ? '<a href="' + window.esc(entry.prUrl) + '" target="_blank">View</a>' : '—') + '</td>';
        }
        tbody.appendChild(tr);
      }
      wireRowClicks();
      setLastUpdated('lu-log');
    } catch (err) {
      console.error('loadLog failed:', err);
    }
  }
  window.loadLog = loadLog;

  function wireRowClicks() {
    const tbody = document.getElementById('log-body');
    if (!tbody || tbody.dataset.drawerWired) return;
    tbody.addEventListener('click', function (e) {
      const target = e.target;
      if (target.closest('a')) return;
      const tr = target.closest('tr');
      const id = tr && tr.getAttribute('data-job-id');
      if (id && window.openJobDrawer) window.openJobDrawer(Number(id));
    });
    tbody.dataset.drawerWired = '1';
  }

  window.registerPage('jobs', function () {
    loadLog();
    wireRowClicks();
    setInterval(function () { loadLog(); }, 15000);
  });
})();
`;
