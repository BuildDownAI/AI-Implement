import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { parse } from "yaml";

const IMPLEMENT_WORKFLOWS = [
  "workflows/claude-implement.yml",
  ".github/workflows/claude-implement.yml",
];
const FILES = [...IMPLEMENT_WORKFLOWS, "workflows/comment-trigger.yml"];

describe("GHA workflow shims", () => {
  it("keeps the canonical and synced dispatch workflows byte-for-byte identical", () => {
    expect(readFileSync(".github/workflows/claude-implement.yml", "utf-8")).toBe(
      readFileSync("workflows/claude-implement.yml", "utf-8"),
    );
  });

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
      expect(yaml).toMatch(/ghcr\.io\/builddownai\/ai-implement-runner:next/);
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
    expect(yaml).toMatch(/invalid characters for a container image reference/);
    expect(yaml).toMatch(/AI_IMPLEMENT_ALLOWED_RUNNER_IMAGE_PREFIXES=<prefix>/);
  });

  it("documents and constrains the ISSUE_META eval trust boundary", () => {
    const yaml = readFileSync("workflows/comment-trigger.yml", "utf-8");
    expect(yaml).toMatch(/lower_snake_case keys/);
    expect(yaml).toMatch(/jq @sh quotes values/);
    expect(yaml).toMatch(/jq -r 'to_entries\[\] \| "export/);
    expect(yaml).toMatch(/@sh/);
    expect(yaml).toMatch(/ISSUE_DESCRIPTION_B64.*base64 -d/);
  });
});
