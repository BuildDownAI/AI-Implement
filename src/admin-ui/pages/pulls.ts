export const pullsHtml = `
<section data-page="pulls" hidden>
  <header class="page-header">
    <div class="page-header-left">
      <h1 class="page-title">Pull requests</h1>
      <div class="page-subtitle" id="pulls-subtitle">&mdash;</div>
    </div>
    <div class="page-header-actions">
      <button class="btn btn-sm" onclick="loadPulls()">&#8635; Refresh</button>
    </div>
  </header>
  <div class="page-body">
    <div id="pulls-error" class="alert fail" hidden></div>
    <div class="card">
      <div class="card-header">
        <h2 class="card-title">Bot-opened PRs</h2>
        <div class="card-subtitle"><span id="pulls-count">&mdash;</span></div>
      </div>
      <div class="card-body tight">
        <table class="tbl">
          <thead>
            <tr><th>PR</th><th>Issue</th><th>Repo</th><th>Status</th><th>Iter</th><th style="text-align:right">Last dispatch</th><th></th></tr>
          </thead>
          <tbody id="pulls-body"></tbody>
        </table>
        <div id="pulls-empty" class="hidden text-tertiary" style="padding:12px">No bot-opened pull requests yet.</div>
      </div>
    </div>
    <div class="alert info" style="margin-top:12px">
      <div style="flex:1">
        <div class="alert-title">CI / review state coming later</div>
        <div class="alert-desc">A future plan will fan out to GitHub for CI green/red, review status, and risk scoring. For now, click a PR to inspect status on GitHub.</div>
      </div>
    </div>
  </div>
</section>
`;

export const pullsScript = `
(function () {
  function fmtAgo(ts) {
    const diff = Date.now() - ts;
    const s = Math.floor(diff / 1000);
    if (s < 60) return s + 's ago';
    const m = Math.floor(s / 60);
    if (m < 60) return m + 'm ago';
    const h = Math.floor(m / 60);
    if (h < 24) return h + 'h ago';
    const d = Math.floor(h / 24);
    return d + 'd ago';
  }

  function statusBadgeKind(s) {
    if (s === 'running') return 'running';
    if (s === 'completed') return 'success';
    if (s === 'review_failed') return 'warn';
    if (s === 'failed') return 'fail';
    if (s === 'timed_out') return 'warn';
    return 'neutral';
  }

  function renderRows(pulls) {
    const countEl = document.getElementById('pulls-count');
    const emptyEl = document.getElementById('pulls-empty');
    const tbody = document.getElementById('pulls-body');
    if (countEl) countEl.textContent = pulls.length + ' tracked';
    if (emptyEl) {
      if (pulls.length === 0) {
        emptyEl.classList.remove('hidden');
      } else {
        emptyEl.classList.add('hidden');
      }
    }
    tbody.innerHTML = '';
    for (const pull of pulls) {
      const { prUrl, prNumber, issueIdentifier, issueTitle, repo, jobStatus, dispatchNumber, lastDispatchedAt } = pull;
      const kind = statusBadgeKind(jobStatus);
      const prCell = '<a class="text-accent mono" href="' + window.esc(prUrl) + '" target="_blank">#' + (prNumber != null ? prNumber : '?') + '</a>';
      let issueCell;
      if (issueIdentifier) {
        issueCell = '<a class="text-accent" href="https://linear.app/issue/' + window.esc(issueIdentifier) + '" target="_blank"><span class="mono text-secondary">' + window.esc(issueIdentifier) + '</span> <span>' + window.esc(issueTitle || '') + '</span></a>';
      } else {
        issueCell = '<span class="text-tertiary">&mdash;</span>';
      }
      const repoCell = '<span class="mono">' + (repo ? window.esc(repo) : '&mdash;') + '</span>';
      const statusLabel = jobStatus === 'review_failed' ? 'review failed' : jobStatus;
      const statusCell = '<span class="badge ' + kind + '"><span class="dot"></span>' + window.esc(statusLabel) + '</span>';
      const iterCell = '<span class="mono' + (dispatchNumber > 1 ? ' text-secondary' : '') + '">' + dispatchNumber + '</span>';
      const lastCell = '<td style="text-align:right" class="mono text-tertiary">' + fmtAgo(lastDispatchedAt) + '</td>';
      const actionCell = '<a class="text-accent" href="' + window.esc(prUrl) + '" target="_blank">Open &#8599;</a>';
      const tr = document.createElement('tr');
      tr.innerHTML = '<td>' + prCell + '</td>'
        + '<td>' + issueCell + '</td>'
        + '<td>' + repoCell + '</td>'
        + '<td>' + statusCell + '</td>'
        + '<td>' + iterCell + '</td>'
        + lastCell
        + '<td>' + actionCell + '</td>';
      tbody.appendChild(tr);
    }
  }

  async function loadPulls() {
    const errorEl = document.getElementById('pulls-error');
    const subtitleEl = document.getElementById('pulls-subtitle');
    const countEl = document.getElementById('pulls-count');
    const tbody = document.getElementById('pulls-body');
    if (errorEl) errorEl.hidden = true;
    const res = await window.api('/api/pulls');
    if (!res.ok) {
      let msg = 'HTTP ' + res.status;
      try {
        const errBody = await res.json();
        if (errBody && errBody.error) msg = errBody.error;
      } catch (_) { /* ignore */ }
      if (errorEl) {
        errorEl.innerHTML = '<div style="flex:1"><div class="alert-title">Failed to load pull requests</div><div class="alert-desc">' + window.esc(msg) + '</div></div>';
        errorEl.hidden = false;
      }
      if (tbody) tbody.innerHTML = '';
      const emptyEl = document.getElementById('pulls-empty');
      if (emptyEl) emptyEl.classList.add('hidden');
      if (countEl) countEl.textContent = '\\u2014';
      if (subtitleEl) subtitleEl.textContent = '\\u2014';
      return;
    }
    const data = await res.json();
    const pulls = data.pulls || [];
    renderRows(pulls);
    if (subtitleEl) subtitleEl.textContent = pulls.length + ' tracked';
  }

  window.loadPulls = loadPulls;

  window.registerPage('pulls', function () { loadPulls(); setInterval(loadPulls, 30000); });
})();
`;
