#!/usr/bin/env node
import { execFile, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { chmod, cp, copyFile, mkdir, readFile, rm, stat, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, "..");
const PROVIDER_SOURCE = join(SCRIPT_DIR, "local-feedback-provider.mjs");
const FIXTURE_SOURCE = join(REPO_ROOT, "examples", "local-demo");
const PREFIX = "bd-local-feedback";
const PROVIDER_ALIAS = "local-feedback-provider";
const DEFAULT_PROVIDER_PORT = 8080;
const DEFAULT_BRIDGE_PORT = 8090;
const REQUIRED_CODEX_VERSION = "0.159.2";
const TARGET_TEXT = "AI-Implement completed this local task.\n";
const AMBIENT_MODEL_CANARY = "ambient-claude-model-canary";
const AMBIENT_BASE_URL_CANARY = "http://ambient-openai-base-url.invalid/v1";
const SYNTHETIC_MODELS = {
  planning: "gpt-local-planning",
  implementation: "gpt-local-implementation",
  review: "gpt-local-review",
};
const SYNTHETIC_PROFILES = {
  planning: "local-feedback-planning",
  implementation: "local-feedback-implementation",
  review: "local-feedback-review",
};
const SYNTHETIC_FORBIDDEN_ENV = new Set([
  "OPENAI_API_KEY",
  "OPENAI_BASE_URL",
  "ANTHROPIC_API_KEY",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "CLAUDE_MODEL",
  "CODEX_API_KEY",
  "NPM_TOKEN",
]);
const GENERATED_ARTIFACT_ALLOWLIST = new Set([".local-feedback"]);

function fail(message) {
  const error = new Error(message);
  error.localFeedback = true;
  return error;
}

export function parseArgs(argv = []) {
  const out = {
    live: false,
    rebuild: false,
    workspace: undefined,
    task: undefined,
    agentConfig: undefined,
    artifactsDir: undefined,
    image: undefined,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const value = () => {
      const next = argv[i + 1];
      if (!next || next.startsWith("--")) throw fail(`Missing value for ${arg}`);
      i += 1;
      return next;
    };
    if (arg === "--live") out.live = true;
    else if (arg === "--rebuild") out.rebuild = true;
    else if (arg === "--workspace" || arg === "-w") out.workspace = value();
    else if (arg === "--task" || arg === "-t") out.task = value();
    else if (arg === "--agent-config") out.agentConfig = value();
    else if (arg === "--artifacts-dir") out.artifactsDir = value();
    else if (arg === "--image") out.image = value();
    else throw fail(`Unknown argument: ${arg}`);
  }
  if (out.live) {
    if (!out.agentConfig || !out.workspace || !out.task) throw fail("--live requires --agent-config, --workspace, and --task");
    if (out.rebuild) throw fail("--live cannot be combined with --rebuild");
  } else {
    if (out.agentConfig) throw fail("--agent-config is only valid with --live; the synthetic gate builds its own external config");
    if (out.workspace || out.task) throw fail("default synthetic mode owns its fixture workspace and task");
  }
  return out;
}

export function assertSafeEnvironment(env = process.env, mode = "synthetic") {
  const collisions = [];
  if (env.NODE_OPTIONS) collisions.push("NODE_OPTIONS");
  if (env.NODE_PATH) collisions.push("NODE_PATH");
  if (mode === "synthetic") {
    for (const [key, value] of Object.entries(env)) {
      if (value === undefined || value === "") continue;
      if (SYNTHETIC_FORBIDDEN_ENV.has(key) || key.startsWith("AI_IMPLEMENT_MODEL_AUTH_")) collisions.push(key);
    }
  }
  if (collisions.length > 0) throw fail(`Unsafe environment for local feedback: ${[...new Set(collisions)].sort().join(", ")}`);
  return true;
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: "utf8", stdio: options.stdio ?? ["ignore", "pipe", "pipe"], ...options });
  return { status: result.status ?? 1, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

function requireOk(result, message) {
  if (result.status !== 0) throw fail(`${message}: ${(result.stderr || result.stdout || `exit ${result.status}`).trim()}`);
  return result;
}

function sha256(text) {
  return createHash("sha256").update(text).digest("hex");
}

export function gateMarkerPath(repoRoot = REPO_ROOT) {
  return join(tmpdir(), `${PREFIX}-gates`, sha256(resolve(repoRoot)), "gate.json");
}

export function resolveSourceIdentity(repoDir = REPO_ROOT, exec = run) {
  const head = requireOk(exec("git", ["rev-parse", "HEAD"], { cwd: repoDir }), "git rev-parse HEAD failed").stdout.trim();
  const trackedDiff = requireOk(exec("git", ["diff", "--binary", "HEAD"], { cwd: repoDir }), "git diff failed").stdout;
  const porcelain = requireOk(exec("git", ["status", "--porcelain"], { cwd: repoDir }), "git status failed").stdout.split("\n").filter(Boolean);
  const untracked = porcelain
    .filter((line) => line.startsWith("?? "))
    .map((line) => line.slice(3).split("/")[0])
    .filter((top) => !GENERATED_ARTIFACT_ALLOWLIST.has(top));
  if (untracked.length > 0) throw fail(`Untracked source is not represented by the git archive/diff proof: ${[...new Set(untracked)].sort().join(", ")}`);
  return { head, trackedDiffSha256: sha256(trackedDiff), dirty: trackedDiff.length > 0, trackedDiff, status: porcelain };
}

function writeJson(path, value, mode = 0o600) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { mode });
}

function ensureNode24() {
  if (!/^v24\./.test(process.version)) throw fail(`local feedback requires Node 24.x, got ${process.version}`);
  return process.version;
}

function dockerAvailable(exec = run) {
  requireOk(exec("docker", ["version", "--format", "{{.Server.Version}}"]), "Docker is required for local feedback");
}

function makeTempRoot(prefix, requested) {
  if (!requested) return mkdtempSync(join(tmpdir(), `${prefix}-`));
  const root = resolve(requested);
  if (existsSync(root) && readdirSync(root).length > 0) {
    throw fail(`--artifacts-dir must be empty so proof cannot reuse stale local feedback output: ${root}`);
  }
  mkdirSync(root, { recursive: true, mode: 0o700 });
  return root;
}

async function createSyntheticWorkspace(root) {
  if (!existsSync(FIXTURE_SOURCE)) throw fail(`local feedback fixture is missing: ${FIXTURE_SOURCE}`);
  const workspace = join(root, "workspace");
  await mkdir(join(workspace, "examples"), { recursive: true });
  await cp(FIXTURE_SOURCE, join(workspace, "examples", "local-demo"), { recursive: true });
  requireOk(run("git", ["init"], { cwd: workspace }), "fixture git init failed");
  requireOk(run("git", ["config", "user.email", "local-feedback@example.invalid"], { cwd: workspace }), "fixture git config failed");
  requireOk(run("git", ["config", "user.name", "Local Feedback"], { cwd: workspace }), "fixture git config failed");
  requireOk(run("git", ["remote", "add", "origin", "https://github.com/BuildDownAI/local-demo.git"], { cwd: workspace }), "fixture git remote failed");
  requireOk(run("git", ["add", "."], { cwd: workspace }), "fixture git add failed");
  requireOk(run("git", ["commit", "-m", "fixture baseline"], { cwd: workspace }), "fixture git commit failed");
  return { workspace, task: join(workspace, "examples", "local-demo", "task.md") };
}

