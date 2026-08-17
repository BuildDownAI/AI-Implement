export const deploymentsHtml = `
<section data-page="deployments" hidden>
  <header class="page-header">
    <div class="page-header-left">
      <h1 class="page-title">Deployments</h1>
      <div class="page-subtitle">Release a new version of this orchestrator — dispatch pauses until in-flight work drains</div>
    </div>
    <div class="page-header-actions">
      <button class="btn btn-sm" onclick="loadDeployments()">↻ Refresh</button>
    </div>
  </header>
  <div class="page-body">
    <div id="deployments-error" hidden></div>

    <div class="kpi-grid" id="deployments-kpis" style="grid-template-columns: 1fr">
      <div class="kpi">
        <div class="kpi-label">Availability <span class="badge neutral" id="kpi-deploy-badge">—</span></div>
        <div class="kpi-value"><span id="kpi-deploy-commit">—</span><span class="kpi-unit" id="kpi-deploy-checked"></span></div>
        <div class="kpi-trend" id="kpi-deploy-source"></div>
      </div>
      <div class="kpi" id="deployments-status-kpi" hidden>
        <div class="kpi-label">Deploy status <span class="badge neutral" id="kpi-deploy-status-badge">—</span></div>
        <div class="kpi-value"><span id="kpi-deploy-status">—</span><span class="kpi-unit" id="kpi-deploy-status-unit"></span></div>
        <div class="kpi-trend" id="kpi-deploy-dispatch"></div>
      </div>
    </div>

    <div id="deployments-cta" hidden style="text-align: center">
      <div style="display: inline-flex; flex-direction: column; align-items: center; gap: 8px">
        <button class="btn btn-accent btn-lg" id="deployments-deploy-btn" onclick="window.triggerDeploy()">Deploy now</button>
        <div class="kpi-trend text-secondary" style="justify-content: center; max-width: 46ch">New dispatches pause immediately, and in-flight work drains before the build starts.</div>
      </div>
    </div>

    <div id="deployments-not-configured" class="alert warn" hidden>
      <div style="flex:1">
        <div class="alert-title">Self-deploy not configured</div>
        <div class="alert-desc">This orchestrator cannot deploy itself. Set <span class="mono">FLY_DEPLOY_TOKEN</span> and ensure the image was built with the <span class="mono">AI_IMPLEMENT_SOURCE_*</span> build args stamped in.</div>
      </div>
    </div>
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

  function short(sha) { return sha ? sha.slice(0, 7) : ''; }

  function plural(count, noun) {
    return count + '\u00a0' + noun + (count === 1 ? '' : 's');
  }

  // Every badge in the app carries a .dot child: .badge .dot sizes it, .badge.<kind> .dot
  // colours it, and .badge.running .dot is where the pulse animation lives. The class
  // alone renders a dotless pill, so the span is opt-in markup that is easy to drop.
  // Routing every badge through here is what stops that recurring on this page.
  function setBadge(el, kind, label) {
    el.className = 'badge ' + kind;
    el.innerHTML = '<span class="dot"></span>' + window.esc(label);
  }

  // a static https:// prefix with escAttr on the path segments
  function commitLink(repo, sha) {
    if (!repo || !sha) return '';
    // .mono sets font-size: 11.5px as well as the family, and wins the cascade against
    // .kpi-value — so the family is set here directly to keep the SHAs at value size.
    return '<a class="text-accent" style="font-family: var(--font-mono)" href="https://github.com/' + window.escAttr(repo)
      + '/commit/' + window.escAttr(sha) + '" target="_blank">' + window.esc(short(sha)) + '</a>';
  }

  // One box, two severities: reading status can fail transiently while the page stays
  // usable, but a refused deploy is a real failure. .warning/.error are the house pair.
  function showMessage(kind, text) {
    const el = document.getElementById('deployments-error');
    el.className = kind;
    el.textContent = text;
    el.hidden = false;
  }

  function clearMessage() {
    document.getElementById('deployments-error').hidden = true;
  }

  async function loadDeployments() {
    clearMessage();

    let data;
    try {
      const res = await window.api('/api/deployment-status');
      if (!res.ok) {
        let message = 'Unknown error';
        try { const body = await res.json(); message = body.error || message; } catch (e) { /* ignore */ }
        showMessage('warning', 'Could not read deployment status — ' + message);
        return;
      }
      data = await res.json();
    } catch (err) {
      showMessage('warning', 'Could not read deployment status — ' + String(err));
      return;
    }

    const configured = !!data.configured;
    const available = data.available;
    const held = !!data.held;
    const inFlight = Array.isArray(data.inFlight) ? data.inFlight : [];

    // With self-deploy off the banner is the whole page — availability and status
    // describe an action this orchestrator cannot take.
    document.getElementById('deployments-not-configured').hidden = configured;
    document.getElementById('deployments-kpis').hidden = !configured;

    document.getElementById('deployments-cta').hidden = !configured || held || available !== true;

    // Deploy status is only meaningful once a deploy is under way, so the whole tile appears with the hold 
    const statusKpi = document.getElementById('deployments-status-kpi');
    const statusBadge = document.getElementById('kpi-deploy-status-badge');
    const statusEl = document.getElementById('kpi-deploy-status');
    const statusUnit = document.getElementById('kpi-deploy-status-unit');
    const dispatchEl = document.getElementById('kpi-deploy-dispatch');
    statusKpi.hidden = !held;
    if (held) {
      if (inFlight.length > 0) {
        setBadge(statusBadge, 'warn', 'Draining');
        statusEl.textContent = inFlight.map(function (w) { return plural(w.count, w.kind); }).join(', ');
        statusUnit.textContent = 'waiting for in-flight work to finish';
      } else {
        setBadge(statusBadge, 'running', 'Building');
        statusEl.textContent = 'All in-flight work drained';
        statusUnit.textContent = 'building and releasing the new image';
      }
      // Identical in both phases deliberately: the pause is a property of deploying,
      // not of a phase, so varying the wording would imply it varies with the phase.
      dispatchEl.textContent = 'New dispatches are paused until the deploy completes.';
    }

    // Availability is the least of the three signals here, so it rides in the label as
    // a tag. The commits it was derived from are the value.
    const badgeEl = document.getElementById('kpi-deploy-badge');
    if (available === true) {
      setBadge(badgeEl, 'warn', 'Available');
    } else if (available === false) {
      setBadge(badgeEl, 'success', 'Up to date');
    } else {
      setBadge(badgeEl, 'neutral', 'Unknown');
    }

    // Built from whichever commits resolved rather than branching on the verdict:
    // two differing commits render as a comparison, equal ones collapse to one, and
    // an unstamped running commit leaves just the head — no case needs special text.
    const links = [];
    if (data.runningCommit) links.push(commitLink(data.repo, data.runningCommit));
    if (data.headCommit && data.headCommit !== data.runningCommit) {
      links.push(commitLink(data.repo, data.headCommit));
    }
    document.getElementById('kpi-deploy-commit').innerHTML = links.length ? links.join(' → ') : '—';
    document.getElementById('kpi-deploy-checked').textContent =
      data.checkedAt ? 'checked ' + fmtAgo(data.checkedAt) : 'not yet checked';

    const source = [];
    if (data.repo) source.push(data.repo);
    if (data.branch) source.push(data.branch);
    document.getElementById('kpi-deploy-source').textContent = source.join(' · ');

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
  }

  async function triggerDeploy() {
    // Native confirm is this codebase's gate for consequential actions — destroying a
    // machine and deleting a secret both use it. A .modal would read better but its
    // only current user is the stepper, with its own open/close wiring.
    if (!confirm('Deploy now? New dispatches pause immediately and in-flight work drains before the build starts.')) return;
    clearMessage();
    const btn = document.getElementById('deployments-deploy-btn');
    btn.disabled = true;
    try {
      const res = await window.api('/api/deploy', { method: 'POST' });
      if (!res.ok && res.status !== 401) {
        let message = 'Deploy failed to start';
        try { const body = await res.json(); message = body.error || message; } catch (e) { /* ignore */ }
        showMessage('error', 'Deploy failed to start — ' + message);
      }
    } catch (err) {
      showMessage('error', 'Deploy failed to start — ' + String(err));
    } finally {
      // finally, not the success path: returning early there left the button dead
      // whenever a fast failure cleared the hold before the next poll could hide it.
      btn.disabled = false;
      loadDeployments();
    }
  }

  window.loadDeployments = loadDeployments;
  window.triggerDeploy = triggerDeploy;
  window.registerPage('deployments', function () { loadDeployments(); setInterval(loadDeployments, 30000); });
})();
`;
