import { describe, expect, it, vi } from "vitest";
import { encodeRunConfig, encodeTrustedRunConfig } from "../run-config.js";
import { formatLocalFullLoopEntrypointError, runLocalFullLoopFromEnv } from "../run-local-full-loop.js";
import { makeGrant, makeSnapshot } from "./configured-run-fixture.js";

describe("runLocalFullLoopFromEnv", () => {
  it("runs planning and implementation from the dev-run task envelope", async () => {
    const runFullLoop = vi.fn().mockResolvedValue({
      exitCode: 0,
      classification: "success",
      planningExitCode: 0,
      implementationExitCode: 0,
      reviewApproved: true,
      iterations: 1,
    });
    const output: string[] = [];
    const runConfig = encodeRunConfig({
      v: 1,
      issue: {
        id: "issue-1",
        identifier: "LOCAL-1",
        title: "Add health check",
        description: "Implement the endpoint.",
      },
      runnerPhase: "implementation",
      maxTurns: 25,
      maxIterations: 2,
    });

    const exitCode = await runLocalFullLoopFromEnv(
      {
        AI_IMPLEMENT_RUN_CONFIG: runConfig,
        WORKSPACE_DIR: "/workspace",
        CLAUDE_MODEL: "claude-test-model",
      },
      {
        runFullLoop,
        writeStdout: (text) => output.push(text),
      },
    );

    expect(runFullLoop).toHaveBeenCalledWith(expect.objectContaining({
      workspaceDir: "/workspace",
      issueId: "issue-1",
      issueIdentifier: "LOCAL-1",
      issueTitle: "Add health check",
      issueDescription: "Implement the endpoint.",
      maxTurns: 25,
      maxIterations: 2,
      model: "claude-test-model",
    }));
    expect(exitCode).toBe(0);
    expect(output.join("\n")).toContain("planning -> implementation -> review");
    expect(output.join("\n")).toContain("classification=success");
  });

  it("loads local session bootstrap for configured full-loop envelopes", async () => {
    const snapshot = makeSnapshot();
    const configured = { agentConfig: snapshot, localCredentialPort: { load: vi.fn() } };
    const onConfiguredFinish = vi.fn(async () => undefined);
    const loadLocalSessionBootstrap = vi.fn(async () => ({ configured, onConfiguredFinish }));
    const runFullLoop = vi.fn().mockResolvedValue({
      exitCode: 0,
      classification: "success",
      planningExitCode: 0,
      implementationExitCode: 0,
      reviewApproved: true,
      iterations: 1,
    });
    const runConfig = encodeRunConfig({
      v: 1,
      issue: {
        id: "issue-1",
        identifier: "LOCAL-1",
        title: "Add health check",
        description: "Implement the endpoint.",
      },
      runnerPhase: "implementation",
      agentConfig: snapshot,
    });

    await runLocalFullLoopFromEnv(
      {
        AI_IMPLEMENT_RUN_CONFIG: runConfig,
        WORKSPACE_DIR: "/workspace",
        AI_IMPLEMENT_LOCAL_AUTH_BOOTSTRAP_FILE: "/tmp/bootstrap.json",
      },
      {
        runFullLoop,
        loadLocalSessionBootstrap,
        writeStdout: vi.fn(),
      },
    );

    expect(loadLocalSessionBootstrap).toHaveBeenCalledWith({ env: expect.any(Object), snapshot, workspaceDir: "/workspace" });
    expect(runFullLoop).toHaveBeenCalledWith(expect.objectContaining({
      agentConfig: snapshot,
      configured,
      onConfiguredFinish,
    }));
  });

  it("passes hosted central grant envelopes through without demanding a local bootstrap file", async () => {
    const snapshot = makeSnapshot();
    const runFullLoop = vi.fn().mockResolvedValue({
      exitCode: 0,
      classification: "success",
      planningExitCode: 0,
      implementationExitCode: 0,
      reviewApproved: true,
      iterations: 1,
    });
    const loadLocalSessionBootstrap = vi.fn();
    const env = {
      AI_IMPLEMENT_RUN_CONFIG: encodeTrustedRunConfig({
        v: 1,
        issue: {
          id: "issue-1",
          identifier: "LOCAL-1",
          title: "Add health check",
          description: "Implement the endpoint.",
        },
        runnerPhase: "implementation",
        agentConfig: snapshot,
        credentials: { version: 1, modelAuthGrant: makeGrant(snapshot) },
      }),
      WORKSPACE_DIR: "/workspace",
    };

    await runLocalFullLoopFromEnv(env, {
      runFullLoop,
      loadLocalSessionBootstrap,
      writeStdout: vi.fn(),
    });

    expect(loadLocalSessionBootstrap).not.toHaveBeenCalled();
    expect(runFullLoop).toHaveBeenCalledWith(expect.objectContaining({
      agentConfig: snapshot,
      configured: undefined,
      configuredEnv: env,
    }));
  });

  it("rejects hosted grants without snapshots before running the full loop", async () => {
    const snapshot = makeSnapshot();
    const runFullLoop = vi.fn();
    const env = {
      AI_IMPLEMENT_RUN_CONFIG: encodeTrustedRunConfig({
        v: 1,
        issue: {
          id: "issue-1",
          identifier: "LOCAL-1",
          title: "Add health check",
          description: "Implement the endpoint.",
        },
        runnerPhase: "implementation",
        credentials: { version: 1, modelAuthGrant: makeGrant(snapshot) },
      }),
      WORKSPACE_DIR: "/workspace",
    };

    await expect(runLocalFullLoopFromEnv(env, {
      runFullLoop,
      loadLocalSessionBootstrap: vi.fn(),
      writeStdout: vi.fn(),
    })).rejects.toThrow("configured local full loop rejected before execution");
    expect(runFullLoop).not.toHaveBeenCalled();
  });

  it("rejects malformed local bootstrap configured intent before running the full loop", async () => {
    const runFullLoop = vi.fn();
    const env = {
      AI_IMPLEMENT_RUN_CONFIG: Buffer.from(JSON.stringify({
        v: 1,
        issue: {
          id: "issue-1",
          identifier: "LOCAL-1",
          title: "Add health check",
          description: "Implement the endpoint.",
        },
        runnerPhase: "implementation",
        agentConfig: { version: 1, snapshotId: "incomplete" },
      }), "utf8").toString("base64"),
      WORKSPACE_DIR: "/workspace",
      AI_IMPLEMENT_LOCAL_AUTH_BOOTSTRAP_FILE: "/tmp/bootstrap.json",
    };

    await expect(runLocalFullLoopFromEnv(env, {
      runFullLoop,
      loadLocalSessionBootstrap: vi.fn(),
      writeStdout: vi.fn(),
    })).rejects.toThrow();
    expect(runFullLoop).not.toHaveBeenCalled();
  });

  it("rejects a local bootstrap pointer with a legacy envelope before running the full loop", async () => {
    const runFullLoop = vi.fn();
    const env = {
      AI_IMPLEMENT_RUN_CONFIG: encodeRunConfig({
        v: 1,
        issue: {
          id: "issue-1",
          identifier: "LOCAL-1",
          title: "Add health check",
          description: "Implement the endpoint.",
        },
        runnerPhase: "implementation",
      }),
      WORKSPACE_DIR: "/workspace",
      AI_IMPLEMENT_LOCAL_AUTH_BOOTSTRAP_FILE: "/private/bootstrap-secret.json",
    };

    await expect(runLocalFullLoopFromEnv(env, {
      runFullLoop,
      loadLocalSessionBootstrap: vi.fn(),
      writeStdout: vi.fn(),
    })).rejects.toThrow("configured local full loop rejected before execution");
    expect(runFullLoop).not.toHaveBeenCalled();
  });

  it("uses static configured error text for configured entrypoint failures", () => {
    const snapshot = makeSnapshot();
    const configuredEnv = {
      AI_IMPLEMENT_RUN_CONFIG: encodeRunConfig({
        v: 1,
        issue: { id: "issue-1", identifier: "LOCAL-1", title: "T", description: "D" },
        agentConfig: snapshot,
      }),
    };
    expect(formatLocalFullLoopEntrypointError(configuredEnv, new Error("secret-ish detail"))).toBe(
      "configured local full loop rejected before execution",
    );
    expect(formatLocalFullLoopEntrypointError({ AI_IMPLEMENT_LOCAL_AUTH_BOOTSTRAP_FILE: "/private/x" }, new Error("secret-ish detail"))).toBe(
      "configured local full loop rejected before execution",
    );
    expect(formatLocalFullLoopEntrypointError({}, new Error("Missing required env var: X"))).toBe("Missing required env var: X");
  });
});
