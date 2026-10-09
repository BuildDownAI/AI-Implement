/**
 * ChatGPT plan sign-in CLI: `node dist/chatgpt-plan-login.js <login|status|logout> --record <path>`.
 * Runs on the operator's machine because OpenAI's callback goes to 127.0.0.1. The saved record is read by the
 * local refresher and uploaded by the hosted import command.
 * No token value reaches argv, stdout, stderr, or an error message; failures print fixed text.
 */

import { createHash, createPublicKey, randomBytes, randomUUID, verify as cryptoVerify } from "node:crypto";
import type { JsonWebKey } from "node:crypto";
import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { Server } from "node:http";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  CHATGPT_RESOURCE,
  CHATGPT_TOKEN_ENDPOINT,
  parseChatGptPlanRecord,
  serializeChatGptPlanRecord,
} from "./chatgpt-plan-token.js";
import type { ChatGptPlanRecordV1 } from "./chatgpt-plan-token.js";

const ISSUER = "https://auth.openai.com";
const AUTHORIZE_URL = "https://auth.openai.com/api/accounts/authorize";
const DISCOVERY_URL = "https://auth.openai.com/.well-known/openid-configuration";
const DYNAMIC_CLIENT_ID = "dynamic_agent_client";
const REQUIRED_SCOPE = "chatgpt.tokens.use.direct";
const REQUESTED_SCOPE = `openid profile email offline_access resource.invoke ${REQUIRED_SCOPE}`;
const AGENT_NAME = "AI-Implement";
const DEFAULT_PORT = 1455;
const CALLBACK_PATH = "/auth/callback";
const LOGIN_TIMEOUT_MS = 10 * 60 * 1000;
const HTTP_TIMEOUT_MS = 15_000;
const DISCONNECT_HINT = "Revocation was not confirmed. You can disconnect the app in ChatGPT settings.";

export interface LoginDeps {
  fetch: typeof fetch;
  now: () => number;
  /** Port for the loopback listener. 0 picks a free port (the redirect_uri uses the bound port). */
  port: number;
  openBrowser: (url: string) => void | Promise<void>;
  stdout: (line: string) => void;
  stderr: (line: string) => void;
  randomBytes: (n: number) => Buffer;
}

/** An error whose message is safe to print: fixed text only, never remote or token data. */
class SignInError extends Error {}

const b64url = (buf: Buffer): string => buf.toString("base64url");

