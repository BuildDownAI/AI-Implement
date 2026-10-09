import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { get } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { main } from "../chatgpt-plan-login.js";
import type { LoginDeps } from "../chatgpt-plan-login.js";
import { parseChatGptPlanRecord } from "../chatgpt-plan-token.js";

const ACCESS = "SENTINEL-ACCESS-TOKEN";
const REFRESH = "SENTINEL-REFRESH-TOKEN";
const NOW = 1_800_000_000_000;
const ISSUED = "oaiapp_issuedclient123";
const REVOKE_URL = "https://auth.openai.com/oauth/revoke";
const SCOPE = "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct";

const good = generateKeyPairSync("rsa", { modulusLength: 2048 });
const other = generateKeyPairSync("rsa", { modulusLength: 2048 });
const jwk = { ...good.publicKey.export({ format: "jwk" }), kid: "k1", alg: "RS256", use: "sig" };

function makeIdToken(claims: Record<string, unknown>, key = good.privateKey): string {
  const enc = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const head = enc({ alg: "RS256", kid: "k1", typ: "JWT" });
  const body = enc(claims);
  const sig = sign("RSA-SHA256", Buffer.from(`${head}.${body}`), key).toString("base64url");
  return `${head}.${body}.${sig}`;
}

interface Scenario {
  callback?: (p: URLSearchParams) => URLSearchParams;
  claims?: (nonce: string) => Record<string, unknown>;
  signer?: typeof good.privateKey;
  tokenReply?: Record<string, unknown>;
  revoke?: "ok" | "500" | "throw";
}

let dir: string;
let record: string;
let out: string[];
let err: string[];
let urls: URL[];
let tokenBodies: URLSearchParams[];
let revokeBodies: URLSearchParams[];

function hit(url: string): Promise<void> {
  return new Promise((res) => {
    get(url, (r) => {
      r.resume();
      r.on("end", () => res());
    }).on("error", () => res());
  });
}

function harness(s: Scenario = {}, extra: Partial<LoginDeps> = {}): LoginDeps {
  let nonce = "";
  return {
    now: () => NOW,
    port: 0,
    stdout: (l) => out.push(l),
    stderr: (l) => err.push(l),
    randomBytes: (n) => Buffer.alloc(n, Math.floor(Math.random() * 255) + 1),
    openBrowser: async (u) => {
      const url = new URL(u);
      urls.push(url);
      nonce = url.searchParams.get("nonce")!;
      let q = new URLSearchParams({ code: "the-code", state: url.searchParams.get("state")! });
      if (url.searchParams.get("client_id") === "dynamic_agent_client") q.set("client_id", ISSUED);
      if (s.callback) q = s.callback(q);
      void hit(`${url.searchParams.get("redirect_uri")}?${q.toString()}`);
    },
    fetch: (async (input: string | URL | Request, init?: RequestInit) => {
      const u = String(input);
      if (u.endsWith("/.well-known/openid-configuration")) {
        return Response.json({
          issuer: "https://auth.openai.com",
          jwks_uri: "https://auth.openai.com/.well-known/jwks.json",
          revocation_endpoint: REVOKE_URL,
        });
      }
      if (u.endsWith("jwks.json")) return Response.json({ keys: [jwk] });
      if (u === "https://auth.openai.com/api/accounts/oauth/token") {
        tokenBodies.push(init!.body as URLSearchParams);
        const clientId = (init!.body as URLSearchParams).get("client_id")!;
        const claims = s.claims
          ? s.claims(nonce)
          : { iss: "https://auth.openai.com", aud: [clientId], exp: NOW / 1000 + 3600, nonce, sub: "user-1", email: "a@b.co" };
        return Response.json({
          access_token: ACCESS,
          refresh_token: REFRESH,
          id_token: makeIdToken(claims, s.signer),
          expires_in: 3600,
          scope: SCOPE,
          earliest_refresh_at: NOW / 1000 + 600,
          ...s.tokenReply,
        });
      }
      if (u === REVOKE_URL) {
        revokeBodies.push(init!.body as URLSearchParams);
        if (s.revoke === "throw") throw new Error(`boom ${REFRESH}`);
        return new Response(s.revoke === "500" ? "nope" : "", { status: s.revoke === "500" ? 500 : 200 });
      }
      throw new Error(`unexpected fetch ${u}`);
    }) as typeof fetch,
    ...extra,
  };
}

const allOutput = () => [...out, ...err].join("\n");

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "chatgpt-login-"));
  record = join(dir, "credentials.json");
  out = [];
  err = [];
  urls = [];
  tokenBodies = [];
  revokeBodies = [];
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  vi.useRealTimers();
});

