import { describe, it, expect, vi, beforeEach } from "vitest";
import { installStep } from "../pipeline/steps/install.js";
import { DefaultPipelineContext } from "../pipeline/context.js";
import { NoopStepReporter } from "../pipeline/reporter.js";
import { EventEmitter } from "node:events";

vi.mock("node:child_process", () => ({
  spawn: vi.fn(),
}));

vi.mock("node:fs", () => ({
  default: {
    existsSync: vi.fn(),
    readFileSync: vi.fn(),
  },
}));

import { spawn } from "node:child_process";
import fs from "node:fs";

function mockSpawnSuccess() {
  vi.mocked(spawn).mockImplementation(() => {
    const emitter = new EventEmitter() as ReturnType<typeof spawn>;
    setImmediate(() => emitter.emit("close", 0));
    return emitter;
  });
}

function makeContext(): DefaultPipelineContext {
  return new DefaultPipelineContext({
    jobId: 1,
    issueId: "issue-1",
    issueIdentifier: "ENG-1",
    issueTitle: "Test",
    issueDescription: "Desc",
    nonce: "nonce",
    orchestratorUrl: "http://localhost:8080",
    ticketingProvider: "linear",
  });
}

function mockRootPackageJson(extraMatches?: (p: string) => boolean) {
  vi.mocked(fs.existsSync).mockImplementation((p) => {
    const rawPath = String(p);
    return rawPath.endsWith("package.json") || extraMatches?.(rawPath) === true;
  });
}

describe("installStep", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSpawnSuccess();
  });

  it("detects npm when no lock files exist", async () => {
    mockRootPackageJson();

    const outputs = await installStep.run(
      makeContext(),
      { workspaceDir: "/tmp/test" },
      new NoopStepReporter(),
    );

    expect(outputs.packageManager).toBe("npm");
    expect(outputs.installMethod).toBe("npm ci");
    expect(spawn).toHaveBeenCalledWith("npm", ["ci"], expect.anything());
  });

  it("detects yarn when yarn.lock exists", async () => {
    mockRootPackageJson((p) => p.endsWith("yarn.lock"));

    const outputs = await installStep.run(
      makeContext(),
      { workspaceDir: "/tmp/test" },
      new NoopStepReporter(),
    );

    expect(outputs.packageManager).toBe("yarn");
    expect(outputs.installMethod).toBe("yarn install --frozen-lockfile");
  });

  it("detects pnpm when pnpm-lock.yaml exists", async () => {
    mockRootPackageJson((p) => p.endsWith("pnpm-lock.yaml"));

    const outputs = await installStep.run(
      makeContext(),
      { workspaceDir: "/tmp/test" },
      new NoopStepReporter(),
    );

    expect(outputs.packageManager).toBe("pnpm");
    expect(outputs.installMethod).toBe("pnpm install --frozen-lockfile");
  });

  it("reads packageManager from .ai-implement/config.yml when present", async () => {
    mockRootPackageJson((p) => p.includes(".ai-implement/config.yml"));
    vi.mocked(fs.readFileSync).mockReturnValue("packageManager: pnpm\n");

    const outputs = await installStep.run(
      makeContext(),
      { workspaceDir: "/tmp/test" },
      new NoopStepReporter(),
    );

    expect(outputs.packageManager).toBe("pnpm");
  });

  it("parses models.implement from .ai-implement/config.yml", async () => {
    mockRootPackageJson((p) => p.includes(".ai-implement/config.yml"));
    vi.mocked(fs.readFileSync).mockReturnValue(
      "models:\n  implement: claude-opus-4-7\n",
    );

    const outputs = await installStep.run(
      makeContext(),
      { workspaceDir: "/tmp/test" },
      new NoopStepReporter(),
    );

    expect((outputs.repoModels as { implement?: string }).implement).toBe("claude-opus-4-7");
  });

  it("parses models.review from .ai-implement/config.yml", async () => {
    mockRootPackageJson((p) => p.includes(".ai-implement/config.yml"));
    vi.mocked(fs.readFileSync).mockReturnValue(
      "models:\n  review: claude-haiku-4-5-20251001\n",
    );

    const outputs = await installStep.run(
      makeContext(),
      { workspaceDir: "/tmp/test" },
      new NoopStepReporter(),
    );

    expect((outputs.repoModels as { review?: string }).review).toBe("claude-haiku-4-5-20251001");
  });

  it("parses both models from .ai-implement/config.yml", async () => {
    mockRootPackageJson((p) => p.includes(".ai-implement/config.yml"));
    vi.mocked(fs.readFileSync).mockReturnValue(
      "packageManager: npm\nmodels:\n  implement: claude-opus-4-7\n  review: claude-haiku-4-5-20251001\n",
    );

    const outputs = await installStep.run(
      makeContext(),
      { workspaceDir: "/tmp/test" },
      new NoopStepReporter(),
    );

    expect((outputs.repoModels as { implement?: string; review?: string })).toEqual({
      implement: "claude-opus-4-7",
      review: "claude-haiku-4-5-20251001",
    });
    expect(outputs.packageManager).toBe("npm");
  });

  it("returns empty repoModels when config.yml has no models section", async () => {
    mockRootPackageJson();

    const outputs = await installStep.run(
      makeContext(),
      { workspaceDir: "/tmp/test" },
      new NoopStepReporter(),
    );

    expect(outputs.repoModels).toEqual({});
  });

  it("includes durationMs in outputs", async () => {
    mockRootPackageJson();

    const outputs = await installStep.run(
      makeContext(),
      { workspaceDir: "/tmp/test" },
      new NoopStepReporter(),
    );

    expect(typeof outputs.durationMs).toBe("number");
    expect(outputs.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("throws when the install command exits with non-zero code", async () => {
    mockRootPackageJson();
    vi.mocked(spawn).mockImplementation(() => {
      const emitter = new EventEmitter() as ReturnType<typeof spawn>;
      setImmediate(() => emitter.emit("close", 1));
      return emitter;
    });

    await expect(
      installStep.run(makeContext(), { workspaceDir: "/tmp/test" }, new NoopStepReporter()),
    ).rejects.toThrow("exited with code 1");
  });

  it("skips install when the repo root has no package.json", async () => {
    vi.mocked(fs.existsSync).mockReturnValue(false);

    const outputs = await installStep.run(
      makeContext(),
      { workspaceDir: "/tmp/test" },
      new NoopStepReporter(),
    );

    expect(outputs.packageManager).toBe("none");
    expect(outputs.installMethod).toBe("skipped: no package.json");
    expect(outputs.durationMs).toBe(0);
    expect(spawn).not.toHaveBeenCalled();
  });

  it("preserves configured packageManager when skipping without package.json", async () => {
    vi.mocked(fs.existsSync).mockImplementation((p) =>
      String(p).includes(".ai-implement/config.yml"),
    );
    vi.mocked(fs.readFileSync).mockReturnValue("packageManager: pnpm\n");

    const outputs = await installStep.run(
      makeContext(),
      { workspaceDir: "/tmp/test" },
      new NoopStepReporter(),
    );

    expect(outputs.packageManager).toBe("pnpm");
    expect(outputs.installMethod).toBe("skipped: no package.json");
    expect(spawn).not.toHaveBeenCalled();
  });
});
