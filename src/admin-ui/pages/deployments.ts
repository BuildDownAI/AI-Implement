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

    <div class="card" id="deployments-policy" hidden>
      <div class="card-header"><h2 class="card-title">When a deployment becomes available...</h2></div>
      <div class="card-body">
        <label class="checkbox-row" id="deployments-auto-row">
          <input type="checkbox" id="deployments-auto" onchange="window.refreshPolicyDirty()">
          <span>Deploy it automatically</span>
        </label>
        <div class="kpi-trend text-secondary" id="deployments-auto-hint" style="margin-left: 24px"></div>

        <label class="checkbox-row" id="deployments-notify-row">
          <input type="checkbox" id="deployments-notify" onchange="window.refreshPolicyDirty()">
          <span>Announce it to the notification webhook</span>
        </label>
        <div class="kpi-trend text-secondary" id="deployments-notify-hint" style="margin-left: 24px"></div>

        <div style="margin-top: 12px">
          <button class="btn btn-primary btn-sm" id="deployments-policy-save" onclick="window.saveDeployPolicy()" disabled>Save</button>
        </div>
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

  function autoHint(data, available, held) {
    if (!data.autoDeploy) {
      return 'Off — an available deployment is announced instead, and you decide when to release it.';
    }
    // A deploy in flight already has its own tile saying what is happening. Repeating
    // "applies from the next push" beside it reads as a contradiction, because the
    // commit being deployed is the one the per-commit guard has just consumed.
    if (held) return 'On — the deploy in progress above is the current one.';
    // One attempt per commit, so switching this on does not reach back for a commit
    // already announced. Name it, and name the way out.
    if (available === true && data.headCommit && data.headCommit === data.lastActedCommit) {
      return short(data.headCommit) + ' is available now but was already announced, so this applies from the next push. Use Deploy now to release it immediately.';
    }
    return 'A push to ' + (data.branch || 'the watched branch') + ' pauses dispatch and releases without asking.';
  }

  function notifyHint(data) {
    if (!data.notifyConfigured) return 'Unavailable — set NOTIFY_WEBHOOK_URL on the orchestrator to announce available deployments here.';
    if (data.autoDeploy) return 'No effect while automatic deploying is on — the restart notice already announces the pause.';
    return 'Sent once per commit, to the same webhook as run notifications.';
  }

  // What the server last told us. Kept so an edit can be detected, and so the 30s poll
  // does not silently revert a checkbox someone has ticked but not yet saved.
  let savedPolicy = null;

  function policyDirty() {
    if (!savedPolicy) return false;
    // A disabled announcement switch is not part of the form: it is forced unchecked
    // while no webhook exists, which would otherwise read as permanently dirty against
    // a stored true and leave Save lit forever.
    const notifyEl = document.getElementById('deployments-notify');
    const notifyChanged = !notifyEl.disabled && notifyEl.checked !== savedPolicy.notifyAvailable;
    return document.getElementById('deployments-auto').checked !== savedPolicy.autoDeploy || notifyChanged;
  }

  function refreshPolicyDirty() {
    document.getElementById('deployments-policy-save').disabled = !policyDirty();
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

    // The policy card follows the tiles: meaningless on an orchestrator that cannot
    // deploy itself, where the banner below is the whole story.
    document.getElementById('deployments-policy').hidden = !configured;

    const autoEl = document.getElementById('deployments-auto');
    const notifyEl = document.getElementById('deployments-notify');

    // Computed against the *previous* server state, before it is replaced below — the
    // poll must not overwrite a checkbox that is ticked and not yet saved.
    if (!policyDirty()) {
      autoEl.checked = !!data.autoDeploy;
      notifyEl.checked = !!data.notifyAvailable;
    }
    savedPolicy = { autoDeploy: !!data.autoDeploy, notifyAvailable: !!data.notifyAvailable };
    refreshPolicyDirty();

    // Nothing can be announced without somewhere to announce to, so the control says so
    // by being unavailable rather than by being a switch that quietly does nothing.
    // Unchecked as well as disabled: the stored value may be true, but nothing is being
    // announced, and a ticked-but-greyed box claims otherwise. The stored value is never
    // written from here, so it returns intact once a webhook exists.
    notifyEl.disabled = !data.notifyConfigured;
    if (!data.notifyConfigured) notifyEl.checked = false;
    const notifyRow = document.getElementById('deployments-notify-row');
    notifyRow.style.opacity = data.notifyConfigured ? '' : '0.5';
    notifyRow.style.cursor = data.notifyConfigured ? '' : 'not-allowed';

    document.getElementById('deployments-auto-hint').textContent = autoHint(data, available, held);
    document.getElementById('deployments-notify-hint').textContent = notifyHint(data);

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

  async function saveDeployPolicy() {
    clearMessage();
    // Sends only the two flags, and re-renders from the response rather than the
    // checkbox state — the server's view is what decides whether the other flag is
    // still meaningful, and an optimistic update would show a hint that is not true yet.
    // Omits the announcement flag while it is unavailable, so saving cannot overwrite a
    // stored preference with the forced-unchecked display. The endpoint takes a patch
    // precisely so one control can stay out of a write.
    const notifyEl = document.getElementById('deployments-notify');
    const patch = { autoDeploy: document.getElementById('deployments-auto').checked };
    if (!notifyEl.disabled) patch.notifyAvailable = notifyEl.checked;
    try {
      const res = await window.api('/api/deploy-policy', { method: 'POST', body: JSON.stringify(patch) });
      if (!res.ok && res.status !== 401) {
        showMessage('error', 'Could not save the deployment policy — the toggles may not reflect what is stored.');
      }
    } catch (err) {
      showMessage('error', 'Could not save the deployment policy — ' + String(err));
    }
    loadDeployments();
  }

  window.loadDeployments = loadDeployments;
  window.triggerDeploy = triggerDeploy;
  window.saveDeployPolicy = saveDeployPolicy;
  window.refreshPolicyDirty = refreshPolicyDirty;
  window.registerPage('deployments', function () { loadDeployments(); setInterval(loadDeployments, 30000); });
})();
`;
