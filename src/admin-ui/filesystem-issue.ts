export const filesystemIssueHtml = `
<dialog id="filesystem-issue-dialog" aria-labelledby="filesystem-issue-title" style="width:900px">
  <div class="md-header">
    <div>
      <div id="filesystem-issue-identifier" class="mono text-tertiary" style="font-size:12px;margin-bottom:6px"></div>
      <h2 id="filesystem-issue-title" style="margin:0;font-size:18px">Filesystem issue</h2>
    </div>
    <button id="filesystem-issue-close" type="button" class="btn btn-ghost" aria-label="Close issue">&times;</button>
  </div>
  <div class="md-body">
    <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
      <button id="filesystem-issue-ticket-tab" type="button" class="btn btn-sm" aria-pressed="true">Ticket Markdown</button>
      <button id="filesystem-issue-state-tab" type="button" class="btn btn-sm" aria-pressed="false">State JSON</button>
      <button id="filesystem-issue-retry" type="button" class="btn btn-sm btn-primary" hidden>Retry</button>
      <button id="filesystem-issue-refresh" type="button" class="btn btn-sm" style="margin-left:auto">Refresh</button>
    </div>
    <p id="filesystem-issue-status" role="status" class="text-tertiary" style="margin:0"></p>
    <p id="filesystem-issue-location" class="mono text-tertiary" style="margin:0;overflow-wrap:anywhere;font-size:12px"></p>
    <p id="filesystem-issue-retry-reason" class="text-tertiary" style="margin:0" hidden></p>
    <p id="filesystem-issue-error" role="alert" class="error" hidden></p>
    <section id="filesystem-issue-ticket-panel" aria-label="Ticket Markdown" hidden>
      <pre id="filesystem-issue-markdown" class="mono" style="white-space:pre-wrap;overflow-wrap:anywhere;font-size:13px;line-height:1.6;margin:0"></pre>
    </section>
    <section id="filesystem-issue-state-panel" aria-label="State JSON" hidden>
      <p id="filesystem-issue-state-path" class="mono text-tertiary" style="overflow-wrap:anywhere;font-size:12px"></p>
      <pre id="filesystem-issue-json" class="mono" style="white-space:pre-wrap;overflow-wrap:anywhere;font-size:12px;line-height:1.6;margin:0"></pre>
    </section>
  </div>
</dialog>`;

