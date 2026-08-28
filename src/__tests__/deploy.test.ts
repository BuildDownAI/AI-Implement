import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import os from "node:os";
import path from "node:path";
import { readFileSync } from "node:fs";
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
  kgSourceRepo: "BuildDownAI/knowledge-graph-ai-implement",
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
    expect(args).toContain("KG_SOURCE_REPO=BuildDownAI/knowledge-graph-ai-implement");
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

  it.each(["app", "sourceCommit", "sourceRepo", "sourceBranch"] as const)(
    "refuses to deploy with an empty %s",
    (field) => {
      // An empty stamp leaves the next version unable to tell what it is running.
      expect(() => deploy.deployArgs({ ...ARGS, [field]: "" })).toThrow(
        new RegExp(`empty ${field}`),
      );
    },
  );

  it("omits KG build-secret and build-arg when kgToken or kgSourceRepo is absent", () => {
    // Null KG fields → sidecar-less build; no token leaks into the build context.
    const args = deploy.deployArgs({ ...ARGS, kgToken: null, kgSourceRepo: null });
    expect(args).not.toContain("--build-secret");
    expect(args.some((a) => a.startsWith("KG_SOURCE_REPO="))).toBe(false);
    expect(args).toContain("SOURCE_COMMIT=abc1234");
    expect(args[0]).toBe("deploy");
  });

  it("accepts a configured project-specific KG repo", () => {
    const args = deploy.deployArgs({ ...ARGS, kgSourceRepo: "Answer9-llc/knowledge-graph-answer9-app" });
    expect(args).toContain("KG_SOURCE_REPO=Answer9-llc/knowledge-graph-answer9-app");
  });

  it.each([
    "https://github.com/Answer9-llc/knowledge-graph-answer9-app",
    "Answer9-llc/knowledge-graph-answer9-app.git;echo nope",
    "Answer9-llc",
    "Answer9-llc/knowledge-graph-answer9-app/extra",
    "../knowledge-graph-answer9-app",
  ])("rejects malformed KG source repo %s", (kgSourceRepo) => {
    expect(() => deploy.deployArgs({ ...ARGS, kgSourceRepo })).toThrow(/KG_SOURCE_REPO/);
  });
});

describe("readKgSourceRepo", () => {
  it("returns null when the setting is absent", () => {
    expect(deploy.readKgSourceRepo(undefined)).toBeNull();
    expect(deploy.readKgSourceRepo(null)).toBeNull();
  });

  it("returns null without warning for an absent or empty value", () => {
    const warn = vi.fn();
    expect(deploy.readKgSourceRepo(undefined, warn)).toBeNull();
    expect(deploy.readKgSourceRepo(null, warn)).toBeNull();
    expect(deploy.readKgSourceRepo("", warn)).toBeNull();
    expect(warn).not.toHaveBeenCalled();
  });

  it("accepts a valid project-specific repository", () => {
    expect(deploy.readKgSourceRepo("Answer9-llc/knowledge-graph-answer9-app")).toBe(
      "Answer9-llc/knowledge-graph-answer9-app",
    );
  });

  it("warns and disables self-deploy for a malformed explicit value", () => {
    const warn = vi.fn();
    expect(deploy.readKgSourceRepo("https://github.com/Answer9-llc/kg", warn)).toBeNull();
    expect(warn).toHaveBeenCalledWith("[deploy] invalid KG_SOURCE_REPO; self-deploy disabled");
  });
});

