import { readFileSync } from "node:fs";
import { parseEnv } from "node:util";
import { describe, expect, it, vi } from "vitest";
import { runCheckSetup, type CheckSetupDependencies } from "../check-setup.js";
import { SETUP_CHECKS, type SetupCheck, type SetupCheckContext, type SetupCheckRestateStatus } from "../setup-checks/index.js";
import { makeMapping } from "./helpers/builders.js";
import { fakeFetch, hangUntilAborted, stubAbortTimeout } from "./helpers/fake-fetch.js";
import { makeSetupCheckContext } from "./helpers/fixtures/setup-checks.js";

const REGISTERED: SetupCheckRestateStatus = { sidecar: { state: "ready" }, registration: { state: "registered" } };

/** The orchestrator's `GET /`, answering with the Restate status given, as `src/index.ts`'s health route does. */
function orchestratorAnswering(restate: SetupCheckRestateStatus = REGISTERED) {
  return fakeFetch({ "GET /": { json: { status: "ok", instanceId: "the-server", restate } } });
}

/** Nothing listening on the port: `fetch` rejects as it does on a refused connection. */
const notAnswering: typeof fetch = async () => {
  throw new TypeError("fetch failed");
};

const RESTATE_CHECK = SETUP_CHECKS.find((c) => c.id === "restate") as SetupCheck;

function check(overrides: Partial<SetupCheck> = {}): SetupCheck {
  return {
    id: "env.github-app",
    title: "Fake check",
    group: "orchestrator",
    tier: "core",
    onAdminPath: false,
    run: () => [{ state: "pass" }],
    ...overrides,
  };
}

/**
 * Fake dependencies throughout: the checks are the setup-check suites' job, so these assert only
 * what the command itself decides: what it reads, in which order, and how it reports.
 */
function deps(overrides: Partial<CheckSetupDependencies> = {}, context: Partial<SetupCheckContext> = {}) {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const base: CheckSetupDependencies = {
    checks: [check()],
    useReadOnlyDb: vi.fn(),
    configureTrackers: vi.fn(),
    createContext: (own) => makeSetupCheckContext({ ...context, ...own }),
    refreshRunnerBackend: vi.fn(async () => {}),
    fetch: orchestratorAnswering().fetch,
    port: 8080,
    writeStdout: (text) => {
      stdout.push(text);
    },
    writeStderr: (text) => {
      stderr.push(text);
    },
    ...overrides,
  };
  return { deps: base, stdout: () => stdout.join(""), stderr: () => stderr.join("") };
}

