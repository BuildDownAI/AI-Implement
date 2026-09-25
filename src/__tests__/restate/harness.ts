// Shared setup for every Restate container test (AII-716). A test file under this
// folder never declares its own container, variants, start/stop hooks, or fetch
// helper — it imports them from here. See docs/restate.md § Testing for the rule.
import { RestateContainer, RestateTestEnvironment } from "@restatedev/restate-sdk-testcontainers";
import type { ServiceDefinition, VirtualObjectDefinition, WorkflowDefinition } from "@restatedev/restate-sdk-testcontainers";
import { createEndpointHandler } from "@restatedev/restate-sdk/node";
import * as http2 from "node:http2";
import type { AddressInfo } from "node:net";

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

/** Fault-injection scenarios need the engine's normal retry policy. Disk storage
 * keeps the same journal across a restart of the pinned sidecar container. */
export function startRetryEnabled(services: RestateServices): Promise<RestateTestEnvironment> {
  return RestateTestEnvironment.start({
    services,
    storage: "disk",
    container: () => new RestateContainer(RESTATE_IMAGE_VERSION),
  });
}

/** Replace only the SDK endpoint, keeping the Restate container and its journal.
 * A sidecar restart after this closes its old HTTP/2 sessions and reconnects to
 * the replacement endpoint at the same address. */
export async function replaceEndpoint(env: RestateTestEnvironment, services: RestateServices): Promise<http2.Http2Server> {
  const old = env.startedRestateHttpServer;
  const address = old.address() as AddressInfo;
  old.close();
  const replacement = http2.createServer(createEndpointHandler({ services }));
  await new Promise<void>((resolve, reject) => {
    replacement.once("error", reject);
    replacement.listen(address.port, address.address, resolve);
  });
  return replacement;
}

export async function stopAll(environments: Map<string, RestateTestEnvironment>): Promise<void> {
  await Promise.all([...environments.values()].map((env) => env.stop()));
}

/**
 * Wraps an async external effect so its first call performs the real effect and then
 * throws, simulating the "commit/dispatch/write succeeded but the caller crashed before
 * observing the acknowledgement" window a fault-injection scenario needs: the durable
 * `ctx.run` step this effect lives in sees a thrown error and the engine retries it, so
 * the assertion is "did the effect run exactly once, and did the retry reconcile instead
 * of repeating it" — never a journal internal. Every call after the first behaves
 * normally, so a scenario that also needs the effect's eventual real return value
 * (e.g. to keep driving the same fixture) still gets it on the retried attempt.
 */
export function crashAfterFirstCall<Args extends unknown[], R>(
  effect: (...args: Args) => Promise<R>,
): (...args: Args) => Promise<R> {
  let crashed = false;
  return async (...args: Args): Promise<R> => {
    const result = await effect(...args);
    if (!crashed) {
      crashed = true;
      throw new Error("injected crash: effect committed, caller never observed the response");
    }
    return result;
  };
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

export async function callWorkflow<T>(baseUrl: string, workflow: string, key: string, handler: string, body: unknown = {}): Promise<T> {
  return post<T>(`${baseUrl}/${workflow}/${encodeURIComponent(key)}/${handler}`, `${workflow}/${key}/${handler}`, body);
}

export async function attachWorkflow<T>(baseUrl: string, workflow: string, key: string): Promise<T> {
  return post<T>(`${baseUrl}/restate/attach`, `${workflow}/${key}/attach`, {
    target: "workflow", workflowName: workflow, workflowKey: key,
  });
}
