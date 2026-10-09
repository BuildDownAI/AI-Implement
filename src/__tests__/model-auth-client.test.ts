import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createCipheriv, randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, symlinkSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync, existsSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ModelAuthClientError,
  acceptModelAuthBootstrap,
  buildModelInvocationEnv,
  CHATGPT_PLAN_ACCESS_TOKEN_ENV,
  createModelAuthClient,
  createModelAuthTransport,
  openSealedModelAuthBootstrap,
  stripProtectedEnv,
  type ExpectedBootstrapContext,
  type LocalCredentialPort,
  type ModelAuthClientOptions,
  type ModelAuthTransport,
} from "../model-auth-client.js";
import {
  MODEL_AUTH_ROUTES,
  sealedBootstrapAad,
  type ModelAuthGrantBootstrapV1,
} from "../model-auth-contract.js";
import { DEFAULT_RETRY_POLICY } from "../pipeline/retry-backoff.js";

// Synthetic sentinels only. No real credential, no network, no paid call.
const S_API = "SENTINEL-api-key-0001";
const S_BEARER = "SENTINELbearer0123456789abcdefghijklmnop";
const S_SESSION = '{"token":"SENTINEL-session-0002"}';
const S_REFRESHED = '{"token":"SENTINEL-refreshed-0003"}';
const S_AWS_SECRET = "SENTINEL-aws-secret-0004";
const S_AWS_TOKEN = "SENTINEL-aws-session-0005";
const S_INHERITED = "SENTINEL-inherited-0006";
const NOW = 1_700_000_000_000;

const ctx: ExpectedBootstrapContext = { dispatchId: "disp-1", projectKey: "proj", snapshotId: "snap-1", backend: "fly" };

function grant(overrides: Partial<ModelAuthGrantBootstrapV1> = {}): ModelAuthGrantBootstrapV1 {
  return {
    version: 1,
    audience: "model-auth",
    grantId: "grant-1",
    dispatchId: "disp-1",
    projectKey: "proj",
    snapshotId: "snap-1",
    backend: "fly",
    expiresAt: NOW + 60_000,
    bearer: S_BEARER,
    bindings: [
      { stage: "implementation", profileId: "sub", profileRevision: 1, authMode: "claude-subscription", ownerGeneration: 3 },
      { stage: "review", profileId: "api", profileRevision: 1, authMode: "openai-api-key" },
      { stage: "planning", profileId: "bed", profileRevision: 1, authMode: "bedrock" },
    ],
    ...overrides,
  };
}

function seal(g: unknown, key: Buffer, opts: { aad?: string; dispatchId?: string } = {}) {
  const nonce = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key, nonce, { authTagLength: 16 });
  c.setAAD(Buffer.from(opts.aad ?? sealedBootstrapAad("disp-1", "fly")));
  const ct = Buffer.concat([c.update(JSON.stringify(g), "utf8"), c.final()]);
  return {
    version: 1,
    algorithm: "aes-256-gcm",
    dispatchId: opts.dispatchId ?? "disp-1",
    backend: "fly",
    nonce: nonce.toString("base64url"),
    ciphertext: ct.toString("base64url"),
    tag: c.getAuthTag().toString("base64url"),
  };
}

function category(fn: () => unknown): string {
  try {
    fn();
  } catch (e) {
    return (e as ModelAuthClientError).category;
  }
  return "no-error";
}

async function categoryAsync(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    return e instanceof ModelAuthClientError ? e.category : `other:${(e as Error).name}`;
  }
  return "no-error";
}

describe("bootstrap", () => {
  const key = randomBytes(32);

  it("opens a sealed bootstrap and validates context", () => {
    const g = openSealedModelAuthBootstrap({ sealed: seal(grant(), key), protectionKey: key, expected: ctx, now: () => NOW });
    expect(g.grantId).toBe("grant-1");
  });

  it("rejects expiry and wrong dispatch/project/snapshot/backend", () => {
    const run = (g: ModelAuthGrantBootstrapV1, expected = ctx) =>
      category(() => acceptModelAuthBootstrap(g, expected, () => NOW));
    expect(run(grant({ expiresAt: NOW }))).toBe("bootstrap_expired");
    expect(run(grant(), { ...ctx, dispatchId: "other" })).toBe("bootstrap_context_mismatch");
    expect(run(grant(), { ...ctx, projectKey: "other" })).toBe("bootstrap_context_mismatch");
    expect(run(grant(), { ...ctx, snapshotId: "other" })).toBe("bootstrap_context_mismatch");
    expect(run(grant(), { ...ctx, backend: "gha" })).toBe("bootstrap_context_mismatch");
  });

  it("fails malformed, tampered and mismatched sealed data with safe categories and never leaks the key", () => {
    const open = (sealed: unknown, k = key) =>
      openSealedModelAuthBootstrap({ sealed, protectionKey: k, expected: ctx, now: () => NOW });
    const good = seal(grant(), key);
    expect(category(() => open({ ...good, tag: "!".repeat(22) }))).toBe("bootstrap_malformed");
    expect(category(() => open({ ...good, tag: "A".repeat(22) }))).toBe("bootstrap_authentication_failed");
    const flipped = good.ciphertext.startsWith("A") ? "B" + good.ciphertext.slice(1) : "A" + good.ciphertext.slice(1);
    expect(category(() => open({ ...good, ciphertext: flipped }))).toBe("bootstrap_authentication_failed");
    expect(category(() => open(seal(grant(), key, { aad: "wrong-aad" })))).toBe("bootstrap_authentication_failed");
    expect(category(() => open(good, randomBytes(32)))).toBe("bootstrap_authentication_failed");
    expect(category(() => open(good, randomBytes(16)))).toBe("bootstrap_key_invalid");
    expect(category(() => open({ ...good, extra: 1 }))).toBe("bootstrap_malformed");
    expect(category(() => open(seal({ not: "a grant" }, key)))).toBe("bootstrap_malformed");
    // Envelope dispatch differs from the decrypted grant (AAD follows the envelope).
    const other = seal(grant({ dispatchId: "disp-2" }), key);
    expect(category(() => open(other))).toBe("bootstrap_binding_mismatch");
    try {
      open({ ...good, tag: "A".repeat(22) });
    } catch (e) {
      expect(String((e as Error).message)).not.toContain(key.toString("base64url"));
      expect(String((e as Error).message)).not.toContain(S_BEARER);
    }
  });

  it("strips protected names from an environment", () => {
    expect(stripProtectedEnv({ A: "1", KEY: "k", B: undefined }, ["KEY"])).toEqual({ A: "1" });
  });
});

