export const pipelinesHtml = `
<section data-page="jobs" hidden>
  <header class="page-header">
    <div class="page-header-left">
      <h1 class="page-title">Pipelines</h1>
      <div class="page-subtitle">Recent dispatches — running pipelines appear at the top</div>
    </div>
    <div class="page-header-actions" style="display:flex;align-items:stretch;gap:8px;flex-wrap:wrap">
      <fieldset style="border:1px solid var(--border);border-radius:6px;padding:2px 10px 6px;margin:0;display:flex;align-items:center;gap:6px">
        <legend style="font-size:0.7em;color:var(--fg-tertiary);padding:0 4px;margin-left:2px">Time Filter</legend>
        <select id="log-time-type" class="select" style="width:auto;height:30px" onchange="onTimeTypeChange()">
          <option value="relative">Relative</option>
          <option value="range">Time range</option>
        </select>
        <div id="log-rel-controls" style="display:flex;align-items:center;gap:4px">
          <input id="log-rel-n" type="number" class="input" style="width:58px;height:30px;padding:0 7px" min="1" max="999" value="7" onchange="loadLog()">
          <select id="log-rel-unit" class="select" style="width:auto;height:30px" onchange="loadLog()">
            <option value="h">h</option>
            <option value="d" selected>d</option>
            <option value="w">w</option>
          </select>
        </div>
        <div id="log-range-controls" style="display:none;align-items:center;gap:4px">
          <input id="log-range-start" type="datetime-local" class="input" style="width:175px;height:30px;padding:0 7px" onchange="loadLog()">
          <span style="color:var(--fg-tertiary)">&#8594;</span>
          <input id="log-range-end" type="datetime-local" class="input" style="width:175px;height:30px;padding:0 7px" onchange="loadLog()">
        </div>
      </fieldset>
      <button class="btn btn-sm" onclick="loadLog()" style="height:30px;align-self:flex-end;padding:0 12px;margin-bottom:6px">&#8635; Refresh</button>
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

  function getTimeFilter() {
    const type = document.getElementById('log-time-type').value;
    if (type === 'relative') {
      const n = parseInt(document.getElementById('log-rel-n').value, 10) || 7;
      const unit = document.getElementById('log-rel-unit').value;
      const ms = { h: 3600000, d: 86400000, w: 604800000 };
      return '?since=' + (Date.now() - n * (ms[unit] || ms.d));
    }
    const start = document.getElementById('log-range-start').value;
    const end   = document.getElementById('log-range-end').value;
    const parts = [];
    if (start) parts.push('since=' + new Date(start).getTime());
    if (end)   parts.push('until=' + new Date(end).getTime());
    return parts.length ? '?' + parts.join('&') : '';
  }

  function getFilterLabel() {
    const type = document.getElementById('log-time-type').value;
    if (type === 'relative') {
      const n = parseInt(document.getElementById('log-rel-n').value, 10) || 7;
      const unit = document.getElementById('log-rel-unit').value;
      return 'last ' + n + unit;
    }
    const start = document.getElementById('log-range-start').value;
    const end   = document.getElementById('log-range-end').value;
    if (start && end) return new Date(start).toLocaleDateString() + ' → ' + new Date(end).toLocaleDateString();
    if (start)        return 'from ' + new Date(start).toLocaleDateString();
    if (end)          return 'until ' + new Date(end).toLocaleDateString();
    return 'all time';
  }

  let _logRefreshInterval = null;

  function startLogAutoRefresh() {
    if (_logRefreshInterval) return;
    _logRefreshInterval = setInterval(function () { loadLog(); }, 15000);
  }

  function stopLogAutoRefresh() {
    if (_logRefreshInterval) { clearInterval(_logRefreshInterval); _logRefreshInterval = null; }
  }

  function onTimeTypeChange() {
    const rel   = document.getElementById('log-rel-controls');
    const range = document.getElementById('log-range-controls');
    const isRange = document.getElementById('log-time-type').value === 'range';
    rel.style.display   = isRange ? 'none' : 'flex';
    range.style.display = isRange ? 'flex' : 'none';
    if (isRange) { stopLogAutoRefresh(); } else { startLogAutoRefresh(); }
    loadLog();
  }
  window.onTimeTypeChange = onTimeTypeChange;

  async function loadLog() {
    try {
      const res = await window.api('/api/log' + getTimeFilter());
      const data = await res.json();
      const tbody = document.getElementById('log-body');
      const empty = document.getElementById('log-empty');
      const countEl = document.getElementById('log-count');
      tbody.innerHTML = '';
      if (data.length === 0) {
        empty.textContent = 'No jobs in the selected time range';
        empty.classList.remove('hidden');
        if (countEl) countEl.textContent = '0 jobs · ' + getFilterLabel();
        setLastUpdated('lu-log');
        return;
      }
      empty.classList.add('hidden');

      const statusClass = {
        unknown: 'neutral',
        dispatched: 'neutral',
        running: 'running',
        completed: 'success',
        review_failed: 'warn',
        failed: 'fail',
        'dispatch-failed': 'fail',
        timed_out: 'warn'
      };

      function makeBadge(cls, text) {
        return '<span class="badge tight ' + cls + '">' + window.esc(text) + '</span>';
      }
      function statusBadge(status) {
        const label = status === 'review_failed' ? 'review failed' : (status || 'dispatched');
        return makeBadge(statusClass[status] || 'neutral', label);
      }
      function execBadge(mode, runnerMode) {
        const short = mode === 'fly-machines' ? 'fly' : 'gha';
        const cls = short === 'fly' ? 'info' : 'neutral';
        return makeBadge(cls, short)
          + (runnerMode ? ' <span style="color:var(--fg-tertiary);font-size:0.85em">(' + window.esc(runnerMode) + ')</span>' : '');
      }
      function phaseBadge(phase) {
        if (phase === 'planning') return makeBadge('info', 'plan');
        if (phase === 'kg-refresh') return makeBadge('info', 'kg');
        return makeBadge('neutral', 'impl');
      }

      // Group planning + implement phases that belong to the same job:
      // a planning dispatch (dn=N) followed by an implement dispatch (dn=N+1) for the same issue.
      const consumed = new Set();
      const grouped = [];
      for (let i = 0; i < data.length; i++) {
        if (consumed.has(i)) continue;
        const e = data[i];
        if (e.phase !== 'planning') {
          const dn = e.dispatchNumber || 1;
          const planIdx = data.findIndex(function (p, j) {
            return !consumed.has(j) && j !== i &&
              p.issueId === e.issueId &&
              p.phase === 'planning' &&
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

      if (countEl) countEl.textContent = grouped.length + ' job' + (grouped.length === 1 ? '' : 's') + ' · ' + getFilterLabel();

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
          if (isRedispatch) tr.classList.add('redispatch-row');
          const dnBadge = isRedispatch
            ? '<span style="color:#d63384;font-weight:bold" title="Re-dispatch">' + dn2 + '</span>'
            : '' + dn2;
          const runnerCell = phaseBadge(plan.phase) + ' ' + execBadge(plan.executionMode, null) + ' <span style="color:#aaa">→</span> ' + phaseBadge(impl.phase) + ' ' + execBadge(impl.executionMode, impl.runnerMode);
          const imageCell = impl.sessionImage
            ? '<td class="mono" title="' + window.escAttr(impl.sessionImage) + '">' + window.esc(impl.sessionImage.split('/').pop()) + '</td>'
            : '<td style="color:#aaa">—</td>';
          // A grouped row exists only when an implement dispatch followed this plan,
          // which requires plan approval — so a plan row stranded in a non-terminal
          // status (e.g. 'unknown' after an orchestrator restart) is known-completed.
          const planStatus = (plan.status === 'unknown' || plan.status === 'dispatched' || plan.status === 'running')
            ? 'completed' : plan.status;
          const combinedStatus = statusBadge(planStatus) + ' <span style="color:#aaa;font-size:0.8em">→</span> ' + statusBadge(impl.status);
          const prLink = impl.prUrl ? '<a href="' + window.safeUrl(impl.prUrl) + '" target="_blank">View</a>' : '—';
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
          if (isRedispatch) tr.classList.add('redispatch-row');
          const dnBadge = isRedispatch
            ? '<span style="color:#d63384;font-weight:bold" title="Re-dispatch">' + dn3 + '</span>'
            : '' + dn3;
          const runnerCell = phaseBadge(entry.phase) + ' ' + execBadge(entry.executionMode, entry.runnerMode);
          const imageCell = entry.sessionImage
            ? '<td class="mono" title="' + window.escAttr(entry.sessionImage) + '">' + window.esc(entry.sessionImage.split('/').pop()) + '</td>'
            : '<td style="color:#aaa">—</td>';
          let logCell;
          if (entry.machineId) {
            const btnText = entry.phase === 'kg-refresh' ? 'Logs \u2197' : 'Logs';
            logCell = '<button data-machine-id="' + window.escAttr(entry.machineId) + '" style="background:none;border:none;cursor:pointer;padding:0;color:var(--accent);font:inherit">' + btnText + '</button>';
          } else if (entry.prUrl) {
            logCell = '<a href="' + window.safeUrl(entry.prUrl) + '" target="_blank">View</a>';
          } else {
            logCell = '—';
          }
          tr.innerHTML = '<td style="white-space:nowrap">' + dt + '</td>'
            + '<td style="text-align:center">' + dnBadge + '</td>'
            + '<td class="mono">' + issueLabel + '</td>'
            + '<td class="mono">' + window.esc(entry.issueState || '—') + '</td>'
            + '<td class="mono">' + window.esc(entry.teamKey || '—') + '</td>'
            + '<td class="mono">' + window.esc(entry.repo || '—') + '</td>'
            + '<td>' + runnerCell + '</td>'
            + imageCell
            + '<td>' + statusBadge(entry.status) + '</td>'
            + '<td>' + logCell + '</td>';
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

  async function viewMachineLogs(machineId) {
    const dialog = document.createElement('dialog');
    dialog.style.cssText = 'width:80vw;max-width:900px;max-height:80vh;overflow:auto;padding:0;border:1px solid var(--border-default);border-radius:8px;background:var(--bg-elev)';
    dialog.innerHTML = '<div style="padding:16px 20px;border-bottom:1px solid var(--border-default);display:flex;justify-content:space-between;align-items:center">'
      + '<strong>Machine Logs \u2014 ' + window.esc(machineId) + '</strong>'
      + '<button onclick="this.closest(\'dialog\').close()" style="background:none;border:none;cursor:pointer;font-size:1.2em;color:var(--fg-secondary)">\u00d7</button>'
      + '</div>'
      + '<pre class="ml-content" style="margin:0;padding:16px;font-size:0.8em;white-space:pre-wrap;word-break:break-all;color:var(--fg-primary)">Loading\u2026</pre>';
    document.body.appendChild(dialog);
    dialog.showModal();
    dialog.addEventListener('close', function () { dialog.remove(); });
    try {
      const r = await window.api('/api/sessions/' + encodeURIComponent(machineId) + '/logs');
      const body = await r.json();
      const el = dialog.querySelector('.ml-content');
      if (!el) return;
      if (r.status === 200) {
        el.textContent = body.logs || '(no output)';
      } else if (r.status === 404) {
        el.textContent = 'Logs no longer available.';
      } else {
        el.textContent = 'Error: ' + (body.error || 'unknown error');
      }
    } catch (err) {
      const el = dialog.querySelector('.ml-content');
      if (el) el.textContent = 'Failed to fetch logs: ' + String(err);
    }
  }

  function wireRowClicks() {
    // The job drawer reads the job-steps and mapping endpoints, both Admin-only, so opening it as a
    // user could only ever report failure. The table itself is the granted read and works.
    if (!window.isAdmin()) return;
    const tbody = document.getElementById('log-body');
    if (!tbody || tbody.dataset.drawerWired) return;
    tbody.addEventListener('click', function (e) {
      const target = e.target;
      if (target.closest('a')) return;
      const logsBtn = target.closest('[data-machine-id]');
      if (logsBtn) {
        viewMachineLogs(logsBtn.getAttribute('data-machine-id'));
        return;
      }
      const tr = target.closest('tr');
      const id = tr && tr.getAttribute('data-job-id');
      if (id && window.openJobDrawer) window.openJobDrawer(Number(id));
    });
    tbody.dataset.drawerWired = '1';
  }

  window.registerPage('jobs', function () {
    loadLog();
    wireRowClicks();
    startLogAutoRefresh();
  });
})();
`;
