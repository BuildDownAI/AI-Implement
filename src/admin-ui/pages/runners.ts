export const runnersHtml = `
<section data-page="runners" hidden>
  <header class="page-header">
    <div class="page-header-left">
      <h1 class="page-title">Runners</h1>
      <div class="page-subtitle" id="runners-subtitle">—</div>
    </div>
    <div class="page-header-actions">
      <button class="btn btn-sm" onclick="loadRunners()">↻ Refresh</button>
    </div>
  </header>
  <div class="page-body">
    <div id="runners-error" class="alert fail" hidden></div>
    <div id="runners-mode-banner" class="alert warn" hidden></div>

    <div class="kpi-grid">
      <div class="kpi"><div class="kpi-label">Runner mode</div><div class="kpi-value" id="kpi-runner-mode">—</div><div class="kpi-trend" id="kpi-runner-source"></div></div>
      <div class="kpi"><div class="kpi-label">Live Fly sessions</div><div class="kpi-value" id="kpi-live-sessions">0</div></div>
      <div class="kpi"><div class="kpi-label">Capacity used</div><div class="kpi-value"><span id="kpi-capacity-used">0</span><span class="kpi-unit"> / <span id="kpi-capacity-max">0</span></span></div></div>
      <div class="kpi"><div class="kpi-label">Reaper (24h)</div><div class="kpi-value" id="kpi-reaped">0</div><div class="kpi-trend" id="kpi-reaper-sweep"></div></div>
    </div>

    <div class="card">
      <div class="card-header">
        <h2 class="card-title">Fly Machines — live sessions</h2>
        <div class="card-subtitle"><a href="#sessions" class="text-accent">Manage on Sessions page →</a></div>
      </div>
      <div class="card-body tight">
        <table class="tbl">
          <thead><tr><th>Issue</th><th>Team</th><th>Repo</th><th>Machine</th><th>State</th></tr></thead>
          <tbody id="runners-sessions-body"></tbody>
        </table>
        <div id="runners-sessions-empty" class="hidden text-tertiary" style="padding:12px">No live machines.</div>
      </div>
    </div>

    <div class="card">
      <div class="card-header">
        <h2 class="card-title">Per-project execution mode</h2>
        <div class="card-subtitle">Effective mode is the mapping value unless the runner-mode override is set.</div>
      </div>
      <div class="card-body tight">
        <table class="tbl">
          <thead><tr><th>Team</th><th>Repo</th><th>Mode</th><th>Effective</th><th style="width:200px">Cap utilization</th><th style="text-align:right">Cap</th></tr></thead>
          <tbody id="runners-projects-body"></tbody>
        </table>
        <div id="runners-projects-empty" class="hidden text-tertiary" style="padding:12px">No projects configured.</div>
      </div>
    </div>
  </div>
</section>
`;

