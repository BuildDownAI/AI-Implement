export const overviewHtml = `
<section data-page="overview" hidden>
  <header class="page-header">
    <div class="page-header-left">
      <h1 class="page-title">Overview</h1>
      <div class="page-subtitle" id="overview-subtitle">&mdash;</div>
    </div>
    <div class="page-header-actions">
      <button class="btn btn-sm" id="overview-poll-now" onclick="pollNowClick()">&#9889; Poll now</button>
      <button class="btn btn-sm" onclick="loadOverview()">&#8635; Refresh</button>
    </div>
  </header>
  <div class="page-body">

    <!-- Environment status pills -->
    <div id="overview-env-status" style="display:flex;flex-wrap:wrap;gap:8px;margin-bottom:16px">
      <!-- populated by loadEnvStatus() -->
    </div>

    <!-- Stale-template alert (hidden when everything is current) -->
    <div id="overview-template-status" class="hidden" style="margin-bottom:16px">
      <div class="alert warn">
        <div class="alert-icon">&#9888;</div>
        <div style="flex:1">
          <div class="alert-title">Target repos with stale prompt templates</div>
          <div class="alert-desc" id="overview-template-status-desc">
            These repos still curl Linear directly from inside their workflows. Update each repo's PLANNING.md / WORKFLOW.md to write outputs to <code>ai-output/comments/</code> so the orchestrator's runner-callback can post via the configured ticketing provider.
          </div>
          <div id="overview-template-status-list" style="margin-top:8px;font-size:0.9em"></div>
        </div>
      </div>
    </div>

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
            <div class="card-subtitle" id="overview-atcap-subtitle">Teams at concurrency cap</div>
          </div>
          <button class="btn btn-ghost btn-sm" onclick="window.navigate('blockers')">View blockers</button>
        </div>
        <div class="card-body">
          <div id="overview-atcap-body" style="display:flex;flex-direction:column;gap:8px"></div>
          <div id="overview-atcap-empty" class="hidden text-tertiary" style="padding:4px 0">All projects have available capacity. <a href="#blockers" onclick="window.navigate('blockers');return false" style="color:var(--accent)">View blockers page</a> for more details.</div>
          <div id="overview-atcap-unavailable" class="hidden text-tertiary" style="padding:4px 0">Capacity data is unavailable right now &mdash; team status can&rsquo;t be determined.</div>
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
          <thead><tr><th>Issue</th><th>Failed at</th><th style="text-align:right">When</th></tr></thead>
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
    const color = pct >= 100 ? 'var(--st-fail-dot)' : pct >= 75 ? 'var(--st-warn-dot)' : 'var(--accent)';
    return '<div style="display:flex;align-items:center;gap:8px">'
      + '<div style="flex:1;height:6px;background:var(--border-subtle);border-radius:3px;overflow:hidden">'
      + '<div style="width:' + Math.min(pct, 100) + '%;height:100%;background:' + color + ';border-radius:3px"></div>'
      + '</div>'
      + '<span class="mono text-secondary" style="font-size:11px;white-space:nowrap">' + used + '/' + max + '</span>'
      + '</div>';
  }

  function capacityMeterUnavailable() {
    return '<span class="text-tertiary" style="font-size:11px">unavailable</span>';
  }

  // Reservation-backed totals from the /api/blockers capacity projection
  // (src/admin.ts#buildCapacityByMapping) — never derived by filtering the job log,
  // so a prepared/unknown/stopping reservation with no visible running row still
  // counts as used, and a stranded tracker label can never mask real capacity.
  function capacityAtCapTeams(capacityByMapping) {
    return Object.entries(capacityByMapping).filter(function (pair) {
      return pair[1].used >= pair[1].cap;
    });
  }

  function isReviewIncomplete(e) {
    if (!e || e.status !== 'review_failed') return false;
    const failure = e.failure;
    const code = failure && typeof failure.code === 'string' ? failure.code : e.conclusion;
    const stage = failure && typeof failure.stage === 'string' ? failure.stage : '';
    return code === 'REVIEWER_TURNS_EXHAUSTED'
      || code === 'invalid_review'
      || code === 'review_invalid'
      || (code === 'PROVIDER_UNAVAILABLE' && (!stage || stage.includes('review')));
  }

  function statusBadge(status, entry) {
    const map = { running: 'running', review_failed: 'warn', timed_out: 'warn', failed: 'fail', 'dispatch-failed': 'fail', completed: 'success' };
    const kind = map[status] || 'neutral';
    const label = isReviewIncomplete(entry)
      ? 'review incomplete'
      : status === 'review_failed'
        ? 'review failed'
        : status === 'dispatch-failed'
          ? 'dispatch failed'
          : status;
    return '<span class="badge ' + kind + '">' + window.esc(label) + '</span>';
  }

  function dispatch24hBuckets(log) {
    if (!log || log.length === 0) return [];
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

  function renderKpis(log, running, capacityByMapping) {
    const now = Date.now();
    const failed24h = log.filter(function (e) {
      return (e.status === 'failed' || e.status === 'review_failed' || (e.status === 'timed_out' && e.conclusion === 'stuck_giveup')) && (now - new Date(e.dispatchedAt).getTime()) < 86400000;
    });

    const teams = new Set(running.filter(function (r) { return r.teamKey; }).map(function (r) { return r.teamKey; }));

    const rv = document.getElementById('kpi-running-value');
    if (rv) rv.textContent = String(running.length);
    const rs = document.getElementById('kpi-running-sub');
    if (rs) rs.textContent = 'across ' + teams.size + ' team' + (teams.size === 1 ? '' : 's');

    const cv = document.getElementById('kpi-capacity-value');
    const cu = document.getElementById('kpi-capacity-unit');
    const cs = document.getElementById('kpi-capacity-sub');
    const bv = document.getElementById('kpi-blocked-value');
    const bs = document.getElementById('kpi-blocked-sub');

    if (!capacityByMapping) {
      // Missing/failed capacity projection is unavailable, never rendered as 0/free.
      if (cv) cv.textContent = '—';
      if (cu) cu.textContent = '';
      if (cs) cs.textContent = 'Capacity data unavailable';
      if (bv) bv.textContent = '—';
      if (bs) bs.textContent = 'Capacity data unavailable';
    } else {
      const capacityEntries = Object.values(capacityByMapping);
      const sumUsed = capacityEntries.reduce(function (acc, c) { return acc + c.used; }, 0);
      const sumCap = capacityEntries.reduce(function (acc, c) { return acc + c.cap; }, 0);
      const pct = sumCap > 0 ? Math.round((sumUsed / sumCap) * 100) : 0;
      const atCapCount = capacityAtCapTeams(capacityByMapping).length;

      if (cv) cv.textContent = String(sumUsed);
      if (cu) cu.textContent = '/ ' + sumCap;
      if (cs) cs.textContent = pct + '% of total slots';
      if (bv) bv.textContent = String(atCapCount);
      if (bs) bs.textContent = 'at concurrency cap';
    }

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
      if (e.id != null) tr.setAttribute('data-job-id', String(e.id));
      tr.style.cursor = 'pointer';
      const issueLabel = e.issueIdentifier || e.issueId || '—';
      const title = e.issueTitle ? window.esc(e.issueTitle) : '';
      const duration = e.dispatchedAt ? fmtDuration(now - new Date(e.dispatchedAt).getTime()) : '—';
      tr.innerHTML = '<td class="col-grow">'
        + '<div><span class="mono" style="color:var(--fg-tertiary);margin-right:8px">' + window.esc(issueLabel) + '</span>'
        + (title ? '<span>' + title + '</span>' : '') + '</div>'
        + '<div style="font-size:11px;color:var(--fg-tertiary);margin-top:2px">'
        + window.esc(e.teamKey || '—') + ' &middot; ' + window.esc(e.repo || '—')
        + '</div></td>'
        + '<td>' + statusBadge(e.status, e) + '</td>'
        + '<td style="text-align:right" class="mono text-secondary">' + duration + '</td>';
      tbody.appendChild(tr);
    });
  }

  function renderAtCapacity(capacityByMapping) {
    const body = document.getElementById('overview-atcap-body');
    const empty = document.getElementById('overview-atcap-empty');
    const unavailable = document.getElementById('overview-atcap-unavailable');
    const subtitle = document.getElementById('overview-atcap-subtitle');
    if (!body || !empty) return;
    body.innerHTML = '';

    if (!capacityByMapping) {
      empty.classList.add('hidden');
      if (unavailable) unavailable.classList.remove('hidden');
      if (subtitle) subtitle.textContent = 'Capacity data unavailable';
      return;
    }
    if (unavailable) unavailable.classList.add('hidden');

    const atCap = capacityAtCapTeams(capacityByMapping);
    if (subtitle) subtitle.textContent = atCap.length + ' team' + (atCap.length === 1 ? '' : 's') + ' at cap';
    if (atCap.length === 0) {
      empty.classList.remove('hidden');
      return;
    }
    empty.classList.add('hidden');
    atCap.forEach(function (pair) {
      const key = pair[0];
      const c = pair[1];
      const div = document.createElement('div');
      div.innerHTML = '<span class="mono">' + window.esc(key) + '</span> '
        + '<span class="text-secondary">at capacity (' + c.used + '/' + c.cap + ')</span>';
      body.appendChild(div);
    });
  }

  function renderRecentFailures(log) {
    const tbody = document.getElementById('overview-failures-body');
    const empty = document.getElementById('overview-failures-empty');
    if (!tbody || !empty) return;
    const now = Date.now();
    const failures = log.filter(function (e) {
      return (e.status === 'failed' || e.status === 'review_failed' || (e.status === 'timed_out' && e.conclusion === 'stuck_giveup')) && (now - new Date(e.dispatchedAt).getTime()) < 86400000;
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
      if (e.id != null) tr.setAttribute('data-job-id', String(e.id));
      tr.style.cursor = 'pointer';
      const issueLabel = e.issueIdentifier || e.issueId || '—';
      const failedAt = e.dispatchedAt ? new Date(e.dispatchedAt).toLocaleString() : '—';
      const when = e.dispatchedAt ? fmtAgo(e.dispatchedAt) : '—';
      tr.innerHTML = '<td class="col-grow"><span class="mono text-secondary">' + window.esc(issueLabel) + '</span>'
        + (e.issueTitle ? ' <span>' + window.esc(e.issueTitle) + '</span>' : '')
        + ' <span style="margin-left:6px">' + statusBadge(e.status, e) + '</span></td>'
        + '<td class="mono text-tertiary" style="white-space:nowrap">' + failedAt + '</td>'
        + '<td style="text-align:right" class="mono text-tertiary">' + when + '</td>';
      tbody.appendChild(tr);
    });
  }

  function wireOverviewDrawerRows() {
    ['overview-running-body', 'overview-failures-body'].forEach(function (id) {
      const tbody = document.getElementById(id);
      if (!tbody || tbody.dataset.drawerWired) return;
      tbody.addEventListener('click', function (e) {
        const target = e.target;
        if (target.closest('a')) return;
        const tr = target.closest('tr');
        const jobId = tr && tr.getAttribute('data-job-id');
        if (jobId && window.openJobDrawer) window.openJobDrawer(Number(jobId));
      });
      tbody.dataset.drawerWired = '1';
    });
  }

  function renderProjectGrid(mappings, capacityByMapping) {
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
    entries.forEach(function (pair) {
      const key = pair[0];
      const m = pair[1];
      const c = capacityByMapping ? capacityByMapping[key] : null;
      const isFly = m.executionMode === 'fly-machines';
      const runnerKind = isFly ? 'success' : 'info';
      const runnerLabel = isFly ? 'fly' : 'gha';
      const tr = document.createElement('tr');
      tr.innerHTML = '<td><span class="mono" style="font-weight:600">' + window.esc(key) + '</span></td>'
        + '<td class="mono text-secondary">' + window.esc((m.owner || '?') + '/' + (m.repo || '?')) + '</td>'
        + '<td><span class="badge ' + runnerKind + '">' + runnerLabel + '</span></td>'
        + '<td class="text-secondary">' + window.esc(m.provider || 'anthropic') + '</td>'
        + '<td>' + (c ? capacityMeter(c.used, c.cap) : capacityMeterUnavailable()) + '</td>'
        + '<td style="text-align:right" class="mono text-secondary">&mdash;</td>';
      tbody.appendChild(tr);
    });
  }

  function renderEnvStatus(status) {
    const container = document.getElementById('overview-env-status');
    if (!container) return;
    const pills = [
      { label: 'Linear', on: !!status.linear, hint: 'LINEAR_CLIENT_ID + LINEAR_CLIENT_SECRET' },
      { label: 'Jira', on: !!status.jira, hint: 'JIRA_TOKEN + JIRA_SITE_URL + (JIRA_EMAIL or JIRA_CLOUD_ID)' },
      { label: 'Runner callback', on: !!status.runnerCallback, hint: 'RUNNER_CALLBACK_BASE_URL + RUNNER_TOKEN_SECRET' },
    ];
    container.innerHTML = pills.map(function (p) {
      const tint = p.on ? 'var(--st-ok-fg, #2a8)' : 'var(--text-tertiary, #888)';
      const dot = p.on ? '●' : '○';
      const text = p.label + ' ' + (p.on ? 'ON' : 'off');
      return '<span title="' + window.escAttr(p.hint) + '" style="display:inline-flex;align-items:center;gap:6px;padding:4px 10px;border:1px solid var(--border, #2a2a2a);border-radius:999px;font-size:0.85em;color:' + tint + '"><span style="font-size:0.7em">' + dot + '</span>' + window.esc(text) + '</span>';
    }).join('');
  }

  async function loadEnvStatus() {
    try {
      const res = await window.api('/api/admin/config-status');
      if (!res.ok) return;
      const status = await res.json();
      renderEnvStatus(status);
    } catch (err) {
      console.error('loadEnvStatus failed:', err);
    }
  }

  function renderTemplateStatus(entries) {
    const wrap = document.getElementById('overview-template-status');
    const list = document.getElementById('overview-template-status-list');
    if (!wrap || !list) return;
    const stale = entries.filter(function (e) { return e.planning === 'stale' || e.implementation === 'stale'; });
    if (stale.length === 0) {
      wrap.classList.add('hidden');
      return;
    }
    list.innerHTML = stale.map(function (e) {
      const files = [];
      if (e.planning === 'stale') files.push('PLANNING.md');
      if (e.implementation === 'stale') files.push('WORKFLOW.md');
      return '<div><code>' + window.esc(e.owner) + '/' + window.esc(e.repo) + '</code>: ' + window.esc(files.join(', ')) + '</div>';
    }).join('');
    wrap.classList.remove('hidden');
  }

  async function loadTemplateStatus() {
    try {
      const res = await window.api('/api/admin/template-status');
      if (!res.ok) return;
      const entries = await res.json();
      renderTemplateStatus(Array.isArray(entries) ? entries : []);
    } catch (err) {
      console.error('loadTemplateStatus failed:', err);
    }
  }

  // The capacity projection rides /api/blockers's capacityByMapping (same field
  // blockers.ts reads), so both pages report identical at-cap teams without either
  // recomputing it from the job log or a tracker label.
  async function readCapacityByMapping(capacityRes) {
    if (!capacityRes || !capacityRes.ok) return null;
    try {
      const data = await capacityRes.json();
      if (!data || typeof data.capacityByMapping !== 'object' || data.capacityByMapping === null) return null;
      return data.capacityByMapping;
    } catch (err) {
      return null;
    }
  }

  async function loadOverview() {
    try {
      const [logRes, mappingsRes, reaperRes, capacityRes] = await Promise.all([
        window.api('/api/log'),
        window.api('/api/mappings'),
        window.api('/api/reaper/summary'),
        window.api('/api/blockers'),
      ]);
      const log = await logRes.json();
      const mappings = await mappingsRes.json();
      const reaper = await reaperRes.json();
      const safeLog = Array.isArray(log) ? log : [];
      const safeMappings = mappings && typeof mappings === 'object' && !Array.isArray(mappings) ? mappings : {};
      const running = safeLog.filter(function (e) { return e.status === 'running'; });
      const capacityByMapping = await readCapacityByMapping(capacityRes);
      renderHeaderSubtitle(reaper);
      renderKpis(safeLog, running, capacityByMapping);
      renderRunningNow(running);
      renderAtCapacity(capacityByMapping);
      renderRecentFailures(safeLog);
      renderProjectGrid(safeMappings, capacityByMapping);
      loadEnvStatus();
      loadTemplateStatus();
    } catch (err) {
      console.error('loadOverview failed:', err);
    }
  }

  window.loadOverview = loadOverview;

  async function pollNowClick() {
    const btn = document.getElementById('overview-poll-now');
    const original = btn.innerHTML;
    btn.disabled = true;
    try {
      const res = await window.api('/api/poll-now', { method: 'POST' });
      const data = await res.json();
      if (!res.ok) btn.textContent = (data && data.error) || 'Unavailable';
      else btn.textContent = data.started ? 'Poll started' : 'Poll already running';
    } catch (err) {
      btn.textContent = 'Failed';
      console.error('pollNow failed:', err);
    }
    setTimeout(function () {
      btn.innerHTML = original;
      btn.disabled = false;
      loadOverview();
    }, 2500);
  }
  window.pollNowClick = pollNowClick;

  window.registerPage('overview', function () {
    loadOverview();
    wireOverviewDrawerRows();
    setInterval(loadOverview, 30000);
  });
})();
`;