export function buildSyntheticAgentConfig({ root, projectKey = "BuildDownAI/local-demo" }) {
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const keyPaths = {};
  for (const stage of Object.keys(SYNTHETIC_PROFILES)) {
    const p = join(root, `${stage}.key`);
    writeFileSync(p, `sk-local-feedback-${stage}-${randomUUID()}\n`, { mode: 0o600 });
    keyPaths[stage] = p;
  }
  const stages = Object.fromEntries(Object.entries(SYNTHETIC_MODELS).map(([stage, model]) => [stage, {
    agent: "codex",
    provider: "openai",
    model,
    accountProfileId: SYNTHETIC_PROFILES[stage],
    invocationTimeoutMs: stage === "implementation" ? 180000 : 120000,
  }]));
  const profiles = Object.entries(SYNTHETIC_PROFILES).map(([stage, id]) => ({
    id,
    identity: `local feedback ${stage}`,
    revision: 1,
    agent: "codex",
    provider: "openai",
    authMode: "openai-api-key",
    credentialPath: keyPaths[stage],
  }));
  const config = { version: 1, mode: "configured", projectKey, stages, profiles };
  const configPath = join(root, "agent-config.json");
  writeJson(configPath, config);
  return { configPath, config, profileIds: Object.values(SYNTHETIC_PROFILES) };
}

async function copyProviderScript(root) {
  if (!existsSync(PROVIDER_SOURCE)) throw fail(`local feedback provider is missing: ${PROVIDER_SOURCE}`);
  const dest = join(root, "local-feedback-provider.mjs");
  await copyFile(PROVIDER_SOURCE, dest);
  return dest;
}

async function waitForFile(path, timeoutMs = 15000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (existsSync(path)) return JSON.parse(await readFile(path, "utf8"));
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw fail(`Timed out waiting for ${path}`);
}

function docker(args, options = {}) {
  return run("docker", args, { stdio: options.stdio ?? ["ignore", "pipe", "pipe"], ...options });
}

function dockerOk(args, message) {
  return requireOk(docker(args), message);
}

async function createNetworkAndPeer({ root, imageId, providerScript, providerPort, bridgePort, bridgeTargetPort, failureMode = "none" }) {
  await mkdir(root, { recursive: true, mode: 0o700 });
  const networkName = `${PREFIX}-${process.pid}-${Date.now()}`.slice(0, 63);
  const peerName = `${networkName}-peer`.slice(0, 63);
  const readyFile = join(root, "peer-ready.json");
  const eventLog = join(root, "provider-events.jsonl");
  dockerOk(["network", "create", "--internal", networkName], "failed to create internal Docker network");
  let peerStarted = false;
  let connected = false;
  try {
    dockerOk([
      "run", "-d", "--name", peerName,
      "--entrypoint", "node",
      "-v", `${providerScript}:/local-feedback-provider.mjs:ro`,
      "-v", `${root}:${root}:rw`,
      "-e", `LOCAL_FEEDBACK_PROVIDER_PORT=${providerPort}`,
      "-e", `LOCAL_FEEDBACK_BRIDGE_PORT=${bridgePort}`,
      "-e", `LOCAL_FEEDBACK_BRIDGE_TARGET_PORT=${bridgeTargetPort}`,
      "-e", "LOCAL_FEEDBACK_BRIDGE_TARGET_HOST=host.docker.internal",
      "-e", `LOCAL_FEEDBACK_READY_FILE=${readyFile}`,
      "-e", `LOCAL_FEEDBACK_EVENT_LOG=${eventLog}`,
      "-e", `LOCAL_FEEDBACK_FAILURE_MODE=${failureMode}`,
      "--add-host", "host.docker.internal:host-gateway",
      imageId,
      "/local-feedback-provider.mjs",
    ], "failed to start local feedback provider peer");
    peerStarted = true;
    dockerOk(["network", "connect", "--alias", PROVIDER_ALIAS, networkName, peerName], "failed to attach provider peer to internal network");
    connected = true;
    await waitForFile(readyFile);
    const peerIp = dockerOk(["inspect", "--format", `{{(index .NetworkSettings.Networks ${JSON.stringify(networkName)}).IPAddress}}`, peerName], "failed to inspect peer IP").stdout.trim();
    if (!peerIp) throw fail("local feedback provider peer has no internal network IP");
    return {
      networkName,
      peerName,
      peerIp,
      providerPort,
      bridgePort,
      eventLog,
      cleanup: async () => {
        if (connected) docker(["network", "disconnect", "-f", networkName, peerName]);
        if (peerStarted) docker(["rm", "-f", peerName]);
        docker(["network", "rm", networkName]);
      },
    };
  } catch (error) {
    if (connected) docker(["network", "disconnect", "-f", networkName, peerName]);
    if (peerStarted) docker(["rm", "-f", peerName]);
    docker(["network", "rm", networkName]);
    throw error;
  }
}

export function createSourceContext({ repoRoot = REPO_ROOT, source }) {
  const context = mkdtempSync(join(tmpdir(), `${PREFIX}-src-`));
  const archive = spawnSync("git", ["archive", source.head], { cwd: repoRoot, encoding: null, maxBuffer: 1024 * 1024 * 512, stdio: ["ignore", "pipe", "pipe"] });
  if ((archive.status ?? 1) !== 0) throw fail(`git archive failed: ${archive.stderr?.toString().trim() ?? archive.status}`);
  const tar = spawnSync("tar", ["-x", "-C", context], { input: archive.stdout, encoding: null, maxBuffer: 1024 * 1024 * 512, stdio: ["pipe", "pipe", "pipe"] });
  if ((tar.status ?? 1) !== 0) throw fail(`git archive extract failed: ${tar.stderr?.toString().trim() ?? tar.status}`);
  if (source.trackedDiff) {
    const applied = run("git", ["apply", "--binary", "--whitespace=nowarn", "-"], { cwd: context, input: source.trackedDiff, stdio: ["pipe", "pipe", "pipe"] });
    requireOk(applied, "failed to apply tracked source diff to build context");
  }
  return context;
}

function inspectImageLabels(imageId, source, exec = run) {
  const labels = JSON.parse(requireOk(exec("docker", ["image", "inspect", imageId, "--format", "{{json .Config.Labels}}"]), "runner image label inspect failed").stdout.trim() || "{}");
  if (labels["ai-implement.local-feedback.head"] !== source.head) throw fail("runner image head label does not match current source identity");
  if (labels["ai-implement.local-feedback.tracked-diff"] !== source.trackedDiffSha256) throw fail("runner image diff label does not match current source identity");
  return labels;
}

function buildImage({ repoRoot = REPO_ROOT, source, rebuild = false, exec = run }) {
  const tag = `${PREFIX}:local-${source.head.slice(0, 12)}-${source.trackedDiffSha256.slice(0, 12)}`.toLowerCase();
  const labelArgs = [
    ["ai-implement.local-feedback.head", source.head],
    ["ai-implement.local-feedback.tracked-diff", source.trackedDiffSha256],
    ["ai-implement.local-feedback.dirty", String(source.dirty)],
  ].flatMap(([key, value]) => ["--label", `${key}=${value}`]);
  const existing = exec("docker", ["image", "inspect", tag]).status === 0;
  if (existing && !rebuild) {
    const imageId = requireOk(exec("docker", ["image", "inspect", tag, "--format", "{{.Id}}"]), "runner image inspect failed").stdout.trim();
    const labels = inspectImageLabels(imageId, source, exec);
    return { tag, imageId, labels, rebuilt: false };
  }
  const context = createSourceContext({ repoRoot, source });
  try {
    const args = ["build", "-f", "Dockerfile.session", "-t", tag, ...labelArgs, "."];
    requireOk(exec("docker", args, { cwd: context, stdio: "inherit" }), "runner image build failed");
  } finally {
    rmSync(context, { recursive: true, force: true });
  }
  const imageId = requireOk(exec("docker", ["image", "inspect", tag, "--format", "{{.Id}}"], { cwd: repoRoot }), "runner image inspect failed").stdout.trim();
  if (!imageId.startsWith("sha256:")) throw fail(`docker image inspect returned a non-immutable id: ${imageId}`);
  const labels = inspectImageLabels(imageId, source, exec);
  return { tag, imageId, labels, rebuilt: true };
}

