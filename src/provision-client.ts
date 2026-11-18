/**
 * Sets up a self-hosted orchestrator in the operator's own Fly organization, and re-runs to change
 * its secrets or add target repositories.
 *
 *   npm run provision-client -- <slug>
 *
 * Every answer is judged by the orchestrator's own environment checks before anything is written.
 * Secrets reach Fly only through `flyctl secrets import` on stdin, and none is shown except the
 * break-glass access code, once. The one secret passed as an argument is the knowledge-graph build
 * token: flyctl takes a build secret only as a NAME=VALUE argument, so the token is minted as
 * self-deploy mints it, read-only for that one repository, and expires within the hour. What a
 * tool prints is shown with every secret this run holds redacted.
 */

import { parse, stringify } from "smol-toml";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname } from "node:path";
import { createInterface, emitKeypressEvents } from "node:readline";
import { allowlistFromEnv, parseAccessEntries } from "./access-entries.js";
import { formatCheckRow } from "./check-setup.js";
import { parseKgSourceRepo } from "./deploy.js";
import { getScopedInstallationToken } from "./github-app-auth.js";
import { redactEvidence } from "./pipeline/failure-classification.js";
import { REPO_SHORTHAND } from "./reference-repos.js";
import type { SetupCheckContext, SetupCheckOutcome, SetupCheckResult } from "./setup-checks/index.js";
import { ORCHESTRATOR_CONFIG_CHECKS } from "./setup-checks/orchestrator-config.js";

export interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

export type HealthProbe =
  | { kind: "serving" }
  | { kind: "starting"; sidecar: string; registration: string }
  | { kind: "not-answering" };

/** Reads health defensively: only a 200 serves, and a structured 503 identifies Restate startup. */
export async function probeHealth(url: string): Promise<HealthProbe> {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    if (response.status === 200) return { kind: "serving" };
    if (response.status === 503) {
      const body = await response.json();
      const sidecar: unknown = body?.restate?.sidecar?.state;
      const registration: unknown = body?.restate?.registration?.state;
      if (typeof sidecar === "string" && typeof registration === "string") {
        return { kind: "starting", sidecar, registration };
      }
    }
  } catch {
    // Fetch, timeout and malformed-body failures all remain retryable.
  }
  return { kind: "not-answering" };
}

export interface ProvisionDependencies {
  /** Asks one question. A hidden prompt never echoes what is typed. */
  prompt: (label: string, hidden: boolean) => Promise<string>;
  /** A file's text, or null when it does not exist. */
  readFile: (path: string) => Promise<string | null>;
  writeFile: (path: string, content: string) => Promise<void>;
  /** Runs a tool with no shell, handing its output to `onOutput` as it arrives. A tool that cannot start resolves with code 1. */
  run: (tool: string, args: string[], stdin?: string, onOutput?: (text: string) => void) => Promise<CommandResult>;
  /** A read-only token for one knowledge-graph repository, minted with the GitHub App. */
  kgToken: (appId: string, privateKey: string, owner: string, repo: string) => Promise<string>;
  generateSecret: () => string;
  /** Whether the orchestrator serves, is starting Restate, or is not answering. */
  probeHealth: (url: string) => Promise<HealthProbe>;
  homeDir: () => string;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  writeStdout: (text: string) => void;
  writeStderr: (text: string) => void;
}

const DEFAULT_DEPENDENCIES: ProvisionDependencies = {
  prompt: (label, hidden) => (hidden ? promptHidden(label) : promptVisible(label)),
  readFile: async (path) => {
    try {
      return await readFile(path, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw err;
    }
  },
  writeFile: async (path, content) => {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, content, { mode: 0o600 });
  },
  run: (tool, args, stdin, onOutput) =>
    new Promise((resolve) => {
      const child = spawn(tool, args, { stdio: ["pipe", "pipe", "pipe"] });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk) => {
        stdout += chunk;
        onOutput?.(String(chunk));
      });
      child.stderr.on("data", (chunk) => {
        stderr += chunk;
        onOutput?.(String(chunk));
      });
      child.on("error", () => resolve({ code: 1, stdout: "", stderr: "" }));
      child.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
      child.stdin.on("error", () => {});
      child.stdin.end(stdin);
    }),
  kgToken: async (appId, privateKey, owner, repo) =>
    (await getScopedInstallationToken(appId, privateKey, owner, { permissions: { contents: "read" }, repositories: [repo] })).token,
  generateSecret: () => randomBytes(32).toString("hex"),
  probeHealth,
  homeDir: homedir,
  now: Date.now,
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  writeStdout: (text) => process.stdout.write(text),
  writeStderr: (text) => process.stderr.write(text),
};

/** How long input already waiting is read and dropped before a question appears. */
const TYPEAHEAD_WINDOW_MS = 50;

/** Drops whatever was typed while the command was busy, so a key pressed during a wait never answers the next question. */
async function discardTypeahead(): Promise<void> {
  if (!process.stdin.isTTY) return;
  const drop = () => {};
  process.stdin.setRawMode(true);
  process.stdin.on("data", drop);
  process.stdin.resume();
  await new Promise((resolve) => setTimeout(resolve, TYPEAHEAD_WINDOW_MS));
  process.stdin.off("data", drop);
  process.stdin.pause();
  process.stdin.setRawMode(false);
}

async function promptVisible(label: string): Promise<string> {
  await discardTypeahead();
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await new Promise((resolve) => rl.question(`${label}: `, resolve));
  } finally {
    rl.close();
  }
}

/** Reads a line in raw mode without echoing it, so a secret never appears on screen or in scrollback. */
async function promptHidden(label: string): Promise<string> {
  if (!process.stdin.isTTY) throw new ProvisionError("Secrets are read from a terminal. Run the command in one.");
  await discardTypeahead();
  process.stdout.write(`${label}: `);
  emitKeypressEvents(process.stdin);
  process.stdin.setRawMode(true);
  process.stdin.resume();
  return new Promise((resolve, reject) => {
    let value = "";
    const finish = () => {
      process.stdin.off("keypress", onKey);
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdout.write("\n");
    };
    const onKey = (text: string | undefined, key: { name?: string; ctrl?: boolean }) => {
      if (key.ctrl && key.name === "c") {
        finish();
        reject(new ProvisionError("Cancelled."));
      } else if (key.name === "return" || key.name === "enter") {
        finish();
        resolve(value);
      } else if (key.name === "backspace") value = value.slice(0, -1);
      else if (text && !key.ctrl) value += text;
    };
    process.stdin.on("keypress", onKey);
  });
}

const USAGE = "Usage: npm run provision-client -- <slug>, where the slug uses lowercase letters, digits and hyphens, with no hyphen at either end.";
const SLUG = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;
const FLY_NAME = /^[a-zA-Z0-9][a-zA-Z0-9-]*$/;
const DOCS_URL = "https://docs.builddown.ai/latest/setup/deploy";
/** Adding a project, and choosing how it reaches a model, which is set per project once the orchestrator runs. */
const PROJECT_DOCS_URL = "https://docs.builddown.ai/latest/setup/target-repo";
export const HEALTH_WAIT_MS = 15 * 60_000;
const HEALTH_RETRY_MS = 5_000;
const HEALTH_PROGRESS_MS = 60_000;
const CHECK_SETUP_COMMAND = "node /app/dist/check-setup.js";

/** A failure whose message is safe to show. Any other error may carry a secret from a tool or a parser, so it is never shown. */
class ProvisionError extends Error {}

// --- checking the answers ---

/** The checks that read only the environment, so they can judge the answers before the orchestrator exists. */
export const PROVISION_ENV_CHECKS = ORCHESTRATOR_CONFIG_CHECKS.filter(
  (check) => check.id.startsWith("env.") || check.id.startsWith("admin.") || check.id === "callback.config",
);

/** Values that pass a check's format rules, standing in for secrets kept on Fly, whose values cannot be read. */
const KEPT_STAND_INS: Record<string, string> = {
  OAUTH_ALLOWED_EMAILS: "kept@example.com",
  BUILDDOWN_OIDC_ISSUER: "https://kept.example.com",
};