function asObject(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function safeCode(value: unknown): string {
  return typeof value === "string" && /^[a-z_]{1,64}$/.test(value) ? value : "unknown";
}

// ---------------------------------------------------------------------------------------------------------------------
// Files
// ---------------------------------------------------------------------------------------------------------------------

function atomicWrite(path: string, content: string, deps: Pick<LoginDeps, "randomBytes">): void {
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmp = join(dir, `.${basename(path)}.${deps.randomBytes(6).toString("hex")}.tmp`);
  try {
    writeFileSync(tmp, content, { mode: 0o600, flag: "wx" });
    chmodSync(tmp, 0o600);
    renameSync(tmp, path);
  } catch {
    try {
      unlinkSync(tmp);
    } catch {
      /* temp file may not exist */
    }
    throw new SignInError("could not write the record file");
  }
}

/** Reads `<dir of record>/host-id`, creating `urn:uuid:<v4>` (mode 0600) when missing. */
function loadHostId(recordPath: string, deps: Pick<LoginDeps, "randomBytes">): string {
  const path = join(dirname(recordPath), "host-id");
  if (existsSync(path)) {
    const id = readFileSync(path, "utf8").trim();
    if (!/^urn:uuid:[0-9a-f-]{36}$/i.test(id)) throw new SignInError("host-id file is malformed");
    return id;
  }
  const id = `urn:uuid:${randomUUID()}`;
  atomicWrite(path, `${id}\n`, deps);
  return id;
}

/** A saved record: full, or signed-out (tokens removed by `logout`). */
type SavedRecord = Record<string, unknown> & { clientId: string; extAgentHostId: string };

function readSaved(path: string): SavedRecord | null {
  if (!existsSync(path)) return null;
  let raw: Record<string, unknown> | null;
  try {
    raw = asObject(JSON.parse(readFileSync(path, "utf8")));
  } catch {
    throw new SignInError("record file is not valid JSON");
  }
  if (!raw || typeof raw.clientId !== "string" || !raw.clientId || typeof raw.extAgentHostId !== "string" || !raw.extAgentHostId) {
    throw new SignInError("record file is missing clientId or extAgentHostId");
  }
  return raw as SavedRecord;
}

function hasTokens(saved: SavedRecord): boolean {
  return ["accessToken", "refreshToken", "idToken"].every((k) => typeof saved[k] === "string" && saved[k]);
}

// ---------------------------------------------------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------------------------------------------------

interface OpenIdConfig {
  issuer: string;
  jwksUri: string;
  revocationEndpoint: string | null;
}

async function fetchJson(deps: Pick<LoginDeps, "fetch">, url: string): Promise<Record<string, unknown>> {
  let res: Response;
  try {
    res = await deps.fetch(url, { signal: AbortSignal.timeout(HTTP_TIMEOUT_MS) });
  } catch {
    throw new SignInError("network error contacting auth.openai.com");
  }
  if (!res.ok) throw new SignInError(`auth.openai.com returned HTTP ${res.status}`);
  let body: Record<string, unknown> | null;
  try {
    body = asObject(await res.json());
  } catch {
    body = null;
  }
  if (!body) throw new SignInError("auth.openai.com returned an unreadable response");
  return body;
}

async function discover(deps: Pick<LoginDeps, "fetch">): Promise<OpenIdConfig> {
  const body = await fetchJson(deps, DISCOVERY_URL);
  const issuer = typeof body.issuer === "string" ? body.issuer : ISSUER;
  if (issuer !== ISSUER) throw new SignInError("OpenID configuration has an unexpected issuer");
  if (typeof body.jwks_uri !== "string" || !body.jwks_uri.startsWith("https://")) {
    throw new SignInError("OpenID configuration has no jwks_uri");
  }
  const rev = typeof body.revocation_endpoint === "string" && body.revocation_endpoint.startsWith("https://");
  return { issuer, jwksUri: body.jwks_uri, revocationEndpoint: rev ? (body.revocation_endpoint as string) : null };
}

// ---------------------------------------------------------------------------------------------------------------------
// ID token
// ---------------------------------------------------------------------------------------------------------------------

interface IdClaims {
  sub: string;
  email: string;
}

function decodePart(part: string): Record<string, unknown> | null {
  try {
    return asObject(JSON.parse(Buffer.from(part, "base64url").toString("utf8")));
  } catch {
    return null;
  }
}

async function verifyIdToken(
  idToken: string,
  config: OpenIdConfig,
  expect: { clientId: string; nonce: string; now: number },
  deps: Pick<LoginDeps, "fetch">,
): Promise<IdClaims> {
  const parts = idToken.split(".");
  if (parts.length !== 3) throw new SignInError("ID token is malformed");
  const header = decodePart(parts[0]);
  const claims = decodePart(parts[1]);
  if (!header || !claims) throw new SignInError("ID token is malformed");
  if (header.alg !== "RS256") throw new SignInError("ID token must be signed with RS256");

  const jwks = await fetchJson(deps, config.jwksUri);
  const keys = (Array.isArray(jwks.keys) ? jwks.keys : []).map(asObject).filter((k): k is Record<string, unknown> => k !== null);
  const candidates = typeof header.kid === "string" ? keys.filter((k) => k.kid === header.kid) : keys.length === 1 ? keys : [];
  const jwk = candidates.find((k) => k.kty === "RSA");
  if (!jwk) throw new SignInError("ID token signing key was not found in the JWKS");

  let signatureOk = false;
  try {
    const key = createPublicKey({ key: jwk as JsonWebKey, format: "jwk" });
    signatureOk = cryptoVerify("RSA-SHA256", Buffer.from(`${parts[0]}.${parts[1]}`), key, Buffer.from(parts[2], "base64url"));
  } catch {
    signatureOk = false;
  }
  if (!signatureOk) throw new SignInError("ID token signature is invalid");

  if (claims.iss !== config.issuer) throw new SignInError("ID token issuer is wrong");
  const aud = claims.aud;
  const audOk = typeof aud === "string" ? aud === expect.clientId : Array.isArray(aud) && aud.includes(expect.clientId);
  if (!audOk) throw new SignInError("ID token audience does not include the issued client id");
  if (typeof claims.exp !== "number" || claims.exp * 1000 <= expect.now) throw new SignInError("ID token is expired");
  if (claims.nonce !== expect.nonce) throw new SignInError("ID token nonce does not match");
  if (typeof claims.sub !== "string" || !claims.sub) throw new SignInError("ID token has no subject");
  if (typeof claims.email !== "string" || !claims.email) throw new SignInError("ID token has no email");
  return { sub: claims.sub, email: claims.email };
}

// ---------------------------------------------------------------------------------------------------------------------
// Loopback listener
// ---------------------------------------------------------------------------------------------------------------------

interface Listener {
  port: number;
  /** Resolves with the callback query; rejects on timeout. Closes the server either way. */
  callback: Promise<URLSearchParams>;
  close: () => void;
}

function startListener(port: number): Promise<Listener> {
  return new Promise((resolveListener, rejectListener) => {
    let settle: (p: URLSearchParams) => void = () => {};
    let abort: (e: Error) => void = () => {};
    const callback = new Promise<URLSearchParams>((res, rej) => {
      settle = res;
      abort = rej;
    });
    callback.catch(() => {});
    let timer: ReturnType<typeof setTimeout> | undefined;
    const server: Server = createServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      if (url.pathname !== CALLBACK_PATH) {
        res.writeHead(404).end();
        return;
      }
      res.writeHead(200, { "Content-Type": "text/plain" }).end("Sign-in received. You can close this tab.");
      settle(url.searchParams);
    });
    const close = (): void => {
      if (timer) clearTimeout(timer);
      server.close();
      server.closeAllConnections();
    };
    server.once("error", (err: NodeJS.ErrnoException) => {
      rejectListener(
        new SignInError(err.code === "EADDRINUSE" ? `port ${port} is already in use` : "could not start the loopback listener"),
      );
    });
    server.listen(port, "127.0.0.1", () => {
      const addr = server.address();
      const bound = typeof addr === "object" && addr ? addr.port : port;
      timer = setTimeout(() => {
        abort(new SignInError("timed out waiting for the browser sign-in (10 minutes)"));
        close();
      }, LOGIN_TIMEOUT_MS);
      callback.then(close, close);
      resolveListener({ port: bound, callback, close });
    });
  });
}

