/**
 * The Stardog Run sign-in and query seam (AII-1974). Every call reads the stored
 * values from `kg-graph-source.ts`, exchanges the stored Run API token for a
 * short-lived bearer at the console, then trades the console `pass` at the edge
 * for the endpoint token — the same two hops the KG base's `StardogRunStore`
 * makes. Neither the stored token nor a header ever enters a log line or an
 * error message.
 */
import { getStardogRunToken, getStardogValues, stardogDataset } from "./kg-graph-source.js";

/**
 * One `countTriples()` call — endpoint discovery, both token exchanges and the query,
 * including each response body read — shares this one deadline. The Restate step retries
 * a timed-out attempt, so a whole try can never run longer than this.
 */
export const STARDOG_REQUEST_TIMEOUT_MS = 30_000;

/** The base store's default console host, used when the stored console is empty. */
export const DEFAULT_STARDOG_RUN_CONSOLE = "https://console.stardog.run";

/** One real query; each try is billed, so a switch sends as few as it can. */
export const STARDOG_COUNT_TRIPLES_QUERY = "SELECT (COUNT(*) AS ?count) WHERE { ?s ?p ?o }";

export interface StardogClient {
  /** Signs in and runs one COUNT query. Reads the stored values and token on every call. */
  countTriples(): Promise<number>;
}

export interface StardogClientDeps {
  /** Test seam; production uses the global `fetch`. */
  fetchImpl?: typeof fetch;
}

interface StardogJson {
  [key: string]: unknown;
}

/** The call's one deadline expired; the message names the step but never a value or header. */
class StardogDeadlineError extends Error {
  constructor(label: string) {
    super(`Stardog Run ${label} timed out after ${STARDOG_REQUEST_TIMEOUT_MS} ms`);
    this.name = "StardogDeadlineError";
  }
}

function deadlineError(label: string): Error {
  return new StardogDeadlineError(label);
}

/** `response.json()` bounded by the call's shared deadline: a stalled body must not outlive it. */
async function jsonWithinDeadline(response: Response, deadline: AbortSignal, label: string): Promise<unknown> {
  if (deadline.aborted) throw deadlineError(label);
  let onAbort: (() => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(deadlineError(label));
    deadline.addEventListener("abort", onAbort, { once: true });
  });
  try {
    return await Promise.race([response.json(), aborted]);
  } finally {
    if (onAbort) deadline.removeEventListener("abort", onAbort);
  }
}

function httpsBase(raw: string, label: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`Stardog Run ${label} is not a valid URL`);
  }
  // The stored token goes only to Stardog over HTTPS.
  if (url.protocol !== "https:" || url.username || url.password) {
    throw new Error(`Stardog Run ${label} must be an HTTPS URL without userinfo`);
  }
  return url.toString().replace(/\/+$/, "");
}

/**
 * The console's `/api/token` names the endpoint as `<ns>/<name>`, the same pair the base
 * store splits out of the console's endpoint target. The stored endpoint is the URL the
 * console shows, so its host is the namespace and its first path segment the name:
 * `https://tenant.stardog.run/kg` -> `{ ns: "tenant.stardog.run", name: "kg" }`.
 */
interface ConsoleEndpoint {
  name?: unknown;
  target?: unknown;
  address?: unknown;
}

/**
 * Mirrors `StardogRunStore`'s constructor: read the console's endpoint list and select the
 * row whose name, target or address is the stored endpoint (the stored value is a URL, so
 * an address is the usual match). No stored endpoint means the token must own exactly one.
 * The console's `target` is `<ns>/<name>`, the shape `POST /api/token` takes.
 */
function endpointTarget(runEndpoint: string, rows: ConsoleEndpoint[]): { ns: string; name: string } {
  const wanted = runEndpoint.replace(/\/+$/, "");
  const matches = runEndpoint
    ? rows.filter((row) => [row.name, row.target, row.address].some((value) => typeof value === "string" && value.replace(/\/+$/, "") === wanted))
    : rows;
  if (matches.length !== 1) {
    throw new Error(runEndpoint ? "Stardog Run endpoint did not match exactly one console endpoint" : "Stardog Run token lists more than one endpoint; set the endpoint");
  }
  const target = matches[0].target;
  const slash = typeof target === "string" ? target.indexOf("/") : -1;
  const ns = slash > 0 ? (target as string).slice(0, slash) : "";
  const name = slash > 0 ? (target as string).slice(slash + 1) : "";
  if (!ns || !name || name.includes("/")) throw new Error("Stardog Run console returned an invalid endpoint target");
  return { ns, name };
}

