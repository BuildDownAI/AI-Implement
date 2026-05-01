export const customizationsHtml = `
<section data-page="customizations" hidden>
  <header class="page-header">
    <div class="page-header-left">
      <h1 class="page-title">Customizations</h1>
      <div class="page-subtitle" id="customizations-subtitle">—</div>
    </div>
    <div class="page-header-actions">
      <button class="btn btn-sm" onclick="loadCustomizations()">↻ Refresh</button>
    </div>
  </header>
  <div class="page-body">
    <div id="customizations-error" class="alert fail" hidden></div>

    <div class="alert info">
      <div style="flex:1">
        <div class="alert-title">About custom/</div>
        <div class="alert-desc">Files under <span class="mono">custom/</span> override their upstream counterparts shipped with the orchestrator. The CI guard <span class="mono">protect-custom.yml</span> prevents upstream PRs from touching anything here. Edit these files directly in your fork.</div>
      </div>
    </div>

    <div class="card">
      <div class="card-header">
        <h2 class="card-title">Files in <span class="mono">custom/</span></h2>
        <div class="card-subtitle"><span id="customizations-root" class="mono text-tertiary"></span></div>
      </div>
      <div class="card-body tight">
        <table class="tbl">
          <thead>
            <tr><th>Path</th><th>Category</th><th>Status</th><th>Upstream</th><th style="text-align:right">Size</th><th style="text-align:right">Modified</th></tr>
          </thead>
          <tbody id="customizations-body"></tbody>
        </table>
        <div id="customizations-empty" class="hidden text-tertiary" style="padding:12px">No customizations. Files added under <span class="mono">custom/</span> will appear here.</div>
      </div>
    </div>
  </div>
</section>
`;

export const customizationsScript = `
(function () {
  function fmtSize(bytes) {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / 1024 / 1024).toFixed(1) + ' MB';
  }

  function fmtAgo(ms) {
    const diff = Date.now() - ms;
    const s = Math.floor(diff / 1000);
    if (s < 60) return s + 's ago';
    const m = Math.floor(s / 60);
    if (m < 60) return m + 'm ago';
    const h = Math.floor(m / 60);
    if (h < 24) return h + 'h ago';
    const d = Math.floor(h / 24);
    return d + 'd ago';
  }

  function renderRows(items) {
    const tbody = document.getElementById('customizations-body');
    const emptyEl = document.getElementById('customizations-empty');
    tbody.innerHTML = '';
    if (items.length === 0) {
      emptyEl.classList.remove('hidden');
      return;
    }
    emptyEl.classList.add('hidden');
    for (const item of items) {
      const { customPath, category, isShadow, upstreamPath, customSize, customMtime } = item;

      let categoryBadge;
      if (category === 'pipeline') {
        categoryBadge = '<span class="badge info">Pipeline</span>';
      } else if (category === 'step') {
        categoryBadge = '<span class="badge success">Step</span>';
      } else if (category === 'provider') {
        categoryBadge = '<span class="badge warn">Provider</span>';
      } else {
        categoryBadge = '<span class="badge neutral">Other</span>';
      }

      let statusCell;
      if (isShadow) {
        statusCell = '<span class="badge warn"><span class="dot"></span>Override</span>';
      } else if (category === 'other') {
        statusCell = '<span class="text-tertiary">—</span>';
      } else {
        statusCell = '<span class="badge info">Additive</span>';
      }

      const tr = document.createElement('tr');
      tr.innerHTML = '<td><span class="mono">' + window.esc(customPath) + '</span></td>'
        + '<td>' + categoryBadge + '</td>'
        + '<td>' + statusCell + '</td>'
        + '<td><span class="mono text-secondary">' + window.esc(upstreamPath ?? '—') + '</span></td>'
        + '<td style="text-align:right" class="mono text-tertiary">' + fmtSize(customSize) + '</td>'
        + '<td style="text-align:right" class="mono text-tertiary">' + fmtAgo(customMtime) + '</td>';
      tbody.appendChild(tr);
    }
  }

  function renderSubtitle(items) {
    const subtitle = document.getElementById('customizations-subtitle');
    if (!subtitle) return;
    const total = items.length;
    if (total === 0) {
      subtitle.textContent = '—';
      return;
    }
    const overrides = items.filter(function (i) { return i.isShadow; }).length;
    subtitle.textContent = total + ' file' + (total === 1 ? '' : 's')
      + (overrides > 0 ? ' · ' + overrides + ' override' + (overrides === 1 ? '' : 's') : '');
  }

  async function loadCustomizations() {
    const errorEl = document.getElementById('customizations-error');
    const subtitle = document.getElementById('customizations-subtitle');
    errorEl.hidden = true;
    const res = await window.api('/api/customizations');
    if (!res.ok) {
      let errorMsg = 'Unknown error';
      try {
        const data = await res.json();
        errorMsg = data.error || errorMsg;
      } catch (_) { /* ignore */ }
      errorEl.hidden = false;
      errorEl.innerHTML = '<div class="alert-title">Failed to load customizations</div><div class="alert-desc">' + window.esc(errorMsg) + '</div>';
      const emptyEl = document.getElementById('customizations-empty');
      if (emptyEl) emptyEl.classList.add('hidden');
      const tbody = document.getElementById('customizations-body');
      if (tbody) tbody.innerHTML = '';
      if (subtitle) subtitle.textContent = '—';
      return;
    }
    const data = await res.json();
    const items = data.customizations || [];
    const rootEl = document.getElementById('customizations-root');
    if (rootEl) rootEl.textContent = data.customRoot || '';
    renderRows(items);
    renderSubtitle(items);
  }

  window.loadCustomizations = loadCustomizations;
  window.registerPage('customizations', function () {
    loadCustomizations();
    setInterval(loadCustomizations, 60000);
  });
})();
`;