/** The variable each check judges on its own. A check of a kept one is left to the remote checks. */
const JUDGED_VARIABLE: Record<string, string> = {
  "env.runner-mode": "RUNNER_MODE",
  "env.poll-interval": "POLL_INTERVAL_MS",
  "env.breaker-threshold": "DISPATCH_BREAKER_THRESHOLD",
  // A new key is still parsed when only the App ID is kept.
  "env.github-app": "GITHUB_APP_PRIVATE_KEY",
};

/** Only the environment exists before the deploy. Anything else a check could read is this machine's own state, so it throws. */
function envOnlyContext(env: Record<string, string>): SetupCheckContext {
  const unavailable = (): never => {
    throw new Error("Only the environment can be read before the orchestrator is deployed");
  };
  return {
    env,
    readSetting: unavailable,
    orchestratorDefaults: unavailable,
    projectStageConfig: unavailable,
    runnerMode: unavailable,
    flySessions: unavailable,
    runnerBackendSource: unavailable,
    mappings: unavailable,
    storedAccessEntries: unavailable,
    effectiveAllowlist: () => ({ entries: allowlistFromEnv(env), source: "env" }),
    allowlistReadAvailable: () => true,
    restateStatus: unavailable,
    databasePath: unavailable,
    onSeparateFilesystem: unavailable,
    trackerProvider: unavailable,
    trackerSetupFacts: unavailable,
  };
}

export type PreflightRow = SetupCheckOutcome & Pick<SetupCheckResult, "id" | "title">;

/**
 * Runs the environment checks over the environment about to be set. Each kept secret has a stand-in
 * that passes its format rules, so a failure here is certain, while a pass that rests on a kept value
 * is confirmed only by the remote checks after the deploy.
 */
export async function provisionPreflight(env: Record<string, string>, kept: ReadonlySet<string> = new Set()): Promise<PreflightRow[]> {
  const judged = { ...env };
  for (const key of kept) judged[key] = KEPT_STAND_INS[key] ?? "kept";
  const context = envOnlyContext(judged);
  const rows: PreflightRow[] = [];
  for (const check of PROVISION_ENV_CHECKS) {
    const own = JUDGED_VARIABLE[check.id];
    if (own && kept.has(own)) continue;
    for (const outcome of await check.run(context)) rows.push({ id: check.id, title: check.title, ...outcome });
  }
  return rows;
}

// --- prompts and shell text ---

/** A wrong answer is asked again this many times in all, then the run stops, so a script answering wrongly cannot loop forever. */
const MAX_TRIES = 3;

/** Reads an answer until `reason` finds none to refuse it, saying each reason it finds. */
async function untilValid(
  read: () => Promise<string>,
  reason: (answer: string) => string | null | Promise<string | null>,
  say: (line: string) => void,
): Promise<string> {
  for (let tries = 1; ; tries++) {
    const answer = await read();
    const refused = await reason(answer);
    if (refused === null) return answer;
    if (tries === MAX_TRIES) throw new ProvisionError(refused);
    say(refused);
  }
}

export interface Io {
  say: (line: string) => void;
  /** Opens a section of steps: a blank line, then its title underlined. */
  heading: (title: string) => void;
  /** Opens a group of questions or steps, held until the group shows anything else, so a group a rerun keeps whole prints nothing. */
  group: (title: string, ...intro: string[]) => void;
  /** Says what comes next is for, after a blank line and indented, so each entry stands apart. */
  explain: (...lines: string[]) => void;
  /** Shows a value to copy on a line of its own, set apart by a blank line. */
  copyable: (...lines: string[]) => void;
  /** Asks a visible question, trimmed, offering a default taken on an empty answer. */
  ask: (label: string, fallback?: string) => Promise<string>;
  /** Asks until `reason` finds none to refuse the answer. */
  askUntil: (label: string, reason: (answer: string) => string | null | Promise<string | null>, fallback?: string) => Promise<string>;
  /** One of `options`, lowercased. */
  choose: <T extends string>(label: string, options: readonly T[], fallback: T) => Promise<T>;
  confirm: (question: string, byDefault?: boolean) => Promise<boolean>;
}

export function makeIo(deps: ProvisionDependencies): Io {
  const write = (line: string) => deps.writeStdout(`${line}\n`);
  // An open group's heading and intro, not yet shown.
  let held: string[] = [];
  const flush = () => {
    for (const line of held) write(line);
    held = [];
  };
  const say = (line: string) => {
    flush();
    write(line);
  };
  const headingLines = (title: string) => ["", title, "-".repeat(title.length)];
  const ask = async (label: string, fallback = "") => {
    flush();
    return (await deps.prompt(fallback ? `${label} [${fallback}]` : label, false)).trim() || fallback;
  };
  const askUntil: Io["askUntil"] = (label, reason, fallback) => untilValid(() => ask(label, fallback), reason, say);
  return {
    say,
    heading: (title) => {
      // A held group that showed nothing is dropped.
      held = [];
      for (const line of headingLines(title)) write(line);
    },
    group: (title, ...intro) => {
      held = [...headingLines(title), ...(intro.length > 0 ? ["", ...intro.map((line) => `  ${line}`)] : [])];
    },
    explain: (...lines) => {
      say("");
      for (const line of lines) say(`  ${line}`);
    },
    copyable: (...lines) => {
      say("");
      for (const line of lines) say(`    ${line}`);
    },
    ask,
    askUntil,
    choose: async (label, options, fallback) => {
      const isOption = (answer: string) => options.some((option) => option === answer.toLowerCase());
      const answer = await askUntil(`${label}: ${options.join(" or ")}`, (a) => (isOption(a) ? null : `Choose ${options.join(" or ")}.`), fallback);
      return options.find((option) => option === answer.toLowerCase())!;
    },
    confirm: async (question, byDefault = false) => {
      const answer = await ask(`${question} [${byDefault ? "Y/n" : "y/N"}]`);
      return answer ? /^(y|yes)$/i.test(answer) : byDefault;
    },
  };
}

