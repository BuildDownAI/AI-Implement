import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { parse } from "yaml";

const IMPLEMENT_WORKFLOWS = [
  "workflows/claude-implement.yml",
  ".github/workflows/claude-implement.yml",
];
const PLANNING_WORKFLOWS = [
  "workflows/claude-plan.yml",
  ".github/workflows/claude-plan.yml",
];
const FILES = [...IMPLEMENT_WORKFLOWS];
const SYNCED_WORKFLOW_FILES = [...IMPLEMENT_WORKFLOWS, ...PLANNING_WORKFLOWS];

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
    expect(doc.on.workflow_dispatch.inputs.channel.default).toBeUndefined();
    expect(doc.on.workflow_dispatch.inputs.channel.options).toEqual(["next", "latest"]);
    expect(doc.concurrency.group).toBe("build-runner-${{ github.ref_name }}");
    expect(doc.concurrency["cancel-in-progress"]).toBe(true);
    expect(yaml).toContain('owner="${GITHUB_REPOSITORY_OWNER,,}"');
    expect(yaml).toMatch(/main\)\s+expected_channel="latest"/);
    expect(yaml).toMatch(/testing\)\s+expected_channel="next"/);
    expect(yaml).toMatch(/does not match selected channel/);
    expect(yaml).toMatch(/date_tag=base-\$\{channel\}-v\$\(date -u \+%Y%m%d\)-\$\{GITHUB_SHA::12\}/);

    expect(buildStep).toBeDefined();
    expect(buildStep.id).toBe("build");
    expect(buildStep.with.tags.trim()).toBe("${{ steps.meta.outputs.image }}:${{ github.sha }}");
    expect(buildStep.with.tags).not.toContain("${{ steps.meta.outputs.image }}:${{ steps.meta.outputs.channel }}");
    expect(buildStep.with.tags).not.toContain("${{ steps.meta.outputs.image }}:${{ steps.meta.outputs.date_tag }}");

    expect(smokeStep).toBeDefined();
    expect(smokeStep.name).toContain("built digest");
    expect(smokeStep.run).toContain('digest_ref="${{ steps.meta.outputs.image }}@${{ steps.build.outputs.digest }}"');
    expect(smokeStep.run).toContain('docker pull "$digest_ref"');
    expect(smokeStep.run).toContain('"$digest_ref"');
    expect(smokeStep.run).not.toContain("steps.meta.outputs.image }}:${{ github.sha");
    expect(smokeStep.run).not.toContain("steps.meta.outputs.channel");

    expect(promoteStep).toBeDefined();
    expect(promoteStep.name).toContain("tested digest");
    expect(promoteStep.run).toContain("set -euo pipefail");
    expect(promoteStep.run).toContain('digest_ref="${{ steps.meta.outputs.image }}@${{ steps.build.outputs.digest }}"');
    expect(promoteStep.run).toContain('git ls-remote origin "refs/heads/$GITHUB_REF_NAME"');
    expect(promoteStep.run).not.toContain('refs/heads/${{ github.ref_name }}');
    expect(promoteStep.run).toContain("Could not verify current head");
    expect(promoteStep.run).toContain("re-test and promote the digest image");
    expect(promoteStep.run).toContain('if [ "$current_sha" != "${{ github.sha }}" ]; then');
    expect(promoteStep.run).toContain("Skipping channel promotion");
    expect(promoteStep.run).toContain("Re-pull immediately before tagging");
    expect(promoteStep.run).toContain('docker pull "$digest_ref"');
    expect(promoteStep.run).toContain(
      'docker tag "$digest_ref" "${{ steps.meta.outputs.image }}:${{ steps.meta.outputs.channel }}"',
    );
    expect(promoteStep.run).toContain(
      'docker tag "$digest_ref" "${{ steps.meta.outputs.image }}:${{ steps.meta.outputs.date_tag }}"',
    );
    expect(promoteStep.run).toContain('docker push "${{ steps.meta.outputs.image }}:${{ steps.meta.outputs.channel }}"');
    expect(promoteStep.run).toContain('docker push "${{ steps.meta.outputs.image }}:${{ steps.meta.outputs.date_tag }}"');
  });

  it("keeps the canonical and synced dispatch workflows byte-for-byte identical", () => {
    expect(readFileSync(".github/workflows/claude-implement.yml", "utf-8")).toBe(
      readFileSync("workflows/claude-implement.yml", "utf-8"),
    );
  });

  it("keeps the canonical and synced planning workflows byte-for-byte identical", () => {
    expect(readFileSync(".github/workflows/claude-plan.yml", "utf-8")).toBe(
      readFileSync("workflows/claude-plan.yml", "utf-8"),
    );
  });

  it("keeps seeded gap-fill Git writes under pipeline control", () => {
    const workflow = readFileSync("workflows/WORKFLOW.md", "utf-8");
    const gapFill = workflow.split("## Gap-fill instructions")[1]?.split("## Issue")[0] ?? "";

    expect(gapFill).toContain("Do NOT commit or push");
    expect(gapFill).toContain("leave your file changes unstaged and uncommitted");
    expect(gapFill).toContain("pipeline will\ncommit and push them to the existing PR branch");
    expect(gapFill).not.toContain("Commit your changes to the current\nbranch and push");
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

    it(`${f} is ticketing-agnostic — no Linear references`, () => {
      const yaml = readFileSync(f, "utf-8");
      expect(yaml).not.toMatch(/LINEAR_API_KEY/);
      expect(yaml).not.toMatch(/api\.linear\.app/);
      expect(yaml).not.toMatch(/Linear issue/);
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
    it(`${f} accepts run_config as the required envelope input and passes it through as AI_IMPLEMENT_RUN_CONFIG`, () => {
      const yaml = readFileSync(f, "utf-8");
      const doc = parse(yaml) as any;
      expect(doc.on.workflow_dispatch.inputs.run_config).toBeDefined();
      expect(doc.on.workflow_dispatch.inputs.run_config.required).toBe(true);
      expect(yaml).toMatch(/AI_IMPLEMENT_RUN_CONFIG:\s*\$\{\{\s*inputs\.run_config\s*\}\}/);
    });

    it(`${f} validates the runner image before the container job starts`, () => {
      const yaml = readFileSync(f, "utf-8");
      expect(yaml).toMatch(/validate-runner-image:/);
      expect(yaml).toMatch(/needs:\s*validate-runner-image/);
      expect(yaml).toMatch(/image:\s*\$\{\{\s*needs\.validate-runner-image\.outputs\.runner_image\s*\}\}/);
      expect(yaml).toMatch(/ghcr\.io\/builddownai\/ai-implement-runner:latest/);
      expect(yaml).toMatch(/invalid characters for a container image reference/);
      expect(yaml).toMatch(/AI_IMPLEMENT_ALLOWED_RUNNER_IMAGE_PREFIXES=<prefix>/);
      // Owner-derived allowlist (safe half of PR #84): trusts the repo's own GHCR namespace.
      expect(yaml).toMatch(/owner="\$\{GITHUB_REPOSITORY_OWNER,,\}"/);
      expect(yaml).toMatch(/ghcr\.io\/\$\{owner\}\//);
      // Reads the per-repo override file from the default branch (no ?ref= → no PR-head read).
      expect(yaml).toMatch(/contents\/\.ai-implement\/image\.yml/);
      expect(yaml).not.toMatch(/image\.yml\?ref=/);
      // The image.yml parse must not abort the job under `set -euo pipefail` (SIGPIPE on multi-match).
      expect(yaml).toMatch(/head -n1\)" \|\| true/);
      // Allowlist match must be literal — quoted "$prefix" so glob chars in an operator prefix can't widen it.
      expect(yaml).toMatch(/\[\[ "\$runner_image" == "\$prefix"\* \]\]/);
      expect(yaml).toMatch(/GITHUB_REPOSITORY_OWNER is empty/);
    });

    it(`${f} masks runner progress tokens before the container step uses them`, () => {
      const yaml = readFileSync(f, "utf-8");
      expect(yaml).toMatch(/::add-mask::\$\{\{\s*inputs\.run_progress_token\s*\}\}/);
      expect(yaml.indexOf("Mask runner callback tokens")).toBeLessThan(yaml.indexOf("Run pipeline"));
    });

    it(`${f} accepts and masks a dedicated publication token only for the pipeline step`, () => {
      const yaml = readFileSync(f, "utf-8");
      const doc = parse(yaml) as any;
      expect(doc.on.workflow_dispatch.inputs.run_publication_token).toBeDefined();
      expect(doc.on.workflow_dispatch.inputs.run_publication_token.required).toBe(false);
      expect(yaml).toMatch(/::add-mask::\$\{\{\s*inputs\.run_publication_token\s*\}\}/);
      expect(yaml.indexOf("Mask runner callback tokens")).toBeLessThan(yaml.indexOf("Run pipeline"));

      const pipelineStep = doc.jobs.implement.steps.find((step: any) => step.name === "Run pipeline");
      expect(pipelineStep.env.RUN_PUBLICATION_TOKEN).toBe("${{ inputs.run_publication_token }}");
      const nonPipelineSteps = doc.jobs.implement.steps.filter((step: any) => step.name !== "Run pipeline");
      expect(JSON.stringify(nonPipelineSteps)).not.toContain("RUN_PUBLICATION_TOKEN");
    });

    it(`${f} validates Bedrock config before configuring AWS credentials`, () => {
      const yaml = readFileSync(f, "utf-8");
      expect(yaml).toMatch(/Validate Bedrock inputs/);
      expect(yaml).toMatch(/provider=bedrock but aws_region dispatch input is empty/);
      expect(yaml).toMatch(/provider=bedrock but AWS_BEDROCK_ROLE_ARN repo secret is not set/);
      expect(yaml.indexOf("Validate Bedrock inputs")).toBeLessThan(yaml.indexOf("Configure AWS credentials (Bedrock)"));
    });
  }

  it("comment trigger fires on a /ai-implement prefix and passes the remainder as an instruction", () => {
    const yaml = readFileSync("workflows/comment-trigger.yml", "utf-8");
    // Anchored prefix match — not a `contains()` check and not exact-equality.
    expect(yaml).not.toMatch(/contains\([^)]*\/ai-implement/);
    expect(yaml).not.toMatch(/body\.trim\(\) === "\/ai-implement"/);
    expect(yaml).toContain("/^\\/ai-implement(?:\\s+([\\s\\S]*))?$/");
    expect(yaml).toMatch(/if:\s*needs\.check-trigger\.outputs\.matched == 'true'/);
    // Remainder is base64-encoded and plumbed through to the runner.
    expect(yaml).toContain('Buffer.from(instruction, "utf-8").toString("base64")');
    expect(yaml).toMatch(/comment_instruction:\s*\$\{\{\s*steps\.trigger\.outputs\.comment_instruction\s*\}\}/);
    expect(yaml).toMatch(/COMMENT_INSTRUCTION_B64:\s*\$\{\{\s*needs\.check-trigger\.outputs\.comment_instruction\s*\}\}/);
    expect(yaml).toContain('export AI_IMPLEMENT_COMMENT_INSTRUCTION=$(echo "$COMMENT_INSTRUCTION_B64" | base64 -d)');
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
    expect(yaml).toMatch(/GITHUB_REPOSITORY_OWNER/);
    expect(yaml).toMatch(/ghcr\.io\/\$\{owner\}\//);
    expect(yaml).toMatch(/contents\/\.ai-implement\/image\.yml/);
    expect(yaml).not.toMatch(/image\.yml\?ref=/);
    // The image.yml parse must not abort the job under `set -euo pipefail` (SIGPIPE on multi-match).
    expect(yaml).toMatch(/head -n1\)" \|\| true/);
    // Allowlist match must be literal — quoted "$prefix" so glob chars in an operator prefix can't widen it.
    expect(yaml).toMatch(/\[\[ "\$runner_image" == "\$prefix"\* \]\]/);
    expect(yaml).toMatch(/GITHUB_REPOSITORY_OWNER is empty/);
  });

  it("comment trigger passes the PR base branch to the runner as GITHUB_DEFAULT_BRANCH", () => {
    const yaml = readFileSync("workflows/comment-trigger.yml", "utf-8");
    expect(yaml).toMatch(/default_branch:\s*\$\{\{\s*steps\.pr\.outputs\.default_branch\s*\}\}/);
    expect(yaml).toMatch(/core\.setOutput\("default_branch", pr\.data\.base\.ref/);
    expect(yaml).toMatch(/GITHUB_DEFAULT_BRANCH:\s*\$\{\{\s*needs\.check-trigger\.outputs\.default_branch\s*\}\}/);
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
    it(`${f} accepts run_config as the required envelope input and passes it through as AI_IMPLEMENT_RUN_CONFIG`, () => {
      const yaml = readFileSync(f, "utf-8");
      const doc = parse(yaml) as any;
      expect(doc.on.workflow_dispatch.inputs.run_config).toBeDefined();
      expect(doc.on.workflow_dispatch.inputs.run_config.required).toBe(true);
      expect(yaml).toMatch(/AI_IMPLEMENT_RUN_CONFIG:\s*\$\{\{\s*inputs\.run_config\s*\}\}/);
    });

    it(`${f} does not call Linear directly from the workflow`, () => {
      const yaml = readFileSync(f, "utf-8");
      expect(yaml).not.toMatch(/api\.linear\.app\/graphql/);
      expect(yaml).not.toMatch(/LINEAR_API_KEY/);
      expect(yaml).not.toMatch(/Update Linear labels/);
    });

    it(`${f} does not allow Claude to curl Linear directly`, () => {
      const yaml = readFileSync(f, "utf-8");
      expect(yaml).not.toMatch(/Bash\(curl\*api\.linear\.app\/graphql\*\)/);
    });
  }

  for (const f of PLANNING_WORKFLOWS) {
    it(`${f} has a validate-runner-image job that the plan job depends on`, () => {
      const yaml = readFileSync(f, "utf-8");
      expect(yaml).toMatch(/validate-runner-image:/);
      expect(yaml).toMatch(/needs:\s*validate-runner-image/);
      expect(yaml).toMatch(/image:\s*\$\{\{\s*needs\.validate-runner-image\.outputs\.runner_image\s*\}\}/);
      expect(yaml).toMatch(/ghcr\.io\/builddownai\/ai-implement-runner:latest/);
      expect(yaml).toMatch(/invalid characters for a container image reference/);
      expect(yaml).toMatch(/AI_IMPLEMENT_ALLOWED_RUNNER_IMAGE_PREFIXES=<prefix>/);
    });

    it(`${f} sets RUNNER_PHASE: planning in the entrypoint env and ends with entrypoint.sh`, () => {
      const yaml = readFileSync(f, "utf-8");
      expect(yaml).toMatch(/RUNNER_PHASE:\s*planning/);
      expect(yaml).toMatch(/\/opt\/ai-implement\/entrypoint\.sh/);
    });

    it(`${f} contains no anthropics/claude-code-action`, () => {
      const yaml = readFileSync(f, "utf-8");
      expect(yaml).not.toMatch(/anthropics\/claude-code-action/);
    });

    it(`${f} wires run tokens to the entrypoint env`, () => {
      const yaml = readFileSync(f, "utf-8");
      expect(yaml).toMatch(/RUN_TOKEN:\s*\$\{\{\s*inputs\.run_token\s*\}\}/);
      expect(yaml).toMatch(/RUN_PROGRESS_TOKEN:\s*\$\{\{\s*inputs\.run_progress_token\s*\}\}/);
      expect(yaml).not.toMatch(/run_publication_token/);
      expect(yaml).not.toMatch(/RUN_PUBLICATION_TOKEN/);
    });

    it(`${f} wires bedrock configure-aws-credentials guarded by provider == 'bedrock'`, () => {
      const yaml = readFileSync(f, "utf-8");
      expect(yaml).toMatch(/configure-aws-credentials/);
      expect(yaml).toMatch(/if:\s*inputs\.provider == 'bedrock'/);
      expect(yaml).toMatch(/role-session-duration:\s*14400/);
    });
  }
});
