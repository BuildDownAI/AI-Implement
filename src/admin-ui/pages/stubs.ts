function stubPage(route: string, title: string, subtitle: string, phase: string, body: string): string {
  return `
<section data-page="${route}" hidden>
  <header class="page-header">
    <div class="page-header-left">
      <h1 class="page-title">${title}</h1>
      <div class="page-subtitle">${subtitle}</div>
    </div>
  </header>
  <div class="page-body">
    <div class="alert info">
      <div style="flex:1">
        <div class="alert-title">Coming in ${phase}</div>
        <div class="alert-desc">${body}</div>
      </div>
    </div>
  </div>
</section>`;
}

export const stubsHtml = [
  stubPage("overview", "Overview", "The four-question dashboard", "Plan 2", "KPIs (running, capacity, blocked, failed-24h), running-now strip, blockers card, recent failures, project capacity grid."),
  stubPage("issues", "Issues", "Linear issue inbox", "Plan 4", "Matched issues, plan state, dispatchable. Backed by /api/linear/issues (new endpoint)."),
  stubPage("pulls", "Pull requests", "PRs opened by the bot", "Plan 4", "Risk-scored, awaiting CI/review. Backed by /api/github/pulls (new endpoint)."),
  stubPage("blockers", "Blockers", "Why each issue isn't running", "Plan 4", "Surfaces concurrency cap, missing secrets, dedup, Linear deps, Bedrock region, Fly config — derived from poll-selection.ts."),
  stubPage("pipelines", "Pipelines & steps", "Composable step library + pipeline definitions", "Plan 5", "List + edit pipeline YAMLs, step modules registered in src/pipeline/."),
  stubPage("models", "Models & providers", "Per-step models, provider failover, runner profiles", "Plan 5", "Configure provider chains and per-step model IDs."),
  stubPage("channels", "Triggers & channels", "Input triggers + output notifications", "Plan 5", "Linear, webhook, MCP triggers; Slack, Teams, GitHub PR comment channels."),
  stubPage("policies", "Policies & risk", "Auto-merge thresholds, risk rubric, CI gates", "Plan 5", "Edge vs stable channels, risk dimensions."),
  stubPage("runners", "Runners", "Fly Machines, GitHub Actions, warm pools", "Plan 5", "Per-runner profiles, image overrides, health metrics."),
  stubPage("secrets", "Secrets", "Encrypted store, scoped per project", "Plan 5", "Rotation tracking; complements global secrets on Settings."),
  stubPage("mcp", "MCP server", "Claude as the primary interface", "Plan 5", "Phase 1 read-only → Phase 3 orchestration."),
  stubPage("webhooks", "Webhooks", "Inbound endpoints + outbound delivery log", "Plan 5", "Signed payloads, retry counters."),
  stubPage("customizations", "Customizations", "Files in custom/ that override or extend upstream", "Plan 5", "Show what's overridden, last edit, drift from upstream."),
  stubPage("updates", "Updates", "Tracks upstream releases, opens upgrade PRs", "Plan 5", "Operationalizes the §3.14 automated upgrade PR model."),
].join("");