describe("login", () => {
  it("registers, writes a 0600 record, and creates the host id", async () => {
    expect(await main(["login", "--record", record], harness())).toBe(0);
    const u = urls[0].searchParams;
    expect(u.get("client_id")).toBe("dynamic_agent_client");
    expect(u.get("agent_name_hint")).toBe("AI-Implement");
    expect(u.has("id_token_hint")).toBe(false);
    expect(u.has("login_hint")).toBe(false);
    expect(u.get("response_type")).toBe("code");
    expect(u.get("scope")).toBe(SCOPE);
    expect(u.get("resource")).toBe("https://api.openai.com/v1");
    expect(u.get("code_challenge_method")).toBe("S256");
    expect(u.get("redirect_uri")).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/auth\/callback$/);

    const t = tokenBodies[0];
    expect(t.get("grant_type")).toBe("authorization_code");
    expect(t.get("client_id")).toBe(ISSUED);
    expect(t.get("redirect_uri")).toBe(u.get("redirect_uri"));
    expect(t.get("resource")).toBe("https://api.openai.com/v1");
    expect(createHash("sha256").update(t.get("code_verifier")!).digest("base64url")).toBe(u.get("code_challenge"));

    expect(statSync(record).mode & 0o777).toBe(0o600);
    const parsed = parseChatGptPlanRecord(JSON.parse(readFileSync(record, "utf8")));
    expect(parsed.ok).toBe(true);
    expect(readdirSync(dir).sort()).toEqual(["credentials.json", "host-id"]);
    const hostFile = join(dir, "host-id");
    expect(statSync(hostFile).mode & 0o777).toBe(0o600);
    expect(readFileSync(hostFile, "utf8").trim()).toMatch(/^urn:uuid:[0-9a-f-]{36}$/);
    expect(allOutput()).not.toMatch(/SENTINEL/);
  });

  it("reauthorizes with the saved client id and hints, reusing the host id", async () => {
    await main(["login", "--record", record], harness());
    const first = JSON.parse(readFileSync(record, "utf8"));
    urls = [];
    expect(await main(["login", "--record", record], harness())).toBe(0);
    const u = urls[0].searchParams;
    expect(u.get("client_id")).toBe(ISSUED);
    expect(u.has("agent_name_hint")).toBe(false);
    expect(u.get("id_token_hint")).toBe(first.idToken);
    expect(u.get("login_hint")).toBe("a@b.co");
    expect(u.get("ext_agent_host_id")).toBe(first.extAgentHostId);
    expect(JSON.parse(readFileSync(record, "utf8")).extAgentHostId).toBe(first.extAgentHostId);
  });

  const claimsWith = (over: Record<string, unknown>) => (nonce: string) => ({
    iss: "https://auth.openai.com",
    aud: [ISSUED],
    exp: NOW / 1000 + 3600,
    nonce,
    sub: "user-1",
    email: "a@b.co",
    ...over,
  });

  const rejections: Array<[string, Scenario]> = [
    ["state mismatch", { callback: (q) => (q.set("state", "wrong"), q) }],
    ["callback error", { callback: (q) => new URLSearchParams({ state: q.get("state")!, error: "access_denied" }) }],
    ["missing issued client id", { callback: (q) => (q.delete("client_id"), q) }],
    ["bad signature", { signer: other.privateKey }],
    ["wrong aud", { claims: claimsWith({ aud: ["someone-else"] }) }],
    ["wrong nonce", { claims: claimsWith({ nonce: "nope" }) }],
    ["expired", { claims: claimsWith({ exp: NOW / 1000 - 1 }) }],
    ["wrong iss", { claims: claimsWith({ iss: "https://evil.example" }) }],
    ["missing required scope", { tokenReply: { scope: "openid profile email" } }],
  ];

  it.each(rejections)("rejects %s and writes no record", async (_name, scenario) => {
    expect(await main(["login", "--record", record], harness(scenario))).toBe(1);
    expect(existsSync(record)).toBe(false);
    expect(allOutput()).not.toMatch(/SENTINEL/);
    expect(readdirSync(dir)).toEqual(["host-id"]);
  });

  it("rejects a changed client id and a changed sub on reauth, leaving the file untouched", async () => {
    await main(["login", "--record", record], harness());
    const before = readFileSync(record, "utf8");

    expect(await main(["login", "--record", record], harness({ callback: (q) => (q.set("client_id", "oaiapp_other"), q) }))).toBe(1);
    expect(readFileSync(record, "utf8")).toBe(before);

    const sub = (nonce: string) => ({
      iss: "https://auth.openai.com",
      aud: [ISSUED],
      exp: NOW / 1000 + 3600,
      nonce,
      sub: "user-2",
      email: "a@b.co",
    });
    expect(await main(["login", "--record", record], harness({ claims: sub }))).toBe(1);
    expect(readFileSync(record, "utf8")).toBe(before);
    expect(allOutput()).not.toMatch(/SENTINEL/);
  });

  it("binds the listener before opening the browser", async () => {
    const order: string[] = [];
    const deps = harness({}, {});
    const open = deps.openBrowser;
    deps.openBrowser = async (u) => {
      const port = new URL(u).searchParams.get("redirect_uri")!.match(/:(\d+)\//)![1];
      await new Promise<void>((res) => get(`http://127.0.0.1:${port}/other`, (r) => (r.resume(), order.push(`listening ${r.statusCode}`), res())));
      order.push("open");
      await open(u);
    };
    await main(["login", "--record", record], deps);
    expect(order).toEqual(["listening 404", "open"]);
  });

  it("times out after 10 minutes and closes the listener", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    let port = "";
    const deps = harness({}, {
      openBrowser: (u) => {
        port = new URL(u).searchParams.get("redirect_uri")!.match(/:(\d+)\//)![1];
      },
    });
    const p = main(["login", "--record", record], deps);
    await vi.waitFor(() => expect(port).not.toBe(""));
    await vi.advanceTimersByTimeAsync(10 * 60 * 1000);
    expect(await p).toBe(1);
    expect(err.join("\n")).toMatch(/timed out/);
    vi.useRealTimers();
    await expect(
      new Promise((res, rej) => get(`http://127.0.0.1:${port}/auth/callback`, res).on("error", rej)),
    ).rejects.toBeDefined();
    expect(existsSync(record)).toBe(false);
  });
});

