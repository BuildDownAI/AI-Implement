export const blockersHtml = `
<section data-page="blockers" hidden>
  <header class="page-header">
    <div class="page-header-left">
      <h1 class="page-title">Blockers</h1>
      <div class="page-subtitle" id="blockers-subtitle">—</div>
    </div>
    <div class="page-header-actions">
      <button class="btn btn-sm" onclick="loadBlockers()">↻ Refresh</button>
    </div>
  </header>
  <div class="page-body">
    <div id="blockers-error" class="alert fail" hidden></div>

    <div class="kpi-grid" id="blockers-kpis" hidden>
      <div class="kpi"><div class="kpi-label">Total blocked</div><div class="kpi-value" id="kpi-blocked-total">0</div></div>
      <div class="kpi"><div class="kpi-label">Teams affected</div><div class="kpi-value" id="kpi-blocked-teams">0</div></div>
      <div class="kpi"><div class="kpi-label">Teams at cap</div><div class="kpi-value" id="kpi-blocked-concurrency">0</div></div>
      <div class="kpi"><div class="kpi-label">By dedup</div><div class="kpi-value" id="kpi-blocked-dedup">0</div></div>
    </div>

    <div class="card">
      <div class="card-header">
        <h2 class="card-title">Blocked issues</h2>
        <div class="card-subtitle">grouped by reason</div>
      </div>
      <div class="card-body tight">
        <table class="tbl">
          <thead><tr><th>Issue</th><th>Team</th><th>Reason</th><th>Detail</th><th></th></tr></thead>
          <tbody id="blockers-body"></tbody>
        </table>
        <div id="blockers-empty" class="hidden text-tertiary" style="padding:12px">Nothing's blocked. All matched issues either have capacity or are already dispatched.</div>
      </div>
    </div>

    <div class="alert info" style="margin-top:12px">
      <div style="flex:1">
        <div class="alert-title">More blocker types coming</div>
        <div class="alert-desc">Today this page surfaces three blocker reasons: no mapping, deduplication, concurrency cap. Future plans will add missing-secret, GitHub App install, Bedrock region, and Linear-dependency blockers.</div>
      </div>
    </div>
  </div>
</section>
`;

export const blockersScript = `
(function () {
  function reasonBadge(reason) {
    if (reason === 'no-mapping') return '<span class="badge fail"><span class="dot"></span>No mapping</span>';
    if (reason === 'dedup') return '<span class="badge info"><span class="dot"></span>Dedup</span>';
    if (reason === 'concurrency') return '<span class="badge warn"><span class="dot"></span>Concurrency cap</span>';
    return '<span class="badge neutral"><span class="dot"></span>' + window.esc(reason) + '</span>';
  }

  function renderRows(blockers) {
    const tbody = document.getElementById('blockers-body');
    const emptyEl = document.getElementById('blockers-empty');
    tbody.innerHTML = '';
    if (blockers.length === 0) {
      emptyEl.classList.remove('hidden');
      tbody.closest('table').style.display = 'none';
      return;
    }
    emptyEl.classList.add('hidden');
    tbody.closest('table').style.display = '';
    for (const b of blockers) {
      const tr = document.createElement('tr');
      tr.innerHTML = '<td><span class="mono text-secondary">' + window.esc(b.issueIdentifier) + '</span> <span>' + window.esc(b.issueTitle || '') + '</span></td>'
        + '<td><span class="mono">' + window.esc(b.teamKey) + '</span></td>'
        + '<td>' + reasonBadge(b.reason) + '</td>'
        + '<td class="col-grow"><span class="text-secondary">' + window.esc(b.detail) + '</span></td>'
        + '<td>' + (b.issueUrl ? '<a class="text-accent" href="' + window.safeUrl(b.issueUrl) + '" target="_blank">Open \u2197</a>' : '<span class="text-tertiary">\u2014</span>') + '</td>';
      tbody.appendChild(tr);
    }
  }

  // Teams at capacity, sourced from the same reservation-backed capacityByMapping
  // projection overview.ts reads off this same /api/blockers response — never
  // recomputed from a tracker label or the job log, so the two pages agree by
  // construction. A missing/malformed projection renders unavailable, never 0.
  function renderKpis(totals, capacityByMapping) {
    document.getElementById('kpi-blocked-total').textContent = totals.issues;
    document.getElementById('kpi-blocked-teams').textContent = totals.teams;
    const concurrencyEl = document.getElementById('kpi-blocked-concurrency');
    if (!capacityByMapping) {
      concurrencyEl.textContent = '—';
    } else {
      const atCapCount = Object.values(capacityByMapping).filter(function (c) { return c.used >= c.cap; }).length;
      concurrencyEl.textContent = String(atCapCount);
    }
    document.getElementById('kpi-blocked-dedup').textContent = totals.byReason.dedup ?? 0;
    document.getElementById('blockers-kpis').hidden = false;
  }

  function renderSubtitle(blockers, totals) {
    const el = document.getElementById('blockers-subtitle');
    if (!el) return;
    if (blockers.length === 0) {
      el.textContent = "Nothing's blocked";
    } else {
      el.textContent = blockers.length + ' blocked across ' + totals.teams + ' team(s)';
    }
  }

  async function loadBlockers() {
    const errorEl = document.getElementById('blockers-error');
    errorEl.hidden = true;
    let res;
    try {
      res = await window.api('/api/blockers');
    } catch (_) {
      res = null;
    }
    if (!res || !res.ok) {
      let errorMsg = 'Capacity data unavailable';
      if (res) {
        try {
          const errBody = await res.json();
          errorMsg = errBody.error || errorMsg;
        } catch (_) { /* ignore parse errors */ }
      }
      errorEl.innerHTML = '<div style="flex:1"><div class="alert-title">Failed to load blockers</div><div class="alert-desc">' + window.esc(errorMsg) + '</div></div>';
      errorEl.hidden = false;
      document.getElementById('blockers-kpis').hidden = true;
      document.getElementById('blockers-body').innerHTML = '';
      document.getElementById('blockers-empty').classList.add('hidden');
      document.getElementById('blockers-subtitle').textContent = '—';
      return;
    }
    const data = await res.json();
    const capacityByMapping = data && typeof data.capacityByMapping === 'object' && data.capacityByMapping !== null
      ? data.capacityByMapping
      : null;
    renderKpis(data.totals, capacityByMapping);
    renderRows(data.blockers);
    renderSubtitle(data.blockers, data.totals);
  }

  window.loadBlockers = loadBlockers;
  window.registerPage('blockers', function () { loadBlockers(); setInterval(loadBlockers, 60000); });
}());
`;
