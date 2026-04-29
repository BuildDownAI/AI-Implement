export const overviewHtml = `
<section data-page="overview" hidden>
  <header class="page-header">
    <div class="page-header-left">
      <h1 class="page-title">Overview</h1>
      <div class="page-subtitle" id="overview-subtitle">&mdash;</div>
    </div>
    <div class="page-header-actions">
      <button class="btn btn-sm" onclick="loadOverview()">&#8635; Refresh</button>
    </div>
  </header>
  <div class="page-body">

    <!-- KPI grid -->
    <div class="kpi-grid">
      <div class="kpi" id="kpi-running">
        <div class="kpi-label">Running now</div>
        <div class="kpi-value"><span id="kpi-running-value">0</span></div>
        <div style="display:flex;align-items:center;justify-content:space-between;gap:8px">
          <span class="kpi-trend" id="kpi-running-sub">across 0 teams</span>
          <div class="spark" data-spark="dispatch24h" style="width:80px" id="kpi-spark"></div>
        </div>
      </div>
      <div class="kpi" id="kpi-capacity">
        <div class="kpi-label">Capacity used</div>
        <div class="kpi-value">
          <span id="kpi-capacity-value">0</span><span class="kpi-unit" id="kpi-capacity-unit">/ 0</span>
        </div>
        <span class="kpi-trend" id="kpi-capacity-sub">0% of total slots</span>
      </div>
      <div class="kpi" id="kpi-blocked">
        <div class="kpi-label">Blocked</div>
        <div class="kpi-value"><span id="kpi-blocked-value">0</span></div>
        <span class="kpi-trend" id="kpi-blocked-sub">at concurrency cap</span>
      </div>
      <div class="kpi" id="kpi-failed">
        <div class="kpi-label">Failed (24h)</div>
        <div class="kpi-value"><span id="kpi-failed-value">0</span></div>
        <span class="kpi-trend" id="kpi-failed-sub">in last 24h</span>
      </div>
    </div>

    <!-- Two-up: Running now + At capacity -->
    <div style="display:grid;grid-template-columns:1.5fr 1fr;gap:16px">
      <div class="card">
        <div class="card-header">
          <div>
            <h2 class="card-title">Running now</h2>
            <div class="card-subtitle" id="overview-running-subtitle">0 jobs</div>
          </div>
          <button class="btn btn-ghost btn-sm" onclick="window.navigate('jobs')">View all</button>
        </div>
        <div class="card-body tight">
          <table class="tbl">
            <thead><tr><th>Issue</th><th>Phase</th><th style="text-align:right">Duration</th></tr></thead>
            <tbody id="overview-running-body"></tbody>
          </table>
          <div id="overview-running-empty" class="hidden text-tertiary" style="padding:12px">No jobs in flight</div>
        </div>
      </div>

      <div class="card">
        <div class="card-header">
          <div>
            <h2 class="card-title">Why isn&rsquo;t this running?</h2>
            <div class="card-subtitle">Full blocker taxonomy on Plan 4 &mdash; Blockers page</div>
          </div>
        </div>
        <div class="card-body">
          <div id="overview-atcap-body" style="display:flex;flex-direction:column;gap:8px"></div>
          <div id="overview-atcap-empty" class="hidden text-tertiary" style="padding:4px 0">All projects have available capacity.</div>
        </div>
      </div>
    </div>

    <!-- Recent failures -->
    <div class="card">
      <div class="card-header">
        <div>
          <h2 class="card-title">Recent failures</h2>
          <div class="card-subtitle">Last 8 failures in the past 24h</div>
        </div>
        <button class="btn btn-ghost btn-sm" onclick="window.navigate('jobs')">All jobs</button>
      </div>
      <div class="card-body tight">
        <table class="tbl">
          <thead><tr><th>Issue</th><th>Failed at</th><th>Summary</th><th style="text-align:right">When</th></tr></thead>
          <tbody id="overview-failures-body"></tbody>
        </table>
        <div id="overview-failures-empty" class="hidden text-tertiary" style="padding:12px">No failures in the last 24h</div>
      </div>
    </div>

    <!-- Project capacity grid -->
    <div class="card">
      <div class="card-header">
        <div>
          <h2 class="card-title">Project capacity</h2>
          <div class="card-subtitle">Concurrency caps and current utilization per project</div>
        </div>
        <button class="btn btn-ghost btn-sm" onclick="window.navigate('projects')">Manage</button>
      </div>
      <div class="card-body tight">
        <table class="tbl">
          <thead><tr><th>Project</th><th>Repo</th><th>Runner</th><th>Provider</th><th>Utilization</th><th style="text-align:right">Queued</th></tr></thead>
          <tbody id="overview-projects-body"></tbody>
        </table>
        <div id="overview-projects-empty" class="hidden text-tertiary" style="padding:12px">No projects configured</div>
      </div>
    </div>

  </div>
</section>
`;