/** Quotes a value for a POSIX shell, for the commands printed for the operator to run. */
function shellWord(value: string): string {
  return /^[A-Za-z0-9_./:=@,+-]+$/.test(value) ? value : `'${value.replaceAll("'", `'\\''`)}'`;
}

/** A path with a leading `~` read as the home directory, as a shell would read it. */
function expandHome(path: string, home: string): string {
  return path === "~" || path.startsWith("~/") ? home + path.slice(1) : path;
}

/** The repository a GitHub origin URL names, scp-style or as a URL, or null for any other remote. */
function repoFromOrigin(remote: string): string | null {
  let path = remote.match(/^git@github\.com:(\S+)$/)?.[1];
  if (!path) {
    try {
      const url = new URL(remote);
      if (url.hostname !== "github.com" || !["https:", "ssh:", "git+ssh:"].includes(url.protocol) || url.search || url.hash) return null;
      path = url.pathname.slice(1);
    } catch {
      return null;
    }
  }
  const repo = path.replace(/\.git$/, "");
  return REPO_SHORTHAND.test(repo) ? repo : null;
}

function printIntro(io: Io): void {
  io.say("Set up a self-hosted AI-Implement orchestrator on Fly.io");
  io.explain(
    "This command asks for each value the orchestrator needs and checks your answers as you go.",
    "Then it creates the Fly apps, sets their secrets, deploys this checkout and runs the orchestrator's setup checks.",
    "Nothing changes on Fly until every answer passes, so Ctrl-C at any question leaves everything as it was.",
    "Press Enter to accept the value shown in [brackets].",
    "If this is your first orchestrator, keep the step-by-step guide open beside the command. It shows where to get each value:",
  );
  io.copyable(DOCS_URL);
}

// --- the client file ---

/** Values the command keeps in the client file's `[answers]` table so a rerun need not ask them. None is secret. */
interface Remembered {
  appId?: string;
  pemPath?: string;
  redirectBase?: string;
  callbackBase?: string;
  /** Built into the image rather than kept on Fly, so this is the only record a rerun can offer. */
  kgRepo?: string;
}

interface ClientFile {
  path: string;
  /** The file as read, or null for a new client. */
  text: string | null;
  /** The file's own tables, written for a new client. */
  config: Record<string, unknown>;
  app: string;
  org: string;
  region: string;
  sessionsApp: string;
  sessionsOrg: string;
  sessionsRegion: string;
  remembered: Remembered;
}

function flyName(value: unknown): string {
  if (typeof value !== "string" || !FLY_NAME.test(value)) {
    throw new ProvisionError("Each app, organization and region in the client file must be a name of letters, digits and hyphens.");
  }
  return value;
}

function rememberedFrom(table: unknown): Remembered {
  const values = (table ?? {}) as Record<string, unknown>;
  const text = (key: string) => (typeof values[key] === "string" && values[key] ? (values[key] as string) : undefined);
  return {
    appId: text("app_id"),
    pemPath: text("private_key_path"),
    redirectBase: text("redirect_base_url"),
    callbackBase: text("callback_base_url"),
    kgRepo: text("kg_source_repo"),
  };
}

/**
 * The client file's text with its `[answers]` table set to `remembered`. The command keeps that table
 * last, so everything above it, an operator's comments included, is kept as written.
 */
function withRemembered(text: string, remembered: Remembered): string {
  const at = text.search(/^\[answers\]/m);
  const above = (at === -1 ? text : text.slice(0, at)).trimEnd();
  const table: Record<string, string> = {};
  if (remembered.appId) table.app_id = remembered.appId;
  if (remembered.pemPath) table.private_key_path = remembered.pemPath;
  if (remembered.redirectBase) table.redirect_base_url = remembered.redirectBase;
  if (remembered.callbackBase) table.callback_base_url = remembered.callbackBase;
  if (remembered.kgRepo) table.kg_source_repo = remembered.kgRepo;
  if (Object.keys(table).length === 0) return at === -1 ? text : `${above}\n`;
  return `${above}\n\n${stringify({ answers: table })}`;
}

/** Reads `clients/<slug>.toml`, or asks for a new one's values, written only once the answers pass. */
async function readClientFile(deps: ProvisionDependencies, io: Io, slug: string): Promise<ClientFile> {
  const path = `clients/${slug}.toml`;
  const text = await deps.readFile(path);
  let config: Record<string, unknown>;
  if (text === null) {
    io.heading("Fly apps");
    io.explain(
      "The orchestrator runs as its own Fly app.",
      `Its name, and the sessions app's below, are saved in ${path}, and running the command again with the same name changes this orchestrator.`,
    );
    const askName = (label: string, fallback: string) =>
      io.askUntil(label, (name) => (FLY_NAME.test(name) ? null : `${label} must be a name of letters, digits and hyphens.`), fallback);
    const app = await askName("Fly app", `ai-implement-${slug}`);
    io.explain("Your Fly organization's slug, as flyctl orgs list shows it.");
    const org = await askName("Fly organization", "personal");
    io.explain("A Fly region code, as flyctl platform regions lists them.", "For example: iad, lhr, syd");
    const region = await askName("Primary region", "iad");
    io.explain(
      "A second Fly app, the sessions app, lets projects run their jobs on Fly Machines. It stays empty until a project does.",
      "Its organization and region default to the orchestrator's.",
    );
    const sessions = {
      app_name: await askName("Sessions app", `ai-implement-sessions-${slug}`),
      org: await askName("Sessions organization", org),
      region: await askName("Sessions region", region),
    };
    config = { client: { slug }, fly: { app_name: app, org, region }, sessions };
  } else {
    try {
      config = parse(text);
    } catch {
      throw new ProvisionError(`${path} is not valid TOML.`);
    }
  }
  const fly = (config.fly ?? {}) as Record<string, unknown>;
  const sessions = (config.sessions ?? {}) as Record<string, unknown>;
  const org = flyName(fly.org);
  const region = flyName(fly.region);
  return {
    path,
    text,
    config,
    app: flyName(fly.app_name),
    org,
    region,
    sessionsApp: flyName(sessions.app_name ?? `ai-implement-sessions-${slug}`),
    sessionsOrg: flyName(sessions.org ?? org),
    sessionsRegion: flyName(sessions.region ?? region),
    remembered: rememberedFrom(config.answers),
  };
}

// --- reading Fly ---

/** Runs flyctl and returns its stdout. A failure names only the subcommand, since its output may carry a secret. */
async function fly(deps: ProvisionDependencies, args: string[], stdin?: string): Promise<string> {
  const result = await deps.run("flyctl", args, stdin);
  if (result.code !== 0) throw new ProvisionError(`flyctl ${args.slice(0, 2).join(" ")} failed. Check that flyctl is installed and signed in.`);
  return result.stdout;
}

/** A flyctl `--json` listing, each entry checked for the fields read from it. Never the table output, whose layout changes. */
async function flyListing(deps: ProvisionDependencies, args: string[], fields: string[]): Promise<Record<string, unknown>[]> {
  let entries: unknown;
  try {
    entries = JSON.parse(await fly(deps, args));
  } catch (err) {
    if (err instanceof ProvisionError) throw err;
    throw new ProvisionError(`flyctl ${args.slice(0, 2).join(" ")} did not return JSON.`);
  }
  const valid = (entry: unknown): entry is Record<string, unknown> =>
    typeof entry === "object" && entry !== null && fields.every((field) => typeof (entry as Record<string, unknown>)[field] === "string");
  if (!Array.isArray(entries) || !entries.every(valid)) throw new ProvisionError(`flyctl ${args.slice(0, 2).join(" ")} returned an unexpected listing.`);
  return entries;
}

interface FlyState {
  apps: Set<string>;
  /** The secrets the orchestrator's app already holds. Fly lists their names, never their values. */
  secretNames: Set<string>;
  /** Whether the orchestrator's app has been deployed, so it has booted at least once. */
  released: boolean;
}

async function listApps(deps: ProvisionDependencies): Promise<Set<string>> {
  return new Set((await flyListing(deps, ["apps", "list", "--json"], ["Name"])).map((entry) => entry.Name as string));
}

async function listSecretNames(deps: ProvisionDependencies, app: string): Promise<Set<string>> {
  return new Set((await flyListing(deps, ["secrets", "list", "--app", app, "--json"], ["name"])).map((entry) => entry.name as string));
}

async function hasRelease(deps: ProvisionDependencies, app: string): Promise<boolean> {
  return (await flyListing(deps, ["releases", "--app", app, "--json"], [])).length > 0;
}

// --- collecting the answers ---

type FlyTokenKey = "FLY_DEPLOY_TOKEN" | "FLY_SESSIONS_TOKEN";

/** Everything answered, derived or generated, before anything is written. */
interface Answers {
  /** Each variable to set. A value kept as it is on Fly is absent. */
  env: Record<string, string>;
  /** The variables in `env` whose values are secret, which are redacted from anything shown. */
  secretKeys: Set<string>;
  /** Values already on Fly that are kept. */
  kept: Set<string>;
  provider: "google" | "microsoft";
  subscription: boolean;
  kgRepo: string;
  /** The .pem path given this run, for the printed repository commands. */
  pemPath: string;
  /** Deploy tokens to mint once the apps exist, each with the app it is scoped to. */
  tokensToMint: Map<FlyTokenKey, string>;
  /** Whether the orchestrator already took its sessions app from `FLY_SESSIONS_APP` (seed-once). */
  sessionsSeeded: boolean;
  /** On a re-run, whether every value already on Fly is kept unasked, so only what is missing is asked. */
  keepAll: boolean;
  repos: string[];
}