const UNLISTED = [
  "DATABASE_URL", "LINEAR_API_KEY", "STRIPE_KEY", "MY_APP_SECRET",
  "COMPOSER_AUTH", "GIT_DEPENDENCY_TOKEN_FILE", "GIT_DEPENDENCY_CALLBACK_URL",
  "LC_SECRET", "LC_TOKEN",
];
const SAFE = {
  PATH: "/bin", HOME: "/home/x", TMPDIR: "/tmp", LANG: "C", LC_ALL: "C", LC_CTYPE: "C", LC_PAPER: "C",
  SSL_CERT_FILE: "/ca.pem", NODE_EXTRA_CA_CERTS: "/ca2.pem", HTTPS_PROXY: "http://proxy:3128",
};
const sentinelEnv = () => ({ ...SAFE, ...Object.fromEntries(UNLISTED.map((k) => [k, "synthetic-" + k])) });

describe("buildModelInvocationEnv", () => {
  const inheritedEnv = {
    PATH: "/bin",
    ANTHROPIC_API_KEY: S_INHERITED,
    OPENAI_API_KEY: S_INHERITED,
    CLAUDE_CODE_OAUTH_TOKEN: S_INHERITED,
    AWS_ACCESS_KEY_ID: S_INHERITED,
    AWS_PROFILE: "x",
    CODEX_HOME: "/inherited",
    MODEL_AUTH_KEY: "protect-me",
  };

  it("passes only the selected API key even when other credentials are inherited", () => {
    const { env, strippedKeys } = buildModelInvocationEnv({
      authMode: "openai-api-key",
      secret: { kind: "api-key", apiKey: S_API },
      inheritedEnv,
      protectedKeys: ["MODEL_AUTH_KEY"],
    });
    expect(env.CODEX_API_KEY).toBe(S_API);
    expect(env).not.toHaveProperty("OPENAI_API_KEY");
    expect(env).not.toHaveProperty("CODEX_HOME");
    expect(env.PATH).toBe("/bin");
    expect(JSON.stringify(env)).not.toContain(S_INHERITED);
    expect(env).not.toHaveProperty("ANTHROPIC_API_KEY");
    expect(env).not.toHaveProperty("AWS_ACCESS_KEY_ID");
    expect(env).not.toHaveProperty("MODEL_AUTH_KEY");
    expect(strippedKeys).toContain("ANTHROPIC_API_KEY");
  });

  it("gives Bedrock the AWS bundle, with the session token only when present", () => {
    const base = { kind: "aws-bedrock" as const, region: "us-east-1", accessKeyId: "AKIASENTINEL", secretAccessKey: S_AWS_SECRET };
    const without = buildModelInvocationEnv({ authMode: "bedrock", secret: base, inheritedEnv });
    expect(without.env.AWS_SECRET_ACCESS_KEY).toBe(S_AWS_SECRET);
    expect(without.env.AWS_REGION).toBe("us-east-1");
    expect(without.env).not.toHaveProperty("AWS_SESSION_TOKEN");
    expect(without.env).not.toHaveProperty("AWS_PROFILE");
    expect(without.env).not.toHaveProperty("ANTHROPIC_API_KEY");
    const withToken = buildModelInvocationEnv({ authMode: "bedrock", secret: { ...base, sessionToken: S_AWS_TOKEN }, inheritedEnv });
    expect(withToken.env.AWS_SESSION_TOKEN).toBe(S_AWS_TOKEN);
  });

  it("rejects a bedrock mode with a generic api key and an unknown mode with no fallback", () => {
    expect(
      category(() => buildModelInvocationEnv({ authMode: "bedrock", secret: { kind: "api-key", apiKey: S_API }, inheritedEnv })),
    ).toBe("credential_source_mismatch");
    expect(
      category(() =>
        buildModelInvocationEnv({
          authMode: "mystery" as never,
          secret: { kind: "api-key", apiKey: S_API },
          inheritedEnv,
        }),
      ),
    ).toBe("unsupported_auth_mode");
  });

  it("points subscription modes at the private directory and drops inherited homes", () => {
    const { env } = buildModelInvocationEnv({
      authMode: "codex-subscription",
      secret: { kind: "session", sessionData: S_SESSION, stateSequence: 0 },
      authDir: "/private",
      inheritedEnv,
    });
    expect(env.CODEX_HOME).toBe("/private");
    expect(env).not.toHaveProperty("OPENAI_API_KEY");
  });

  it("drops unlisted inherited names, records names only, keeps safe context", () => {
    const out = buildModelInvocationEnv({
      authMode: "anthropic-api-key",
      secret: { kind: "api-key", apiKey: S_API },
      inheritedEnv: sentinelEnv(),
    });
    for (const k of UNLISTED) {
      expect(out.env).not.toHaveProperty(k);
      expect(out.strippedKeys).toContain(k);
    }
    expect(JSON.stringify(out.env)).not.toContain("synthetic-");
    expect(JSON.stringify(out.strippedKeys)).not.toContain("synthetic-");
    for (const [k, v] of Object.entries(SAFE)) expect(out.env[k]).toBe(v);
  });

  it("protected and forwarded names override safe-context names", () => {
    const out = buildModelInvocationEnv({
      authMode: "anthropic-api-key",
      secret: { kind: "api-key", apiKey: S_API },
      inheritedEnv: { ...SAFE, AI_IMPLEMENT_FORWARDED_SECRETS: "HOME, LANG" },
      protectedKeys: ["HTTPS_PROXY"],
    });
    expect(out.env).not.toHaveProperty("HOME");
    expect(out.env).not.toHaveProperty("LANG");
    expect(out.env).not.toHaveProperty("HTTPS_PROXY");
    expect(out.env.PATH).toBe("/bin");
  });

});