// ---------------------------------------------------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------------------------------------------------

export async function login(recordPath: string, deps: LoginDeps): Promise<void> {
  const saved = readSaved(recordPath);
  const reauth = saved !== null && saved.clientId !== DYNAMIC_CLIENT_ID;
  const hostId = loadHostId(recordPath, deps);
  if (saved && saved.extAgentHostId !== hostId) throw new SignInError("record host id does not match the host-id file");

  const config = await discover(deps);
  const listener = await startListener(deps.port);
  try {
    const redirectUri = `http://127.0.0.1:${listener.port}${CALLBACK_PATH}`;
    const state = b64url(deps.randomBytes(24));
    const nonce = b64url(deps.randomBytes(24));
    const verifier = b64url(deps.randomBytes(32));
    const challenge = b64url(createHash("sha256").update(verifier).digest());

    const params = new URLSearchParams({
      client_id: reauth ? saved.clientId : DYNAMIC_CLIENT_ID,
      ext_agent_host_id: hostId,
      response_type: "code",
      redirect_uri: redirectUri,
      scope: REQUESTED_SCOPE,
      resource: CHATGPT_RESOURCE,
      state,
      nonce,
      code_challenge: challenge,
      code_challenge_method: "S256",
    });
    if (!reauth) params.set("agent_name_hint", AGENT_NAME);
    else {
      if (typeof saved.idToken === "string" && saved.idToken) params.set("id_token_hint", saved.idToken);
      if (typeof saved.email === "string" && saved.email) params.set("login_hint", saved.email);
    }
    const authorizeUrl = `${AUTHORIZE_URL}?${params.toString()}`;

    deps.stdout("Open this URL in a browser on this machine to sign in with ChatGPT:");
    deps.stdout(authorizeUrl);
    try {
      await deps.openBrowser(authorizeUrl);
    } catch {
      deps.stderr("Could not open a browser automatically; open the URL above by hand.");
    }

    const query = await listener.callback;
    if (query.get("state") !== state) throw new SignInError("callback state does not match");
    if (query.has("error")) throw new SignInError(`sign-in failed: ${safeCode(query.get("error"))}`);
    const code = query.get("code");
    if (!code) throw new SignInError("callback has no authorization code");
    const issued = query.get("client_id");
    let clientId: string;
    if (reauth) {
      if (issued !== null && issued !== saved.clientId) throw new SignInError("callback client_id differs from the saved client id");
      clientId = saved.clientId;
    } else {
      if (!issued || issued === DYNAMIC_CLIENT_ID) throw new SignInError("registration is incomplete: no client_id was issued");
      clientId = issued;
    }

    let res: Response;
    try {
      res = await deps.fetch(CHATGPT_TOKEN_ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          client_id: clientId,
          code,
          code_verifier: verifier,
          redirect_uri: redirectUri,
          resource: CHATGPT_RESOURCE,
        }),
        signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
      });
    } catch {
      throw new SignInError("network error exchanging the authorization code");
    }
    let body: Record<string, unknown> | null;
    try {
      body = asObject(await res.json());
    } catch {
      body = null;
    }
    if (!res.ok || !body) {
      throw new SignInError(`token exchange failed (HTTP ${res.status}${body ? `, ${safeCode(body.error)}` : ""})`);
    }
    const { access_token, refresh_token, id_token, expires_in, scope, earliest_refresh_at } = body;
    if (
      typeof access_token !== "string" || !access_token ||
      typeof refresh_token !== "string" || !refresh_token ||
      typeof id_token !== "string" || !id_token ||
      typeof expires_in !== "number" || !Number.isFinite(expires_in)
    ) {
      throw new SignInError("token response is incomplete");
    }

    const now = deps.now();
    const claims = await verifyIdToken(id_token, config, { clientId, nonce, now }, deps);
    if (reauth && typeof saved.subject === "string" && saved.subject && saved.subject !== claims.sub) {
      throw new SignInError("signed in as a different account than the saved record");
    }

    const scopes = [...new Set((typeof scope === "string" ? scope : REQUESTED_SCOPE).split(/\s+/).filter(Boolean))].sort();
    if (!scopes.includes(REQUIRED_SCOPE)) throw new SignInError(`grant is missing the ${REQUIRED_SCOPE} scope`);

    const candidate: ChatGptPlanRecordV1 = {
      version: 1,
      email: claims.email,
      issuer: ISSUER,
      subject: claims.sub,
      clientId,
      extAgentHostId: hostId,
      idToken: id_token,
      accessToken: access_token,
      refreshToken: refresh_token,
      tokenType: "Bearer",
      scopes,
      accessTokenExpiresAt: now + expires_in * 1000,
      earliestRefreshAt:
        typeof earliest_refresh_at === "number" && Number.isFinite(earliest_refresh_at) ? earliest_refresh_at * 1000 : null,
      savedAt: now,
    };
    const checked = parseChatGptPlanRecord(candidate);
    if (!checked.ok) throw new SignInError(`record failed validation: ${checked.reason}`);
    atomicWrite(recordPath, serializeChatGptPlanRecord(checked.value), deps);
    deps.stdout(`Signed in as ${claims.email}. Record saved to ${recordPath}.`);
  } finally {
    listener.close();
  }
}

