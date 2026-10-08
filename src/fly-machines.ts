import crypto from "node:crypto";

import {
  MODEL_AUTH_BACKENDS,
  MODEL_AUTH_ENV,
  parseSealedModelAuthBootstrap,
  type SealedModelAuthBootstrapV1,
} from "./model-auth-contract.js";
import { isSafeProtectionKeyRef } from "./model-auth-seal.js";
import {
  MODEL_CREDENTIAL_KEYS,
  MODEL_SESSION_KEYS,
  PROTECTED_BOOTSTRAP_KEYS,
  PROTECTED_BOOTSTRAP_PREFIXES,
} from "./pipeline/process-env.js";
import { encodeTrustedRunConfig, type RunConfigV1 } from "./run-config.js";

import {
  DURABLE_RUNNER_DISPATCH_ID_KEY,
  DURABLE_RUNNER_PIPELINE_KEY,
  DURABLE_RUNNER_PURPOSE_KEY,
  type DURABLE_RUNNER_PURPOSE_VALUE,
} from "./durable-runner.js";

// ── Types ────────────────────────────────────────────────────────────────────

export interface MachineGuest {
  cpu_kind: "shared" | "performance";
  cpus: number;
  memory_mb: number;
}

export interface MachineService {
  internal_port: number;
  protocol: string;
  ports: Array<{ port: number; handlers: string[] }>;
}

export interface MachineSecret {
  env_var: string; // env var name inside the machine
  name?: string;   // app-level secret name when it differs from env_var
}

export interface MachineProcess {
  entrypoint?: string[];
  cmd?: string[];
  env?: Record<string, string>;
  exec?: string[];
  user?: string;
  ignore_app_secrets?: boolean;
  secrets?: MachineSecret[];
}

export interface MachineConfig {
  image: string;
  env?: Record<string, string>;
  guest?: MachineGuest;
  services?: MachineService[];
  auto_destroy?: boolean;
  restart?: { policy: string };
  metadata?: Record<string, string>;
  processes?: MachineProcess[];
  init?: { entrypoint?: string[]; cmd?: string[] };
}

export interface MachineExitEvent {
  exit_code?: number;
  guest_exit_code?: number;
  guest_signal?: number;
  signal?: number;
  oom_killed?: boolean;
}

export interface MachineEvent {
  type: string;
  status?: string;
  source?: string;
  timestamp?: number;
  request?: { exit_event?: MachineExitEvent };
}

export interface Machine {
  id: string;
  name: string;
  state: string;
  region: string;
  created_at: string;
  updated_at: string;
  config: MachineConfig;
  events?: MachineEvent[];
}

export interface CreateMachineOpts {
  name?: string;
  region?: string;
  min_secrets_version?: number;
  config: MachineConfig;
}

// ── API Helpers ──────────────────────────────────────────────────────────────

export const FLY_API_BASE = "https://api.machines.dev/v1";

export function flyHeaders(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
  };
}

// ── Machine CRUD ─────────────────────────────────────────────────────────────

export async function createMachine(
  token: string,
  appName: string,
  opts: CreateMachineOpts,
): Promise<Machine> {
  const url = `${FLY_API_BASE}/apps/${appName}/machines`;
  const res = await fetch(url, {
    method: "POST",
    headers: flyHeaders(token),
    body: JSON.stringify(opts),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Failed to create machine in ${appName} (${res.status}): ${body}`);
  }

  return (await res.json()) as Machine;
}

export async function getMachine(
  token: string,
  appName: string,
  machineId: string,
): Promise<Machine> {
  const url = `${FLY_API_BASE}/apps/${appName}/machines/${machineId}`;
  const res = await fetch(url, { headers: flyHeaders(token) });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Failed to get machine ${machineId} (${res.status}): ${body}`);
  }

  return (await res.json()) as Machine;
}