describe("client", () => {
  let root: string;
  let authRoot: string;
  let workspace: string;
  let artifacts: string;
  let sleeps: number[];

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "model-auth-client-"));
    authRoot = join(root, "auth");
    workspace = join(root, "workspace");
    artifacts = join(workspace, "ai-output");
    mkdirSync(authRoot);
    mkdirSync(workspace);
    sleeps = [];
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  type Handler = (route: string, body: Record<string, unknown>) => { status: number; body: unknown } | Promise<never>;
  it("applies the allowlist to the process.env default", async () => {
    const saved = { ...process.env };
    Object.assign(process.env, sentinelEnv());
    try {
      const dir = mkdtempSync(join(tmpdir(), "model-auth-default-"));
      try {
        const { transport } = fakeTransport((route) => reply(route, ack()));
        const client = createModelAuthClient({
          source: { kind: "hosted", grant: grant(), transport },
          authRoot: dir,
          forbiddenRoots: [],
          now: () => NOW,
          sleep: async () => {},
        });
        await client.checkout({ profileId: "sub", authMode: "claude-subscription" as const });
        await client.invoke("sub", async (inv) => {
          for (const k of UNLISTED) expect(inv.env).not.toHaveProperty(k);
          expect(JSON.stringify(inv.env)).not.toContain("synthetic-");
          expect(inv.env.PATH).toBe(process.env.PATH);
        });
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    } finally {
      for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
      Object.assign(process.env, saved);
    }
  });

  function fakeTransport(handler: Handler) {
    const calls: Array<{ route: string; raw: string }> = [];
    const transport: ModelAuthTransport = {
      post: vi.fn(async (route: string, raw: string) => {
        calls.push({ route, raw });
        return handler(route, JSON.parse(raw) as Record<string, unknown>);
      }),
    };
    return { transport, calls };
  }

  const okCheckout = (over: Record<string, unknown> = {}) => ({
    status: 200,
    body: {
      version: 1,
      ok: true,
      profileId: "sub",
      authMode: "claude-subscription",
      ownerGeneration: 3,
      secret: { kind: "session", sessionData: S_SESSION, stateSequence: 5 },
      ...over,
    },
  });
  const ack = (over: Record<string, unknown> = {}) => ({
    status: 200,
    body: { version: 1, ok: true, profileId: "sub", ownerGeneration: 3, stateSequence: 6, ...over },
  });

  const finishOk = { status: 200, body: { version: 1, ok: true, acknowledged: true } };
  const reply = (route: string, checkpoint: { status: number; body: unknown }) =>
    route === MODEL_AUTH_ROUTES.checkout ? okCheckout() : route === MODEL_AUTH_ROUTES.finish ? finishOk : checkpoint;

  function make(transport: ModelAuthTransport, extra: Partial<ModelAuthClientOptions> = {}, g = grant()) {
    return createModelAuthClient({
      source: { kind: "hosted", grant: g, transport },
      authRoot,
      forbiddenRoots: [workspace, artifacts],
      inheritedEnv: { ANTHROPIC_API_KEY: S_INHERITED, PATH: "/bin" },
      now: () => NOW,
      sleep: async (ms) => void sleeps.push(ms),
      ...extra,
    });
  }

  const sub = { profileId: "sub", authMode: "claude-subscription" as const };

  it("writes a private 0700 dir with 0600 session file outside the workspace, then checkpoints after a successful invocation", async () => {
    const { transport, calls } = fakeTransport((route) => (reply(route, ack())));
    const client = make(transport);
    await client.checkout(sub);
    const [dir] = readdirSync(authRoot);
    const full = join(authRoot, dir!);
    expect(statSync(full).mode & 0o777).toBe(0o700);
    const file = join(full, ".credentials.json");
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(readdirSync(full)).toEqual([".credentials.json"]); // no leftover temp file
    expect(full.startsWith(workspace)).toBe(false);

    let argvSeen = "";
    const result = await client.invoke("sub", async (inv) => {
      expect(realpathSync(inv.env.CLAUDE_CONFIG_DIR!)).toBe(realpathSync(full));
      expect(JSON.stringify(inv.env)).not.toContain(S_INHERITED);
      argvSeen = JSON.stringify(process.argv);
      writeFileSync(file, S_REFRESHED);
      return 42;
    });
    expect(result).toBe(42);
    expect(argvSeen).not.toContain("SENTINEL");
    const cp = calls.filter((c) => c.route === MODEL_AUTH_ROUTES.checkpoint);
    expect(cp).toHaveLength(1);
    expect(JSON.parse(cp[0]!.raw)).toEqual({
      version: 1,
      profileId: "sub",
      ownerGeneration: 3,
      stateSequence: 6,
      sessionData: S_REFRESHED,
    });

    await client.finish("sub", "completed");
    expect(existsSync(full)).toBe(false);
    expect(calls.at(-1)!.route).toBe(MODEL_AUTH_ROUTES.finish);
    expect(JSON.parse(calls.at(-1)!.raw)).toEqual({ version: 1, profileId: "sub", handling: "completed" });
  });

  it("checkpoints refreshed state even when the invocation fails, and rethrows the invocation error", async () => {
    const { transport, calls } = fakeTransport((route) => (reply(route, ack())));
    const client = make(transport);
    await client.checkout(sub);
    const file = join(authRoot, readdirSync(authRoot)[0]!, ".credentials.json");
    const boom = new Error("model crashed");
    await expect(
      client.invoke("sub", async () => {
        writeFileSync(file, S_REFRESHED);
        throw boom;
      }),
    ).rejects.toBe(boom);
    expect(calls.filter((c) => c.route === MODEL_AUTH_ROUTES.checkpoint)).toHaveLength(1);
    // Sequence advances for the next invocation.
    await client.invoke("sub", async () => undefined).catch(() => undefined);
    const seqs = calls.filter((c) => c.route === MODEL_AUTH_ROUTES.checkpoint).map((c) => JSON.parse(c.raw).stateSequence);
    expect(seqs[0]).toBe(6);
  });

  describe("checkout authorization happens before any file is written", () => {
    const cases: Array<[string, Record<string, unknown>]> = [
      ["cross-profile response", { profileId: "api" }],
      ["stale owner generation", { ownerGeneration: 2 }],
    ];
    for (const [name, over] of cases) {
      it(name, async () => {
        const { transport } = fakeTransport(() => okCheckout(over));
        const client = make(transport);
        expect(await categoryAsync(client.checkout(sub))).toBe("checkout_response_mismatch");
        expect(readdirSync(authRoot)).toEqual([]);
        expect(client.status("sub")).toBe("unknown");
      });
    }

    it("missing owner generation is an invalid response", async () => {
      const { transport } = fakeTransport(() => okCheckout({ ownerGeneration: undefined }));
      expect(await categoryAsync(make(transport).checkout(sub))).toBe("checkout_response_invalid");
      expect(readdirSync(authRoot)).toEqual([]);
    });

    it("extra generation on an API-key profile is rejected", async () => {
      const { transport } = fakeTransport(() => ({
        status: 200,
        body: {
          version: 1,
          ok: true,
          profileId: "api",
          authMode: "openai-api-key",
          ownerGeneration: 1,
          secret: { kind: "api-key", apiKey: S_API },
        },
      }));
      expect(await categoryAsync(make(transport).checkout({ profileId: "api", authMode: "openai-api-key" }))).toBe(
        "checkout_response_invalid",
      );
    });

    it("wrong auth mode", async () => {
      const { transport } = fakeTransport(() => okCheckout({ authMode: "codex-subscription" }));
      const client = make(transport);
      expect(await categoryAsync(client.checkout(sub))).toBe("checkout_response_invalid");
      expect(readdirSync(authRoot)).toEqual([]);
      expect(client.status("sub")).toBe("unknown");
    });

    it("rejects an unlisted profile, a mode differing from the binding, an unknown mode and an expired grant without a request", async () => {
      const { transport } = fakeTransport(() => okCheckout());
      const client = make(transport);
      expect(await categoryAsync(client.checkout({ profileId: "nope", authMode: "bedrock" }))).toBe("profile_not_allowed");
      expect(await categoryAsync(client.checkout({ profileId: "sub", authMode: "codex-subscription" }))).toBe("binding_mismatch");
      expect(await categoryAsync(client.checkout({ profileId: "sub", authMode: "weird" as never }))).toBe("unsupported_auth_mode");
      expect(await categoryAsync(make(transport, {}, grant({ expiresAt: NOW - 1 })).checkout(sub))).toBe("bootstrap_expired");
      expect(transport.post).not.toHaveBeenCalled();
    });

    it("reports a server rejection by safe category only", async () => {
      const { transport } = fakeTransport(() => ({ status: 409, body: { version: 1, ok: false, category: "busy" } }));
      const err = await make(transport).checkout(sub).catch((e) => e as ModelAuthClientError);
      expect((err as ModelAuthClientError).category).toBe("server_rejected");
      expect((err as ModelAuthClientError).serverCategory).toBe("busy");
    });
  });

  it("API mode keeps everything in memory, no files, only the selected key", async () => {
    const { transport, calls } = fakeTransport((route) =>
      route === MODEL_AUTH_ROUTES.finish
        ? finishOk
        : {
            status: 200,
            body: { version: 1, ok: true, profileId: "api", authMode: "openai-api-key", secret: { kind: "api-key", apiKey: S_API } },
          },
    );
    const client = make(transport);
    await client.checkout({ profileId: "api", authMode: "openai-api-key" });
    expect(readdirSync(authRoot)).toEqual([]);
    await client.invoke("api", async (inv) => {
      expect(inv.env.CODEX_API_KEY).toBe(S_API);
      expect(inv.env).not.toHaveProperty("OPENAI_API_KEY");
      expect(inv.env).not.toHaveProperty("ANTHROPIC_API_KEY");
    });
    await client.finish("api", "completed");
    expect(calls.map((c) => c.route)).toEqual([MODEL_AUTH_ROUTES.checkout, MODEL_AUTH_ROUTES.finish]);
  });

  it("Bedrock checkout yields the AWS bundle for the invocation", async () => {
    const { transport } = fakeTransport(() => ({
      status: 200,
      body: {
        version: 1,
        ok: true,
        profileId: "bed",
        authMode: "bedrock",
        secret: { kind: "aws-bedrock", region: "us-east-1", accessKeyId: "AKIASENTINEL", secretAccessKey: S_AWS_SECRET },
      },
    }));
    const client = make(transport);
    await client.checkout({ profileId: "bed", authMode: "bedrock" });
    await client.invoke("bed", async (inv) => {
      expect(inv.env.AWS_SECRET_ACCESS_KEY).toBe(S_AWS_SECRET);
      expect(inv.env.CLAUDE_CODE_USE_BEDROCK).toBe("1");
    });
  });

  describe("checkpoint safety", () => {
    async function ready(handler: Handler, extra: Partial<ModelAuthClientOptions> = {}) {
      const f = fakeTransport((route, body) => (route === MODEL_AUTH_ROUTES.checkout ? okCheckout() : handler(route, body)));
      const client = make(f.transport, extra);
      await client.checkout(sub);
      return { ...f, client };
    }

    for (const [name, over] of [
      ["wrong profile", { profileId: "api" }],
      ["wrong generation", { ownerGeneration: 4 }],
      ["wrong sequence", { stateSequence: 7 }],
    ] as const) {
      it(`blocks further invocations on an acknowledgement with the ${name}`, async () => {
        const { client } = await ready(() => ack(over));
        expect(await categoryAsync(client.invoke("sub", async () => 1))).toBe("checkpoint_uncertain");
        const spy = vi.fn(async () => 1);
        expect(await categoryAsync(client.invoke("sub", spy))).toBe("checkpoint_uncertain");
        expect(spy).not.toHaveBeenCalled();
        expect(await categoryAsync(client.finish("sub", "completed"))).toBe("checkpoint_uncertain");
        expect(readdirSync(authRoot)).toHaveLength(1); // fresher state is not destroyed while unreconciled
      });
    }

    it("retries transport failures with the identical payload, then succeeds", async () => {
      let n = 0;
      const { client, calls } = await ready(() => {
        n++;
        if (n === 1) return Promise.reject(new Error(`network ${S_SESSION}`));
        if (n === 2) return { status: 503, body: { leaked: S_SESSION } };
        return ack();
      });
      await client.invoke("sub", async () => undefined);
      const cps = calls.filter((c) => c.route === MODEL_AUTH_ROUTES.checkpoint);
      expect(cps).toHaveLength(3);
      expect(new Set(cps.map((c) => c.raw)).size).toBe(1);
      expect(sleeps).toHaveLength(2);
      expect(sleeps.every((s) => s <= DEFAULT_RETRY_POLICY.backoffMaxMs)).toBe(true);
    });

    it("exhausted retries leave the profile uncertain and no further model call happens", async () => {
      const { client, calls } = await ready(() => Promise.reject(new Error(`down ${S_REFRESHED}`)), { maxTransportAttempts: 3 });
      const err = await client.invoke("sub", async () => undefined).catch((e) => e as Error);
      expect((err as ModelAuthClientError).category).toBe("checkpoint_uncertain");
      expect((err as Error).message).not.toContain("SENTINEL");
      expect(calls.filter((c) => c.route === MODEL_AUTH_ROUTES.checkpoint)).toHaveLength(3);
      const spy = vi.fn(async () => 1);
      expect(await categoryAsync(client.invoke("sub", spy))).toBe("checkpoint_uncertain");
      expect(spy).not.toHaveBeenCalled();
      expect(client.status("sub")).toBe("uncertain");
    });

    it("a definitive rejection blocks without retrying and surfaces the server category", async () => {
      const { client, calls } = await ready(() => ({ status: 409, body: { version: 1, ok: false, category: "stale_owner" } }));
      const err = (await client.invoke("sub", async () => 1).catch((e) => e)) as ModelAuthClientError;
      expect(err.category).toBe("checkpoint_rejected");
      expect(err.serverCategory).toBe("stale_owner");
      expect(calls.filter((c) => c.route === MODEL_AUTH_ROUTES.checkpoint)).toHaveLength(1);
      expect(await categoryAsync(client.invoke("sub", async () => 1))).toBe("checkpoint_uncertain");
    });

    it("reconcile: accepted resumes, not_accepted resends the identical payload, unknown stays blocked", async () => {
      let mode: "lost" | "ok" = "lost";
      const verdicts: Array<"accepted" | "not_accepted" | "unknown"> = ["unknown", "not_accepted", "accepted"];
      const reconcile = vi.fn(async () => verdicts.shift()!);
      const { client, calls } = await ready(() => (mode === "lost" ? Promise.reject(new Error("x")) : ack()), {
        maxTransportAttempts: 1,
        reconcile,
      });
      await client.invoke("sub", async () => undefined).catch(() => undefined);
      await client.reconcile("sub");
      expect(client.status("sub")).toBe("uncertain");
      mode = "ok";
      await client.reconcile("sub");
      expect(client.status("sub")).toBe("ready");
      const cps = calls.filter((c) => c.route === MODEL_AUTH_ROUTES.checkpoint);
      expect(cps).toHaveLength(2);
      expect(cps[0]!.raw).toBe(cps[1]!.raw);
    });

    it("reconcile accepted advances the sequence without resending", async () => {
      const { client, calls } = await ready(() => Promise.reject(new Error("x")), {
        maxTransportAttempts: 1,
        reconcile: async () => "accepted",
      });
      await client.invoke("sub", async () => undefined).catch(() => undefined);
      await client.reconcile("sub");
      expect(client.status("sub")).toBe("ready");
      expect(calls.filter((c) => c.route === MODEL_AUTH_ROUTES.checkpoint)).toHaveLength(1);
    });

    it("rejects concurrent invocations of one profile", async () => {
      const { client } = await ready(() => ack());
      let release!: () => void;
      const first = client.invoke("sub", () => new Promise<void>((r) => (release = r)));
      await Promise.resolve();
      expect(await categoryAsync(client.invoke("sub", async () => 1))).toBe("invocation_in_progress");
      release();
      await first;
    });
  });

  it("clears temporary credentials when finish is not acknowledged, but still reports it", async () => {
    const { transport } = fakeTransport((route) =>
      route === MODEL_AUTH_ROUTES.checkout ? okCheckout() : route === MODEL_AUTH_ROUTES.checkpoint ? ack() : { status: 400, body: "raw" },
    );
    const client = make(transport);
    await client.checkout(sub);
    await client.invoke("sub", async () => undefined);
    expect(await categoryAsync(client.finish("sub", "failed"))).toBe("finish_failed");
    expect(readdirSync(authRoot)).toEqual([]);
  });

  it("reports cleanup failure by category only, with no path or secret", async () => {
    const { transport } = fakeTransport((route) => (reply(route, ack())));
    const client = make(transport, {
      removeDir: async (p) => {
        throw new Error(`EPERM ${p} ${S_SESSION}`);
      },
    });
    await client.checkout(sub);
    await client.invoke("sub", async () => undefined);
    const err = (await client.finish("sub", "completed").catch((e) => e)) as ModelAuthClientError;
    expect(err.category).toBe("cleanup_failed");
    expect(err.message).not.toContain("SENTINEL");
    expect(err.message).not.toContain(authRoot);
    expect(await categoryAsync(client.dispose())).toBe("cleanup_failed");
  });

  it("dispose removes only the directories it created", async () => {
    const { transport } = fakeTransport(() => okCheckout());
    const client = make(transport);
    const foreign = join(authRoot, "foreign");
    mkdirSync(foreign);
    await client.checkout(sub);
    await client.dispose();
    expect(readdirSync(authRoot)).toEqual(["foreign"]);
  });

  it("refuses a credential directory inside the workspace or artifacts", async () => {
    const { transport } = fakeTransport(() => okCheckout());
    for (const bad of [workspace, artifacts, "relative/path"]) {
      const client = make(transport, { authRoot: bad });
      expect(await categoryAsync(client.checkout(sub))).toBe("auth_dir_unsafe");
    }
    expect(readdirSync(workspace)).toEqual([]);
  });

  it("local credential port: copies the login, never deletes it, persists refreshed state via the port", async () => {
    const login = join(root, "local-login.json");
    writeFileSync(login, S_SESSION);
    const persist = vi.fn(async () => undefined);
    const port: LocalCredentialPort = {
      load: async () => ({ kind: "session", sessionData: readFileSync(login, "utf8"), stateSequence: 0 }),
      persistSession: persist,
    };
    const client = createModelAuthClient({
      source: { kind: "local", port },
      authRoot,
      forbiddenRoots: [workspace],
      inheritedEnv: { OPENAI_API_KEY: S_INHERITED },
    });
    await client.checkout(sub);
    const file = join(authRoot, readdirSync(authRoot)[0]!, ".credentials.json");
    await client.invoke("sub", async (inv) => {
      expect(inv.env).not.toHaveProperty("OPENAI_API_KEY");
      writeFileSync(file, S_REFRESHED);
    });
    expect(persist).toHaveBeenCalledWith({ profileId: "sub", sessionData: S_REFRESHED });
    await client.finish("sub", "completed");
    expect(readdirSync(authRoot)).toEqual([]);
    expect(readFileSync(login, "utf8")).toBe(S_SESSION);
  });

  it("local credential port failure and kind mismatch use safe categories", async () => {
    const mk = (load: LocalCredentialPort["load"]) =>
      createModelAuthClient({ source: { kind: "local", port: { load, persistSession: async () => undefined } }, authRoot, forbiddenRoots: [workspace] });
    expect(
      await categoryAsync(
        mk(async () => {
          throw new Error(S_SESSION);
        }).checkout(sub),
      ),
    ).toBe("credential_source_failed");
    expect(
      await categoryAsync(mk(async () => ({ kind: "api-key", apiKey: S_API })).checkout(sub)),
    ).toBe("credential_source_mismatch");
    expect(readdirSync(authRoot)).toEqual([]);
  });

  describe("AII-988 hardening", () => {
    const localPort = (over: Partial<LocalCredentialPort> = {}): LocalCredentialPort => ({
      load: async () => ({ kind: "session", sessionData: S_SESSION, stateSequence: 0 }),
      persistSession: async () => undefined,
      ...over,
    });
    const local = (port: LocalCredentialPort, extra: Partial<ModelAuthClientOptions> = {}) =>
      createModelAuthClient({
        source: { kind: "local", port },
        authRoot,
        forbiddenRoots: [workspace],
        inheritedEnv: { PATH: "/bin" },
        ...extra,
      });

    it("local subscription without persistSession fails before any file or model call", async () => {
      const load = vi.fn(localPort().load);
      const client = local({ load });
      expect(await categoryAsync(client.checkout(sub))).toBe("credential_source_failed");
      expect(load).not.toHaveBeenCalled();
      expect(readdirSync(authRoot)).toEqual([]);
    });

    it("local API-only ports may omit persistSession", async () => {
      const client = local({ load: async () => ({ kind: "api-key", apiKey: S_API }) });
      await client.checkout({ profileId: "api", authMode: "openai-api-key" });
      await client.invoke("api", async (inv) => expect(inv.env.CODEX_API_KEY).toBe(S_API));
    });

    it("failed persistence blocks further calls with a category-only error", async () => {
      const client = local(localPort({ persistSession: async () => Promise.reject(new Error(S_REFRESHED)) }));
      await client.checkout(sub);
      const err = (await client.invoke("sub", async () => 1).catch((e) => e)) as ModelAuthClientError;
      expect(err.category).toBe("credential_source_failed");
      expect(err.message).not.toContain("SENTINEL");
      expect(client.status("sub")).toBe("rejected");
      const spy = vi.fn(async () => 1);
      expect(await categoryAsync(client.invoke("sub", spy))).toBe("checkpoint_uncertain");
      expect(spy).not.toHaveBeenCalled();
    });

    it("rejects symlinked authRoot, symlinked parent, traversal; allows prefix collisions", async () => {
      const link = join(root, "link-to-workspace");
      symlinkSync(workspace, link);
      const parentLink = join(root, "parent-link");
      symlinkSync(workspace, parentLink);
      mkdirSync(join(workspace, "inner"));
      const { transport } = fakeTransport(() => okCheckout());
      for (const bad of [link, join(parentLink, "inner"), join(authRoot, "..", "workspace"), join(root, "auth", "..", "workspace", "inner")]) {
        const client = make(transport, { authRoot: bad });
        expect(await categoryAsync(client.checkout(sub))).toBe("auth_dir_unsafe");
      }
      expect(readdirSync(join(workspace, "inner"))).toEqual([]);
      expect(readdirSync(workspace)).toEqual(["inner"]);
      // prefix collision: sibling "workspace-auth" is not inside "workspace"
      const sibling = join(root, "workspace-auth");
      mkdirSync(sibling);
      const ok = make(transport, { authRoot: sibling });
      await ok.checkout(sub);
      const dir = join(sibling, readdirSync(sibling)[0]!);
      expect(statSync(dir).mode & 0o777).toBe(0o700);
    });

    it("strips every authority leak by default and from the passed env only", () => {
      const prev = process.env.AI_IMPLEMENT_FORWARDED_SECRETS;
      process.env.AI_IMPLEMENT_FORWARDED_SECRETS = "UNRELATED";
      try {
        const leak = "SENTINEL-leak-0007";
        const inheritedEnv = {
          PATH: "/bin",
          HOME: "/home/x",
          SSL_CERT_FILE: "/etc/ca.pem",
          HTTPS_PROXY: "http://proxy:3128",
          RUNNER_CALLBACK_URL: leak,
          RUNNER_CALLBACK_BASE_URL: leak,
          RUN_TOKEN: leak,
          RUN_PROGRESS_TOKEN: leak,
          RUN_PUBLICATION_TOKEN: leak,
          RUN_RESULT_TOKEN: leak,
          GITHUB_TOKEN: leak,
          GH_TOKEN: leak,
          NPM_TOKEN: leak,
          AI_IMPLEMENT_DEP_TOKEN_OVERRIDE: leak,
          AI_IMPLEMENT_RUN_CONFIG: leak,
          AI_IMPLEMENT_FORWARDED_SECRETS: "MY_FWD, OTHER_FWD",
          MY_FWD: leak,
          OTHER_FWD: leak,
          UNRELATED: "kept",
          MODEL_AUTH_KEY: leak,
          OPENAI_BASE_URL: leak,
          ANTHROPIC_BASE_URL: leak,
          ANTHROPIC_BEDROCK_BASE_URL: leak,
          CLAUDE_CODE_USE_VERTEX: "1",
          ANTHROPIC_VERTEX_PROJECT_ID: leak,
        };
        for (const [authMode, secret] of [
          ["openai-api-key", { kind: "api-key", apiKey: S_API }],
          ["anthropic-api-key", { kind: "api-key", apiKey: S_API }],
        ] as const) {
          const { env, strippedKeys } = buildModelInvocationEnv({
            authMode,
            secret,
            inheritedEnv,
            protectedKeys: ["MODEL_AUTH_KEY"],
          });
          expect(JSON.stringify(env)).not.toContain(leak);
          expect(JSON.stringify(strippedKeys)).not.toContain(leak);
          expect(env).not.toHaveProperty("CLAUDE_CODE_USE_VERTEX");
          expect(env).not.toHaveProperty("OPENAI_BASE_URL");
          expect(env).not.toHaveProperty("MODEL_AUTH_KEY");
          expect(env).toMatchObject({ PATH: "/bin", HOME: "/home/x", SSL_CERT_FILE: "/etc/ca.pem", HTTPS_PROXY: "http://proxy:3128" });
          expect(env).not.toHaveProperty("UNRELATED");
        }
      } finally {
        if (prev === undefined) delete process.env.AI_IMPLEMENT_FORWARDED_SECRETS;
        else process.env.AI_IMPLEMENT_FORWARDED_SECRETS = prev;
      }
    });

    it("codex subscription ignores inherited API keys and points at the private dir", () => {
      const { env } = buildModelInvocationEnv({
        authMode: "codex-subscription",
        secret: { kind: "session", sessionData: S_SESSION, stateSequence: 0 },
        authDir: "/private",
        inheritedEnv: { OPENAI_API_KEY: S_INHERITED, CODEX_API_KEY: S_INHERITED, CODEX_HOME: "/x" },
      });
      expect(env).toEqual({ CODEX_HOME: "/private" });
    });

    it("dispose fails without deleting while an invocation is active, then succeeds", async () => {
      const client = local(localPort());
      await client.checkout(sub);
      let release!: () => void;
      const running = client.invoke("sub", () => new Promise<void>((r) => (release = r)));
      await Promise.resolve();
      expect(await categoryAsync(client.dispose())).toBe("invocation_in_progress");
      expect(readdirSync(authRoot)).toHaveLength(1);
      release();
      await running;
      await client.dispose();
      expect(readdirSync(authRoot)).toEqual([]);
    });

    it("no use after disposal, for API and subscription profiles", async () => {
      const client = local(localPort());
      await client.dispose();
      const spy = vi.fn(async () => 1);
      expect(await categoryAsync(client.checkout(sub))).toBe("client_disposed");
      expect(await categoryAsync(client.checkout({ profileId: "api", authMode: "openai-api-key" }))).toBe("client_disposed");
      expect(await categoryAsync(client.invoke("sub", spy))).toBe("client_disposed");
      expect(await categoryAsync(client.invoke("api", spy))).toBe("client_disposed");
      expect(spy).not.toHaveBeenCalled();

      const used = local(localPort());
      await used.checkout(sub);
      await used.dispose();
      expect(await categoryAsync(used.invoke("sub", spy))).toBe("client_disposed");
      expect(spy).not.toHaveBeenCalled();
    });

    it("dispose preserves uncertain state and pending payload and makes no transport call", async () => {
      const f = fakeTransport((route) => (route === MODEL_AUTH_ROUTES.checkout ? okCheckout() : Promise.reject(new Error("down"))));
      const reconcile = vi.fn(async () => "unknown" as const);
      const client = make(f.transport, { maxTransportAttempts: 1, reconcile });
      await client.checkout(sub);
      await client.invoke("sub", async () => undefined).catch(() => undefined);
      const before = f.calls.length;
      await client.dispose();
      expect(f.calls.length).toBe(before);
      expect(client.status("sub")).toBe("uncertain");
    });
  });

  it("diagnostics carry no bearer or secret", async () => {
    const seen: unknown[] = [];
    const { transport } = fakeTransport((route) => (reply(route, ack())));
    const client = make(transport, { onDiagnostic: (d) => seen.push(d) });
    await client.checkout(sub);
    await client.invoke("sub", async () => undefined);
    await client.finish("sub", "completed");
    expect(seen.length).toBeGreaterThanOrEqual(3);
    const dump = JSON.stringify(seen);
    for (const s of [S_BEARER, S_SESSION, S_REFRESHED, S_INHERITED]) expect(dump).not.toContain(s);
  });
});

