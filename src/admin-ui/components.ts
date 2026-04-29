export const componentsCss = `
/* ── App shell ──────────────────────────────────────────────── */
.app-shell {
  display: grid;
  grid-template-columns: 232px 1fr;
  min-height: 100%;
  background: var(--bg-app);
}

.sidebar {
  background: var(--bg-app);
  border-right: 1px solid var(--border-subtle);
  display: flex;
  flex-direction: column;
  padding: var(--sp-4);
  gap: var(--sp-1);
  position: sticky;
  top: 0;
  height: 100vh;
}

.sidebar-brand {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 6px 8px 14px;
  margin-bottom: 4px;
}
.sidebar-brand img {
  width: 24px;
  height: 24px;
  border-radius: 5px;
  object-fit: contain;
}
.sidebar-brand .brand-name {
  font-size: 13px;
  font-weight: 600;
  letter-spacing: -0.01em;
  color: var(--fg-primary);
}
.sidebar-brand .brand-meta {
  font-size: 10.5px;
  color: var(--fg-tertiary);
  font-family: var(--font-mono);
  letter-spacing: 0.02em;
}

.nav-section-label {
  font-size: 10.5px;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  color: var(--fg-tertiary);
  padding: 14px 8px 4px;
  font-weight: 500;
}

.nav-item {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 6px 8px;
  border-radius: var(--r-sm);
  color: var(--fg-secondary);
  font-size: 13px;
  cursor: pointer;
  text-decoration: none;
  font-weight: 450;
  position: relative;
}
.nav-item:hover { background: var(--bg-hover); color: var(--fg-primary); }
.nav-item.active {
  background: var(--bg-elev);
  color: var(--fg-primary);
  font-weight: 550;
  box-shadow: var(--shadow-sm);
  border: 1px solid var(--border-subtle);
}
.nav-item .nav-icon {
  width: 16px;
  height: 16px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  color: var(--fg-tertiary);
}
.nav-item.active .nav-icon { color: var(--accent); }
.nav-item .nav-count {
  margin-left: auto;
  font-size: 11px;
  color: var(--fg-tertiary);
  font-variant-numeric: tabular-nums;
  font-family: var(--font-mono);
}

.sidebar-footer {
  margin-top: auto;
  padding: var(--sp-2) var(--sp-2) 0;
  border-top: 1px solid var(--border-subtle);
}
.sidebar-user {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px;
  border-radius: var(--r-sm);
  cursor: pointer;
}
.sidebar-user:hover { background: var(--bg-hover); }
.sidebar-user .avatar {
  width: 24px; height: 24px;
  border-radius: 6px;
  background: var(--accent);
  color: var(--fg-on-accent);
  display: flex; align-items: center; justify-content: center;
  font-size: 11px; font-weight: 600;
}
.sidebar-user .user-name {
  font-size: 12.5px;
  font-weight: 500;
  color: var(--fg-primary);
}
.sidebar-user .user-email {
  font-size: 11px;
  color: var(--fg-tertiary);
}

/* ── Main content area ─────────────────────────────────────── */
.main {
  min-width: 0;
  display: flex;
  flex-direction: column;
  background: var(--bg-app);
}

.page-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 20px 32px 18px;
  gap: 16px;
  border-bottom: 1px solid var(--border-subtle);
  background: var(--bg-app);
}
.page-header-left { min-width: 0; }
.page-title {
  font-size: 17px;
  font-weight: 600;
  letter-spacing: -0.01em;
  color: var(--fg-primary);
  margin: 0;
}
.page-subtitle {
  font-size: 12.5px;
  color: var(--fg-tertiary);
  margin-top: 2px;
}
.page-header-actions {
  display: flex;
  align-items: center;
  gap: 8px;
}

.page-body {
  padding: 24px 32px 48px;
  display: flex;
  flex-direction: column;
  gap: 24px;
}

/* ── Buttons ───────────────────────────────────────────────── */
.btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 6px 12px;
  border-radius: var(--r-sm);
  border: 1px solid var(--border-default);
  background: var(--bg-elev);
  color: var(--fg-primary);
  font-size: 12.5px;
  font-weight: 500;
  cursor: pointer;
  transition: background 80ms ease, border-color 80ms ease, transform 80ms ease;
  white-space: nowrap;
  line-height: 1.4;
}
.btn:hover { background: var(--bg-hover); border-color: var(--border-strong); }
.btn:active { transform: translateY(0.5px); }
.btn:focus-visible { outline: none; box-shadow: var(--shadow-focus); }

.btn-primary {
  background: var(--fg-primary);
  color: var(--bg-elev);
  border-color: var(--fg-primary);
}
.btn-primary:hover { background: #2a2a28; border-color: #2a2a28; }
[data-theme="dark"] .btn-primary { background: var(--fg-primary); color: var(--bg-app); }
[data-theme="dark"] .btn-primary:hover { background: #fff; }

.btn-accent {
  background: var(--accent);
  color: var(--fg-on-accent);
  border-color: var(--accent);
}
.btn-accent:hover { background: var(--accent-hover); border-color: var(--accent-hover); }

.btn-ghost {
  background: transparent;
  border-color: transparent;
  color: var(--fg-secondary);
}
.btn-ghost:hover { background: var(--bg-hover); color: var(--fg-primary); }

.btn-danger {
  background: var(--bg-elev);
  border-color: var(--border-default);
  color: var(--st-fail-fg);
}
.btn-danger:hover { background: var(--st-fail-bg); border-color: var(--st-fail-fg); }

.btn-sm { padding: 3px 8px; font-size: 11.5px; gap: 4px; }
.btn-icon { padding: 6px; }
.btn-lg { padding: 9px 16px; font-size: 13px; }

/* ── Cards ─────────────────────────────────────────────────── */
.card {
  background: var(--bg-elev);
  border: 1px solid var(--border-subtle);
  border-radius: var(--r-md);
  overflow: hidden;
}
.card-header {
  padding: 14px 18px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  border-bottom: 1px solid var(--border-subtle);
}
.card-title {
  font-size: 13px;
  font-weight: 600;
  color: var(--fg-primary);
  margin: 0;
  letter-spacing: -0.005em;
}
.card-subtitle {
  font-size: 11.5px;
  color: var(--fg-tertiary);
  margin-top: 2px;
}
.card-body { padding: 16px 18px; }
.card-body.tight { padding: 0; }

/* ── KPI tiles ─────────────────────────────────────────────── */
.kpi-grid {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 12px;
}
.kpi {
  background: var(--bg-elev);
  border: 1px solid var(--border-subtle);
  border-radius: var(--r-md);
  padding: 16px 18px;
  display: flex;
  flex-direction: column;
  gap: 6px;
  position: relative;
  overflow: hidden;
}
.kpi-label {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 11.5px;
  font-weight: 500;
  color: var(--fg-tertiary);
  text-transform: uppercase;
  letter-spacing: 0.04em;
}
.kpi-value {
  font-size: 28px;
  font-weight: 600;
  letter-spacing: -0.02em;
  color: var(--fg-primary);
  font-variant-numeric: tabular-nums;
  font-family: var(--font-display);
  line-height: 1.1;
  display: flex;
  align-items: baseline;
  gap: 6px;
}
.kpi-value .kpi-unit {
  font-size: 14px;
  font-weight: 500;
  color: var(--fg-tertiary);
  letter-spacing: 0;
}
.kpi-trend {
  font-size: 11.5px;
  color: var(--fg-tertiary);
  font-variant-numeric: tabular-nums;
  display: flex;
  align-items: center;
  gap: 4px;
}
.kpi-trend.up { color: var(--st-success-fg); }
.kpi-trend.down { color: var(--st-fail-fg); }

/* ── Status badges & dots ──────────────────────────────────── */
.badge {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 2px 7px;
  border-radius: 999px;
  font-size: 11px;
  font-weight: 500;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
  line-height: 1.5;
}
.badge.tight { padding: 1px 6px; font-size: 10.5px; }
.badge .dot {
  width: 6px; height: 6px;
  border-radius: 50%;
  flex-shrink: 0;
}
.badge.running { background: var(--st-running-bg); color: var(--st-running-fg); }
.badge.running .dot { background: var(--st-running-dot); animation: pulse 2s ease-in-out infinite; }
.badge.success { background: var(--st-success-bg); color: var(--st-success-fg); }
.badge.success .dot { background: var(--st-success-dot); }
.badge.warn { background: var(--st-warn-bg); color: var(--st-warn-fg); }
.badge.warn .dot { background: var(--st-warn-dot); }
.badge.fail { background: var(--st-fail-bg); color: var(--st-fail-fg); }
.badge.fail .dot { background: var(--st-fail-dot); }
.badge.neutral { background: var(--st-neutral-bg); color: var(--st-neutral-fg); }
.badge.neutral .dot { background: var(--st-neutral-dot); }
.badge.info { background: var(--st-info-bg); color: var(--st-info-fg); }
.badge.info .dot { background: var(--st-info-dot); }

.badge.outline {
  background: transparent;
  border: 1px solid var(--border-default);
  color: var(--fg-secondary);
}

@keyframes pulse {
  0%, 100% { opacity: 1; transform: scale(1); }
  50% { opacity: 0.6; transform: scale(0.9); }
}

/* ── Tables ────────────────────────────────────────────────── */
.tbl {
  width: 100%;
  border-collapse: collapse;
  font-size: 12.5px;
}
.tbl thead th {
  text-align: left;
  padding: 8px 14px;
  font-weight: 500;
  font-size: 10.5px;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--fg-tertiary);
  border-bottom: 1px solid var(--border-subtle);
  background: var(--bg-sunken);
  white-space: nowrap;
}
.tbl tbody td {
  padding: 10px 14px;
  border-bottom: 1px solid var(--border-subtle);
  vertical-align: middle;
  color: var(--fg-primary);
  font-variant-numeric: tabular-nums;
}
.tbl tbody tr:last-child td { border-bottom: none; }
.tbl tbody tr {
  cursor: pointer;
  transition: background 80ms ease;
}
.tbl tbody tr:hover { background: var(--bg-hover); }
.tbl tbody tr.active { background: var(--bg-active); }
.tbl tbody tr.failed-row td { background: rgba(220, 38, 38, 0.025); }
.tbl tbody tr.failed-row:hover td { background: rgba(220, 38, 38, 0.05); }

.mono {
  font-family: var(--font-mono);
  font-size: 11.5px;
  font-feature-settings: 'zero', 'cv01';
}
.text-secondary { color: var(--fg-secondary); }
.text-tertiary { color: var(--fg-tertiary); }
.text-quaternary { color: var(--fg-quaternary); }

/* ── Phase pipeline ────────────────────────────────────────── */
.phase-pipe {
  display: inline-flex;
  align-items: center;
  gap: 0;
  font-size: 10.5px;
}
.phase-pipe .phase {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 2px 8px;
  border: 1px solid var(--border-default);
  background: var(--bg-elev);
  font-weight: 500;
  color: var(--fg-tertiary);
  position: relative;
}
.phase-pipe .phase:first-child {
  border-top-left-radius: 999px;
  border-bottom-left-radius: 999px;
  padding-left: 10px;
}
.phase-pipe .phase:last-child {
  border-top-right-radius: 999px;
  border-bottom-right-radius: 999px;
  padding-right: 10px;
}
.phase-pipe .phase + .phase { border-left: none; }
.phase-pipe .phase.done {
  background: var(--st-success-bg);
  color: var(--st-success-fg);
  border-color: transparent;
}
.phase-pipe .phase.active {
  background: var(--st-running-bg);
  color: var(--st-running-fg);
  border-color: transparent;
}
.phase-pipe .phase.fail {
  background: var(--st-fail-bg);
  color: var(--st-fail-fg);
  border-color: transparent;
}
.phase-pipe .phase .pdot {
  width: 5px; height: 5px;
  border-radius: 50%;
  background: currentColor;
  opacity: 0.8;
}
.phase-pipe .phase.active .pdot { animation: pulse 1.6s ease-in-out infinite; }

/* ── Form controls ─────────────────────────────────────────── */
.field {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.field-label {
  font-size: 11.5px;
  font-weight: 500;
  color: var(--fg-secondary);
}
.field-hint {
  font-size: 11px;
  color: var(--fg-tertiary);
  line-height: 1.45;
}
.input, .select, .textarea {
  width: 100%;
  background: var(--bg-elev);
  border: 1px solid var(--border-default);
  border-radius: var(--r-sm);
  padding: 7px 10px;
  font-size: 12.5px;
  color: var(--fg-primary);
  transition: border-color 80ms ease, box-shadow 80ms ease;
}
.input:focus, .select:focus, .textarea:focus {
  outline: none;
  border-color: var(--border-focus);
  box-shadow: var(--shadow-focus);
}
.input.mono { font-family: var(--font-mono); font-size: 11.5px; }
.textarea { resize: vertical; min-height: 80px; font-family: var(--font-mono); font-size: 11.5px; }

.checkbox-row {
  display: flex; align-items: center; gap: 8px;
  cursor: pointer;
  padding: 6px 0;
  font-size: 12.5px;
}

/* ── Toolbars / filters ────────────────────────────────────── */
.toolbar {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
.search {
  display: flex;
  align-items: center;
  gap: 6px;
  background: var(--bg-elev);
  border: 1px solid var(--border-default);
  border-radius: var(--r-sm);
  padding: 5px 10px;
  font-size: 12.5px;
  min-width: 240px;
}
.search input {
  border: none; outline: none; background: transparent;
  flex: 1; min-width: 0; padding: 0;
  color: var(--fg-primary);
}
.search input::placeholder { color: var(--fg-tertiary); }
.kbd {
  font-family: var(--font-mono);
  font-size: 10px;
  padding: 1px 5px;
  background: var(--bg-sunken);
  border: 1px solid var(--border-default);
  border-radius: 3px;
  color: var(--fg-tertiary);
}

.seg {
  display: inline-flex;
  background: var(--bg-sunken);
  border: 1px solid var(--border-subtle);
  border-radius: var(--r-sm);
  padding: 2px;
  gap: 1px;
}
.seg button {
  border: none;
  background: transparent;
  color: var(--fg-secondary);
  font-size: 11.5px;
  font-weight: 500;
  padding: 4px 10px;
  border-radius: 4px;
  cursor: pointer;
}
.seg button.active {
  background: var(--bg-elev);
  color: var(--fg-primary);
  box-shadow: var(--shadow-sm);
}

/* ── Drawer ────────────────────────────────────────────────── */
.drawer-backdrop {
  position: fixed; inset: 0;
  background: rgba(20, 20, 18, 0.32);
  backdrop-filter: blur(2px);
  z-index: 100;
  animation: fade-in 160ms ease;
}
[data-theme="dark"] .drawer-backdrop { background: rgba(0, 0, 0, 0.55); }
.drawer {
  position: fixed;
  top: 0; right: 0; bottom: 0;
  width: 720px;
  max-width: 92vw;
  background: var(--bg-elev);
  border-left: 1px solid var(--border-default);
  z-index: 101;
  display: flex;
  flex-direction: column;
  animation: slide-in 220ms cubic-bezier(0.2, 0.8, 0.2, 1);
  box-shadow: var(--shadow-lg);
}
@keyframes fade-in { from { opacity: 0; } to { opacity: 1; } }
@keyframes slide-in { from { transform: translateX(40px); opacity: 0; } to { transform: translateX(0); opacity: 1; } }

.drawer-header {
  padding: 20px 24px 16px;
  border-bottom: 1px solid var(--border-subtle);
}
.drawer-body { padding: 20px 24px; flex: 1; overflow-y: auto; }
.drawer-footer {
  padding: 14px 24px;
  border-top: 1px solid var(--border-subtle);
  display: flex;
  justify-content: space-between;
  gap: 8px;
}

/* ── Modal ─────────────────────────────────────────────────── */
.modal {
  position: fixed; inset: 0;
  display: flex; align-items: center; justify-content: center;
  z-index: 200;
  padding: 40px;
}
.modal-card {
  background: var(--bg-elev);
  border: 1px solid var(--border-default);
  border-radius: var(--r-lg);
  width: 720px; max-width: 100%;
  max-height: 90vh;
  display: flex;
  flex-direction: column;
  box-shadow: var(--shadow-lg);
  animation: slide-in 200ms cubic-bezier(0.2, 0.8, 0.2, 1);
}

/* ── Empty / placeholder states ────────────────────────────── */
.empty {
  padding: 40px;
  text-align: center;
  color: var(--fg-tertiary);
  font-size: 12.5px;
}

/* ── Section header ───────────────────────────────────────── */
.section-h {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 10px;
}
.section-h h3 {
  font-size: 12px;
  font-weight: 600;
  color: var(--fg-primary);
  margin: 0;
  text-transform: uppercase;
  letter-spacing: 0.06em;
}
.section-h .section-meta {
  font-size: 11.5px;
  color: var(--fg-tertiary);
}

/* ── Mini bar/chart ────────────────────────────────────────── */
.spark {
  display: flex;
  align-items: flex-end;
  gap: 2px;
  height: 36px;
}
.spark .bar {
  flex: 1;
  background: var(--accent);
  border-radius: 1px;
  opacity: 0.85;
  min-height: 2px;
}
.spark .bar.dim { background: var(--border-strong); opacity: 1; }

/* ── Capacity meter ────────────────────────────────────────── */
.meter {
  height: 6px;
  background: var(--bg-sunken);
  border-radius: 999px;
  overflow: hidden;
  position: relative;
}
.meter > .fill {
  height: 100%;
  background: var(--accent);
  border-radius: 999px;
  transition: width 240ms ease;
}
.meter.full > .fill { background: var(--st-fail-dot); }
.meter.warn > .fill { background: var(--st-warn-dot); }

/* ── Alert / blocker callout ───────────────────────────────── */
.alert {
  display: flex;
  gap: 12px;
  padding: 12px 14px;
  border-radius: var(--r-md);
  border: 1px solid var(--border-subtle);
  background: var(--bg-elev);
  align-items: flex-start;
}
.alert .alert-icon {
  width: 28px; height: 28px;
  border-radius: 6px;
  display: flex; align-items: center; justify-content: center;
  flex-shrink: 0;
}
.alert.warn .alert-icon { background: var(--st-warn-bg); color: var(--st-warn-fg); }
.alert.fail .alert-icon { background: var(--st-fail-bg); color: var(--st-fail-fg); }
.alert.info .alert-icon { background: var(--st-info-bg); color: var(--st-info-fg); }
.alert .alert-title {
  font-size: 12.5px;
  font-weight: 600;
  color: var(--fg-primary);
  margin-bottom: 2px;
}
.alert .alert-desc {
  font-size: 12px;
  color: var(--fg-secondary);
  line-height: 1.5;
}
.alert .alert-actions {
  margin-left: auto;
  display: flex; gap: 6px;
  align-items: center;
}

/* ── Timeline ──────────────────────────────────────────────── */
.timeline { display: flex; flex-direction: column; gap: 0; }
.tl-item {
  display: grid;
  grid-template-columns: 24px 1fr;
  gap: 12px;
  position: relative;
  padding-bottom: 16px;
}
.tl-item::before {
  content: '';
  position: absolute;
  left: 11px; top: 24px; bottom: 0;
  width: 1px;
  background: var(--border-default);
}
.tl-item:last-child::before { display: none; }
.tl-marker {
  width: 24px; height: 24px;
  border-radius: 50%;
  background: var(--bg-sunken);
  border: 2px solid var(--border-default);
  display: flex; align-items: center; justify-content: center;
  font-size: 10px;
  color: var(--fg-tertiary);
  z-index: 1;
}
.tl-marker.done { background: var(--st-success-bg); border-color: var(--st-success-dot); color: var(--st-success-fg); }
.tl-marker.active { background: var(--st-running-bg); border-color: var(--st-running-dot); color: var(--st-running-fg); }
.tl-marker.fail { background: var(--st-fail-bg); border-color: var(--st-fail-dot); color: var(--st-fail-fg); }
.tl-content {
  padding-top: 2px;
}
.tl-title {
  font-size: 12.5px;
  font-weight: 550;
  color: var(--fg-primary);
  display: flex;
  align-items: center;
  gap: 8px;
}
.tl-meta {
  font-size: 11px;
  color: var(--fg-tertiary);
  margin-top: 2px;
  font-variant-numeric: tabular-nums;
}
.tl-detail {
  margin-top: 6px;
  padding: 8px 10px;
  border-radius: var(--r-sm);
  background: var(--bg-sunken);
  font-family: var(--font-mono);
  font-size: 11px;
  color: var(--fg-secondary);
  line-height: 1.55;
  white-space: pre-wrap;
}
.tl-detail.fail { background: var(--st-fail-bg); color: var(--st-fail-fg); }

/* ── Stepper (new project flow) ────────────────────────────── */
.stepper {
  display: flex;
  align-items: center;
  gap: 0;
  padding: 16px 24px;
  border-bottom: 1px solid var(--border-subtle);
}
.stepper-step {
  display: flex; align-items: center; gap: 8px;
  padding: 4px 0;
  color: var(--fg-tertiary);
  font-size: 12px;
  font-weight: 500;
}
.stepper-step .num {
  width: 20px; height: 20px;
  border-radius: 50%;
  background: var(--bg-sunken);
  border: 1px solid var(--border-default);
  display: flex; align-items: center; justify-content: center;
  font-size: 11px;
  font-variant-numeric: tabular-nums;
  font-weight: 600;
}
.stepper-step.active { color: var(--fg-primary); }
.stepper-step.active .num {
  background: var(--accent);
  border-color: var(--accent);
  color: var(--fg-on-accent);
}
.stepper-step.done .num {
  background: var(--accent-soft);
  border-color: var(--accent-soft);
  color: var(--accent-soft-fg);
}
.stepper-divider {
  flex: 1;
  height: 1px;
  background: var(--border-subtle);
  margin: 0 14px;
}

/* ── Misc ──────────────────────────────────────────────────── */
.divider { height: 1px; background: var(--border-subtle); }
.row-ellipsis {
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 0;
}
td.col-grow { width: 100%; max-width: 0; }
td.col-grow > div { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }

/* small icon */
.svg-icon {
  width: 1em; height: 1em;
  flex-shrink: 0;
  stroke-width: 1.75;
}

/* ── Banner ───────────────────────────────────────────────── */
.banner {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 14px;
  background: var(--accent-soft);
  color: var(--accent-soft-fg);
  font-size: 12px;
  font-weight: 500;
  border-bottom: 1px solid var(--border-subtle);
}

/* canvas overrides */
deck-stage, .dc-artboard { background: var(--bg-app); }

/* ── Login page (existing) ─────────────────────────────────── */
.login-wrap {
  min-height: 100vh;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--bg-app);
}
.login-box {
  background: var(--bg-elev);
  border: 1px solid var(--border-subtle);
  border-radius: var(--r-lg);
  padding: 32px;
  width: 360px;
  box-shadow: var(--shadow-md);
}
.error {
  color: var(--st-fail-fg);
  background: var(--st-fail-bg);
  border: 1px solid var(--st-fail-dot);
  border-radius: var(--r-sm);
  padding: 8px 12px;
  font-size: 12.5px;
}
.hidden { display: none !important; }
.warning {
  color: var(--st-warn-fg);
  background: var(--st-warn-bg);
  border: 1px solid var(--st-warn-dot);
  border-radius: var(--r-sm);
  padding: 8px 12px;
  font-size: 12.5px;
}
`;