function inspectImageTools(imageId) {
  const nodeVersion = requireOk(run("docker", ["run", "--rm", "--entrypoint", "node", imageId, "--version"]), "runner image Node check failed").stdout.trim();
  if (!/^v24\./.test(nodeVersion)) throw fail(`runner image must have Node 24.x, got ${nodeVersion}`);
  const codexVersion = requireOk(run("docker", ["run", "--rm", "--entrypoint", "codex", imageId, "--version"]), "runner image Codex check failed").stdout.trim();
  if (!new RegExp(`${REQUIRED_CODEX_VERSION.replaceAll(".", "\\.")}\\b`).test(codexVersion)) throw fail(`runner image must have Codex ${REQUIRED_CODEX_VERSION}, got ${codexVersion}`);
  const entrypoint = JSON.parse(requireOk(run("docker", ["image", "inspect", imageId, "--format", "{{json .Config.Entrypoint}}"]), "runner image entrypoint inspect failed").stdout.trim());
  if (!Array.isArray(entrypoint) || entrypoint.length !== 1 || entrypoint[0] !== "/opt/ai-implement/entrypoint.sh") {
    throw fail(`runner image entrypoint must be /opt/ai-implement/entrypoint.sh, got ${JSON.stringify(entrypoint)}`);
  }
  requireOk(run("docker", ["run", "--rm", "--entrypoint", "test", imageId, "-x", "/opt/ai-implement/entrypoint.sh"]), "runner image production entrypoint check failed");
  const sourceHash = sha256(readFileSync(join(REPO_ROOT, "session", "entrypoint.sh")));
  const imageHash = requireOk(run("docker", ["run", "--rm", "--entrypoint", "sha256sum", imageId, "/opt/ai-implement/entrypoint.sh"]), "runner image entrypoint hash failed").stdout.trim().split(/\s+/)[0];
  if (imageHash !== sourceHash) throw fail("runner image entrypoint hash does not match represented source");
  return { nodeVersion, codexVersion, entrypoint: entrypoint[0], entrypointSha256: imageHash };
}

export function buildDevHarnessArgs({ workspace, task, imageId, agentConfig }) {
  return ["--workspace", workspace, "--task", task, "--phase", "full", "--workspace-mode", "copy", "--image", imageId, "--agent-config", agentConfig];
}

export function buildLocalFeedbackOptions({ providerPort = DEFAULT_PROVIDER_PORT, bridgePort = DEFAULT_BRIDGE_PORT, networkName, hostGateway }) {
  return { providerPort, bridgePort, networkName, hostGateway };
}

function execFileWithTimeout(command, args, timeoutMs) {
  return new Promise((resolve) => {
    execFile(command, args, { timeout: timeoutMs }, () => resolve(undefined));
  });
}

function delay(ms, value) {
  let timer;
  const promise = new Promise((resolve) => {
    timer = setTimeout(() => resolve(value), ms);
    timer.unref?.();
  });
  return { promise, clear: () => clearTimeout(timer) };
}

export function makeCliDeps({ cliModule, localFeedback, artifactsDir, logsPath, signalProcess = process }) {
  const out = [];
  const err = [];
  const controller = new AbortController();
  const abortFromSignal = () => controller.abort();
  signalProcess?.once?.("SIGINT", abortFromSignal);
  signalProcess?.once?.("SIGTERM", abortFromSignal);
  const dispose = () => {
    signalProcess?.off?.("SIGINT", abortFromSignal);
    signalProcess?.off?.("SIGTERM", abortFromSignal);
  };
  let lastHandle;
  let stopProof;
  const deps = {
    startDevRun: async (opts) => {
      lastHandle = await cliModule.startDevRun({
        ...opts,
        artifactsDir,
        githubToken: "dev-placeholder-token",
        env: {
          CLAUDE_MODEL: AMBIENT_MODEL_CANARY,
          OPENAI_BASE_URL: AMBIENT_BASE_URL_CANARY,
          ...(opts.env ?? {}),
        },
        localFeedback,
      });
      return lastHandle;
    },
    streamLogs: cliModule.streamLogs,
    streamLogsUntilShellReady: cliModule.streamLogsUntilShellReady,
    getRunStatus: cliModule.getRunStatus,
    collectRunArtifacts: cliModule.collectRunArtifacts,
    stopSession: async (handle) => {
      stopProof = {
        networks: safeInspectContainerNetworks(handle.containerName),
        stopped: containerStopped(handle.containerName),
      };
      await cliModule.stopDevRun(handle);
    },
    stopContainer: async (handle) => { await execFileWithTimeout("docker", ["stop", "--time", "2", handle.containerName], 15_000); },
    spawnDocker: (args, stdio) => spawnSync("docker", args, { stdio }).status ?? 1,
    writeStdout: (text) => { out.push(text); if (logsPath) writeFileSync(logsPath, out.join("")); },
    writeStderr: (text) => { err.push(text); },
    now: () => Date.now(),
    cancelSignal: controller.signal,
  };
  return { deps, out, err, abort: () => controller.abort(), dispose, getHandle: () => lastHandle, getStopProof: () => stopProof };
}

async function importBuiltHarness() {
  requireOk(run("npm", ["run", "build"], { cwd: REPO_ROOT, stdio: "inherit" }), "host dist build failed");
  const distCli = join(REPO_ROOT, "dist", "dev-harness", "cli.js");
  const distIndex = join(REPO_ROOT, "dist", "dev-harness", "index.js");
  if (!existsSync(distCli) || !existsSync(distIndex)) throw fail("dist dev-harness is missing after npm run build");
  const cli = await import(`${pathToFileURL(distCli).href}?localFeedback=${Date.now()}`);
  const index = await import(`${pathToFileURL(distIndex).href}?localFeedback=${Date.now()}`);
  return { ...index, runDevHarnessCli: cli.runDevHarnessCli };
}

function summarizeStages(config) {
  return Object.fromEntries(Object.entries(config.stages).map(([stage, selected]) => [stage, {
    agent: selected.agent,
    provider: selected.provider,
    model: selected.model,
    profileId: selected.accountProfileId,
    authMode: config.profiles.find((p) => p.id === selected.accountProfileId)?.authMode,
    invocationTimeoutMs: selected.invocationTimeoutMs,
  }]));
}

export function summarizeResult(input) {
  return [
    "# Local Feedback Result", "",
    `- outcome: ${input.ok ? "success" : "failure"}`,
    `- mode: ${input.mode}`,
    `- source head: ${input.source?.head ?? "unknown"}`,
    `- tracked diff: ${input.source?.trackedDiffSha256 ?? "unknown"}`,
    `- image: ${input.image?.imageId ?? input.image ?? "unknown"}`,
    `- artifacts: ${input.artifactsDir}`, "",
    "## Stage selections", "", "```json", JSON.stringify(input.stages ?? {}, null, 2), "```", "",
    input.note ?? "",
  ].join("\n");
}