export const runnersScript = `
(function () {
  function fmtAgo(ms) {
    const s = Math.floor((Date.now() - ms) / 1000);
    if (s < 60) return s + 's ago';
    const m = Math.floor(s / 60);
    if (m < 60) return m + 'm ago';
    const h = Math.floor(m / 60);
    return h + 'h ago';
  }

  async function fetchOk(url, fallback) {
    try {
      const res = await window.api(url);
      if (res.ok) return await res.json();
      return fallback;
    } catch (e) {
      return fallback;
    }
  }

  function kindForMode(mode) {
    if (mode === 'gha') return 'info';
    if (mode === 'fly') return 'success';
    if (mode === 'local') return 'neutral';
    if (mode === 'shadow') return 'warn';
    return 'neutral';
  }

  async function loadRunners() {
    const errEl = document.getElementById('runners-error');
    const bannerEl = document.getElementById('runners-mode-banner');
    errEl.hidden = true;
    bannerEl.hidden = true;

    const [runnerModeRes, mappingsRes, sessions, reaper] = await Promise.all([
      window.api('/api/runner-mode'),
      window.api('/api/mappings'),
      fetchOk('/api/sessions', null),
      fetchOk('/api/reaper/summary', null),
    ]);

    if (!runnerModeRes.ok || !mappingsRes.ok) {
      let message = 'Unknown error';
      try {
        const body = await (!runnerModeRes.ok ? runnerModeRes : mappingsRes).json();
        message = body.error || message;
      } catch (e) { /* ignore */ }
      errEl.innerHTML = '<div style="flex:1"><div class="alert-title">Failed to load runners data</div><div class="alert-desc">' + window.esc(message) + '</div></div>';
      errEl.hidden = false;
      document.getElementById('kpi-runner-mode').textContent = '—';
      document.getElementById('kpi-live-sessions').textContent = '0';
      document.getElementById('kpi-capacity-used').textContent = '0';
      document.getElementById('kpi-capacity-max').textContent = '0';
      document.getElementById('kpi-reaped').textContent = '0';
      document.getElementById('runners-sessions-body').innerHTML = '';
      document.getElementById('runners-projects-body').innerHTML = '';
      document.getElementById('runners-subtitle').textContent = '—';
      return;
    }

    const runnerMode = await runnerModeRes.json();
    const mappings = await mappingsRes.json();

    const liveSessions = Array.isArray(sessions) ? sessions : [];
    const mapEntries = Object.entries(mappings).sort((a, b) => a[0].localeCompare(b[0]));
    const capMax = mapEntries.reduce((s, entry) => s + (entry[1].maxInProgressAiIssues ?? 0), 0);
    const capUsed = liveSessions.length;

    const runningByTeam = {};
    for (const s of liveSessions) {
      if (s.teamKey) runningByTeam[s.teamKey] = (runningByTeam[s.teamKey] ?? 0) + 1;
    }

    // Runner mode KPI
    const modeBadgeKind = kindForMode(runnerMode.mode);
    document.getElementById('kpi-runner-mode').innerHTML = '<span class="badge ' + modeBadgeKind + '"><span class="dot"></span>' + window.esc(runnerMode.mode) + '</span>';
    document.getElementById('kpi-runner-source').textContent = '(' + runnerMode.source + ')';

    if (runnerMode.mode !== 'default') {
      const bannerKind = runnerMode.mode === 'shadow' ? 'warn' : 'info';
      bannerEl.className = 'alert ' + bannerKind;
      bannerEl.innerHTML = '<div style="flex:1"><div class="alert-title">Runner mode override active: ' + window.esc(runnerMode.mode) + '</div><div class="alert-desc">All projects route through ' + window.esc(runnerMode.mode) + ' regardless of their per-project mode.</div></div>';
      bannerEl.hidden = false;
    }

    // Live sessions KPI
    document.getElementById('kpi-live-sessions').textContent = String(liveSessions.length);

    // Capacity KPI
    document.getElementById('kpi-capacity-used').textContent = String(capUsed);
    document.getElementById('kpi-capacity-max').textContent = String(capMax || '—');

    // Reaper KPI
    document.getElementById('kpi-reaped').textContent = String(reaper ? (reaper.total24h ?? 0) : 0);
    document.getElementById('kpi-reaper-sweep').textContent = reaper && reaper.lastSweepAt ? ('last sweep ' + fmtAgo(reaper.lastSweepAt)) : 'no sweep yet';

    // Sessions table
    const sessionsBody = document.getElementById('runners-sessions-body');
    const sessionsEmpty = document.getElementById('runners-sessions-empty');
    sessionsBody.innerHTML = '';
    const topSessions = liveSessions.slice(0, 8);
    if (topSessions.length === 0) {
      sessionsEmpty.classList.remove('hidden');
    } else {
      sessionsEmpty.classList.add('hidden');
      for (const s of topSessions) {
        const stateBadgeKind = s.state === 'started' ? 'success' : s.state === 'stopped' ? 'neutral' : 'info';
        const machineId = s.machineId || '';
        const machineTrunc = machineId.length > 12 ? machineId.slice(0, 12) : machineId;
        const tr = document.createElement('tr');
        tr.innerHTML = '<td class="mono" title="' + window.esc(s.issueTitle || '') + '">' + window.esc(s.issueIdentifier || '—') + '</td>'
          + '<td class="mono">' + window.esc(s.teamKey || '—') + '</td>'
          + '<td class="mono">' + window.esc(s.repo || '—') + '</td>'
          + '<td class="mono" title="' + window.esc(machineId) + '">' + window.esc(machineTrunc) + '</td>'
          + '<td><span class="badge ' + stateBadgeKind + '">' + window.esc(s.state || '—') + '</span></td>';
        sessionsBody.appendChild(tr);
      }
    }

    // Projects table
    const projectsBody = document.getElementById('runners-projects-body');
    const projectsEmpty = document.getElementById('runners-projects-empty');
    projectsBody.innerHTML = '';
    if (mapEntries.length === 0) {
      projectsEmpty.classList.remove('hidden');
    } else {
      projectsEmpty.classList.add('hidden');
      for (const entry of mapEntries) {
        const teamKey = entry[0];
        const m = entry[1];
        const execMode = m.executionMode || 'gha';
        const modeKind = execMode === 'fly' || execMode === 'fly-machines' ? 'success' : 'info';
        const effectiveBadge = runnerMode.mode === 'default'
          ? '<span class="badge ' + modeKind + '">' + window.esc(execMode) + '</span>'
          : '<span class="badge warn">' + window.esc(runnerMode.mode) + '</span>';
        const cap = m.maxInProgressAiIssues ?? 0;
        const running = runningByTeam[teamKey] ?? 0;
        let capCell;
        if (cap === 0) {
          capCell = '<td style="text-align:right"><span class="mono text-secondary">— / 0</span></td>';
        } else {
          const rawPct = (running / cap) * 100;
          const pct = Math.min(100, Math.max(0, rawPct));
          const fillColor = pct >= 100 ? 'var(--st-fail-dot)' : pct >= 75 ? 'var(--st-warn-dot)' : 'var(--accent)';
          capCell = '<td><div class="meter"><div class="fill" style="width:' + pct + '%;background:' + fillColor + '"></div></div></td>'
            + '<td style="text-align:right"><span class="mono text-secondary">' + running + ' / ' + cap + '</span></td>';
        }
        const owner = m.owner || '';
        const repo = m.repo || '';
        const tr = document.createElement('tr');
        tr.innerHTML = '<td class="mono">' + window.esc(teamKey) + '</td>'
          + '<td class="mono">' + window.esc(owner) + '/' + window.esc(repo) + '</td>'
          + '<td><span class="badge ' + modeKind + '">' + window.esc(execMode) + '</span></td>'
          + '<td>' + effectiveBadge + '</td>'
          + (cap === 0 ? capCell : capCell);
        projectsBody.appendChild(tr);
      }
    }

    // Subtitle
    document.getElementById('runners-subtitle').textContent = liveSessions.length + ' live · ' + runnerMode.mode + ' mode';
  }

  window.loadRunners = loadRunners;
  window.registerPage('runners', function () { loadRunners(); setInterval(loadRunners, 30000); });
})();
`;
