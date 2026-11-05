/** Self-hosted onboarding. Effects are supplied by the CLI adapter, never by the workflow. */
import { parse, stringify } from "smol-toml";
import { ORCHESTRATOR_CONFIG_CHECKS } from "./setup-checks/orchestrator-config.js";
import { createSetupCheckContext } from "./setup-checks/index.js";
import { parseAppPrivateKey } from "./github-app-auth.js";
import { allowlistFromEnv, parseAccessEntries } from "./access-entries.js";

class ProvisionError extends Error {}

export interface ProvisionResult { code: number; stdout: string; stderr: string }
export interface ProvisionDependencies {
  prompt(label: string, hidden: boolean): Promise<string>;
  readFile(path: string): Promise<string | null>;
  writeFile(path: string, content: string): Promise<void>;
  command(tool: string, args: string[], stdin?: string): Promise<ProvisionResult>;
  random(): string;
  http(url: string): Promise<boolean>;
  now(): number;
  sleep(ms: number): Promise<void>;
  writeStdout(text: string): void;
  writeStderr(text: string): void;
}

export const PROVISION_ENV_CHECKS = ORCHESTRATOR_CONFIG_CHECKS.filter(c => c.id.startsWith("env.") || c.id.startsWith("admin.") || c.id === "callback.config");

/** Reject determinable failures using optimistic witnesses for retained values. Remote checks verify the unknown values. */
export async function provisionPreflight(env: Record<string, string>, retained: Set<string> = new Set()) {
  // Use optimistic witnesses for unknown values. A failure even with these witnesses
  // is determinable locally. Passing results involving retained values remain unverified.
  const known = { ...env };
  for (const key of Object.keys(known)) if (/^(GOOGLE|MICROSOFT)_OAUTH_/.test(key)) known[key] = known[key]!.trim();
  for (const key of retained) known[key] = key === "OAUTH_ALLOWED_EMAILS" ? "retained@example.com" : "retained";
  const context = createSetupCheckContext({ env: known, restateStatus: () => ({ sidecar: { state: "unknown" }, registration: { state: "unknown" } }), effectiveAllowlist: () => ({ entries: allowlistFromEnv(known), source: "env" }) });
  const rows = [];
  for (const check of PROVISION_ENV_CHECKS) {
    const ownVariable: Record<string, string> = { "env.runner-mode": "RUNNER_MODE", "env.poll-interval": "POLL_INTERVAL_MS", "env.breaker-threshold": "DISPATCH_BREAKER_THRESHOLD" };
    if (retained.has(ownVariable[check.id] ?? "")) continue;
    // A retained PEM cannot be parsed locally. Newly supplied PEMs are validated
    // independently even when the App ID is retained.
    if (check.id === "env.github-app" && retained.has("GITHUB_APP_PRIVATE_KEY")) continue;
    for (const outcome of await check.run(context)) rows.push({ id: check.id, ...outcome });
  }
  return rows;
}

const quote = (s: string) => `'${s.replaceAll("'", "'\\''")}'`;
const repoPattern = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;

