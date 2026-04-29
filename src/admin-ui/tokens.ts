export const tokensCss = `
/* ============================================================
   AI-Implement Admin — Design Tokens
   PE-stage internal ops aesthetic. Neutral grayscale + cool teal.
   ============================================================ */

:root {
  /* ── Color: light theme ───────────────────────────────────── */
  --bg-app: #fafaf9;
  --bg-elev: #ffffff;
  --bg-sunken: #f4f4f2;
  --bg-hover: #f0f0ee;
  --bg-active: #e8e8e6;

  --border-subtle: #ececea;
  --border-default: #e0e0dc;
  --border-strong: #c8c8c4;
  --border-focus: #14b8a6;

  --fg-primary: #1a1a19;
  --fg-secondary: #525250;
  --fg-tertiary: #8a8a86;
  --fg-quaternary: #b4b4af;
  --fg-on-accent: #ffffff;

  --accent: #0d9488;
  --accent-hover: #0f766e;
  --accent-soft: #ccfbf1;
  --accent-soft-fg: #115e59;

  /* status palette */
  --st-running-bg: #dbeafe;
  --st-running-fg: #1e40af;
  --st-running-dot: #2563eb;
  --st-success-bg: #d1fae5;
  --st-success-fg: #065f46;
  --st-success-dot: #059669;
  --st-warn-bg: #fef3c7;
  --st-warn-fg: #92400e;
  --st-warn-dot: #d97706;
  --st-fail-bg: #fee2e2;
  --st-fail-fg: #991b1b;
  --st-fail-dot: #dc2626;
  --st-neutral-bg: #f4f4f2;
  --st-neutral-fg: #525250;
  --st-neutral-dot: #8a8a86;
  --st-info-bg: #e0e7ff;
  --st-info-fg: #3730a3;
  --st-info-dot: #4f46e5;

  /* shadows */
  --shadow-sm: 0 1px 2px rgba(20, 20, 18, 0.04);
  --shadow-md: 0 1px 3px rgba(20, 20, 18, 0.06), 0 4px 12px rgba(20, 20, 18, 0.04);
  --shadow-lg: 0 4px 12px rgba(20, 20, 18, 0.08), 0 16px 40px rgba(20, 20, 18, 0.08);
  --shadow-focus: 0 0 0 3px rgba(13, 148, 136, 0.18);

  /* spacing scale */
  --sp-1: 4px;
  --sp-2: 8px;
  --sp-3: 12px;
  --sp-4: 16px;
  --sp-5: 20px;
  --sp-6: 24px;
  --sp-8: 32px;
  --sp-10: 40px;
  --sp-12: 48px;

  --r-xs: 4px;
  --r-sm: 6px;
  --r-md: 8px;
  --r-lg: 12px;
  --r-xl: 16px;

  --font-sans: 'Inter', ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, sans-serif;
  --font-mono: 'JetBrains Mono', ui-monospace, 'SF Mono', Menlo, Consolas, monospace;
  --font-display: 'Inter', ui-sans-serif, system-ui, sans-serif;
}

[data-theme="dark"] {
  --bg-app: #0e0f0e;
  --bg-elev: #161817;
  --bg-sunken: #0a0b0a;
  --bg-hover: #1d1f1e;
  --bg-active: #252726;

  --border-subtle: #1e201f;
  --border-default: #292b2a;
  --border-strong: #3a3c3b;
  --border-focus: #2dd4bf;

  --fg-primary: #ededeb;
  --fg-secondary: #a8a8a4;
  --fg-tertiary: #707070;
  --fg-quaternary: #4a4c4b;
  --fg-on-accent: #042f2e;

  --accent: #2dd4bf;
  --accent-hover: #5eead4;
  --accent-soft: #134e4a;
  --accent-soft-fg: #99f6e4;

  --st-running-bg: #1e2a4a;
  --st-running-fg: #93c5fd;
  --st-running-dot: #60a5fa;
  --st-success-bg: #14352a;
  --st-success-fg: #6ee7b7;
  --st-success-dot: #34d399;
  --st-warn-bg: #3a2a10;
  --st-warn-fg: #fbbf24;
  --st-warn-dot: #f59e0b;
  --st-fail-bg: #3f1a1a;
  --st-fail-fg: #fca5a5;
  --st-fail-dot: #f87171;
  --st-neutral-bg: #1e201f;
  --st-neutral-fg: #a8a8a4;
  --st-neutral-dot: #707070;
  --st-info-bg: #1e1f3a;
  --st-info-fg: #a5b4fc;
  --st-info-dot: #818cf8;

  --shadow-sm: 0 1px 2px rgba(0, 0, 0, 0.3);
  --shadow-md: 0 1px 3px rgba(0, 0, 0, 0.4), 0 4px 12px rgba(0, 0, 0, 0.3);
  --shadow-lg: 0 4px 12px rgba(0, 0, 0, 0.5), 0 16px 40px rgba(0, 0, 0, 0.4);
  --shadow-focus: 0 0 0 3px rgba(45, 212, 191, 0.25);
}

/* ── Accent palette overrides ───────────────────────────────── */
/* Default accent is teal (matches :root above). Override per-page
   by setting data-accent on <html> or a container element. */

[data-accent="violet"] {
  --accent: #7c3aed;
  --accent-hover: #6d28d9;
  --accent-soft: #ede9fe;
  --accent-soft-fg: #4c1d95;
  --border-focus: #8b5cf6;
  --shadow-focus: 0 0 0 3px rgba(124, 58, 237, 0.18);
}
[data-theme="dark"][data-accent="violet"],
[data-theme="dark"] [data-accent="violet"] {
  --accent: #a78bfa;
  --accent-hover: #c4b5fd;
  --accent-soft: #2e1065;
  --accent-soft-fg: #ddd6fe;
  --border-focus: #a78bfa;
  --shadow-focus: 0 0 0 3px rgba(167, 139, 250, 0.25);
}

[data-accent="blue"] {
  --accent: #2563eb;
  --accent-hover: #1d4ed8;
  --accent-soft: #dbeafe;
  --accent-soft-fg: #1e3a8a;
  --border-focus: #3b82f6;
  --shadow-focus: 0 0 0 3px rgba(37, 99, 235, 0.18);
}
[data-theme="dark"][data-accent="blue"],
[data-theme="dark"] [data-accent="blue"] {
  --accent: #60a5fa;
  --accent-hover: #93c5fd;
  --accent-soft: #1e2a4a;
  --accent-soft-fg: #bfdbfe;
  --border-focus: #60a5fa;
  --shadow-focus: 0 0 0 3px rgba(96, 165, 250, 0.25);
}

[data-accent="emerald"] {
  --accent: #059669;
  --accent-hover: #047857;
  --accent-soft: #d1fae5;
  --accent-soft-fg: #064e3b;
  --border-focus: #10b981;
  --shadow-focus: 0 0 0 3px rgba(5, 150, 105, 0.18);
}
[data-theme="dark"][data-accent="emerald"],
[data-theme="dark"] [data-accent="emerald"] {
  --accent: #34d399;
  --accent-hover: #6ee7b7;
  --accent-soft: #14352a;
  --accent-soft-fg: #a7f3d0;
  --border-focus: #34d399;
  --shadow-focus: 0 0 0 3px rgba(52, 211, 153, 0.25);
}

[data-accent="amber"] {
  --accent: #d97706;
  --accent-hover: #b45309;
  --accent-soft: #fef3c7;
  --accent-soft-fg: #78350f;
  --border-focus: #f59e0b;
  --shadow-focus: 0 0 0 3px rgba(217, 119, 6, 0.18);
}
[data-theme="dark"][data-accent="amber"],
[data-theme="dark"] [data-accent="amber"] {
  --accent: #fbbf24;
  --accent-hover: #fcd34d;
  --accent-soft: #3a2a10;
  --accent-soft-fg: #fde68a;
  --border-focus: #fbbf24;
  --shadow-focus: 0 0 0 3px rgba(251, 191, 36, 0.25);
}

* { box-sizing: border-box; }
html, body { margin: 0; padding: 0; }
body {
  font-family: var(--font-sans);
  font-size: 13px;
  line-height: 1.5;
  color: var(--fg-primary);
  background: var(--bg-app);
  -webkit-font-smoothing: antialiased;
  -moz-osx-font-smoothing: grayscale;
  font-feature-settings: 'cv11', 'ss01';
}

button { font-family: inherit; }
input, textarea, select { font-family: inherit; font-size: inherit; color: inherit; }
`;