export function status(recordPath: string, deps: Pick<LoginDeps, "now" | "stdout">): void {
  const saved = readSaved(recordPath);
  if (!saved) throw new SignInError("no record found; run login first");
  const str = (k: string): string => (typeof saved[k] === "string" && saved[k] ? (saved[k] as string) : "-");
  if (!hasTokens(saved)) {
    deps.stdout("Status: signed out (client id and host id are kept; run login to sign in again)");
    deps.stdout(`Client id: ${str("clientId").slice(0, 10)}`);
    deps.stdout(`Host id: ${saved.extAgentHostId}`);
    return;
  }
  const parsed = parseChatGptPlanRecord(saved);
  if (!parsed.ok) throw new SignInError(`record failed validation: ${parsed.reason}`);
  const r = parsed.value;
  deps.stdout(`Email: ${r.email}`);
  deps.stdout(`Subject: ${r.subject}`);
  deps.stdout(`Client id: ${r.clientId.slice(0, 10)}`);
  deps.stdout(`Host id: ${r.extAgentHostId}`);
  deps.stdout(`Scopes: ${r.scopes.join(" ")}`);
  deps.stdout(`Seconds left: ${Math.floor((r.accessTokenExpiresAt - deps.now()) / 1000)}`);
}

async function revoke(saved: SavedRecord, deps: Pick<LoginDeps, "fetch">): Promise<boolean> {
  try {
    const config = await discover(deps);
    if (!config.revocationEndpoint) return false;
    const res = await deps.fetch(config.revocationEndpoint, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        token: saved.refreshToken as string,
        token_type_hint: "refresh_token",
        client_id: saved.clientId,
      }),
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    });
    return res.status === 200;
  } catch {
    return false;
  }
}