export async function runProvisionClient(args: string[], d: ProvisionDependencies): Promise<number> {
  const out = (s: string) => d.writeStdout(s + "\n");
  const ask = async (label: string, fallback = "") => (await d.prompt(label + (fallback ? ` [${fallback}]` : ""), false)).trim() || fallback;
  const yes = async (label: string) => /^(y|yes)$/i.test(await ask(label + " [y/N]"));
  const command = async (tool: string, argv: string[], stdin?: string) => {
    try { return await d.command(tool, argv, stdin); } catch { return { code: 1, stdout: "", stderr: "" }; }
  };
  const fly = async (argv: string[], stdin?: string) => {
    const result = await command("flyctl", argv, stdin);
    if (result.code) throw new ProvisionError(`flyctl ${argv.slice(0, 2).join(" ")} failed. Check Fly installation and sign-in.`);
    return result.stdout;
  };
  const listing = async (argv: string[]): Promise<Record<string, unknown>[]> => {
    const value: unknown = JSON.parse(await fly(argv));
    if (!Array.isArray(value) || value.some(x => !x || typeof x !== "object")) throw new ProvisionError("Fly returned an invalid JSON listing.");
    return value;
  };
  const prepareDeploy = async (app: string, region: string, kg: string) => {
    const source = await command("gh", ["repo", "view", "--json", "nameWithOwner", "--jq", ".nameWithOwner"]);
    const commit = await command("git", ["rev-parse", "HEAD"]);
    const branch = await command("git", ["rev-parse", "--abbrev-ref", "HEAD"]);
    const sourceRepo = source.code === 0 && repoPattern.test(source.stdout.trim()) ? source.stdout.trim() : "$(gh repo view --json nameWithOwner --jq .nameWithOwner)";
    const stamps = `--build-arg SOURCE_COMMIT=${commit.code === 0 ? quote(commit.stdout.trim()) : '"$(git rev-parse HEAD)"'} --build-arg SOURCE_REPO=${sourceRepo} --build-arg SOURCE_BRANCH=${branch.code === 0 ? quote(branch.stdout.trim()) : '"$(git rev-parse --abbrev-ref HEAD)"'}`;
    const imageTag = `registry.fly.io/${app}:provision-${commit.code === 0 ? commit.stdout.trim().slice(0, 12) : "manual"}`;
    const deploy = kg
      ? `export GH_TOKEN="$(gh auth token)"
flyctl auth docker
docker buildx build --load --no-cache --secret id=kg_token,env=GH_TOKEN --build-arg KG_SOURCE_REPO=${quote(kg)} ${stamps} --tag ${imageTag} .
docker push ${imageTag}
flyctl deploy --image ${imageTag} --primary-region ${region} --ha=false --app ${app}
unset GH_TOKEN`
      : `flyctl deploy --remote-only --no-cache --build-secret kg_token= --build-arg KG_SOURCE_REPO= ${stamps} --primary-region ${region} --ha=false --app ${app}`;
    return { source, commit, branch, sourceRepo, deploy };
  };
  try {
    const slug = args[0];
    if (args.length !== 1 || !slug || !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(slug)) throw new ProvisionError("Usage: npm run provision-client -- <slug>. Use lowercase letters, digits and hyphens with no leading or trailing hyphen.");
    const path = `clients/${slug}.toml`;
    const original = await d.readFile(path);
    let config: Record<string, unknown>;
    if (original !== null) config = parse(original);
    else {
      const app_name = await ask("Fly app", `ai-implement-${slug}`);
      const org = await ask("Fly organization", "personal");
      const region = await ask("Primary region", "iad");
      config = { client: { slug }, fly: { app_name, org, region }, sessions: { app_name: await ask("Sessions app", `ai-implement-sessions-${slug}`), org: await ask("Sessions organization", org), region: await ask("Sessions region", region) } };
    }
    const section = (key: string) => (config[key] ?? {}) as Record<string, unknown>;
    const field = (value: unknown): string => {
      if (typeof value !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9-]*$/.test(value)) throw new ProvisionError("Client app, organization and region fields must be nonempty names.");
      return value;
    };
    const f = section("fly"), s = section("sessions");
    const app = field(f.app_name), org = field(f.org), region = field(f.region);
    const sessions = field(s.app_name ?? `ai-implement-sessions-${slug}`), sessionsOrg = field(s.org ?? org), sessionsRegion = field(s.region ?? region);
    let apps: Record<string, unknown>[];
    try {
      apps = await listing(["apps", "list", "--json"]);
    } catch {
      out("Fly discovery failed. Install flyctl and run flyctl auth login, then rerun setup before deploying.");
      out(`npm run provision-client -- ${slug}`);
      const kg = await ask("KG_SOURCE_REPO (optional)");
      if (kg && !repoPattern.test(kg)) throw new ProvisionError("KG_SOURCE_REPO must be owner/repo.");
      const { deploy } = await prepareDeploy(app, region, kg);
      out("After setup succeeds, these commands deploy, wait for a response and check the orchestrator:");
      out(deploy);
      out(`curl --fail https://${app}.fly.dev/`);
      out(`flyctl ssh console --app ${app} -C "node /app/dist/check-setup.js"`);
      return 1;
    }
    if (apps.some(x => typeof x.Name !== "string")) throw new ProvisionError("Fly apps listing has no Name field.");
    const exists = (name: string) => apps.some(x => x.Name === name);
    const names = exists(app) ? await listing(["secrets", "list", "--app", app, "--json"]) : [];
    if (names.some(x => typeof x.name !== "string")) throw new ProvisionError("Fly secrets listing has no name field.");
    const retained = new Set(names.map(x => x.name as string));
    const env: Record<string, string> = {};
    const set = (key: string, value: string) => {
      if (/[\r\n\0]/.test(value)) throw new ProvisionError(`${key} must be a single line.`);
      env[key] = value;
      retained.delete(key);
    };
    const secret = async (key: string, required = true) => {
      const value = await d.prompt(`${key}${retained.has(key) ? " [already set, Enter to keep]" : required ? " [required]" : " [optional]"}`, true);
      if (value) set(key, value);
      else if (required && !retained.has(key)) throw new ProvisionError(`${key} is required.`);
    };
    const derived = async (key: string, value: string) => {
      if (retained.has(key)) await secret(key);
      else set(key, await ask(key, value));
    };
    await secret("OAUTH_ALLOWED_EMAILS");
    if (env.OAUTH_ALLOWED_EMAILS && !parseAccessEntries(env.OAUTH_ALLOWED_EMAILS.split(",").map(value => ({ kind: "address", value, role: "admin" }))).ok) {
      throw new ProvisionError("OAUTH_ALLOWED_EMAILS must be valid admin email addresses.");
    }
    await derived("RUNNER_CALLBACK_BASE_URL", `https://${app}.fly.dev`);
    await derived("OAUTH_REDIRECT_BASE_URL", `https://${app}.fly.dev`);
    const provider = (await ask("Sign-in provider: google or microsoft", names.some(x => x.name === "MICROSOFT_OAUTH_CLIENT_ID") && !names.some(x => x.name === "GOOGLE_OAUTH_CLIENT_ID") ? "microsoft" : "google")).toLowerCase();
    if (!["google", "microsoft"].includes(provider)) throw new ProvisionError("Choose google or microsoft.");
    for (const key of [`${provider.toUpperCase()}_OAUTH_CLIENT_ID`, `${provider.toUpperCase()}_OAUTH_CLIENT_SECRET`, ...(provider === "microsoft" ? ["MICROSOFT_OAUTH_TENANT"] : [])]) await secret(key);
    if (provider === "microsoft") out("Microsoft requires a single-tenant ID.");
    const tracker = (await ask("Tracker: linear or jira", names.some(x => x.name === "JIRA_TOKEN") && !names.some(x => x.name === "LINEAR_CLIENT_ID") ? "jira" : "linear")).toLowerCase();
    if (tracker === "linear") for (const key of ["LINEAR_CLIENT_ID", "LINEAR_CLIENT_SECRET", "LINEAR_WORKSPACE_URL"]) await secret(key);
    else if (tracker === "jira") {
      let mode = await ask("Jira mode: basic (recommended) or oauth", retained.has("JIRA_CLOUD_ID") && !retained.has("JIRA_EMAIL") ? "oauth" : "basic");
      if (mode === "oauth" && retained.has("JIRA_EMAIL")) {
        out("Switching to Jira OAuth clears the existing JIRA_EMAIL because basic authentication takes precedence.");
        if (await yes("Clear JIRA_EMAIL and switch to OAuth?")) set("JIRA_EMAIL", "");
        else { mode = "basic"; out("Keeping Jira basic authentication and its existing credentials."); }
      }
      if (!["basic", "oauth"].includes(mode)) throw new ProvisionError("Choose basic or oauth.");
      for (const key of [mode === "basic" ? "JIRA_EMAIL" : "JIRA_CLOUD_ID", "JIRA_TOKEN", "JIRA_SITE_URL"]) await secret(key);
    } else throw new ProvisionError("Choose linear or jira.");
    await secret("GITHUB_APP_ID");
    if (env.GITHUB_APP_ID && !/^\d+$/.test(env.GITHUB_APP_ID)) throw new ProvisionError("GITHUB_APP_ID must be numeric.");
    const pem = await ask(`GITHUB_APP_PRIVATE_KEY .pem path${retained.has("GITHUB_APP_PRIVATE_KEY") ? " [Enter to keep]" : ""}`);
    if (pem) {
      if (!pem.endsWith(".pem")) throw new ProvisionError("Choose a .pem file.");
      const key = await d.readFile(pem);
      if (!key) throw new ProvisionError("The .pem file could not be read.");
      set("GITHUB_APP_PRIVATE_KEY", key.replace(/\r?\n/g, "\\n"));
    } else if (!retained.has("GITHUB_APP_PRIVATE_KEY")) throw new ProvisionError("GITHUB_APP_PRIVATE_KEY is required.");
    const subscription = await yes("Will projects run on a Claude subscription?");
    if (subscription) await secret("CLAUDE_CODE_OAUTH_TOKEN");
    for (const key of ["NOTIFY_TYPE", "NOTIFY_WEBHOOK_URL"]) await secret(key, false);
    const kg = await ask("KG_SOURCE_REPO (optional)");
    if (kg && !repoPattern.test(kg)) throw new ProvisionError("KG_SOURCE_REPO must be owner/repo.");
    out("Changing RUNNER_TOKEN_SECRET makes every stored model credential unreadable until it is re-keyed.");
    for (const key of ["RUNNER_TOKEN_SECRET", "GITHUB_WEBHOOK_SECRET", "ADMIN_ACCESS_CODE"]) {
      if (retained.has(key)) await secret(key, false);
      else if (key !== "ADMIN_ACCESS_CODE" || await yes("Generate a break-glass ADMIN_ACCESS_CODE shown once?")) set(key, d.random());
    }
    const sessionsSeeded = retained.has("FLY_SESSIONS_APP");
    let tokenSessionsApp = sessions;
    const mint = new Set<string>();
    for (const key of ["FLY_DEPLOY_TOKEN", "FLY_SESSIONS_TOKEN"]) {
      if (retained.has(key)) await secret(key);
      else mint.add(key);
    }
    if (sessionsSeeded && mint.has("FLY_SESSIONS_TOKEN")) {
      out("The local client file no longer controls the active sessions app. Read its app name on /admin#settings before creating a token.");
      const selected = await ask("Active sessions app from /admin#settings (required)");
      if (!selected) throw new ProvisionError("Select the active sessions app before creating its token.");
      tokenSessionsApp = field(selected);
      if (!exists(tokenSessionsApp)) throw new ProvisionError("The selected active sessions app is absent from the Fly apps listing. Check your account and /admin#settings.");
    }
    if (!sessionsSeeded) {
      set("FLY_SESSIONS_APP", sessions);
      set("FLY_SESSIONS_REGION", sessionsRegion);
    } else out("The sessions app is now changed on /admin#settings. Both sessions seed variables are kept.");
    const repos: string[] = [];
    for (;;) {
      const repo = await ask("Target repo owner/repo (Enter to finish)");
      if (!repo) break;
      if (!repoPattern.test(repo)) throw new ProvisionError("Target repos must be owner/repo.");
      repos.push(repo);
    }
    if (env.GITHUB_APP_PRIVATE_KEY) {
      try { parseAppPrivateKey(env.GITHUB_APP_PRIVATE_KEY); } catch {
        out("env.github-app: fail. Set GITHUB_APP_ID and GITHUB_APP_PRIVATE_KEY. The private key is the PEM file from the GitHub App's settings page.");
        return 1;
      }
    }
    const checks = await provisionPreflight(env, retained);
    const failures = checks.filter(x => x.state === "fail" || x.state === "warn");
    for (const row of failures) out(`${row.id}: ${row.state}. ${row.detail ?? ""} ${row.fix ?? "Correct this answer."}`.replaceAll("—", ",").replaceAll(";", ","));
    if (failures.length) return 1;
    if (retained.size) out("Existing secret values and the saved admin allowlist cannot be verified locally. Remote setup checks verify them after deployment.");
    // Only after preflight may any persistent write or token mint occur.
    if (original === null) await d.writeFile(path, stringify(config));
    for (const [name, organization] of [[app, org], ...(!sessionsSeeded ? [[sessions, sessionsOrg]] : [])]) if (!exists(name)) await fly(["apps", "create", name!, "--org", organization!]);
    const volumes = await listing(["volumes", "list", "--app", app, "--json"]);
    if (volumes.some(x => typeof x.name !== "string" || typeof x.region !== "string")) throw new ProvisionError("Fly volume listing has no name or region field.");
    if (!volumes.some(x => x.name === "dedup_data" && x.region === region)) await fly(["volumes", "create", "dedup_data", "--size", "1", "--region", region, "--app", app, "--yes"]);
    for (const key of mint) {
      const token = await command("flyctl", ["tokens", "create", "deploy", "--app", key === "FLY_DEPLOY_TOKEN" ? app : tokenSessionsApp, ...(key === "FLY_DEPLOY_TOKEN" ? ["--expiry", "8760h"] : [])]);
      if (token.code === 0 && token.stdout.trim()) set(key, token.stdout.trim());
      else await secret(key);
    }
    if (Object.keys(env).length) await fly(["secrets", "import", "--app", app], Object.entries(env).map(([key, value]) => `${key}=${value}\n`).join(""));
    if (env.ADMIN_ACCESS_CODE) out(`Save your break-glass access code now: ${env.ADMIN_ACCESS_CODE}`);
    const base = env.OAUTH_REDIRECT_BASE_URL;
    if (base) {
      out(`Register ${base}/api/auth/${provider}/callback`);
      out(`Register ${base}/mcp/callback/${provider}`);
    } else out(`Read OAUTH_REDIRECT_BASE_URL on the host and register /api/auth/${provider}/callback and /mcp/callback/${provider} under that address.`);
    out(`Host recovery: flyctl ssh console -a ${app} -C "node /app/dist/access-recovery.js --email <address>"`);
    const { source, commit, branch, sourceRepo, deploy } = await prepareDeploy(app, region, kg);
    const deferred: string[] = [];
    out("Deploy builds this checkout with source stamps and the selected knowledge graph.");
    const deployAccepted = await yes("Deploy now?");
    // flyctl v0.5.4 only supports literal NAME=VALUE build secrets. Never leak a token in argv.
    if (deployAccepted && source.code === 0 && commit.code === 0 && branch.code === 0) {
      // No KG is cloned, so no GitHub build credential is needed or passed.
      const auth = await command("flyctl", ["auth", "whoami"]);
      const args = ["deploy", "--remote-only", "--no-cache", "--build-secret", "kg_token=", "--build-arg", "KG_SOURCE_REPO=", "--build-arg", `SOURCE_COMMIT=${commit.stdout.trim()}`, "--build-arg", `SOURCE_REPO=${sourceRepo}`, "--build-arg", `SOURCE_BRANCH=${branch.stdout.trim()}`, "--primary-region", region, "--ha=false", "--app", app];
      let result = auth;
      if (auth.code === 0 && kg) {
        out("Build the knowledge graph with local Docker BuildKit, push to Fly and deploy the image.");
        const token = await command("gh", ["auth", "token"]);
        const image = `registry.fly.io/${app}:provision-${commit.stdout.trim().slice(0, 12)}`;
        result = token.code || !token.stdout.trim() ? { code: 1, stdout: "", stderr: "" } : await command("flyctl", ["auth", "docker"]);
        if (!result.code) result = await command("docker", ["buildx", "build", "--load", "--no-cache", "--secret", "id=kg_token,src=/dev/stdin", "--build-arg", `KG_SOURCE_REPO=${kg}`, "--build-arg", `SOURCE_COMMIT=${commit.stdout.trim()}`, "--build-arg", `SOURCE_REPO=${sourceRepo}`, "--build-arg", `SOURCE_BRANCH=${branch.stdout.trim()}`, "--tag", image, "."], token.stdout.trim());
        if (!result.code) result = await command("docker", ["push", image]);
        if (!result.code) result = await command("flyctl", [...args, "--image", image]);
      } else if (auth.code === 0) result = await command("flyctl", args);
      if (result.code) { out(deploy); deferred.push(deploy); }
    } else {
      out(deploy);
      deferred.push(deploy);
    }
    const health = `https://${app}.fly.dev/`;
    let waitFailed = false;
    if (await yes("Wait up to 15 minutes for the orchestrator to answer?")) {
      const deadline = d.now() + 15 * 60_000;
      let ready = false;
      while (d.now() < deadline) {
        try { ready = await d.http(health); } catch { /* retry until the deadline */ }
        if (ready) break;
        await d.sleep(Math.min(5000, Math.max(0, deadline - d.now())));
      }
      if (!ready) { waitFailed = true; out("The orchestrator did not answer within 15 minutes."); deferred.push(`curl --fail ${health}`); }
    } else { out(`curl --fail ${health}`); deferred.push(`curl --fail ${health}`); }
    const checkArgs = ["ssh", "console", "--app", app, "-C", "node /app/dist/check-setup.js"];
    const checkCommand = `flyctl ssh console --app ${app} -C "node /app/dist/check-setup.js"`;
    let status = waitFailed ? 1 : 0;
    if (await yes("Run the setup checks on the orchestrator?")) {
      const machines = await command("flyctl", ["machines", "list", "--app", app, "--json"]);
      let running = false;
      try { running = machines.code === 0 && JSON.parse(machines.stdout).some((m: { state: string }) => m.state === "started"); } catch { /* defer */ }
      if (running) {
        const result = await command("flyctl", checkArgs);
        // Remote output is useful, but tools can include values in diagnostics. Redact all known secrets.
        const redact = (text: string) => Object.values(env).filter(Boolean).sort((a,b) => b.length-a.length).reduce((s,v) => s.replaceAll(v, "[redacted]"), text).replaceAll("—", ",").replaceAll(";", ",");
        d.writeStdout(redact(result.stdout));
        d.writeStderr(redact(result.stderr));
        status = result.code || status;
        if (status) deferred.push(checkCommand);
      } else { out(checkCommand); deferred.push(checkCommand); status = 1; }
    } else { out(checkCommand); deferred.push(checkCommand); }
    for (const repo of repos) {
      out(`gh secret set AI_IMPLEMENT_APP_ID --repo ${repo} --body ${env.GITHUB_APP_ID ? '"$(flyctl ssh console -a ' + app + ' -C "printenv GITHUB_APP_ID")"' : '"<App ID>"'}`);
      out(`gh secret set AI_IMPLEMENT_PRIVATE_KEY --repo ${repo} < ${pem ? quote(pem) : "<pem-path>"}`);
      if (subscription) out(`gh secret set CLAUDE_CODE_OAUTH_TOKEN --repo ${repo}`);
    }
    out(`Set the App webhook to ${env.RUNNER_CALLBACK_BASE_URL ?? "<RUNNER_CALLBACK_BASE_URL>"}/api/github/webhook with pull_request and issue_comment events.`);
    out(`Read its secret with flyctl ssh console -a ${app} -C "printenv GITHUB_WEBHOOK_SECRET"`);
    out("Add each project on /admin with the New project stepper. Check installation links to installing the App or adding the repo. Saving starts workflow sync.");
    if (!subscription) out('Add an Anthropic API-key profile on Models & providers and opt each project in on its Agents tab before its first dispatch. A project left legacy with no key logs "Cannot dispatch" every poll and nothing else. On Fly, a repo that pins a custom runner image cannot opt in yet.');
    else out("Claude subscription projects stay on the legacy path. A subscription cannot yet be an account profile.");
    if (deferred.length) out("Remaining commands:\n" + deferred.join("\n"));
    return status;
  } catch (error) {
    // Never forward an exception from a tool, parser, filesystem or prompt, which can contain secrets.
    const safe = error instanceof ProvisionError ? error.message : "Provisioning failed. Check the client TOML, input files and tool availability.";
    d.writeStderr(safe + "\n");
    return 1;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { readFile, writeFile, mkdir } = await import("node:fs/promises");
  const { dirname } = await import("node:path");
  const { randomBytes } = await import("node:crypto");
  const { spawn } = await import("node:child_process");
  const { createInterface } = await import("node:readline/promises");
  const prompt = async (label: string, hidden: boolean): Promise<string> => {
    if (!hidden) {
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      try { return await rl.question(label + ": "); } finally { rl.close(); }
    }
    if (!process.stdin.isTTY) throw new ProvisionError("Hidden prompts require a terminal.");
    process.stdout.write(label + ": ");
    const { emitKeypressEvents } = await import("node:readline");
    emitKeypressEvents(process.stdin);
    process.stdin.setRawMode(true);
    process.stdin.resume();
    return new Promise((resolve, reject) => {
      let value = "";
      const finish = () => { process.stdin.off("keypress", onKey); process.stdin.setRawMode(false); process.stdin.pause(); process.stdout.write("\n"); };
      const onKey = (text: string, key: { name?: string; ctrl?: boolean }) => {
        if (key.ctrl && key.name === "c") { finish(); reject(new Error("Cancelled")); }
        else if (key.name === "return" || key.name === "enter") { finish(); resolve(value); }
        else if (key.name === "backspace") value = value.slice(0, -1);
        else if (text && !key.ctrl) value += text;
      };
      process.stdin.on("keypress", onKey);
    });
  };
  const deps: ProvisionDependencies = {
    prompt,
    readFile: async path => { try { return await readFile(path, "utf8"); } catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return null; throw e; } },
    writeFile: async (path, value) => { await mkdir(dirname(path), { recursive: true }); await writeFile(path, value, { mode: 0o600 }); },
    command: (tool, args, stdin) => new Promise(resolve => {
      const child = spawn(tool, args, { stdio: ["pipe", "pipe", "pipe"] });
      let stdout = "", stderr = "";
      child.stdout.on("data", chunk => { stdout += chunk; });
      child.stderr.on("data", chunk => { stderr += chunk; });
      child.on("error", () => resolve({ code: 1, stdout: "", stderr: "" }));
      child.stdin.on("error", () => {});
      child.on("close", code => resolve({ code: code ?? 1, stdout, stderr }));
      child.stdin.end(stdin);
    }),
    random: () => randomBytes(32).toString("hex"),
    http: async url => (await fetch(url, { signal: AbortSignal.timeout(10_000) })).ok,
    now: Date.now, sleep: ms => new Promise(resolve => setTimeout(resolve, ms)),
    writeStdout: text => process.stdout.write(text), writeStderr: text => process.stderr.write(text),
  };
  process.exitCode = await runProvisionClient(process.argv.slice(2), deps);
}
