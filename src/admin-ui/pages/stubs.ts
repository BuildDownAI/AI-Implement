type StubStatus = "not-implemented" | "partial";

interface StubSpec {
  route: string;
  title: string;
  subtitle: string;
  status: StubStatus;
  body: string;
  /**
   * Optional list of links to where related/partial functionality already lives.
   * Rendered as a list under the explanation.
   */
  seeAlso?: Array<{ label: string; route: string }>;
}

function stubPage(spec: StubSpec): string {
  const badge = spec.status === "partial"
    ? '<span class="badge info"><span class="dot"></span>Partially implemented</span>'
    : '<span class="badge warn"><span class="dot"></span>Not implemented yet</span>';

  const seeAlso = spec.seeAlso && spec.seeAlso.length > 0
    ? `<div style="margin-top:10px">
         <div class="text-tertiary" style="font-size:11.5px;text-transform:uppercase;letter-spacing:0.04em;margin-bottom:4px">See also</div>
         ${spec.seeAlso
           .map(
             (l) =>
               `<a class="text-accent" href="#${l.route}" style="display:inline-block;margin-right:14px">${l.label} →</a>`,
           )
           .join("")}
       </div>`
    : "";

  return `
<section data-page="${spec.route}" hidden>
  <header class="page-header">
    <div class="page-header-left">
      <h1 class="page-title">${spec.title}</h1>
      <div class="page-subtitle">${spec.subtitle}</div>
    </div>
    <div class="page-header-actions">${badge}</div>
  </header>
  <div class="page-body">
    <div class="alert info">
      <div style="flex:1">
        <div class="alert-title">Coming soon</div>
        <div class="alert-desc">${spec.body}</div>
        ${seeAlso}
      </div>
    </div>
  </div>
</section>`;
}

export const stubsHtml = [
  stubPage({
    route: "channels",
    title: "Triggers & channels",
    subtitle: "Input triggers + output notifications",
    status: "partial",
    body:
      "Today the orchestrator polls Linear for the <span class=\"mono\">AI-Implement</span> label and emits notifications via the configured webhook (<span class=\"mono\">NOTIFY_TYPE</span> env var). A unified UI for adding webhook triggers, MCP triggers, and Slack/Teams/GitHub-comment channels is not built yet.",
    seeAlso: [
      { label: "Settings", route: "settings" },
      { label: "Webhooks", route: "webhooks" },
    ],
  }),
  stubPage({
    route: "policies",
    title: "Policies & risk",
    subtitle: "Auto-merge thresholds, risk rubric, CI gates",
    status: "not-implemented",
    body:
      "There is no policy engine in the orchestrator yet. The vision: per-project auto-merge thresholds, a risk rubric over PR diff (size, files touched, blast radius), and edge / stable channels for staged rollouts. Nothing in this area runs today.",
  }),
  stubPage({
    route: "secrets",
    title: "Secrets",
    subtitle: "Encrypted store, scoped per project",
    status: "partial",
    body:
      "Secrets are managed in two places already: <strong>global Fly machine secrets</strong> (injected into every machine) on the Settings page, and <strong>per-project secrets</strong> on each project's row on the Projects page. A consolidated browse + rotation-tracking view is not built yet.",
    seeAlso: [
      { label: "Settings — global secrets", route: "settings" },
      { label: "Projects", route: "projects" },
    ],
  }),
  stubPage({
    route: "mcp",
    title: "MCP server",
    subtitle: "Claude as the primary interface",
    status: "not-implemented",
    body:
      "An MCP server that exposes the orchestrator's data and actions to Claude is not built yet. The plan: phase 1 read-only (issues, jobs, blockers), phase 2 dispatch + retry actions, phase 3 full orchestration with Claude as the operator.",
  }),
  stubPage({
    route: "webhooks",
    title: "Webhooks",
    subtitle: "Inbound endpoints + outbound delivery log",
    status: "partial",
    body:
      "An inbound endpoint at <span class=\"mono\">POST /api/github/webhook</span> consumes GitHub PR-merge events to update job status — that runs today (configured via <span class=\"mono\">GITHUB_WEBHOOK_SECRET</span>). The UI for browsing configured endpoints, viewing signed-payload deliveries, and retrying outbound notifications is not built yet.",
    seeAlso: [
      { label: "Audit log (recent dispatches)", route: "audit" },
    ],
  }),
  stubPage({
    route: "updates",
    title: "Updates",
    subtitle: "Tracks upstream releases, opens upgrade PRs",
    status: "not-implemented",
    body:
      "Tracking upstream <span class=\"mono\">ai-implement</span> releases and automatically opening upgrade PRs against your fork is not built yet. Today, follow upstream on GitHub and rebase manually when you want new features.",
  }),
].join("");