describe("createModelAuthTransport", () => {
  it("sends the bearer to the model-auth route only and never surfaces raw text", async () => {
    const fetchImpl = vi.fn(async () => new Response("not json SENTINEL", { status: 500 })) as unknown as typeof fetch;
    const t = createModelAuthTransport({ baseUrl: "https://orch.example/", bearer: S_BEARER, fetchImpl });
    const res = await t.post(MODEL_AUTH_ROUTES.checkpoint, "{}");
    expect(res).toEqual({ status: 500, body: undefined });
    const [url, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://orch.example/runner/model-auth/checkpoint");
    expect((init.headers as Record<string, string>).Authorization).toBe(`Bearer ${S_BEARER}`);
  });
});

describe("ChatGPT plan access token (codex-subscription)", () => {
  const S_TOKEN = "SENTINEL-chatgpt-token-0010";
  const S_TOKEN2 = "SENTINEL-chatgpt-token-0011";
  const REQ = 120_000;
  const cg = { profileId: "cx", authMode: "codex-subscription" as const };
  let root: string;
  let authRoot: string;
  let clock: number;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "model-auth-cg-"));
    authRoot = join(root, "auth");
    mkdirSync(authRoot);
    clock = NOW;
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  const tok = (accessToken: string, expiresAt: number) => ({ kind: "chatgpt-access-token" as const, accessToken, expiresAt });
  const diagnostics: unknown[] = [];

  function local(loads: Array<ReturnType<typeof tok> | Error>) {
    const load = vi.fn(async () => {
      const next = loads.shift()!;
      if (next instanceof Error) throw next;
      return next;
    });
    const persistSession = vi.fn(async () => undefined);
    const client = createModelAuthClient({
      source: { kind: "local", port: { load, persistSession } },
      authRoot,
      forbiddenRoots: [join(root, "ws")],
      inheritedEnv: { PATH: "/bin" },
      now: () => clock,
      onDiagnostic: (d) => void diagnostics.push(d),
    });
    return { client, load, persistSession };
  }

  function hosted(responses: Array<ReturnType<typeof tok> | "reject" | "throw">) {
    const calls: string[] = [];
    const transport: ModelAuthTransport = {
      post: vi.fn(async (route: string) => {
        calls.push(route);
        if (route !== MODEL_AUTH_ROUTES.checkout) return { status: 200, body: {} };
        const next = responses.shift()!;
        if (next === "throw") throw new Error("boom");
        if (next === "reject") return { status: 403, body: { version: 1, ok: false, category: "unauthorized" } };
        return {
          status: 200,
          body: { version: 1, ok: true, profileId: "cx", authMode: "codex-subscription", secret: next },
        };
      }),
    };
    const g = grant({
      bindings: [{ stage: "implementation", profileId: "cx", profileRevision: 1, authMode: "codex-subscription" }],
    });
    const client = createModelAuthClient({
      source: { kind: "hosted", grant: g, transport },
      authRoot,
      forbiddenRoots: [join(root, "ws")],
      inheritedEnv: { PATH: "/bin" },
      now: () => clock,
      sleep: async () => {},
      onDiagnostic: (d) => void diagnostics.push(d),
    });
    return { client, calls, checkouts: () => calls.filter((c) => c === MODEL_AUTH_ROUTES.checkout).length };
  }

  type Variant = { name: string; make: (r: Array<ReturnType<typeof tok> | "fail">) => { client: ReturnType<typeof createModelAuthClient>; loads: () => number; extra: () => string[] } };
  const variants: Variant[] = [
    {
      name: "local",
      make: (r) => {
        const l = local(r.map((x) => (x === "fail" ? new Error("nope") : x)));
        return { client: l.client, loads: () => l.load.mock.calls.length, extra: () => (l.persistSession.mock.calls.length ? ["persist"] : []) };
      },
    },
    {
      name: "hosted",
      make: (r) => {
        const h = hosted(r.map((x) => (x === "fail" ? ("reject" as const) : x)));
        return { client: h.client, loads: h.checkouts, extra: () => h.calls.filter((c) => c !== MODEL_AUTH_ROUTES.checkout) };
      },
    },
  ];

  for (const v of variants) {
    describe(v.name, () => {
      it("enough time: no renewal, env holds the token, no files, no write-back", async () => {
        const t = v.make([tok(S_TOKEN, NOW + REQ + 60_000)]);
        await t.client.checkout(cg);
        expect(readdirSync(authRoot)).toEqual([]);
        await t.client.invoke("cx", async (inv) => {
          expect(inv.env[CHATGPT_PLAN_ACCESS_TOKEN_ENV]).toBe(S_TOKEN);
          expect(inv.env).not.toHaveProperty("CODEX_HOME");
          expect(inv.codexProvider).toBe("chatgpt-plan");
        }, { requiredMs: REQ });
        expect(t.loads()).toBe(1);
        expect(t.extra()).toEqual([]);
        expect(t.client.status("cx")).toBe("ready");
        expect(readdirSync(authRoot)).toEqual([]);
        await t.client.dispose();
      });

      it("one ms short: renews once, uses the new token, even if it is still short", async () => {
        const t = v.make([tok(S_TOKEN, NOW + REQ + 59_999), tok(S_TOKEN2, NOW + 1)]);
        await t.client.checkout(cg);
        await t.client.invoke("cx", async (inv) => {
          expect(inv.env[CHATGPT_PLAN_ACCESS_TOKEN_ENV]).toBe(S_TOKEN2);
        }, { requiredMs: REQ });
        expect(t.loads()).toBe(2);
        expect(t.extra()).toEqual([]);
      });

      it("renewal failure: fails with the source category, never runs, stays ready", async () => {
        const t = v.make([tok(S_TOKEN, NOW + 1), "fail"]);
        await t.client.checkout(cg);
        const run = vi.fn(async () => undefined);
        const cat = await categoryAsync(t.client.invoke("cx", run, { requiredMs: REQ }));
        expect(cat).toBe(v.name === "local" ? "credential_source_failed" : "server_rejected");
        expect(run).not.toHaveBeenCalled();
        expect(t.client.status("cx")).toBe("ready");
        expect(t.extra()).toEqual([]);
      });

      it("a throwing run still writes nothing back", async () => {
        const t = v.make([tok(S_TOKEN, NOW + 10 * REQ)]);
        await t.client.checkout(cg);
        await expect(t.client.invoke("cx", async () => { throw new Error("x"); })).rejects.toThrow("x");
        expect(t.extra()).toEqual([]);
        expect(t.client.status("cx")).toBe("ready");
      });
    });
  }

  it("renews exactly at the boundary only below requiredMs + 60s", async () => {
    const l = local([tok(S_TOKEN, NOW + REQ + 60_000)]);
    await l.client.checkout(cg);
    await l.client.invoke("cx", async () => undefined, { requiredMs: REQ });
    expect(l.load).toHaveBeenCalledTimes(1);
  });

  it("uses the injected clock for renewal", async () => {
    const l = local([tok(S_TOKEN, NOW + 10 * REQ), tok(S_TOKEN2, NOW + 20 * REQ)]);
    await l.client.checkout(cg);
    clock = NOW + 10 * REQ;
    await l.client.invoke("cx", async (inv) => expect(inv.env[CHATGPT_PLAN_ACCESS_TOKEN_ENV]).toBe(S_TOKEN2));
    expect(l.load).toHaveBeenCalledTimes(2);
  });

  it("a concurrent invoke during renewal fails with invocation_in_progress", async () => {
    const l = local([tok(S_TOKEN, NOW + 1), tok(S_TOKEN2, NOW + 10 * REQ)]);
    await l.client.checkout(cg);
    const first = l.client.invoke("cx", async () => undefined);
    expect(await categoryAsync(l.client.invoke("cx", async () => undefined))).toBe("invocation_in_progress");
    await first;
    expect(l.load).toHaveBeenCalledTimes(2);
    expect(l.client.status("cx")).toBe("ready");
  });

  it("hosted renewal transport throw surfaces transport_failed", async () => {
    const h = hosted([tok(S_TOKEN, NOW + 1), "throw"]);
    await h.client.checkout(cg);
    expect(await categoryAsync(h.client.invoke("cx", async () => undefined))).toBe("transport_failed");
  });

  it("a local token source needs no persistSession; Claude subscription still does", async () => {
    const load = vi.fn(async () => tok(S_TOKEN, NOW + 10 * REQ));
    const c = createModelAuthClient({ source: { kind: "local", port: { load } }, authRoot, forbiddenRoots: [] });
    await c.checkout(cg);
    expect(await categoryAsync(c.checkout({ profileId: "sub", authMode: "claude-subscription" }))).toBe("credential_source_failed");
  });

  it("session secret on codex still uses CODEX_HOME, checkpoints, and does no expiry check", async () => {
    const load = vi.fn(async () => ({ kind: "session" as const, sessionData: S_SESSION, stateSequence: 0 }));
    const persistSession = vi.fn(async () => undefined);
    const c = createModelAuthClient({ source: { kind: "local", port: { load, persistSession } }, authRoot, forbiddenRoots: [], inheritedEnv: {} });
    await c.checkout(cg);
    await c.invoke("cx", async (inv) => {
      expect(inv.env.CODEX_HOME).toBeTruthy();
      expect(inv.codexProvider).toBeUndefined();
    }, { requiredMs: 10 ** 12 });
    expect(load).toHaveBeenCalledTimes(1);
    expect(persistSession).toHaveBeenCalledTimes(1);
    await c.dispose();
  });

  it("the sentinel appears only in the env, never in diagnostics or errors", async () => {
    diagnostics.length = 0;
    const h = hosted([tok(S_TOKEN, NOW + 1), "reject"]);
    await h.client.checkout(cg);
    let err: unknown;
    try {
      await h.client.invoke("cx", async () => undefined);
    } catch (e) {
      err = e;
    }
    expect(JSON.stringify(diagnostics)).not.toContain("SENTINEL-chatgpt");
    expect(JSON.stringify(err, Object.getOwnPropertyNames(err as object))).not.toContain("SENTINEL-chatgpt");
  });

  it("the env helper sets only the token", () => {
    const { env } = buildModelInvocationEnv({
      authMode: "codex-subscription",
      secret: tok(S_TOKEN, NOW),
      inheritedEnv: { PATH: "/bin", CODEX_HOME: "/x", OPENAI_API_KEY: "y" },
    });
    expect(env[CHATGPT_PLAN_ACCESS_TOKEN_ENV]).toBe(S_TOKEN);
    for (const k of ["CODEX_HOME", "CODEX_API_KEY", "OPENAI_API_KEY"]) expect(env).not.toHaveProperty(k);
  });
});