export async function listMachines(
  token: string,
  appName: string,
): Promise<Machine[]> {
  const url = `${FLY_API_BASE}/apps/${appName}/machines`;
  const res = await fetch(url, { headers: flyHeaders(token) });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Failed to list machines in ${appName} (${res.status}): ${body}`);
  }

  return (await res.json()) as Machine[];
}

export async function stopMachine(
  token: string,
  appName: string,
  machineId: string,
): Promise<void> {
  const url = `${FLY_API_BASE}/apps/${appName}/machines/${machineId}/stop`;
  const res = await fetch(url, {
    method: "POST",
    headers: flyHeaders(token),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Failed to stop machine ${machineId} (${res.status}): ${body}`);
  }
}

export async function startMachine(
  token: string,
  appName: string,
  machineId: string,
): Promise<void> {
  const url = `${FLY_API_BASE}/apps/${appName}/machines/${machineId}/start`;
  const res = await fetch(url, {
    method: "POST",
    headers: flyHeaders(token),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Failed to start machine ${machineId} (${res.status}): ${body}`);
  }
}

/** Replaces the machine's config. Fly takes the whole config (no partial update), so pass a full one. */
export async function updateMachine(
  token: string,
  appName: string,
  machineId: string,
  config: MachineConfig,
): Promise<Machine> {
  const url = `${FLY_API_BASE}/apps/${appName}/machines/${machineId}`;
  const res = await fetch(url, {
    method: "POST",
    headers: flyHeaders(token),
    body: JSON.stringify({ config }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Failed to update machine ${machineId} (${res.status}): ${body}`);
  }

  return (await res.json()) as Machine;
}

/**
 * Reads the machine, then replaces its config with the same one and `env: {}`. Fly's update on a
 * stopped machine applies the config without starting it (AII-1123), so this never calls `start`.
 */
export async function clearMachineEnv(
  token: string,
  appName: string,
  machineId: string,
): Promise<void> {
  const machine = await getMachine(token, appName, machineId);
  await updateMachine(token, appName, machineId, { ...machine.config, env: {} });
}

/**
 * Process exit code from a stopped machine's terminal event, or null when unreadable.
 * Verified against live Fly machines (2026-07):
 *   - clean exit N≠0 → type "exit",  exit_event.exit_code = N   (guest_exit_code omitted)
 *   - clean exit 0   → exit_event has NO exit_code (Fly omits the zero) → null → treated as clean
 *   - killed / OOM   → type "crash", exit_event.exit_code = -1  (+ guest_signal)
 * 
 * Match on the exit_event field (type is "exit" OR "crash"); events are newest-first; prefer
 * exit_code (the field a clean non-zero exit populates).
 * Fully optional-chained, so any shape drift degrades to null rather than throwing.
 * (Session machines run auto_destroy:false, so a normally-exited machine stays `stopped` with this event present.)
 */
export function readMachineExitCode(machine: Machine): number | null {
  const exit = machine.events?.find((e) => e.request?.exit_event)?.request?.exit_event;
  return exit?.exit_code ?? exit?.guest_exit_code ?? null;
}

export interface MachineExit {
  exitCode: number | null;
  signal: number | null;
  oomKilled: boolean | null;
  timestamp: number | null;
}

/**
 * Terminal exit details from the newest event carrying an exit_event (all null when none exists).
 * Raw: Fly omits exit_code for a clean exit 0, so `exitCode: null` with an event present is a
 * clean exit (see readMachineExitCode). Every field is optional-chained and degrades to null.
 */
export function readMachineExit(machine: Machine): MachineExit {
  const event = machine.events?.find((e) => e.request?.exit_event);
  const exit = event?.request?.exit_event;
  return {
    exitCode: exit?.exit_code ?? exit?.guest_exit_code ?? null,
    signal: exit?.guest_signal ?? exit?.signal ?? null,
    oomKilled: exit?.oom_killed ?? null,
    timestamp: event?.timestamp ?? null,
  };
}

