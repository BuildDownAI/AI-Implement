import crypto from "node:crypto";

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
}

export interface Machine {
  id: string;
  name: string;
  state: string;
  region: string;
  created_at: string;
  updated_at: string;
  config: MachineConfig;
}

export interface CreateMachineOpts {
  name?: string;
  region?: string;
  min_secrets_version?: number;
  config: MachineConfig;
}

// ── API Helpers ──────────────────────────────────────────────────────────────

const FLY_API_BASE = "https://api.machines.dev/v1";

function flyHeaders(token: string): Record<string, string> {
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

export interface SessionMachineInput {
  image: string;
  issueId: string;
  issueIdentifier: string;
  issueTitle: string;
  issueDescription: string;
  owner: string;
  repo: string;
  defaultBranch: string;
  linearApiKey?: string;
  anthropicApiKey?: string;
  claudeOAuthToken?: string;
  githubAppId: string;
  githubAppPrivateKey: string;
  sessionToken: string;
  machineNonce: string;
  sessionMode?: string;
  region?: string;
  cpus?: number;
  memoryMb?: number;
  teamKey?: string;
  teamSecretNames?: string[]; // full prefixed secret names from the Fly app (e.g. ["ENG_DATABASE_URL"])
  minSecretsVersion?: number;
  orchestratorUrl?: string;
  orchestratorApp?: string; // Fly app name of this orchestrator, stamped into machine metadata
  tenantId?: string; // client slug (e.g. "acme-corp"), stamped as tenant_id in metadata
  expectedTtlSeconds?: number; // expected machine lifetime in seconds, stamped in metadata for reaper
  extraEnv?: Record<string, string>; // per-mapping env vars injected last, overriding defaults
}

export function buildSessionMachineConfig(input: SessionMachineInput): CreateMachineOpts {
  const env: Record<string, string> = {
    ISSUE_ID: input.issueId,
    ISSUE_IDENTIFIER: input.issueIdentifier,
    ISSUE_TITLE: input.issueTitle,
    ISSUE_DESCRIPTION: input.issueDescription,
    GITHUB_OWNER: input.owner,
    GITHUB_REPO: input.repo,
    GITHUB_DEFAULT_BRANCH: input.defaultBranch,
    GITHUB_APP_ID: input.githubAppId,
    GITHUB_APP_PRIVATE_KEY: input.githubAppPrivateKey,
    SESSION_TOKEN: input.sessionToken,
    MACHINE_NONCE: input.machineNonce,
    SESSION_MODE: input.sessionMode ?? "autonomous",
  };

  if (input.linearApiKey) {
    env.LINEAR_API_KEY = input.linearApiKey;
  }
  if (input.claudeOAuthToken) {
    env.CLAUDE_CODE_OAUTH_TOKEN = input.claudeOAuthToken;
  }
  if (input.anthropicApiKey) {
    env.ANTHROPIC_API_KEY = input.anthropicApiKey;
  }
  if (input.orchestratorUrl) {
    env.ORCHESTRATOR_URL = input.orchestratorUrl;
  }
  if (input.extraEnv) {
    Object.assign(env, input.extraEnv);
  }

  const machineConfig: MachineConfig = {
    image: input.image,
    env,
    guest: {
      cpu_kind: "shared",
      cpus: input.cpus ?? 1,
      memory_mb: input.memoryMb ?? 1024,
    },
    auto_destroy: false,
    restart: { policy: "no" },
    metadata: {
      purpose: "session",
      issue_id: input.issueId,
      issue_identifier: input.issueIdentifier,
      repo: `${input.owner}/${input.repo}`,
      session_mode: input.sessionMode ?? "autonomous",
      ...(input.orchestratorApp ? { orchestrator_app: input.orchestratorApp } : {}),
      ...(input.tenantId ? { tenant_id: input.tenantId } : {}),
      ...(input.expectedTtlSeconds !== undefined ? { expected_ttl_seconds: String(input.expectedTtlSeconds) } : {}),
    },
  };

  if (input.teamKey && input.teamSecretNames?.length) {
    const prefix = `${input.teamKey.toUpperCase()}_`;
    const mappedSecrets = input.teamSecretNames
      .filter((name) => name.startsWith(prefix))
      .map((name) => ({ env_var: name.slice(prefix.length), name }));
    if (mappedSecrets.length > 0) {
      machineConfig.processes = [{ secrets: mappedSecrets }];
    }
  }

  return {
    name: `session-${input.issueIdentifier.toLowerCase().replace(/[^a-z0-9-]/g, "-")}`,
    region: input.region ?? "iad",
    min_secrets_version: input.minSecretsVersion,
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
