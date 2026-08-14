import { beforeEach, describe, expect, it, vi } from "vitest";
import os from "node:os";
import path from "node:path";
import type * as DeployModule from "../deploy.js";

let deploy: typeof DeployModule;

beforeEach(async () => {
  vi.resetModules();
  // deploy.ts reaches dedup.ts through deploy-hold.ts, and dedup resolves its path at
  // module load. Point it somewhere writable so the import doesn't warn; no test here
  // opens the database.
  process.env.DEDUP_DB_PATH = path.join(os.tmpdir(), `deploy-test-${Date.now()}.sqlite`);
  deploy = await import("../deploy.js");
});

const ARGS = {
  app: "orchestrator",
  kgToken: "kg-token",
  sourceCommit: "abc1234",
  sourceRepo: "Owner/Repo",
  sourceBranch: "testing",
};

describe("flyctlArch", () => {
  it("maps Node's arch names onto flyctl's release asset names", () => {
    expect(deploy.flyctlArch("x64")).toBe("x86_64");
    expect(deploy.flyctlArch("arm64")).toBe("arm64");
  });

  it("throws rather than guessing on an unknown architecture", () => {
    // Guessing would produce a 404 on the release URL at deploy time instead of here.
    expect(() => deploy.flyctlArch("mips")).toThrow(/unsupported architecture/);
  });
});

describe("deployArgs", () => {
  it("carries the three requirements a plain `fly deploy` is missing", () => {
    const args = deploy.deployArgs(ARGS);

    // Without the secret the KG clone fail-softs and /mcp ships dead.
    expect(args).toContain("--build-secret");
    expect(args).toContain("kg_token=kg-token");
    // A build secret is not part of the layer cache key, so a repeat deploy would
    // otherwise reuse a stale, possibly sidecar-less layer.
    expect(args).toContain("--no-cache");
    // Without the stamps the next image cannot tell what it is running.
    expect(args).toContain("SOURCE_COMMIT=abc1234");
    expect(args).toContain("SOURCE_REPO=Owner/Repo");
    expect(args).toContain("SOURCE_BRANCH=testing");
  });

  it("targets the requested app and builds remotely", () => {
    const args = deploy.deployArgs(ARGS);
    expect(args[0]).toBe("deploy");
    expect(args).toContain("--remote-only");
    expect(args[args.indexOf("--app") + 1]).toBe("orchestrator");
  });

  it.each(Object.keys(ARGS))("refuses to deploy with an empty %s", (field) => {
    // An empty secret is the original failure in a new costume: the build succeeds,
    // ships without a sidecar, and reports success.
    expect(() => deploy.deployArgs({ ...ARGS, [field]: "" })).toThrow(
      new RegExp(`empty ${field}`),
    );
  });
});

describe("drainPollMs", () => {
  it("samples twice per poll so a drain never sits a full interval on stale state", () => {
    // The in-flight set is only mutated by the poll loop, so checking faster than it
    // runs observes nothing new — but checking at exactly its rate can lock into a
    // phase that is always just-before the update.
    expect(deploy.drainPollMs(60_000)).toBe(30_000);
    expect(deploy.drainPollMs(15_000)).toBe(7_500);
  });

  it("floors at 5s so a very short configured interval cannot spin the database", () => {
    expect(deploy.drainPollMs(1_000)).toBe(5_000);
    expect(deploy.drainPollMs(0)).toBe(5_000);
  });
});

describe("interpretMcpProbe", () => {
  it("treats 401 as serving — alive and OAuth-gated", () => {
    expect(deploy.interpretMcpProbe(401)).toEqual({ serving: true });
  });

  it("treats 503 as not serving and carries the body, which names the cause", () => {
    // 503 has two causes that the status alone cannot separate: no KG sidecar, or an
    // unset OAUTH_REDIRECT_BASE_URL. The body distinguishes them; we pass it through
    // rather than parse it.
    const probe = deploy.interpretMcpProbe(503, '{"error":"KG sidecar not configured"}');
    expect(probe).toEqual({
      serving: false,
      reason: "mcp-unavailable",
      detail: '{"error":"KG sidecar not configured"}',
    });
  });

  it("reports any other status as not responding, keeping the status", () => {
    expect(deploy.interpretMcpProbe(502)).toEqual({
      serving: false,
      reason: "not-responding",
      status: 502,
    });
  });

  it("treats a failed request (status 0) as not responding, not as a bad release", () => {
    // A machine mid-restart refuses connections; that is not the same as shipping a
    // broken image, so it must stay retryable rather than terminal.
    expect(deploy.interpretMcpProbe(0)).toEqual({
      serving: false,
      reason: "not-responding",
      status: 0,
    });
  });
});

describe("makeStartDeploy", () => {
  const configured = {
    flyDeployToken: "fly-token",
    flyOrchestratorApp: "orchestrator",
    selfDeployTarget: { owner: "Owner", repo: "Repo", branch: "testing", runningCommit: "abc" },
    pollIntervalMs: 60_000,
    githubAppId: "1",
    githubAppPrivateKey: "key",
  };

  it("returns a starter when everything a deploy needs is present", () => {
    expect(typeof deploy.makeStartDeploy(configured)).toBe("function");
  });

  it.each(["flyDeployToken", "flyOrchestratorApp", "selfDeployTarget"] as const)(
    "returns undefined when %s is missing, so the route answers 501",
    (field) => {
      // Undefined here is what distinguishes "cannot deploy" from "deploy failed" —
      // an unconfigured orchestrator must refuse up front, not part-way through.
      expect(deploy.makeStartDeploy({ ...configured, [field]: null })).toBeUndefined();
    },
  );

  it("refuses while a deploy already holds, before reaching the network", async () => {
    const { initSettingsTable } = await import("../runner-mode.js");
    const { setDeployHold } = await import("../deploy-hold.js");
    const { closeDb } = await import("../dedup.js");
    initSettingsTable();
    setDeployHold();

    // Asserting that nothing is fetched is the point: it is the only observable
    // difference between claiming the hold before the awaits and after them, and the
    // "after" ordering is the one that lets two triggers both start a deploy.
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    try {
      const start = deploy.makeStartDeploy(configured)!;
      await expect(start()).resolves.toEqual({ started: false, reason: "deploy-in-progress" });
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
      closeDb();
    }
  });
});

describe("resolveFlyctl", () => {
  it("rejects a download whose digest does not match the pin", async () => {
    // The digest check runs before anything is written, so a tampered or truncated
    // download never reaches the disk or the deploy.
    const fetchImpl = vi.fn().mockResolvedValue(new Response(new Uint8Array([1, 2, 3])));

    await expect(deploy.resolveFlyctl(os.tmpdir(), fetchImpl as unknown as typeof fetch)).rejects.toThrow(
      /digest mismatch/,
    );
  });

  it("surfaces a failed download rather than proceeding", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response("nope", { status: 404 }));

    await expect(deploy.resolveFlyctl(os.tmpdir(), fetchImpl as unknown as typeof fetch)).rejects.toThrow(
      /HTTP 404/,
    );
  });
});