function setValue(answers: Answers, key: string, value: string, secret: boolean): void {
  // flyctl secrets import reads one NAME=VALUE line per variable, so a line break would start another.
  if (/[\r\n\0]/.test(value)) throw new ProvisionError(`${key} must be a single line.`);
  answers.env[key] = value;
  answers.kept.delete(key);
  if (secret) answers.secretKeys.add(key);
}

/** The values of every secret this run holds, longest first, so a secret containing another is redacted whole. */
function secretValues(answers: Answers, extra: string[] = []): string[] {
  return [...[...answers.secretKeys].map((key) => answers.env[key]!), ...extra].filter(Boolean).sort((a, b) => b.length - a.length);
}

interface AskOptions {
  /** What the value is for and where to find it, shown before the question. */
  about: string;
  /** A value in the shape expected, for one with a known format. */
  example?: string;
  secret?: boolean;
  required?: boolean;
  /** The value an empty answer takes when nothing is set yet. */
  derived?: string;
  /** Why a nonempty answer is refused, or null. */
  reason?: (answer: string) => string | null;
}

/**
 * Asks for one variable, with hidden input when it is secret, until no reason refuses the answer. An
 * empty answer keeps a value already on Fly or answered earlier this run, takes the derived value
 * when there is one, and is refused for a required one otherwise.
 */
async function ask(
  deps: ProvisionDependencies,
  io: Io,
  answers: Answers,
  key: string,
  { about, example, secret = true, required = true, derived = "", reason }: AskOptions,
): Promise<void> {
  const onFly = answers.kept.has(key);
  if (answers.keepAll && (onFly || !required)) return;
  const earlier = answers.env[key];
  const keepable = onFly || earlier !== undefined;
  io.explain(about, ...(example ? [`For example: ${example}`] : []));
  // The label says what Enter does with this variable.
  let note = required ? "required" : "optional";
  if (onFly) note = "already set, Enter to keep";
  else if (earlier !== undefined) note = secret ? "Enter to keep your earlier answer" : earlier;
  else if (derived) note = derived;
  const answer = await untilValid(
    async () => (await deps.prompt(`${key} [${note}]`, secret)).trim(),
    (value) => {
      if (!value) return required && !keepable && !derived ? `${key} is required.` : null;
      if (/[\r\n\0]/.test(value)) return `${key} must be a single line.`;
      return reason?.(value) ?? null;
    },
    io.say,
  );
  const value = answer || (keepable ? "" : derived);
  if (value) setValue(answers, key, value, secret);
}

/** The GitHub App's private key from a .pem file, on one line with its newlines as literal `\n`, which `parseAppPrivateKey` turns back. Null when unreadable. */
async function readPem(deps: ProvisionDependencies, pemPath: string): Promise<string | null> {
  try {
    return (await deps.readFile(expandHome(pemPath, deps.homeDir())))?.replace(/\r?\n/g, "\\n") || null;
  } catch {
    return null;
  }
}

/** The checks over the sign-in answers and the GitHub App's, run as soon as each group is answered. */
const SIGN_IN_CHECKS = ["admin.path", "admin.providers", "admin.redirect-url", "admin.allowlist"];
const GITHUB_APP_CHECKS = ["env.github-app"];

/** The rows the answers so far fail, among the checks named, or every check when none are. */
async function failingRows(answers: Answers, ids?: readonly string[]): Promise<PreflightRow[]> {
  const rows = await provisionPreflight(answers.env, answers.kept);
  return rows.filter((row) => (row.state === "fail" || row.state === "warn") && (!ids || ids.includes(row.id)));
}

/** Prints each row as `check-setup` does, so a check reads the same before the deploy and after it. */
function showRows(io: Io, rows: readonly PreflightRow[]): void {
  if (rows.length > 0) io.say("");
  for (const row of rows) for (const line of formatCheckRow(row)) io.say(line);
}

/** Asks a group of questions until the checks over its answers pass, so a mistake is answered again where it was made. */
async function askChecked(io: Io, answers: Answers, ids: readonly string[], askGroup: () => Promise<void>): Promise<void> {
  const keepAll = answers.keepAll;
  for (let tries = 1; ; tries++) {
    await askGroup();
    const failing = await failingRows(answers, ids);
    if (failing.length === 0) break;
    showRows(io, failing);
    if (tries === MAX_TRIES) throw new ProvisionError("Those answers still fail their checks. Correct them and rerun the command.");
    io.explain("Answer these again. Enter keeps an earlier answer.");
    // A kept value can be what fails, so the group is asked again in full.
    answers.keepAll = false;
  }
  answers.keepAll = keepAll;
}

/** The two addresses a sign-in provider returns to, one for the admin UI and one for MCP clients. */
function redirectAddresses(base: string, provider: Answers["provider"]): string[] {
  return [`${base}/api/auth/${provider}/callback`, `${base}/mcp/callback/${provider}`];
}

/** The base the redirect addresses hang from, or null when it was kept on Fly and never remembered here. */
function redirectBase(client: ClientFile, answers: Answers): string | null {
  if (answers.env.OAUTH_REDIRECT_BASE_URL) return answers.env.OAUTH_REDIRECT_BASE_URL;
  if (client.remembered.redirectBase) return client.remembered.redirectBase;
  return answers.kept.has("OAUTH_REDIRECT_BASE_URL") ? null : `https://${client.app}.fly.dev`;
}

/** The redirect addresses to register, or, at the end of a run, a reminder of them. */
function showRedirectAddresses(io: Io, client: ClientFile, answers: Answers, reminder = false): void {
  const base = redirectBase(client, answers);
  if (base) {
    io.explain(reminder ? "As a reminder, your sign-in application needs both redirect addresses if they weren't set during the Admin sign-in step:" : "Register both of these redirect addresses in your sign-in application:");
    io.copyable(...redirectAddresses(base, answers.provider));
  } else {
    io.explain(
      reminder
        ? "As a reminder, your sign-in application needs both of these paths, under the OAUTH_REDIRECT_BASE_URL already set:"
        : "Register both of these paths under the OAUTH_REDIRECT_BASE_URL already set, in your sign-in application:",
    );
    io.copyable(...redirectAddresses("", answers.provider));
  }
}