export async function logout(recordPath: string, deps: LoginDeps): Promise<void> {
  const saved = readSaved(recordPath);
  if (!saved) throw new SignInError("no record found; nothing to sign out");
  let confirmed = true;
  if (typeof saved.refreshToken === "string" && saved.refreshToken) {
    confirmed = await revoke(saved, deps);
  }
  const { accessToken: _a, refreshToken: _r, idToken: _i, ...rest } = saved;
  atomicWrite(recordPath, JSON.stringify(rest), deps);
  deps.stdout(confirmed ? "Signed out. The refresh token was revoked and the tokens were removed." : "Tokens removed from the record.");
  if (!confirmed) deps.stdout(DISCONNECT_HINT);
}

// ---------------------------------------------------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------------------------------------------------

const USAGE = "usage: chatgpt-plan-login <login|status|logout> --record <path> [--port <n>]";

function defaultOpenBrowser(url: string): void {
  const cmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  const child = spawn(cmd, args, { stdio: "ignore", detached: true });
  child.on("error", () => {});
  child.unref();
}

export function defaultDeps(): LoginDeps {
  return {
    fetch: (input, init) => fetch(input, init),
    now: () => Date.now(),
    port: DEFAULT_PORT,
    openBrowser: defaultOpenBrowser,
    stdout: (l) => console.log(l),
    stderr: (l) => console.error(l),
    randomBytes: (n) => randomBytes(n),
  };
}

/** Runs the CLI and returns the exit code. */
export async function main(argv: string[], deps: LoginDeps = defaultDeps()): Promise<number> {
  const [command, ...rest] = argv;
  let record: string | undefined;
  let port = deps.port;
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === "--record") record = rest[++i];
    else if (rest[i] === "--port") {
      const n = Number(rest[++i]);
      if (!Number.isInteger(n) || n < 0 || n > 65535) {
        deps.stderr(USAGE);
        return 2;
      }
      port = n;
    } else {
      deps.stderr(USAGE);
      return 2;
    }
  }
  if (!record || !["login", "status", "logout"].includes(command ?? "")) {
    deps.stderr(USAGE);
    return 2;
  }
  const path = resolve(record);
  const d = { ...deps, port };
  try {
    if (command === "login") await login(path, d);
    else if (command === "status") status(path, d);
    else await logout(path, d);
    return 0;
  } catch (err) {
    deps.stderr(`error: ${err instanceof SignInError ? err.message : "unexpected failure"}`);
    return 1;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main(process.argv.slice(2)).then((code) => process.exit(code));
}
