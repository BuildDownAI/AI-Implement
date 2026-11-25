import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { MANIFEST_TYPES, publicationContext } from "../deploy-availability.js";

const workflow = parse(readFileSync(".github/workflows/publish-orchestrator-image.yml", "utf8"));

describe("overlapping orchestrator publications", () => {
  it("cancels superseded validation but preserves an active publisher through push and status recording", () => {
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
    const record = publish.steps.find((step: { id?: string }) => step.id === "published");
    expect(record.if).toContain("always() && steps.push-fly.outcome == 'success'");
    const notify = publish.steps.find((step: { name?: string }) => step.name === "Notify control plane");
    expect(notify).toBeUndefined();
    const source = readFileSync(".github/workflows/publish-orchestrator-image.yml", "utf8");
    expect(source).not.toMatch(/CONTROL_PLANE_OPS_TOKEN|auth\.builddown\.ai/);
    expect(record.run).toContain("-f context=orchestrator-image/published");
  });

  it("guards one runner build and pushes that image to both registries before recording it", () => {
    type Step = { id?: string; if?: string; run?: string; uses?: string };
    const steps: Step[] = workflow.jobs.publish.steps;
    const step = (id: string) => steps.find((s) => s.id === id)!;
    const at = (id: string) => steps.findIndex((s) => s.id === id);
    // Built fresh: the base template and the Python dependencies are fetched at build time.
    expect(step("build").run).toContain("docker build --no-cache --tag orchestrator-publish");
    expect(step("build").run).not.toContain("KG_SOURCE_REPO");
    // The guard reads the image the pushes send, before either push.
    expect(step("guard").run).toContain("orchestrator-publish");
    expect(step("guard").run).toContain("^KG_SOURCE_REPO=.");
    for (const path of ["snapshot", "sources.yml", "out"]) expect(step("guard").run).toContain(path);
    for (const push of ["push-ghcr", "push-fly"]) {
      expect(step(push).run).toContain("docker tag orchestrator-publish");
      expect(at("guard")).toBeLessThan(at(push));
    }
    // Each step runs only after the one before it succeeded, and stays alive under cancellation; the status comes last.
    const chain = ["build", "guard", "ghcr-login", "push-ghcr", "readable", "public", "push-fly", "published"];
    for (let i = 1; i < chain.length; i++) {
      expect(at(chain[i - 1])).toBeLessThan(at(chain[i]));
      // The Fly push also needs the token, which a fork may not have.
      const flyToken = chain[i] === "push-fly" ? " && steps.check.outputs.fly == 'true'" : "";
      expect(step(chain[i]).if).toBe(`\${{ always() && steps.${chain[i - 1]}.outcome == 'success'${flyToken} }}`);
    }
    expect(workflow.jobs.publish.permissions).toMatchObject({ contents: "read", statuses: "write", packages: "write" });
  });

  it("records each registry's copy under its own status, the Fly copy's only after a real Fly push", () => {
    type Step = { id?: string; if?: string; run?: string; uses?: string; env?: Record<string, string> };
    const steps: Step[] = workflow.jobs.publish.steps;
    const step = (id: string) => steps.find((s) => s.id === id)!;
    // SelfDeploy.start reads the status of the copy it deploys, so the workflow writes the names it reads.
    const ghcrContext = publicationContext("ghcr.io/owner/ai-implement-orchestrator:testing-abcdef0");
    const flyContext = publicationContext("registry.fly.io/owned-images:testing-abcdef0");
    expect(ghcrContext).not.toBe(flyContext);
    expect(step("public").run).toContain(`-f context=${ghcrContext}`);
    expect(step("public").run).toContain('"description=$GHCR_IMAGE"');
    expect(step("public").env?.GHCR_IMAGE).toBe("${{ steps.meta.outputs.ghcr }}");
    expect(step("published").run).toContain(`-f context=${flyContext}`);
    expect(step("published").run).toContain('"description=$FLY_IMAGE"');
    expect(step("published").env?.FLY_IMAGE).toBe("${{ steps.meta.outputs.fly }}");
    // Without the token the Fly push is skipped, never a success, so no Fly status is set for a copy that was not pushed.
    expect(step("push-fly").run).not.toContain("exit 0");
    expect(step("check").run).toMatch(/if \[ -n "\$FLY_API_TOKEN" \]; then\s+echo "fly=true" >> "\$GITHUB_OUTPUT"/);
    const setup = steps.find((s) => s.uses?.startsWith("superfly/flyctl-actions/setup-flyctl"))!;
    expect(setup.if).toBe(step("push-fly").if);
  });

  it("reads the GHCR copy accepting exactly the manifest types SelfDeploy.start's own read accepts", () => {
    // GHCR answers an OCI image index with 404 unless the request accepts that type, and the runner's push stores one.
    const readable = workflow.jobs.publish.steps.find((step: { id?: string }) => step.id === "readable");
    expect(readable.run).toContain(`accept='${MANIFEST_TYPES}'`);
  });

  it("publishes the validated commit even if a dispatched branch advances", () => {
    expect(workflow.jobs.build.outputs.commit).toBe("${{ steps.meta.outputs.commit }}");
    const checkout = workflow.jobs.publish.steps.find((step: { uses?: string }) => step.uses === "actions/checkout@v4");
    expect(checkout.with.ref).toBe("${{ needs.build.outputs.commit }}");
  });
});
