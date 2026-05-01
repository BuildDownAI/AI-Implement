export const auditHtml = `
<section data-page="audit" hidden>
  <header class="page-header">
    <div class="page-header-left">
      <h1 class="page-title">Audit log</h1>
      <div class="page-subtitle">Dispatch dedup ledger (last 24h). Full audit-log enrichment is on the roadmap.</div>
    </div>
    <div class="page-header-actions">
      <button class="btn btn-sm" onclick="loadDedup()">&#8635; Refresh</button>
    </div>
  </header>
  <div class="page-body">
    <div class="card">
      <div class="card-header">
        <h2 class="card-title">Dedup entries</h2>
        <div class="card-subtitle"><span id="dedup-count">&mdash;</span></div>
      </div>
      <div class="card-body tight">
        <table class="tbl">
          <thead><tr><th>Issue</th><th>Dispatched at</th><th></th></tr></thead>
          <tbody id="dedup-body"></tbody>
        </table>
        <div id="dedup-empty" class="hidden text-tertiary" style="padding:12px">No entries</div>
      </div>
    </div>
  </div>
</section>
`;

export const auditScript = `
(function () {
  async function loadDedup() {
    try {
      const res = await window.api('/api/dedup');
      const data = await res.json();
      const countEl = document.getElementById('dedup-count');
      if (countEl) countEl.textContent = '(' + (Array.isArray(data) ? data.length : 0) + ')';
      const tbody = document.getElementById('dedup-body');
      const empty = document.getElementById('dedup-empty');
      tbody.innerHTML = '';
      if (data.length === 0) { empty.classList.remove('hidden'); return; }
      empty.classList.add('hidden');
      for (const e of data) {
        const tr = document.createElement('tr');
        const dt = new Date(e.dispatchedAt).toLocaleString();
        const issueLabel = (e.issueIdentifier || e.issueId) + (e.issueTitle ? ': ' + e.issueTitle : '');
        tr.innerHTML = '<td><span class="mono">' + window.esc(issueLabel) + '</span></td>'
          + '<td>' + dt + '</td>'
          + '<td><button class="danger" data-issue-id="' + window.esc(e.issueId) + '" onclick="delDedup(this.dataset.issueId)">Delete</button></td>';
        tbody.appendChild(tr);
      }
    } catch (err) {
      console.error('loadDedup failed:', err);
    }
  }

  async function delDedup(id) {
    await window.api('/api/dedup/' + encodeURIComponent(id), { method: 'DELETE' });
    await loadDedup();
  }

  window.loadDedup = loadDedup;
  window.delDedup = delDedup;

  window.registerPage('audit', function () {
    loadDedup();
  });
})();
`;
