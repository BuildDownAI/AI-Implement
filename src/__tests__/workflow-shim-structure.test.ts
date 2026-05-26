import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { parse } from "yaml";

const IMPLEMENT_WORKFLOWS = [
  "workflows/claude-implement.yml",
  ".github/workflows/claude-implement.yml",
];
const COMMENT_TRIGGER_WORKFLOWS = [
  "workflows/comment-trigger.yml",
  ".github/workflows/comment-trigger.yml",
];
const PLANNING_WORKFLOWS = [
  "workflows/claude-plan.yml",
  ".github/workflows/claude-plan.yml",
];
const FILES = [...IMPLEMENT_WORKFLOWS, ...COMMENT_TRIGGER_WORKFLOWS];
const SYNCED_WORKFLOW_FILES = [...IMPLEMENT_WORKFLOWS, ...COMMENT_TRIGGER_WORKFLOWS, ...PLANNING_WORKFLOWS];

describe("GHA workflow shims", () => {
  it("ships workflow templates in the orchestrator image for admin-triggered syncs", () => {
    expect(readFileSync("Dockerfile", "utf-8")).toMatch(/COPY workflows\/ \.\/workflows\//);
  });

  it("publishes runner image channels from the correct source branches", () => {
    const yaml = readFileSync(".github/workflows/build-runner.yml", "utf-8");
    const doc = parse(yaml) as any;
    const steps = doc.jobs.build.steps as any[];
    const buildStep = steps.find((step) => step.name === "Build and push");
    const smokeStep = steps.find((step) => String(step.name).startsWith("Smoke-test"));
    const promoteStep = steps.find((step) => String(step.name).startsWith("Promote"));

    expect(doc.on.push.branches).toEqual(["main", "testing"]);
    expect(doc.on.workflow_dispatch.inputs.channel.type).toBe("choice");
    expect(doc.on.workflow_dispatch.inputs.channel.description).toContain("main -> latest, testing -> next");
    expect(doc.on.workflow_dispatch.inputs.channel.options).toEqual(["next", "latest"]);
    expect(doc.concurrency.group).toBe("build-runner-${{ github.ref_name }}");
    expect(doc.concurrency["cancel-in-progress"]).toBe(true);
    expect(yaml).toContain('owner="${GITHUB_REPOSITORY_OWNER,,}"');
    expect(yaml).toMatch(/main\)\s+expected_channel="latest"/);
    expect(yaml).toMatch(/testing\)\s+expected_channel="next"/);
    expect(yaml).toMatch(/does not match selected channel/);
    expect(yaml).toMatch(/date_tag=base-\$\{channel\}-v\$\(date -u \+%Y%m%d\)-\$\{GITHUB_SHA::12\}/);

    expect(buildStep).toBeDefined();
    expect(buildStep.with.tags.trim()).toBe("${{ steps.meta.outputs.image }}:${{ github.sha }}");
    expect(buildStep.with.tags).not.toContain("${{ steps.meta.outputs.image }}:${{ steps.meta.outputs.channel }}");
    expect(buildStep.with.tags).not.toContain("${{ steps.meta.outputs.image }}:${{ steps.meta.outputs.date_tag }}");

    expect(smokeStep).toBeDefined();
    expect(smokeStep.run).toContain('docker pull "${{ steps.meta.outputs.image }}:${{ github.sha }}"');
    expect(smokeStep.run).toContain('"${{ steps.meta.outputs.image }}:${{ github.sha }}"');
    expect(smokeStep.run).not.toContain("steps.meta.outputs.channel");

    expect(promoteStep).toBeDefined();
    expect(promoteStep.run).toContain("set -euo pipefail");
    expect(promoteStep.run).toContain('git ls-remote origin "refs/heads/${{ github.ref_name }}"');
    expect(promoteStep.run).toContain("Could not verify current head");
    expect(promoteStep.run).toContain("re-test and promote the SHA image");
    expect(promoteStep.run).toContain('if [ "$current_sha" != "${{ github.sha }}" ]; then');
    expect(promoteStep.run).toContain("Skipping channel promotion");
    expect(promoteStep.run).toContain("Re-pull immediately before tagging");
    expect(promoteStep.run).toContain('docker pull "${{ steps.meta.outputs.image }}:${{ github.sha }}"');
    expect(promoteStep.run).toContain(
      'docker tag "${{ steps.meta.outputs.image }}:${{ github.sha }}" "${{ steps.meta.outputs.image }}:${{ steps.meta.outputs.channel }}"',
    );
    expect(promoteStep.run).toContain(
      'docker tag "${{ steps.meta.outputs.image }}:${{ github.sha }}" "${{ steps.meta.outputs.image }}:${{ steps.meta.outputs.date_tag }}"',
    );
    expect(promoteStep.run).toContain('docker push "${{ steps.meta.outputs.image }}:${{ steps.meta.outputs.channel }}"');
    expect(promoteStep.run).toContain('docker push "${{ steps.meta.outputs.image }}:${{ steps.meta.outputs.date_tag }}"');
  });

  it("keeps the canonical and synced dispatch workflows byte-for-byte identical", () => {
    expect(readFileSync(".github/workflows/claude-implement.yml", "utf-8")).toBe(
      readFileSync("workflows/claude-implement.yml", "utf-8"),
    );
  });

  it("keeps the canonical and synced comment trigger workflows byte-for-byte identical", () => {
    expect(readFileSync(".github/workflows/comment-trigger.yml", "utf-8")).toBe(
      readFileSync("workflows/comment-trigger.yml", "utf-8"),
    );
  });

  it("keeps the canonical and synced planning workflows byte-for-byte identical", () => {
    expect(readFileSync(".github/workflows/claude-plan.yml", "utf-8")).toBe(
      readFileSync("workflows/claude-plan.yml", "utf-8"),
    );
  });

  for (const f of SYNCED_WORKFLOW_FILES) {
    it(`${f} pins external actions to full commit SHAs`, () => {
      const yaml = readFileSync(f, "utf-8");
      const actionRefs = [...yaml.matchAll(/^\s*uses:\s*([^\s#]+@[^\s#]+)/gm)].map((m) => m[1]);
      expect(actionRefs.length).toBeGreaterThan(0);
      for (const ref of actionRefs) {
        expect(ref).toMatch(/@[0-9a-f]{40}$/);
      }
    });
  }

  for (const f of FILES) {
    it(`${f} uses a resolved runner image for its container job`, () => {
      const yaml = readFileSync(f, "utf-8");
      const doc = parse(yaml) as any;
      const jobs = Object.values(doc.jobs) as any[];
      // At least one job must be a container job referencing the runner image
      const containerJob = jobs.find((j) => j.container);
      expect(containerJob).toBeDefined();
      const image = typeof containerJob.container === "string" ? containerJob.container : containerJob.container.image;
      expect(String(image)).toMatch(/runner_image/);
      expect(yaml).toMatch(/ai-implement-runner/);
    });

    it(`${f} has no apt-get install or claude install blocks`, () => {
      const yaml = readFileSync(f, "utf-8");
      expect(yaml).not.toMatch(/apt-get install/);
      expect(yaml).not.toMatch(/curl.*claude\.ai\/install/);
    });

    it(`${f} has at most one configure-aws-credentials step`, () => {
      const yaml = readFileSync(f, "utf-8");
      const awsCount = (yaml.match(/configure-aws-credentials/g) ?? []).length;
      expect(awsCount).toBeLessThanOrEqual(1);
    });

    it(`${f} configures exactly one 4-hour AWS credentials step when it supports Bedrock`, () => {
      const yaml = readFileSync(f, "utf-8");
      if (yaml.includes("bedrock")) {
        const awsCount = (yaml.match(/configure-aws-credentials/g) ?? []).length;
        expect(awsCount).toBe(1);
        expect(yaml).toMatch(/role-session-duration:\s*14400/);
      }
    });
  }

  for (const f of IMPLEMENT_WORKFLOWS) {
    it(`${f} validates the runner image before the container job starts`, () => {
      const yaml = readFileSync(f, "utf-8");
      expect(yaml).toMatch(/validate-runner-image:/);
      expect(yaml).toMatch(/needs:\s*validate-runner-image/);
      expect(yaml).toMatch(/image:\s*\$\{\{\s*needs\.validate-runner-image\.outputs\.runner_image\s*\}\}/);
      expect(yaml).toMatch(/ghcr\.io\/builddownai\/ai-implement-runner:latest/);
      expect(yaml).toMatch(/invalid characters for a container image reference/);
      expect(yaml).toMatch(/AI_IMPLEMENT_ALLOWED_RUNNER_IMAGE_PREFIXES=<prefix>/);
    });
  }

  it("comment trigger only runs implementation for an exact trimmed /ai-implement command", () => {
    const yaml = readFileSync("workflows/comment-trigger.yml", "utf-8");
    expect(yaml).not.toMatch(/contains\([^)]*\/ai-implement/);
    expect(yaml).toMatch(/body\.trim\(\) === "\/ai-implement"/);
    expect(yaml).toMatch(/if:\s*needs\.check-trigger\.outputs\.matched == 'true'/);
  });

  it("comment trigger allows maintainers and preserves the intended missing metadata error", () => {
    const yaml = readFileSync("workflows/comment-trigger.yml", "utf-8");
    expect(yaml).toMatch(/\["write", "maintain", "admin"\]/);
    expect(yaml).toMatch(/core\.setFailed\("PR body has no ai-implement-meta block"\);\n\s+return;/);
  });

  it("comment trigger validates repository configured runner images with an explicit override variable", () => {
    const yaml = readFileSync("workflows/comment-trigger.yml", "utf-8");
    expect(yaml).toMatch(/runner_image:\s*\$\{\{\s*steps\.runner-image\.outputs\.runner_image\s*\}\}/);
    expect(yaml).toMatch(/image:\s*\$\{\{\s*needs\.check-trigger\.outputs\.runner_image\s*\}\}/);
    expect(yaml).toMatch(/AI_IMPLEMENT_RUNNER_IMAGE/);
    expect(yaml).toMatch(/ghcr\.io\/builddownai\/ai-implement-runner:latest/);
    expect(yaml).toMatch(/invalid characters for a container image reference/);
    expect(yaml).toMatch(/AI_IMPLEMENT_ALLOWED_RUNNER_IMAGE_PREFIXES=<prefix>/);
  });

  it("documents and constrains the ISSUE_META eval trust boundary", () => {
    const yaml = readFileSync("workflows/comment-trigger.yml", "utf-8");
    expect(yaml).toMatch(/lower_snake_case keys/);
    expect(yaml).toMatch(/select\(\.key \| IN\("issue_id", "issue_identifier", "issue_title", "issue_description_b64"\)\)/);
    expect(yaml).not.toMatch(/IN\([^)]*github_token/);
    expect(yaml).not.toMatch(/IN\([^)]*anthropic_api_key/);
    expect(yaml).toMatch(/jq @sh quotes values/);
    expect(yaml).toMatch(/jq -r 'to_entries\[\] \| select/);
    expect(yaml).toMatch(/@sh/);
    expect(yaml).toMatch(/ISSUE_DESCRIPTION_B64.*base64 -d/);
  });

  it("comment trigger grants OIDC only to the container implementation job", () => {
    const doc = parse(readFileSync("workflows/comment-trigger.yml", "utf-8")) as any;
    expect(doc.permissions).not.toHaveProperty("id-token");
    expect(doc.jobs["check-trigger"].permissions).toBeUndefined();
    expect(doc.jobs.implement.permissions["id-token"]).toBe("write");
  });

  it("comment trigger acknowledges valid trigger comments", () => {
    const yaml = readFileSync("workflows/comment-trigger.yml", "utf-8");
    expect(yaml).toMatch(/Acknowledge trigger/);
    expect(yaml).toMatch(/createForIssueComment/);
    expect(yaml).toMatch(/content: "\+1"/);
  });

  it("comment trigger validates Bedrock config before configuring AWS credentials", () => {
    const yaml = readFileSync("workflows/comment-trigger.yml", "utf-8");
    expect(yaml).toMatch(/Validate Bedrock inputs/);
    expect(yaml).toMatch(/AI_IMPLEMENT_AWS_REGION repository or organization variable is empty/);
    expect(yaml.indexOf("Validate Bedrock inputs")).toBeLessThan(yaml.indexOf("Configure AWS credentials (Bedrock)"));
  });

  for (const f of PLANNING_WORKFLOWS) {
    it(`${f} accepts related-issue context as dispatch inputs`, () => {
      const yaml = readFileSync(f, "utf-8");
      expect(yaml).toMatch(/parent:\n\s+description:\s*"Related parent issue summary/);
      expect(yaml).toMatch(/siblings:\n\s+description:\s*"Related sibling issues summary/);
      expect(yaml).toMatch(/dependencies:\n\s+description:\s*"Related dependency issues summary/);
      expect(yaml).toMatch(/PARENT:\s*\$\{\{\s*inputs\.parent\s*\}\}/);
      expect(yaml).toMatch(/SIBLINGS:\s*\$\{\{\s*inputs\.siblings\s*\}\}/);
      expect(yaml).toMatch(/DEPENDENCIES:\s*\$\{\{\s*inputs\.dependencies\s*\}\}/);
    });

    it(`${f} does not call Linear directly from the workflow`, () => {
      const yaml = readFileSync(f, "utf-8");
      expect(yaml).not.toMatch(/api\.linear\.app\/graphql/);
      expect(yaml).not.toMatch(/LINEAR_API_KEY/);
      expect(yaml).not.toMatch(/Update Linear labels/);
      expect(yaml).toMatch(/runner\/result/);
    });

    it(`${f} does not allow Claude to curl Linear directly`, () => {
      const yaml = readFileSync(f, "utf-8");
      expect(yaml).not.toMatch(/Bash\(curl\*api\.linear\.app\/graphql\*\)/);
      expect(yaml).toMatch(/Do NOT post comments directly to the/);
    });

    it(`${f} uses default bash pipefail and glob iteration for callback comments`, () => {
      const yaml = readFileSync(f, "utf-8");
      expect(yaml).not.toMatch(/shell:\s*\/usr\/bin\/bash -e \{0\}/);
      expect(yaml).toMatch(/shopt -s nullglob/);
      expect(yaml).toMatch(/for f in ai-output\/comments\/\*\.md; do/);
      expect(yaml).not.toMatch(/for f in \$\(ls ai-output\/comments\/\*\.md/);
    });
  }
});
