import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { parse } from "yaml";

const FILES = [
  "workflows/claude-implement.yml",
  "workflows/comment-trigger.yml",
  ".github/workflows/claude-implement.yml",
];

describe("GHA workflow shims", () => {
  for (const f of FILES) {
    it(`${f} uses container:image referencing ai-implement-runner`, () => {
      const doc = parse(readFileSync(f, "utf-8")) as any;
      const jobs = Object.values(doc.jobs) as any[];
      // At least one job must be a container job referencing the runner image
      const containerJob = jobs.find((j) => j.container);
      expect(containerJob).toBeDefined();
      const image = typeof containerJob.container === "string" ? containerJob.container : containerJob.container.image;
      expect(String(image)).toMatch(/ai-implement-runner/);
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

    it(`${f} sets role-session-duration: 14400 if it uses Bedrock`, () => {
      const yaml = readFileSync(f, "utf-8");
      if (yaml.includes("configure-aws-credentials")) {
        expect(yaml).toMatch(/role-session-duration:\s*14400/);
      }
    });
  }
});