export const overviewScript = `
(function () {
  function fmtAgo(ts) {
    const s = Math.floor((Date.now() - new Date(ts).getTime()) / 1000);
    if (s < 60) return s + 's ago';
    const m = Math.floor(s / 60);
    if (m < 60) return m + 'm ago';
    const h = Math.floor(m / 60);
    return h + 'h ago';
  }

  function fmtDuration(ms) {
    const s = Math.floor(ms / 1000);
    if (s < 60) return s + 's';
    const m = Math.floor(s / 60);
    if (m < 60) return m + 'm ' + (s % 60) + 's';
    const h = Math.floor(m / 60);
    return h + 'h ' + (m % 60) + 'm';
  }

  function sparkline(values) {
    if (!values || values.length === 0) {
      return '<div class="text-tertiary" style="font-size:11px">no data</div>';
    }
    const max = Math.max(...values, 1);
    const h = 24;
    const w = Math.floor(80 / values.length);
    const bars = values.map(function (v) {
      const barH = Math.max(2, Math.round((v / max) * h));
      return '<rect x="0" y="' + (h - barH) + '" width="' + (w - 1) + '" height="' + barH + '" fill="var(--accent)" opacity="0.7"/>';
    });
    const svgW = w * values.length;
    return '<svg width="' + svgW + '" height="' + h + '" viewBox="0 0 ' + svgW + ' ' + h + '" style="display:block">'
      + bars.map(function (b, i) { return '<g transform="translate(' + (i * w) + ',0)">' + b + '</g>'; }).join('')
      + '</svg>';
  }

  function capacityMeter(used, max) {
    const pct = max > 0 ? Math.round((used / max) * 100) : 0;
    const color = pct >= 100 ? 'var(--red)' : pct >= 75 ? 'var(--yellow)' : 'var(--green, var(--accent))';
    return '<div style="display:flex;align-items:center;gap:8px">'
      + '<div style="flex:1;height:6px;background:var(--border-subtle);border-radius:3px;overflow:hidden">'
      + '<div style="width:' + Math.min(pct, 100) + '%;height:100%;background:' + color + ';border-radius:3px"></div>'
      + '</div>'
      + '<span class="mono text-secondary" style="font-size:11px;white-space:nowrap">' + used + '/' + max + '</span>'
      + '</div>';
  }

  function statusBadge(status) {
    const map = { running: 'running', failed: 'fail', completed: 'success' };
    const kind = map[status] || 'neutral';
    return '<span class="badge ' + kind + '">' + window.esc(status) + '</span>';
  }

  function dispatch24hBuckets(log) {
    const now = Date.now();
    const buckets = new Array(24).fill(0);
    for (const e of log) {
      const ts = new Date(e.dispatchedAt).getTime();
      const age = now - ts;
      if (age < 0 || age >= 86400000) continue;
      const bucket = Math.floor(age / 3600000);
      buckets[23 - bucket]++;
    }
    return buckets;
  }

  function renderHeaderSubtitle(reaper) {
    const el = document.getElementById('overview-subtitle');
    if (!el) return;
    el.textContent = 'last sweep ' + (reaper.lastSweepAt ? fmtAgo(reaper.lastSweepAt) : 'never');
  }

  function renderKpis(log, mappings, running) {
    const now = Date.now();
    const failed24h = log.filter(function (e) {
      return e.status === 'failed' && (now - new Date(e.dispatchedAt).getTime()) < 86400000;
    });

    const mappingEntries = Object.entries(mappings);
    const sumMax = mappingEntries.reduce(function (acc, pair) {
      return acc + (pair[1].maxInProgressAiIssues != null ? pair[1].maxInProgressAiIssues : 3);
    }, 0);
    const pct = sumMax > 0 ? Math.round((running.length / sumMax) * 100) : 0;

    const atCapCount = mappingEntries.filter(function (pair) {
      const key = pair[0];
      const m = pair[1];
      const cap = m.maxInProgressAiIssues != null ? m.maxInProgressAiIssues : 3;
      const cnt = running.filter(function (r) { return r.teamKey === key; }).length;
      return cnt >= cap;
    }).length;

    const teams = new Set(running.map(function (r) { return r.teamKey; }));

    const rv = document.getElementById('kpi-running-value');
    if (rv) rv.textContent = String(running.length);
    const rs = document.getElementById('kpi-running-sub');
    if (rs) rs.textContent = 'across ' + teams.size + ' team' + (teams.size === 1 ? '' : 's');

    const cv = document.getElementById('kpi-capacity-value');
    if (cv) cv.textContent = String(running.length);
    const cu = document.getElementById('kpi-capacity-unit');
    if (cu) cu.textContent = '/ ' + sumMax;
    const cs = document.getElementById('kpi-capacity-sub');
    if (cs) cs.textContent = pct + '% of total slots';

    const bv = document.getElementById('kpi-blocked-value');
    if (bv) bv.textContent = String(atCapCount);

    const fv = document.getElementById('kpi-failed-value');
    if (fv) fv.textContent = String(failed24h.length);

    const spark = document.getElementById('kpi-spark');
    if (spark) spark.innerHTML = sparkline(dispatch24hBuckets(log));
  }

  function renderRunningNow(running) {
    const tbody = document.getElementById('overview-running-body');
    const empty = document.getElementById('overview-running-empty');
    const subtitle = document.getElementById('overview-running-subtitle');
    if (!tbody || !empty) return;
    if (subtitle) subtitle.textContent = running.length + ' job' + (running.length === 1 ? '' : 's');
    tbody.innerHTML = '';
    if (running.length === 0) {
      empty.classList.remove('hidden');
      return;
    }
    empty.classList.add('hidden');
    const now = Date.now();
    running.slice(0, 6).forEach(function (e) {
      const tr = document.createElement('tr');
      const issueLabel = e.issueIdentifier || e.issueId || '—';
      const title = e.issueTitle ? window.esc(e.issueTitle) : '';
      const duration = e.dispatchedAt ? fmtDuration(now - new Date(e.dispatchedAt).getTime()) : '—';
      tr.innerHTML = '<td class="col-grow">'
        + '<div><span class="mono" style="color:var(--fg-tertiary);margin-right:8px">' + window.esc(issueLabel) + '</span>'
        + (title ? '<span>' + title + '</span>' : '') + '</div>'
        + '<div style="font-size:11px;color:var(--fg-tertiary);margin-top:2px">'
        + window.esc(e.teamKey || '—') + ' &middot; ' + window.esc(e.repo || '—')
        + '</div></td>'
        + '<td>' + statusBadge(e.status) + '</td>'
        + '<td style="text-align:right" class="mono text-secondary">' + duration + '</td>';
      tbody.appendChild(tr);
    });
  }

  function renderAtCapacity(running, mappings) {
    const body = document.getElementById('overview-atcap-body');
    const empty = document.getElementById('overview-atcap-empty');
    if (!body || !empty) return;
    body.innerHTML = '';
    const atCap = Object.entries(mappings).filter(function (pair) {
      const key = pair[0];
      const m = pair[1];
      const cap = m.maxInProgressAiIssues != null ? m.maxInProgressAiIssues : 3;
      const cnt = running.filter(function (r) { return r.teamKey === key; }).length;
      return cnt >= cap;
    });
    if (atCap.length === 0) {
      empty.classList.remove('hidden');
      return;
    }
    empty.classList.add('hidden');
    atCap.forEach(function (pair) {
      const key = pair[0];
      const m = pair[1];
      const cap = m.maxInProgressAiIssues != null ? m.maxInProgressAiIssues : 3;
      const cnt = running.filter(function (r) { return r.teamKey === key; }).length;
      const div = document.createElement('div');
      div.innerHTML = '<span class="mono">' + window.esc(key) + '</span> '
        + '<span class="text-secondary">at capacity (' + cnt + '/' + cap + ')</span>';
      body.appendChild(div);
    });
  }

  function renderRecentFailures(log) {
    const tbody = document.getElementById('overview-failures-body');
    const empty = document.getElementById('overview-failures-empty');
    if (!tbody || !empty) return;
    const now = Date.now();
    const failures = log.filter(function (e) {
      return e.status === 'failed' && (now - new Date(e.dispatchedAt).getTime()) < 86400000;
    }).sort(function (a, b) {
      return new Date(b.dispatchedAt).getTime() - new Date(a.dispatchedAt).getTime();
    }).slice(0, 8);
    tbody.innerHTML = '';
    if (failures.length === 0) {
      empty.classList.remove('hidden');
      return;
    }
    empty.classList.add('hidden');
    failures.forEach(function (e) {
      const tr = document.createElement('tr');
      const issueLabel = e.issueIdentifier || e.issueId || '—';
      const failedAt = e.dispatchedAt ? new Date(e.dispatchedAt).toLocaleString() : '—';
      const when = e.dispatchedAt ? fmtAgo(e.dispatchedAt) : '—';
      tr.innerHTML = '<td><span class="mono text-secondary">' + window.esc(issueLabel) + '</span>'
        + (e.issueTitle ? ' <span class="text-secondary">' + window.esc(e.issueTitle) + '</span>' : '') + '</td>'
        + '<td class="mono text-tertiary" style="white-space:nowrap">' + failedAt + '</td>'
        + '<td class="text-secondary col-grow">' + (e.issueTitle ? window.esc(e.issueTitle) : '&mdash;') + '</td>'
        + '<td style="text-align:right" class="mono text-tertiary">' + when + '</td>';
      tbody.appendChild(tr);
    });
  }

  function renderProjectGrid(log, mappings) {
    const tbody = document.getElementById('overview-projects-body');
    const empty = document.getElementById('overview-projects-empty');
    if (!tbody || !empty) return;
    const entries = Object.entries(mappings);
    tbody.innerHTML = '';
    if (entries.length === 0) {
      empty.classList.remove('hidden');
      return;
    }
    empty.classList.add('hidden');
    const running = log.filter(function (e) { return e.status === 'running'; });
    entries.forEach(function (pair) {
      const key = pair[0];
      const m = pair[1];
      const cap = m.maxInProgressAiIssues != null ? m.maxInProgressAiIssues : 3;
      const cnt = running.filter(function (r) { return r.teamKey === key; }).length;
      const isFly = m.executionMode === 'fly-machines';
      const runnerKind = isFly ? 'success' : 'info';
      const runnerLabel = isFly ? 'fly' : 'gha';
      const tr = document.createElement('tr');
      tr.innerHTML = '<td><span class="mono" style="font-weight:600">' + window.esc(key) + '</span></td>'
        + '<td class="mono text-secondary">' + window.esc((m.owner || '?') + '/' + (m.repo || '?')) + '</td>'
        + '<td><span class="badge ' + runnerKind + '">' + runnerLabel + '</span></td>'
        + '<td class="text-secondary">' + window.esc(m.provider || 'anthropic') + '</td>'
        + '<td>' + capacityMeter(cnt, cap) + '</td>'
        + '<td style="text-align:right" class="mono text-secondary">&mdash;</td>';
      tbody.appendChild(tr);
    });
  }

  async function loadOverview() {
    try {
      const [logRes, mappingsRes, reaperRes] = await Promise.all([
        window.api('/api/log'),
        window.api('/api/mappings'),
        window.api('/api/reaper/summary'),
      ]);
      const log = await logRes.json();
      const mappings = await mappingsRes.json();
      const reaper = await reaperRes.json();
      const safeLog = Array.isArray(log) ? log : [];
      const safeMappings = mappings && typeof mappings === 'object' && !Array.isArray(mappings) ? mappings : {};
      const running = safeLog.filter(function (e) { return e.status === 'running'; });
      renderHeaderSubtitle(reaper);
      renderKpis(safeLog, safeMappings, running);
      renderRunningNow(running);
      renderAtCapacity(running, safeMappings);
      renderRecentFailures(safeLog);
      renderProjectGrid(safeLog, safeMappings);
    } catch (err) {
      console.error('loadOverview failed:', err);
    }
  }

  window.loadOverview = loadOverview;

  window.registerPage('overview', function () {
    loadOverview();
    setInterval(loadOverview, 30000);
  });
})();
`;
