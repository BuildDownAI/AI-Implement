export const journalHtml = `
<section data-page="journal" hidden>
  <header class="page-header">
    <div class="page-header-left">
      <h1 class="page-title">Journal</h1>
      <div class="page-subtitle">Look up a Restate invocation's journal by service and key, or by invocation id</div>
    </div>
  </header>
  <div class="page-body">
    <div class="card">
      <div class="card-body">
        <form id="journal-form" style="display:flex;gap:10px;align-items:flex-end;flex-wrap:wrap">
          <label>Service<br><input id="journal-service" class="input mono" placeholder="KgRefresh" autocomplete="off"></label>
          <label>Key<br><input id="journal-key" class="input mono" autocomplete="off"></label>
          <label>Invocation id<br><input id="journal-id" class="input mono" autocomplete="off"></label>
          <button type="submit" class="btn btn-primary btn-sm">Lookup</button>
        </form>
        <div id="journal-status" class="text-tertiary" style="margin-top:10px;font-size:12.5px"></div>
      </div>
    </div>
    <div class="card">
      <div class="card-body tight" id="journal-result" style="padding:12px" hidden></div>
    </div>
  </div>
</section>
`;

export const journalScript = `
(function () {
  async function lookup(ev) {
    if (ev) ev.preventDefault();
    const service = document.getElementById('journal-service').value.trim();
    const key = document.getElementById('journal-key').value.trim();
    const id = document.getElementById('journal-id').value.trim();
    const status = document.getElementById('journal-status');
    const result = document.getElementById('journal-result');
    result.hidden = true;
    result.innerHTML = '';
    if (id && (service || key)) { status.textContent = 'Give either an invocation id or service and key, not both.'; return; }
    if (!id && !(service && key)) { status.textContent = 'Give service and key, or an invocation id.'; return; }
    const qs = id ? 'id=' + encodeURIComponent(id) : 'service=' + encodeURIComponent(service) + '&key=' + encodeURIComponent(key);
    status.textContent = 'Looking up…';
    try {
      const res = await window.api('/api/restate/journal?' + qs);
      if (res.status === 404) { status.textContent = 'No journal found (not found, or retention has passed).'; return; }
      if (res.status === 503) { status.textContent = 'Restate is unavailable.'; return; }
      if (!res.ok) {
        let msg = 'Lookup failed (' + res.status + ')';
        try { const b = await res.json(); if (b && b.error) msg = String(b.error); } catch (e) { /* keep default */ }
        status.textContent = msg;
        return;
      }
      const data = await res.json();
      if (typeof window.renderRestateJournal !== 'function') { status.textContent = 'Journal renderer is not loaded.'; return; }
      status.textContent = '';
      window.renderRestateJournal(result, data);
      result.hidden = false;
    } catch (err) {
      status.textContent = 'Lookup failed: ' + (err && err.message ? err.message : err);
    }
  }

  window.registerPage('journal', function () {
    const form = document.getElementById('journal-form');
    if (form && !form.dataset.bound) {
      form.dataset.bound = '1';
      form.addEventListener('submit', lookup);
    }
  });
})();
`;
