export const reaperHtml = `
<section data-page="reaper" hidden>
  <header class="page-header">
    <div class="page-header-left">
      <h1 class="page-title">Reaper</h1>
      <div class="page-subtitle">Reconciliation sweep &#x2014; destroys orphaned machines and stale jobs</div>
    </div>
    <div class="page-header-actions">
      <button class="btn btn-sm" onclick="window.loadReaper();">&#8635; Refresh</button>
    </div>
  </header>
  <div class="page-body">
    <div id="reaper-mode-banner" class="alert" hidden></div>

    <p class="text-secondary" style="font-size:13px">Runner mode controls have moved to the <a href="#runners" class="text-accent">Runners page</a>.</p>

    <div class="card">
      <div class="card-header">
        <h2 class="card-title">Sweep summary</h2>
        <div class="card-subtitle" id="reaper-status-line">&#x2014;</div>
      </div>
      <div class="card-body">
        <div id="reaper-summary-block"></div>
      </div>
    </div>

    <div class="card">
      <div class="card-header"><h2 class="card-title">Recent actions</h2><div class="card-subtitle"><span id="reaper-count">&#x2014;</span></div></div>
      <div class="card-body tight">
        <table class="tbl">
          <thead><tr><th>Time</th><th>Rule</th><th>Machine</th><th>Tenant</th><th>Issue</th><th>Age (s)</th><th>Mode</th></tr></thead>
          <tbody id="reaper-body"></tbody>
        </table>
        <div id="reaper-empty" class="hidden text-tertiary" style="padding:12px">No reaper actions recorded</div>
      </div>
    </div>
  </div>
</section>
`;

export const reaperScript = `
(function () {
  function setLastUpdated(id) {
    const el = document.getElementById(id);
    if (el) el.textContent = 'updated ' + new Date().toLocaleTimeString();
  }

  function fmtAgo(ts) {
    const s = Math.floor((Date.now() - ts) / 1000);
    if (s < 60) return s + 's ago';
    const m = Math.floor(s / 60);
    if (m < 60) return m + 'm ago';
    const h = Math.floor(m / 60);
    return h + 'h ago';
  }

  async function loadReaper() {
    try {
      const [summaryRes, recentRes] = await Promise.all([
        window.api('/api/reaper/summary'),
        window.api('/api/reaper/recent?limit=20'),
      ]);
      const summary = await summaryRes.json();
      const recent = await recentRes.json();
      renderReaper(summary, recent);
      const countEl = document.getElementById('reaper-count');
      if (countEl) countEl.textContent = '(' + (Array.isArray(recent) ? recent.length : 0) + ')';

      // Derive the dry-run banner from recent events
      const banner = document.getElementById('reaper-mode-banner');
      if (!recent || recent.length === 0) {
        banner.className = 'alert info';
        banner.textContent = 'No reaper sweeps in the last 24h.';
        banner.hidden = false;
        return;
      }
      const allDry = recent.every(function (r) { return r.dryRun; });
      banner.hidden = false;
      if (allDry) {
        banner.className = 'alert warn';
        banner.innerHTML = '<div class="alert-title">DRY-RUN MODE</div><div class="alert-desc">' + recent.length + ' recent reaps logged but not executed.</div>';
      } else {
        banner.className = 'alert info';
        banner.innerHTML = '<div class="alert-title">LIVE MODE</div><div class="alert-desc">Reaper destroys machines for real. ' + (summary.total24h || 0) + ' destroyed in the last 24h.</div>';
      }
    } catch (err) {
      console.error('loadReaper failed:', err);
    }
  }

  function renderReaper(summary, recent) {
    const statusEl = document.getElementById('reaper-status-line');
    if (statusEl) {
      const count = summary.total24h != null ? summary.total24h : 0;
      const lastSweepStr = summary.lastSweepAt ? fmtAgo(summary.lastSweepAt) : 'never';
      statusEl.textContent = 'Reaper: ' + count + ' destroyed in last 24h · last sweep ' + lastSweepStr;
    }

    const summaryEl = document.getElementById('reaper-summary-block');
    if (summaryEl) {
      const byRule = summary.byRule || {};
      const rules = ['orphan', 'stale-terminal-job', 'max-age-exceeded', 'issue-terminal'];
      let html = '<div style="display:flex;gap:20px;flex-wrap:wrap;font-size:0.9em">';
      html += '<span><b>24h total: ' + (summary.total24h != null ? summary.total24h : 0) + '</b></span>';
      for (const rule of rules) {
        html += '<span style="color:#555">' + window.esc(rule) + ': <b>' + (byRule[rule] || 0) + '</b></span>';
      }
      html += '</div>';
      summaryEl.innerHTML = html;
    }

    const tbody = document.getElementById('reaper-body');
    const empty = document.getElementById('reaper-empty');
    if (!tbody || !empty) return;
    tbody.innerHTML = '';
    if (!Array.isArray(recent) || recent.length === 0) {
      empty.classList.remove('hidden');
      setLastUpdated('lu-reaper');
      return;
    }
    empty.classList.add('hidden');
    for (const r of recent) {
      const tr = document.createElement('tr');
      if (r.dryRun) tr.style.backgroundColor = '#f8f9fa';
      const dt = new Date(r.createdAt).toLocaleString();
      const modeBadge = r.dryRun
        ? '<span class="badge" style="background:#6c757d;color:#fff">dry-run</span>'
        : '<span class="badge" style="background:#e74c3c;color:#fff">destroyed</span>';
      tr.innerHTML = '<td style="white-space:nowrap">' + dt + '</td>'
        + '<td class="mono">' + window.esc(r.ruleMatched) + '</td>'
        + '<td class="mono" title="' + window.escAttr(r.machineId) + '">' + window.esc(r.machineId.slice(0, 12)) + '</td>'
        + '<td class="mono">' + window.esc(r.tenantId || '—') + '</td>'
        + '<td class="mono">' + window.esc(r.issueIdentifier || '—') + '</td>'
        + '<td>' + (r.ageSeconds != null ? r.ageSeconds : '—') + '</td>'
        + '<td>' + modeBadge + '</td>';
      tbody.appendChild(tr);
    }
    setLastUpdated('lu-reaper');
  }

  window.loadReaper = loadReaper;

  window.registerPage('reaper', function () {
    loadReaper();
  });
})();
`;