async function collectAnswers(deps: ProvisionDependencies, io: Io, client: ClientFile, flyState: FlyState): Promise<Answers> {
  const has = (name: string) => flyState.secretNames.has(name);
  const answers: Answers = {
    env: {},
    secretKeys: new Set(),
    kept: new Set(flyState.secretNames),
    provider: "google",
    subscription: false,
    kgRepo: "",
    pemPath: client.remembered.pemPath ?? "",
    tokensToMint: new Map(),
    // The orchestrator takes FLY_SESSIONS_APP once, at its first boot, so it is taken only once the app has been deployed.
    sessionsSeeded: has("FLY_SESSIONS_APP") && flyState.released,
    keepAll: false,
    repos: [],
  };
  if (flyState.secretNames.size > 0) {
    io.explain(`${client.app} already holds ${flyState.secretNames.size} values. Fly never shows a secret's value, so kept ones stay as they are.`);
    answers.keepAll = await io.confirm("Keep every value already set, and ask only what is missing?", true);
  }
  const baseUrl = `https://${client.app}.fly.dev`;

  // Sign-in: the admin address, the addresses the provider redirects to, and the provider's credentials.
  await askChecked(io, answers, SIGN_IN_CHECKS, async () => {
    io.group("Admin sign-in");
    await ask(deps, io, answers, "OAUTH_ALLOWED_EMAILS", {
      about: "Who may sign in to the admin UI as an administrator. Separate several addresses with commas.",
      example: "you@example.com,teammate@example.com",
      secret: false,
      reason: (emails) =>
        parseAccessEntries(emails.split(",").map((value) => ({ kind: "address", value: value.trim(), role: "admin" }))).ok
          ? null
          : "OAUTH_ALLOWED_EMAILS must be one or more email addresses, separated by commas.",
    });
    await ask(deps, io, answers, "RUNNER_CALLBACK_BASE_URL", {
      about: "The address runners report their results to. Enter keeps the Fly app's own address.",
      secret: false,
      derived: baseUrl,
    });
    await ask(deps, io, answers, "OAUTH_REDIRECT_BASE_URL", {
      about: "The address your sign-in provider sends people back to. Enter keeps the Fly app's own address.",
      secret: false,
      derived: baseUrl,
    });
    const keptProvider = has("MICROSOFT_OAUTH_CLIENT_ID") && !has("GOOGLE_OAUTH_CLIENT_ID") ? "microsoft" : "google";
    if (answers.keepAll && has(`${keptProvider.toUpperCase()}_OAUTH_CLIENT_ID`)) answers.provider = keptProvider;
    else {
      io.explain("Administrators sign in with Google or Microsoft, through a web application you create in that provider's console.");
      answers.provider = await io.choose("Sign-in provider", ["google", "microsoft"] as const, keptProvider);
      showRedirectAddresses(io, client, answers);
    }
    const prefix = answers.provider.toUpperCase();
    if (answers.provider === "google") {
      await ask(deps, io, answers, "GOOGLE_OAUTH_CLIENT_ID", {
        about: "Your OAuth client's whole Client ID, from the Google Cloud console's Clients page.",
        example: "123456789012-abc123def456.apps.googleusercontent.com",
        secret: false,
      });
      await ask(deps, io, answers, "GOOGLE_OAUTH_CLIENT_SECRET", { about: "The same OAuth client's Client secret." });
    } else {
      await ask(deps, io, answers, `${prefix}_OAUTH_CLIENT_ID`, {
        about: "Your app registration's Application (client) ID, from its Overview page in Microsoft Entra.",
        example: "00000000-0000-0000-0000-000000000000",
        secret: false,
      });
      await ask(deps, io, answers, `${prefix}_OAUTH_CLIENT_SECRET`, {
        about: "A client secret's Value, from Certificates & secrets. Not its Secret ID.",
      });
      await ask(deps, io, answers, "MICROSOFT_OAUTH_TENANT", {
        about: "Your Directory (tenant) ID, from the same Overview page. A multi-tenant value such as common is refused.",
        example: "00000000-0000-0000-0000-000000000000",
        secret: false,
      });
    }
  });

  // The ticketing system, and only its own variables.
  const keptTracker = has("JIRA_TOKEN") && !has("LINEAR_CLIENT_ID") ? "jira" : "linear";
  let tracker: "linear" | "jira" = keptTracker;
  if (!(answers.keepAll && (has("LINEAR_CLIENT_ID") || has("JIRA_TOKEN")))) {
    io.heading("Ticketing system");
    io.explain("Where AI-Implement picks up the issues it works on.");
    tracker = await io.choose("Ticketing system", ["linear", "jira"] as const, keptTracker);
  }
  if (tracker === "linear") {
    await ask(deps, io, answers, "LINEAR_CLIENT_ID", {
      about: "Your Linear app's client ID, from Settings, API, Applications. The app needs Client credentials turned on.",
      secret: false,
    });
    await ask(deps, io, answers, "LINEAR_CLIENT_SECRET", { about: "The same Linear app's client secret." });
    await ask(deps, io, answers, "LINEAR_WORKSPACE_URL", {
      about: "Your Linear workspace's address, used to link issues in notifications and the admin UI.",
      example: "https://linear.app/your-workspace",
      secret: false,
    });
  } else {
    await askJira(deps, io, answers);
  }

  // The GitHub App. Its ID is not secret, so it is printed in the repository commands.
  await askChecked(io, answers, GITHUB_APP_CHECKS, async () => {
    io.group("GitHub App", "The orchestrator works on GitHub as your GitHub App. Its settings page shows the App ID, and Generate a private key downloads its .pem file.");
    await ask(deps, io, answers, "GITHUB_APP_ID", {
      about: "The App ID from the GitHub App's settings page.",
      example: "123456",
      secret: false,
      reason: (id) => (/^\d+$/.test(id) ? null : "GITHUB_APP_ID must be a number."),
    });
    await askPrivateKey(deps, io, answers);
  });

  // Model credentials. An API key is an account profile on the orchestrator, never an environment value.
  // A Claude subscription cannot be a profile yet, so its token is still taken here, for the legacy path.
  if (answers.keepAll && has("CLAUDE_CODE_OAUTH_TOKEN")) answers.subscription = true;
  else {
    io.heading("Model access");
    io.explain(
      "Model accounts, such as an Anthropic or OpenAI API key, are added later on the admin UI's Models & providers page.",
      "Only a Claude subscription's token is set here, for the projects that use one.",
    );
    answers.subscription = await io.confirm("Will projects run on a Claude subscription?", has("CLAUDE_CODE_OAUTH_TOKEN"));
  }
  if (answers.subscription) {
    await ask(deps, io, answers, "CLAUDE_CODE_OAUTH_TOKEN", {
      about: "Run claude setup-token where Claude Code is signed in to the subscription, then paste the token it prints.",
    });
  }

  if (!answers.keepAll) io.heading("Notifications (optional)");
  await ask(deps, io, answers, "NOTIFY_TYPE", {
    about: "Where notifications go: slack or teams. Enter leaves the default, slack.",
    secret: false,
    required: false,
  });
  await ask(deps, io, answers, "NOTIFY_WEBHOOK_URL", {
    about: "The incoming webhook notifications are posted to. Without one, none are sent.",
    example: "https://hooks.slack.com/services/T000/B000/XXXX",
    required: false,
  });

  // Not kept on Fly, since the build bakes it into the image, so the client file remembers it and a
  // rerun offers it. Enter keeps it, so a rerun cannot build without the graph by accident. Judged as
  // self-deploy reads it, so a value accepted here never disables the orchestrator's next deploy.
  const keptKg = client.remembered.kgRepo;
  io.heading("Knowledge graph (optional)");
  io.explain(
    "A knowledge-graph repository is built into the orchestrator so it can be searched through its MCP endpoint.",
    "Your GitHub App must be able to read it.",
    "For example: your-org/knowledge-graph",
  );
  answers.kgRepo = await io.askUntil(keptKg ? "KG_SOURCE_REPO, its owner/repo" : "KG_SOURCE_REPO, its owner/repo (Enter for none)", (repo) => {
    if (!repo) return null;
    try {
      parseKgSourceRepo(repo);
      return null;
    } catch {
      return "KG_SOURCE_REPO must be the owner/repo of a GitHub repository.";
    }
  }, keptKg);

  // Generated, as the control plane's set-up generates them. A value already set is kept on Enter.
  io.heading("Generated values");
  io.explain("RUNNER_TOKEN_SECRET and GITHUB_WEBHOOK_SECRET are generated for you unless they are already set.");
  if (!answers.keepAll) io.explain("Changing RUNNER_TOKEN_SECRET later makes every stored model credential unreadable, so each one has to be entered again.");
  for (const key of ["RUNNER_TOKEN_SECRET", "GITHUB_WEBHOOK_SECRET"]) {
    if (answers.kept.has(key)) await ask(deps, io, answers, key, { about: `${key} is already set. Enter keeps it.`, required: false });
    else setValue(answers, key, deps.generateSecret(), true);
  }
  if (answers.kept.has("ADMIN_ACCESS_CODE")) {
    await ask(deps, io, answers, "ADMIN_ACCESS_CODE", { about: "The break-glass access code is already set. Enter keeps it.", required: false });
  } else if (!answers.keepAll) {
    io.explain("A break-glass access code signs in to the admin UI when sign-in is broken. It is shown once.");
    if (await io.confirm("Generate a break-glass ADMIN_ACCESS_CODE, shown once?")) setValue(answers, "ADMIN_ACCESS_CODE", deps.generateSecret(), true);
  }

  await askFlyTokens(deps, io, answers, client, flyState);

  io.heading("Target repositories (optional)");
  io.explain(
    "The repositories AI-Implement will work in. Their jobs run in GitHub Actions by default, and need repository secrets of their own:",
    "- AI_IMPLEMENT_APP_ID and AI_IMPLEMENT_PRIVATE_KEY, the GitHub App's ID and key, so a job can push its branch and open its pull request as the App",
    ...(answers.subscription ? ["- CLAUDE_CODE_OAUTH_TOKEN, the subscription's token, so a job can reach Claude"] : []),
    "Enter each repository to have the command print the commands that set them, at the end. Entering none skips them.",
    "Enter one owner/repo at a time, then an empty line to finish. The projects themselves are added on the admin UI afterwards.",
    "For example: your-org/your-repo",
  );
  for (;;) {
    const repo = await io.askUntil("Target repo owner/repo (Enter to finish)", (r) => (!r || REPO_SHORTHAND.test(r) ? null : "Each target repo must be owner/repo."));
    if (!repo) break;
    answers.repos.push(repo);
  }
  return answers;
}

