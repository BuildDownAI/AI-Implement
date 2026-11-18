import { describe, expect, it } from "vitest";
import { generateKeyPairSync } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parse } from "smol-toml";
import { fakeFetch, hangUntilAborted, stubAbortTimeout } from "./helpers/fake-fetch.js";
import { testDir } from "./helpers/test-dir.js";
import { HEALTH_WAIT_MS, probeHealth, PROVISION_ENV_CHECKS, makeIo, provisionPreflight, runProvisionClient, type CommandResult, type ProvisionDependencies } from "../provision-client.js";

describe("probeHealth", () => {
  it("accepts 200 without reading JSON and exports a 15 minute deadline", async () => {
    fakeFetch({ "GET /": { status: 200, text: "ok" } }).install();
    expect(await probeHealth("https://orchestrator.fly.dev/")).toEqual({ kind: "serving" });
    expect(HEALTH_WAIT_MS).toBe(15 * 60_000);
  });

  it("accepts a 200 with startup states before S1-15 changes the server status contract", async () => {
    fakeFetch({ "GET /": { status: 200, json: { restate: { sidecar: { state: "starting" }, registration: { state: "not-attempted" } } } } }).install();
    expect(await probeHealth("https://orchestrator.fly.dev/")).toEqual({ kind: "serving" });
  });

  it("reads both Restate states from a 503", async () => {
    fakeFetch({ "GET /": { status: 503, json: { restate: { sidecar: { state: "starting" }, registration: { state: "not-attempted" } } } } }).install();
    expect(await probeHealth("https://orchestrator.fly.dev/")).toEqual({ kind: "starting", sidecar: "starting", registration: "not-attempted" });
  });

  it.each([
    { status: 201 }, { status: 500 }, { status: 503, text: "not JSON" },
    ...[null, {}, { restate: null }, { restate: { sidecar: null } },
      { restate: { sidecar: { state: 1 }, registration: { state: "pending" } } },
      { restate: { sidecar: { state: "ready" }, registration: { state: false } } },
      { restate: { sidecar: { state: "ready" } } },
    ].map((json) => ({ status: 503, json })),
  ])("treats other responses as not answering: %j", async (reply) => {
    fakeFetch({ "GET /": reply }).install();
    expect(await probeHealth("https://orchestrator.fly.dev/")).toEqual({ kind: "not-answering" });
  });

  it("catches fetch errors", async () => {
    fakeFetch({ "GET /": () => { throw new TypeError("fetch failed"); } }).install();
    expect(await probeHealth("https://orchestrator.fly.dev/")).toEqual({ kind: "not-answering" });
  });

  it("bounds the request at ten seconds", async () => {
    stubAbortTimeout(10_000);
    fakeFetch({ "GET /": hangUntilAborted }).install();
    expect(await probeHealth("https://orchestrator.fly.dev/")).toEqual({ kind: "not-answering" });
  });
});

const PEM = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const EXISTING_CLIENT_FILE = '[fly]\napp_name = "orchestrator"\norg = "my-org"\nregion = "lhr"\n';

/** Every secret a first run sets, generated ones included. Each value contains "sentinel" so a leak is easy to find. */
const SECRET_KEYS = [
  "GOOGLE_OAUTH_CLIENT_SECRET", "LINEAR_CLIENT_SECRET", "GITHUB_APP_PRIVATE_KEY", "RUNNER_TOKEN_SECRET",
  "GITHUB_WEBHOOK_SECRET", "FLY_DEPLOY_TOKEN", "FLY_SESSIONS_TOKEN",
];

/** An answer for each prompt, by label prefix. The longest matching prefix wins, and a list is answered in order. */
type Answers = Record<string, string | string[]>;

interface FakeOptions {
  /** Answers over the defaults, for a first run of a Google and Linear client. */
  answers?: Answers;
  clientFile?: string;
  /** Apps already on Fly. */
  apps?: string[];
  /** Secret names already on the orchestrator's app. */
  secrets?: string[];
  volumes?: Array<{ name: string; region: string }>;
  /** Whether the orchestrator's app has been deployed, so it has booted and taken its seeds. */
  released?: boolean;
  origin?: string;
  /** A reply that replaces the fake's own for a matching call. */
  respond?: (tool: string, args: string[]) => CommandResult | undefined;
}

interface Call {
  tool: string;
  args: string[];
  stdin?: string;
  /** The output shown before the tool ran. */
  shownBefore: string;
}

/** Whether `text` is shown on a line of its own, however it is indented, as a value to copy is. */
function onItsOwnLine(output: string, text: string): boolean {
  return output.split("\n").some((line) => line.trim() === text);
}

/** A check's row as `check-setup` prints it, by its state and id alone: the check's own wording is its module's to test. */
function checkRow(state: "FAIL" | "WARN", id: string): RegExp {
  return new RegExp(`^ *${state} +${id.replaceAll(".", "\\.")}:`, "m");
}

/** The last line shown before a call or a write, which names what is about to happen. */
function announced(effect: { shownBefore: string } | undefined): string {
  return effect?.shownBefore.trimEnd().split("\n").pop() ?? "";
}

async function fakeDeps(options: FakeOptions = {}) {
  const dir = testDir("provision");
  const pemPath = join(dir, "app.pem");
  await writeFile(pemPath, PEM);
  const answers: Answers = {
    OAUTH_ALLOWED_EMAILS: "admin@example.com",
    GOOGLE_OAUTH_CLIENT_ID: "google-id",
    GOOGLE_OAUTH_CLIENT_SECRET: "google-secret-sentinel",
    MICROSOFT_OAUTH_CLIENT_ID: "microsoft-id",
    MICROSOFT_OAUTH_CLIENT_SECRET: "microsoft-secret-sentinel",
    MICROSOFT_OAUTH_TENANT: "00000000-0000-0000-0000-000000000000",
    LINEAR_CLIENT_ID: "linear-id",
    LINEAR_CLIENT_SECRET: "linear-secret-sentinel",
    LINEAR_WORKSPACE_URL: "https://linear.app/client",
    JIRA_EMAIL: "jira@example.com",
    JIRA_CLOUD_ID: "jira-cloud-id",
    JIRA_TOKEN: "jira-token-sentinel",
    JIRA_SITE_URL: "https://client.atlassian.net",
    GITHUB_APP_ID: "987654321",
    GITHUB_APP_PRIVATE_KEY: pemPath,
    CLAUDE_CODE_OAUTH_TOKEN: "subscription-token-sentinel",
    "Generate a break-glass": "yes",
    ...options.answers,
  };
  const overrides = options.answers ?? {};
  const asked = new Map<string, number>();
  const calls: Call[] = [];
  /** Each question asked, with the output shown before it. */
  const prompts: Array<{ label: string; hidden: boolean; shownBefore: string }> = [];
  const writes: Array<{ path: string; content: string; shownBefore: string }> = [];
  const mints: string[][] = [];
  let stdout = "";
  let stderr = "";
  /** Both streams in the order they were written, as a terminal shows them. */
  let terminal = "";
  let time = 0;
  let generated = 0;

  const answer = (label: string): string => {
    // A value already on Fly is kept unless the test answers it on purpose.
    const pool = label.includes("already set") ? overrides : answers;
    const prefix = Object.keys(pool).filter((key) => label.startsWith(key)).sort((a, b) => b.length - a.length)[0];
    if (prefix === undefined) return "";
    const value = pool[prefix]!;
    if (!Array.isArray(value)) return value;
    const index = asked.get(prefix) ?? 0;
    asked.set(prefix, index + 1);
    return value[index] ?? "";
  };

  const flyctl = (args: string[]): string => {
    const [command, sub] = args;
    if (command === "apps" && sub === "list") return JSON.stringify((options.apps ?? []).map((Name) => ({ Name })));
    if (command === "secrets" && sub === "list") return JSON.stringify((options.secrets ?? []).map((name) => ({ name })));
    if (command === "volumes" && sub === "list") return JSON.stringify(options.volumes ?? []);
    if (command === "releases") return JSON.stringify(options.released ? [{ Version: 1, Status: "complete" }] : []);
    if (command === "tokens") return `token-for-${args[args.indexOf("--app") + 1]}-sentinel\n`;
    if (command === "machines") return JSON.stringify([{ state: "started" }]);
    if (command === "ssh") return "No core check fails.\n";
    return "";
  };
  const git = (args: string[]): string => {
    if (args[0] === "remote") return `${options.origin ?? "git@github.com:fork-owner/fork-repo.git"}\n`;
    return args.includes("--abbrev-ref") ? "feature\n" : "0123456789abcdef0123\n";
  };

  const deps: ProvisionDependencies = {
    prompt: async (label, hidden) => {
      prompts.push({ label, hidden, shownBefore: stdout });
      return answer(label);
    },
    readFile: async (path) => (path.startsWith("clients/") ? options.clientFile ?? null : readFile(path, "utf8")),
    writeFile: async (path, content) => {
      writes.push({ path, content, shownBefore: stdout });
    },
    run: async (tool, args, stdin, onOutput) => {
      calls.push({ tool, args, ...(stdin === undefined ? {} : { stdin }), shownBefore: stdout });
      const result = options.respond?.(tool, args) ?? { code: 0, stdout: tool === "git" ? git(args) : flyctl(args), stderr: "" };
      // A streamed tool hands its output over as it runs, in pieces that need not end at a line.
      if (onOutput) for (const piece of [result.stdout, result.stderr].join("").match(/[\s\S]{1,7}/g) ?? []) onOutput(piece);
      return result;
    },
    kgToken: async (...args) => {
      mints.push(args);
      return "kg-build-token-sentinel";
    },
    generateSecret: () => `generated-${++generated}-sentinel`,
    probeHealth: async () => ({ kind: "serving" }),
    homeDir: () => dir,
    now: () => time,
    sleep: async (ms) => {
      time += ms;
    },
    writeStdout: (text) => {
      stdout += text;
      terminal += text;
    },
    writeStderr: (text) => {
      stderr += text;
      terminal += text;
    },
  };

  /** The variables the one `flyctl secrets import` set, read back from its stdin. */
  const imported = (): Record<string, string> => {
    const call = calls.find((c) => c.args[0] === "secrets" && c.args[1] === "import");
    const lines = (call?.stdin ?? "").split("\n").filter(Boolean);
    return Object.fromEntries(lines.map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]));
  };
  const flyCalls = (command: string, sub?: string) => calls.filter((c) => c.tool === "flyctl" && c.args[0] === command && (sub === undefined || c.args[1] === sub));
  /** True when nothing was written, created, minted or set: only listings ran. */
  const changedNothing = () => writes.length === 0 && calls.every((c) => c.tool !== "flyctl" || c.args[1] === "list" || c.args[0] === "releases");

  return { deps, calls, prompts, writes, mints, imported, flyCalls, changedNothing, pemPath, stdout: () => stdout, stderr: () => stderr, terminal: () => terminal, time: () => time };
}

