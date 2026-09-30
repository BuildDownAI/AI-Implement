/**
 * Adapts the webhook's PR dry-run `trigger` to the Restate-backed admin trigger
 * (AII-685). The `trigger_kg_refresh` tool input carries no `report` target, so
 * `opts.report` is deliberately dropped: no per-PR outcome is recorded and the
 * `kg-refresh/dry-run` comment/status stay dark until AII-730 replaces those surfaces.
 */
export interface KgWebhookTriggerDeps {
  trigger: (opts: { dryRun?: boolean; ref?: string }) => Promise<{ status: number; body: Record<string, unknown> }>;
}

export function makeKgWebhookTrigger(
  getDeps: () => KgWebhookTriggerDeps | null | undefined,
): (opts: { dryRun?: boolean; ref?: string; report?: unknown }) => Promise<{ status: number; body: Record<string, unknown> }> {
  return async (opts) => {
    const deps = getDeps();
    return deps
      ? deps.trigger({ dryRun: opts.dryRun, ref: opts.ref })
      : { status: 501, body: { error: "kg-source-repo-not-configured" } };
  };
}