describe("status", () => {
  it("prints identity and expiry but no token", async () => {
    await main(["login", "--record", record], harness());
    out = [];
    expect(await main(["status", "--record", record], harness())).toBe(0);
    const text = out.join("\n");
    expect(text).toContain("a@b.co");
    expect(text).toContain("user-1");
    expect(text).toContain(`Client id: ${ISSUED.slice(0, 10)}\n`);
    expect(text).not.toContain(ISSUED);
    expect(text).toMatch(/urn:uuid:/);
    expect(text).toContain("chatgpt.tokens.use.direct");
    expect(text).toContain("Seconds left: 3600");
    expect(text).not.toMatch(/SENTINEL/);
  });

  it("reports a missing record without crashing", async () => {
    expect(await main(["status", "--record", record], harness())).toBe(1);
  });
});

describe("logout", () => {
  it.each([["ok" as const], ["500" as const], ["throw" as const]])("clears tokens and keeps ids when revocation is %s", async (mode) => {
    await main(["login", "--record", record], harness());
    const before = JSON.parse(readFileSync(record, "utf8"));
    out = [];
    expect(await main(["logout", "--record", record], harness({ revoke: mode }))).toBe(0);
    const after = JSON.parse(readFileSync(record, "utf8"));
    expect(after.clientId).toBe(before.clientId);
    expect(after.extAgentHostId).toBe(before.extAgentHostId);
    expect(after).not.toHaveProperty("accessToken");
    expect(after).not.toHaveProperty("refreshToken");
    expect(after).not.toHaveProperty("idToken");
    expect(statSync(record).mode & 0o777).toBe(0o600);
    expect(revokeBodies[0].get("token")).toBe(REFRESH);
    expect(revokeBodies[0].get("token_type_hint")).toBe("refresh_token");
    expect(revokeBodies[0].get("client_id")).toBe(ISSUED);
    expect(out.join("\n").includes("disconnect the app in ChatGPT settings")).toBe(mode !== "ok");
    expect(allOutput()).not.toMatch(/SENTINEL/);

    // A signed-out record reports as such, and login can reauthorize from it.
    out = [];
    expect(await main(["status", "--record", record], harness())).toBe(0);
    expect(out.join("\n")).toContain("signed out");
    urls = [];
    expect(await main(["login", "--record", record], harness())).toBe(0);
    expect(urls[0].searchParams.get("client_id")).toBe(ISSUED);
    expect(urls[0].searchParams.has("agent_name_hint")).toBe(false);
  });

  it("refuses to run on a corrupt record without leaking content", async () => {
    writeFileSync(record, `{"clientId": "${REFRESH}"`);
    expect(await main(["logout", "--record", record], harness())).toBe(1);
    expect(allOutput()).not.toMatch(/SENTINEL/);
  });
});

describe("usage", () => {
  it("rejects unknown commands and a missing --record", async () => {
    expect(await main(["nope"], harness())).toBe(2);
    expect(await main(["login"], harness())).toBe(2);
  });
});