export async function destroyMachine(
  token: string,
  appName: string,
  machineId: string,
  force = true,
): Promise<void> {
  const url = `${FLY_API_BASE}/apps/${appName}/machines/${machineId}?force=${force}`;
  const res = await fetch(url, {
    method: "DELETE",
    headers: flyHeaders(token),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Failed to destroy machine ${machineId} (${res.status}): ${body}`);
  }
}

export async function waitForMachine(
  token: string,
  appName: string,
  machineId: string,
  state: string,
  timeoutSeconds = 60,
): Promise<void> {
  const url = `${FLY_API_BASE}/apps/${appName}/machines/${machineId}/wait?state=${state}&timeout=${timeoutSeconds}`;
  const res = await fetch(url, { headers: flyHeaders(token) });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Timeout waiting for machine ${machineId} to reach state "${state}" (${res.status}): ${body}`);
  }
}

// ── App Secrets CRUD (Fly GraphQL API) ───────────────────────────────────────
//
// The Fly Machines REST API secrets endpoint (api.machines.dev) targets the
// KMS named-secrets feature (not yet GA), not the traditional app env-var
// secrets that `fly secrets set/list` manages. The GraphQL API is the correct
// interface for those.

const FLY_GRAPHQL_URL = "https://api.fly.io/graphql";

export interface FlySecret {
  name: string;
  digest: string;
  created_at: string;
}

async function flyGraphQL<T>(
  token: string,
  query: string,
  variables: Record<string, unknown>,
): Promise<T> {
  const res = await fetch(FLY_GRAPHQL_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ query, variables }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Fly API request failed (${res.status}): ${text}`);
  }

  const json = await res.json() as { data?: T; errors?: Array<{ message: string }> };
  if (json.errors?.length) {
    throw new Error(json.errors.map((e) => e.message).join("; "));
  }

  return json.data as T;
}

export async function listAppSecrets(
  token: string,
  appName: string,
): Promise<FlySecret[]> {
  const data = await flyGraphQL<{
    app: { secrets: Array<{ name: string; digest: string; createdAt: string }> } | null;
  }>(token, `
    query ListSecrets($appName: String!) {
      app(name: $appName) {
        secrets { name digest createdAt }
      }
    }
  `, { appName });

  return (data.app?.secrets ?? []).map((s) => ({
    name: s.name,
    digest: s.digest,
    created_at: s.createdAt,
  }));
}

export async function setAppSecrets(
  token: string,
  appName: string,
  secrets: Record<string, string>,
): Promise<number | null> {
  const secretInputs = Object.entries(secrets).map(([key, value]) => ({ key, value }));

  // Always returns null: the GraphQL response is discarded (typed as unknown) so
  // release.version — which would populate min_secrets_version — is never read.
  // setFlySecretsMinVersion would store that version; getFlySecretsMinVersion would
  // return it — but neither is called here, so callers always receive undefined.
  await flyGraphQL<unknown>(token, `
    mutation SetSecrets($input: SetSecretsInput!) {
      setSecrets(input: $input) { release { version } }
    }
  `, { input: { appId: appName, secrets: secretInputs } });

  return null;
}

export async function unsetAppSecret(
  token: string,
  appName: string,
  secretName: string,
): Promise<number | null> {
  await flyGraphQL<unknown>(token, `
    mutation UnsetSecrets($input: UnsetSecretsInput!) {
      unsetSecrets(input: $input) { release { version } }
    }
  `, { input: { appId: appName, keys: [secretName] } });

  return null;
}

// ── Machine Logs ─────────────────────────────────────────────────────────────

/**
 * Fetches the last `lastN` log lines from a Fly Machine and returns them as a
 * single newline-joined string.
 *
 * The Fly Machines logs endpoint (`/v1/apps/{app}/machines/{id}/logs`) is a
 * streaming NDJSON endpoint that can remain open on a running machine.
 * Passing `?lines=N` caps the response to the last N lines so the stream
 * closes immediately and `res.text()` cannot hang.  An AbortController with a
 * 10 s timeout is added as a second line of defence.
 */
export async function fetchMachineLogs(
  token: string,
  appName: string,
  machineId: string,
  lastN = 100,
): Promise<string> {
  const url = `${FLY_API_BASE}/apps/${appName}/machines/${machineId}/logs?lines=${lastN}`;

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 10_000);

  let res: Response;
  try {
    res = await fetch(url, { headers: flyHeaders(token), signal: ac.signal });
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Failed to fetch logs for machine ${machineId} (${res.status}): ${body}`);
  }

  const raw = await res.text();
  if (!raw.trim()) return "";

  return raw
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => {
      try {
        const parsed = JSON.parse(line) as Record<string, unknown>;
        return typeof parsed.message === "string" ? parsed.message : line;
      } catch {
        return line;
      }
    })
    .join("\n");
}

