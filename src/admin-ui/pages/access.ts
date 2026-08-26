export const accessHtml = `
<section data-page="access" hidden>
  <header class="page-header">
    <div class="page-header-left">
      <h1 class="page-title">Access</h1>
      <div class="page-subtitle">Who may sign in to this orchestrator</div>
    </div>
    <div class="page-header-actions">
      <span id="access-dirty" class="badge warn hidden" style="margin-right:8px"><span class="dot"></span>unsaved changes</span>
      <button class="btn btn-accent btn-sm" id="access-save" onclick="saveAccess()" disabled>Save changes</button>
    </div>
  </header>
  <div class="page-body">
    <div id="access-unreadable" class="error hidden" style="margin-bottom:12px">
      The allowlist could not be read, so sign-in is denied until it can be. Nothing here can be edited and no change has been lost.
    </div>
    <div id="access-readonly" class="warning hidden" style="margin-bottom:12px">
      Signed in with an access code, so this list is read-only &#x2014; a change here could not be attributed to anyone. Sign in with SSO to edit it.
    </div>
    <div id="access-seed" class="warning hidden" style="margin-bottom:12px">
      Nobody can sign in. Set <span class="mono">OAUTH_ALLOWED_DOMAINS</span> or <span class="mono">OAUTH_ALLOWED_EMAILS</span> on this app and restart &#x2014; once someone can sign in with SSO, this page takes over from there.
    </div>

    <div class="card">
      <div class="card-header">
        <h2 class="card-title">Sign-in allowlist</h2>
      </div>
      <div class="card-body">
        <div class="field-hint" style="margin-bottom:8px">A domain admits everyone at that domain as a user. Only an email can be an admin.</div>
        <table class="tbl">
          <thead><tr><th>Type</th><th>Email / Domain</th><th>Role</th><th>Added</th><th></th></tr></thead>
          <tbody id="access-body"></tbody>
        </table>
        <div id="access-empty" class="empty hidden">No entries.</div>

        <div id="access-banner" class="alert hidden" style="margin-top:12px">
          <span class="alert-icon">&#x25CF;</span>
          <div>
            <div class="alert-title" id="access-banner-title"></div>
            <div class="alert-desc" id="access-banner-desc"></div>
          </div>
        </div>

        <div id="access-editor" style="display:flex;gap:6px;align-items:flex-end;flex-wrap:wrap;margin-top:10px">
          <div class="field" style="min-width:110px">
            <label class="field-label">Type</label>
            <select class="input" id="access-new-kind" onchange="onAccessKindChange()">
              <option value="address">Email</option>
              <option value="domain">Domain</option>
            </select>
          </div>
          <div class="field" style="flex:1;min-width:220px">
            <label class="field-label">Email / Domain</label>
            <input class="input mono" id="access-new-value" placeholder="name@example.com">
          </div>
          <div class="field" style="min-width:110px">
            <label class="field-label">Role</label>
            <select class="input" id="access-new-role">
              <option value="user">user</option>
              <option value="admin">admin</option>
            </select>
          </div>
          <button class="btn btn-accent btn-sm" onclick="addAccessEntry()" style="align-self:flex-end">+ Add</button>
        </div>
        <div class="field-hint">Roles are stored now and take effect when the Admin/User split ships.</div>
        <div id="access-error" class="error hidden"></div>
      </div>
    </div>

    <div class="card">
      <div class="card-header"><h2 class="card-title">Recent access changes</h2></div>
      <div class="card-body">
        <table class="tbl">
          <thead><tr><th>When</th><th>Who</th><th>Change</th></tr></thead>
          <tbody id="access-changes-body"></tbody>
        </table>
        <div id="access-changes-empty" class="empty hidden">No changes recorded yet.</div>
      </div>
    </div>
  </div>
</section>
`;

