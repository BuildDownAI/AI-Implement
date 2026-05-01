export const modelsAndProvidersHtml = `
<section data-page="models" hidden>
  <header class="page-header">
    <div class="page-header-left">
      <h1 class="page-title">Models & providers</h1>
      <div class="page-subtitle" id="mp-subtitle">—</div>
    </div>
    <div class="page-header-actions">
      <button class="btn btn-sm" onclick="loadModelsAndProviders()">↻ Refresh</button>
    </div>
  </header>
  <div class="page-body">
    <div id="mp-error" class="alert fail" hidden></div>

    <div class="alert info">
      <div style="flex:1">
        <div class="alert-title">Where models are configured</div>
        <div class="alert-desc">Model identifiers live in each target repo's <span class="mono">WORKFLOW.md</span> (and <span class="mono">PLANNING.md</span>) front matter, not in the orchestrator. This page summarizes the <em>provider</em> and <em>region</em> chosen per project. Edit the model itself in the target repo.</div>
      </div>
    </div>

    <div class="kpi-grid" id="mp-kpis" hidden>
      <div class="kpi"><div class="kpi-label">Projects</div><div class="kpi-value" id="kpi-mp-projects">0</div></div>
      <div class="kpi"><div class="kpi-label">Anthropic</div><div class="kpi-value" id="kpi-mp-anthropic">0</div></div>
      <div class="kpi"><div class="kpi-label">Bedrock</div><div class="kpi-value" id="kpi-mp-bedrock">0</div></div>
      <div class="kpi"><div class="kpi-label">Bedrock regions</div><div class="kpi-value" id="kpi-mp-regions">0</div></div>
    </div>

    <div class="card">
      <div class="card-header">
        <h2 class="card-title">Per-project providers</h2>
        <div class="card-subtitle">Edit a row's provider on the Projects page.</div>
      </div>
      <div class="card-body tight">
        <table class="tbl">
          <thead>
            <tr><th>Team</th><th>Repo</th><th>Provider</th><th>Region</th><th>Planning</th><th>Runner</th></tr>
          </thead>
          <tbody id="mp-rows"></tbody>
        </table>
        <div id="mp-empty" class="hidden text-tertiary" style="padding:12px">No projects configured. Add one on the Projects page.</div>
      </div>
    </div>
  </div>
</section>`;

export const modelsAndProvidersScript = `(function () {
  async function loadModelsAndProviders() {
    const errorEl = document.getElementById('mp-error');
    const kpisEl = document.getElementById('mp-kpis');
    const emptyEl = document.getElementById('mp-empty');
    const rowsEl = document.getElementById('mp-rows');
    const subtitleEl = document.getElementById('mp-subtitle');

    errorEl.hidden = true;

    const res = await window.api('/api/mappings');
    if (!res.ok) {
      let msg = 'Failed to load mappings';
      try {
        const data = await res.json();
        if (data && data.error) msg += ': ' + data.error;
      } catch (_) {}
      errorEl.innerHTML = '<div class="alert-title">Failed to load mappings</div><div class="alert-desc">' + window.esc(msg) + '</div>';
      errorEl.hidden = false;
      kpisEl.hidden = true;
      emptyEl.classList.add('hidden');
      rowsEl.innerHTML = '';
      subtitleEl.textContent = '—';
      return;
    }

    const mappings = await res.json();
    renderKpis(mappings);
    renderRows(mappings);
    const count = Object.keys(mappings).length;
    renderSubtitle(count);
  }

  function renderKpis(mappings) {
    const entries = Object.values(mappings);
    const total = entries.length;
    const anthropic = entries.filter(function (m) { return m.provider !== 'bedrock'; }).length;
    const bedrock = entries.filter(function (m) { return m.provider === 'bedrock'; }).length;
    const regions = new Set(entries.filter(function (m) { return m.provider === 'bedrock' && m.awsRegion; }).map(function (m) { return m.awsRegion; })).size;

    document.getElementById('kpi-mp-projects').textContent = String(total);
    document.getElementById('kpi-mp-anthropic').textContent = String(anthropic);
    document.getElementById('kpi-mp-bedrock').textContent = String(bedrock);
    document.getElementById('kpi-mp-regions').textContent = String(regions);
    document.getElementById('mp-kpis').hidden = false;
  }

  function renderRows(mappings) {
    const entries = Object.entries(mappings).sort(function (a, b) { return a[0].localeCompare(b[0]); });
    const emptyEl = document.getElementById('mp-empty');
    const rowsEl = document.getElementById('mp-rows');

    if (entries.length === 0) {
      emptyEl.classList.remove('hidden');
    } else {
      emptyEl.classList.add('hidden');
    }

    rowsEl.innerHTML = '';
    for (const [teamKey, m] of entries) {
      let regionCell;
      if (m.provider === 'bedrock' && m.awsRegion) {
        regionCell = '<td class="mono text-secondary">' + window.esc(m.awsRegion) + '</td>';
      } else if (m.provider === 'bedrock') {
        regionCell = '<td><span class="badge fail">missing</span></td>';
      } else {
        regionCell = '<td><span class="text-tertiary">—</span></td>';
      }

      const planningKind = m.planningEnabled ? 'success' : 'neutral';
      const planningLabel = m.planningEnabled ? 'enabled' : 'disabled';
      const autoText = (m.planningEnabled && m.autoApprovePlans)
        ? '<span class="text-tertiary" style="margin-left:6px;font-size:11.5px">· auto-approve</span>'
        : '';

      const runnerKind = m.executionMode === 'fly-machines' ? 'success' : 'info';

      const tr = document.createElement('tr');
      tr.innerHTML =
        '<td><span class="mono">' + window.esc(teamKey) + '</span></td>' +
        '<td><span class="mono">' + window.esc(m.owner) + '/' + window.esc(m.repo) + '</span></td>' +
        '<td><span class="badge ' + (m.provider === 'bedrock' ? 'warn' : 'info') + '">' + window.esc(m.provider) + '</span></td>' +
        regionCell +
        '<td><span class="badge ' + planningKind + '">' + planningLabel + '</span>' + autoText + '</td>' +
        '<td><span class="badge ' + runnerKind + '">' + window.esc(m.executionMode) + '</span></td>';
      rowsEl.appendChild(tr);
    }
  }

  function renderSubtitle(count) {
    const subtitleEl = document.getElementById('mp-subtitle');
    subtitleEl.textContent = count + ' project' + (count === 1 ? '' : 's') + ' configured';
  }

  window.loadModelsAndProviders = loadModelsAndProviders;
  window.registerPage('models', function () { loadModelsAndProviders(); setInterval(loadModelsAndProviders, 60000); });
})();`;