describe("Dockerfile KG source repo wiring", () => {
  it("persists the KG_SOURCE_REPO build arg into the runtime image for later self-deploys", () => {
    const dockerfile = readFileSync(new URL("../../Dockerfile", import.meta.url), "utf8");

    expect(dockerfile).toMatch(/^ARG KG_SOURCE_REPO\s*$/m);
    expect(dockerfile).not.toContain("ARG KG_SOURCE_REPO=");
    expect(dockerfile).toContain("ENV KG_SOURCE_REPO=$KG_SOURCE_REPO");
    expect(dockerfile).toContain('[ "$kg_owner" = "$KG_SOURCE_REPO" ]');
    expect(dockerfile).toContain("KG_SOURCE_REPO not set — building without a knowledge graph");
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

describe("makeStartDeploy", () => {
  const configured = {
    flyDeployToken: "fly-token",
    flyOrchestratorApp: "orchestrator",
    selfDeployTarget: { owner: "Owner", repo: "Repo", branch: "testing", runningCommit: "abc" },
    pollIntervalMs: 60_000,
    githubAppId: "1",
    githubAppPrivateKey: "key",
    kgSourceRepo: "BuildDownAI/knowledge-graph-ai-implement",
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

  it("returns a starter when kgSourceRepo is null — deploy proceeds without KG", () => {
    // An operator running a KG-less orchestrator can still self-deploy; the KG token
    // mint is skipped and the build receives no KG build-arg, producing a sidecar-less image.
    expect(typeof deploy.makeStartDeploy({ ...configured, kgSourceRepo: null })).toBe("function");
  });

  it("clears the hold when resolving HEAD throws, rather than pausing dispatch forever", async () => {
    const { initSettingsTable } = await import("../runner-mode.js");
    const { isDeployHeld } = await import("../deploy-hold.js");
    const { closeDb } = await import("../dedup.js");
    initSettingsTable();

    try {
      // Only a 404 is soft on these calls; anything else throws. `configured` carries a
      // stub private key so the App-token mint throws before any request, standing in
      // for the 5xx or 422 this has to survive — the hold is claimed by then.
      const start = deploy.makeStartDeploy(configured)!;
      await expect(start()).rejects.toThrow();
      expect(isDeployHeld()).toBe(false);
    } finally {
      closeDb();
    }
  });

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

describe("canSelfDeploy", () => {
  const configured = {
    flyDeployToken: "fly-token",
    flyOrchestratorApp: "orchestrator",
    selfDeployTarget: { owner: "Owner", repo: "Repo", branch: "testing", runningCommit: "abc" },
    pollIntervalMs: 60_000,
    githubAppId: "1",
    githubAppPrivateKey: "key",
    kgSourceRepo: "BuildDownAI/knowledge-graph-ai-implement",
  };

  it("is true when a token, an app and build stamps are all present", () => {
    expect(deploy.canSelfDeploy(configured)).toBe(true);
  });

  it.each(["flyDeployToken", "flyOrchestratorApp", "selfDeployTarget"] as const)(
    "is false without %s",
    (field) => {
      // The predicate is the single definition of "can this orchestrator deploy itself",
      // asserted directly here rather than only through makeStartDeploy's return. A type
      // predicate's body is not verified by the compiler, so this table is what holds it honest.
      expect(deploy.canSelfDeploy({ ...configured, [field]: null })).toBe(false);
    },
  );

  it("is true when kgSourceRepo is null — KG is optional for self-deploy", () => {
    // An operator intentionally running without a KG can still self-deploy.
    expect(deploy.canSelfDeploy({ ...configured, kgSourceRepo: null })).toBe(true);
  });

  it("agrees with whether makeStartDeploy produces a starter", () => {
    // They must never disagree: the route answers 501 on the starter's absence while
    // the poll passenger gates on the predicate.
    expect(deploy.canSelfDeploy(configured)).toBe(deploy.makeStartDeploy(configured) !== undefined);
    const unconfigured = { ...configured, flyDeployToken: null };
    expect(deploy.canSelfDeploy(unconfigured)).toBe(deploy.makeStartDeploy(unconfigured) !== undefined);
  });
});

describe("makeStartDeploy onBuildFailure callback", () => {
  // Needs real SQLite (deploy-hold.ts writes to it), but mocks the two GitHub helpers
  // so we can control what commit is returned and skip the App-token mint.
  let localDeploy: typeof DeployModule;
  let closeDb: () => void;

  beforeEach(async () => {
    // Re-reset so the mocks below are visible when deploy.js is imported.
    vi.resetModules();
    process.env.DEDUP_DB_PATH = path.join(os.tmpdir(), `deploy-onbf-${Date.now()}.sqlite`);

    vi.doMock("../github-app-auth.js", () => ({
      getScopedInstallationToken: vi.fn().mockResolvedValue({ token: "tok", expiresAt: "" }),
    }));
    vi.doMock("../github.js", () => ({
      fetchRepoTarball: vi.fn(),
      getBranchSha: vi.fn().mockResolvedValue("def5678"),
    }));

    localDeploy = await import("../deploy.js");
    const { initSettingsTable } = await import("../runner-mode.js");
    initSettingsTable();
    const dedup = await import("../dedup.js");
    closeDb = dedup.closeDb;
  });

  afterEach(() => {
    closeDb?.();
    vi.doUnmock("../github-app-auth.js");
    vi.doUnmock("../github.js");
    vi.unstubAllGlobals();
  });

  it("calls onBuildFailure when runDeploy rejects", async () => {
    // resolveFlyctl uses global fetch; a 404 makes it reject before any subprocess.
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("nope", { status: 404 })));

    // Resolved by the callback itself rather than waited out: runDeploy is fire-and-forget,
    // so the test needs a signal, and a fixed sleep is a guess that gets tighter under load.
    let signalCalled = () => {};
    const called = new Promise<void>((resolve) => { signalCalled = resolve; });
    const onBuildFailure = vi.fn(() => signalCalled());
    const start = localDeploy.makeStartDeploy({
      flyDeployToken: "fly-token",
      flyOrchestratorApp: "orchestrator",
      selfDeployTarget: { owner: "Owner", repo: "Repo", branch: "testing", runningCommit: "abc" },
      pollIntervalMs: 60_000,
      githubAppId: "1",
      githubAppPrivateKey: "key",
      kgSourceRepo: "BuildDownAI/knowledge-graph-ai-implement",
      onBuildFailure,
    })!;

    const result = await start();
    expect(result).toMatchObject({ started: true, commit: "def5678" });

    await called;

    expect(onBuildFailure).toHaveBeenCalledWith("def5678", expect.any(Error));
  });
});