// ── Token / Nonce Helpers ────────────────────────────────────────────────────

export function generateSessionToken(): string {
  return crypto.randomBytes(32).toString("base64url");
}

export function generateMachineNonce(): string {
  return crypto.randomBytes(16).toString("hex");
}

// ── Session Machine Builder ──────────────────────────────────────────────────

/**
 * Verified state of the platform app secret that carries the protection key. The caller
 * resolves it from the secrets listing; the builder never sees the key bytes.
 */
export interface ProtectedBootstrapSecretMetadata {
  /** Must be the canonical bootstrap-key secret name (`MODEL_AUTH_ENV.protectionKey`). */
  name?: string;
  available?: boolean;
  /** Positive Fly secrets version at which the secret is verified present. */
  version?: number;
}

/** Explicit opt-in for sealed model-auth delivery (AII-500). Absent means legacy behaviour. */
export interface ProtectedModelBootstrapInput {
  /** Output of `sealModelAuthBootstrap`; re-validated here. */
  sealed: SealedModelAuthBootstrapV1;
  projectKey: string;
  /** Run envelope without a `modelAuthGrant`; the builder embeds the sealed blob and owns `AI_IMPLEMENT_RUN_CONFIG`. */
  runConfig: RunConfigV1;
  secret: ProtectedBootstrapSecretMetadata;
}

export type ProtectedBootstrapErrorCategory =
  | "protected_input_invalid"
  | "protected_legacy_credentials_rejected"
  | "protected_reserved_env_collision"
  | "protected_secret_unavailable"
  | "protected_secret_partial"
  | "protected_secret_reference_unsafe";

/** Value-free: carries a category only, never env names, values or key material. */
export class ProtectedBootstrapError extends Error {
  readonly category: ProtectedBootstrapErrorCategory;
  constructor(category: ProtectedBootstrapErrorCategory) {
    super(`protected model bootstrap rejected: ${category}`);
    this.name = "ProtectedBootstrapError";
    this.category = category;
  }
}

function isReservedModelEnvName(name: string): boolean {
  const upper = name.toUpperCase();
  return (
    (PROTECTED_BOOTSTRAP_KEYS as readonly string[]).includes(upper) ||
    (MODEL_CREDENTIAL_KEYS as readonly string[]).includes(upper) ||
    (MODEL_SESSION_KEYS as readonly string[]).includes(upper) ||
    PROTECTED_BOOTSTRAP_PREFIXES.some((p) => upper.startsWith(p))
  );
}

