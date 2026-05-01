export const sessionsHtml = `
<section data-page="sessions" hidden>
  <header class="page-header">
    <div class="page-header-left">
      <h1 class="page-title">Sessions</h1>
      <div class="page-subtitle">Live Fly Machines running agent sessions</div>
    </div>
    <div class="page-header-actions">
      <button class="btn btn-sm" onclick="loadSessions()">&#8635; Refresh</button>
    </div>
  </header>
  <div class="page-body">
    <div class="card">
      <div class="card-header">
        <h2 class="card-title">Active sessions</h2>
        <div class="card-subtitle"><span id="lu-sessions" class="text-tertiary"></span></div>
      </div>
      <div class="card-body tight">
        <table class="tbl">
          <thead><tr><th>Issue</th><th>Team</th><th>Repo</th><th>Machine</th><th>State</th><th>Duration</th><th></th></tr></thead>
          <tbody id="sessions-body"></tbody>
        </table>
        <div id="sessions-empty" class="hidden text-tertiary" style="padding:12px">No active sessions</div>
      </div>
    </div>
  </div>
</section>
`;

export const sessionsScript = `
(function () {
  function setLastUpdated(id) {
    const el = document.getElementById(id);
    if (el) el.textContent = 'updated ' + new Date().toLocaleTimeString();
  }

  const destroyedMachineIds = new Map();

  function pruneDestroyed() {
    const now = Date.now();
    for (const [id, ts] of destroyedMachineIds) {
      if (now - ts > 60000) destroyedMachineIds.delete(id);
    }
  }

  function fmtDuration(ms) {
    const s = Math.floor(ms / 1000);
    if (s < 60) return s + 's';
    const m = Math.floor(s / 60);
    if (m < 60) return m + 'm ' + (s % 60) + 's';
    const h = Math.floor(m / 60);
    return h + 'h ' + (m % 60) + 'm';
  }

  async function loadSessions() {
    try {
      pruneDestroyed();
      const res = await window.api('/api/sessions');
      const raw = await res.json();
      const data = Array.isArray(raw) ? raw.filter((s) => !destroyedMachineIds.has(s.machineId)) : [];
      const tbody = document.getElementById('sessions-body');
      const empty = document.getElementById('sessions-empty');
      tbody.innerHTML = '';
      if (data.length === 0) {
        empty.classList.remove('hidden');
        setLastUpdated('lu-sessions');
        return;
      }
      empty.classList.add('hidden');
      for (const s of data) {
        const tr = document.createElement('tr');
        const createdMs = s.createdAt ? new Date(s.createdAt).getTime() : (s.dispatchedAt || Date.now());
        const duration = fmtDuration(Date.now() - createdMs);
        const issueLabel = s.issueIdentifier
          ? (s.issueTitle ? s.issueIdentifier + ': ' + s.issueTitle : s.issueIdentifier)
          : '—';
        const issueHtml = s.issueIdentifier
          ? '<a href="https://linear.app/issue/' + window.esc(s.issueIdentifier) + '" target="_blank">' + window.esc(issueLabel) + '</a>'
          : '<span class="mono">—</span>';
        tr.innerHTML = '<td>' + issueHtml + '</td>'
          + '<td class="mono">' + window.esc(s.teamKey || '—') + '</td>'
          + '<td class="mono">' + window.esc(s.repo || '—') + '</td>'
          + '<td class="mono" title="' + window.esc(s.machineId) + '">' + window.esc(s.machineName || s.machineId.slice(0, 10)) + '</td>'
          + '<td>' + window.esc(s.state) + '</td>'
          + '<td>' + duration + '</td>'
          + '<td><button class="sm danger" data-mid="' + window.esc(s.machineId) + '" onclick="destroySession(this.dataset.mid)">Destroy</button></td>';
        tbody.appendChild(tr);
      }
      setLastUpdated('lu-sessions');
    } catch (err) {
      console.error('loadSessions failed:', err);
    }
  }

  async function destroySession(machineId) {
    if (!confirm('Destroy machine ' + machineId + '? This will also reset the Linear issue.')) return;

    destroyedMachineIds.set(machineId, Date.now());

    try {
      await window.api('/api/sessions/' + encodeURIComponent(machineId), { method: 'DELETE' });
    } catch (err) {
      console.error('destroy failed:', err);
      destroyedMachineIds.delete(machineId);
      alert('Failed to destroy machine. Reloading list.');
    }

    await Promise.all([loadSessions(), (window.loadLog ? window.loadLog() : Promise.resolve())]);
  }

  window.loadSessions = loadSessions;
  window.destroySession = destroySession;

  window.registerPage('sessions', function () {
    loadSessions();
  });
})();
`;
