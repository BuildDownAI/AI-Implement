import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

const script = "scripts/test-docker.sh";

describe("Docker test launcher", () => {
  it("passes bash syntax checking", () => {
    const result = spawnSync("bash", ["-n", script]);
    expect(result.status, result.stderr?.toString()).toBe(0);
  });

  it("passes shellcheck when installed", (context) => {
    const result = spawnSync("shellcheck", [script]);
    if ((result.error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") {
      context.skip();
      return;
    }
    expect(result.status, result.stderr?.toString()).toBe(0);
  });

  it("is exposed as test:docker", () => {
    const pkg = JSON.parse(readFileSync("package.json", "utf8"));
    expect(pkg.scripts["test:docker"]).toBe(`bash ${script}`);
  });

  it("uses the exact builder image, including its digest", () => {
    const dockerfile = readFileSync("Dockerfile", "utf8");
    const builder = dockerfile.match(/^FROM (\S+) AS builder$/m)?.[1];
    expect(builder).toMatch(/^node:24\..+@sha256:[a-f0-9]{64}$/);
    const launcher = readFileSync(script, "utf8");
    expect(launcher.match(/^image='([^']+)'$/m)?.[1]).toBe(builder);
  });

  it("rejects unknown suites before checking Docker", () => {
    const result = spawnSync("/bin/bash", [script, "unknown"], { env: { PATH: "" } });
    // Use an absolute bash path because the intentionally empty PATH hides Docker.
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(1);
    expect(result.stderr.toString()).toContain("Unknown suite: unknown");
  });
});
