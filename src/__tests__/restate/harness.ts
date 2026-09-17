// Shared setup for every Restate container test (AII-716). A test file under this
// folder never declares its own container, variants, start/stop hooks, or fetch
// helper — it imports them from here. See docs/restate.md § Testing for the rule.
import { RestateContainer, RestateTestEnvironment } from "@restatedev/restate-sdk-testcontainers";
import type { ServiceDefinition, VirtualObjectDefinition, WorkflowDefinition } from "@restatedev/restate-sdk-testcontainers";

// Pinned (not `latest`) to match the image cached by .github/workflows/unit-tests.yml's
// restate-tests job (`RESTATE_IMAGE_TAG`), which keys its image cache on this same value.
export const RESTATE_IMAGE_VERSION = "1.7.10";

type RestateServices = Array<
  ServiceDefinition<string, unknown> | VirtualObjectDefinition<string, unknown> | WorkflowDefinition<string, unknown>
>;

// Both variants are proven for AII-683: each environment boots the same services with
// one of the two test options RestateTestEnvironment.start supports. RestateTestEnvironment
// .start() only translates `alwaysReplay`/`disableRetries` into container config in its own
// default container-factory branch — supplying a custom `container` factory (needed here to
// pin the image version) bypasses that wiring, so each variant's factory must call the
// corresponding RestateContainer method itself.
export const VARIANTS = [
  ["alwaysReplay", (container: RestateContainer) => container.alwaysReplay()],
  ["disableRetries", (container: RestateContainer) => container.disableRetries()],
] satisfies Array<[string, (container: RestateContainer) => RestateContainer]>;

export async function startVariants(services: RestateServices): Promise<Map<string, RestateTestEnvironment>> {
  const started = await Promise.all(
    VARIANTS.map(async ([label, configure]) => {
      const env = await RestateTestEnvironment.start({
        services,
        container: () => configure(new RestateContainer(RESTATE_IMAGE_VERSION)),
      });
      return [label, env] as const;
    }),
  );
  return new Map(started);
}

export async function stopAll(environments: Map<string, RestateTestEnvironment>): Promise<void> {
  await Promise.all([...environments.values()].map((env) => env.stop()));
}

// A `void` handler answers with an empty body on success. Reading response.text() first
// (rather than calling response.json() directly) lets an empty 2xx body resolve to
// `undefined` instead of throwing a JSON-parse error — the AII-709 regression: its
// pre-extraction copy of this helper called response.json() unconditionally and failed
// all 13 scenarios against issue/revoke.
async function post<T>(url: string, label: string, body: unknown, headers?: Record<string, string>): Promise<T> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`${label} failed: ${response.status} ${text}`);
  }
  return (text === "" ? undefined : JSON.parse(text)) as T;
}

// Matches what serviceClient builds in @restatedev/restate-sdk-clients' ingress
// (doComponentInvocation): `${url}/${service}/${handler}`, with no `/restate/` prefix —
// that prefix is reserved for admin/introspection routes, not for invoking a handler.
export async function callService<T>(
  baseUrl: string,
  service: string,
  handler: string,
  body: unknown,
  headers?: Record<string, string>,
): Promise<T> {
  return post<T>(`${baseUrl}/${service}/${handler}`, `${service}/${handler}`, body, headers);
}

// Same convention for a virtual object: `${url}/${object}/${key}/${handler}`.
export async function callObject<T>(baseUrl: string, object: string, key: string, handler: string, body: unknown): Promise<T> {
  return post<T>(`${baseUrl}/${object}/${encodeURIComponent(key)}/${handler}`, `${object}/${key}/${handler}`, body);
}

export async function callWorkflow<T>(baseUrl: string, workflow: string, key: string, handler: string): Promise<T> {
  return post<T>(`${baseUrl}/${workflow}/${key}/${handler}`, `${workflow}/${key}/${handler}`, "{}");
}
