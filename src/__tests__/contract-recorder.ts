// Shared real-route recorder. Keep the legacy fixture envelope byte-compatible with Control-Plane.
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { expect, vi } from "vitest";
import { SignJWT, exportJWK, generateKeyPair } from "jose";
import type * as restate from "@restatedev/restate-sdk";
import type * as AdminModule from "../admin.js";
import type * as ToolsModule from "../restate/tools.js";
import { fakeFetch } from "./helpers/fake-fetch.js";

const ISSUER = "https://cp.builddown.test";
const BASE_URL = "https://orch-a.example.com";

export interface Exchange {
  request: { method: string; path: string; body: { args: Record<string, unknown> } };
  response: {
    status: number;
    body: { content: Array<{ type: string; text: string }>; isError?: boolean };
  };
}

class MockRequest extends EventEmitter {
  constructor(public url: string, public method: string, public headers: Record<string, string>, body: string) {
    super();
    const release = (event: string | symbol): void => {
      if (event !== "data" && event !== "end") return;
      this.off("newListener", release);
      process.nextTick(() => {
        this.emit("data", Buffer.from(body));
        this.emit("end");
      });
    };
    this.on("newListener", release);
  }
}

class MockResponse {
  statusCode = 200;
  body = "";
  private resolver!: () => void;
  done = new Promise<void>((resolve) => { this.resolver = resolve; });
  writeHead(statusCode: number): this {
    this.statusCode = statusCode;
    return this;
  }
  end(chunk?: string): void {
    this.body = chunk ?? "";
    this.resolver();
  }
}

function fakeContext(handlerName: string): restate.Context {
  return {
    request: () => ({ target: { handler: handlerName } }),
    run: async (name: unknown, action?: unknown) => (typeof name === "function" ? (name as () => unknown) : (action as () => unknown))(),
  } as unknown as restate.Context;
}

/** Simulate ingress deserialization with the registered handler's own input serde. */
function ingress(tools: typeof ToolsModule, handlerName: string): typeof fetch {
  // Legacy service() definitions retain their implementation in `service` at runtime;
  // the SDK's public definition type hides it from clients.
  const definition = tools.orchestratorTools as unknown as {
    service: Record<string, (ctx: restate.Context, input: unknown) => Promise<unknown>>;
  };
  const handler = definition.service[handlerName];
  if (!handler) throw new Error(`Unknown contract tool: ${handlerName}`);
  // The SDK attaches its Handler wrapper with a private symbol. Keep this seam here;
  // fail explicitly if an SDK upgrade changes it, rather than duplicating tool schemas.
  const wrapper = Object.getOwnPropertySymbols(handler)
    .map((symbol) => (handler as unknown as Record<symbol, unknown>)[symbol])
    .find((value): value is { options: { input: restate.Serde<unknown> } } =>
      typeof value === "object" && value !== null && "options" in value);
  if (!wrapper?.options.input) throw new Error(`No registered input serde for ${handlerName}`);
  return (async (_url, init) => {
    let input: unknown;
    try {
      input = wrapper.options.input.deserialize(new TextEncoder().encode(String(init?.body ?? "{}")));
    } catch (error) {
      return Response.json({ code: 400, message: `Failed to deserialize input: ${(error as Error).message}`, source: "invocation" }, { status: 400 });
    }
    const invoke = handler as (ctx: restate.Context, input: unknown) => Promise<unknown>;
    return Response.json(await invoke(fakeContext(handlerName), input));
  }) as typeof fetch;
}

export async function recordExchange(tool: string, body: { args: Record<string, unknown> }, opts?: { scope?: string }): Promise<Exchange> {
  // Resolve after testDb() resets modules so handlers use the current database.
  const admin = await import("../admin.js");
  const tools = await import("../restate/tools.js");
  const { callTool } = await import("../restate/tools-client.js");
  const cp = await import("../control-plane-token.js");
  cp.resetControlPlaneTokenCache();
  const pair = await generateKeyPair("ES256");
  const signingKey = pair.privateKey;
  const jwk = { ...(await exportJWK(pair.publicKey)), kid: "k1", alg: "ES256", use: "sig" };
  fakeFetch({
    "GET /.well-known/openid-configuration": { json: { jwks_uri: `${ISSUER}/jwks` } },
    "GET /jwks": { json: { keys: [jwk] } },
  }).install();
  vi.stubEnv("BUILDDOWN_OIDC_ISSUER", ISSUER);
  vi.stubEnv("OAUTH_REDIRECT_BASE_URL", BASE_URL);
  const now = Math.floor(Date.now() / 1000);
  const token = await new SignJWT({ scope: opts?.scope ?? "orchestrator:read" })
    .setProtectedHeader({ alg: "ES256", kid: "k1" })
    .setIssuer(ISSUER)
    .setAudience(BASE_URL)
    .setIssuedAt(now)
    .setExpirationTime(now + 300)
    .sign(signingKey);
  const deps: AdminModule.AdminDeps = {
    callTool: async (name, args, caller) => {
      expect(caller).toEqual({ kind: "service", email: null, role: "user" });
      return callTool(name, args, caller, {
        restateReady: () => true,
        permitsExternalCall: () => true,
        ingressBaseUrl: "http://restate.test",
        fetchImpl: ingress(tools, name),
      });
    },
  };
  const req = new MockRequest(`/api/tools/${tool}`, "POST", { authorization: `Bearer ${token}` }, JSON.stringify(body));
  const res = new MockResponse();
  const config = { adminAccessCode: null, flySessionsToken: null, flySessionsApp: null, flySessionsRegion: null, githubAppId: "a", githubAppPrivateKey: "k" };
  const registry = { forMapping: async () => null, forAllMappings: async () => [], invalidate: () => {} };
  admin.handleAdminRequest(req as never, res as never, config as never, registry as never, deps);
  await res.done;
  return {
    request: { method: req.method, path: req.url, body },
    response: { status: res.statusCode, body: JSON.parse(res.body) },
  };
}

export function checkExchange(tool: string, scenario: string, recorded: Exchange): void {
  const DIR = new URL(`../../docs/contracts/${tool}/`, import.meta.url);
  const file = new URL(`${scenario}.json`, DIR);
  // Control-Plane consumes the original body/status/body envelope. Keep this
  // compatibility mapping at the fixture boundary, not in the public Exchange.
  const fixture = { request: recorded.request.body, status: recorded.response.status, response: recorded.response.body };
  const text = `${JSON.stringify(fixture, null, 2)}\n`;
  if (process.env.UPDATE_CONTRACT_FIXTURES === "1") {
    mkdirSync(DIR, { recursive: true });
    writeFileSync(file, text);
    return;
  }
  const hint = `Regenerate with UPDATE_CONTRACT_FIXTURES=1 npx vitest run ${tool === "list_job_accounting" ? "src/__tests__/job-accounting-contract.test.ts" : `src/__tests__/${tool.replaceAll("_", "-")}-contract.test.ts`}, and tell the control plane: it copies these files.`;
  if (!existsSync(file)) throw new Error(`Recorded exchange docs/contracts/${tool}/${scenario}.json is missing. ${hint}`);
  if (readFileSync(file, "utf8") !== text) {
    throw new Error(`The ${tool} response for "${scenario}" differs from docs/contracts/${tool}/${scenario}.json. ${hint}\nActual:\n${text}`);
  }
}

