import { beforeEach, describe, expect, it, vi } from "vitest";
import os from "node:os";
import { readFileSync } from "node:fs";
import type * as DeployModule from "../deploy.js";
import { fakeFetch } from "./helpers/fake-fetch.js";

let deploy: typeof DeployModule;


beforeEach(async () => {
  vi.resetModules();
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
  };

  it("is true when a token, an app and build stamps are all present", () => {
    expect(deploy.canSelfDeploy(configured)).toBe(true);
  });

  it.each(["flyDeployToken", "flyOrchestratorApp", "selfDeployTarget"] as const)(
    "is false without %s",
    (field) => {
      // The predicate is the single definition of "can this orchestrator deploy itself",
      // asserted directly here. A type
      // predicate's body is not verified by the compiler, so this table is what holds it honest.
      expect(deploy.canSelfDeploy({ ...configured, [field]: null })).toBe(false);
    },
  );
});

describe("self-deploy drain exclusion", () => {
  it("excludes only the supplied invocation and preserves the default query", async () => {
    const { queryNonCompletedInvocations } = await import("../restate/endpoint.js");
    const fake = fakeFetch({ "POST /query": { json: { rows: [{ count: 0 }] } } });
    await queryNonCompletedInvocations(fake.fetch, "http://admin", "http://endpoint", "inv'123");
    const excluded = JSON.parse(fake.calls[0].body).query as string;
    expect(excluded).toContain("id != 'inv''123'");
    expect(excluded).toContain("status != 'completed' AND status != 'scheduled'");
    expect(excluded).not.toContain("target_service_name !=");
    await queryNonCompletedInvocations(fake.fetch, "http://admin", "http://endpoint");
    expect(JSON.parse(fake.calls[1].body).query).not.toContain("id !=");
  });

  it("passes the exclusion through the drain factory", async () => {
    const fake = fakeFetch({ "POST /query": { json: { rows: [{ count: 0 }] } } }).install();
    expect(await deploy.createRestateDrainProbes("inv-123").oldDeploymentInvocations()).toBe(0);
    expect(JSON.parse(fake.calls[0].body).query).toContain("id != 'inv-123'");
  });

  it("checks published manifests with HEAD and returns auth failures without guessing", async () => {
    const { publishedImageManifestHead } = await import("../restate/self-deploy.js");
    const fake = fakeFetch({ "HEAD /v2/images/manifests/main-abcdef0": { status: 403 } });
    expect(await publishedImageManifestHead("registry.fly.io/images:main-abcdef0", "deploy-token", fake.fetch)).toBe(403);
    expect(fake.calls[0].headers.get("authorization")).toBe("Bearer deploy-token");
  });
});

describe("the in-memory deploy is gone", () => {
  it("exports no runDeploy, makeStartDeploy or in-process drain wait", () => {
    for (const name of ["runDeploy", "makeStartDeploy", "waitForQuiet", "drainPollMs"]) {
      expect(name in deploy).toBe(false);
    }
  });
});