async function runInvalidConfigScenario({ root, cliModule, imageId, fixture }) {
  const dir = join(root, "invalid-config");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const bad = join(dir, "agent-config.json");
  writeJson(bad, { version: 1, mode: "configured", projectKey: "BuildDownAI/local-demo", stages: {}, profiles: [] });
  const { deps, err, getHandle, dispose } = makeCliDeps({ cliModule, artifactsDir: join(dir, "artifacts") });
  let exitCode = 1;
  try {
    exitCode = await cliModule.runDevHarnessCli(buildDevHarnessArgs({ workspace: fixture.workspace, task: fixture.task, imageId, agentConfig: bad }), deps);
  } finally {
    dispose();
  }
  const noContainerStarted = getHandle() === undefined;
  return {
    name: "invalid-config",
    ok: exitCode !== 0 && noContainerStarted && /profile|stage|config|snapshot|requires/i.test(err.join("")),
    exitCode,
    noContainerStarted,
    stderr: err.join(""),
  };
}

async function runNodePreloadScenario() {
  try {
    assertSafeEnvironment({ ...process.env, NODE_OPTIONS: "--require ./evil.js" }, "synthetic");
    return { name: "node-preload", ok: false, error: "accepted NODE_OPTIONS" };
  } catch (error) {
    return { name: "node-preload", ok: /NODE_OPTIONS/.test(error.message), error: error.message };
  }
}

async function runEnvCollisionScenario() {
  try {
    assertSafeEnvironment({ PATH: process.env.PATH, CODEX_HOME: "/ambient-ok", OPENAI_BASE_URL: "http://ambient.invalid", CLAUDE_MODEL: "canary" }, "synthetic");
    return { name: "env-collision", ok: false, error: "accepted ambient route" };
  } catch (error) {
    return { name: "env-collision", ok: /OPENAI_BASE_URL/.test(error.message) && /CLAUDE_MODEL/.test(error.message), error: error.message };
  }
}

function category(error) {
  return typeof error?.category === "string" ? error.category : "unknown";
}

async function mkdirPrivate(path) {
  await mkdir(path, { recursive: true, mode: 0o700 });
  await chmod(path, 0o700).catch(() => undefined);
}

async function writePrivateFile(path, content) {
  await writeFile(path, content, { mode: 0o600 });
  await chmod(path, 0o600).catch(() => undefined);
}

async function makeSubscriptionFixture(privateRoot, name) {
  const root = mkdtempSync(join(privateRoot, `${name}-`));
  const repo = join(root, "repo");
  const outside = join(root, "outside");
  const authRoot = join(root, "auth-root");
  await mkdirPrivate(repo);
  await mkdirPrivate(outside);
  await mkdirPrivate(authRoot);
  const authPath = join(outside, "auth.json");
  const configPath = join(outside, "agent-config.json");
  await writePrivateFile(authPath, '{"tokens":{"account_id":"acct-local","refresh_token":"r1"}}\n');
  const stage = { agent: "codex", provider: "openai", model: "gpt-local-subscription", accountProfileId: "sub", invocationTimeoutMs: 60000 };
  await writePrivateFile(configPath, JSON.stringify({
    version: 1,
    mode: "configured",
    projectKey: "local-demo",
    stages: { planning: stage, implementation: stage, review: stage },
    profiles: [{ id: "sub", identity: "local synthetic subscription", revision: 1, agent: "codex", provider: "openai", authMode: "codex-subscription", sessionPath: authPath, sessionSource: "local-login", trustedPrivateTesting: true }],
  }));
  return { root, repo, outside, authRoot, authPath, configPath, lockPath: join(outside, ".auth.json.ai-lock") };
}

async function makeSubscriptionLifecycle(classes, fixture) {
  const loaded = await classes.loadLocalAgentConfig({ configPath: fixture.configPath, projectKey: "local-demo", forbiddenRoots: [fixture.repo] });
  const sub = loaded.references.get("sub");
  if (!sub) throw fail("subscription lifecycle fixture did not resolve selected reference");
  const ownership = new classes.LocalSessionOwnership({ forbiddenRoots: [fixture.repo] });
  const port = classes.createLocalCredentialPort({ references: loaded.references, forbiddenRoots: [fixture.repo], ownership });
  const client = classes.createModelAuthClient({
    source: { kind: "local", port },
    authRoot: fixture.authRoot,
    forbiddenRoots: [fixture.repo],
    inheritedEnv: { PATH: process.env.PATH ?? "/usr/bin", OPENAI_API_KEY: "synthetic-ambient-openai-key", CODEX_HOME: "/synthetic/ambient-codex-home" },
  });
  return { sub, ownership, port, client };
}

async function checkoutInvokeFinishSubscription(lifecycle, capture = {}) {
  await lifecycle.client.checkout({ profileId: "sub", authMode: "codex-subscription" });
  await lifecycle.client.invoke("sub", async ({ env }) => {
    capture.codexHome = env.CODEX_HOME;
    capture.selectedEnvHadCodexHome = typeof env.CODEX_HOME === "string" && env.CODEX_HOME.length > 0;
    capture.ambientOpenAiKeyStripped = !Object.prototype.hasOwnProperty.call(env, "OPENAI_API_KEY");
    capture.ambientCodexHomeStripped = env.CODEX_HOME !== "/synthetic/ambient-codex-home";
    await writePrivateFile(join(env.CODEX_HOME, "auth.json"), '{"tokens":{"account_id":"acct-local","refresh_token":"r2"}}\n');
  });
  await lifecycle.client.finish("sub", "completed");
  await lifecycle.client.dispose();
}

export function subscriptionUnknownProof({ category: releaseCategory, heldBeforeRetry, busyCategory, releasedAfterRetry }) {
  return {
    unknownTerminationCategory: releaseCategory,
    unknownTerminationHeldLock: heldBeforeRetry === true,
    unknownTerminationBlocksOtherOwner: busyCategory === "session_busy",
    unknownRetryConfirmedReleased: releasedAfterRetry === true,
  };
}