export const accessScript = `
(function () {
  // saved is slimmed for comparison against the draft; stored keeps the database rows whole,
  // because only they carry addedAt.
  var state = { source: null, env: [], saved: [], stored: [], changes: [], draft: [], canEdit: false, you: null };
  // Stored kinds stay 'address'/'domain'; the page speaks the operator's words.
  var TYPE_LABEL = { address: 'Email', domain: 'Domain' };

  function slim(e) { return { kind: e.kind, value: e.value, role: e.role }; }

  function signature(list) {
    return list.map(function (e) { return e.kind + ':' + e.value + ':' + e.role; }).sort().join('|');
  }

  function isDirty() { return signature(state.draft) !== signature(state.saved); }

  function addedLabel(e) {
    var match = null;
    for (var i = 0; i < state.stored.length; i++) {
      if (state.stored[i].kind === e.kind && state.stored[i].value === e.value) match = state.stored[i];
    }
    if (!match || !match.addedAt) return '\\u2014';
    return new Date(match.addedAt).toLocaleDateString();
  }

  function renderBanner(blocked) {
    var banner = document.getElementById('access-banner');
    var title = document.getElementById('access-banner-title');
    var desc = document.getElementById('access-banner-desc');
    if (blocked === 'unreadable') {
      banner.classList.add('hidden');
      return;
    }
    banner.classList.remove('hidden', 'warn', 'info');
    if (state.source === 'env') {
      banner.classList.add('warn');
      title.textContent = 'Allowlist source: Environment variables';
      desc.textContent = 'OAUTH_ALLOWED_DOMAINS and OAUTH_ALLOWED_EMAILS are in force. Saving hands control to this list \\u2014 the environment values stop being consulted while it has entries.';
    } else if (state.env.length) {
      banner.classList.add('warn');
      title.textContent = 'Allowlist source: Database';
      desc.textContent = 'OAUTH_ALLOWED_* are still set on this app and are no longer used. Clearing them removes a value that no longer reflects who can sign in.';
    } else {
      banner.classList.add('info');
      title.textContent = 'Allowlist source: Database';
      desc.textContent = 'This list is what decides who can sign in.';
    }
  }

  /** 'new', 'changed', or null — how this row differs from what is stored. */
  function pendingState(e) {
    var saved = null;
    for (var i = 0; i < state.saved.length; i++) {
      if (state.saved[i].kind === e.kind && state.saved[i].value === e.value) saved = state.saved[i];
    }
    if (!saved) return 'new';
    if (saved.role !== e.role) return 'changed';
    return null;
  }

  var ROW_CLASS = { 'new': 'row-new', 'changed': 'row-changed' };

  function renderRows(blocked) {
    var body = document.getElementById('access-body');
    document.getElementById('access-empty').classList.toggle('hidden', state.draft.length > 0);
    var readOnly = blocked !== null;
    body.innerHTML = state.draft.map(function (e, i) {
      // A domain cannot carry admin, so the control does not exist for a value that cannot take it.
      var role = (e.kind === 'domain' || readOnly)
        ? '<span class="text-tertiary">' + window.esc(e.role) + '</span>'
        : '<select class="input" onchange="setAccessRole(' + i + ', this.value)">'
          + '<option value="user"' + (e.role === 'user' ? ' selected' : '') + '>user</option>'
          + '<option value="admin"' + (e.role === 'admin' ? ' selected' : '') + '>admin</option>'
          + '</select>';
      var pending = pendingState(e);
      return '<tr' + (pending ? ' class="' + ROW_CLASS[pending] + '"' : '') + '>'
        + '<td>' + window.esc(TYPE_LABEL[e.kind] || e.kind) + '</td>'
        + '<td class="mono">' + window.esc(e.value) + '</td>'
        + '<td>' + role + '</td>'
        + '<td class="text-tertiary">' + window.esc(addedLabel(e)) + '</td>'
        + '<td style="text-align:right;white-space:nowrap">'
        + (readOnly ? '' : '<button class="btn btn-sm btn-danger" onclick="removeAccessEntry(' + i + ')">Remove</button>')
        + '</td>'
        + '</tr>';
    }).join('');
  }

  /** Returns markup, so the call site must not escape it \u2014 values are escaped here. */
  function summarize(change) {
    var before = {}, beforeRole = {}, after = {}, added = [], removed = [], roleChanges = [];
    change.before.forEach(function (e) {
      before[e.kind + ':' + e.value] = true;
      beforeRole[e.kind + ':' + e.value] = e.role;
    });
    change.after.forEach(function (e) {
      after[e.kind + ':' + e.value] = true;
      if (!before[e.kind + ':' + e.value]) added.push(e.value);
      var was = beforeRole[e.kind + ':' + e.value];
      if (was && was !== e.role) roleChanges.push(e.value + ': ' + was + ' \\u2192 ' + e.role);
    });
    change.before.forEach(function (e) { if (!after[e.kind + ':' + e.value]) removed.push(e.value); });
    var groups = [];
    if (added.length) groups.push(['added', added]);
    if (removed.length) groups.push(['removed', removed]);
    if (roleChanges.length) groups.push(['role changed', roleChanges]);
    if (!groups.length) return '<span class="text-tertiary">no effective change</span>';
    return groups.map(function (g) {
      return '<div style="display:flex;gap:10px;align-items:baseline;margin-top:2px">'
        + '<span class="text-tertiary" style="flex:none;min-width:96px">' + g[0] + ' ' + g[1].length + '</span>'
        + '<span>' + window.esc(g[1].join(', ')) + '</span>'
        + '</div>';
    }).join('');
  }

  function renderChanges() {
    var body = document.getElementById('access-changes-body');
    document.getElementById('access-changes-empty').classList.toggle('hidden', state.changes.length > 0);
    body.innerHTML = state.changes.map(function (c) {
      var who = c.actor || (c.action === 'recover' ? 'host recovery' : 'unattributed');
      return '<tr>'
        + '<td class="text-tertiary">' + window.esc(new Date(c.createdAt).toLocaleString()) + '</td>'
        + '<td>' + window.esc(who) + '</td>'
        + '<td>' + summarize(c) + '</td>'
        + '</tr>';
    }).join('');
  }

  /**
   * Why editing is unavailable, or null. An empty list denies everyone, so the only session that
   * can be looking at one is an access-code session — it is seeded from the environment, not here.
   */
  function blockedBecause() {
    if (!state.source) return 'unreadable';
    // Server-supplied rather than inferred: auth.ts populates the identity asynchronously, and
    // the router can reach this page first.
    if (!state.canEdit) return 'access-code';
    if (!state.saved.length && !state.draft.length) return 'seed';
    return null;
  }

  function render() {
    var blocked = blockedBecause();
    renderBanner(blocked);
    renderRows(blocked);
    renderChanges();
    var dirty = isDirty();
    document.getElementById('access-unreadable').classList.toggle('hidden', blocked !== 'unreadable');
    document.getElementById('access-readonly').classList.toggle('hidden', blocked !== 'access-code');
    document.getElementById('access-seed').classList.toggle('hidden', blocked !== 'seed');
    document.getElementById('access-editor').classList.toggle('hidden', blocked !== null);
    document.getElementById('access-save').disabled = blocked !== null || !dirty;
    document.getElementById('access-dirty').classList.toggle('hidden', blocked !== null || !dirty);
  }

  function showError(message) {
    var el = document.getElementById('access-error');
    el.textContent = message || '';
    el.classList.toggle('hidden', !message);
  }

  function apply(payload) {
    state.source = payload.source;
    state.env = payload.env || [];
    state.saved = (payload.entries || []).map(slim);
    state.stored = payload.stored || [];
    state.changes = payload.changes || [];
    state.canEdit = payload.canEdit === true;
    state.you = payload.you || null;
    // map(slim), not slice() — a shallow array copy would share the row objects, so editing a
    // role in the draft would silently edit the saved copy it is compared against.
    state.draft = state.saved.map(slim);
    render();
  }

  function onAccessKindChange() {
    var kind = document.getElementById('access-new-kind').value;
    var role = document.getElementById('access-new-role');
    // Keep the form from offering a combination the server will refuse.
    role.value = kind === 'domain' ? 'user' : role.value;
    role.disabled = kind === 'domain';
    document.getElementById('access-new-value').placeholder = kind === 'domain' ? 'example.com' : 'name@example.com';
  }
  window.onAccessKindChange = onAccessKindChange;

  function addAccessEntry() {
    var kind = document.getElementById('access-new-kind').value;
    var valueEl = document.getElementById('access-new-value');
    var value = valueEl.value.trim().toLowerCase();
    var role = kind === 'domain' ? 'user' : document.getElementById('access-new-role').value;
    if (!value) return showError(kind === 'domain' ? 'Enter a domain.' : 'Enter an email address.');
    // A hint, not the gate — the server re-checks with the stricter patterns and is authoritative.
    if (kind === 'address' && !/^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$/.test(value)) {
      return showError('"' + value + '" is not an email address.');
    }
    if (kind === 'domain' && !/^[^\\s@.]+(\\.[^\\s@.]+)+$/.test(value)) {
      return showError('"' + value + '" is not a domain.');
    }
    for (var i = 0; i < state.draft.length; i++) {
      if (state.draft[i].kind === kind && state.draft[i].value === value) return showError(value + ' is already listed.');
    }
    state.draft.push({ kind: kind, value: value, role: role });
    valueEl.value = '';
    showError('');
    render();
  }
  window.addAccessEntry = addAccessEntry;

  function removeAccessEntry(index) {
    state.draft.splice(index, 1);
    render();
  }
  window.removeAccessEntry = removeAccessEntry;

  function setAccessRole(index, role) {
    state.draft[index].role = role;
    render();
  }
  window.setAccessRole = setAccessRole;

  function wouldDemoteMe() {
    if (!state.you) return false;
    var email = state.you.toLowerCase();
    var isAdmin = function (list) {
      return list.some(function (e) { return e.kind === 'address' && e.value === email && e.role === 'admin'; });
    };
    return isAdmin(state.saved) && !isAdmin(state.draft);
  }

  async function saveAccess() {
    if (wouldDemoteMe() && !confirm("This removes your own admin access. You'll keep sign-in access but won't be able to edit this page after saving. Continue?")) return;
    showError('');
    var payload;
    try {
      var res = await window.api('/api/access', { method: 'POST', body: JSON.stringify({ entries: state.draft }) });
      payload = await res.json();
      if (!res.ok) return showError(payload.error || 'The list could not be saved.');
    } catch (e) {
      return showError('The list could not be saved.');
    }
    apply(payload);
  }
  window.saveAccess = saveAccess;

  async function loadAccess() {
    var payload;
    try {
      var res = await window.api('/api/access');
      if (!res.ok) return showError('Could not load the access list.');
      payload = await res.json();
    } catch (e) {
      return showError('Could not load the access list.');
    }
    // Outside the catch deliberately: a render fault is a bug, and reporting it as a failed
    // request sends the reader to the network tab.
    apply(payload);
  }

  window.registerPage('access', loadAccess);
})();
`;