/** Validates everything before any env is assembled; returns the verified secrets version. */
function validateProtectedInput(input: SessionMachineInput, p: ProtectedModelBootstrapInput): number {
  if (input.anthropicApiKey || input.claudeOAuthToken) {
    throw new ProtectedBootstrapError("protected_legacy_credentials_rejected");
  }
  if (input.extraEnv && Object.keys(input.extraEnv).some(isReservedModelEnvName)) {
    throw new ProtectedBootstrapError("protected_reserved_env_collision");
  }
  const sealed = parseSealedModelAuthBootstrap(p?.sealed);
  if (!sealed.ok || typeof p.projectKey !== "string" || !p.projectKey.trim() || !p.runConfig) {
    throw new ProtectedBootstrapError("protected_input_invalid");
  }
  if (input.dispatchId !== undefined && input.dispatchId !== sealed.value.dispatchId) {
    throw new ProtectedBootstrapError("protected_input_invalid");
  }
  if (p.runConfig.credentials?.modelAuthGrant !== undefined) {
    throw new ProtectedBootstrapError("protected_input_invalid");
  }
  const secret = p.secret;
  if (!secret || (secret.name === undefined && secret.available === undefined && secret.version === undefined)) {
    throw new ProtectedBootstrapError("protected_secret_unavailable");
  }
  if (secret.name === undefined || secret.available === undefined || secret.version === undefined) {
    throw new ProtectedBootstrapError("protected_secret_partial");
  }
  if (!isSafeProtectionKeyRef(secret.name)) {
    throw new ProtectedBootstrapError("protected_secret_reference_unsafe");
  }
  if (secret.available !== true) throw new ProtectedBootstrapError("protected_secret_unavailable");
  if (!Number.isInteger(secret.version) || secret.version < 1) {
    throw new ProtectedBootstrapError("protected_secret_partial");
  }
  return secret.version;
}

export interface SessionMachineInput {
  image: string;
  issueId: string;
  issueIdentifier: string;
  issueTitle: string;
  issueDescription: string;
  owner: string;
  repo: string;
  defaultBranch: string;
  anthropicApiKey?: string;
  claudeOAuthToken?: string;
  githubToken: string;
  sessionToken: string;
  machineNonce: string;
  sessionMode?: string;
  phase?: "implementation" | "planning" | "kg-refresh";
  region?: string;
  cpus?: number;
  memoryMb?: number;
  /** Defaults to "shared". */
  cpuKind?: "shared" | "performance";
  teamKey?: string;
  teamSecretNames?: string[]; // full prefixed secret names from the Fly app (e.g. ["ENG_DATABASE_URL"])
  allTeamKeys?: string[]; // all known team keys across all mappings, used to identify foreign secrets
  flyProcessLevelSecrets?: boolean; // when true, use processes[].secrets + ignore_app_secrets (see FLY_PROCESS_LEVEL_SECRETS)
  minSecretsVersion?: number;
  orchestratorUrl?: string;
  runnerCallbackUrl?: string;
  runToken?: string;
  orchestratorApp?: string; // Fly app name of this orchestrator, stamped into machine metadata
  tenantId?: string; // client slug (e.g. "acme-corp"), stamped as tenant_id in metadata
  expectedTtlSeconds?: number; // expected machine lifetime in seconds, stamped in metadata for reaper
  extraEnv?: Record<string, string>; // per-mapping env vars injected last, overriding defaults
  machineName?: string; // overrides the default `session-<issue key>` name
  /** Stamped as `purpose` metadata; defaults to "session". "durable-runner" marks a machine a pipeline keeps between runs (the reaper skips it). */
  purpose?: "session" | typeof DURABLE_RUNNER_PURPOSE_VALUE;
  /** Stamped as `pipeline` metadata when set (e.g. "kg-refresh"). */
  pipeline?: string;
  /** Stamped as `dispatch_id` metadata when set; a retried dispatch step compares it to find its own run. */
  dispatchId?: string;
  /**
   * Opt-in sealed model-auth delivery. When set the builder carries only the sealed envelope and safe
   * dispatch fields, rejects legacy raw credentials and reserved `extraEnv` names, and throws before a
   * Machine can be created if the platform-secret protection is not verified. No plaintext fallback.
   * The protection key reaches the Machine through the app-wide platform secret, never this config.
   */
  protectedModelBootstrap?: ProtectedModelBootstrapInput;
}

