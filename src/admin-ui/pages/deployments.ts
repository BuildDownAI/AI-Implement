export const deploymentsHtml = `
<section data-page="deployments" hidden>
  <header class="page-header">
    <div class="page-header-left">
      <h1 class="page-title">Deployments</h1>
      <div class="page-subtitle" id="deployments-subtitle">—</div>
    </div>
    <div class="page-header-actions">
      <button class="btn btn-sm" onclick="loadDeployments()">↻ Refresh</button>
      <button class="btn btn-primary btn-sm" id="deployments-deploy-btn" onclick="window.triggerDeploy()" hidden>Deploy now</button>
    </div>
  </header>
  <div class="page-body">
    <div id="deployments-error" class="alert fail" hidden></div>

    <div id="deployments-not-configured" class="alert warn" hidden>
      <div style="flex:1">
        <div class="alert-title">Self-deploy not configured</div>
        <div class="alert-desc">This orchestrator cannot deploy itself. Set <span class="mono">FLY_DEPLOY_TOKEN</span> and ensure the image was built with the <span class="mono">AI_IMPLEMENT_SOURCE_*</span> build args stamped in.</div>
      </div>
    </div>

    <div id="deployments-held-section" hidden>
      <div class="alert info">
        <div style="flex:1">
          <div class="alert-title" id="deployments-held-title">Deploy in progress</div>
          <div class="alert-desc" id="deployments-held-desc"></div>
        </div>
      </div>
    </div>

    <div class="kpi-grid" style="grid-template-columns: repeat(2, 1fr)">
      <div class="kpi">
        <div class="kpi-label">Availability</div>
        <div class="kpi-value" id="kpi-deploy-available">—</div>
        <div class="kpi-trend" id="kpi-deploy-checked"></div>
      </div>
      <div class="kpi">
        <div class="kpi-label">Deploy status</div>
        <div class="kpi-value" id="kpi-deploy-status">—</div>
      </div>
    </div>

    <div id="deployments-uptodate" class="empty" hidden>You are up to date. No deployment is available.</div>
  </div>
</section>
`;

export const deploymentsScript = `
(function () {
  function fmtAgo(ms) {
    const s = Math.floor((Date.now() - ms) / 1000);
    if (s < 60) return s + 's ago';
    const m = Math.floor(s / 60);
    if (m < 60) return m + 'm ago';
    const h = Math.floor(m / 60);
    return h + 'h ago';
  }

  async function loadDeployments() {
    const errEl = document.getElementById('deployments-error');
    errEl.hidden = true;

    let data;
    try {
      const res = await window.api('/api/deployment-status');
      if (!res.ok) {
        let message = 'Unknown error';
        try { const body = await res.json(); message = body.error || message; } catch (e) { /* ignore */ }
        errEl.innerHTML = '<div style="flex:1"><div class="alert-title">Failed to load deployment status</div><div class="alert-desc">' + window.esc(message) + '</div></div>';
        errEl.hidden = false;
        return;
      }
      data = await res.json();
    } catch (err) {
      errEl.innerHTML = '<div style="flex:1"><div class="alert-title">Failed to load deployment status</div><div class="alert-desc">' + window.esc(String(err)) + '</div></div>';
      errEl.hidden = false;
      return;
    }

    const configured = !!data.configured;
    const available = data.available;
    const held = !!data.held;
    const inFlight = Array.isArray(data.inFlight) ? data.inFlight : [];

    // Not-configured banner
    document.getElementById('deployments-not-configured').hidden = configured;

    // Deploy button — only when configured, not held, and a deployment is available
    const deployBtn = document.getElementById('deployments-deploy-btn');
    deployBtn.hidden = !configured || held || available !== true;

    // Held section — names what's still executing
    const heldSection = document.getElementById('deployments-held-section');
    const heldTitle = document.getElementById('deployments-held-title');
    const heldDesc = document.getElementById('deployments-held-desc');
    if (held) {
      heldSection.hidden = false;
      if (inFlight.length > 0) {
        heldTitle.textContent = 'Draining — waiting for in-flight work to complete';
        const summary = inFlight.map(function (w) {
          return window.esc(String(w.count)) + '\u00a0' + window.esc(w.kind);
        }).join(', ');
        heldDesc.innerHTML = 'Still executing: ' + summary + '. New dispatches are paused until these finish.';
      } else {
        heldTitle.textContent = 'Building';
        heldDesc.textContent = 'Work has drained. The new image is being built and released.';
      }
    } else {
      heldSection.hidden = true;
    }

    // Availability KPI — three states; null is always unknown, never up to date
    const availEl = document.getElementById('kpi-deploy-available');
    const checkedEl = document.getElementById('kpi-deploy-checked');
    if (available === true) {
      availEl.innerHTML = '<span class="badge warn"><span class="dot"></span>Available</span>';
    } else if (available === false) {
      availEl.innerHTML = '<span class="badge success"><span class="dot"></span>Up to date</span>';
    } else {
      availEl.innerHTML = '<span class="badge neutral"><span class="dot"></span>Unknown</span>';
    }
    checkedEl.textContent = data.checkedAt ? 'checked ' + fmtAgo(data.checkedAt) : 'not yet checked';

    // Deploy status KPI
    const statusEl = document.getElementById('kpi-deploy-status');
    if (held && inFlight.length > 0) {
      statusEl.innerHTML = '<span class="badge warn"><span class="dot"></span>Draining</span>';
    } else if (held) {
      statusEl.innerHTML = '<span class="badge running"><span class="dot"></span>Building</span>';
    } else {
      statusEl.innerHTML = '<span class="badge neutral">Idle</span>';
    }

    // Subtitle
    if (available === true) {
      document.getElementById('deployments-subtitle').textContent = 'deployment available';
    } else if (available === false) {
      document.getElementById('deployments-subtitle').textContent = 'up to date';
    } else {
      document.getElementById('deployments-subtitle').textContent = 'availability unknown';
    }

    // Nav indicator — shown only when a deployment is confirmed available
    const navCount = document.querySelector('[data-count="deploy-available"]');
    if (navCount) {
      if (available === true) {
        navCount.textContent = '1';
        navCount.hidden = false;
      } else {
        navCount.hidden = true;
      }
    }

    // Up-to-date empty state
    document.getElementById('deployments-uptodate').hidden = available !== false || held;
  }

  async function triggerDeploy() {
    const errEl = document.getElementById('deployments-error');
    errEl.hidden = true;
    const btn = document.getElementById('deployments-deploy-btn');
    btn.disabled = true;
    try {
      const res = await window.api('/api/deploy', { method: 'POST' });
      if (res.ok || res.status === 202) {
        loadDeployments();
        return;
      }
      if (res.status !== 401) {
        let message = 'Deploy failed to start';
        try { const body = await res.json(); message = body.error || message; } catch (e) { /* ignore */ }
        errEl.innerHTML = '<div style="flex:1"><div class="alert-title">Deploy failed to start</div><div class="alert-desc">' + window.esc(message) + '</div></div>';
        errEl.hidden = false;
      }
    } catch (err) {
      errEl.innerHTML = '<div style="flex:1"><div class="alert-title">Deploy failed to start</div><div class="alert-desc">' + window.esc(String(err)) + '</div></div>';
      errEl.hidden = false;
    }
    btn.disabled = false;
  }

  window.loadDeployments = loadDeployments;
  window.triggerDeploy = triggerDeploy;
  window.registerPage('deployments', function () { loadDeployments(); setInterval(loadDeployments, 30000); });
})();
`;