export const filesystemIssueScript = `
(function () {
  const dialog = document.getElementById('filesystem-issue-dialog');
  const ticketPanel = document.getElementById('filesystem-issue-ticket-panel');
  const statePanel = document.getElementById('filesystem-issue-state-panel');
  const ticketTab = document.getElementById('filesystem-issue-ticket-tab');
  const stateTab = document.getElementById('filesystem-issue-state-tab');
  const refresh = document.getElementById('filesystem-issue-refresh');
  const retry = document.getElementById('filesystem-issue-retry');
  const status = document.getElementById('filesystem-issue-status');
  const location = document.getElementById('filesystem-issue-location');
  const retryReason = document.getElementById('filesystem-issue-retry-reason');
  const error = document.getElementById('filesystem-issue-error');
  let activeIssue = null;
  let requestVersion = 0;
  let selectedPanel = 'ticket';
  let loaded = false;
  let loading = false;
  let retryInFlight = false;
  let issueDetail = null;

  function selectPanel(panel) {
    selectedPanel = panel;
    ticketTab.setAttribute('aria-pressed', String(panel === 'ticket'));
    stateTab.setAttribute('aria-pressed', String(panel === 'state'));
    ticketPanel.hidden = !loaded || panel !== 'ticket';
    statePanel.hidden = !loaded || panel !== 'state';
  }

  function locationLabel(value) {
    if (value === 'completed') return 'Completed archive';
    if (value === 'failed') return 'Failed archive';
    return 'Active queue';
  }

  function setRetryControls() {
    const failed = issueDetail && issueDetail.state && issueDetail.state.status === 'failed';
    retry.hidden = !failed;
    retryReason.hidden = true;
    retryReason.textContent = '';
    retry.title = '';
    if (!failed) {
      retry.disabled = true;
      return;
    }
    const blockedReason = issueDetail.retryBlockedReason || '';
    retry.disabled = loading || retryInFlight || !issueDetail.retryEligible;
    if (!issueDetail.retryEligible && blockedReason) {
      retry.title = blockedReason;
      retryReason.textContent = blockedReason;
      retryReason.hidden = false;
    }
  }

  async function responseError(res, fallback) {
    try {
      const body = await res.json();
      if (body && body.error) return body.error;
    } catch (_) {
      // Keep the clearer fallback when the response has no JSON body.
    }
    return fallback;
  }

  async function loadIssue(successStatus) {
    const version = ++requestVersion;
    loading = true;
    refresh.disabled = true;
    setRetryControls();
    error.hidden = true;
    status.textContent = 'Loading issue…';
    try {
      const res = await window.api('/api/filesystem-issue?issueId=' + encodeURIComponent(activeIssue));
      if (!res.ok) {
        throw new Error(res.status === 404 ? 'This issue is unavailable. Its ticket may have been removed or its files may be invalid.' : 'Could not load this issue (' + res.status + ').');
      }
      const data = await res.json();
      if (version !== requestVersion || !dialog.open) return;
      issueDetail = data;
      document.getElementById('filesystem-issue-identifier').textContent = data.issue.identifier;
      document.getElementById('filesystem-issue-title').textContent = data.issue.title;
      document.getElementById('filesystem-issue-markdown').textContent = data.markdown;
      document.getElementById('filesystem-issue-state-path').textContent = data.statePath;
      document.getElementById('filesystem-issue-json').textContent = data.state === null
        ? 'No state file yet. State is saved when the orchestrator starts processing this ticket.'
        : JSON.stringify(data.state, null, 2);
      status.textContent = successStatus || (data.state === null ? 'No saved state yet' : 'Status: ' + data.state.status + ' · Updated: ' + data.state.updatedAt);
      location.textContent = [data.ticketPath, data.location ? locationLabel(data.location) : null].filter(Boolean).join(' · ');
      loaded = true;
      selectPanel(selectedPanel);
      setRetryControls();
    } catch (err) {
      if (version !== requestVersion || !dialog.open) return;
      issueDetail = null;
      loaded = false;
      selectPanel(selectedPanel);
      status.textContent = '';
      location.textContent = '';
      error.textContent = err.message || 'Could not load this issue.';
      error.hidden = false;
      setRetryControls();
    } finally {
      if (version === requestVersion) {
        loading = false;
        refresh.disabled = false;
        setRetryControls();
      }
    }
  }

  async function retryIssue() {
    if (!activeIssue || loading || retryInFlight || !issueDetail || !issueDetail.retryEligible) return;
    const issueId = activeIssue;
    const version = ++requestVersion;
    retryInFlight = true;
    refresh.disabled = true;
    setRetryControls();
    error.hidden = true;
    status.textContent = 'Queueing retry…';
    try {
      const res = await window.api('/api/filesystem-issue/retry', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ issueId: issueId }),
      });
      if (version !== requestVersion || activeIssue !== issueId || !dialog.open) return;
      if (!res.ok) {
        throw new Error(await responseError(res, 'Could not retry this issue (' + res.status + ').'));
      }
      const data = await res.json();
      if (version !== requestVersion || activeIssue !== issueId || !dialog.open) return;
      if (!data || data.retried !== true) {
        throw new Error('Could not retry this issue.');
      }
      retryInFlight = false;
      await loadIssue('Queued for retry');
    } catch (err) {
      if (version !== requestVersion || activeIssue !== issueId || !dialog.open) return;
      status.textContent = issueDetail && issueDetail.state ? 'Status: ' + issueDetail.state.status + ' · Updated: ' + issueDetail.state.updatedAt : '';
      error.textContent = err.message || 'Could not retry this issue.';
      error.hidden = false;
    } finally {
      if (version === requestVersion) {
        retryInFlight = false;
        refresh.disabled = false;
        setRetryControls();
      }
    }
  }

  function openIssue(issueId) {
    activeIssue = issueId;
    loaded = false;
    loading = false;
    retryInFlight = false;
    issueDetail = null;
    selectPanel('ticket');
    document.getElementById('filesystem-issue-identifier').textContent = '';
    document.getElementById('filesystem-issue-title').textContent = 'Filesystem issue';
    location.textContent = '';
    setRetryControls();
    if (!dialog.open) dialog.showModal();
    return loadIssue();
  }

  ticketTab.addEventListener('click', function () { selectPanel('ticket'); });
  stateTab.addEventListener('click', function () { selectPanel('state'); });
  refresh.addEventListener('click', function () { loadIssue(); });
  retry.addEventListener('click', retryIssue);
  document.getElementById('filesystem-issue-close').addEventListener('click', function () { dialog.close(); });
  dialog.addEventListener('close', function () { ++requestVersion; activeIssue = null; issueDetail = null; });

  document.addEventListener('click', function (event) {
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    const anchor = event.target.closest && event.target.closest('a[href]');
    if (!anchor) return;
    const url = new URL(anchor.href, window.location.href);
    const issueId = url.searchParams.get('filesystemIssue');
    if (url.origin !== window.location.origin || url.pathname !== '/admin' || !issueId) return;
    event.preventDefault();
    openIssue(issueId);
  });

  // Called after authentication so direct links work without requesting data before login.
  window.openFilesystemIssueFromLocation = function () {
    const issueId = new URL(window.location.href).searchParams.get('filesystemIssue');
    if (issueId) return openIssue(issueId);
  };
})();
`;
