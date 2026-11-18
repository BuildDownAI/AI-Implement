import { pathToFileURL } from "node:url";
import { classifyFlySecretNames, FLY_API_BASE } from "../src/fly-machines.js";
import { MODEL_AUTH_ENV } from "../src/model-auth-contract.js";

export const FLY_GRAPHQL_URL = "https://api.fly.io/graphql";
const QUERY = "query($appName: String!) { app(name: $appName) { secrets { name digest createdAt } } }";
type Secret = { name: string; digest: string };

function secretList(value: unknown): Secret[] {
  if (!Array.isArray(value)) throw new Error();
  const names = new Set<string>();
  return value.map((entry: unknown) => {
    if (!entry || typeof entry !== "object") throw new Error();
    const { name, digest } = entry as Partial<Secret>;
    if (typeof name !== "string" || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)
      || typeof digest !== "string" || names.has(name)) throw new Error();
    names.add(name);
    return { name, digest };
  });
}

/** Import-safe operator entry point. Errors deliberately never interpolate remote data. */
export async function runFlySecretsCompare(
  args: readonly string[],
  { env = process.env, fetchImpl = fetch, stdout = console.log, stderr = console.error }: {
    env?: NodeJS.ProcessEnv; fetchImpl?: typeof fetch;
    stdout?: (line: string) => void; stderr?: (line: string) => void;
  } = {},
): Promise<0 | 1 | 2> {
  let json = false;
  const fail = (error: string): 2 => {
    if (json) stdout(JSON.stringify({ error })); else stderr(error);
    return 2;
  };
  let app = "";
  let prefixes: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--json") json = true;
    else if (args[i] === "--app" && args[i + 1]) app = args[++i];
    else if (args[i] === "--prefixes" && args[i + 1]) prefixes = args[++i].split(",");
    else return fail("Usage: --app <sessions app> [--prefixes SAN,AII] [--json]");
  }
  if (!/^[a-z0-9][a-z0-9-]*$/.test(app)) return fail("A valid --app is required");
  if (prefixes.some((prefix) => !/^[A-Za-z][A-Za-z0-9]*$/.test(prefix))) return fail("Invalid --prefixes");
  const token = env.FLY_SESSIONS_TOKEN;
  if (!token?.trim()) return fail("FLY_SESSIONS_TOKEN is required");
  let httpStatus: number | undefined;
  try {
    const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
    const read = async (url: string, method: "GET" | "POST", body?: string) => {
      const response = await fetchImpl(url, {
        method, headers, body, redirect: "error", signal: AbortSignal.timeout(30_000),
      });
      if (!response.ok) { httpStatus = response.status; throw new Error(); }
      return response.json();
    };
    const graphql = await read(FLY_GRAPHQL_URL, "POST", JSON.stringify({ query: QUERY, variables: { appName: app } }));
    if (!graphql || graphql.errors !== undefined) throw new Error();
    const oldSecrets = secretList(graphql.data?.app?.secrets);
    const machines = await read(`${FLY_API_BASE}/apps/${app}/secrets`, "GET");
    const newSecrets = secretList(machines?.secrets);
    const oldMap = new Map(oldSecrets.map(({ name, digest }) => [name, digest]));
    const newMap = new Map(newSecrets.map(({ name, digest }) => [name, digest]));
    const names = [...new Set([...oldMap.keys(), ...newMap.keys()])].sort();
    const classify = (name: string) => name === MODEL_AUTH_ENV.protectionKey
      ? "protection key: launch skips it"
      : classifyFlySecretNames([name], prefixes)[0].group === "project"
        ? "project" : "global: passes to every machine in process-level mode";
    const inBoth = names.filter((name) => oldMap.has(name) && newMap.has(name))
      .map((name) => ({ name, digestDiffers: oldMap.get(name) !== newMap.get(name), classification: classify(name) }));
    const graphqlOnly = names.filter((name) => !newMap.has(name)).map((name) => ({
      name, classification: classify(name), suggestion: `fly secrets unset ${name} -a ${app}`,
    }));
    const machinesOnly = names.filter((name) => !oldMap.has(name)).map((name) => ({ name, classification: classify(name) }));
    const same = !graphqlOnly.length && !machinesOnly.length && !inBoth.some((entry) => entry.digestDiffers);
    if (json) stdout(JSON.stringify({ app, same, inBoth, graphqlOnly, machinesOnly }));
    else {
      stdout("In both lists.");
      for (const entry of inBoth) stdout(`  ${entry.name}${entry.digestDiffers ? " (digest differs)" : ""} — ${entry.classification}`);
      stdout("GraphQL only (stale). Launch no longer sees these. Suggested commands (not executed):");
      for (const entry of graphqlOnly) stdout(`  ${entry.name} — ${entry.classification}; ${entry.suggestion}`);
      stdout("Machines API only. After the move, launch sees these:");
      for (const entry of machinesOnly) stdout(`  ${entry.name} — ${entry.classification}`);
    }
    return same ? 0 : 1;
  } catch {
    return fail(httpStatus === undefined ? "Secret comparison failed" : `HTTP ${httpStatus}`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await runFlySecretsCompare(process.argv.slice(2));
}
