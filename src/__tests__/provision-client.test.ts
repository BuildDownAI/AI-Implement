import { describe, expect, it } from "vitest";
import { generateKeyPairSync } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { testDir } from "./helpers/test-dir.js";
import { runProvisionClient, provisionPreflight, type ProvisionDependencies, type ProvisionResult } from "../provision-client.js";

const pem = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const existingConfig = '[fly]\napp_name="orchestrator"\norg="my-org"\nregion="lhr"\n';
type Call = { tool: string; args: string[]; stdin?: string };
async function fixture(options: { existing?: boolean; retained?: string[]; answers?: Record<string, string>; apps?: boolean } = {}) {
  const root = testDir("provision");
  const pemPath = join(root, "app.pem");
  await writeFile(pemPath, pem);
  const calls: Call[] = [], prompts: { label: string; hidden: boolean }[] = [], writes: string[] = [];
  let output = "", errors = "", time = 0, random = 0;
  const answers: Record<string, string> = {
    OAUTH_ALLOWED_EMAILS: "admin@example.com", GOOGLE_OAUTH_CLIENT_ID: "google-id-sentinel", GOOGLE_OAUTH_CLIENT_SECRET: "google-secret-sentinel",
    MICROSOFT_OAUTH_CLIENT_ID: "microsoft-id-sentinel", MICROSOFT_OAUTH_CLIENT_SECRET: "microsoft-secret-sentinel", MICROSOFT_OAUTH_TENANT: "tenant-id-sentinel",
    LINEAR_CLIENT_ID: "linear-id-sentinel", LINEAR_CLIENT_SECRET: "linear-secret-sentinel", LINEAR_WORKSPACE_URL: "https://linear.app/client",
    JIRA_EMAIL: "jira@example.com", JIRA_CLOUD_ID: "cloud-id-sentinel", JIRA_TOKEN: "jira-token-sentinel", JIRA_SITE_URL: "https://client.atlassian.net",
    GITHUB_APP_ID: "987654321", GITHUB_APP_PRIVATE_KEY: pemPath, CLAUDE_CODE_OAUTH_TOKEN: "subscription-sentinel",
    ...options.answers,
  };
  const retained = options.retained ?? [];
  const deps: ProvisionDependencies = {
    prompt: async (label, hidden) => {
      prompts.push({ label, hidden });
      if (label.includes("already set")) return options.answers?.[label.split(" ")[0]!.replace(/:$/, "")] ?? "";
      const key = label.split(" ")[0]!.replace(/:$/, "");
      return answers[key] ?? "";
    },
    readFile: async path => path.startsWith("clients/") ? options.existing ? existingConfig : null : readFile(path, "utf8"),
    writeFile: async (path, text) => { writes.push(path); await writeFile(join(root, "client.toml"), text); },
    command: async (tool, args, stdin): Promise<ProvisionResult> => {
      calls.push({ tool, args, stdin });
      let stdout = "";
      if (args[0] === "apps" && args[1] === "list") stdout = JSON.stringify(options.apps ? [{ Name: "orchestrator" }, { Name: "ai-implement-sessions-client" }, { Name: "active-sessions" }] : []);
      if (args[0] === "volumes" && args[1] === "list") stdout = JSON.stringify(options.apps ? [{ name: "dedup_data", region: "lhr" }] : []);
      if (args[0] === "secrets" && args[1] === "list") stdout = JSON.stringify(retained.map(name => ({ name })));
      if (args[0] === "tokens") stdout = args.includes("8760h") ? "deploy-token-sentinel\n" : "sessions-token-sentinel\n";
      if (tool === "gh") stdout = args[0] === "auth" ? "github-build-token-sentinel\n" : "fork-owner/fork-repo\n";
      if (tool === "git") stdout = args.includes("--abbrev-ref") ? "feature\n" : "0123456789abcdef\n";
      if (args[0] === "machines") stdout = '[{"state":"started"}]';
      if (args[0] === "ssh") stdout = "All setup checks pass\n";
      return { code: 0, stdout, stderr: "" };
    },
    random: () => `generated-secret-${++random}`, http: async () => true,
    now: () => time, sleep: async ms => { time += ms; },
    writeStdout: text => { output += text; }, writeStderr: text => { errors += text; },
  };
  const imported = () => Object.fromEntries((calls.find(c => c.args[0] === "secrets" && c.args[1] === "import")?.stdin ?? "").trim().split("\n").filter(Boolean).map(line => { const at = line.indexOf("="); return [line.slice(0, at), line.slice(at + 1)]; }));
  return { deps, calls, prompts, writes, imported, answers, output: () => output, errors: () => errors, time: () => time };
}

