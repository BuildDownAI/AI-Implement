import { dispatchLogHtml } from "./pipelines.js";

export const kgPipelinesHtml = `
<section data-page="kg-pipelines" hidden>
  <header class="page-header">
    <div class="page-header-left">
      <h1 class="page-title">Knowledge Graph Pipelines</h1>
      <div class="page-subtitle">Refresh the knowledge graph and watch its runs</div>
    </div>
    <div class="page-header-actions">
      <button class="btn btn-sm" onclick="loadKgStatus(); loadKgMaterializeMode(); loadKgFlyMachine()">&#8635; Refresh</button>
    </div>
  </header>
  <div class="page-body">
    <div id="kg-pipelines-error" hidden></div>

    <div class="card" id="kg-refresh-card" hidden>
      <div class="card-header"><h2 class="card-title">Knowledge graph <span class="badge neutral" id="kg-refresh-badge">—</span></h2></div>
      <div class="card-body">
        <div class="kpi-trend" id="kg-refresh-stamp">Served graph stamp: —</div>
        <div class="kpi-trend text-secondary" id="kg-refresh-last"></div>
        <div class="kpi-trend text-secondary" id="kg-sidecar-status" hidden></div>
        <div style="margin-top: 12px">
          <button class="btn btn-sm" id="kg-refresh-btn" onclick="window.triggerKgRefresh()">Refresh graph now</button>
          <button class="btn btn-sm" id="kg-dry-run-btn" onclick="window.triggerKgRefresh(true)">Dry-run refresh</button>
          <button class="btn btn-sm" id="kg-accept-baseline-btn" onclick="window.triggerKgAcceptBaseline()">Accept new baseline &amp; refresh</button>
          <span class="kpi-trend text-secondary" style="margin-left: 8px">Refresh fetches the KG source repo's committed snapshot and restarts the sidecar — no deploy, no dispatch pause. Dry-run runs the same job with the push skipped and reports the guard table below; the served graph never changes. Accept new baseline pushes even if the guard table above shows a shrink — review it first.</span>
        </div>
        <div class="kpi-trend text-secondary" id="kg-dry-run-last" style="margin-top: 8px" hidden></div>
        <div style="margin-top: 12px; display:flex; align-items:center; gap:12px; flex-wrap:wrap">
          <span class="kpi-trend text-secondary">Materialize:</span>
          <span class="seg" id="kg-materialize-controls">
            <button class="btn btn-sm" id="btn-kg-materialize-rdflib" data-materialize="rdflib" onclick="window.setKgMaterializeDirect(false)">rdflib</button>
            <button class="btn btn-sm" id="btn-kg-materialize-direct" data-materialize="direct" onclick="window.setKgMaterializeDirect(true)">direct</button>
          </span>
          <span class="kpi-trend text-secondary" id="kg-materialize-source"></span>
        </div>
        <div style="margin-top: 12px; display:flex; align-items:center; gap:12px; flex-wrap:wrap" id="kg-fly-machine-controls">
          <span class="kpi-trend text-secondary">Fly machine:</span>
          <span class="seg">
            <button class="btn btn-sm" id="btn-kg-fly-cpu-shared" onclick="window.setKgFlyCpuKind('shared')">shared</button>
            <button class="btn btn-sm" id="btn-kg-fly-cpu-performance" onclick="window.setKgFlyCpuKind('performance')">performance</button>
          </span>
          <label class="kpi-trend text-secondary">CPUs <input type="number" id="kg-fly-cpus" min="1" max="16" step="1" style="width: 70px" oninput="window.refreshKgFlyDirty()"></label>
          <label class="kpi-trend text-secondary">Memory (MB) <input type="number" id="kg-fly-memory-mb" min="256" max="65536" step="1" style="width: 90px" oninput="window.refreshKgFlyDirty()"></label>
          <label class="kpi-trend text-secondary">Idle (hours) <input type="number" id="kg-fly-idle-hours" min="0" step="any" style="width: 80px" oninput="window.refreshKgFlyDirty()"></label>
          <button class="btn btn-sm" id="btn-kg-fly-save" disabled onclick="window.saveKgFlyMachine()">Save</button>
        </div>
        <div class="kpi-trend text-secondary" id="kg-fly-machine-effective"></div>
      </div>
    </div>
    ${dispatchLogHtml("kglog", { title: "Runs", emptyText: "No knowledge-graph refresh runs in the selected time range" })}
  </div>
</section>
`;