async function runSubscriptionLifecycleSimulation(root) {
  const [{ loadLocalAgentConfig, LocalSessionOwnership, createLocalCredentialPort }, { createModelAuthClient }] = await Promise.all([
    import(pathToFileURL(join(REPO_ROOT, "dist", "local", "agent-config.js")).href),
    import(pathToFileURL(join(REPO_ROOT, "dist", "model-auth-client.js")).href),
  ]);
  const classes = { loadLocalAgentConfig, LocalSessionOwnership, createLocalCredentialPort, createModelAuthClient };
  const runRoot = mkdtempSync(join(root, "subscription-lifecycle-"));
  const refreshed = '{"tokens":{"account_id":"acct-local","refresh_token":"r2"}}\n';
  try {
    const happyFixture = await makeSubscriptionFixture(runRoot, "happy");
    const happyLifecycle = await makeSubscriptionLifecycle(classes, happyFixture);
    const happyLease = await happyLifecycle.ownership.acquire(happyLifecycle.sub);
    const happyCapture = {};
    await checkoutInvokeFinishSubscription(happyLifecycle, happyCapture);
    const happyExternalLoginRefreshed = (await readFile(happyFixture.authPath, "utf8")) === refreshed;
    let happyTempRemoved = false;
    try { await stat(happyCapture.codexHome); } catch { happyTempRemoved = true; }
    await happyLifecycle.ownership.release(happyLease, { confirmTermination: async () => "confirmed" });
    let happyLockGone = false;
    try { await stat(happyFixture.lockPath); } catch { happyLockGone = true; }
    const reacquire = await happyLifecycle.ownership.acquire(happyLifecycle.sub);
    const reloaded = await happyLifecycle.port.load({ profileId: "sub", authMode: "codex-subscription" });
    await happyLifecycle.port.persistSession({ profileId: "sub", sessionData: reloaded.sessionData });
    await happyLifecycle.ownership.release(reacquire, { confirmTermination: async () => "confirmed" });

    const unknownFixture = await makeSubscriptionFixture(runRoot, "unknown");
    const unknownLifecycle = await makeSubscriptionLifecycle(classes, unknownFixture);
    const unknownLease = await unknownLifecycle.ownership.acquire(unknownLifecycle.sub);
    await checkoutInvokeFinishSubscription(unknownLifecycle);
    let unknownCategory = "none";
    try { await unknownLifecycle.ownership.release(unknownLease, { confirmTermination: async () => "unknown" }); }
    catch (error) { unknownCategory = category(error); }
    const heldReason = JSON.parse(await readFile(unknownFixture.lockPath, "utf8")).holdReason;
    const unknownHeldBeforeRetry = unknownLease.status === "held" && heldReason === "termination_unconfirmed";
    const otherOwner = new classes.LocalSessionOwnership({ forbiddenRoots: [unknownFixture.repo] });
    let busyCategory = "none";
    try { await otherOwner.acquire(unknownLifecycle.sub); } catch (error) { busyCategory = category(error); }
    await unknownLifecycle.ownership.release(unknownLease, { confirmTermination: async () => "confirmed" });
    const unknownReleasedAfterRetry = unknownLease.status === "released";

    const stalePersistFixture = await makeSubscriptionFixture(runRoot, "stale-persist");
    const stalePersistLifecycle = await makeSubscriptionLifecycle(classes, stalePersistFixture);
    await stalePersistLifecycle.ownership.acquire(stalePersistLifecycle.sub);
    await stalePersistLifecycle.client.checkout({ profileId: "sub", authMode: "codex-subscription" });
    await unlink(stalePersistFixture.lockPath);
    let stalePersistCategory = "none";
    try {
      await stalePersistLifecycle.client.invoke("sub", async ({ env }) => {
        await writePrivateFile(join(env.CODEX_HOME, "auth.json"), refreshed);
      });
    } catch (error) { stalePersistCategory = category(error); }
    await stalePersistLifecycle.client.dispose().catch(() => undefined);

    const staleReleaseFixture = await makeSubscriptionFixture(runRoot, "stale-release");
    const staleReleaseLifecycle = await makeSubscriptionLifecycle(classes, staleReleaseFixture);
    const staleReleaseLease = await staleReleaseLifecycle.ownership.acquire(staleReleaseLifecycle.sub);
    await checkoutInvokeFinishSubscription(staleReleaseLifecycle);
    await unlink(staleReleaseFixture.lockPath);
    let staleReleaseCategory = "none";
    try { await staleReleaseLifecycle.ownership.release(staleReleaseLease, { confirmTermination: async () => "confirmed" }); }
    catch (error) { staleReleaseCategory = category(error); }

    const happy = {
      selectedEnvHadCodexHome: happyCapture.selectedEnvHadCodexHome === true,
      ambientOpenAiKeyStripped: happyCapture.ambientOpenAiKeyStripped === true,
      ambientCodexHomeStripped: happyCapture.ambientCodexHomeStripped === true,
      externalLoginRefreshed: happyExternalLoginRefreshed,
      finishRemovedTempAuthDir: happyTempRemoved,
      confirmedReleaseFreedLock: happyLease.status === "released" && happyLockGone,
      reacquireSawRefreshedLogin: reloaded.sessionData === refreshed,
    };
    const unknown = subscriptionUnknownProof({
      category: unknownCategory,
      heldBeforeRetry: unknownHeldBeforeRetry,
      busyCategory,
      releasedAfterRetry: unknownReleasedAfterRetry,
    });
    const stalePersist = {
      stalePersistRejected: stalePersistCategory === "credential_source_failed",
      stalePersistCategory,
      stalePersistExternalUnchanged: (await readFile(stalePersistFixture.authPath, "utf8")) !== refreshed,
      stalePersistClientStatus: stalePersistLifecycle.client.status("sub"),
    };
    const staleRelease = {
      staleReleaseRejected: staleReleaseCategory === "stale_owner",
      staleReleaseCategory,
      staleReleaseExternalStillRefreshed: (await readFile(staleReleaseFixture.authPath, "utf8")) === refreshed,
    };
    const ok = Object.values(happy).every(Boolean)
      && unknown.unknownTerminationCategory === "termination_unconfirmed"
      && unknown.unknownTerminationHeldLock
      && unknown.unknownTerminationBlocksOtherOwner
      && unknown.unknownRetryConfirmedReleased
      && stalePersist.stalePersistRejected
      && stalePersist.stalePersistExternalUnchanged
      && staleRelease.staleReleaseRejected
      && staleRelease.staleReleaseExternalStillRefreshed;
    return { name: "subscription-lifecycle-simulation", ok, happy, unknown, stalePersist, staleRelease };
  } finally {
    await rm(runRoot, { recursive: true, force: true }).catch(() => undefined);
  }
}