describe("provision-client", () => {
  it.each(["", "UPPER", "-client", "client-", "a/b"])("rejects invalid slug %j without effects", async slug => {
    const f = await fixture();
    expect(await runProvisionClient([slug], f.deps)).toBe(1);
    expect(f.calls).toEqual([]);
    expect(f.writes).toEqual([]);
  });

  it("accepts a single-character slug and generates a complete Google/Linear environment", async () => {
    const f = await fixture({ answers: { Generate: "yes" } });
    expect(await runProvisionClient(["a"], f.deps)).toBe(0);
    expect(f.writes).toEqual(["clients/a.toml"]);
    const env = f.imported();
    expect((await provisionPreflight(env)).filter(c => c.state === "fail" || c.state === "warn")).toEqual([]);
    expect(env.GITHUB_APP_PRIVATE_KEY).toBe(pem.replaceAll("\n", "\\n"));
    expect(env.FLY_SESSIONS_APP).toBe("ai-implement-sessions-a");
    expect(env.FLY_SESSIONS_REGION).toBe("iad");
    expect(env).not.toHaveProperty("ANTHROPIC_API_KEY");
    expect(f.prompts.some(p => p.label.startsWith("JIRA_"))).toBe(false);
    expect(f.prompts.filter(p => /^[A-Z_]+ /.test(p.label) && !p.label.startsWith("GITHUB_APP_PRIVATE_KEY") && !p.label.startsWith("KG_SOURCE_REPO") && !p.label.startsWith("RUNNER_CALLBACK") && !p.label.startsWith("OAUTH_REDIRECT")).every(p => p.hidden)).toBe(true);
    expect(f.output()).toContain("/api/auth/google/callback");
    expect(f.output()).toContain("/mcp/callback/google");
    expect(f.output()).toContain("unreadable until it is re-keyed");
    expect(f.output()).toContain("Models & providers");
    expect(f.output()).toContain("Agents tab");
    expect(f.output()).toContain('"Cannot dispatch"');
    expect(f.output()).toContain("custom runner image");
  });

  it("keeps an existing file, apps, matching volume and every blank secret, without reseeding sessions", async () => {
    const keys = ["OAUTH_ALLOWED_EMAILS", "RUNNER_CALLBACK_BASE_URL", "OAUTH_REDIRECT_BASE_URL", "GOOGLE_OAUTH_CLIENT_ID", "GOOGLE_OAUTH_CLIENT_SECRET", "LINEAR_CLIENT_ID", "LINEAR_CLIENT_SECRET", "LINEAR_WORKSPACE_URL", "GITHUB_APP_ID", "GITHUB_APP_PRIVATE_KEY", "RUNNER_TOKEN_SECRET", "GITHUB_WEBHOOK_SECRET", "ADMIN_ACCESS_CODE", "FLY_DEPLOY_TOKEN", "FLY_SESSIONS_TOKEN", "FLY_SESSIONS_APP", "FLY_SESSIONS_REGION"];
    const f = await fixture({ existing: true, apps: true, retained: keys, answers: { GITHUB_APP_PRIVATE_KEY: "" } });
    expect(await runProvisionClient(["client"], f.deps)).toBe(0);
    expect(f.writes).toEqual([]);
    expect(f.calls.filter(c => c.args[1] === "create")).toEqual([]);
    expect(f.calls.filter(c => c.args[1] === "import")).toEqual([]);
    expect(f.output()).toContain("/admin#settings");
    expect(f.output()).toContain("cannot be verified locally");
  });

  it("mints a rerun token for the explicitly selected active sessions app, without creating the local seed app", async () => {
    const f = await fixture({ existing: true, apps: true, retained: ["FLY_SESSIONS_APP"], answers: { Active: "active-sessions" } });
    const command = f.deps.command;
    f.deps.command = async (tool, args, stdin) => {
      const result = await command(tool, args, stdin);
      return args[0] === "apps" && args[1] === "list"
        ? { ...result, stdout: JSON.stringify([{ Name: "orchestrator" }, { Name: "active-sessions" }]) }
        : result;
    };
    expect(await runProvisionClient(["client"], f.deps)).toBe(0);
    expect(f.calls.filter(c => c.args[0] === "apps" && c.args[1] === "create")).toEqual([]);
    expect(f.calls.find(c => c.args[0] === "tokens" && !c.args.includes("8760h"))?.args).toEqual(["tokens", "create", "deploy", "--app", "active-sessions"]);
    expect(f.imported()).not.toHaveProperty("FLY_SESSIONS_APP");
    expect(f.imported()).not.toHaveProperty("FLY_SESSIONS_REGION");
    expect(f.output()).toContain("local client file no longer controls");
  });

  it("requires an explicit active sessions app before minting a rerun token", async () => {
    const f = await fixture({ existing: true, apps: true, retained: ["FLY_SESSIONS_APP"] });
    expect(await runProvisionClient(["client"], f.deps)).toBe(1);
    expect(f.calls.every(c => c.args.includes("list"))).toBe(true);
    expect(f.writes).toEqual([]);
  });

  it.each(["missing executable", "unauthenticated"])("prints deferred commands without mutations when initial Fly discovery is %s", async failure => {
    const f = await fixture();
    const command = f.deps.command;
    let requests = 0;
    f.deps.http = async () => { requests++; return true; };
    f.deps.command = async (tool, args, stdin) => {
      if (tool === "flyctl") {
        f.calls.push({ tool, args, stdin });
        if (failure === "missing executable") throw new Error("ENOENT private-sentinel");
        return { code: 1, stdout: "private-sentinel", stderr: "private-sentinel" };
      }
      return command(tool, args, stdin);
    };
    expect(await runProvisionClient(["client"], f.deps)).toBe(1);
    expect(f.output()).toContain("flyctl deploy --remote-only --no-cache");
    expect(f.output()).toContain("SOURCE_REPO=fork-owner/fork-repo");
    expect(f.output()).toContain("curl --fail https://ai-implement-client.fly.dev/");
    expect(f.output()).toContain('flyctl ssh console --app ai-implement-client -C "node /app/dist/check-setup.js"');
    expect(f.output()).toContain("npm run provision-client -- client");
    expect(f.calls.filter(c => c.tool === "flyctl").map(c => c.args)).toEqual([["apps", "list", "--json"]]);
    expect(f.writes).toEqual([]);
    expect(requests).toBe(0);
    expect(f.output() + f.errors()).not.toContain("private-sentinel");
  });

  it.each(["basic", "oauth"])("provisions Microsoft/Jira %s without Linear answers", async mode => {
    const f = await fixture({ answers: { "Sign-in": "microsoft", Tracker: "jira", Jira: mode } });
    expect(await runProvisionClient(["client"], f.deps)).toBe(0);
    expect(f.prompts.some(p => p.label.startsWith("LINEAR_"))).toBe(false);
    expect(f.imported()).toHaveProperty(mode === "basic" ? "JIRA_EMAIL" : "JIRA_CLOUD_ID");
    expect((await provisionPreflight(f.imported())).filter(c => c.state === "fail" || c.state === "warn")).toEqual([]);
    expect(f.output()).toContain("/api/auth/microsoft/callback");
  });

  it("imports every secret together on stdin and never emits secret values except the access code once", async () => {
    const f = await fixture({ answers: { Generate: "yes", Will: "yes", Target: "owner/repo" } });
    let repoAsked = false;
    const prompt = f.deps.prompt;
    f.deps.prompt = async (label, hidden) => {
      if (label.startsWith("Target")) { if (repoAsked) return ""; repoAsked = true; }
      return prompt(label, hidden);
    };
    expect(await runProvisionClient(["client"], f.deps)).toBe(0);
    const imports = f.calls.filter(c => c.args[1] === "import");
    expect(imports).toHaveLength(1);
    const visible = f.output() + f.errors() + JSON.stringify(f.calls.map(({tool,args}) => ({tool,args})));
    for (const key of ["GOOGLE_OAUTH_CLIENT_ID", "GOOGLE_OAUTH_CLIENT_SECRET", "LINEAR_CLIENT_ID", "LINEAR_CLIENT_SECRET", "GITHUB_APP_ID", "GITHUB_APP_PRIVATE_KEY", "CLAUDE_CODE_OAUTH_TOKEN", "RUNNER_TOKEN_SECRET", "GITHUB_WEBHOOK_SECRET", "FLY_DEPLOY_TOKEN", "FLY_SESSIONS_TOKEN"]) expect(visible).not.toContain(f.imported()[key]);
    expect(f.output().split(f.imported().ADMIN_ACCESS_CODE!).length - 1).toBe(1);
    expect(f.output()).toContain("gh secret set CLAUDE_CODE_OAUTH_TOKEN --repo owner/repo");
    expect(f.output()).toContain("gh secret set AI_IMPLEMENT_PRIVATE_KEY --repo owner/repo <");
    expect(f.output()).toContain("printenv GITHUB_WEBHOOK_SECRET");
    expect(f.calls.find(c => c.args[0] === "tokens" && c.args.includes("8760h"))).toBeDefined();
    expect(f.output()).not.toMatch(/—|;|push to main|set-github-secrets|sync-workflow.yml|Allow GitHub Actions/);
  });

  it.each([
    { GITHUB_APP_ID: "not-numeric" }, { GITHUB_APP_ID: "" }, { Target: "badrepo" }, { GOOGLE_OAUTH_CLIENT_SECRET: "evil\nINJECTED=value" },
  ] as Record<string, string>[])("rejects invalid answers before any writes: %j", async answers => {
    const f = await fixture({ answers });
    expect(await runProvisionClient(["client"], f.deps)).toBe(1);
    expect(f.writes).toEqual([]);
    expect(f.calls.every(c => c.args.includes("list"))).toBe(true);
  });

  it("shows the shared check and fix for a malformed PEM before mutations", async () => {
    const f = await fixture();
    const read = f.deps.readFile;
    f.deps.readFile = path => path.endsWith(".pem") ? Promise.resolve("bad-key-sentinel") : read(path);
    expect(await runProvisionClient(["client"], f.deps)).toBe(1);
    expect(f.output()).toContain("env.github-app: fail. Set GITHUB_APP_ID and GITHUB_APP_PRIVATE_KEY");
    expect(f.output()).not.toContain("bad-key-sentinel");
    expect(f.writes).toEqual([]);
  });

  it("shows the shared provider check fix for a Microsoft multi-tenant alias", async () => {
    const f = await fixture({ answers: { "Sign-in": "microsoft", MICROSOFT_OAUTH_TENANT: "common" } });
    expect(await runProvisionClient(["client"], f.deps)).toBe(1);
    expect(f.output()).toContain("Correct each variable named");
    expect(f.writes).toEqual([]);
  });

  it("does not treat failed listings as absent resources or echo tool errors", async () => {
    const f = await fixture();
    f.deps.command = async () => ({ code: 1, stdout: "private-sentinel", stderr: "private-sentinel" });
    expect(await runProvisionClient(["client"], f.deps)).toBe(1);
    expect(f.writes).toEqual([]);
    expect(f.output() + f.errors()).not.toContain("private-sentinel");
  });

  it("rejects malformed TOML without echoing its contents", async () => {
    const f = await fixture();
    f.deps.readFile = async () => '[invalid secret-sentinel';
    expect(await runProvisionClient(["client"], f.deps)).toBe(1);
    expect(f.calls).toEqual([]);
    expect(f.errors()).not.toContain("secret-sentinel");
  });

  it("offers a hidden pasted token fallback if minting fails", async () => {
    const f = await fixture({ answers: { FLY_DEPLOY_TOKEN: "pasted-deploy-sentinel", FLY_SESSIONS_TOKEN: "pasted-session-sentinel" } });
    const command = f.deps.command;
    f.deps.command = (tool, args, stdin) => args[0] === "tokens" ? Promise.resolve({ code: 1, stdout: "", stderr: "secret-sentinel" }) : command(tool, args, stdin);
    expect(await runProvisionClient(["client"], f.deps)).toBe(0);
    expect(f.imported().FLY_DEPLOY_TOKEN).toBe("pasted-deploy-sentinel");
    expect(f.prompts.filter(p => p.label.startsWith("FLY_")).every(p => p.hidden)).toBe(true);
    expect(f.output() + f.errors()).not.toContain("pasted-deploy-sentinel");
  });

  it("deploys without a KG using fork source stamps, then waits and runs remote checks", async () => {
    const f = await fixture({ answers: { Deploy: "yes", Wait: "yes", Run: "yes" } });
    expect(await runProvisionClient(["client"], f.deps)).toBe(0);
    const deploy = f.calls.find(c => c.args[0] === "deploy")!;
    expect(deploy.args).toEqual(expect.arrayContaining(["--remote-only", "--no-cache", "--build-secret", "kg_token=", "KG_SOURCE_REPO=", "SOURCE_REPO=fork-owner/fork-repo", "SOURCE_COMMIT=0123456789abcdef", "SOURCE_BRANCH=feature", "--app", "ai-implement-client", "--primary-region", "iad"]));
    expect(f.calls.some(c => c.args.includes("node /app/dist/check-setup.js"))).toBe(true);
    expect(f.output()).toContain("All setup checks pass");
    expect(f.prompts.filter(p => /^(Deploy|Wait|Run)/.test(p.label))).toHaveLength(3);
  });

  it("prints exact deferred commands for declined operations", async () => {
    const f = await fixture();
    expect(await runProvisionClient(["client"], f.deps)).toBe(0);
    expect(f.calls.some(c => c.args[0] === "deploy" || c.args[0] === "ssh")).toBe(false);
    expect(f.output()).toContain("flyctl deploy --remote-only --no-cache");
    expect(f.output()).toContain("curl --fail https://ai-implement-client.fly.dev/");
    expect(f.output()).toContain('flyctl ssh console --app ai-implement-client -C "node /app/dist/check-setup.js"');
  });

  it("executes an accepted KG build with the credential only on Docker stdin", async () => {
    const f = await fixture({ answers: { Deploy: "yes", KG_SOURCE_REPO: "owner/graph" } });
    expect(await runProvisionClient(["client"], f.deps)).toBe(0);
    const build = f.calls.find(c => c.tool === "docker" && c.args[0] === "buildx")!;
    expect(build.args).toEqual(expect.arrayContaining(["id=kg_token,src=/dev/stdin", "KG_SOURCE_REPO=owner/graph", "SOURCE_REPO=fork-owner/fork-repo"]));
    expect(build.stdin).toBe("github-build-token-sentinel");
    expect(f.calls.some(c => c.tool === "docker" && c.args[0] === "push")).toBe(true);
    expect(f.calls.find(c => c.args[0] === "deploy")?.args).toContain("--image");
    expect(f.output() + f.errors() + JSON.stringify(f.calls.map(c => c.args))).not.toContain("github-build-token-sentinel");
  });

  it("defers a failed KG build with safe commands and no partial image deployment", async () => {
    const f = await fixture({ answers: { Deploy: "yes", KG_SOURCE_REPO: "owner/graph" } });
    const command = f.deps.command;
    f.deps.command = (tool, args, stdin) => tool === "docker" && args[0] === "buildx"
      ? Promise.resolve({ code: 1, stdout: "github-build-token-sentinel", stderr: "github-build-token-sentinel" })
      : command(tool, args, stdin);
    expect(await runProvisionClient(["client"], f.deps)).toBe(0);
    expect(f.calls.some(c => c.args[0] === "deploy" || c.args[0] === "push")).toBe(false);
    expect(f.output()).toContain("--secret id=kg_token,env=GH_TOKEN");
    expect(f.output()).toContain('export GH_TOKEN="$(gh auth token)"');
    expect(f.output() + f.errors()).not.toContain("github-build-token-sentinel");
  });

  it("waits at most 15 minutes with fake time and returns failure on timeout", async () => {
    const f = await fixture({ answers: { Wait: "yes" } });
    f.deps.http = async () => false;
    expect(await runProvisionClient(["client"], f.deps)).toBe(1);
    expect(f.time()).toBe(15 * 60_000);
  });

  it("preserves remote check exit status and redacts known credentials", async () => {
    const f = await fixture({ answers: { Run: "yes" } });
    const command = f.deps.command;
    f.deps.command = (tool, args, stdin) => args[0] === "ssh" ? Promise.resolve({ code: 2, stdout: "google-secret-sentinel", stderr: "deploy-token-sentinel" }) : command(tool, args, stdin);
    expect(await runProvisionClient(["client"], f.deps)).toBe(2);
    expect(f.output() + f.errors()).not.toContain("google-secret-sentinel");
    expect(f.errors()).toContain("[redacted]");
  });
  it("rejects a placeholder access code with the shared check and fix before writing", async () => {
    const f = await fixture({ answers: { Generate: "yes" } });
    f.deps.random = () => "your-secret-access-code";
    expect(await runProvisionClient(["client"], f.deps)).toBe(1);
    expect(f.output()).toContain("env.admin-access-code: fail");
    expect(f.output()).toContain("Set a real access code");
    expect(f.writes).toEqual([]);
  });

  it("only accepts a dedup_data volume in the selected region", async () => {
    const f = await fixture({ existing: true, apps: true });
    const command = f.deps.command;
    f.deps.command = (tool, args, stdin) => args[0] === "volumes" && args[1] === "list" ? Promise.resolve({ code: 0, stdout: '[{"name":"dedup_data","region":"iad"}]', stderr: "" }) : command(tool, args, stdin);
    expect(await runProvisionClient(["client"], f.deps)).toBe(0);
    expect(f.calls.find(c => c.args[0] === "volumes" && c.args[1] === "create")?.args).toContain("lhr");
  });

  it("defers deploy and checks with exact commands when tools are unavailable", async () => {
    const f = await fixture({ answers: { Deploy: "yes", Run: "yes" } });
    const command = f.deps.command;
    f.deps.command = (tool, args, stdin) => args[0] === "auth" || args[0] === "machines" ? Promise.resolve({ code: 1, stdout: "", stderr: "tool-error-sentinel" }) : command(tool, args, stdin);
    expect(await runProvisionClient(["client"], f.deps)).toBe(1);
    expect(f.output()).toContain("flyctl deploy --remote-only --no-cache");
    expect(f.output()).toContain('flyctl ssh console --app ai-implement-client -C "node /app/dist/check-setup.js"');
    expect(f.output() + f.errors()).not.toContain("tool-error-sentinel");
  });

  it("derives the existing Microsoft and Jira choices on a re-run", async () => {
    const f = await fixture({ existing: true, apps: true, retained: ["MICROSOFT_OAUTH_CLIENT_ID", "MICROSOFT_OAUTH_CLIENT_SECRET", "MICROSOFT_OAUTH_TENANT", "JIRA_EMAIL", "JIRA_TOKEN", "JIRA_SITE_URL"] });
    expect(await runProvisionClient(["client"], f.deps)).toBe(0);
    expect(f.prompts.some(p => /^(LINEAR_|GOOGLE_)/.test(p.label))).toBe(false);
    expect(f.prompts.find(p => p.label.startsWith("Tracker"))?.label).toContain("[jira]");
  });

  it("rejects a changed Microsoft tenant even when its other credentials are retained", async () => {
    const f = await fixture({ existing: true, apps: true, retained: ["MICROSOFT_OAUTH_CLIENT_ID", "MICROSOFT_OAUTH_CLIENT_SECRET", "MICROSOFT_OAUTH_TENANT"], answers: { MICROSOFT_OAUTH_TENANT: "common" } });
    expect(await runProvisionClient(["client"], f.deps)).toBe(1);
    expect(f.output()).toContain("admin.providers: warn");
    expect(f.writes).toEqual([]);
    expect(f.calls.every(c => c.args.includes("list"))).toBe(true);
  });

  it.each([
    { retained: ["OAUTH_ALLOWED_EMAILS"], answers: { GOOGLE_OAUTH_CLIENT_SECRET: "   " } },
    { retained: ["GOOGLE_OAUTH_CLIENT_ID", "OAUTH_ALLOWED_EMAILS"], answers: { GOOGLE_OAUTH_CLIENT_SECRET: "   " } },
  ])("rejects determinable provider failures with mixed retained values", async options => {
    const f = await fixture({ existing: true, apps: true, ...options });
    expect(await runProvisionClient(["client"], f.deps)).toBe(1);
    expect(f.output()).toContain("admin.providers: warn");
    expect(f.output()).toContain("Correct each variable named");
    expect(f.calls.every(c => c.args.includes("list"))).toBe(true);
    expect(f.writes).toEqual([]);
  });

  it("defaults an OAuth Jira re-run to OAuth and keeps blank credentials", async () => {
    const f = await fixture({ existing: true, apps: true, retained: ["JIRA_CLOUD_ID", "JIRA_TOKEN", "JIRA_SITE_URL"] });
    expect(await runProvisionClient(["client"], f.deps)).toBe(0);
    expect(f.prompts.find(p => p.label.startsWith("Jira mode"))?.label).toContain("[oauth]");
    expect(f.prompts.some(p => p.label.startsWith("JIRA_EMAIL"))).toBe(false);
    for (const key of ["JIRA_EMAIL", "JIRA_CLOUD_ID", "JIRA_TOKEN", "JIRA_SITE_URL"]) expect(f.imported()).not.toHaveProperty(key);
  });

  it.each(["yes", ""])("confirms clearing Jira basic email before OAuth migration: %j", async confirmation => {
    const f = await fixture({ existing: true, apps: true, retained: ["JIRA_EMAIL", "JIRA_TOKEN", "JIRA_SITE_URL"], answers: { Jira: "oauth", Clear: confirmation } });
    expect(await runProvisionClient(["client"], f.deps)).toBe(0);
    expect(f.output()).toContain("basic authentication takes precedence");
    if (confirmation) {
      expect(f.imported().JIRA_EMAIL).toBe("");
      expect(f.imported()).toHaveProperty("JIRA_CLOUD_ID");
    } else {
      expect(f.imported()).not.toHaveProperty("JIRA_EMAIL");
      expect(f.imported()).not.toHaveProperty("JIRA_CLOUD_ID");
    }
  });

});