/** The console's endpoint list, the same read `StardogRunStore` makes in its constructor. */
async function consoleEndpoints(
  fetchImpl: typeof fetch,
  consoleBase: string,
  apiToken: string,
  deadline: AbortSignal,
): Promise<ConsoleEndpoint[]> {
  if (deadline.aborted) throw deadlineError("/api/cli/endpoints");
  let response: Response;
  try {
    response = await fetchImpl(`${consoleBase}/api/cli/endpoints`, {
      method: "GET",
      headers: { Authorization: `Bearer ${apiToken}` },
      signal: deadline,
    });
  } catch (err) {
    if (deadline.aborted) throw deadlineError("/api/cli/endpoints");
    throw new Error(`Stardog Run endpoint list request failed: ${err instanceof Error ? err.name : "request failed"}`);
  }
  if (!response.ok) throw new Error(`Stardog Run endpoint list answered HTTP ${response.status}`);
  let parsed: unknown;
  try {
    parsed = await jsonWithinDeadline(response, deadline, "/api/cli/endpoints");
  } catch (err) {
    if (err instanceof StardogDeadlineError) throw err;
    throw new Error("Stardog Run endpoint list returned an invalid response");
  }
  if (!Array.isArray(parsed)) throw new Error("Stardog Run endpoint list returned an invalid response");
  return parsed as ConsoleEndpoint[];
}

async function fetchJson(
  fetchImpl: typeof fetch,
  url: string,
  init: RequestInit,
  label: string,
  deadline: AbortSignal,
): Promise<StardogJson> {
  if (deadline.aborted) throw deadlineError(label);
  let response: Response;
  try {
    response = await fetchImpl(url, { ...init, signal: deadline });
  } catch (err) {
    if (deadline.aborted) throw deadlineError(label);
    // A transport error's text is the fetch message, never the request headers.
    const detail = err instanceof Error ? err.name : "request failed";
    throw new Error(`Stardog Run ${label} request failed: ${detail}`);
  }
  // The body is deliberately not read into the error: an upstream echo could carry a credential.
  if (!response.ok) throw new Error(`Stardog Run ${label} answered HTTP ${response.status}`);
  let body: unknown;
  try {
    body = await jsonWithinDeadline(response, deadline, label);
  } catch (err) {
    if (err instanceof StardogDeadlineError) throw err;
    throw new Error(`Stardog Run ${label} returned an invalid response`);
  }
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    throw new Error(`Stardog Run ${label} returned an invalid response`);
  }
  return body as StardogJson;
}

function stringField(body: StardogJson, field: string, label: string): string {
  const value = body[field];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Stardog Run ${label} returned no ${field}`);
  }
  return value;
}

async function signIn(fetchImpl: typeof fetch, deadline: AbortSignal): Promise<{ bearer: string; endpoint: string }> {
  const values = getStardogValues();
  const apiToken = getStardogRunToken();
  if (!apiToken) throw new Error("Stardog Run token is not set");

  const consoleBase = httpsBase(values.runConsole || DEFAULT_STARDOG_RUN_CONSOLE, "console");
  const target = endpointTarget(values.runEndpoint, await consoleEndpoints(fetchImpl, consoleBase, apiToken, deadline));

  let body = await fetchJson(
    fetchImpl,
    `${consoleBase}/api/token`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${apiToken}`, "Content-Type": "application/json" },
      body: JSON.stringify(target),
    },
    "/api/token",
    deadline,
  );

  // New console shape: a `pass` trades at the edge for the endpoint token.
  if (typeof body.pass === "string") {
    const edgeUrl = httpsBase(stringField(body, "edgeUrl", "/api/token"), "edge");
    body = await fetchJson(
      fetchImpl,
      `${edgeUrl}/edge/token`,
      { method: "POST", headers: { Authorization: `Bearer ${body.pass}` } },
      "/edge/token",
      deadline,
    );
  }

  return {
    bearer: stringField(body, "token", "sign-in"),
    endpoint: httpsBase(stringField(body, "endpoint", "sign-in"), "endpoint"),
  };
}

async function countTriples(fetchImpl: typeof fetch): Promise<number> {
  // One deadline for the whole attempt: the four requests cannot stack their own 30 s.
  const deadline = AbortSignal.timeout(STARDOG_REQUEST_TIMEOUT_MS);
  const values = getStardogValues();
  const { bearer, endpoint } = await signIn(fetchImpl, deadline);
  const form = new URLSearchParams({ query: STARDOG_COUNT_TRIPLES_QUERY });
  const dataset = stardogDataset();
  if (dataset) form.set("default-graph-uri", dataset);

  const body = await fetchJson(
    fetchImpl,
    `${endpoint}/${encodeURIComponent(values.db)}/query`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${bearer}`,
        Accept: "application/sparql-results+json",
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: form.toString(),
    },
    "count query",
    deadline,
  );

  const results = body.results;
  const bindings = results && typeof results === "object" ? (results as { bindings?: unknown }).bindings : undefined;
  const first = Array.isArray(bindings) && bindings.length > 0 ? bindings[0] : undefined;
  const countValue = first && typeof first === "object" ? (first as Record<string, unknown>).count : undefined;
  const raw = countValue && typeof countValue === "object" ? (countValue as { value?: unknown }).value : undefined;
  const count = typeof raw === "string" ? Number(raw) : NaN;
  if (!Number.isSafeInteger(count) || count < 0) {
    throw new Error("Stardog Run count query returned an invalid count");
  }
  return count;
}

/** Builds the production client. Values are re-read on every `countTriples()` call. */
export function createStardogClient(deps: StardogClientDeps = {}): StardogClient {
  const fetchImpl = deps.fetchImpl ?? fetch;
  return { countTriples: () => countTriples(fetchImpl) };
}