describe("runCheckSetup arguments", () => {
  it("prints usage and succeeds for --help, running nothing", async () => {
    const fetch = vi.fn(notAnswering);
    const d = deps({ fetch });

    expect(await runCheckSetup(["--help"], d.deps)).toBe(0);
    expect(d.stdout()).toContain("Usage: node dist/check-setup.js [--json]");
    expect(d.deps.useReadOnlyDb).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("refuses an unknown argument with exit code 2 and the usage, running nothing", async () => {
    const fetch = vi.fn(notAnswering);
    const d = deps({ fetch });

    expect(await runCheckSetup(["--jsn"], d.deps)).toBe(2);
    expect(d.stderr()).toContain("Unknown argument: --jsn");
    expect(d.stderr()).toContain("Usage: node dist/check-setup.js [--json]");
    expect(d.stdout()).toBe("");
    expect(d.deps.useReadOnlyDb).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe("before any check reads", () => {
  it("switches the database to read-only, then configures tracker credentials as boot does", async () => {
    const order: string[] = [];
    const d = deps({
      useReadOnlyDb: () => {
        order.push("read-only");
      },
      configureTrackers: () => {
        order.push("trackers");
      },
      checks: [check({ run: () => (order.push("check"), [{ state: "pass" }]) })],
    });

    await runCheckSetup([], d.deps);

    expect(order).toEqual(["read-only", "trackers", "check"]);
  });
});

describe("Restate's status, from the orchestrator's own health route", () => {
  it("asks GET / on the orchestrator's port, and hands its Restate status to the checks", async () => {
    const orchestrator = orchestratorAnswering();
    const d = deps({ fetch: orchestrator.fetch, port: 9123, checks: [RESTATE_CHECK] });

    expect(await runCheckSetup([], d.deps)).toBe(0);
    expect(orchestrator.calls.map((c) => `${c.method} ${c.url.href}`)).toEqual(["GET http://127.0.0.1:9123/"]);
    expect(d.stdout()).toMatch(/PASS +restate: /);
  });

  it("reports the orchestrator's own Restate fault, as the server knows it", async () => {
    const d = deps({
      fetch: orchestratorAnswering({ sidecar: { state: "ready" }, registration: { state: "declined-conflict" } }).fetch,
      checks: [RESTATE_CHECK],
    });

    expect(await runCheckSetup([], d.deps)).toBe(1);
    expect(d.stdout()).toMatch(/FAIL +restate: .*\n +The sidecar is ready and the endpoint registration is declined-conflict/);
  });

  it("reads Restate states from a 503 body and reports the failure", async () => {
    const d = deps({
      fetch: fakeFetch({ "GET /": { status: 503, json: { restate: { sidecar: { state: "starting" }, registration: { state: "not-attempted" } } } } }).fetch,
      checks: [RESTATE_CHECK],
    });

    expect(await runCheckSetup([], d.deps)).toBe(1);
    expect(d.stdout()).toMatch(/FAIL +restate: .*\n +The sidecar is starting and the endpoint registration is not-attempted/);
    expect(d.stdout()).not.toContain("CANNOT VERIFY");
  });

  it("reports Restate as cannot-verify, not as a failure, when the orchestrator is not answering", async () => {
    const d = deps({ fetch: notAnswering, checks: [RESTATE_CHECK] });

    expect(await runCheckSetup([], d.deps)).toBe(0);
    expect(d.stdout()).toMatch(/CANNOT VERIFY +restate: .*\n +The orchestrator is not answering on port 8080, so its health endpoint cannot be read\./);
  });

  it.each([
    ["a JSON body with no Restate status", { json: { status: "ok" } }],
    ["a body that is not JSON", { text: "<html>not the orchestrator</html>" }],
  ])("reports Restate as cannot-verify when something else answers on the port (%s)", async (_case, reply) => {
    const d = deps({ fetch: fakeFetch({ "GET /": reply }).fetch, checks: [RESTATE_CHECK] });

    expect(await runCheckSetup([], d.deps)).toBe(0);
    expect(d.stdout()).toMatch(/CANNOT VERIFY +restate: .*\n +Port 8080 answered without the orchestrator's health response, so it may not be this orchestrator\./);
  });

  it("gives up on a health route that never answers after five seconds", async () => {
    stubAbortTimeout(5_000);
    const d = deps({ fetch: fakeFetch({ "GET /": hangUntilAborted }).fetch, checks: [RESTATE_CHECK] });

    expect(await runCheckSetup([], d.deps)).toBe(0);
    expect(d.stdout()).toMatch(/CANNOT VERIFY +restate: .*\n +The orchestrator is not answering on port 8080/);
  });
});

describe("the server's instance identifier, from the same health read", () => {
  const INSTANCE_CHECK = check({ run: (ctx) => [{ state: "pass", detail: `instance ${ctx.orchestratorInstanceId()}` }] });

  it("hands the checks the identifier the orchestrator's own GET / carries, not this process's own", async () => {
    const d = deps({ checks: [INSTANCE_CHECK] });

    await runCheckSetup([], d.deps);

    expect(d.stdout()).toContain("instance the-server");
  });

  it("makes a check that asks for it cannot-verify, with the same reason as Restate's, when the orchestrator is not answering", async () => {
    const d = deps({ fetch: notAnswering, checks: [INSTANCE_CHECK] });

    expect(await runCheckSetup([], d.deps)).toBe(0);
    expect(d.stdout()).toMatch(/CANNOT VERIFY +env\.github-app: .*\n +The orchestrator is not answering on port 8080, so its health endpoint cannot be read\./);
  });
});

describe("the Fly sessions cache", () => {
  it("is refreshed from Restate before the checks run, once Restate is registered", async () => {
    const order: string[] = [];
    const d = deps({
      refreshRunnerBackend: async () => {
        order.push("refresh");
      },
      checks: [check({ run: () => (order.push("check"), [{ state: "pass" }]) })],
    });

    await runCheckSetup([], d.deps);

    expect(order).toEqual(["refresh", "check"]);
  });

  it.each([
    ["the orchestrator is not answering", () => notAnswering],
    ["the endpoint is not registered", () => orchestratorAnswering({ sidecar: { state: "timeout" }, registration: { state: "not-attempted" } }).fetch],
  ])("is left alone when %s, since Restate cannot answer", async (_case, makeFetch) => {
    const d = deps({ fetch: makeFetch() });

    await runCheckSetup([], d.deps);

    expect(d.deps.refreshRunnerBackend).not.toHaveBeenCalled();
  });
});

describe("output", () => {
  const CHECKS: SetupCheck[] = [
    check({ id: "env.github-app", title: "First", run: () => [{ state: "pass", detail: "Read the key" }] }),
    check({ id: "runner.fly-sessions", title: "Second", tier: "mode", run: () => [{ state: "warn", project: "ENG", detail: "A detail", fix: "A fix." }] }),
    check({ id: "env.admin-access-code", title: "Third", group: "tracker", run: () => [{ state: "fail", fix: "Do it." }] }),
  ];

  it("prints a table grouped by check group, with each state, detail and fix, and a summary", async () => {
    const d = deps({ checks: CHECKS });

    await runCheckSetup([], d.deps);

    expect(d.stdout()).toBe(
      [
        "orchestrator",
        "  PASS           env.github-app: First",
        "                 Read the key",
        "  WARN           runner.fly-sessions (ENG): Second",
        "                 A detail",
        "                 Fix: A fix.",
        "",
        "tracker",
        "  FAIL           env.admin-access-code: Third",
        "                 Fix: Do it.",
        "",
        "1 core check fails.",
        "",
      ].join("\n"),
    );
  });

  it.each([
    [0, "No core check fails."],
    [2, "2 core checks fail."],
  ])("ends the table with how many core checks fail (%i)", async (failing, summary) => {
    const checks = Array.from({ length: failing }, () => check({ run: () => [{ state: "fail" }] }));
    const d = deps({ checks: [...checks, check()] });

    await runCheckSetup([], d.deps);

    expect(d.stdout().trimEnd().split("\n").at(-1)).toBe(summary);
  });

  it("prints the run as JSON with --json", async () => {
    const d = deps({ checks: CHECKS });

    expect(await runCheckSetup(["--json"], d.deps)).toBe(1);
    expect(JSON.parse(d.stdout())).toEqual({
      checkedAt: expect.any(Number),
      results: [
        { id: "env.github-app", title: "First", group: "orchestrator", tier: "core", onAdminPath: false, state: "pass", detail: "Read the key" },
        { id: "runner.fly-sessions", title: "Second", group: "orchestrator", tier: "mode", onAdminPath: false, state: "warn", project: "ENG", detail: "A detail", fix: "A fix." },
        { id: "env.admin-access-code", title: "Third", group: "tracker", tier: "core", onAdminPath: false, state: "fail", fix: "Do it." },
      ],
    });
  });
});

describe("the exit code", () => {
  it.each([
    ["a core check fails", 1, { tier: "core", state: "fail" }],
    ["only a mode check fails", 0, { tier: "mode", state: "fail" }],
    ["a core check warns", 0, { tier: "core", state: "warn" }],
    ["a core check cannot verify", 0, { tier: "core", state: "cannot-verify" }],
  ] as const)("is set when %s: %i", async (_case, exitCode, { tier, state }) => {
    const d = deps({ checks: [check({ tier, run: () => [{ state }] }), check()] });

    expect(await runCheckSetup([], d.deps)).toBe(exitCode);
  });

  it.each([
    ["another core check fails", { state: "fail" as const }, 1],
    ["the others pass", { state: "pass" as const }, 0],
  ])("still reflects the other checks when one throws (%s)", async (_case, other, exitCode) => {
    const thrower = check({ id: "restate", title: "Thrower", run: () => {
      throw new Error("the check broke");
    } });
    const d = deps({ checks: [thrower, check({ run: () => [other] })] });

    expect(await runCheckSetup([], d.deps)).toBe(exitCode);
    expect(d.stdout()).toMatch(/CANNOT VERIFY +restate: Thrower\n +the check broke/);
  });
});

describe("secret values", () => {
  it("never appear in either output form", async () => {
    const secrets = {
      GITHUB_APP_PRIVATE_KEY: "sentinel-app-key",
      ADMIN_ACCESS_CODE: "sentinel-access-code",
      RUNNER_TOKEN_SECRET: "sentinel-token-secret",
      FLY_SESSIONS_TOKEN: "sentinel-fly-sessions-token",
      GOOGLE_OAUTH_CLIENT_SECRET: "sentinel-google-secret",
      MICROSOFT_OAUTH_CLIENT_SECRET: "sentinel-microsoft-secret",
      BUILDDOWN_OIDC_CLIENT_SECRET: "sentinel-builddown-secret",
    };
    const context: Partial<SetupCheckContext> = {
      env: {
        ...secrets,
        GITHUB_APP_ID: "123456",
        RUNNER_CALLBACK_BASE_URL: "https://orchestrator.example.com",
        GOOGLE_OAUTH_CLIENT_ID: "gid",
        MICROSOFT_OAUTH_CLIENT_ID: "mid",
        MICROSOFT_OAUTH_TENANT: "tenant-id",
        BUILDDOWN_OIDC_ISSUER: "https://cp.example.com",
        BUILDDOWN_OIDC_CLIENT_ID: "bid",
        OAUTH_REDIRECT_BASE_URL: "https://orchestrator.example.com",
      },
      mappings: () => ({ ENG: makeMapping({ executionMode: "fly-machines" }) }),
      flySessions: () => ({ token: secrets.FLY_SESSIONS_TOKEN, app: null, region: null, source: { app: null, region: null } }),
    };

    for (const args of [[], ["--json"]]) {
      const d = deps({ checks: SETUP_CHECKS }, context);
      await runCheckSetup(args, d.deps);
      expect(d.stdout().length, args.join(" ")).toBeGreaterThan(0);
      expect(d.stdout(), args.join(" ")).not.toContain("sentinel-");
    }
  });
});

describe("a raw copy of .env.example, with no orchestrator running", () => {
  it("exits 1, naming the placeholder App key, the missing admin path, the missing callback pair and Restate", async () => {
    // Parsed by Node's own .env parser, the one `npm run check-setup` loads it with.
    const env = parseEnv(readFileSync(".env.example", "utf8"));
    const d = deps({ checks: SETUP_CHECKS, fetch: notAnswering }, { env });

    expect(await runCheckSetup([], d.deps)).toBe(1);
    const out = d.stdout();
    expect(out).toMatch(/FAIL +env\.github-app: .*\n +GITHUB_APP_PRIVATE_KEY does not parse as a private key/);
    expect(out).toMatch(/FAIL +admin\.path: /);
    expect(out).toMatch(/FAIL +callback\.config: .*\n +RUNNER_CALLBACK_BASE_URL and RUNNER_TOKEN_SECRET not set/);
    expect(out).toMatch(/CANNOT VERIFY +restate: .*\n +The orchestrator is not answering on port 8080/);
  });
});