export const kgPipelinesScript = `
(function () {
  // Local copies of the Deployments page helpers; the message box here is #kg-pipelines-error.
  function setBadge(el, kind, label) {
    el.className = 'badge ' + kind;
    el.innerHTML = '<span class="dot"></span>' + window.esc(label);
  }

  function showMessage(kind, text) {
    const el = document.getElementById('kg-pipelines-error');
    el.className = kind;
    el.textContent = text;
    el.hidden = false;
  }

  async function loadKgStatus() {
    const card = document.getElementById('kg-refresh-card');
    try {
      const res = await window.api('/api/kg/status');
      if (res.status === 409) {
        const held = await res.json().catch(() => ({}));
        if (held.error === 'deploy-in-progress') {
          card.hidden = false;
          document.getElementById('kg-refresh-btn').disabled = true;
          document.getElementById('kg-dry-run-btn').disabled = true;
          document.getElementById('kg-accept-baseline-btn').disabled = true;
          document.getElementById('kg-refresh-last').textContent =
            'A deploy is in progress \u2014 the refresh status returns after it completes.';
          return;
        }
      }
      if (!res.ok) { card.hidden = true; return; }
      const data = await res.json();
      card.hidden = false;
      const badge = document.getElementById('kg-refresh-badge');
      // Use the stage field for fine-grained badge states; fall back to running for
      // older orchestrator responses that lack it.
      const stage = data.stage || (data.running ? 'checking' : 'idle');
      if (stage === 'checking') {
        setBadge(badge, 'running', 'checking');
      } else if (stage === 'ingest-running') {
        setBadge(badge, 'running', 'running');
      } else if (stage === 'snapshot-landed') {
        setBadge(badge, 'running', 'landing');
      } else if (stage === 'staging') {
        setBadge(badge, 'running', 'staging');
      } else if (stage === 'serving') {
        setBadge(badge, 'ok', 'serving');
      } else if (stage === 'reverted') {
        setBadge(badge, 'warn', 'reverted');
      } else if (stage === 'failed') {
        setBadge(badge, 'fail', 'failed');
      } else if (data.kgDegraded) {
        setBadge(badge, 'warn', 'degraded');
      } else if (data.lastRefresh?.gate === 'ingest-needed') {
        setBadge(badge, 'neutral', 'stale');
      } else {
        setBadge(badge, 'ok', 'serving');
      }
      document.getElementById('kg-refresh-stamp').textContent =
        'Served graph stamp: ' + (data.servedStamp || 'baked image graph');
      // Stage-specific in-progress text, otherwise show last-refresh summary.
      let progressText = '';
      if (stage === 'checking') progressText = 'Checking KG source repo for a newer snapshot\u2026';
      else if (stage === 'ingest-running') progressText = 'Runner job dispatched \u2014 waiting for snapshot commit\u2026';
      else if (stage === 'snapshot-landed') progressText = 'Snapshot commit confirmed \u2014 starting local staging\u2026';
      else if (stage === 'staging') progressText = 'Staging new graph overlay\u2026';
      const last = data.lastRefresh;
      const lastText = !last
        ? 'No refresh has run since boot.'
        : last.gate === 'ingest-needed'
        ? 'Last refresh: ' + last.detail
        : 'Last refresh: ' + (last.ok ? 'ok' : 'failed at gate "' + (last.gate || '?') + '"') + ' \u2014 ' + last.detail;
      document.getElementById('kg-refresh-last').textContent = progressText || lastText;
      // AII-650: surface the sidecar liveness probe (AII-648) next to the stage-based badge —
      // a sidecar can be "serving" per the stage above while the probe shows it rejecting calls.
      const sidecarEl = document.getElementById('kg-sidecar-status');
      if (data.kgUnavailable) {
        sidecarEl.textContent = '⚠️ KG sidecar not serving — ' + ((data.sidecar && data.sidecar.lastError) || 'unknown error');
        sidecarEl.hidden = false;
      } else if (data.sidecar && data.sidecar.checkedAt) {
        sidecarEl.textContent = 'KG sidecar: reachable';
        sidecarEl.hidden = false;
      } else {
        sidecarEl.hidden = true;
      }
      renderKgDryRun(document.getElementById('kg-dry-run-last'), data.lastDryRun);
      const busy = !!data.running || !!data.deployHeld;
      document.getElementById('kg-refresh-btn').disabled = busy;
      document.getElementById('kg-dry-run-btn').disabled = busy;
      document.getElementById('kg-accept-baseline-btn').disabled = busy;
    } catch (e) { card.hidden = true; }
  }

  // AII-635: the last dry-run's verdict and per-part table, shown only when the last
  // admin dry-run (get_kg_status lastDryRun, never lastRefresh). Cells are set with
  // textContent, never innerHTML.
  function renderKgDryRun(el, last) {
    el.textContent = '';
    if (!last) { el.hidden = true; return; }
    el.hidden = false;
    const head = document.createElement('div');
    head.textContent = 'Last dry-run (' + new Date(last.at).toLocaleString() + '): ' + last.detail;
    el.appendChild(head);
    const rows = Array.isArray(last.partTable) ? last.partTable : [];
    if (!rows.length) return;
    const table = document.createElement('table');
    table.className = 'table';
    table.style.marginTop = '6px';
    const thead = document.createElement('thead');
    const hr = document.createElement('tr');
    ['part', 'previous', 'new', 'delta'].forEach(function (h) {
      const th = document.createElement('th'); th.textContent = h; hr.appendChild(th);
    });
    thead.appendChild(hr);
    table.appendChild(thead);
    const tbody = document.createElement('tbody');
    rows.forEach(function (r) {
      const tr = document.createElement('tr');
      const prev = parseInt(r.prev, 10);
      const next = parseInt(r.new, 10);
      const delta = (isNaN(prev) || isNaN(next)) ? '' : ((next - prev >= 0 ? '+' : '') + String(next - prev));
      [r.part, r.prev, r.new, delta].forEach(function (v) {
        const td = document.createElement('td'); td.textContent = v == null ? '' : String(v); tr.appendChild(td);
      });
      tbody.appendChild(tr);
    });
    table.appendChild(tbody);
    el.appendChild(table);
  }

  // AII-635: dryRun=true posts { dryRun: true } so the rail runs with the push skipped
  // and reports the guard table on the card instead of changing the served graph.
  window.triggerKgRefresh = async function (dryRun) {
    const btn = document.getElementById('kg-refresh-btn');
    const dryBtn = document.getElementById('kg-dry-run-btn');
    btn.disabled = true;
    dryBtn.disabled = true;
    document.getElementById('kg-accept-baseline-btn').disabled = true;
    try {
      const res = dryRun
        ? await window.api('/api/kg/refresh', { method: 'POST', body: JSON.stringify({ dryRun: true }) })
        : await window.api('/api/kg/refresh', { method: 'POST' });
      if (!res.ok) showKgRefreshRefusal(res, await res.json().catch(function () { return {}; }));
    } catch (err) { showMessage('warning', 'Refresh failed \u2014 ' + String(err)); }
    setTimeout(loadKgStatus, 1000);
  };

  // One refusal-to-message mapping for all three refresh buttons (real, dry-run, accept-baseline):
  // the same preconditions (callback-unconfigured, deploy-in-progress, already-running) apply to each.
  function showKgRefreshRefusal(res, body) {
    if (res.status === 422 && body.precondition === 'callback-unconfigured') {
      showMessage('warning', 'Refresh requires a configured runner callback \u2014 set RUNNER_CALLBACK_BASE_URL and RUNNER_TOKEN_SECRET on the orchestrator.');
    } else if (res.status === 409 && body.error === 'deploy-in-progress') {
      showMessage('warning', 'A deploy is in progress \u2014 try again after it completes.');
    } else if (res.status === 409) {
      showMessage('warning', 'A refresh is already in progress.');
    } else {
      showMessage('warning', 'Refresh refused \u2014 ' + (body.error || String(res.status)));
    }
  }

  // AII-628: a one-shot override of the zero-shrink/50% push guards, gated by the same
  // native confirm() this page uses for every other consequential action (see "Deploy now").
  // A separate button/function from triggerKgRefresh rather than a third argument there,
  // so an operator reads the shrink table first and opts in deliberately.
  window.triggerKgAcceptBaseline = async function () {
    if (!confirm('Accept the new baseline? This pushes the snapshot even though a tracked part (issue.nt/comment.nt) shrank, overriding the zero-shrink/50% guard for this one refresh. Review the guard table above first.')) return;
    document.getElementById('kg-refresh-btn').disabled = true;
    document.getElementById('kg-dry-run-btn').disabled = true;
    document.getElementById('kg-accept-baseline-btn').disabled = true;
    try {
      const res = await window.api('/api/kg/refresh', { method: 'POST', body: JSON.stringify({ acceptNewBaseline: true }) });
      if (!res.ok) showKgRefreshRefusal(res, await res.json().catch(function () { return {}; }));
    } catch (err) { showMessage('warning', 'Refresh failed \u2014 ' + String(err)); }
    setTimeout(loadKgStatus, 1000);
  };

  async function loadKgMaterializeMode() {
    try {
      const res = await window.api('/api/kg/materialize-mode');
      if (!res.ok) return;
      const data = await res.json();
      const direct = !!data.direct;
      document.getElementById('btn-kg-materialize-rdflib').classList.toggle('btn-primary', !direct);
      document.getElementById('btn-kg-materialize-direct').classList.toggle('btn-primary', direct);
      document.getElementById('kg-materialize-source').textContent = '(' + data.source + ')';
    } catch (e) { /* transient \u2014 next poll retries */ }
  }

  window.setKgMaterializeDirect = async function (direct) {
    try {
      const res = await window.api('/api/kg/materialize-mode', { method: 'POST', body: JSON.stringify({ direct: direct }) });
      if (!res.ok && res.status !== 401) {
        const body = await res.json().catch(function () { return {}; });
        showMessage('warning', 'Could not change materialize mode \u2014 ' + (body.error || res.status));
      }
    } catch (err) {
      showMessage('warning', 'Could not change materialize mode \u2014 ' + String(err));
    }
    loadKgMaterializeMode();
  };

  // AII-1116: the kg-refresh FlyMachineProfile. Reads and writes go through the tools route;
  // a tool answer is { content: [{ text }], isError }, with a 400 carried inside the text.
  let savedKgFly = null;
  let kgFlyKind = null;

  function unwrapToolAnswer(res, body) {
    let status = res.status;
    let data = body;
    if (res.ok && body && Array.isArray(body.content)) {
      const text = body.content[0] && body.content[0].text;
      let parsed = null;
      try { parsed = JSON.parse(text); } catch (e) { /* plain-text error */ }
      if (body.isError) {
        status = /^forbidden/.test(String(text)) ? 403 : 500;
        data = { error: String(text) };
      } else if (parsed && parsed.status && parsed.body) {
        status = parsed.status;
        data = parsed.body;
      } else {
        data = parsed || {};
      }
    }
    return { ok: status >= 200 && status < 300, status: status, body: data || {} };
  }

  function formatKgIdle(ms) {
    const hours = ms / 3600000;
    if (hours >= 24 && hours % 24 === 0) return (hours / 24) + ' d';
    if (hours >= 1 && Number.isInteger(hours)) return hours + ' h';
    return Math.round(ms / 60000) + ' min';
  }

  function kgFlyInputs() {
    return {
      cpuKind: kgFlyKind,
      cpus: Number(document.getElementById('kg-fly-cpus').value),
      memoryMb: Number(document.getElementById('kg-fly-memory-mb').value),
      idleTimeoutMs: Math.round(Number(document.getElementById('kg-fly-idle-hours').value) * 3600000),
    };
  }

  function kgFlyChanges() {
    if (!savedKgFly) return {};
    const now = kgFlyInputs();
    const changes = {};
    ['cpuKind', 'cpus', 'memoryMb', 'idleTimeoutMs'].forEach(function (k) {
      if (now[k] !== savedKgFly[k]) changes[k] = now[k];
    });
    return changes;
  }

  function refreshKgFlyDirty() {
    document.getElementById('btn-kg-fly-save').disabled = Object.keys(kgFlyChanges()).length === 0;
  }

  function paintKgFlyKind() {
    document.getElementById('btn-kg-fly-cpu-shared').classList.toggle('btn-primary', kgFlyKind === 'shared');
    document.getElementById('btn-kg-fly-cpu-performance').classList.toggle('btn-primary', kgFlyKind === 'performance');
  }

  async function loadKgFlyMachine() {
    try {
      const res = await window.api('/api/tools/get_kg_status', { method: 'POST', body: JSON.stringify({ args: {} }) });
      if (!res.ok) return;
      const raw = await res.json();
      const fm = unwrapToolAnswer(res, raw).body.flyMachine;
      if (!fm || typeof fm.cpus !== 'number') return;
      document.getElementById('kg-fly-machine-effective').textContent =
        'next Fly run: ' + fm.cpuKind + ', ' + fm.cpus + ' CPU / ' + fm.memoryMb + ' MB, idle '
        + formatKgIdle(fm.idleTimeoutMs) + ' (' + fm.source + ')';
      // A poll must not overwrite values the admin is mid-edit on.
      if (savedKgFly && Object.keys(kgFlyChanges()).length) return;
      savedKgFly = { cpuKind: fm.cpuKind, cpus: fm.cpus, memoryMb: fm.memoryMb, idleTimeoutMs: fm.idleTimeoutMs };
      kgFlyKind = fm.cpuKind;
      paintKgFlyKind();
      document.getElementById('kg-fly-cpus').value = String(fm.cpus);
      document.getElementById('kg-fly-memory-mb').value = String(fm.memoryMb);
      document.getElementById('kg-fly-idle-hours').value = String(fm.idleTimeoutMs / 3600000);
      refreshKgFlyDirty();
    } catch (e) { /* transient \u2014 next poll retries */ }
  }

  window.setKgFlyCpuKind = function (kind) {
    kgFlyKind = kind;
    paintKgFlyKind();
    refreshKgFlyDirty();
  };
  window.refreshKgFlyDirty = refreshKgFlyDirty;

  window.saveKgFlyMachine = async function () {
    const changes = kgFlyChanges();
    if (!Object.keys(changes).length) return;
    const args = Object.assign({ pipeline: 'kg-refresh' }, changes);
    try {
      const res = await window.api('/api/tools/set_fly_machine_profile', { method: 'POST', body: JSON.stringify({ args: args }) });
      const out = unwrapToolAnswer(res, await res.json().catch(function () { return {}; }));
      if (out.status === 403) { showMessage('warning', 'admin only'); return; }
      if (!out.ok) {
        showMessage('warning', 'Could not change the Fly machine profile \u2014 ' + (out.body.error || out.status));
        return;
      }
      document.getElementById('kg-pipelines-error').hidden = true;
      savedKgFly = null;
      loadKgFlyMachine();
    } catch (err) {
      showMessage('warning', 'Could not change the Fly machine profile \u2014 ' + String(err));
    }
  };

  window.loadKgStatus = loadKgStatus;
  window.loadKgMaterializeMode = loadKgMaterializeMode;
  window.loadKgFlyMachine = loadKgFlyMachine;

  window.registerPage('kg-pipelines', function () {
    loadKgStatus();
    loadKgMaterializeMode();
    loadKgFlyMachine();
    setInterval(loadKgStatus, 15000);
    setInterval(loadKgMaterializeMode, 15000);
    setInterval(loadKgFlyMachine, 15000);
    // createDispatchLog comes from the Pipelines page script; the card works without it.
    if (window.createDispatchLog) window.createDispatchLog('kglog', { filter: function (e) { return e.phase === 'kg-refresh'; } }).start();
  });
})();
`;
