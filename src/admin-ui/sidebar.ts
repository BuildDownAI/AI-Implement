import { icon } from "./icons.js";

interface NavItem { key: string; label: string; icon: string; count?: string }
interface NavGroup { label: string; items: NavItem[] }

const groups: NavGroup[] = [
  { label: "Work", items: [
    { key: "overview", label: "Overview",      icon: "activity" },
    { key: "issues",   label: "Issues",        icon: "inbox",   count: "issues" },
    { key: "jobs",     label: "Pipelines",     icon: "queue",   count: "running" },
    { key: "pulls",    label: "Pull requests", icon: "git",     count: "pulls" },
    { key: "blockers", label: "Blockers",      icon: "alert",   count: "blockers" },
  ]},
  { label: "Configure", items: [
    { key: "projects",  label: "Projects",            icon: "folder" },
    { key: "pipelines", label: "Pipelines & steps",   icon: "flow" },
    { key: "models",    label: "Models & providers",  icon: "bolt" },
    { key: "channels",  label: "Triggers & channels", icon: "broadcast" },
    { key: "policies",  label: "Policies & risk",     icon: "shield" },
  ]},
  { label: "Platform", items: [
    { key: "runners",  label: "Runners",  icon: "cpu" },
    { key: "sessions", label: "Sessions", icon: "server" },
    { key: "reaper",   label: "Reaper",   icon: "broom" },
    { key: "secrets",  label: "Secrets",  icon: "key" },
    { key: "settings", label: "Settings", icon: "settings" },
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
  const sections = groups.map(g => `
    <div class="nav-section-label">${g.label}</div>
    ${g.items.map(it => `
      <a class="nav-item" data-route="${it.key}" href="#${it.key}">
        <span class="nav-icon">${icon(it.icon, 14)}</span>
        <span style="flex:1">${it.label}</span>
        ${it.count ? `<span class="nav-count" data-count="${it.count}" hidden>0</span>` : ""}
      </a>`).join("")}
  `).join("");

  return `
    <div class="sidebar-brand">
      <div style="min-width:0">
        <div class="brand-name">AI-Implement</div>
        <div class="brand-meta">orchestrator</div>
      </div>
    </div>
    ${sections}
    <div class="sidebar-footer">
      <div class="sidebar-user">
        <div class="avatar">·</div>
        <div style="min-width:0;flex:1">
          <div class="user-name">Admin</div>
          <div class="user-email">signed in</div>
        </div>
        <button class="btn btn-ghost btn-icon" onclick="logout()" title="Log out">${icon("x", 12)}</button>
      </div>
    </div>
  `;
}

export const SIDEBAR_ROUTES = groups.flatMap(g => g.items.map(it => it.key));
