/** Persisted KG configuration. Startup/seeding and UI callers are added separately. */
import { getDb } from "./dedup.js";
import { STARDOG_RUN_TOKEN_REF } from "./kg-secret-refs.js";
import { createModelProtectedSecrets } from "./model-protected-secrets.js";

export const KG_GRAPH_SOURCE_SETTING_KEY = "kg_graph_source";
export const KG_NAMESPACE_SETTING_KEY = "kg_namespace";
export const KG_GRAPH_NAME_SETTING_KEY = "kg_graph_name";
export const KG_STARDOG_RUN_TOKEN_HANDLED_SETTING_KEY = "kg_stardog_run_token_handled";
export { STARDOG_RUN_TOKEN_REF };
export const DEFAULT_STARDOG_RUN_PLATFORM = "https://app.stardog.run";
export type KgGraphSource = "sidecar" | "stardog_run";

const keys = {
  db: "kg_stardog_db",
  runEndpoint: "kg_stardog_run_endpoint",
  runConsole: "kg_stardog_run_console",
  runPlatform: "kg_stardog_run_platform",
  namespace: KG_NAMESPACE_SETTING_KEY,
  graphName: KG_GRAPH_NAME_SETTING_KEY,
} as const;

export interface StardogValues {
  db: string;
  runEndpoint: string;
  runConsole: string;
  runPlatform: string;
  namespace: string;
  graphName: string;
  tokenSet: boolean;
}
export type StardogValuesUpdate = Partial<Omit<StardogValues, "tokenSet">> & {
  /** Empty string clears the token; omission preserves it. */
  token?: string;
};

function read(key: string): string {
  const row = getDb().prepare("SELECT value FROM settings WHERE key = ?").get(key) as { value: string } | undefined;
  return row?.value ?? "";
}
function write(key: string, value: string): void {
  getDb().prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)").run(key, value);
}

export function getKgGraphSource(): KgGraphSource {
  return read(KG_GRAPH_SOURCE_SETTING_KEY) === "stardog_run" ? "stardog_run" : "sidecar";
}
export function setKgGraphSource(source: KgGraphSource): void {
  if (source !== "sidecar" && source !== "stardog_run") throw new Error("Invalid KG graph source");
  write(KG_GRAPH_SOURCE_SETTING_KEY, source);
}

function token(): string | undefined {
  const value = createModelProtectedSecrets().resolve(STARDOG_RUN_TOKEN_REF);
  return typeof value === "string" ? value : undefined;
}

/** The decrypted Stardog Run token. Contains a credential: never log it or return it to a caller. */
export function getStardogRunToken(): string | undefined {
  return token();
}

/** Safe for setup checks and admin responses: never includes the token. */
export function getStardogValues(): StardogValues {
  return {
    db: read(keys.db),
    runEndpoint: read(keys.runEndpoint),
    runConsole: read(keys.runConsole),
    runPlatform: read(keys.runPlatform) || DEFAULT_STARDOG_RUN_PLATFORM,
    namespace: read(keys.namespace),
    graphName: read(keys.graphName),
    tokenSet: token() !== undefined,
  };
}

function validate(field: keyof typeof keys, value: string): void {
  if (typeof value !== "string" || value.length > 4096 || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new Error(`Invalid Stardog field: ${field}`);
  }
  if (!value) return;
  if (field === "graphName" && !/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(value)) {
    throw new Error("Invalid KG graph name");
  }
  if (["runEndpoint", "runConsole", "runPlatform", "namespace"].includes(field)) {
    let url: URL;
    try { url = new URL(value); } catch { throw new Error(`Invalid Stardog URL: ${field}`); }
    if (!["https:", "http:"].includes(url.protocol) || url.username || url.password) {
      throw new Error(`Invalid Stardog URL: ${field}`);
    }
  }
}

/** Validates a partial update without writing, so a caller can reject a whole request before touching rows. */
export function validateStardogValues(values: StardogValuesUpdate): void {
  for (const field of Object.keys(keys) as Array<keyof typeof keys>) {
    if (values[field] !== undefined) validate(field, values[field]);
  }
  if (values.token !== undefined && typeof values.token !== "string") throw new Error("Invalid Stardog token");
}

/** Partial updates are atomic, including the encrypted token. Errors never contain supplied values. */
export function setStardogValues(values: StardogValuesUpdate): void {
  validateStardogValues(values);
  getDb().transaction(() => {
    if (values.token !== undefined) {
      const store = createModelProtectedSecrets();
      const result = values.token === "" ? store.delete(STARDOG_RUN_TOKEN_REF) : store.write(STARDOG_RUN_TOKEN_REF, values.token);
      if (!result.ok) throw new Error(`Stardog token storage failed: ${result.code}`);
      // Also written inside this transaction: a failed store leaves no marker, so boot retries.
      write(KG_STARDOG_RUN_TOKEN_HANDLED_SETTING_KEY, "1");
    }
    for (const field of Object.keys(keys) as Array<keyof typeof keys>) {
      const value = values[field];
      if (value !== undefined) write(keys[field], value);
    }
  })();
}

export function stardogDataset(): string | undefined {
  const name = read(KG_GRAPH_NAME_SETTING_KEY);
  return name ? `tag:stardog:kit:alias:${name.replaceAll("-", "_")}` : process.env.KG_STARDOG_DATASET;
}

/** Contains plaintext credentials: only pass this to the sidecar child, never log or expose it. */
export function stardogChildEnv(): NodeJS.ProcessEnv {
  const values = getStardogValues();
  const runToken = token();
  return {
    KG_BACKEND: getKgGraphSource(),
    KG_STARDOG_DB: values.db,
    KG_STARDOG_RUN_ENDPOINT: values.runEndpoint,
    KG_STARDOG_RUN_CONSOLE: values.runConsole,
    KG_STARDOG_RUN_PLATFORM: values.runPlatform,
    KG_STARDOG_DATASET: stardogDataset(),
    // Omitted, not empty: the child env starts from process.env, so a stored token that
    // cannot be read must not replace a working KG_STARDOG_RUN_TOKEN from the environment.
    ...(runToken !== undefined ? { KG_STARDOG_RUN_TOKEN: runToken } : {}),
    KG_NAMESPACE: values.namespace,
  };
}
