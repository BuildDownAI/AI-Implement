import { icon } from "./icons.js";

/** grantBlocker: why this page can never be granted, shown in the grant editor. Presentation only —
 *  whether a page IS grantable is the server's call, declared as PAGE_ROUTES in access-page-grants.ts. */
interface NavItem { key: string; label: string; icon: string; count?: string; grantBlocker?: string }
interface NavGroup { label: string; items: NavItem[] }

const groups: NavGroup[] = [
  { label: "Work", items: [
    { key: "overview", label: "Overview",      icon: "activity",
      grantBlocker: "Its project data includes the environment values injected into runner machines." },
    { key: "issues",   label: "Issues",        icon: "inbox",   count: "issues" },
    { key: "jobs",     label: "Pipelines",     icon: "queue",   count: "running" },
    { key: "pulls",    label: "Pull requests", icon: "git",     count: "pulls" },
    { key: "blockers", label: "Blockers",      icon: "alert",   count: "blockers" },
    { key: "reports",  label: "Reports",       icon: "layers" },
  ]},
  { label: "Configure", items: [
    { key: "projects",  label: "Projects",            icon: "folder",
      grantBlocker: "Editing project configuration is administration, and the payload carries runner environment values." },
    { key: "pipelines", label: "Pipelines & steps",   icon: "flow" },
    { key: "models",    label: "Models & providers",  icon: "bolt",
      grantBlocker: "Reads the project-mapping payload, which carries runner environment values." },
    { key: "channels",  label: "Triggers & channels", icon: "broadcast" },
    { key: "policies",  label: "Policies & risk",     icon: "shield" },
  ]},
  { label: "Platform", items: [
    { key: "runners",     label: "Runners",     icon: "cpu",
      grantBlocker: "The runner mode is a global failover control, not a read-only view." },
    { key: "sessions",    label: "Sessions",    icon: "server" },
    { key: "deployments", label: "Deployments", icon: "rocket", count: "deploy-available",
      grantBlocker: "Triggers deploys and exposes infrastructure inventory." },
    { key: "reaper",      label: "Reaper",      icon: "broom" },
    { key: "access",      label: "Access",      icon: "shield",
      grantBlocker: "Decides who can sign in and as what." },
    { key: "secrets",     label: "Secrets",     icon: "key",
      grantBlocker: "Exposes global secret names." },
    { key: "settings",    label: "Settings",    icon: "settings",
      grantBlocker: "Exposes global secrets and infrastructure settings." },
  ]},
  { label: "Developer", items: [
    { key: "mcp",            label: "MCP server",     icon: "plug" },
    { key: "webhooks",       label: "Webhooks",       icon: "webhook" },
    { key: "audit",          label: "Audit log",      icon: "history" },
    { key: "customizations", label: "Customizations", icon: "fork" },
    { key: "updates",        label: "Updates",        icon: "download" },
  ]},
];

export function sidebarHtml(): string {
  // The group wraps its label and items so a group whose every item is hidden can be hidden whole —
  // a label with nothing under it is what a flat list leaves behind.
  const sections = groups.map(g => `
    <div class="nav-section">
      <div class="nav-section-label">${g.label}</div>
      ${g.items.map(it => `
        <a class="nav-item" data-route="${it.key}" href="#${it.key}">
          <span class="nav-icon">${icon(it.icon, 14)}</span>
          <span style="flex:1">${it.label}</span>
          ${it.count ? `<span class="nav-count" data-count="${it.count}" hidden>0</span>` : ""}
        </a>`).join("")}
    </div>
  `).join("");

  return `
    <div class="sidebar-brand">
      <div style="min-width:0">
        <div class="brand-name">AI-Implement</div>
        <div class="brand-meta">orchestrator</div>
      </div>
    </div>
    <div class="sidebar-nav">
      ${sections}
    </div>
    <div class="sidebar-footer">
      <div class="sidebar-user">
        <div class="avatar" id="session-avatar">·</div>
        <div style="min-width:0;flex:1">
          <div class="user-name" id="session-name">Signed in</div>
          <div class="user-email" id="session-email"></div>
        </div>
      </div>
      <div class="sidebar-user-actions">
        <button class="btn btn-ghost btn-icon" onclick="window.toggleTheme()" title="Toggle theme">
          <span class="theme-icon-sun">${icon("sun", 14)}</span>
          <span class="theme-icon-moon">${icon("moon", 14)}</span>
        </button>
        <button class="btn btn-sm btn-danger" onclick="logout()">${icon("x", 12)}Log out</button>
      </div>
    </div>
  `;
}

export const SIDEBAR_ROUTES = groups.flatMap(g => g.items.map(it => it.key));

/** Label per page key, so the grant editor can name what the server tells it is grantable. */
export const PAGE_LABELS: Record<string, string> = Object.fromEntries(
  groups.flatMap(g => g.items.map(it => [it.key, it.label])),
);

/** Nav group per page key, so the grant editor can mirror the sidebar's own grouping. */
export const PAGE_GROUPS: Record<string, string> = Object.fromEntries(
  groups.flatMap(g => g.items.map(it => [it.key, g.label])),
);

/** Why a page is excluded, for the pages that carry a stated reason. */
export const GRANT_BLOCKERS: Record<string, string> = Object.fromEntries(
  groups.flatMap(g => g.items.filter(it => it.grantBlocker).map(it => [it.key, it.grantBlocker as string])),
);