export async function runChatGptSignInScenario(root) {
  const [{ loadLocalAgentConfig, LocalSessionOwnership, createLocalCredentialPort }, { createModelAuthClient }] = await Promise.all([
    import(pathToFileURL(join(REPO_ROOT, "dist", "local", "agent-config.js")).href),
    import(pathToFileURL(join(REPO_ROOT, "dist", "model-auth-client.js")).href),
  ]);
  const runRoot = mkdtempSync(join(root, "chatgpt-sign-in-"));
  try {
    const fixture = await makeSubscriptionFixture(runRoot, "chatgpt");
    const now = Date.now();
    const oldRecord = {
      version: 1, email: "synthetic@example.invalid", issuer: "https://auth.openai.com", subject: "synthetic-subject",
      clientId: "synthetic-client", extAgentHostId: "synthetic-host", idToken: "synthetic-id-token", accessToken: "synthetic-old-access",
      refreshToken: "synthetic-old-refresh", tokenType: "Bearer", scopes: ["chatgpt.tokens.use.direct"],
      accessTokenExpiresAt: now + 60_000, earliestRefreshAt: null, savedAt: now - 3_000_000,
    };
    await writePrivateFile(fixture.authPath, JSON.stringify(oldRecord));
    const config = JSON.parse(await readFile(fixture.configPath, "utf8"));
    config.profiles[0].sessionSource = "chatgpt-sign-in";
    await writePrivateFile(fixture.configPath, JSON.stringify(config));
    const loaded = await loadLocalAgentConfig({ configPath: fixture.configPath, projectKey: "local-demo", forbiddenRoots: [fixture.repo] });
    const ownership = new LocalSessionOwnership({ forbiddenRoots: [fixture.repo] });
    // The fake token endpoint is injected in-process, so no network call is made.
    let fetchCalls = 0;
    const fakeFetch = async () => {
      fetchCalls += 1;
      return new Response(JSON.stringify({ access_token: "synthetic-new-access", refresh_token: "synthetic-new-refresh", expires_in: 3600 }), { status: 200 });
    };
    const port = createLocalCredentialPort({ references: loaded.references, forbiddenRoots: [fixture.repo], ownership, io: { fetch: fakeFetch } });
    const client = createModelAuthClient({
      source: { kind: "local", port },
      authRoot: fixture.authRoot,
      forbiddenRoots: [fixture.repo],
      inheritedEnv: { PATH: process.env.PATH ?? "/usr/bin" },
    });
    const lease = await ownership.acquire(loaded.references.get("sub"));
    const capture = {};
    await client.checkout({ profileId: "sub", authMode: "codex-subscription" });
    await client.invoke("sub", async ({ env }) => {
      capture.hasAccessToken = env.CHATGPT_PLAN_ACCESS_TOKEN === "synthetic-new-access";
      capture.leakedRefresh = Object.values(env).some((v) => typeof v === "string" && (v.includes("synthetic-new-refresh") || v.includes("synthetic-old-refresh") || v.includes("synthetic-id-token")));
      capture.noAuthJson = !(typeof env.CODEX_HOME === "string" && existsSync(join(env.CODEX_HOME, "auth.json")));
    });
    await client.finish("sub", "completed");
    await client.dispose();
    await ownership.release(lease, { confirmTermination: async () => "confirmed" });
    const saved = JSON.parse(await readFile(fixture.authPath, "utf8"));
    const checks = {
      containerEnvHasAccessToken: capture.hasAccessToken === true,
      containerEnvHasNoRefreshOrIdToken: capture.leakedRefresh === false,
      noAuthJson: capture.noAuthJson === true,
      refreshedOnce: fetchCalls === 1,
      recordRotatedOnHost: saved.refreshToken === "synthetic-new-refresh",
      leaseReleased: lease.status === "released",
    };
    return { name: "chatgpt-sign-in", ok: Object.values(checks).every(Boolean), checks };
  } finally {
    await rm(runRoot, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function runNetworkIsolationScenario({ root, imageId, providerScript }) {
  const peer = await createNetworkAndPeer({ root: join(root, "network-isolation"), imageId, providerScript, providerPort: DEFAULT_PROVIDER_PORT, bridgePort: DEFAULT_BRIDGE_PORT, bridgeTargetPort: DEFAULT_BRIDGE_PORT });
  try {
    const external = docker(["run", "--rm", "--network", peer.networkName, "--entrypoint", "node", imageId, "-e", "const c=new AbortController();setTimeout(()=>c.abort(),2500);fetch('https://api.openai.com/v1/models',{signal:c.signal}).then(()=>process.exit(42)).catch(()=>process.exit(0))"]);
    const host = docker(["run", "--rm", "--network", peer.networkName, "--add-host", `host.docker.internal:${peer.peerIp}`, "--entrypoint", "node", imageId, "-e", `const c=new AbortController();setTimeout(()=>c.abort(),2500);fetch('http://host.docker.internal:${DEFAULT_PROVIDER_PORT}/',{signal:c.signal}).then(()=>process.exit(0)).catch(()=>process.exit(43))`]);
    return { name: "network-isolation", ok: external.status === 0 && host.status === 0, externalStatus: external.status, hostStatus: host.status };
  } finally {
    await peer.cleanup();
  }
}

function inspectContainerNetworks(containerName) {
  const raw = requireOk(docker(["inspect", "--format", "{{json .NetworkSettings.Networks}}", containerName]), "failed to inspect runner networks").stdout.trim();
  const networks = JSON.parse(raw || "{}");
  return Object.keys(networks);
}

function safeInspectContainerNetworks(containerName) {
  try { return inspectContainerNetworks(containerName); } catch { return []; }
}

function containerStopped(containerName) {
  const result = docker(["inspect", "--format", "{{.State.Running}}", containerName]);
  return result.status === 0 && result.stdout.trim() === "false";
}

function providerHasAllStages(events) {
  const models = new Set(events.map((event) => event.model));
  return Object.values(SYNTHETIC_MODELS).every((model) => models.has(model));
}

async function waitForEvent(path, predicate, timeoutMs) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (existsSync(path)) {
      const events = readFileSync(path, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
      if (events.some(predicate)) return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return false;
}

function assertNoSensitiveProofLeak(entries) {
  const patterns = [
    /sk-local-feedback-/,
    /synthetic-ambient-openai-key/,
    /dev-placeholder-token/,
    /SESSION_TOKEN/,
    /MACHINE_NONCE/,
    /Authorization/i,
    /Bearer\s+[A-Za-z0-9._-]+/i,
  ];
  for (const entry of entries) {
    const text = entry.path ? (existsSync(entry.path) ? readFileSync(entry.path, "utf8") : "") : (entry.text ?? "");
    const hit = patterns.find((pattern) => pattern.test(text));
    if (hit) return { ok: false, source: entry.name ?? entry.path ?? "inline", pattern: String(hit) };
  }
  return { ok: true };
}

function parseFullLoopLine(runLog) {
  const match = runLog.match(/^\[dev:run\] full loop complete: classification=(\S+) .* review=(approved|unapproved)$/m);
  if (!match) return { classification: null, review: null };
  return { classification: match[1], review: match[2] };
}

export async function runScenarioFinally({ dispose, cleanup }) {
  let disposeError;
  try {
    await dispose?.();
  } catch (error) {
    disposeError = error;
  }
  await cleanup();
  if (disposeError) throw disposeError;
}

async function runCliScenario({ name, root, cliModule, imageId, providerScript, fixture, agent, failureMode = "none", cancelAfterMs }) {
  const scenarioRoot = join(root, name);
  await mkdir(scenarioRoot, { recursive: true, mode: 0o700 });
  const peer = await createNetworkAndPeer({ root: join(scenarioRoot, "provider"), imageId, providerScript, providerPort: DEFAULT_PROVIDER_PORT, bridgePort: DEFAULT_BRIDGE_PORT, bridgeTargetPort: DEFAULT_BRIDGE_PORT, failureMode });
  writeJson(join(scenarioRoot, "network.json"), { networkName: peer.networkName, peerName: peer.peerName, peerIp: peer.peerIp, providerAlias: PROVIDER_ALIAS, providerPort: peer.providerPort, bridgePort: peer.bridgePort });
  let exitCode = 1;
  let stdout = "";
  let stderr = "";
  let handle;
  let runnerNetworks = [];
  let runnerStopped = false;
  let disposeScenario;
  try {
    const localFeedback = buildLocalFeedbackOptions({ providerPort: DEFAULT_PROVIDER_PORT, bridgePort: DEFAULT_BRIDGE_PORT, networkName: peer.networkName, hostGateway: peer.peerIp });
    const harnessArtifacts = join(scenarioRoot, "artifacts");
    const { deps, out, err, abort, dispose, getHandle, getStopProof } = makeCliDeps({ cliModule, localFeedback, artifactsDir: harnessArtifacts, logsPath: join(scenarioRoot, "runner.log") });
    disposeScenario = dispose;
    let cancelDriver;
    if (cancelAfterMs) {
      cancelDriver = (async () => {
        const sawHang = await waitForEvent(peer.eventLog, (event) => event.outcome === "hang", Math.max(cancelAfterMs, 30_000));
        abort();
        return sawHang;
      })();
    }
    const cliPromise = cliModule.runDevHarnessCli(buildDevHarnessArgs({ workspace: fixture.workspace, task: fixture.task, imageId, agentConfig: agent.configPath }), deps);
    const watchdogDelay = delay(cancelAfterMs ? 90_000 : 600_000, 124);
    try {
      exitCode = await Promise.race([cliPromise, watchdogDelay.promise]);
    } finally {
      watchdogDelay.clear();
    }
    if (exitCode === 124) {
      abort();
      const grace = delay(20_000, 124);
      try { await Promise.race([cliPromise.catch(() => 124), grace.promise]); }
      finally { grace.clear(); }
    } else {
      await cliPromise.catch(() => undefined);
    }
    if (cancelDriver) await cancelDriver.catch(() => false);
    handle = getHandle();
    if (handle) {
      const stopProof = getStopProof();
      runnerNetworks = stopProof?.networks?.length ? stopProof.networks : safeInspectContainerNetworks(handle.containerName);
      runnerStopped = stopProof?.stopped ?? containerStopped(handle.containerName);
      if (!stopProof) await cliModule.stopDevRun(handle).catch(() => undefined);
    }
    stdout = out.join("");
    stderr = err.join("");
  } finally {
    await runScenarioFinally({ dispose: disposeScenario, cleanup: peer.cleanup });
  }
  const artifactWorkspace = join(scenarioRoot, "artifacts", "workspace");
  const messagePath = join(artifactWorkspace, "examples", "local-demo", "message.txt");
  const copiedMessage = existsSync(messagePath) ? readFileSync(messagePath, "utf8") : "";
  const changes = existsSync(join(scenarioRoot, "artifacts", "changes.diff")) ? readFileSync(join(scenarioRoot, "artifacts", "changes.diff"), "utf8") : "";
  const runLog = existsSync(join(scenarioRoot, "artifacts", "run.log")) ? readFileSync(join(scenarioRoot, "artifacts", "run.log"), "utf8") : "";
  const diffNames = existsSync(artifactWorkspace) ? run("git", ["diff", "--name-only"], { cwd: artifactWorkspace }).stdout.split("\n").filter(Boolean) : [];
  const fixtureClean = run("git", ["status", "--porcelain"], { cwd: fixture.workspace }).stdout.trim() === "";
  const events = existsSync(peer.eventLog) ? readFileSync(peer.eventLog, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line)) : [];
  const fullLoop = parseFullLoopLine(runLog);
  const secretScan = assertNoSensitiveProofLeak([
    { name: "provider-events", path: peer.eventLog },
    { name: "run.log", text: runLog },
    { name: "stdout", text: stdout },
    { name: "stderr", text: stderr },
  ]);
  const actualRunnerInternalOnly = runnerNetworks.length === 1 && runnerNetworks[0] === peer.networkName;
  const confirmedDeath = runnerStopped === true;
  const reviewApproved = fullLoop.review === "approved";
  const successClassification = fullLoop.classification === "success";
  const ok = name === "success"
    ? exitCode === 0 && copiedMessage === TARGET_TEXT && diffNames.length === 1 && diffNames[0] === "examples/local-demo/message.txt" && changes.includes("examples/local-demo/message.txt") && fixtureClean && providerHasAllStages(events) && reviewApproved && successClassification && actualRunnerInternalOnly && confirmedDeath && secretScan.ok
    : name === "provider500" ? exitCode !== 0 && events.some((event) => event.outcome === "synthetic_500") && actualRunnerInternalOnly && confirmedDeath && secretScan.ok
      : name === "cancel-hang" ? exitCode === 130 && events.some((event) => event.outcome === "hang") && actualRunnerInternalOnly && confirmedDeath && secretScan.ok
        : false;
  writeJson(join(scenarioRoot, "scenario.json"), { name, ok, exitCode, events, copiedMessage, diffNames, fixtureClean, runnerNetworks, confirmedDeath, fullLoop, secretScan, stdout, stderr });
  return { name, ok, exitCode, events: events.length, runnerNetworks, confirmedDeath, fullLoop, secretScan, stderr };
}

export async function pathAbsent(path, statFn = stat) {
  if (!path) return true;
  try {
    await statFn(path);
    return false;
  } catch (error) {
    return error?.code === "ENOENT";
  }
}

async function cleanupOwnedTemps({ privateRoot, workspaceRoot }) {
  await rm(privateRoot, { recursive: true, force: true }).catch(() => undefined);
  if (workspaceRoot) await rm(workspaceRoot, { recursive: true, force: true }).catch(() => undefined);
  return {
    privateRootRemoved: await pathAbsent(privateRoot),
    fixtureRootRemoved: workspaceRoot ? await pathAbsent(workspaceRoot) : true,
  };
}

async function runSyntheticGate(options) {
  ensureNode24();
  assertSafeEnvironment(process.env, "synthetic");
  dockerAvailable();
  const artifactsDir = makeTempRoot(PREFIX, options.artifactsDir);
  const privateRoot = makeTempRoot(`${PREFIX}-private`);
  let workspaceRoot;
  let cleanupState = { privateRootRemoved: false, fixtureRootRemoved: false };
  try {
    const source = resolveSourceIdentity(REPO_ROOT, run);
    writeJson(join(artifactsDir, "source.json"), { head: source.head, trackedDiffSha256: source.trackedDiffSha256, dirty: source.dirty, status: source.status });
    writeFileSync(join(artifactsDir, "tracked.diff"), source.trackedDiff, { mode: 0o600 });
    const image = options.image ? { imageId: options.image, tag: options.image, labels: inspectImageLabels(options.image, source), rebuilt: false } : buildImage({ source, rebuild: options.rebuild });
    const imageTools = inspectImageTools(image.imageId);
    writeJson(join(artifactsDir, "image.json"), { ...image, tools: imageTools });
    const providerScript = await copyProviderScript(privateRoot);
    writeJson(join(artifactsDir, "provider.json"), { source: "scripts/local-feedback-provider.mjs", sha256: sha256(readFileSync(PROVIDER_SOURCE)) });
    workspaceRoot = makeTempRoot(`${PREFIX}-fixture`);
    const fixture = await createSyntheticWorkspace(workspaceRoot);
    const agent = buildSyntheticAgentConfig({ root: join(privateRoot, "agent-config") });
    writeJson(join(artifactsDir, "agent-config.redacted.json"), { stages: summarizeStages(agent.config), profileIds: agent.profileIds });
    const cliModule = await importBuiltHarness();

    const scenarios = [];
    scenarios.push(await runEnvCollisionScenario());
    scenarios.push(await runInvalidConfigScenario({ root: artifactsDir, cliModule, imageId: image.imageId, fixture }));
    scenarios.push(await runNodePreloadScenario());
    scenarios.push(await runSubscriptionLifecycleSimulation(privateRoot));
    scenarios.push(await runChatGptSignInScenario(privateRoot));
    scenarios.push(await runCliScenario({ name: "provider500", root: artifactsDir, cliModule, imageId: image.imageId, providerScript, fixture, agent, failureMode: "500" }));
    scenarios.push(await runCliScenario({ name: "cancel-hang", root: artifactsDir, cliModule, imageId: image.imageId, providerScript, fixture, agent, failureMode: "hang", cancelAfterMs: 5000 }));
    const success = await runCliScenario({ name: "success", root: artifactsDir, cliModule, imageId: image.imageId, providerScript, fixture, agent });
    scenarios.push(success);
    const network = await runNetworkIsolationScenario({ root: artifactsDir, imageId: image.imageId, providerScript }).catch((error) => ({ name: "network-isolation", ok: false, error: error.message }));
    scenarios.push(network);

    const ok = scenarios.every((s) => s.ok);
    writeJson(join(artifactsDir, "result.json"), { ok, scenarios });
    writeFileSync(join(artifactsDir, "summary.md"), summarizeResult({ ok, mode: "synthetic", source, image, artifactsDir, stages: summarizeStages(agent.config), note: `Scenarios: ${scenarios.map((s) => `${s.name}=${s.ok ? "ok" : "fail"}`).join(", ")}` }), { mode: 0o600 });
    if (!ok) throw fail(`synthetic local feedback failed; see ${artifactsDir}`);
    return { ok, artifactsDir, source, image, scenarios, cleanupState };
  } finally {
    cleanupState = await cleanupOwnedTemps({ privateRoot, workspaceRoot });
    writeJson(join(artifactsDir, "cleanup.json"), { ownedPrefix: PREFIX, ...cleanupState });
    if (!cleanupState.privateRootRemoved || !cleanupState.fixtureRootRemoved) {
      throw fail(`local feedback cleanup could not confirm removal of owned temp roots; see ${artifactsDir}`);
    }
  }
}

function loadPreviousGate(repoRoot = REPO_ROOT) {
  const marker = gateMarkerPath(repoRoot);
  if (!existsSync(marker)) return null;
  try { return JSON.parse(readFileSync(marker, "utf8")); } catch { return null; }
}

function safeRealpath(path) {
  try { return realpathSync(path); } catch { return resolve(path); }
}

export function parseGitHubProjectKey(origin) {
  const trimmed = String(origin ?? "").trim();
  const scp = trimmed.match(/^git@github\.com:([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+?)(?:\.git)?$/);
  if (scp) return `${scp[1]}/${scp[2]}`;
  let url;
  try { url = new URL(trimmed); } catch { return null; }
  if (url.hostname !== "github.com") return null;
  if (url.protocol !== "https:" && url.protocol !== "ssh:" && url.protocol !== "git:") return null;
  const parts = url.pathname.replace(/^\/+/, "").replace(/\.git$/, "").split("/");
  if (parts.length !== 2) return null;
  const [owner, repo] = parts;
  if (!/^[A-Za-z0-9-]+$/.test(owner) || !/^[A-Za-z0-9._-]+$/.test(repo)) return null;
  return `${owner}/${repo}`;
}

function detectProjectKey(workspace) {
  const url = run("git", ["config", "--get", "remote.origin.url"], { cwd: workspace }).stdout.trim();
  const projectKey = parseGitHubProjectKey(url);
  if (!projectKey) throw fail("--live workspace must have a GitHub origin so the local agent config can be resolved against the project key");
  return projectKey;
}

export function assertLiveReferencesOutsideActiveAuth(references) {
  const home = process.env.HOME ? join(process.env.HOME, ".codex", "auth.json") : undefined;
  const codexHome = process.env.CODEX_HOME ? join(process.env.CODEX_HOME, "auth.json") : undefined;
  const active = [home, codexHome].filter(Boolean).map((p) => safeRealpath(p));
  if (active.length === 0) return;
  for (const reference of references.values()) {
    if (active.includes(safeRealpath(reference.canonicalPath))) {
      throw fail(`--live agent config profile ${reference.profileId} points at active app auth; use a dedicated local feedback profile`);
    }
  }
}

function summarizeResolvedStages(loaded) {
  if (loaded.resolution.mode !== "configured") return { mode: loaded.resolution.mode };
  return Object.fromEntries(Object.entries(loaded.resolution.stages).map(([stage, selected]) => {
    const reference = loaded.references.get(selected.accountProfileId);
    return [stage, {
      agent: selected.agent,
      provider: selected.provider,
      model: selected.model,
      profileId: selected.accountProfileId,
      authMode: reference?.authMode,
      invocationTimeoutMs: selected.invocationTimeoutMs,
    }];
  }));
}

/** Final live evidence: result.json plus a summary that replaces the preflight one with the finished run's outcome. */
export function writeLiveResult({ artifactsDir, exitCode, source, image, stages }) {
  writeJson(join(artifactsDir, "result.json"), { exitCode, live: true });
  const note = `Live production full loop finished with exit code ${exitCode}; runner.log and run/ hold the stage outcomes.`;
  writeFileSync(join(artifactsDir, "summary.md"), summarizeResult({ ok: exitCode === 0, mode: "live", source, image, artifactsDir, stages, note }), { mode: 0o600 });
}

/**
 * Runs the live harness and always records its result. The harness's own error outranks a dispose
 * or result-write failure, so a broken summary write never hides why the run failed.
 */
export async function finishLiveRun({ runHarness, dispose, writeResult }) {
  let exitCode = 1;
  let harnessError;
  try {
    exitCode = await runHarness();
  } catch (error) {
    harnessError = error;
  }
  try {
    dispose();
  } catch (error) {
    harnessError ??= error;
  }
  try {
    writeResult(exitCode);
  } catch (error) {
    if (!harnessError) throw error;
    console.error(`[local:feedback] could not record the live result: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (harnessError) throw harnessError;
  return exitCode;
}

async function runLive(options) {
  ensureNode24();
  dockerAvailable();
  const source = resolveSourceIdentity(REPO_ROOT, run);
  const prior = loadPreviousGate(REPO_ROOT);
  if (!prior || prior.version !== 1 || prior.ok !== true || prior.head !== source.head || prior.trackedDiffSha256 !== source.trackedDiffSha256 || !prior.imageId) {
    throw fail("--live requires a prior successful synthetic gate for the same source identity and image");
  }
  const agentConfig = resolve(options.agentConfig);
  const workspace = resolve(options.workspace);
  const task = resolve(options.task);
  const artifactsDir = makeTempRoot(PREFIX, options.artifactsDir);
  if (options.image && options.image !== prior.imageId) throw fail("--live --image must match the prior synthetic-gated image");
  inspectImageLabels(prior.imageId, source);
  inspectImageTools(prior.imageId);
  const projectKey = detectProjectKey(workspace);
  const cliModule = await importBuiltHarness();
  const { loadLocalAgentConfig } = await import(`${pathToFileURL(join(REPO_ROOT, "dist", "local", "agent-config.js")).href}?localFeedback=${Date.now()}`);
  const loaded = await loadLocalAgentConfig({ configPath: agentConfig, projectKey, forbiddenRoots: [workspace, artifactsDir, REPO_ROOT] });
  if (loaded.resolution.mode !== "configured") throw fail("--live requires a configured local agent config; legacy mode would fall back to ambient credentials");
  assertLiveReferencesOutsideActiveAuth(loaded.references);
  const stages = summarizeResolvedStages(loaded);
  writeFileSync(join(artifactsDir, "summary.md"), summarizeResult({ ok: false, mode: "live-preflight", source, image: prior.imageId, artifactsDir, stages, note: "Live run manually requested; launching production full loop using the prior synthetic-gated runner image." }), { mode: 0o600 });
  console.error("[local:feedback] live stage selections:");
  console.error(JSON.stringify(stages, null, 2));
  const { deps, dispose } = makeCliDeps({ cliModule, artifactsDir: join(artifactsDir, "run"), logsPath: join(artifactsDir, "runner.log") });
  const imageId = options.image ?? prior.imageId;
  const exitCode = await finishLiveRun({
    runHarness: () => cliModule.runDevHarnessCli(buildDevHarnessArgs({ workspace, task, imageId, agentConfig }), deps),
    dispose,
    // A harness that throws still leaves a failure summary rather than the preflight one.
    writeResult: (code) => writeLiveResult({ artifactsDir, exitCode: code, source, image: imageId, stages }),
  });
  return { ok: exitCode === 0, exitCode, artifactsDir };
}

export async function main(argv = process.argv.slice(2)) {
  try {
    const args = parseArgs(argv);
    if (args.live) return (await runLive(args)).ok ? 0 : 1;
    const result = await runSyntheticGate(args);
    const marker = gateMarkerPath(REPO_ROOT);
    writeJson(marker, { version: 1, ok: true, head: result.source.head, trackedDiffSha256: result.source.trackedDiffSha256, imageId: result.image.imageId, scenarios: result.scenarios.map((s) => s.name), at: new Date().toISOString(), artifactsDir: result.artifactsDir });
    console.error(`[local:feedback] synthetic gate passed: ${result.artifactsDir}`);
    return 0;
  } catch (error) {
    console.error(`[local:feedback] ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().then((code) => process.exit(code));
}
