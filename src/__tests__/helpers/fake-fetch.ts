// A fake fetch for tests (AII-925). A test describes the HTTP API it expects as a route table
// and passes `fake.fetch` wherever a module takes `fetchImpl`, or calls `fake.install()` for code
// that calls the global fetch. Every request is recorded, and a request the table does not expect
// fails the test, even when the code under test catches the error. See docs/unit-tests.md § Harnesses.
import { onTestFinished } from "vitest";

export type Method = "GET" | "HEAD" | "POST" | "PUT" | "PATCH" | "DELETE";

/** One request as the fake received it, parsed the way a server would see it. */
export interface FetchCall {
  method: string;
  url: URL;
  /** The URL's path without its query string: what a route key matches. */
  path: string;
  headers: Headers;
  /** The request body as text; empty when there is none. */
  body: string;
  /** The caller's `AbortSignal`: `init.signal`, else the signal of a `Request` passed as input, else undefined.
   *  Read from the caller's arguments, because the `Request` built here carries a signal even when the caller passed none. */
  signal: AbortSignal | undefined;
}

/** A response to build fresh for each request: `json` is serialized, otherwise `text` is sent as is. */
export interface ReplyInit {
  status?: number;
  json?: unknown;
  text?: string;
  headers?: Record<string, string>;
}

/** A static reply, or a function of the request for a fake that keeps state between requests.
 *  A function may return a `Response` it builds itself; a static `Response` is not accepted,
 *  because its body can be read only once. */
export type Reply = ReplyInit | ((call: FetchCall) => Response | ReplyInit | Promise<Response | ReplyInit>);

/** Keys are `"<METHOD> <path>"`. A list of replies is served in order, one per request. */
export type Routes = Partial<Record<`${Method} /${string}`, Reply | Reply[]>>;

/** A reply that never answers on its own, for proving a request is bounded by its timeout.
 *  It rejects with the signal's reason once the caller aborts, as `fetch` does, and stays pending when no signal was passed. */
export const hangUntilAborted: Reply = ({ signal }) =>
  new Promise<never>((_resolve, reject) => {
    if (!signal) return;
    if (signal.aborted) return reject(signal.reason);
    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  });

export interface FakeFetch {
  fetch: typeof fetch;
  /** Every request, matched or not, in the order received. */
  calls: FetchCall[];
  /** Replaces the global `fetch` with this fake until the test finishes. */
  install(): void;
}

/** Builds a fake fetch from a route table. Call it from a test or a `beforeEach`: it fails the
 *  test when it finishes if any request matched no route, or outran its route's list of replies. */
export function fakeFetch(routes: Routes): FakeFetch {
  const calls: FetchCall[] = [];
  const served = new Map<string, number>();
  const problems: string[] = [];

  onTestFinished(() => {
    if (problems.length > 0) throw new Error(problems.join("\n"));
  });

  function refuse(message: string): never {
    problems.push(message);
    throw new Error(message);
  }

  const fakeFetchImpl: typeof fetch = async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    const signal = init?.signal ?? (input instanceof Request ? input.signal : undefined);
    const call: FetchCall = { method: request.method, url, path: url.pathname, headers: request.headers, body: await request.text(), signal };
    calls.push(call);

    const key = `${call.method} ${call.path}`;
    const route = routes[key as keyof Routes];
    if (route === undefined) refuse(`fakeFetch: no route for ${key}`);

    let reply: Reply;
    if (Array.isArray(route)) {
      const count = served.get(key) ?? 0;
      served.set(key, count + 1);
      if (count >= route.length) refuse(`fakeFetch: ${key} was requested ${count + 1} times; its route has ${route.length} replies`);
      reply = route[count];
    } else {
      reply = route;
    }

    const resolved = typeof reply === "function" ? await reply(call) : reply;
    if (resolved instanceof Response) return resolved;
    const responseInit = { status: resolved.status ?? 200, headers: resolved.headers };
    return resolved.json !== undefined
      ? Response.json(resolved.json, responseInit)
      : new Response(resolved.text ?? null, responseInit);
  };

  return {
    fetch: fakeFetchImpl,
    calls,
    install() {
      const original = globalThis.fetch;
      onTestFinished(() => {
        globalThis.fetch = original;
      });
      globalThis.fetch = fakeFetchImpl;
    },
  };
}
