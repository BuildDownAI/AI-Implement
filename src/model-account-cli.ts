/**
 * Operator command for hosted model accounts: `node dist/model-account-cli.js <command> ...`, run on the
 * orchestrator machine (for example through `fly ssh console`). ChatGPT plan commands: `chatgpt-import`,
 * `chatgpt-status`, `chatgpt-logout`, each with `--profile <id>`. API credential commands: `secret-import` and
 * `secret-delete`, each with `--ref model-account:<name>`, over the encrypted store in model-protected-secrets.ts.
 * Claude subscription commands arrive with AII-963; add them to `COMMANDS`.
 *
 * Trust boundary: the operator shell on this machine to the protected session store. The record enters only through
 * stdin (never argv). No token reaches stdout, stderr, or an error message; failures print fixed text.
 */
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { getAccountProfile } from "./agent-config-store.js";
import type { AccountProfileProjection } from "./agent-config-store.js";
import { revoke } from "./chatgpt-plan-login.js";
import { parseChatGptPlanRecord, serializeChatGptPlanRecord } from "./chatgpt-plan-token.js";
import { getDb } from "./dedup.js";
import { createModelProtectedSecrets } from "./model-protected-secrets.js";
import type { ModelProtectedSecrets, ProtectedSecretFailure } from "./model-protected-secrets.js";
import { MODEL_ACCOUNT_REF_PATTERN } from "./model-credentials.js";
import { createModelSessionKeyProvider } from "./model-session-keys.js";
import { PLAN_RECORD_OWNER_GENERATION, createModelSessionStore } from "./model-session-store.js";
import type { ModelSessionStore } from "./model-session-store.js";
import { readChatGptPlanState, requestChatGptPlanRefresh } from "./restate/chatgpt-plan-account.js";

export const HOST_ID_KEY = "chatgpt_plan_host_id";
const OPERATOR = "model-account-cli";
const USAGE =
  "usage: model-account-cli <chatgpt-import|chatgpt-status|chatgpt-logout> --profile <id>   (import reads the record JSON from stdin)\n" +
  "       model-account-cli <secret-import|secret-delete> --ref model-account:<name>   (import reads the API key or Bedrock JSON from stdin)";

export interface CliDeps {
  store: () => ModelSessionStore;
  /** Returns the orchestrator's host id, creating it on first use. */
  hostId: () => string;
  /** Latest plan-record checkpoint sequence, read without decrypting; null when no row exists. */
  planSequence: (profileId: string) => number | null;
  getProfile: (profileId: string) => AccountProfileProjection | null;
  requestRefresh: (profileId: string) => Promise<void>;
  readState: (profileId: string) => Promise<{ lastOutcome: string } | null>;
  /** Encrypted API-key and Bedrock credential store (AII-1411). */
  secrets: () => ModelProtectedSecrets;
  fetch: typeof fetch;
  readStdin: () => Promise<string>;
  now: () => number;
  env: NodeJS.ProcessEnv;
  stdout: (line: string) => void;
  stderr: (line: string) => void;
}

/** An error whose message is safe to print: fixed text only. */
class CliError extends Error {}

