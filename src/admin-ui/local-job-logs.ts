export const localJobLogsHtml = `
<dialog id="local-job-logs-dialog" aria-labelledby="local-job-logs-title" style="width:1000px">
  <div class="md-header">
    <h2 id="local-job-logs-title" style="margin:0;font-size:18px">Local runner logs</h2>
    <button id="local-job-logs-close" type="button" class="btn btn-ghost" aria-label="Close logs">&times;</button>
  </div>
  <div class="md-body">
    <div style="display:flex;align-items:center;gap:12px">
      <p id="local-job-logs-status" role="status" class="text-tertiary" style="margin:0;flex:1"></p>
      <button id="local-job-logs-refresh" type="button" class="btn btn-sm">Refresh</button>
    </div>
    <p id="local-job-logs-error" role="alert" class="error" hidden></p>
    <pre id="local-job-logs-output" class="mono" style="white-space:pre-wrap;overflow-wrap:anywhere;font-size:12px;line-height:1.5;margin:0" hidden></pre>
  </div>
</dialog>`;

export const localJobLogsScript = `
(function () {
  const dialog = document.getElementById('local-job-logs-dialog');
  const output = document.getElementById('local-job-logs-output');
  const status = document.getElementById('local-job-logs-status');
  const error = document.getElementById('local-job-logs-error');
  const refresh = document.getElementById('local-job-logs-refresh');
  let jobId = null;
  let requestVersion = 0;

  async function loadLogs() {
    const version = ++requestVersion;
    refresh.disabled = true;
    error.hidden = true;
    status.textContent = 'Loading logs…';
    try {
      const res = await window.api('/api/jobs/' + encodeURIComponent(jobId) + '/logs');
      if (!res.ok) {
        throw new Error(res.status === 404
          ? 'Logs are unavailable. Older containers may have been removed before log saving was enabled.'
          : 'Could not load logs (' + res.status + '). Check that the local runner and Docker are available.');
      }
      const data = await res.json();
      if (version !== requestVersion || !dialog.open) return;
      output.textContent = data.logs || 'No output yet.';
      output.hidden = false;
      status.textContent = data.source === 'saved'
        ? 'Saved recent output · captured before container cleanup'
        : 'Recent container output · refresh to see updates';
    } catch (err) {
      if (version !== requestVersion || !dialog.open) return;
      output.hidden = true;
      status.textContent = '';
      error.textContent = err.message || 'Could not load logs.';
      error.hidden = false;
    } finally {
      if (version === requestVersion) refresh.disabled = false;
    }
  }

  window.openLocalJobLogs = function (id, identifier) {
    jobId = id;
    document.getElementById('local-job-logs-title').textContent = (identifier || 'Job ' + id) + ' · Local runner logs';
    output.textContent = '';
    output.hidden = true;
    if (!dialog.open) dialog.showModal();
    return loadLogs();
  };
  refresh.addEventListener('click', loadLogs);
  document.getElementById('local-job-logs-close').addEventListener('click', function () { dialog.close(); });
  dialog.addEventListener('close', function () { ++requestVersion; jobId = null; });
})();
`;
