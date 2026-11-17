import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Readable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";
import { handleAdminRequest } from "../src/admin.js";
import { createSession } from "../src/admin-session.js";
import { closeDb, getDb } from "../src/dedup.js";
import { initKeyBindingsTable, readKeyBinding } from "../src/key-bindings.js";
import { getAccountProfile } from "../src/agent-config-store.js";
import { resolveModelCredential } from "../src/model-credentials.js";
import { createModelProtectedSecrets } from "../src/model-protected-secrets.js";
import { createModelSessionStore } from "../src/model-session-store.js";
import { createModelSessionKeyProvider } from "../src/model-session-keys.js";

const OPENROUTER_HOST = "https://openrouter.ai";
const PROFILE = "openrouter-live-check";
class CheckFailure extends Error {}
type Answer = { status: number; text: string };
export interface AccountCheckDeps {
  now?: () => number;
  request?: (method: string, url: string, body?: unknown) => Promise<Answer>;
  binding?: typeof readKeyBinding;
  resolveCredential?: typeof resolveModelCredential;
}

/** Owns a scratch database; use in a dedicated process, never alongside a running server.
 * Returns the resolved key for the subsequent agent live check. No network calls here.
 */
export async function createAndResolveOpenRouterAccount(key: string, deps: AccountCheckDeps = {}): Promise<string> {
  const directory = mkdtempSync(join(tmpdir(), "openrouter-account-live-check-"));
  const saved = { DEDUP_DB_PATH: process.env.DEDUP_DB_PATH, RUNNER_TOKEN_SECRET: process.env.RUNNER_TOKEN_SECRET };
  // Admin routes emit audit lines. This dedicated process emits only its result.
  const savedConsole = { log: console.log, warn: console.warn, error: console.error };
  console.log = console.warn = console.error = () => {};
  let stage = "create";
  try {
    closeDb();
    process.env.DEDUP_DB_PATH = join(directory, "check.db");
    process.env.RUNNER_TOKEN_SECRET = randomBytes(32).toString("hex");
    initKeyBindingsTable();
    const token = createSession();
    const request = deps.request ?? ((method, url, body) => new Promise<Answer>((resolveAnswer, reject) => {
      const req = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]);
      Object.assign(req, { method, url, headers: { authorization: `Bearer ${token}` } });
      let status = 0;
      const res = { writeHead(code: number) { status = code; }, end(text: string) { resolveAnswer({ status, text }); } };
      Promise.resolve(handleAdminRequest(req as IncomingMessage, res as ServerResponse,
        { adminAccessCode: "live-check" } as never, undefined as never, {
          bindKey: async (ref: string, destination: string) => {
            getDb().prepare("INSERT OR IGNORE INTO key_bindings VALUES (?, ?, ?)").run(ref, destination, (deps.now ?? Date.now)());
            return "bound";
          },
        } as never)).catch(reject);
    }));
    const created = await request("POST", "/api/model-accounts", {
      profileId: PROFILE, identity: PROFILE, agent: "codex", provider: "openrouter", authMode: "openrouter-api-key",
    });
    if (created.status !== 201) throw new CheckFailure(`create: status ${created.status}`);
    stage = "store";
    const stored = await request("PUT", `/api/model-accounts/${PROFILE}/credential`, { apiKey: key });
    if (stored.status !== 200) throw new CheckFailure(`store: status ${stored.status}`);
    stage = "binding";
    const binding = (deps.binding ?? readKeyBinding)(`model-account:${PROFILE}`);
    if (!binding) throw new CheckFailure("binding: missing");
    if (binding.destination !== "openrouter/openrouter-api-key") throw new CheckFailure("binding: mismatch");
    stage = "list";
    const listed = await request("GET", "/api/model-accounts");
    if (listed.text.includes(key)) throw new CheckFailure("list: key in answer");
    const accounts = JSON.parse(listed.text).accounts;
    if (listed.status !== 200 || !Array.isArray(accounts) || !accounts.some(a => a.profileId === PROFILE && a.credentialSet === true)) {
      throw new CheckFailure("list: credential not set");
    }
    stage = "resolve";
    const result = (deps.resolveCredential ?? resolveModelCredential)({
      profileId: PROFILE, revision: getAccountProfile(PROFILE)?.revision ?? 1, provider: "openrouter", authMode: "openrouter-api-key",
    }, {
      sessionStore: createModelSessionStore({ keys: createModelSessionKeyProvider(), verifyOwner: () => false, authorizeOperator: () => false }),
      resolveProtectedSecret: createModelProtectedSecrets().resolve,
    });
    if (!result.ok) throw new CheckFailure(`resolve: ${result.code}`);
    if (result.secret.kind !== "api-key") throw new CheckFailure("resolve: secret_invalid");
    return result.secret.apiKey;
  } catch (error) {
    if (error instanceof CheckFailure) throw error;
    // Fixed safe codes only; exceptions from dependencies may contain the key.
    throw new CheckFailure(stage === "create" || stage === "store" ? `${stage}: status 0`
      : stage === "binding" ? "binding: missing" : stage === "list" ? "list: credential not set" : "resolve: secret_unavailable");
  } finally {
    Object.assign(console, savedConsole);
    closeDb();
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
    rmSync(directory, { recursive: true, force: true });
  }
}

export async function runOpenRouterAccountLiveCheck({ env = process.env, fetchImpl = globalThis.fetch,
  now = Date.now, log = console.log, accountDeps = {},
}: { env?: NodeJS.ProcessEnv; fetchImpl?: typeof fetch; now?: () => number; log?: (line: string) => void; accountDeps?: AccountCheckDeps } = {}): Promise<number> {
  let result = "skipped (no key)";
  const key = env.OPENROUTER_TEST_API_KEY;
  if (key) {
    try {
      // The hook supplies its parent pipeline process identity on Linux. Hash the identity.
      // Outside a runner, omit deduplication rather than suppressing an unrelated future run.
      const run = (env.GITHUB_RUN_ID && `${env.GITHUB_RUN_ID}:${env.GITHUB_RUN_ATTEMPT ?? "1"}`) || env.OPENROUTER_ACCOUNT_CHECK_RUN_ID;
      if (run) {
        const marker = join(tmpdir(), `openrouter-account-live-check-${createHash("sha256").update(run).digest("hex")}.marker`);
        try { writeFileSync(marker, String(now()), { flag: "wx", mode: 0o600 }); }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
          log("openrouter-account-live-check: skipped (ran before in this run)");
          return 0;
        }
      }
      const credential = await createAndResolveOpenRouterAccount(key, { now, ...accountDeps });
      try {
        const response = await fetchImpl(`${OPENROUTER_HOST}/api/v1/key`, {
          method: "GET", headers: { Authorization: `Bearer ${credential}` }, redirect: "manual", signal: AbortSignal.timeout(20_000),
        });
        const status = response.status;
        result = status >= 200 && status < 300 ? "pass" : status === 401 || status === 403
          ? `fail (provider: key refused, status ${status})` : `fail (provider: status ${status})`;
      } catch { result = "fail (provider: no answer)"; }
    } catch (error) {
      result = `fail (${error instanceof CheckFailure ? error.message : "create: status 0"})`;
    }
  }
  log(`openrouter-account-live-check: ${result}`);
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await runOpenRouterAccountLiveCheck();
}
