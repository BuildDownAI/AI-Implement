import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import os from "node:os";
import { readFileSync } from "node:fs";
import type * as DeployModule from "../deploy.js";
import { RestateDrainCoordinator } from "../restate/drain.js";
import { fakeFetch } from "./helpers/fake-fetch.js";
import { testDb } from "./helpers/test-db.js";
import { testDir } from "./helpers/test-dir.js";

let deploy: typeof DeployModule;

const DRAINED_PROBES = {
  oldDeploymentInvocations: async () => 0,
  unresolvedLaunches: async () => 0,
  unresolvedTerminations: async () => 0,
  activeOwners: async () => 0,
};

beforeEach(async () => {
  vi.resetModules();
  deploy = await import("../deploy.js");
});

/** Prepares a test whose deploy runs past `start()` in the background: its scratch directory goes
 *  under a `testDir` instead of the OS temp directory, and its flyctl download gets a 404, so it
 *  fails before any subprocess. The download is a stubbed global, not a `fakeFetch` route, because
 *  its URL embeds an unexported version and the runtime arch. Undone by `vi.unstubAllEnvs()` and
 *  `vi.unstubAllGlobals()`. */
function containBackgroundDeploy(): void {
  // deployScratch() creates its directory under os.tmpdir(), which reads these per call.
  const tempRoot = testDir("deploy");
  for (const name of ["TMPDIR", "TEMP", "TMP"]) vi.stubEnv(name, tempRoot);
  vi.stubGlobal("fetch", vi.fn(async () => new Response("nope", { status: 404 })));
}

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

  it("rejects asymmetric KG fields (token without repo)", () => {
    expect(() => deploy.deployArgs({ ...ARGS, kgSourceRepo: null })).toThrow(/kgToken and kgSourceRepo must both be set or both be absent/);
  });

  it("rejects asymmetric KG fields (repo without token)", () => {
    expect(() => deploy.deployArgs({ ...ARGS, kgToken: null })).toThrow(/kgToken and kgSourceRepo must both be set or both be absent/);
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

describe("endpoint drain barrier", () => {
  function coordinator(invocations: () => Promise<number | null>) {
    return new RestateDrainCoordinator({
      oldDeploymentInvocations: invocations,
      unresolvedLaunches: async () => 0,
      unresolvedTerminations: async () => 0,
      activeOwners: async () => 0,
    });
  }

  it("refuses a quiet dispatch log when the old endpoint is unknown", async () => {
    const drain = coordinator(async () => null);
    drain.begin();
    await expect(deploy.waitForQuiet(0, 1, drain, () => [])).rejects.toThrow(/did not drain/);
  });

  it("returns when no old-deployment invocation counts and nothing else is in flight", async () => {
    const drain = coordinator(async () => 0);
    drain.begin();
    await deploy.waitForQuiet(1000, 1, drain, () => []);
    expect(drain.snapshot().state).toBe("drained");
  });

  it("waits for old-deployment invocations separately from runner occupancy", async () => {
    let count = 1;
    const drain = coordinator(async () => count-- > 0 ? 1 : 0);
    drain.begin();
    await deploy.waitForQuiet(1000, 1, drain, () => []);
    expect(drain.snapshot().state).toBe("drained");
  });
});

describe("makeStartDeploy", () => {
  const configured = {
    flyDeployToken: "fly-token",
    flyOrchestratorApp: "orchestrator",
    selfDeployTarget: { owner: "Owner", repo: "Repo", branch: "testing", runningCommit: "abc" },
    pollIntervalMs: 60_000,
    restateDrainProbes: DRAINED_PROBES,
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

  /** The hold lives in the database, so these tests take deploy.js and deploy-hold.js over one of their own. */
  async function withDatabase(): Promise<typeof import("../deploy-hold.js")> {
    let hold: typeof import("../deploy-hold.js");
    ({ deploy, hold } = (
      await testDb({ modules: { deploy: () => import("../deploy.js"), hold: () => import("../deploy-hold.js") } })
    ).modules);
    return hold;
  }

  it("clears the hold when resolving HEAD throws, rather than pausing dispatch forever", async () => {
    const hold = await withDatabase();

    // Only a 404 is soft on these calls; anything else throws. `configured` carries a
    // stub private key so the App-token mint throws before any request, standing in
    // for the 5xx or 422 this has to survive — the hold is claimed by then.
    const start = deploy.makeStartDeploy(configured)!;
    await expect(start()).rejects.toThrow();
    expect(hold.isDeployHeld()).toBe(false);
  });

  it("refuses while a deploy already holds, before reaching the network", async () => {
    const hold = await withDatabase();
    hold.setDeployHold();

    // Asserting that nothing is fetched is the point: it is the only observable
    // difference between claiming the hold before the awaits and after them, and the
    // "after" ordering is the one that lets two triggers both start a deploy.
    const network = fakeFetch({});
    network.install();

    const start = deploy.makeStartDeploy(configured)!;
    await expect(start()).resolves.toEqual({ started: false, reason: "deploy-in-progress" });
    expect(network.calls).toHaveLength(0);
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

  beforeEach(async () => {
    vi.doMock("../github-app-auth.js", () => ({
      getScopedInstallationToken: vi.fn().mockResolvedValue({ token: "tok", expiresAt: "" }),
      mintSourceTokenOrJwt: vi.fn().mockResolvedValue({ token: "tok", authMode: "installation" }),
    }));
    vi.doMock("../github.js", () => ({
      fetchRepoTarball: vi.fn(),
      getRefSha: vi.fn().mockResolvedValue("def5678"),
    }));

    // testDb resets the module registry, so deploy.js is imported with the mocks above.
    ({ deploy: localDeploy } = (await testDb({ modules: { deploy: () => import("../deploy.js") } })).modules);
    containBackgroundDeploy();
  });

  afterEach(() => {
    vi.doUnmock("../github-app-auth.js");
    vi.doUnmock("../github.js");
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("uses the installation token path by default (auth=installation)", async () => {
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
      kgSourceRepo: null,
      onBuildFailure,
      restateDrainProbes: DRAINED_PROBES,
    })!;

    const result = await start();
    // HEAD resolved → started even though runDeploy will fail later at flyctl
    expect(result).toMatchObject({ started: true, commit: "def5678" });
    await called; // the deploy runs on in the background; it must end inside this test
  });

  it("calls onBuildFailure when runDeploy rejects", async () => {
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
      restateDrainProbes: DRAINED_PROBES,
    })!;

    const result = await start();
    expect(result).toMatchObject({ started: true, commit: "def5678" });

    await called;

    expect(onBuildFailure).toHaveBeenCalledWith("def5678", expect.any(Error));
  });
});

describe("makeStartDeploy — public mode (no App installation on source owner)", () => {
  // Re-setup with public auth mode: App not installed on source owner; reads are unauthenticated.
  let localDeploy: typeof DeployModule;
  let hold: typeof import("../deploy-hold.js");
  let github: typeof import("../github.js");
  let githubAuth: typeof import("../github-app-auth.js");

  beforeEach(async () => {
    vi.doMock("../github-app-auth.js", () => ({
      getScopedInstallationToken: vi.fn().mockResolvedValue({ token: "kg-tok", expiresAt: "" }),
      mintSourceTokenOrJwt: vi.fn().mockResolvedValue({ token: null, authMode: "public" }),
    }));
    vi.doMock("../github.js", () => ({
      fetchRepoTarball: vi.fn().mockResolvedValue(Buffer.alloc(0)),
      getRefSha: vi.fn().mockResolvedValue("def5678"),
    }));

    // testDb resets the module registry, so deploy.js and these loaders get the mocks above.
    ({ deploy: localDeploy, hold, github, githubAuth } = (
      await testDb({
        modules: {
          deploy: () => import("../deploy.js"),
          hold: () => import("../deploy-hold.js"),
          github: () => import("../github.js"),
          githubAuth: () => import("../github-app-auth.js"),
        },
      })
    ).modules);
    containBackgroundDeploy();
  });

  afterEach(() => {
    vi.doUnmock("../github-app-auth.js");
    vi.doUnmock("../github.js");
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("resolves HEAD and returns started:true when the source uses public (unauthenticated) fallback", async () => {
    let signalCalled = () => {};
    const called = new Promise<void>((resolve) => { signalCalled = resolve; });
    const start = localDeploy.makeStartDeploy({
      flyDeployToken: "fly-token",
      flyOrchestratorApp: "orchestrator",
      selfDeployTarget: { owner: "BuildDownAI", repo: "AI-Implement", branch: "main", runningCommit: null },
      pollIntervalMs: 60_000,
      githubAppId: "1",
      githubAppPrivateKey: "key",
      kgSourceRepo: null,
      onBuildFailure: vi.fn(() => signalCalled()),
      restateDrainProbes: DRAINED_PROBES,
    })!;

    const result = await start();
    expect(result).toMatchObject({ started: true, commit: "def5678" });
    await called; // the deploy runs on in the background; it must end inside this test
  });

  it("surfaces a fix message via onBuildFailure when tarball fails in public mode (private out-of-installation repo)", async () => {
    // fetchRepoTarball fails: private repo returns error when accessed without auth
    vi.mocked(github.fetchRepoTarball).mockRejectedValue(new Error("fetchRepoTarball failed: HTTP 404"));

    let signalCalled = () => {};
    const called = new Promise<void>((resolve) => { signalCalled = resolve; });
    let capturedError: unknown;
    const onBuildFailure = vi.fn((_, err: unknown) => { capturedError = err; signalCalled(); });

    const start = localDeploy.makeStartDeploy({
      flyDeployToken: "fly-token",
      flyOrchestratorApp: "orchestrator",
      selfDeployTarget: { owner: "BuildDownAI", repo: "AI-Implement", branch: "main", runningCommit: null },
      pollIntervalMs: 60_000,
      githubAppId: "1",
      githubAppPrivateKey: "key",
      kgSourceRepo: null,
      onBuildFailure,
      restateDrainProbes: DRAINED_PROBES,
    })!;

    const result = await start();
    expect(result).toMatchObject({ started: true, commit: "def5678" });

    await called;

    expect(onBuildFailure).toHaveBeenCalledWith("def5678", expect.any(Error));
    expect((capturedError as Error).message).toMatch(/Install the App|add the repository to the existing installation/);
  });

  it("does not fall back when a non-404 mint error occurs — clears the hold and rethrows", async () => {
    vi.mocked(githubAuth.mintSourceTokenOrJwt).mockRejectedValue(new Error("GitHub 422 Unprocessable Entity"));

    const start = localDeploy.makeStartDeploy({
      flyDeployToken: "fly-token",
      flyOrchestratorApp: "orchestrator",
      selfDeployTarget: { owner: "BuildDownAI", repo: "AI-Implement", branch: "main", runningCommit: null },
      pollIntervalMs: 60_000,
      githubAppId: "1",
      githubAppPrivateKey: "key",
      kgSourceRepo: null,
    })!;

    await expect(start()).rejects.toThrow("422");
    expect(hold.isDeployHeld()).toBe(false);
  });
});
