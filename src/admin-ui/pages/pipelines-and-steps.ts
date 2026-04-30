export const pipelinesAndStepsHtml = `
<section data-page="pipelines" hidden>
  <header class="page-header">
    <div class="page-header-left">
      <h1 class="page-title">Pipelines &amp; steps</h1>
      <div class="page-subtitle" id="ps-subtitle">—</div>
    </div>
    <div class="page-header-actions">
      <button class="btn btn-sm" onclick="loadPipelinesAndSteps()">↻ Refresh</button>
    </div>
  </header>
  <div class="page-body">
    <div id="ps-error" class="alert fail" hidden></div>

    <div class="card">
      <div class="card-header">
        <h2 class="card-title">Pipeline definitions</h2>
        <div class="card-subtitle">Overridden definitions in <span class="mono">custom/pipelines/</span> take precedence.</div>
      </div>
      <div class="card-body" id="ps-pipelines-body"></div>
      <div id="ps-pipelines-empty" class="hidden text-tertiary" style="padding:12px">No pipelines configured.</div>
    </div>

    <div class="card">
      <div class="card-header">
        <h2 class="card-title">Step modules</h2>
        <div class="card-subtitle">Built-in steps under <span class="mono">src/pipeline/steps/</span> with optional overrides at <span class="mono">custom/steps/</span>.</div>
      </div>
      <div class="card-body tight">
        <table class="tbl">
          <thead><tr><th>Id</th><th>Built-in</th><th>Custom override</th><th>Status</th></tr></thead>
          <tbody id="ps-steps-body"></tbody>
        </table>
        <div id="ps-steps-empty" class="hidden text-tertiary" style="padding:12px">No step modules found.</div>
      </div>
    </div>
  </div>
</section>
`;

export const pipelinesAndStepsScript = `(function () {
  async function loadPipelinesAndSteps() {
    const errorEl = document.getElementById('ps-error');
    const pipelinesBody = document.getElementById('ps-pipelines-body');
    const stepsBody = document.getElementById('ps-steps-body');
    const subtitle = document.getElementById('ps-subtitle');
    let data;
    try {
      data = await window.api('/api/pipelines-steps');
    } catch (err) {
      if (errorEl) { errorEl.textContent = String(err); errorEl.hidden = false; }
      if (pipelinesBody) pipelinesBody.innerHTML = '';
      if (stepsBody) stepsBody.innerHTML = '';
      if (subtitle) subtitle.textContent = '—';
      const pe = document.getElementById('ps-pipelines-empty');
      const se = document.getElementById('ps-steps-empty');
      if (pe) pe.classList.add('hidden');
      if (se) se.classList.add('hidden');
      return;
    }
    if (errorEl) { errorEl.textContent = ''; errorEl.hidden = true; }
    renderPipelines(data.pipelines || []);
    renderSteps(data.steps || []);
    renderSubtitle(data.pipelines || [], data.steps || []);
  }

  function renderPipelines(pipelines) {
    const body = document.getElementById('ps-pipelines-body');
    const emptyEl = document.getElementById('ps-pipelines-empty');
    if (!body) return;
    if (!pipelines.length) {
      body.innerHTML = '';
      if (emptyEl) emptyEl.classList.remove('hidden');
      return;
    }
    if (emptyEl) emptyEl.classList.add('hidden');
    body.innerHTML = pipelines.map(function (p) {
      const overrideBadge = p.isOverride
        ? '<span class="badge warn"><span class="dot"></span>Override</span>'
        : '';
      const errorBadge = p.error ? '<span class="badge fail">Error</span>' : '';
      let inner;
      if (p.error) {
        inner = '<div class="alert fail" style="margin-bottom:8px"><div style="flex:1"><div class="alert-desc">' + window.esc(p.error) + '</div></div></div>';
      } else {
        const stepRows = (p.steps || []).map(function (s) {
          const overrideCell = s.hasCustomOverride
            ? '<span class="badge warn"><span class="dot"></span>Override</span>'
            : '<span class="text-tertiary">—</span>';
          return '<tr><td class="mono">' + window.esc(s.id) + '</td><td><span class="badge neutral">' + window.esc(s.type) + '</span></td><td class="mono text-secondary">' + window.esc(s.moduleId) + '</td><td>' + overrideCell + '</td></tr>';
        }).join('');
        inner = '<table class="tbl"><thead><tr><th>Step</th><th>Type</th><th>Module</th><th>Override</th></tr></thead><tbody>' + stepRows + '</tbody></table>';
      }
      return '<details class="card" style="background:var(--bg-elev);margin-bottom:8px;border:1px solid var(--border-subtle);border-radius:6px"><summary style="padding:10px 14px;cursor:pointer;display:flex;align-items:center;gap:10px;font-weight:500"><span class="mono">' + window.esc(p.id) + '</span><span class="text-tertiary mono" style="font-size:11.5px">' + window.esc(p.file) + '</span>' + overrideBadge + errorBadge + '</summary><div style="padding:0 14px 14px">' + inner + '</div></details>';
    }).join('');
  }

  function renderSteps(steps) {
    const body = document.getElementById('ps-steps-body');
    const emptyEl = document.getElementById('ps-steps-empty');
    if (!body) return;
    if (!steps.length) {
      body.innerHTML = '';
      if (emptyEl) emptyEl.classList.remove('hidden');
      return;
    }
    if (emptyEl) emptyEl.classList.add('hidden');
    body.innerHTML = steps.map(function (s) {
      let statusBadge;
      if (s.hasCustomOverride) {
        statusBadge = '<span class="badge warn"><span class="dot"></span>Override</span>';
      } else if (s.customPath && !s.builtinPath) {
        statusBadge = '<span class="badge info">Additive</span>';
      } else {
        statusBadge = '<span class="badge neutral">Built-in</span>';
      }
      const builtinCell = s.builtinPath ? '<span class="mono text-tertiary">' + window.esc(s.builtinPath) + '</span>' : '—';
      const customCell = s.customPath ? '<span class="mono text-tertiary">' + window.esc(s.customPath) + '</span>' : '—';
      return '<tr><td class="mono">' + window.esc(s.id) + '</td><td>' + builtinCell + '</td><td>' + customCell + '</td><td>' + statusBadge + '</td></tr>';
    }).join('');
  }

  function renderSubtitle(pipelines, steps) {
    const el = document.getElementById('ps-subtitle');
    if (!el) return;
    el.textContent = pipelines.length + ' pipeline' + (pipelines.length === 1 ? '' : 's') + ' · ' + steps.length + ' step module' + (steps.length === 1 ? '' : 's');
  }

  window.loadPipelinesAndSteps = loadPipelinesAndSteps;

  window.registerPage('pipelines', function () {
    loadPipelinesAndSteps();
    setInterval(loadPipelinesAndSteps, 60000);
  });
})();`;