export function buildSessionMachineConfig(input: SessionMachineInput): CreateMachineOpts {
  const protectedBootstrap = input.protectedModelBootstrap;
  const verifiedSecretsVersion = protectedBootstrap ? validateProtectedInput(input, protectedBootstrap) : undefined;

  const env: Record<string, string> = {
    ISSUE_ID: input.issueId,
    ISSUE_IDENTIFIER: input.issueIdentifier,
    ISSUE_TITLE: input.issueTitle,
    ISSUE_DESCRIPTION: input.issueDescription,
    GITHUB_OWNER: input.owner,
    GITHUB_REPO: input.repo,
    GITHUB_DEFAULT_BRANCH: input.defaultBranch,
    GITHUB_TOKEN: input.githubToken,
    SESSION_TOKEN: input.sessionToken,
    MACHINE_NONCE: input.machineNonce,
    SESSION_MODE: input.sessionMode ?? "autonomous",
    RUNNER_PHASE: input.phase ?? "implementation",
  };

  if (input.claudeOAuthToken) {
    env.CLAUDE_CODE_OAUTH_TOKEN = input.claudeOAuthToken;
  }
  if (input.anthropicApiKey) {
    env.ANTHROPIC_API_KEY = input.anthropicApiKey;
  }
  if (input.orchestratorUrl) {
    env.ORCHESTRATOR_URL = input.orchestratorUrl;
  }
  if (input.runnerCallbackUrl) {
    env.RUNNER_CALLBACK_URL = input.runnerCallbackUrl;
  }
  if (input.runToken) {
    env.RUN_TOKEN = input.runToken;
  }
  if (input.extraEnv) {
    Object.assign(env, input.extraEnv);
  }
  if (protectedBootstrap) {
    env[MODEL_AUTH_ENV.dispatchId] = protectedBootstrap.sealed.dispatchId;
    env[MODEL_AUTH_ENV.projectKey] = protectedBootstrap.projectKey.trim();
    env[MODEL_AUTH_ENV.backend] = MODEL_AUTH_BACKENDS.find((b) => b === protectedBootstrap.sealed.backend)!;
    env.AI_IMPLEMENT_RUN_CONFIG = encodeTrustedRunConfig({
      ...protectedBootstrap.runConfig,
      credentials: {
        ...(protectedBootstrap.runConfig.credentials ?? { version: 1 }),
        modelAuthGrant: protectedBootstrap.sealed,
      },
    });
  }

  const machineConfig: MachineConfig = {
    image: input.image,
    env,
    guest: {
      cpu_kind: input.cpuKind ?? "shared",
      cpus: input.cpus ?? 1,
      memory_mb: input.memoryMb ?? 1024,
    },
    auto_destroy: false,
    restart: { policy: "no" },
    metadata: {
      [DURABLE_RUNNER_PURPOSE_KEY]: input.purpose ?? "session",
      ...(input.pipeline ? { [DURABLE_RUNNER_PIPELINE_KEY]: input.pipeline } : {}),
      ...(input.dispatchId ? { [DURABLE_RUNNER_DISPATCH_ID_KEY]: input.dispatchId } : {}),
      issue_id: input.issueId,
      issue_identifier: input.issueIdentifier,
      repo: `${input.owner}/${input.repo}`,
      session_mode: input.sessionMode ?? "autonomous",
      ...(input.orchestratorApp ? { orchestrator_app: input.orchestratorApp } : {}),
      ...(input.tenantId ? { tenant_id: input.tenantId } : {}),
      ...(input.expectedTtlSeconds !== undefined ? { expected_ttl_seconds: String(input.expectedTtlSeconds) } : {}),
    },
  };

  // Secret isolation — two modes:
  //
  // Flag OFF (default): entrypoint-filter mode (AII-488).
  //   Classic Fly app secrets are app-wide; every machine receives every classic secret.
  //   The Machines API processes[].secrets env_var remap applies only to the non-GA
  //   named-secrets feature and has no effect on classic secrets (confirmed 2026-09-03,
  //   probe SAN-22; see https://fly.io/docs/machines/api/machines-resource/).
  //   Two env vars tell the runner entrypoint (remap_team_secrets in session/lib.sh) what to do:
  //     AI_IMPLEMENT_TEAM_SECRET_PREFIX: own-team prefix; entrypoint remaps prefixed vars to bare form.
  //     AI_IMPLEMENT_FOREIGN_SECRET_NAMES: comma-joined foreign names; entrypoint unsets these.
  //   Global secrets (no team prefix) pass through unchanged.
  //
  // Flag ON (FLY_PROCESS_LEVEL_SECRETS): process-level secrets mode (AII-491 spike).
  //   Populates processes[0].ignore_app_secrets=true so the machine receives only the
  //   explicitly listed secrets — keeping foreign secrets out at the Fly boundary, not inside
  //   the machine. The entrypoint remap/filter logic remains but is a no-op: it sees bare names
  //   and finds nothing to unset.
  //   Spike outcomes (recorded on AII-491):
  //     - QA_PROBE present, SAN_QA_PROBE and AII_PROBE_FOREIGN absent → Fly honours the list. ✅
  //     - SAN_QA_PROBE and AII_PROBE_FOREIGN present → processes not applied; add explicit entrypoint.
  //     - Nothing present → ignore_app_secrets applied but secrets list did not resolve; turn flag off.
  // Note: a falsy teamKey (e.g. Jira issues with an empty scopeKey) falls through both branches,
  // so the machine receives all classic app secrets regardless of the flag. This matches flag-off
  // behaviour for the same case and is not a regression, but the flag does not close this gap.
  // Protected mode never uses process-level secrets: ignore_app_secrets would withhold the protection
  // key, and the remap is unsupported for classic secrets. It uses the entrypoint-filter branch.
  if (!protectedBootstrap && input.flyProcessLevelSecrets && input.teamKey && input.teamSecretNames !== undefined) {
    const ownPrefix = `${input.teamKey.toUpperCase()}_`;
    const allPrefixes = (input.allTeamKeys ?? []).map((k) => `${k.toUpperCase()}_`);
    const processSecrets: MachineSecret[] = [];
    for (const name of input.teamSecretNames) {
      if (name.startsWith(ownPrefix)) {
        // Own-team secret: remap from prefixed stored name to bare env var
        processSecrets.push({ env_var: name.slice(ownPrefix.length), name });
      } else if (allPrefixes.some((p) => name.startsWith(p))) {
        // Foreign-team secret: exclude entirely
      } else {
        // Global secret (no team prefix): pass through under its stored name
        processSecrets.push({ env_var: name });
      }
    }
    machineConfig.processes = [{
      ignore_app_secrets: true,
      secrets: processSecrets,
    }];
    const ownBareNames = processSecrets.filter((s) => s.name !== undefined).map((s) => s.env_var);
    if (ownBareNames.length > 0) {
      env.AI_IMPLEMENT_FORWARDED_SECRETS = ownBareNames.join(",");
    }
  } else if (input.teamKey && input.teamSecretNames?.length) {
    const ownPrefix = `${input.teamKey.toUpperCase()}_`;
    env.AI_IMPLEMENT_TEAM_SECRET_PREFIX = ownPrefix;

    if (input.allTeamKeys?.length) {
      const foreignNames = input.teamSecretNames.filter((name) => {
        if (name.startsWith(ownPrefix)) return false;
        return input.allTeamKeys!.some((k) => name.startsWith(`${k.toUpperCase()}_`));
      });
      if (foreignNames.length > 0) {
        env.AI_IMPLEMENT_FOREIGN_SECRET_NAMES = foreignNames.join(",");
      }
    }
  }

  return {
    name: input.machineName ?? `session-${input.issueIdentifier.toLowerCase().replace(/[^a-z0-9-]/g, "-")}`,
    region: input.region ?? "iad",
    min_secrets_version:
      verifiedSecretsVersion !== undefined
        ? Math.max(verifiedSecretsVersion, input.minSecretsVersion ?? 0)
        : input.minSecretsVersion,
    config: machineConfig,
  };
}

export async function updateMachineMetadata(
  token: string,
  appName: string,
  machineId: string,
  key: string,
  value: string,
): Promise<void> {
  const res = await fetch(
    `https://api.machines.dev/v1/apps/${appName}/machines/${machineId}/metadata/${key}`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ value }),
    },
  );
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Fly Machines updateMachineMetadata failed (${res.status}): ${text}`);
  }
}
