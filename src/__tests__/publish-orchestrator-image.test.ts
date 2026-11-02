import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const workflow = parse(readFileSync(".github/workflows/publish-orchestrator-image.yml", "utf8"));

describe("overlapping orchestrator publications", () => {
  it("cancels superseded validation but preserves an active publisher through push and notification", () => {
    // Workflow cancellation would also cancel the publisher, regardless of its
    // own concurrency group. Only the build job may cancel its predecessor.
    expect(workflow.concurrency).toBeUndefined();
    const { build, publish } = workflow.jobs;
    expect(build.concurrency["cancel-in-progress"]).toBe(true);
    expect(publish.concurrency["cancel-in-progress"]).toBe(false);
    expect(build.concurrency.group).not.toBe(publish.concurrency.group);
    for (const job of [build, publish]) {
      expect(job.concurrency.group).toContain("inputs.branch || github.ref_name");
    }
    // GitHub re-evaluates this condition when cancellation is requested. It
    // must stay true for an active publisher, but reject failed/cancelled builds.
    expect(publish.needs).toBe("build");
    expect(publish.if).toBe("${{ always() && needs.build.result == 'success' }}");
    const push = publish.steps.find((step: { id?: string }) => step.id === "push");
    expect(push.run).toContain("--build-only --push --remote-only --no-cache");
    const record = publish.steps.find((step: { id?: string }) => step.id === "published");
    expect(record.if).toContain("always() && steps.push.outcome == 'success'");
    const notify = publish.steps.find((step: { name?: string }) => step.name === "Notify control plane");
    expect(notify.if).toContain("always() && steps.published.outcome == 'success'");
  });

  it("publishes the validated commit even if a dispatched branch advances", () => {
    expect(workflow.jobs.build.outputs.commit).toBe("${{ steps.meta.outputs.commit }}");
    const checkout = workflow.jobs.publish.steps.find((step: { uses?: string }) => step.uses === "actions/checkout@v4");
    expect(checkout.with.ref).toBe("${{ needs.build.outputs.commit }}");
  });
});