async function askPrivateKey(deps: ProvisionDependencies, io: Io, answers: Answers): Promise<void> {
  const onFly = answers.kept.has("GITHUB_APP_PRIVATE_KEY");
  if (answers.keepAll && onFly) return;
  const answeredEarlier = answers.env.GITHUB_APP_PRIVATE_KEY !== undefined;
  const keepable = onFly || answeredEarlier;
  const note = onFly ? " [already set, Enter to keep]" : answeredEarlier ? " [Enter to keep your earlier answer]" : "";
  io.explain("The path to the GitHub App's private key file. Keep it outside this checkout.", "For example: ~/keys/your-app.private-key.pem");
  let key = "";
  const path = await io.askUntil(`GITHUB_APP_PRIVATE_KEY .pem path${note}`, async (answer) => {
    if (!answer) return keepable ? null : "GITHUB_APP_PRIVATE_KEY is required.";
    // Whether it holds a key at all is the App check's, which parses it as the orchestrator does.
    key = (await readPem(deps, answer)) ?? "";
    return key ? null : `${answer} could not be read.`;
  });
  if (!path) return;
  answers.pemPath = expandHome(path, deps.homeDir());
  setValue(answers, "GITHUB_APP_PRIVATE_KEY", key, true);
}

async function askJira(deps: ProvisionDependencies, io: Io, answers: Answers): Promise<void> {
  const has = (name: string) => answers.kept.has(name);
  const kept = has("JIRA_CLOUD_ID") && !has("JIRA_EMAIL") ? "oauth" : "basic";
  let mode: "basic" | "oauth" = kept;
  if (!(answers.keepAll && (has("JIRA_EMAIL") || has("JIRA_CLOUD_ID")))) {
    io.explain("Basic signs in with an Atlassian account's email and an API token. OAuth uses an OAuth access token and your site's cloud ID.");
    mode = await io.choose("Jira mode (basic is recommended)", ["basic", "oauth"] as const, kept);
  }
  // The orchestrator uses basic authentication whenever JIRA_EMAIL is set, so OAuth needs it cleared.
  if (mode === "oauth" && has("JIRA_EMAIL")) {
    io.explain("Switching to Jira OAuth clears JIRA_EMAIL, because basic authentication wins while it is set.");
    if (await io.confirm("Clear JIRA_EMAIL and switch to OAuth?")) setValue(answers, "JIRA_EMAIL", "", false);
    else {
      mode = "basic";
      io.say("Keeping Jira basic authentication and its credentials.");
    }
  }
  if (mode === "basic") {
    await ask(deps, io, answers, "JIRA_EMAIL", { about: "The Atlassian account's email address.", example: "you@example.com", secret: false });
    await ask(deps, io, answers, "JIRA_TOKEN", { about: "An API token for that account, created at id.atlassian.com under Security, API tokens." });
  } else {
    await ask(deps, io, answers, "JIRA_CLOUD_ID", {
      about: "Your site's cloud ID, the cloudId shown at https://your-domain.atlassian.net/_edge/tenant_info",
      example: "00000000-0000-0000-0000-000000000000",
      secret: false,
    });
    await ask(deps, io, answers, "JIRA_TOKEN", { about: "An OAuth access token for your site." });
  }
  await ask(deps, io, answers, "JIRA_SITE_URL", { about: "Your Jira site's address.", example: "https://your-domain.atlassian.net", secret: false });
}

/**
 * Plans the two deploy tokens and the sessions seed. Once the orchestrator has taken its sessions app
 * from `FLY_SESSIONS_APP`, the saved runner settings own it, so neither seed is set again and the
 * client file's sessions app may no longer be the active one.
 */
async function askFlyTokens(deps: ProvisionDependencies, io: Io, answers: Answers, client: ClientFile, flyState: FlyState): Promise<void> {
  for (const key of ["FLY_DEPLOY_TOKEN", "FLY_SESSIONS_TOKEN"] as const) {
    const scope = key === "FLY_DEPLOY_TOKEN" ? "orchestrator" : "sessions";
    if (answers.kept.has(key)) await ask(deps, io, answers, key, { about: `The ${scope} app's deploy token is already set. Enter keeps it.` });
    else answers.tokensToMint.set(key, key === "FLY_DEPLOY_TOKEN" ? client.app : client.sessionsApp);
  }
  if (!answers.sessionsSeeded) {
    setValue(answers, "FLY_SESSIONS_APP", client.sessionsApp, false);
    setValue(answers, "FLY_SESSIONS_REGION", client.sessionsRegion, false);
    return;
  }
  io.explain("The orchestrator has taken its sessions app, which is now changed on the admin UI's Settings page, so both sessions seed variables are left as they are.");
  if (answers.tokensToMint.has("FLY_SESSIONS_TOKEN")) {
    io.explain("FLY_SESSIONS_TOKEN is missing. The client file no longer decides the active sessions app, so read its name on the Settings page.");
    const active = await io.askUntil("Active sessions app from the Settings page", (app) => {
      if (!app) return "Enter the active sessions app, so its token is created for the right app.";
      return FLY_NAME.test(app) && flyState.apps.has(app) ? null : `${app} is not in your Fly apps. Check the Fly account and the Settings page.`;
    });
    answers.tokensToMint.set("FLY_SESSIONS_TOKEN", active);
  }
}

/** The last check, over every answer: shows each failing check with its fix. True when none fails. */
async function passesPreflight(io: Io, answers: Answers): Promise<boolean> {
  const failing = await failingRows(answers);
  if (failing.length > 0) {
    io.heading("These answers fail their checks");
    showRows(io, failing);
    io.explain("Nothing was changed. Correct them and rerun the command.");
    return false;
  }
  if (answers.kept.size > 0) {
    io.explain("Secrets already on Fly, and an admin allowlist saved on the orchestrator, cannot be read here. The setup checks on the orchestrator confirm them after the deploy.");
  }
  return true;
}

// --- applying them ---

/**
 * Writes the client file, creates whatever is missing, mints the deploy tokens and sets every value
 * in one import. Each step skips what exists, so a re-run after a failure redoes nothing, and the
 * import comes as early as it can, since until it succeeds this run's answers live only here.
 */