const EVERY_SECRET_RETAINED = [
  "OAUTH_ALLOWED_EMAILS", "RUNNER_CALLBACK_BASE_URL", "OAUTH_REDIRECT_BASE_URL", "GOOGLE_OAUTH_CLIENT_ID", "GOOGLE_OAUTH_CLIENT_SECRET",
  "LINEAR_CLIENT_ID", "LINEAR_CLIENT_SECRET", "LINEAR_WORKSPACE_URL", "GITHUB_APP_ID", "GITHUB_APP_PRIVATE_KEY", "RUNNER_TOKEN_SECRET",
  "GITHUB_WEBHOOK_SECRET", "ADMIN_ACCESS_CODE", "FLY_DEPLOY_TOKEN", "FLY_SESSIONS_TOKEN", "FLY_SESSIONS_APP", "FLY_SESSIONS_REGION",
];

describe("runProvisionClient", () => {
  describe("its argument", () => {
    it.each(["", "UPPER", "-client", "client-", "a/b"])("refuses the slug %j with the usage, before any effect", async (slug) => {
      const f = await fakeDeps();
      expect(await runProvisionClient([slug], f.deps)).toBe(2);
      expect(f.stderr()).toContain("Usage: npm run provision-client -- <slug>");
      expect(f.calls).toEqual([]);
      expect(f.prompts).toEqual([]);
    });

    it("accepts a one-character slug", async () => {
      const f = await fakeDeps();
      expect(await runProvisionClient(["a"], f.deps)).toBe(0);
      expect(f.writes.map((w) => w.path)).toEqual(["clients/a.toml"]);
    });
  });

  describe("the client file", () => {
    it("remembers the App ID, the .pem path, both base addresses and the knowledge-graph repository, none of them secret", async () => {
      const f = await fakeDeps({ answers: { KG_SOURCE_REPO: "graph-owner/graph" } });
      await runProvisionClient(["client"], f.deps);
      const written = parse(f.writes[0]!.content) as { fly: object; answers: object };
      expect(written.fly).toEqual({ app_name: "ai-implement-client", org: "personal", region: "iad" });
      expect(written.answers).toEqual({
        app_id: "987654321",
        private_key_path: f.pemPath,
        redirect_base_url: "https://ai-implement-client.fly.dev",
        callback_base_url: "https://ai-implement-client.fly.dev",
        kg_source_repo: "graph-owner/graph",
      });
    });

    it("keeps an operator's own lines and comments when it adds what it remembers", async () => {
      const own = `# Our production orchestrator.\n${EXISTING_CLIENT_FILE}`;
      const f = await fakeDeps({ clientFile: own, apps: ["orchestrator"], released: true });
      expect(await runProvisionClient(["client"], f.deps)).toBe(0);
      expect(f.writes[0]?.content.startsWith(`${own.trimEnd()}\n\n[answers]\n`)).toBe(true);
    });

    it("replaces its own table, and nothing else, on a later run", async () => {
      const own = `${EXISTING_CLIENT_FILE}\n[answers]\napp_id = "111"\n`;
      const f = await fakeDeps({ clientFile: own, apps: ["orchestrator"], released: true });
      expect(await runProvisionClient(["client"], f.deps)).toBe(0);
      const written = parse(f.writes[0]!.content) as { fly: object; answers: { app_id: string } };
      expect(written.fly).toEqual({ app_name: "orchestrator", org: "my-org", region: "lhr" });
      expect(written.answers.app_id).toBe("987654321");
      expect(f.writes[0]?.content.match(/\[answers\]/g)).toHaveLength(1);
    });

    it("reads a .pem path that starts with ~ from the home directory", async () => {
      const f = await fakeDeps({ answers: { GITHUB_APP_PRIVATE_KEY: "~/app.pem", "Target repo": ["owner/repo", ""] } });
      expect(await runProvisionClient(["client"], f.deps)).toBe(0);
      expect(f.imported().GITHUB_APP_PRIVATE_KEY).toBe(PEM.replaceAll("\n", "\\n"));
      expect(f.stdout()).toContain(`< ${f.pemPath}`);
    });

    it("carries a new client's own app name, organization and region into everything derived from them", async () => {
      const f = await fakeDeps({ answers: { "Fly app": "acme-orch", "Fly organization": "acme-org", "Primary region": "lhr" } });
      expect(await runProvisionClient(["client"], f.deps)).toBe(0);
      expect(f.prompts.find((p) => p.label.startsWith("Sessions organization"))?.label).toContain("[acme-org]");
      expect(f.prompts.find((p) => p.label.startsWith("Sessions region"))?.label).toContain("[lhr]");
      expect(f.imported()).toMatchObject({
        RUNNER_CALLBACK_BASE_URL: "https://acme-orch.fly.dev",
        OAUTH_REDIRECT_BASE_URL: "https://acme-orch.fly.dev",
        FLY_SESSIONS_REGION: "lhr",
      });
      const shown = f.prompts.find((p) => p.label.startsWith("GOOGLE_OAUTH_CLIENT_ID"))?.shownBefore ?? "";
      expect(onItsOwnLine(shown, "https://acme-orch.fly.dev/api/auth/google/callback")).toBe(true);
      expect(f.flyCalls("apps", "create")[1]?.args).toEqual(["apps", "create", "ai-implement-sessions-client", "--org", "acme-org"]);
    });
  });

  describe("a first run", () => {
    it("creates both apps and the volume, mints both deploy tokens, and sets every value in one import on stdin", async () => {
      const f = await fakeDeps();
      expect(await runProvisionClient(["client"], f.deps)).toBe(0);
      expect(f.flyCalls("apps", "create").map((c) => c.args)).toEqual([
        ["apps", "create", "ai-implement-client", "--org", "personal"],
        ["apps", "create", "ai-implement-sessions-client", "--org", "personal"],
      ]);
      expect(f.flyCalls("volumes", "create")[0]?.args).toEqual(["volumes", "create", "dedup_data", "--size", "1", "--region", "iad", "--app", "ai-implement-client", "--yes"]);
      expect(f.flyCalls("tokens").map((c) => c.args)).toEqual([
        ["tokens", "create", "deploy", "--app", "ai-implement-client", "--expiry", "8760h"],
        ["tokens", "create", "deploy", "--app", "ai-implement-sessions-client"],
      ]);
      expect(f.flyCalls("secrets", "import")).toHaveLength(1);
      // Until the import succeeds this run's answers exist only in the command, so it comes before the volume.
      const order = f.calls.filter((c) => c.tool === "flyctl" && c.args[1] !== "list").map((c) => c.args.slice(0, 2).join(" "));
      expect(order.indexOf("secrets import")).toBeLessThan(order.indexOf("volumes create"));
      const env = f.imported();
      expect(env).toMatchObject({
        RUNNER_CALLBACK_BASE_URL: "https://ai-implement-client.fly.dev",
        OAUTH_REDIRECT_BASE_URL: "https://ai-implement-client.fly.dev",
        FLY_SESSIONS_APP: "ai-implement-sessions-client",
        FLY_SESSIONS_REGION: "iad",
        FLY_DEPLOY_TOKEN: "token-for-ai-implement-client-sentinel",
        GITHUB_APP_PRIVATE_KEY: PEM.replaceAll("\n", "\\n"),
      });
      expect(env).not.toHaveProperty("ANTHROPIC_API_KEY");
    });

    it("sets an environment that every provisioning check passes", async () => {
      const f = await fakeDeps();
      expect(await runProvisionClient(["client"], f.deps)).toBe(0);
      const failing = (await provisionPreflight(f.imported())).filter((row) => row.state === "fail" || row.state === "warn");
      expect(failing).toEqual([]);
    });

    it("reads secrets hidden and every other value in the open", async () => {
      const f = await fakeDeps({ answers: { "Will projects run": "yes", "NOTIFY_WEBHOOK_URL": "https://hooks.example.com/sentinel" } });
      expect(await runProvisionClient(["client"], f.deps)).toBe(0);
      const hidden = f.prompts.filter((p) => p.hidden).map((p) => p.label.split(" ")[0]);
      expect(hidden).toEqual(["GOOGLE_OAUTH_CLIENT_SECRET", "LINEAR_CLIENT_SECRET", "CLAUDE_CODE_OAUTH_TOKEN", "NOTIFY_WEBHOOK_URL"]);
    });

    it("never shows a secret, nor passes one as an argument, and shows the access code once", async () => {
      const f = await fakeDeps({ answers: { "Will projects run": "yes", "Target repo": ["owner/repo", ""] } });
      expect(await runProvisionClient(["client"], f.deps)).toBe(0);
      const env = f.imported();
      const shown = f.stdout() + f.stderr() + JSON.stringify(f.calls.map((c) => c.args));
      for (const key of [...SECRET_KEYS, "CLAUDE_CODE_OAUTH_TOKEN"]) expect(shown).not.toContain(env[key]);
      expect(f.stdout().split(env.ADMIN_ACCESS_CODE!)).toHaveLength(2);
    });

    it("prints the sign-in redirect addresses, one to a line, before it asks for the sign-in application's credentials", async () => {
      const f = await fakeDeps();
      await runProvisionClient(["client"], f.deps);
      const shown = f.prompts.find((p) => p.label.startsWith("GOOGLE_OAUTH_CLIENT_ID"))?.shownBefore ?? "";
      expect(onItsOwnLine(shown, "https://ai-implement-client.fly.dev/api/auth/google/callback")).toBe(true);
      expect(onItsOwnLine(shown, "https://ai-implement-client.fly.dev/mcp/callback/google")).toBe(true);
    });

    it("opens with its guide and how a default is taken, before anything is read or asked", async () => {
      const f = await fakeDeps();
      await runProvisionClient(["client"], f.deps);
      const opening = f.calls[0]!.shownBefore;
      expect(onItsOwnLine(opening, "https://docs.builddown.ai/latest/setup/deploy")).toBe(true);
      expect(opening).toMatch(/Enter.*\[brackets\]/);
    });

    it("says something before each variable's question, with an example for one of a known shape", async () => {
      const f = await fakeDeps();
      await runProvisionClient(["client"], f.deps);
      const variables = f.prompts.filter((p) => /^[A-Z][A-Z_]+ \[/.test(p.label));
      // Each question follows output of its own: no two are asked with nothing shown between them.
      for (const [i, p] of variables.entries()) {
        if (i > 0) expect(p.shownBefore, p.label).not.toBe(variables[i - 1]!.shownBefore);
      }
      const explained = (key: string) => f.prompts.find((p) => p.label.startsWith(key))?.shownBefore.trimEnd().split("\n\n").pop() ?? "";
      expect(explained("LINEAR_WORKSPACE_URL")).toContain("https://linear.app/your-workspace");
      expect(explained("OAUTH_ALLOWED_EMAILS")).toContain("you@example.com");
    });

    it.each(["basic", "oauth"])("sets up Microsoft sign-in and Jira %s with no Linear question", async (mode) => {
      const f = await fakeDeps({ answers: { "Sign-in provider": "microsoft", "Ticketing system": "jira", "Jira mode": mode } });
      expect(await runProvisionClient(["client"], f.deps)).toBe(0);
      expect(f.prompts.some((p) => p.label.startsWith("LINEAR_") || p.label.startsWith("GOOGLE_"))).toBe(false);
      expect(f.imported()).toHaveProperty(mode === "basic" ? "JIRA_EMAIL" : "JIRA_CLOUD_ID");
      expect(f.imported()).not.toHaveProperty(mode === "basic" ? "JIRA_CLOUD_ID" : "JIRA_EMAIL");
      expect((await provisionPreflight(f.imported())).filter((row) => row.state === "fail" || row.state === "warn")).toEqual([]);
      expect(f.stdout()).toContain("/api/auth/microsoft/callback");
    });

    it("asks no Jira question of a Linear client", async () => {
      const f = await fakeDeps();
      await runProvisionClient(["client"], f.deps);
      expect(f.prompts.some((p) => p.label.startsWith("JIRA_") || p.label.startsWith("Jira"))).toBe(false);
    });
  });

  describe("model credentials", () => {
    it("on a Claude subscription, sets the token and prints it for each target repo", async () => {
      const f = await fakeDeps({ answers: { "Will projects run": "yes", "Target repo": ["owner/one", "owner/two", ""] } });
      expect(await runProvisionClient(["client"], f.deps)).toBe(0);
      expect(f.imported().CLAUDE_CODE_OAUTH_TOKEN).toBe("subscription-token-sentinel");
      for (const repo of ["owner/one", "owner/two"]) expect(f.stdout()).toContain(`gh secret set CLAUDE_CODE_OAUTH_TOKEN --repo ${repo}`);
    });

    it("names the secrets a target repository needs before asking for one, the subscription's token only when it is used", async () => {
      const without = await fakeDeps();
      await runProvisionClient(["client"], without.deps);
      const before = (f: Awaited<ReturnType<typeof fakeDeps>>) => f.prompts.find((p) => p.label.startsWith("Target repo"))?.shownBefore.trimEnd().split("\n\n").pop() ?? "";
      expect(before(without)).toContain("AI_IMPLEMENT_APP_ID");
      expect(before(without)).toContain("AI_IMPLEMENT_PRIVATE_KEY");
      expect(before(without)).not.toContain("CLAUDE_CODE_OAUTH_TOKEN");
      const subscribed = await fakeDeps({ answers: { "Will projects run": "yes" } });
      await runProvisionClient(["client"], subscribed.deps);
      expect(before(subscribed)).toContain("CLAUDE_CODE_OAUTH_TOKEN");
    });

    it("without one, asks for no model credential and points to Models & providers", async () => {
      const f = await fakeDeps({ answers: { "Target repo": ["owner/one", ""] } });
      expect(await runProvisionClient(["client"], f.deps)).toBe(0);
      expect(f.prompts.some((p) => /^(CLAUDE_CODE_OAUTH_TOKEN|ANTHROPIC_API_KEY)/.test(p.label))).toBe(false);
      expect(f.stdout()).not.toContain("CLAUDE_CODE_OAUTH_TOKEN");
      expect(f.stdout()).toContain("Models & providers");
    });
  });

  describe("the next steps", () => {
    it("print the App pair for each target repo, the webhook, and the stepper, and nothing stale", async () => {
      const f = await fakeDeps({ answers: { "Target repo": ["owner/repo", ""] } });
      await runProvisionClient(["client"], f.deps);
      expect(f.stdout()).toContain("gh secret set AI_IMPLEMENT_APP_ID --repo owner/repo --body 987654321");
      expect(f.stdout()).toContain(`gh secret set AI_IMPLEMENT_PRIVATE_KEY --repo owner/repo < ${f.pemPath}`);
      expect(onItsOwnLine(f.stdout(), "https://ai-implement-client.fly.dev/api/github/webhook")).toBe(true);
      for (const event of ["Issue comment", "Pull request", "Pull request review", "Pull request review comment"]) expect(f.stdout()).toContain(event);
      expect(f.stdout()).toContain("printenv GITHUB_WEBHOOK_SECRET");
      // Adding a project, and opting it in to a model account, are the guide's to explain.
      expect(onItsOwnLine(f.stdout(), "https://docs.builddown.ai/latest/setup/target-repo")).toBe(true);
      expect(f.stdout()).not.toMatch(/push to main|set-github-secrets|sync-workflow\.yml|Allow GitHub Actions/);
    });

    it("repeats the redirect addresses at the end only as a reminder of what was asked at sign-in", async () => {
      const f = await fakeDeps();
      await runProvisionClient(["client"], f.deps);
      const lines = f.stdout().split("\n");
      const address = "https://ai-implement-client.fly.dev/api/auth/google/callback";
      const introductions = lines.flatMap((line, i) => (line.trim() === address ? [lines.slice(0, i).reverse().find((l) => l.trim() && !l.includes("://"))] : []));
      expect(introductions).toHaveLength(2);
      expect(introductions[1]).not.toBe(introductions[0]);
    });

    it("use no em dash or semicolon anywhere in the output", async () => {
      const f = await fakeDeps({ answers: { "Target repo": ["owner/repo", ""], "Deploy now": "yes", "Wait up to": "yes" } });
      await runProvisionClient(["client"], f.deps);
      expect(f.stdout() + f.stderr()).not.toMatch(/[—;]/);
    });
  });

  describe("checking the answers before anything is written", () => {
    it("shows a failing check and its fix for a .pem that does not parse", async () => {
      const f = await fakeDeps();
      const read = f.deps.readFile;
      f.deps.readFile = async (path) => (path.endsWith(".pem") ? "not-a-key-sentinel" : read(path));
      expect(await runProvisionClient(["client"], f.deps)).toBe(1);
      expect(f.stdout()).toMatch(checkRow("FAIL", "env.github-app"));
      expect(f.stdout()).not.toContain("not-a-key-sentinel");
      expect(f.changedNothing()).toBe(true);
    });

    it("shows the provider check for a multi-tenant Microsoft value", async () => {
      const f = await fakeDeps({ answers: { "Sign-in provider": "microsoft", MICROSOFT_OAUTH_TENANT: "common" } });
      expect(await runProvisionClient(["client"], f.deps)).toBe(1);
      expect(f.stdout()).toMatch(checkRow("WARN", "admin.providers"));
      expect(f.changedNothing()).toBe(true);
    });

    it("refuses a generated access code that is the published placeholder", async () => {
      const f = await fakeDeps();
      f.deps.generateSecret = () => "your-secret-access-code";
      expect(await runProvisionClient(["client"], f.deps)).toBe(1);
      expect(f.stdout()).toMatch(checkRow("FAIL", "env.admin-access-code"));
      expect(f.changedNothing()).toBe(true);
    });

    it.each<[string, Answers]>([
      ["a non-numeric App ID", { GITHUB_APP_ID: "not-numeric" }],
      ["no App ID", { GITHUB_APP_ID: "" }],
      ["a target repo that is not owner/repo", { "Target repo": "badrepo" }],
      ["a value that would start another line of the import", { GOOGLE_OAUTH_CLIENT_SECRET: "evil\nINJECTED=value" }],
      ["an admin address that is not an email", { OAUTH_ALLOWED_EMAILS: "not-an-email" }],
      ["a secret of only spaces", { GOOGLE_OAUTH_CLIENT_SECRET: "   " }],
      ["a sign-in provider it does not offer", { "Sign-in provider": "github" }],
    ])("refuses %s three times, then stops before anything changes", async (_, answers) => {
      const f = await fakeDeps({ answers });
      expect(await runProvisionClient(["client"], f.deps)).toBe(1);
      expect(f.changedNothing()).toBe(true);
    });

    it("refuses a .pem path that cannot be read, naming it", async () => {
      const f = await fakeDeps({ answers: { GITHUB_APP_PRIVATE_KEY: "/missing/app.pem" } });
      expect(await runProvisionClient(["client"], f.deps)).toBe(1);
      expect(f.stdout()).toContain("/missing/app.pem");
      expect(f.changedNothing()).toBe(true);
    });

    it("asks a wrong answer again, saying why, and keeps every other answer", async () => {
      const f = await fakeDeps({ answers: { GITHUB_APP_ID: ["not-numeric", "987654321"] } });
      expect(await runProvisionClient(["client"], f.deps)).toBe(0);
      // The reason is said once, naming the variable, and the question comes back.
      expect(f.stdout().split("\n").filter((line) => line.includes("GITHUB_APP_ID"))).toHaveLength(1);
      expect(f.prompts.filter((p) => p.label.startsWith("GITHUB_APP_ID"))).toHaveLength(2);
      expect(f.prompts.filter((p) => p.label.startsWith("OAUTH_ALLOWED_EMAILS"))).toHaveLength(1);
      expect(f.imported().GITHUB_APP_ID).toBe("987654321");
    });

    it("checks the sign-in answers as soon as they are in, and asks that group again with Enter keeping each answer", async () => {
      const f = await fakeDeps({
        answers: {
          "Sign-in provider": "microsoft",
          MICROSOFT_OAUTH_TENANT: ["common", "00000000-0000-0000-0000-000000000000"],
          MICROSOFT_OAUTH_CLIENT_SECRET: ["microsoft-secret-sentinel", ""],
        },
      });
      expect(await runProvisionClient(["client"], f.deps)).toBe(0);
      expect(f.stdout()).toMatch(checkRow("WARN", "admin.providers"));
      // The ticketing system comes after the sign-in group, so it is asked once, after the group passed.
      expect(f.prompts.filter((p) => p.label.startsWith("Ticketing system"))).toHaveLength(1);
      expect(f.prompts.find((p) => p.label.startsWith("MICROSOFT_OAUTH_CLIENT_SECRET [Enter to keep your earlier answer]"))).toBeDefined();
      expect(f.imported()).toMatchObject({ MICROSOFT_OAUTH_CLIENT_SECRET: "microsoft-secret-sentinel", MICROSOFT_OAUTH_TENANT: "00000000-0000-0000-0000-000000000000" });
    });

    it("refuses a kept BuildDown provider missing its secret", async () => {
      const f = await fakeDeps({ clientFile: EXISTING_CLIENT_FILE, apps: ["orchestrator"], secrets: ["BUILDDOWN_OIDC_ISSUER", "BUILDDOWN_OIDC_CLIENT_ID"] });
      expect(await runProvisionClient(["client"], f.deps)).toBe(1);
      expect(f.stdout()).toMatch(checkRow("WARN", "admin.providers"));
      expect(f.stdout()).toContain("BUILDDOWN_OIDC_CLIENT_SECRET");
      expect(f.changedNothing()).toBe(true);
    });

    it.each(["google", "microsoft"])("passes a complete kept BuildDown provider beside new %s sign-in", async (provider) => {
      const kept = ["BUILDDOWN_OIDC_ISSUER", "BUILDDOWN_OIDC_CLIENT_ID", "BUILDDOWN_OIDC_CLIENT_SECRET"];
      const f = await fakeDeps({ clientFile: EXISTING_CLIENT_FILE, apps: ["orchestrator"], secrets: kept, answers: { "Sign-in provider": provider } });
      expect(await runProvisionClient(["client"], f.deps)).toBe(0);
      for (const key of kept) expect(f.imported()).not.toHaveProperty(key);
    });

    it("refuses a changed Microsoft tenant though its other credentials are kept", async () => {
      const kept = ["MICROSOFT_OAUTH_CLIENT_ID", "MICROSOFT_OAUTH_CLIENT_SECRET", "MICROSOFT_OAUTH_TENANT"];
      const f = await fakeDeps({
        clientFile: EXISTING_CLIENT_FILE,
        apps: ["orchestrator"],
        secrets: kept,
        answers: { "Keep every value": "no", MICROSOFT_OAUTH_TENANT: "common" },
      });
      expect(await runProvisionClient(["client"], f.deps)).toBe(1);
      expect(f.stdout()).toMatch(checkRow("WARN", "admin.providers"));
      expect(f.changedNothing()).toBe(true);
    });

    it("asks a new client's app name again when it is not a Fly name", async () => {
      const f = await fakeDeps({ answers: { "Fly app": ["my_app!", "my-app"] } });
      expect(await runProvisionClient(["client"], f.deps)).toBe(0);
      expect(f.prompts.filter((p) => p.label.startsWith("Fly app ["))).toHaveLength(2);
      expect(f.flyCalls("apps", "create")[0]?.args).toEqual(["apps", "create", "my-app", "--org", "personal"]);
    });

    it("refuses an existing client file whose names are not Fly names", async () => {
      const f = await fakeDeps({ clientFile: '[fly]\napp_name = "my_app!"\norg = "my-org"\nregion = "lhr"\n' });
      expect(await runProvisionClient(["client"], f.deps)).toBe(1);
      expect(f.stderr()).toContain("client file");
      expect(f.changedNothing()).toBe(true);
    });

    it("refuses a client file that is not TOML without showing its contents", async () => {
      const f = await fakeDeps({ clientFile: "[fly\nsecret-sentinel" });
      expect(await runProvisionClient(["client"], f.deps)).toBe(1);
      expect(f.stderr()).toBe("clients/client.toml is not valid TOML.\n");
      expect(f.calls.map((c) => c.args)).toEqual([["apps", "list", "--json"]]);
    });
  });

  describe("provisionPreflight", () => {
    it("runs exactly the environment, admin and callback checks", () => {
      expect(PROVISION_ENV_CHECKS.map((check) => check.id)).toEqual([
        "env.github-app", "env.admin-access-code", "env.runner-mode", "env.poll-interval", "env.breaker-threshold",
        "callback.config", "admin.path", "admin.providers", "admin.redirect-url", "admin.allowlist",
      ]);
    });

    // Its context throws for anything but the environment, so a check that read this machine's own state would throw here.
    it("reads nothing but the environment", async () => {
      await expect(provisionPreflight({})).resolves.toEqual(expect.any(Array));
    });

    it("leaves a check of a kept value to the remote checks", async () => {
      const rows = await provisionPreflight({ POLL_INTERVAL_MS: "fast" }, new Set(["GITHUB_APP_PRIVATE_KEY", "GITHUB_APP_ID"]));
      expect(rows.map((row) => row.id)).not.toContain("env.github-app");
      expect(rows.find((row) => row.id === "env.poll-interval")?.state).toBe("fail");
    });
  });

  describe("a re-run", () => {
    it("keeps the client file, the apps, the volume and every secret left empty, and seeds no sessions variable", async () => {
      const f = await fakeDeps({
        clientFile: EXISTING_CLIENT_FILE,
        apps: ["orchestrator", "ai-implement-sessions-client"],
        secrets: EVERY_SECRET_RETAINED,
        volumes: [{ name: "dedup_data", region: "lhr" }],
        released: true,
      });
      expect(await runProvisionClient(["client"], f.deps)).toBe(0);
      expect(f.writes).toEqual([]);
      expect(f.calls.filter((c) => c.args[1] === "create")).toEqual([]);
      expect(f.flyCalls("secrets", "import")).toEqual([]);
      expect(f.stdout()).toContain("Settings page");
    });

    it("sets the sessions seed again when the app holds it but was never deployed, since nothing has taken it yet", async () => {
      const f = await fakeDeps({ clientFile: EXISTING_CLIENT_FILE, apps: ["orchestrator", "ai-implement-sessions-client"], secrets: EVERY_SECRET_RETAINED });
      expect(await runProvisionClient(["client"], f.deps)).toBe(0);
      expect(f.imported()).toEqual({ FLY_SESSIONS_APP: "ai-implement-sessions-client", FLY_SESSIONS_REGION: "lhr" });
      expect(f.stdout()).not.toContain("Settings page");
    });

    it("asks only what is not kept on Fly when every value is kept", async () => {
      const f = await fakeDeps({ clientFile: EXISTING_CLIENT_FILE, apps: ["orchestrator"], secrets: EVERY_SECRET_RETAINED, volumes: [{ name: "dedup_data", region: "lhr" }] });
      expect(await runProvisionClient(["client"], f.deps)).toBe(0);
      expect(f.prompts.map((p) => p.label.split(/[ ,:]/)[0])).toEqual(["Keep", "Will", "KG_SOURCE_REPO", "Target", "Deploy", "Wait", "Run"]);
    });

    it("shows no heading for a group it asks nothing in, where a first run shows each", async () => {
      const groups = ["Admin sign-in", "GitHub App", "Setting up Fly"];
      const first = await fakeDeps();
      await runProvisionClient(["client"], first.deps);
      for (const group of groups) expect(onItsOwnLine(first.stdout(), group)).toBe(true);
      const f = await fakeDeps({ clientFile: EXISTING_CLIENT_FILE, apps: ["orchestrator"], secrets: EVERY_SECRET_RETAINED, released: true, volumes: [{ name: "dedup_data", region: "lhr" }] });
      expect(await runProvisionClient(["client"], f.deps)).toBe(0);
      for (const group of groups) expect(onItsOwnLine(f.stdout(), group)).toBe(false);
      expect(f.stdout()).not.toContain("Generate a private key");
    });

    it("shows a held group's heading before a question that opens the group", async () => {
      const f = await fakeDeps();
      const io = makeIo(f.deps);
      io.group("A group", "What the group is for.");
      await io.ask("First question");
      expect(f.prompts[0]?.shownBefore).toContain("A group");
      expect(f.prompts[0]?.shownBefore).toContain("What the group is for.");
    });

    it("offers the knowledge-graph repository the client file remembers, and builds with it on Enter", async () => {
      const g = await fakeDeps();
      const remembered = `${EXISTING_CLIENT_FILE}\n[answers]\napp_id = "987654321"\nprivate_key_path = "${g.pemPath}"\nkg_source_repo = "graph-owner/graph"\n`;
      const f = await fakeDeps({
        clientFile: remembered,
        apps: ["orchestrator"],
        secrets: EVERY_SECRET_RETAINED,
        released: true,
        answers: { "Deploy now": "yes" },
      });
      expect(await runProvisionClient(["client"], f.deps)).toBe(0);
      expect(f.prompts.find((p) => p.label.startsWith("KG_SOURCE_REPO"))?.label).toContain("[graph-owner/graph]");
      expect(f.flyCalls("deploy")[0]?.args).toEqual(expect.arrayContaining(["KG_SOURCE_REPO=graph-owner/graph"]));
    });

    it("prints the webhook under the callback address the client file remembers when the value is kept on Fly", async () => {
      const remembered = `${EXISTING_CLIENT_FILE}\n[answers]\ncallback_base_url = "https://orchestrator.example.com"\n`;
      const f = await fakeDeps({ clientFile: remembered, apps: ["orchestrator"], secrets: EVERY_SECRET_RETAINED, released: true });
      expect(await runProvisionClient(["client"], f.deps)).toBe(0);
      expect(onItsOwnLine(f.stdout(), "https://orchestrator.example.com/api/github/webhook")).toBe(true);
    });

    it("asks a failing group again in full on a kept re-run, then keeps the later groups' values unasked", async () => {
      const f = await fakeDeps({
        clientFile: EXISTING_CLIENT_FILE,
        apps: ["orchestrator"],
        secrets: EVERY_SECRET_RETAINED.filter((key) => !key.startsWith("GOOGLE_")).concat("MICROSOFT_OAUTH_CLIENT_ID", "MICROSOFT_OAUTH_CLIENT_SECRET"),
        answers: { MICROSOFT_OAUTH_TENANT: ["common", "00000000-0000-0000-0000-000000000000"] },
      });
      expect(await runProvisionClient(["client"], f.deps)).toBe(0);
      expect(f.prompts.some((p) => p.label.startsWith("OAUTH_ALLOWED_EMAILS [already set"))).toBe(true);
      expect(f.prompts.some((p) => p.label.startsWith("LINEAR_") || p.label.startsWith("GITHUB_APP_ID"))).toBe(false);
    });

    it("asks every question with Enter keeping each value, when the operator does not keep them all", async () => {
      const f = await fakeDeps({ clientFile: EXISTING_CLIENT_FILE, apps: ["orchestrator"], secrets: EVERY_SECRET_RETAINED, released: true, answers: { "Keep every value": "no" } });
      expect(await runProvisionClient(["client"], f.deps)).toBe(0);
      expect(f.prompts.filter((p) => p.label.includes("already set, Enter to keep")).length).toBeGreaterThan(10);
      expect(f.flyCalls("secrets", "import")).toEqual([]);
    });

    it("replaces only the secret the operator answers", async () => {
      const f = await fakeDeps({
        clientFile: EXISTING_CLIENT_FILE,
        apps: ["orchestrator"],
        secrets: EVERY_SECRET_RETAINED,
        volumes: [{ name: "dedup_data", region: "lhr" }],
        released: true,
        answers: { "Keep every value": "no", LINEAR_CLIENT_SECRET: "new-linear-secret-sentinel" },
      });
      expect(await runProvisionClient(["client"], f.deps)).toBe(0);
      expect(f.imported()).toEqual({ LINEAR_CLIENT_SECRET: "new-linear-secret-sentinel" });
    });

    it("creates the volume in the client's region when the only one is elsewhere", async () => {
      const f = await fakeDeps({ clientFile: EXISTING_CLIENT_FILE, apps: ["orchestrator"], volumes: [{ name: "dedup_data", region: "iad" }] });
      expect(await runProvisionClient(["client"], f.deps)).toBe(0);
      expect(f.flyCalls("volumes", "create")[0]?.args).toContain("lhr");
    });

    it("mints a missing sessions token for the active app named on /admin#settings, never the client file's", async () => {
      const f = await fakeDeps({
        clientFile: EXISTING_CLIENT_FILE,
        apps: ["orchestrator", "active-sessions"],
        secrets: ["FLY_SESSIONS_APP"],
        released: true,
        answers: { "Active sessions app": "active-sessions" },
      });
      expect(await runProvisionClient(["client"], f.deps)).toBe(0);
      expect(f.flyCalls("apps", "create")).toEqual([]);
      expect(f.flyCalls("tokens").map((c) => c.args)).toContainEqual(["tokens", "create", "deploy", "--app", "active-sessions"]);
      expect(f.imported()).not.toHaveProperty("FLY_SESSIONS_APP");
      expect(f.imported()).not.toHaveProperty("FLY_SESSIONS_REGION");
    });

    it.each<[string, string]>([["no answer", ""], ["an app not on Fly", "missing-app"]])(
      "refuses %s for the active sessions app, before anything changes",
      async (_, active) => {
        const f = await fakeDeps({ clientFile: EXISTING_CLIENT_FILE, apps: ["orchestrator"], secrets: ["FLY_SESSIONS_APP"], released: true, answers: { "Active sessions app": active } });
        expect(await runProvisionClient(["client"], f.deps)).toBe(1);
        expect(f.changedNothing()).toBe(true);
      },
    );

    it("offers the kept Microsoft and Jira choices", async () => {
      const kept = ["MICROSOFT_OAUTH_CLIENT_ID", "MICROSOFT_OAUTH_CLIENT_SECRET", "MICROSOFT_OAUTH_TENANT", "JIRA_EMAIL", "JIRA_TOKEN", "JIRA_SITE_URL"];
      const f = await fakeDeps({ clientFile: EXISTING_CLIENT_FILE, apps: ["orchestrator"], secrets: kept, answers: { "Keep every value": "no" } });
      expect(await runProvisionClient(["client"], f.deps)).toBe(0);
      expect(f.prompts.find((p) => p.label.startsWith("Sign-in provider"))?.label).toContain("[microsoft]");
      expect(f.prompts.find((p) => p.label.startsWith("Ticketing system"))?.label).toContain("[jira]");
    });

    it("takes the kept Microsoft and Jira choices unasked when every value is kept", async () => {
      const kept = ["MICROSOFT_OAUTH_CLIENT_ID", "MICROSOFT_OAUTH_CLIENT_SECRET", "MICROSOFT_OAUTH_TENANT", "JIRA_EMAIL", "JIRA_TOKEN", "JIRA_SITE_URL"];
      const f = await fakeDeps({ clientFile: EXISTING_CLIENT_FILE, apps: ["orchestrator"], secrets: kept });
      expect(await runProvisionClient(["client"], f.deps)).toBe(0);
      expect(f.prompts.some((p) => /^(Sign-in provider|Ticketing system|Jira mode)/.test(p.label))).toBe(false);
      expect(f.stdout()).toContain("/api/auth/microsoft/callback");
    });

    it("offers Jira OAuth when it is kept, and keeps its credentials", async () => {
      const f = await fakeDeps({
        clientFile: EXISTING_CLIENT_FILE,
        apps: ["orchestrator"],
        secrets: ["JIRA_CLOUD_ID", "JIRA_TOKEN", "JIRA_SITE_URL"],
        answers: { "Keep every value": "no", "Ticketing system": "jira" },
      });
      expect(await runProvisionClient(["client"], f.deps)).toBe(0);
      expect(f.prompts.find((p) => p.label.startsWith("Jira mode"))?.label).toContain("[oauth]");
      for (const key of ["JIRA_EMAIL", "JIRA_CLOUD_ID", "JIRA_TOKEN", "JIRA_SITE_URL"]) expect(f.imported()).not.toHaveProperty(key);
    });

    it.each([["yes", true], ["", false]] as const)("clears a kept JIRA_EMAIL for OAuth only on confirmation (%j)", async (confirmation, cleared) => {
      const f = await fakeDeps({
        clientFile: EXISTING_CLIENT_FILE,
        apps: ["orchestrator"],
        secrets: ["JIRA_EMAIL", "JIRA_TOKEN", "JIRA_SITE_URL"],
        answers: { "Keep every value": "no", "Ticketing system": "jira", "Jira mode": "oauth", "Clear JIRA_EMAIL": confirmation },
      });
      expect(await runProvisionClient(["client"], f.deps)).toBe(0);
      if (cleared) expect(f.imported()).toMatchObject({ JIRA_EMAIL: "", JIRA_CLOUD_ID: "jira-cloud-id" });
      else expect(f.imported()).not.toHaveProperty("JIRA_CLOUD_ID");
    });
  });

  describe("Fly", () => {
    it.each<[string, FakeOptions["respond"]]>([
      ["flyctl is missing", (tool) => (tool === "flyctl" ? { code: 1, stdout: "", stderr: "" } : undefined)],
      ["flyctl is signed out", (tool) => (tool === "flyctl" ? { code: 1, stdout: "tool-output-sentinel", stderr: "tool-output-sentinel" } : undefined)],
      ["the listing is not JSON", (tool, args) => (tool === "flyctl" && args[1] === "list" ? { code: 0, stdout: "NAME OWNER", stderr: "" } : undefined)],
      // Read as no apps, this would create the orchestrator's app again.
      ["the listing lacks the field it is read by", (tool, args) => (tool === "flyctl" && args[1] === "list" ? { code: 0, stdout: '[{"name":"ai-implement-client"}]', stderr: "" } : undefined)],
    ])("stops before any question or change when %s, and says to rerun", async (_, respond) => {
      const f = await fakeDeps({ respond });
      expect(await runProvisionClient(["client"], f.deps)).toBe(1);
      for (const command of ["flyctl auth login", "npm run provision-client -- client"]) expect(f.stdout()).toContain(command);
      expect(f.prompts).toEqual([]);
      expect(f.changedNothing()).toBe(true);
      expect(f.stdout() + f.stderr()).not.toContain("tool-output-sentinel");
    });

    it("asks for a pasted deploy token, hidden, when minting one fails", async () => {
      const f = await fakeDeps({
        answers: { FLY_DEPLOY_TOKEN: "pasted-deploy-sentinel", FLY_SESSIONS_TOKEN: "pasted-sessions-sentinel" },
        respond: (_, args) => (args[0] === "tokens" ? { code: 1, stdout: "", stderr: "tool-output-sentinel" } : undefined),
      });
      expect(await runProvisionClient(["client"], f.deps)).toBe(0);
      expect(f.imported()).toMatchObject({ FLY_DEPLOY_TOKEN: "pasted-deploy-sentinel", FLY_SESSIONS_TOKEN: "pasted-sessions-sentinel" });
      expect(f.prompts.filter((p) => p.label.startsWith("FLY_")).every((p) => p.hidden)).toBe(true);
      expect(f.stdout() + f.stderr()).not.toMatch(/pasted-deploy-sentinel|tool-output-sentinel/);
    });
  });

  describe("deploy, wait and check", () => {
    const accepted = { "Deploy now": "yes", "Wait up to": "yes", "Run the setup checks": "yes" };

    it("builds this checkout on Fly with its own source stamps and the client's region, then waits and runs the checks", async () => {
      const f = await fakeDeps({ answers: accepted });
      expect(await runProvisionClient(["client"], f.deps)).toBe(0);
      expect(f.flyCalls("deploy")[0]?.args).toEqual([
        "deploy", "--remote-only", "--no-cache", "--build-secret", "kg_token=", "--build-arg", "KG_SOURCE_REPO=",
        "--build-arg", "SOURCE_COMMIT=0123456789abcdef0123", "--build-arg", "SOURCE_REPO=fork-owner/fork-repo",
        "--build-arg", "SOURCE_BRANCH=feature", "--primary-region", "iad", "--ha=false", "--app", "ai-implement-client",
      ]);
      expect(f.flyCalls("ssh")[0]?.args).toEqual(["ssh", "console", "--app", "ai-implement-client", "-C", "node /app/dist/check-setup.js"]);
      expect(f.stdout()).toContain("No core check fails.");
      expect(onItsOwnLine(f.stdout(), "curl --fail https://ai-implement-client.fly.dev/")).toBe(false);
      expect(onItsOwnLine(f.stdout(), "npm run provision-client -- client")).toBe(false);
    });

    it.each(["https://github.com/fork-owner/fork-repo.git", "ssh://git@github.com/fork-owner/fork-repo"])("reads the repository from an origin of %s", async (origin) => {
      const f = await fakeDeps({ answers: accepted, origin });
      await runProvisionClient(["client"], f.deps);
      expect(f.flyCalls("deploy")[0]?.args).toContain("SOURCE_REPO=fork-owner/fork-repo");
    });

    it.each(["", "https://example.com/owner/repo.git", "https://github.com/owner/repo.git?ref=x"])(
      "does not deploy when the origin %j names no GitHub repository",
      async (origin) => {
        const f = await fakeDeps({ answers: accepted, origin });
        await runProvisionClient(["client"], f.deps);
        expect(f.flyCalls("deploy")).toEqual([]);
        expect(onItsOwnLine(f.stdout(), "npm run provision-client -- client")).toBe(true);
      },
    );

    it("mints a read-only token for the knowledge graph with the App and passes it as the build secret, never showing it", async () => {
      const f = await fakeDeps({ answers: { ...accepted, KG_SOURCE_REPO: "graph-owner/graph" } });
      expect(await runProvisionClient(["client"], f.deps)).toBe(0);
      expect(f.mints).toEqual([["987654321", PEM.replaceAll("\n", "\\n"), "graph-owner", "graph"]]);
      expect(f.flyCalls("deploy")[0]?.args).toEqual(expect.arrayContaining(["kg_token=kg-build-token-sentinel", "KG_SOURCE_REPO=graph-owner/graph"]));
      expect(f.stdout() + f.stderr()).not.toContain("kg-build-token-sentinel");
    });

    it("asks the knowledge-graph repository again when self-deploy would refuse it", async () => {
      const f = await fakeDeps({ answers: { ...accepted, KG_SOURCE_REPO: ["-owner/graph", "graph-owner/graph"] } });
      expect(await runProvisionClient(["client"], f.deps)).toBe(0);
      expect(f.prompts.filter((p) => p.label.startsWith("KG_SOURCE_REPO"))).toHaveLength(2);
      expect(f.stdout()).toContain("KG_SOURCE_REPO");
      expect(f.mints[0]?.slice(2)).toEqual(["graph-owner", "graph"]);
    });

    it("asks for the App's ID and key to mint the token when a re-run kept them", async () => {
      const f = await fakeDeps({
        clientFile: EXISTING_CLIENT_FILE,
        apps: ["orchestrator"],
        secrets: ["GITHUB_APP_ID", "GITHUB_APP_PRIVATE_KEY"],
        answers: { ...accepted, KG_SOURCE_REPO: "graph-owner/graph", "GITHUB_APP_PRIVATE_KEY .pem path [already set": "", "GITHUB_APP_ID, to mint": "987654321" },
      });
      const prompt = f.deps.prompt;
      f.deps.prompt = (label, hidden) => (label.startsWith("GITHUB_APP_PRIVATE_KEY .pem path, to mint") ? Promise.resolve(f.pemPath) : prompt(label, hidden));
      expect(await runProvisionClient(["client"], f.deps)).toBe(0);
      expect(f.mints[0]?.slice(0, 2)).toEqual(["987654321", PEM.replaceAll("\n", "\\n")]);
    });

    it("mints the token on a re-run with the App ID and .pem path the client file remembers, asking neither", async () => {
      const g = await fakeDeps();
      const remembered = `${EXISTING_CLIENT_FILE}\n[answers]\napp_id = "987654321"\nprivate_key_path = "${g.pemPath}"\n`;
      const f = await fakeDeps({ clientFile: remembered, apps: ["orchestrator"], secrets: EVERY_SECRET_RETAINED, released: true, answers: { ...accepted, KG_SOURCE_REPO: "graph-owner/graph" } });
      expect(await runProvisionClient(["client"], f.deps)).toBe(0);
      expect(f.prompts.some((p) => p.label.startsWith("GITHUB_APP"))).toBe(false);
      expect(f.mints[0]?.slice(0, 2)).toEqual(["987654321", PEM.replaceAll("\n", "\\n")]);
    });

    it.each([["yes", true], ["", false]] as const)("when the App cannot read the graph, deploys without it only on confirmation (%j)", async (confirmation, deployed) => {
      const f = await fakeDeps({ answers: { ...accepted, KG_SOURCE_REPO: "graph-owner/graph", "Deploy without a knowledge graph": confirmation } });
      f.deps.kgToken = async () => {
        throw new Error("Failed to get scoped installation token for owner graph-owner (404): tool-output-sentinel");
      };
      await runProvisionClient(["client"], f.deps);
      // It names where the App has to be installed, and which repository it has to reach.
      expect(f.stdout()).toMatch(/\bgraph-owner\b.*\bgraph\b/);
      expect(f.stdout()).not.toContain("tool-output-sentinel");
      if (deployed) expect(f.flyCalls("deploy")[0]?.args).toEqual(expect.arrayContaining(["kg_token=", "KG_SOURCE_REPO="]));
      else expect(f.flyCalls("deploy")).toEqual([]);
    });

    it("prints the exact deploy, wait and check commands when each is declined", async () => {
      const f = await fakeDeps();
      expect(await runProvisionClient(["client"], f.deps)).toBe(0);
      expect(f.calls.some((c) => c.args[0] === "deploy" || c.args[0] === "ssh")).toBe(false);
      for (const command of [
        "flyctl deploy --remote-only --no-cache --build-secret kg_token= --build-arg KG_SOURCE_REPO= --build-arg SOURCE_COMMIT=0123456789abcdef0123 " +
          "--build-arg SOURCE_REPO=fork-owner/fork-repo --build-arg SOURCE_BRANCH=feature --primary-region iad --ha=false --app ai-implement-client",
        "curl --fail https://ai-implement-client.fly.dev/",
        'flyctl ssh console --app ai-implement-client -C "node /app/dist/check-setup.js"',
      ]) {
        expect(onItsOwnLine(f.stdout(), command), command).toBe(true);
      }
    });

    it("defers a declined knowledge-graph deploy to a re-run, since its token has no hand-run form", async () => {
      const f = await fakeDeps({ answers: { KG_SOURCE_REPO: "graph-owner/graph" } });
      await runProvisionClient(["client"], f.deps);
      expect(onItsOwnLine(f.stdout(), "npm run provision-client -- client")).toBe(true);
      expect(f.mints).toEqual([]);
    });

    it("shows the deploy's output as it runs, with the build token and every secret set here redacted, even split across pieces", async () => {
      const f = await fakeDeps({
        answers: { ...accepted, KG_SOURCE_REPO: "graph-owner/graph" },
        respond: (_, args) =>
          args[0] === "deploy" ? { code: 0, stdout: "==> Building image\nusing kg-build-token-sentinel and google-secret-sentinel\n--> done", stderr: "" } : undefined,
      });
      expect(await runProvisionClient(["client"], f.deps)).toBe(0);
      expect(f.stdout()).toContain("==> Building image\nusing *** and ***\n--> done\n");
      expect(f.stdout()).not.toMatch(/kg-build-token-sentinel|google-secret-sentinel/);
    });

    it("reports a failed deploy with its output redacted, and defers it", async () => {
      const f = await fakeDeps({
        answers: { ...accepted, KG_SOURCE_REPO: "graph-owner/graph" },
        respond: (_, args) => (args[0] === "deploy" ? { code: 1, stdout: "kg-build-token-sentinel", stderr: "kg-build-token-sentinel" } : undefined),
      });
      await runProvisionClient(["client"], f.deps);
      expect(f.stdout() + f.stderr()).not.toContain("kg-build-token-sentinel");
      // A knowledge-graph deploy has no hand-run form, so the failure defers to a rerun of the command.
      expect(onItsOwnLine(f.stdout(), "npm run provision-client -- client")).toBe(true);
    });

    it("names what it is about to do before each step that takes a while", async () => {
      const f = await fakeDeps({ answers: { ...accepted } });
      await runProvisionClient(["client"], f.deps);
      expect(announced(f.writes[0])).toContain("clients/client.toml");
      for (const [app, call] of f.flyCalls("apps", "create").map((c) => [c.args[2]!, c] as const)) expect(announced(call)).toContain(app);
      for (const call of f.flyCalls("tokens")) expect(announced(call)).toContain(call.args[call.args.indexOf("--app") + 1]!);
      expect(announced(f.flyCalls("secrets", "import")[0])).toContain("ai-implement-client");
      expect(announced(f.flyCalls("volumes", "create")[0])).toContain("dedup_data");
      expect(announced(f.flyCalls("ssh")[0])).toMatch(/setup checks/);
    });

    it("says each minute how long it has waited for the orchestrator, out of 15", async () => {
      const f = await fakeDeps({ answers: { "Wait up to": "yes" } });
      f.deps.probeHealth = async () => ({ kind: f.time() >= 3 * 60_000 ? "serving" : "not-answering" });
      expect(await runProvisionClient(["client"], f.deps)).toBe(0);
      // Each progress line gives the minutes waited and the limit, whatever its wording.
      const minutesWaited = f.stdout().split("\n").filter((line) => /\b15\b/.test(line)).map((line) => line.match(/\d+/)![0]);
      expect(minutesWaited).toEqual(["1", "2"]);
    });

    it("waits 15 minutes at most and then fails", async () => {
      const f = await fakeDeps({ answers: { "Wait up to": "yes" } });
      f.deps.probeHealth = async () => ({ kind: "not-answering" });
      expect(await runProvisionClient(["client"], f.deps)).toBe(1);
      expect(f.time()).toBe(15 * 60_000);
      expect(f.stdout()).toContain("The orchestrator did not answer within 15 minutes.");
      expect(f.stdout()).toContain("curl --fail https://ai-implement-client.fly.dev/");
    });

    it("succeeds immediately on the first serving probe", async () => {
      const f = await fakeDeps({ answers: { "Wait up to": "yes" } });
      let attempts = 0;
      f.deps.probeHealth = async () => { attempts++; return { kind: "serving" }; };
      expect(await runProvisionClient(["client"], f.deps)).toBe(0);
      expect(attempts).toBe(1);
      expect(f.time()).toBe(0);
      expect(f.stdout()).toContain("The orchestrator is answering.");
    });

    it("keeps waiting for Restate and reports its states before serving", async () => {
      const f = await fakeDeps({ answers: { "Wait up to": "yes" } });
      f.deps.probeHealth = async () => f.time() >= 2 * 60_000
        ? { kind: "serving" }
        : { kind: "starting", sidecar: "starting", registration: "pending" };
      expect(await runProvisionClient(["client"], f.deps)).toBe(0);
      expect(f.time()).toBe(2 * 60_000);
      expect(f.stdout()).toContain("Still waiting, 1 of 15 minutes. Restate is not serving (sidecar starting, registration pending).");
      expect(f.stdout()).toContain("The orchestrator is answering.");
    });

    it.each([false, true])("uses the latest probe at the deadline (stopped answering: %s)", async (stopped) => {
      const f = await fakeDeps({ answers: { "Wait up to": "yes" } });
      f.deps.probeHealth = async () => stopped && f.time() >= 14 * 60_000
        ? { kind: "not-answering" }
        : { kind: "starting", sidecar: "ready", registration: "pending" };
      expect(await runProvisionClient(["client"], f.deps)).toBe(1);
      expect(f.time()).toBe(HEALTH_WAIT_MS);
      expect(f.stdout()).toContain(stopped
        ? "The orchestrator did not answer within 15 minutes."
        : "The orchestrator answers, but Restate is not serving (sidecar ready, registration pending).");
      expect(f.stdout()).toContain("curl --fail https://ai-implement-client.fly.dev/");
    });

    it("keeps waiting through a request that throws", async () => {
      const f = await fakeDeps({ answers: { "Wait up to": "yes" } });
      let attempts = 0;
      f.deps.probeHealth = async () => {
        if (++attempts < 3) throw new Error("connection refused");
        return { kind: "serving" };
      };
      expect(await runProvisionClient(["client"], f.deps)).toBe(0);
      expect(attempts).toBe(3);
    });

    it("returns the remote checks' exit code, with every secret set here redacted and other values left", async () => {
      const f = await fakeDeps({
        answers: { "Run the setup checks": "yes" },
        respond: (_, args) =>
          args[0] === "ssh" ? { code: 1, stdout: "google-secret-sentinel at https://ai-implement-client.fly.dev", stderr: "token-for-ai-implement-client-sentinel" } : undefined,
      });
      expect(await runProvisionClient(["client"], f.deps)).toBe(1);
      expect(f.stdout()).toContain("*** at https://ai-implement-client.fly.dev");
      expect(f.stderr()).toContain("***");
      expect(f.stdout() + f.stderr()).not.toMatch(/google-secret-sentinel|token-for-ai-implement-client-sentinel/);
    });

    it("shows flyctl's own notices before the checks' results", async () => {
      const f = await fakeDeps({
        answers: { "Run the setup checks": "yes" },
        respond: (_, args) => (args[0] === "ssh" ? { code: 0, stdout: "remote-results-sentinel\n", stderr: "flyctl-notice-sentinel\n" } : undefined),
      });
      await runProvisionClient(["client"], f.deps);
      const notice = f.terminal().indexOf("flyctl-notice-sentinel");
      expect(notice).toBeGreaterThanOrEqual(0);
      expect(notice).toBeLessThan(f.terminal().indexOf("remote-results-sentinel"));
    });

    it("defers the checks when no machine is running", async () => {
      const f = await fakeDeps({
        answers: { "Run the setup checks": "yes" },
        respond: (_, args) => (args[0] === "machines" ? { code: 0, stdout: '[{"state":"stopped"}]', stderr: "" } : undefined),
      });
      expect(await runProvisionClient(["client"], f.deps)).toBe(1);
      expect(f.flyCalls("ssh")).toEqual([]);
      expect(f.stdout().split("Still to run:\n")[1]).toContain('flyctl ssh console --app ai-implement-client -C "node /app/dist/check-setup.js"');
    });
  });
});