/** `INSERT OR IGNORE` then read back, so concurrent first uses agree on one id. */
export function orchestratorHostId(db: () => ReturnType<typeof getDb> = getDb): string {
  const conn = db();
  conn.exec("CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
  conn.prepare("INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)").run(HOST_ID_KEY, `urn:uuid:${randomUUID()}`);
  const row = conn.prepare("SELECT value FROM settings WHERE key = ?").get(HOST_ID_KEY) as { value: string } | undefined;
  if (!row) throw new CliError("could not read the orchestrator host id");
  return row.value;
}

export function latestPlanSequence(profileId: string, db: () => ReturnType<typeof getDb> = getDb): number | null {
  const row = db()
    .prepare("SELECT MAX(checkpoint_sequence) AS seq FROM model_session_generations WHERE profile_id = ? AND owner_generation = ?")
    .get(profileId, PLAN_RECORD_OWNER_GENERATION) as { seq: number | null } | undefined;
  return row?.seq ?? null;
}

function operatorStore(): ModelSessionStore {
  return createModelSessionStore({
    keys: createModelSessionKeyProvider(),
    verifyOwner: () => false,
    authorizeOperator: (operator) => operator === OPERATOR, // shell access on this machine is the boundary
    db: () => getDb(),
  });
}

/** Import needs an active profile. Status and logout also accept a disabled or archived one: retiring a profile leaves its stored session, and sign-out must still reach it. */
function requireProfile(profileId: string, deps: CliDeps, opts: { allowInactive?: boolean } = {}): void {
  const profile = deps.getProfile(profileId);
  if (!profile) throw new CliError("unknown profile");
  if (profile.authMode !== "codex-subscription") throw new CliError("profile is not a codex-subscription profile");
  if (profile.status !== "active" && !opts.allowInactive) throw new CliError("profile is not active");
}

function parseJsonObject(text: string): Record<string, unknown> | null {
  try {
    const v = JSON.parse(text);
    return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function readStored(store: ModelSessionStore, profileId: string): { data: Record<string, unknown> | null; sequence: number | null } {
  const read = store.readPlanRecord(profileId);
  if (!read.ok) {
    if (read.reason === "no_state") return { data: null, sequence: null };
    if (read.reason === "key_mismatch") throw new CliError("the stored record was sealed under another RUNNER_TOKEN_SECRET; sign in and import again");
    throw new CliError("could not read the stored record");
  }
  return { data: parseJsonObject(read.sessionData), sequence: read.stateSequence };
}

async function chatgptImport(profileId: string, deps: CliDeps): Promise<void> {
  if (!deps.env.RUNNER_TOKEN_SECRET) throw new CliError("RUNNER_TOKEN_SECRET is not set; the session key derives from it");
  requireProfile(profileId, deps);
  const raw = parseJsonObject(await deps.readStdin());
  if (!raw) throw new CliError("stdin is not a JSON object");
  const parsed = parseChatGptPlanRecord(raw);
  if (!parsed.ok) throw new CliError(`record failed validation: ${parsed.reason}`);
  const record = { ...parsed.value, extAgentHostId: deps.hostId() };
  const store = deps.store();
  // The old row may be unreadable (rotated secret, corruption); import is the recovery path, so replace it
  // using its sequence without decrypting.
  const written = store.writePlanRecord({
    profileId,
    expectedSequence: deps.planSequence(profileId),
    sessionData: serializeChatGptPlanRecord(record),
    operator: OPERATOR,
  });
  if (!written.ok) {
    throw new CliError(written.reason === "stale_sequence" ? "the record changed during import; run the import again" : "could not write the record");
  }
  try {
    await deps.requestRefresh(profileId);
  } catch {
    deps.stdout(`profile=${profileId} chatgpt-import imported, refresh not requested`);
    throw new CliError("imported, but the refresh request failed; check the Restate ingress");
  }
  deps.stdout(`profile=${profileId} chatgpt-import ok host=${record.extAgentHostId}`);
}

async function chatgptStatus(profileId: string, deps: CliDeps): Promise<void> {
  requireProfile(profileId, deps, { allowInactive: true });
  const { data } = readStored(deps.store(), profileId);
  if (!data) throw new CliError("no record stored for this profile");
  const str = (k: string): string => (typeof data[k] === "string" && data[k] ? (data[k] as string) : "-");
  let outcome = "unknown";
  try {
    const state = await deps.readState(profileId);
    outcome = state ? state.lastOutcome : "never run";
  } catch {
    /* ingress unreachable: leave unknown */
  }
  const signedOut = !data.refreshToken;
  const exp = data.accessTokenExpiresAt;
  const left = signedOut || typeof exp !== "number" ? "-" : String(Math.floor((exp - deps.now()) / 1000));
  deps.stdout(`State: ${signedOut ? "signed out" : "signed in"}`);
  deps.stdout(`Email: ${str("email")}`);
  deps.stdout(`Subject: ${str("subject")}`);
  deps.stdout(`Client id: ${str("clientId").slice(0, 10)}`);
  deps.stdout(`Host id: ${str("extAgentHostId")}`);
  deps.stdout(`Seconds left: ${left}`);
  deps.stdout(`Last refresh outcome: ${outcome}`);
  deps.stdout(`profile=${profileId} chatgpt-status ok`);
}

async function chatgptLogout(profileId: string, deps: CliDeps): Promise<void> {
  requireProfile(profileId, deps, { allowInactive: true });
  const store = deps.store();
  const { data, sequence } = readStored(store, profileId);
  if (!data) throw new CliError("no record stored for this profile");
  let confirmed = false;
  if (typeof data.refreshToken === "string" && data.refreshToken && typeof data.clientId === "string") {
    try {
      confirmed = await revoke({ refreshToken: data.refreshToken, clientId: data.clientId }, deps);
    } catch {
      confirmed = false;
    }
  }
  const { accessToken: _a, refreshToken: _r, idToken: _i, ...rest } = data;
  const written = store.writePlanRecord({ profileId, expectedSequence: sequence, sessionData: JSON.stringify(rest), operator: OPERATOR });
  if (!written.ok) throw new CliError("could not write the tokenless record");
  deps.stdout(`profile=${profileId} chatgpt-logout tokens removed, revocation ${confirmed ? "confirmed" : "not confirmed"}`);
  if (!confirmed) deps.stdout("Revocation was not confirmed. You can disconnect the app in ChatGPT settings.");
}

const SECRET_FAILURES: Record<ProtectedSecretFailure, string> = {
  invalid_ref: "the reference is not a valid model-account reference",
  invalid_value: "stdin is not a valid API key or Bedrock credential bundle",
  key_unavailable: "RUNNER_TOKEN_SECRET is not set; the encryption key derives from it",
  row_missing: "could not write the credential",
  decrypt_failed: "could not write the credential",
  write_failed: "could not write the credential",
};

/** A key is one line; a trailing newline from `echo` or a heredoc is dropped, nothing else is trimmed. */
function parseSecretInput(raw: string): string | Record<string, unknown> {
  const text = raw.replace(/\r?\n$/, "");
  return parseJsonObject(text) ?? text;
}

async function secretImport(ref: string, deps: CliDeps): Promise<void> {
  if (!deps.env.RUNNER_TOKEN_SECRET) throw new CliError(SECRET_FAILURES.key_unavailable);
  const result = deps.secrets().write(ref, parseSecretInput(await deps.readStdin()) as never);
  if (!result.ok) throw new CliError(SECRET_FAILURES[result.code]);
  deps.stdout(`ref=${ref} secret-import ok`);
}

async function secretDelete(ref: string, deps: CliDeps): Promise<void> {
  const result = deps.secrets().delete(ref);
  if (!result.ok) throw new CliError("could not delete the credential");
  deps.stdout(`ref=${ref} secret-delete ok`);
}

const SECRET_COMMANDS: Record<string, (ref: string, deps: CliDeps) => Promise<void>> = {
  "secret-import": secretImport,
  "secret-delete": secretDelete,
};

const COMMANDS: Record<string, (profileId: string, deps: CliDeps) => Promise<void>> = {
  "chatgpt-import": chatgptImport,
  "chatgpt-status": chatgptStatus,
  "chatgpt-logout": chatgptLogout,
};

export async function main(argv: string[], deps: CliDeps = defaultDeps()): Promise<number> {
  const [command, ...rest] = argv;
  const secretRun = command ? SECRET_COMMANDS[command] : undefined;
  if (secretRun) {
    // Only `--ref <ref>` is accepted, so a value can never ride on argv; an invalid ref is never echoed.
    const ref = rest[1];
    if (rest.length !== 2 || rest[0] !== "--ref" || ref === undefined || !MODEL_ACCOUNT_REF_PATTERN.test(ref)) {
      deps.stderr(rest.length === 2 && rest[0] === "--ref" ? `${command} failed: ${SECRET_FAILURES.invalid_ref}` : USAGE);
      return rest.length === 2 && rest[0] === "--ref" ? 1 : 2;
    }
    try {
      await secretRun(ref, deps);
      return 0;
    } catch (err) {
      deps.stderr(`ref=${ref} ${command} failed: ${err instanceof CliError ? err.message : "unexpected failure"}`);
      return 1;
    }
  }
  const run = command ? COMMANDS[command] : undefined;
  // Only `--profile <id>` is accepted, so a record can never ride on argv.
  if (!run || rest.length !== 2 || rest[0] !== "--profile" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(rest[1] ?? "")) {
    deps.stderr(USAGE);
    return 2;
  }
  const profileId = rest[1] as string;
  try {
    await run(profileId, deps);
    return 0;
  } catch (err) {
    deps.stderr(`profile=${profileId} ${command} failed: ${err instanceof CliError ? err.message : "unexpected failure"}`);
    return 1;
  }
}

async function readProcessStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

export function defaultDeps(): CliDeps {
  return {
    store: operatorStore,
    hostId: () => orchestratorHostId(),
    planSequence: (id) => latestPlanSequence(id),
    getProfile: getAccountProfile,
    requestRefresh: (id) => requestChatGptPlanRefresh(id),
    readState: (id) => readChatGptPlanState(id),
    secrets: () => createModelProtectedSecrets({ env: process.env }),
    fetch: (input, init) => fetch(input, init),
    readStdin: readProcessStdin,
    now: () => Date.now(),
    env: process.env,
    stdout: (l) => console.log(l),
    stderr: (l) => console.error(l),
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main(process.argv.slice(2)).then((code) => process.exit(code));
}