async function apply(deps: ProvisionDependencies, io: Io, client: ClientFile, flyState: FlyState, answers: Answers): Promise<void> {
  io.group("Setting up Fly");
  const remembered: Remembered = {
    appId: answers.env.GITHUB_APP_ID ?? client.remembered.appId,
    pemPath: answers.pemPath || client.remembered.pemPath,
    redirectBase: answers.env.OAUTH_REDIRECT_BASE_URL ?? client.remembered.redirectBase,
    callbackBase: answers.env.RUNNER_CALLBACK_BASE_URL ?? client.remembered.callbackBase,
    kgRepo: answers.kgRepo || client.remembered.kgRepo,
  };
  const text = withRemembered(client.text ?? stringify(client.config), remembered);
  if (text !== client.text) {
    io.say(`Writing ${client.path}...`);
    await deps.writeFile(client.path, text);
  }
  if (!flyState.apps.has(client.app)) {
    io.say(`Creating the Fly app ${client.app}...`);
    await fly(deps, ["apps", "create", client.app, "--org", client.org]);
  }
  if (!answers.sessionsSeeded && !flyState.apps.has(client.sessionsApp)) {
    io.say(`Creating the sessions app ${client.sessionsApp}...`);
    await fly(deps, ["apps", "create", client.sessionsApp, "--org", client.sessionsOrg]);
  }

  for (const [key, app] of answers.tokensToMint) {
    io.say(`Creating ${key}, a deploy token for ${app}...`);
    const args = ["tokens", "create", "deploy", "--app", app, ...(key === "FLY_DEPLOY_TOKEN" ? ["--expiry", "8760h"] : [])];
    const minted = await deps.run("flyctl", args);
    if (minted.code === 0 && minted.stdout.trim()) setValue(answers, key, minted.stdout.trim(), true);
    else {
      io.explain(`Creating ${key} failed. Create a deploy token for ${app} in the Fly dashboard and paste it.`);
      await ask(deps, io, answers, key, { about: `A deploy token for ${app}, from the Fly dashboard.` });
    }
  }

  // One import sets every value, so an app that already has machines restarts once.
  const lines = Object.entries(answers.env).map(([key, value]) => `${key}=${value}\n`);
  if (lines.length > 0) {
    io.say(`Setting ${lines.length} values as Fly secrets on ${client.app}, in one import...`);
    await fly(deps, ["secrets", "import", "--app", client.app], lines.join(""));
  }

  const volumes = await flyListing(deps, ["volumes", "list", "--app", client.app, "--json"], ["name", "region"]);
  if (!volumes.some((volume) => volume.name === "dedup_data" && volume.region === client.region)) {
    io.say(`Creating the dedup_data volume in ${client.region}...`);
    await fly(deps, ["volumes", "create", "dedup_data", "--size", "1", "--region", client.region, "--app", client.app, "--yes"]);
  }

  if (answers.env.ADMIN_ACCESS_CODE) {
    io.explain("Save your break-glass access code now. It is not shown again:");
    io.copyable(answers.env.ADMIN_ACCESS_CODE);
  }
}

// --- deploy, wait and check ---

interface SourceStamps {
  commit: string;
  branch: string;
  /** This checkout's own repository, so a fork deploys itself. */
  repo: string;
}

/** The stamps self-deploy compares against its branch, read from this checkout, or null when any is unreadable. */
async function readSourceStamps(deps: ProvisionDependencies): Promise<SourceStamps | null> {
  const [origin, commit, branch] = await Promise.all([
    deps.run("git", ["remote", "get-url", "origin"]),
    deps.run("git", ["rev-parse", "HEAD"]),
    deps.run("git", ["rev-parse", "--abbrev-ref", "HEAD"]),
  ]);
  const repo = origin.code === 0 ? repoFromOrigin(origin.stdout.trim()) : null;
  if (!repo || commit.code !== 0 || branch.code !== 0) return null;
  return { commit: commit.stdout.trim(), branch: branch.stdout.trim(), repo };
}

/** `docs/deployment.md` § Manual deploy's command, built remotely by Fly from this checkout. */
function deployArgs(client: ClientFile, stamps: SourceStamps, kg: { repo: string; token: string } | null): string[] {
  return [
    "deploy", "--remote-only", "--no-cache",
    // With no graph the secret is still declared, empty, and the build skips the sidecar.
    "--build-secret", `kg_token=${kg?.token ?? ""}`,
    "--build-arg", `KG_SOURCE_REPO=${kg?.repo ?? ""}`,
    "--build-arg", `SOURCE_COMMIT=${stamps.commit}`,
    "--build-arg", `SOURCE_REPO=${stamps.repo}`,
    "--build-arg", `SOURCE_BRANCH=${stamps.branch}`,
    // fly.toml pins the template's own region, and the volume is in the client's.
    "--primary-region", client.region,
    // One machine, as the control plane's set-up creates.
    "--ha=false",
    "--app", client.app,
  ];
}

/** Passes a tool's output on line by line with every secret replaced, holding back a partial line until it ends. */
function redactingStream(write: (text: string) => void, secrets: string[]): { push: (text: string) => void; flush: () => void } {
  let pending = "";
  return {
    push: (text) => {
      pending += text;
      const lines = pending.split("\n");
      pending = lines.pop()!;
      for (const line of lines) write(`${redactEvidence(line, secrets)}\n`);
    },
    flush: () => {
      if (pending) write(`${redactEvidence(pending, secrets)}\n`);
      pending = "";
    },
  };
}

/** Mints the knowledge-graph build token, asking for the App's credentials only when neither this run nor the client file has them. Null when it cannot. */
async function mintKgBuildToken(deps: ProvisionDependencies, io: Io, client: ClientFile, answers: Answers): Promise<string | null> {
  const appId = answers.env.GITHUB_APP_ID || client.remembered.appId || (await io.ask("GITHUB_APP_ID, to mint the knowledge-graph build token"));
  const pemPath = answers.pemPath || (await io.ask("GITHUB_APP_PRIVATE_KEY .pem path, to mint the knowledge-graph build token"));
  const privateKey = answers.env.GITHUB_APP_PRIVATE_KEY ?? (pemPath ? await readPem(deps, pemPath) : null);
  if (!appId || !privateKey) return null;
  const [owner, repo] = answers.kgRepo.split("/") as [string, string];
  try {
    return await deps.kgToken(appId, privateKey, owner, repo);
  } catch {
    // The error carries GitHub's response body, so it is not shown.
    return null;
  }
}

/** Deploys this checkout, or records what to run instead. */
async function deploy(deps: ProvisionDependencies, io: Io, slug: string, client: ClientFile, answers: Answers, stillToRun: string[]): Promise<void> {
  io.heading("Deployment");
  const rerun = `npm run provision-client -- ${slug}`;
  const stamps = await readSourceStamps(deps);
  if (!stamps) {
    io.explain("This checkout's commit, branch or GitHub origin could not be read. A deploy without them could not deploy itself later, so run the command from a clone of your orchestrator repository.");
    stillToRun.push(rerun);
    return;
  }
  // A knowledge-graph build needs a token only the App can mint, so it has no hand-run form.
  const handRun = (kg: unknown) => (kg ? rerun : `flyctl ${deployArgs(client, stamps, null).map(shellWord).join(" ")}`);
  io.explain(
    `The deploy builds this checkout (${stamps.repo} at ${stamps.commit.slice(0, 12)}) on Fly's builders${answers.kgRepo ? `, with the knowledge graph from ${answers.kgRepo}` : ""}.`,
    "It usually takes several minutes, and flyctl's output is shown as it runs.",
  );
  if (!(await io.confirm("Deploy now?"))) {
    stillToRun.push(handRun(answers.kgRepo));
    return;
  }

  let kg: { repo: string; token: string } | null = null;
  if (answers.kgRepo) {
    io.say(`Creating a read-only token for ${answers.kgRepo}...`);
    const token = await mintKgBuildToken(deps, io, client, answers);
    if (token) kg = { repo: answers.kgRepo, token };
    else {
      const [owner, repo] = answers.kgRepo.split("/");
      io.explain(`The GitHub App could not mint a read token for ${answers.kgRepo}. Install the App on ${owner} with access to ${repo}, then rerun the command.`);
      if (!(await io.confirm("Deploy without a knowledge graph now?"))) {
        stillToRun.push(rerun);
        return;
      }
    }
  }

  io.say("");
  const output = redactingStream(deps.writeStdout, secretValues(answers, kg ? [kg.token] : []));
  const result = await deps.run("flyctl", deployArgs(client, stamps, kg), undefined, output.push);
  output.flush();
  if (result.code === 0) {
    io.explain("The deploy finished.");
    return;
  }
  io.explain("The deploy failed. Its output is above.");
  stillToRun.push(handRun(kg));
}

