import { icon } from "../icons.js";
import { GRANT_BLOCKERS, PAGE_GROUPS, PAGE_LABELS } from "../sidebar.js";

export const accessHtml = `
<section data-page="access" hidden>
  <header class="page-header">
    <div class="page-header-left">
      <h1 class="page-title">Access</h1>
      <div class="page-subtitle">Who may sign in to this orchestrator, and what they can see</div>
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

    <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:16px">
      <button class="card card-action" id="access-editor" onclick="openAddEntry()">
        <span class="card-action-title">Add an entry${icon("chevronRight", 14)}</span>
        <span class="field-hint">A domain admits everyone at that domain as a user. Only an email can be an admin, and an email entry overrides the domain for that person.</span>
      </button>
      <button class="card card-action" id="grants-section" onclick="openGrantEditor()">
        <span class="card-action-title">Manage user page access${icon("chevronRight", 14)}</span>
        <span class="field-hint">Users always reach the MCP server. Choose which admin pages they can open as well &#x2014; the same set applies to every user.</span>
      </button>
    </div>

    <div class="card">
      <div class="card-header">
        <h2 class="card-title">Sign-in allowlist</h2>
      </div>
      <div class="card-body tight">
        <table class="tbl">
          <thead><tr><th>Type</th><th>Email / Domain</th><th>Role</th><th>Added</th><th></th></tr></thead>
          <tbody id="access-body"></tbody>
        </table>
        <div id="access-empty" class="empty hidden">No entries.</div>

        <div id="access-banner" class="alert hidden" style="margin:12px 14px 14px">
          <span class="alert-icon">&#x25CF;</span>
          <div>
            <div class="alert-title" id="access-banner-title"></div>
            <div class="alert-desc" id="access-banner-desc"></div>
          </div>
        </div>

      </div>
    </div>

    <div class="card">
      <div class="card-header"><h2 class="card-title">Recent access changes</h2></div>
      <div class="card-body tight">
        <table class="tbl">
          <thead><tr><th>When</th><th>Who</th><th>Change</th></tr></thead>
          <tbody id="access-changes-body"></tbody>
        </table>
        <div id="access-changes-empty" class="empty hidden">No changes recorded yet.</div>
      </div>
    </div>
  </div>

  <div id="add-entry-modal" class="modal" hidden>
    <div class="modal-backdrop" onclick="closeAddEntry()"></div>
    <div class="modal-card" style="width:560px">
      <div style="padding:18px 24px 14px;border-bottom:1px solid var(--border-subtle);display:flex;justify-content:space-between;align-items:center">
        <div>
          <h2 style="font-size:15px;font-weight:600;margin:0">Add to the allowlist</h2>
          <div style="font-size:12px;color:var(--fg-tertiary);margin-top:2px">Added to the list on this page &#x2014; nothing takes effect until you save.</div>
        </div>
        <button class="btn btn-ghost btn-icon" onclick="closeAddEntry()" title="Close">&times;</button>
      </div>

      <div style="padding:20px 24px 0;display:flex;gap:8px;align-items:flex-end;flex-wrap:wrap">
        <div class="field" style="min-width:110px">
          <label class="field-label">Type</label>
          <select class="input" id="access-new-kind" onchange="onAccessKindChange()">
            <option value="address">Email</option>
            <option value="domain">Domain</option>
          </select>
        </div>
        <div class="field" style="flex:1;min-width:200px">
          <label class="field-label">Email / Domain</label>
          <input class="input mono" id="access-new-value" placeholder="name@example.com" onkeydown="if (event.key === 'Enter') stageAccessEntry()">
        </div>
        <div class="field" style="min-width:100px">
          <label class="field-label">Role</label>
          <select class="input" id="access-new-role">
            <option value="user">user</option>
            <option value="admin">admin</option>
          </select>
        </div>
        <button class="btn btn-icon" onclick="stageAccessEntry()" style="flex:none;color:var(--accent)" title="Add another">${icon("plus", 14)}</button>
      </div>

      <div style="padding:12px 24px 0"><div id="access-error" class="error hidden"></div></div>

      <div id="access-staged-section" style="padding:16px 24px 4px" hidden>
        <div class="field-label" id="access-staged-label"></div>
        <div id="access-staged" style="max-height:172px;overflow-y:auto;margin-top:4px"></div>
      </div>

      <div style="padding:14px 24px;border-top:1px solid var(--border-subtle);display:flex;justify-content:flex-end;gap:8px">
        <button class="btn btn-sm" onclick="closeAddEntry()">Cancel</button>
        <button class="btn btn-accent btn-sm" onclick="commitStagedEntries()">Add to list</button>
      </div>
    </div>
  </div>

  <div id="grant-modal" class="modal" hidden>
    <div class="modal-backdrop" onclick="closeGrantEditor()"></div>
    <div class="modal-card" style="display:flex;flex-direction:column;max-height:90vh">
      <div style="padding:18px 24px 14px;border-bottom:1px solid var(--border-subtle);display:flex;justify-content:space-between;align-items:center">
        <div>
          <h2 style="font-size:15px;font-weight:600;margin:0">Pages a user can see</h2>
          <div style="font-size:12px;color:var(--fg-tertiary);margin-top:2px">Admins see everything. A user sees only what is ticked here, plus the MCP server.</div>
        </div>
        <button class="btn btn-ghost btn-icon" onclick="closeGrantEditor()" title="Close">&times;</button>
      </div>

      <div style="padding:20px 24px;flex:1;overflow-y:auto">
        <div id="grant-list"></div>
        <details style="margin-top:20px">
          <summary class="alert warn" style="cursor:pointer;list-style:none">
            <span class="alert-icon">!</span>
            <div>
              <div class="alert-title">Some pages can never be granted</div>
              <div class="alert-desc">They carry credentials or infrastructure control. Open this to see which, and why.</div>
            </div>
          </summary>
          <div id="grant-blocked" style="margin-top:10px"></div>
        </details>
      </div>

      <div style="padding:14px 24px;border-top:1px solid var(--border-subtle);display:flex;align-items:center;gap:8px">
        <div id="grant-error" class="error hidden" style="flex:1;margin:0"></div>
        <div style="flex:1"></div>
        <button class="btn btn-sm" onclick="closeGrantEditor()">Cancel</button>
        <button class="btn btn-accent btn-sm" onclick="saveGrants()">Save</button>
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
    // Server-supplied rather than inferred: whether a change can be attributed to someone is the
    // server's rule, and re-deriving it here would let the two drift.
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
    // Same gate as the allowlist editor: an access-code session has no actor to attribute a grant to.
    document.getElementById('grants-section').classList.toggle('hidden', blocked !== null);
    document.getElementById('access-save').disabled = blocked !== null || !dirty;
    document.getElementById('access-dirty').classList.toggle('hidden', blocked !== null || !dirty);
  }

  function showError(message) {
    var el = document.getElementById('access-error');
    el.textContent = message || '';
    el.classList.toggle('hidden', !message);
  }

  // Held here rather than in state.draft so Cancel genuinely discards: an entry reaches the page's
  // list only when the modal is committed.
  var staged = [];

  function renderStaged() {
    document.getElementById('access-staged-section').hidden = staged.length === 0;
    document.getElementById('access-staged-label').textContent =
      staged.length === 1 ? '1 entry to add' : staged.length + ' entries to add';
    document.getElementById('access-staged').innerHTML = staged.map(function (e, i) {
      return '<div class="checkbox-row" style="cursor:default">'
        + '<span class="text-tertiary" style="flex:none;min-width:48px">' + window.esc(TYPE_LABEL[e.kind] || e.kind) + '</span>'
        + '<span class="mono" style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis">' + window.esc(e.value) + '</span>'
        + '<span class="text-tertiary" style="flex:none">' + window.esc(e.role) + '</span>'
        + '<button class="btn btn-sm btn-danger" style="flex:none" onclick="unstageAccessEntry(' + i + ')" title="Remove">&times;</button>'
        + '</div>';
    }).join('');
  }

  function openAddEntry() {
    staged = [];
    document.getElementById('access-new-value').value = '';
    showError('');
    renderStaged();
    document.getElementById('add-entry-modal').hidden = false;
    document.getElementById('access-new-value').focus();
  }
  window.openAddEntry = openAddEntry;

  function closeAddEntry() { document.getElementById('add-entry-modal').hidden = true; }
  window.closeAddEntry = closeAddEntry;

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

  /** Validates the form and appends it to the staged list. Returns false without staging on error. */
  function stageAccessEntry() {
    var kind = document.getElementById('access-new-kind').value;
    var valueEl = document.getElementById('access-new-value');
    var value = valueEl.value.trim().toLowerCase();
    var role = kind === 'domain' ? 'user' : document.getElementById('access-new-role').value;
    if (!value) { showError(kind === 'domain' ? 'Enter a domain.' : 'Enter an email address.'); return false; }
    // A hint, not the gate — the server re-checks with the stricter patterns and is authoritative.
    if (kind === 'address' && !/^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$/.test(value)) {
      showError('"' + value + '" is not an email address.');
      return false;
    }
    if (kind === 'domain' && !/^[^\\s@.]+(\\.[^\\s@.]+)+$/.test(value)) {
      showError('"' + value + '" is not a domain.');
      return false;
    }
    var listed = state.draft.concat(staged);
    for (var i = 0; i < listed.length; i++) {
      if (listed[i].kind === kind && listed[i].value === value) { showError(value + ' is already listed.'); return false; }
    }
    staged.push({ kind: kind, value: value, role: role });
    valueEl.value = '';
    valueEl.focus();
    showError('');
    renderStaged();
    return true;
  }
  window.stageAccessEntry = stageAccessEntry;

  function unstageAccessEntry(index) {
    staged.splice(index, 1);
    renderStaged();
  }
  window.unstageAccessEntry = unstageAccessEntry;

  function commitStagedEntries() {
    // Forgiving on purpose: a value typed and not yet added would otherwise be lost on the click
    // most people read as "add it". An invalid one reports and blocks the commit.
    var typed = document.getElementById('access-new-value').value.trim();
    if ((typed || !staged.length) && !stageAccessEntry()) return;
    staged.forEach(function (e) { state.draft.push(e); });
    closeAddEntry();
    render();
  }
  window.commitStagedEntries = commitStagedEntries;

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

  // Rendered in from sidebar.ts: the client names pages, the server decides which are grantable.
  var PAGE_LABELS = ${JSON.stringify(PAGE_LABELS)};
  var PAGE_GROUPS = ${JSON.stringify(PAGE_GROUPS)};
  var GRANT_BLOCKERS = ${JSON.stringify(GRANT_BLOCKERS)};

  var grants = { granted: [], grantable: [], draft: [] };

  /** Keys in sidebar order, split under their nav group so the modal reads like the sidebar. */
  function byGroup(keys) {
    var out = [];
    keys.forEach(function (key) {
      var group = PAGE_GROUPS[key] || 'Other';
      var bucket = out.filter(function (b) { return b.group === group; })[0];
      if (!bucket) { bucket = { group: group, keys: [] }; out.push(bucket); }
      bucket.keys.push(key);
    });
    return out;
  }

  function groupLabel(text) {
    return '<div class="nav-section-label" style="margin:14px 0 2px">' + window.esc(text) + '</div>';
  }

  function renderGrantEditor() {
    document.getElementById('grant-list').innerHTML = byGroup(grants.grantable).map(function (b) {
      return groupLabel(b.group) + b.keys.map(function (key) {
        var i = grants.grantable.indexOf(key);
        var on = grants.draft.indexOf(key) !== -1;
        return '<label class="checkbox-row">'
          + '<input type="checkbox" style="width:auto"' + (on ? ' checked' : '') + ' onchange="toggleGrant(' + i + ')">'
          + '<span>' + window.esc(PAGE_LABELS[key] || key) + '</span>'
          + '</label>';
      }).join('');
    }).join('');

    document.getElementById('grant-blocked').innerHTML = byGroup(Object.keys(GRANT_BLOCKERS)).map(function (b) {
      return groupLabel(b.group) + b.keys.map(function (key) {
        return '<div class="checkbox-row text-tertiary" style="cursor:default">'
          + '<span>' + window.esc(PAGE_LABELS[key] || key) + '</span>'
          + '</div>'
          + '<div class="kpi-trend text-secondary" style="margin-left:24px">' + window.esc(GRANT_BLOCKERS[key]) + '</div>';
      }).join('');
    }).join('');
  }

  function toggleGrant(index) {
    var key = grants.grantable[index];
    var at = grants.draft.indexOf(key);
    if (at === -1) grants.draft.push(key); else grants.draft.splice(at, 1);
  }
  window.toggleGrant = toggleGrant;

  function openGrantEditor() {
    // Copied on open and discarded on cancel, so closing without saving genuinely reverts.
    grants.draft = grants.granted.slice();
    showGrantError('');
    renderGrantEditor();
    document.getElementById('grant-modal').hidden = false;
  }
  window.openGrantEditor = openGrantEditor;

  function closeGrantEditor() { document.getElementById('grant-modal').hidden = true; }
  window.closeGrantEditor = closeGrantEditor;

  function showGrantError(message) {
    var el = document.getElementById('grant-error');
    el.textContent = message || '';
    el.classList.toggle('hidden', !message);
  }

  function applyGrants(payload) {
    grants.granted = payload.granted || [];
    grants.grantable = payload.grantable || [];
  }

  async function saveGrants() {
    var payload;
    try {
      var res = await window.api('/api/access-grants', { method: 'POST', body: JSON.stringify({ pages: grants.draft }) });
      payload = await res.json();
      if (!res.ok) return showGrantError(payload.error || 'Grants could not be saved.');
    } catch (e) {
      return showGrantError('Grants could not be saved.');
    }
    applyGrants(payload);
    closeGrantEditor();
  }
  window.saveGrants = saveGrants;

  async function loadGrants() {
    try {
      var res = await window.api('/api/access-grants');
      if (res.ok) applyGrants(await res.json());
    } catch (e) { /* the summary stays blank rather than claiming a state it does not know */ }
  }

  document.addEventListener('keydown', function (ev) {
    if (ev.key !== 'Escape') return;
    if (!document.getElementById('add-entry-modal').hidden) closeAddEntry();
    else if (!document.getElementById('grant-modal').hidden) closeGrantEditor();
  });

  window.registerPage('access', function () { loadAccess(); loadGrants(); });
})();
`;