/** Polls the orchestrator for up to `HEALTH_WAIT_MS`, as the control plane's set-up does. False when it does not become serving. */
async function waitForHealth(deps: ProvisionDependencies, io: Io, client: ClientFile, stillToRun: string[]): Promise<boolean> {
  const health = `https://${client.app}.fly.dev/`;
  const minutes = HEALTH_WAIT_MS / 60_000;
  io.heading("Checking the orchestrator");
  io.explain("A new orchestrator takes a few minutes to start. Once it answers, its setup checks confirm every value, the kept ones included.");
  if (!(await io.confirm(`Wait up to ${minutes} minutes for the orchestrator to answer?`))) {
    stillToRun.push(`curl --fail ${health}`);
    return true;
  }
  io.say(`Waiting for ${health} to answer...`);
  const start = deps.now();
  const deadline = start + HEALTH_WAIT_MS;
  let reported = start;
  let probe: HealthProbe = { kind: "not-answering" };
  while (deps.now() < deadline) {
    try {
      probe = await deps.probeHealth(health);
      if (probe.kind === "serving") {
        io.say("The orchestrator is answering.");
        return true;
      }
    } catch {
      probe = { kind: "not-answering" };
      // Not answering yet. Retry until the deadline.
    }
    if (deps.now() - reported >= HEALTH_PROGRESS_MS) {
      reported = deps.now();
      const states = probe.kind === "starting" ? ` Restate is not serving (sidecar ${probe.sidecar}, registration ${probe.registration}).` : "";
      io.say(`Still waiting, ${Math.floor((reported - start) / 60_000)} of ${minutes} minutes.${states}`);
    }
    await deps.sleep(Math.min(HEALTH_RETRY_MS, deadline - deps.now()));
  }
  io.explain(probe.kind === "starting"
    ? `The orchestrator answers, but Restate is not serving (sidecar ${probe.sidecar}, registration ${probe.registration}).`
    : `The orchestrator did not answer within ${minutes} minutes.`);
  stillToRun.push(`curl --fail ${health}`);
  return false;
}

/** Runs the setup checks on the orchestrator itself, which alone can read its own environment. Returns their exit code. */
async function runRemoteChecks(deps: ProvisionDependencies, io: Io, client: ClientFile, answers: Answers, stillToRun: string[]): Promise<number> {
  const command = `flyctl ssh console --app ${client.app} -C "${CHECK_SETUP_COMMAND}"`;
  io.say("");
  if (!(await io.confirm("Run the setup checks on the orchestrator?"))) {
    stillToRun.push(command);
    return 0;
  }
  const machines = await deps.run("flyctl", ["machines", "list", "--app", client.app, "--json"]);
  let running = false;
  try {
    running = machines.code === 0 && (JSON.parse(machines.stdout) as Array<{ state?: unknown }>).some((machine) => machine.state === "started");
  } catch {
    // An unreadable listing reads as no running machine.
  }
  if (!running) {
    io.explain("No machine is running, so the setup checks cannot run yet.");
    stillToRun.push(command);
    return 1;
  }
  io.say("Running the setup checks on the orchestrator...");
  io.say("");
  const result = await deps.run("flyctl", ["ssh", "console", "--app", client.app, "-C", CHECK_SETUP_COMMAND]);
  // The checks never print a secret, but a tool's own diagnostics might.
  const secrets = secretValues(answers);
  deps.writeStderr(redactEvidence(result.stderr, secrets));
  deps.writeStdout(redactEvidence(result.stdout, secrets));
  if (result.code !== 0) stillToRun.push(command);
  return result.code;
}

function printNextSteps(io: Io, client: ClientFile, answers: Answers, stillToRun: string[]): void {
  io.heading("What's left to do");
  const appId = answers.env.GITHUB_APP_ID ?? client.remembered.appId ?? "<App ID>";
  const pemPath = answers.pemPath || client.remembered.pemPath;
  const pem = pemPath ? shellWord(pemPath) : "<pem-path>";
  if (answers.repos.length > 0) {
    io.explain("Set the GitHub App's credentials as secrets on each target repository:");
    io.copyable(
      ...answers.repos.flatMap((repo) => [
        `gh secret set AI_IMPLEMENT_APP_ID --repo ${repo} --body ${appId}`,
        `gh secret set AI_IMPLEMENT_PRIVATE_KEY --repo ${repo} < ${pem}`,
        ...(answers.subscription ? [`gh secret set CLAUDE_CODE_OAUTH_TOKEN --repo ${repo}`] : []),
      ]),
    );
  }
  io.explain("Set the GitHub App's webhook to this address, with the Issue comment, Pull request, Pull request review and Pull request review comment events:");
  // As the redirect addresses: a callback base kept on Fly and never remembered here is unknown.
  const callbackBase =
    answers.env.RUNNER_CALLBACK_BASE_URL ??
    client.remembered.callbackBase ??
    (answers.kept.has("RUNNER_CALLBACK_BASE_URL") ? "<RUNNER_CALLBACK_BASE_URL>" : `https://${client.app}.fly.dev`);
  io.copyable(`${callbackBase}/api/github/webhook`);
  io.explain("Its secret is printed by:");
  io.copyable(`flyctl ssh console -a ${client.app} -C "printenv GITHUB_WEBHOOK_SECRET"`);
  showRedirectAddresses(io, client, answers, true);
  io.explain("If nobody can sign in, recover access on the host:");
  io.copyable(`flyctl ssh console -a ${client.app} -C "node /app/dist/access-recovery.js --email <address>"`);
  io.explain("Then add your projects on the admin UI. This guide covers adding one and choosing how it reaches a model:");
  io.copyable(PROJECT_DOCS_URL);
  if (stillToRun.length > 0) {
    io.explain("Still to run:");
    io.copyable(...stillToRun);
  }
}

// --- the command ---

export async function runProvisionClient(args: string[], deps: ProvisionDependencies = DEFAULT_DEPENDENCIES): Promise<number> {
  const slug = args[0];
  if (args.length !== 1 || !slug || !SLUG.test(slug)) {
    deps.writeStderr(`${USAGE}\n`);
    return 2;
  }
  const io = makeIo(deps);
  const flyUnreadable = () => {
    io.explain(`Fly could not be read. Install flyctl and run flyctl auth login, then rerun npm run provision-client -- ${slug}. Nothing was changed.`);
    return 1;
  };
  try {
    printIntro(io);
    // Fly is read before the first question, so a missing or signed-out flyctl costs no answers.
    const flyState: FlyState = { apps: new Set(), secretNames: new Set(), released: false };
    io.say("");
    io.say("Reading your Fly apps...");
    try {
      flyState.apps = await listApps(deps);
    } catch {
      return flyUnreadable();
    }
    const client = await readClientFile(deps, io, slug);
    try {
      if (flyState.apps.has(client.app)) {
        flyState.secretNames = await listSecretNames(deps, client.app);
        flyState.released = await hasRelease(deps, client.app);
      }
    } catch {
      return flyUnreadable();
    }
    const answers = await collectAnswers(deps, io, client, flyState);
    if (!(await passesPreflight(io, answers))) return 1;

    // Nothing is written, created or minted before this point.
    await apply(deps, io, client, flyState, answers);
    const stillToRun: string[] = [];
    await deploy(deps, io, slug, client, answers, stillToRun);
    const healthy = await waitForHealth(deps, io, client, stillToRun);
    const checks = await runRemoteChecks(deps, io, client, answers, stillToRun);
    printNextSteps(io, client, answers, stillToRun);
    // The setup checks' own exit code wins, since it says the most about what is wrong.
    if (checks !== 0) return checks;
    return healthy ? 0 : 1;
  } catch (err) {
    deps.writeStderr(`${err instanceof ProvisionError ? err.message : "Provisioning failed. Check the client file, the .pem file, and that flyctl and git are installed."}\n`);
    return 1;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runProvisionClient(process.argv.slice(2))
    .then((exitCode) => process.exit(exitCode))
    .catch(() => {
      process.stderr.write("Provisioning failed.\n");
      process.exit(1);
    });
}
