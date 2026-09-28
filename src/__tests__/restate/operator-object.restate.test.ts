// Restate scenarios for the `Operator` Virtual Object (AII-709): the concurrency
// serialization and grace-window behavior that only a real exclusive-handler queue can
// prove, plus the alwaysReplay determinism check the operator rule (docs/restate.md)
// asks for. The exact grace-window boundary and the "unavailable" ingress-client path
// are unit-tested in operator-object.test.ts instead — a real container can only test
// that boundary with an actual 30-second wait, and the operator rule keeps that class of
// test in the default suite where it runs in milliseconds.
//
// Run with `npm run test:restate` (Docker required); excluded from `npm test`.
import crypto from "node:crypto";
import { randomUUID } from "node:crypto";
import { RestateTestEnvironment } from "@restatedev/restate-sdk-testcontainers";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { operatorObject, RestateRefreshAuthority } from "../../restate/operator-object.js";
import { getEffectiveAllowlist, matchAccessEntry } from "../../access-entries.js";
import { VARIANTS, callObject, startVariants, stopAll } from "./harness.js";

// Mocked so RestateRefreshAuthority.rotate's allowlist re-check and auth-event emission
// don't need the access_entries/mcp_auth_events tables in this container-only suite, which
// never opens the dedup DB — mirrors operator-object.test.ts's unit-tier mocks. Only the
// deauthorized-identity scenario below configures the allowlist mock.
vi.mock("../../access-entries.js", () => ({
  getEffectiveAllowlist: vi.fn(),
  matchAccessEntry: vi.fn(),
}));
vi.mock("../../mcp-auth-events.js", () => ({
  recordAuthEvent: vi.fn(),
  resolveClientPath: vi.fn(() => "unknown"),
}));

function sha256(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

interface IssueBody {
  email: string;
  sub: string;
  provider: string;
  hash: string;
  expiresAt: number;
}

type RefreshResult =
  | { status: "ok"; token: string; expiresAt: number; email: string; sub: string; provider: string }
  | { status: "replay" }
  | { status: "expired" };

interface DescribeResult {
  email: string | null;
  rotatedAt: number | null;
  expiresAt: number | null;
}

function issueBody(overrides: Partial<IssueBody> = {}): IssueBody {
  return {
    email: "ada@eudoxus.ai",
    sub: "google|1",
    provider: "google",
    hash: sha256(randomUUID()),
    expiresAt: Date.now() + 30 * 24 * 60 * 60 * 1000,
    ...overrides,
  };
}

describe("Operator object", () => {
  let environments: Map<string, RestateTestEnvironment>;

  beforeAll(async () => {
    environments = await startVariants([operatorObject]);
  }, 60_000);

  afterAll(async () => {
    await stopAll(environments);
  });

  it.each(VARIANTS.map(([label]) => label))(
    "two concurrent refresh calls presenting the current hash both succeed with the same new pair (%s)",
    async (label) => {
      const env = environments.get(label);
      if (!env) throw new Error(`environment "${label}" did not start`);
      const key = randomUUID();
      const raw = randomUUID();
      const hash = sha256(raw);
      await callObject(env.baseUrl(), "Operator", key, "issue", issueBody({ hash }));

      const [first, second] = await Promise.all([
        callObject<RefreshResult>(env.baseUrl(), "Operator", key, "refresh", { presentedHash: hash }),
        callObject<RefreshResult>(env.baseUrl(), "Operator", key, "refresh", { presentedHash: hash }),
      ]);

      expect(first.status).toBe("ok");
      expect(second.status).toBe("ok");
      expect(first).toEqual(second);
    },
  );

  it.each(VARIANTS.map(([label]) => label))(
    "a presentation of the previous hash within GRACE_MS returns the current pair (%s)",
    async (label) => {
      const env = environments.get(label);
      if (!env) throw new Error(`environment "${label}" did not start`);
      const key = randomUUID();
      const raw = randomUUID();
      const hash = sha256(raw);
      await callObject(env.baseUrl(), "Operator", key, "issue", issueBody({ hash }));

      const rotated = await callObject<RefreshResult>(env.baseUrl(), "Operator", key, "refresh", { presentedHash: hash });
      expect(rotated.status).toBe("ok");

      // Present the now-rotated-away hash again — immediately, well inside the 30s window.
      const concurrent = await callObject<RefreshResult>(env.baseUrl(), "Operator", key, "refresh", { presentedHash: hash });
      expect(concurrent).toEqual(rotated);
    },
  );

  it.each(VARIANTS.map(([label]) => label))(
    "an unknown hash returns replay without disturbing a live family (%s)",
    async (label) => {
      const env = environments.get(label);
      if (!env) throw new Error(`environment "${label}" did not start`);
      const key = randomUUID();
      const hash = sha256(randomUUID());
      await callObject(env.baseUrl(), "Operator", key, "issue", issueBody({ hash }));

      const forged = await callObject<RefreshResult>(env.baseUrl(), "Operator", key, "refresh", {
        presentedHash: sha256("forged"),
      });
      expect(forged).toEqual({ status: "replay" });

      // The legitimate current hash still works — the forged presentation did not clear state.
      const legitimate = await callObject<RefreshResult>(env.baseUrl(), "Operator", key, "refresh", { presentedHash: hash });
      expect(legitimate.status).toBe("ok");
    },
  );

  it.each(VARIANTS.map(([label]) => label))(
    "an expired family returns expired and clears state (%s)",
    async (label) => {
      const env = environments.get(label);
      if (!env) throw new Error(`environment "${label}" did not start`);
      const key = randomUUID();
      const hash = sha256(randomUUID());
      await callObject(env.baseUrl(), "Operator", key, "issue", issueBody({ hash, expiresAt: Date.now() - 1000 }));

      const result = await callObject<RefreshResult>(env.baseUrl(), "Operator", key, "refresh", { presentedHash: hash });
      expect(result).toEqual({ status: "expired" });

      const description = await callObject<DescribeResult>(env.baseUrl(), "Operator", key, "describe", {});
      expect(description).toEqual({ email: null, rotatedAt: null, expiresAt: null });
    },
  );

  it.each(VARIANTS.map(([label]) => label))(
    "revoke clears state; a subsequent refresh sees no family (%s)",
    async (label) => {
      const env = environments.get(label);
      if (!env) throw new Error(`environment "${label}" did not start`);
      const key = randomUUID();
      const hash = sha256(randomUUID());
      await callObject(env.baseUrl(), "Operator", key, "issue", issueBody({ hash }));
      await callObject(env.baseUrl(), "Operator", key, "revoke", {});

      const result = await callObject<RefreshResult>(env.baseUrl(), "Operator", key, "refresh", { presentedHash: hash });
      expect(result).toEqual({ status: "replay" });
    },
  );

  it.each(VARIANTS.map(([label]) => label))(
    "a new sign-in after a prior revoke() works: issue, revoke, issue again, refresh succeeds (%s)",
    async (label) => {
      const env = environments.get(label);
      if (!env) throw new Error(`environment "${label}" did not start`);
      const key = randomUUID();
      const firstHash = sha256(randomUUID());
      await callObject(env.baseUrl(), "Operator", key, "issue", issueBody({ hash: firstHash }));
      await callObject(env.baseUrl(), "Operator", key, "revoke", {});

      // The old family's hash must no longer work post-revoke.
      const afterRevoke = await callObject<RefreshResult>(env.baseUrl(), "Operator", key, "refresh", {
        presentedHash: firstHash,
      });
      expect(afterRevoke).toEqual({ status: "replay" });

      const secondHash = sha256(randomUUID());
      await callObject(env.baseUrl(), "Operator", key, "issue", issueBody({ hash: secondHash, email: "re-signed-in@eudoxus.ai" }));

      const refreshed = await callObject<RefreshResult>(env.baseUrl(), "Operator", key, "refresh", { presentedHash: secondHash });
      expect(refreshed.status).toBe("ok");
      if (refreshed.status === "ok") {
        expect(refreshed.email).toBe("re-signed-in@eudoxus.ai");
      }
    },
  );

  it.each(VARIANTS.map(([label]) => label))(
    "describe returns email, rotatedAt, and expiresAt without any hash (%s)",
    async (label) => {
      const env = environments.get(label);
      if (!env) throw new Error(`environment "${label}" did not start`);
      const key = randomUUID();
      const hash = sha256(randomUUID());
      await callObject(env.baseUrl(), "Operator", key, "issue", issueBody({ hash, email: "describe-test@eudoxus.ai" }));

      const description = await callObject<Record<string, unknown>>(env.baseUrl(), "Operator", key, "describe", {});
      expect(Object.keys(description).sort()).toEqual(["email", "expiresAt", "rotatedAt"]);
      expect(description.email).toBe("describe-test@eudoxus.ai");
      expect(typeof description.rotatedAt).toBe("number");
      expect(typeof description.expiresAt).toBe("number");
    },
  );

  it.each(VARIANTS.map(([label]) => label))(
    "identity returns sub and provider and no hash; a subsequent refresh with the current hash rotates (%s, AII-718)",
    async (label) => {
      const env = environments.get(label);
      if (!env) throw new Error(`environment "${label}" did not start`);
      const key = randomUUID();
      const hash = sha256(randomUUID());
      await callObject(
        env.baseUrl(),
        "Operator",
        key,
        "issue",
        issueBody({ hash, sub: "google|identity-test", provider: "google", email: "identity-test@eudoxus.ai" }),
      );

      const identityResult = await callObject<Record<string, unknown>>(env.baseUrl(), "Operator", key, "identity", {});
      expect(Object.keys(identityResult).sort()).toEqual(["email", "expiresAt", "provider", "sub"]);
      expect(identityResult.email).toBe("identity-test@eudoxus.ai");
      expect(identityResult.sub).toBe("google|identity-test");
      expect(identityResult.provider).toBe("google");
      expect(identityResult).not.toHaveProperty("hash");
      expect(identityResult).not.toHaveProperty("currentHash");
      expect(identityResult).not.toHaveProperty("rotatedAt");

      const refreshed = await callObject<RefreshResult>(env.baseUrl(), "Operator", key, "refresh", { presentedHash: hash });
      expect(refreshed.status).toBe("ok");
    },
  );

  it("state after issue then two refresh calls is equivalent whether or not the server forces replay", async () => {
    async function runSequence(env: RestateTestEnvironment): Promise<{
      rotateStatus: string;
      concurrentStatus: string;
      concurrentReturnedTheSameTokenAsTheRotation: boolean;
    }> {
      const key = randomUUID();
      const raw = randomUUID();
      const hash = sha256(raw);
      await callObject(env.baseUrl(), "Operator", key, "issue", issueBody({ hash }));
      const rotated = await callObject<RefreshResult>(env.baseUrl(), "Operator", key, "refresh", { presentedHash: hash });
      const concurrent = await callObject<RefreshResult>(env.baseUrl(), "Operator", key, "refresh", { presentedHash: hash });
      return {
        rotateStatus: rotated.status,
        concurrentStatus: concurrent.status,
        concurrentReturnedTheSameTokenAsTheRotation:
          rotated.status === "ok" && concurrent.status === "ok" && rotated.token === concurrent.token,
      };
    }

    const alwaysReplayEnv = environments.get("alwaysReplay");
    const disableRetriesEnv = environments.get("disableRetries");
    if (!alwaysReplayEnv || !disableRetriesEnv) throw new Error("both environments must be started");

    const withReplay = await runSequence(alwaysReplayEnv);
    const withoutReplay = await runSequence(disableRetriesEnv);

    expect(withReplay).toEqual({
      rotateStatus: "ok",
      concurrentStatus: "ok",
      concurrentReturnedTheSameTokenAsTheRotation: true,
    });
    expect(withoutReplay).toEqual(withReplay);
  });

  // AII-727: the coverage gap this closes is "describe during an in-flight exclusive
  // refresh" (docs/restate-testing.md) — only a real exclusive-handler queue can prove a
  // shared handler is genuinely non-blocking against a suspended exclusive one, not a fake.
  // Run against disableRetries only: alwaysReplay forces the server to replay the handler's
  // journal at every suspension point, which is an unrelated axis from the wall-clock
  // assertion here and would only add timing noise to it.
  it(
    "describe (shared) answers while a refresh (exclusive) is suspended on ctx.sleep, on the same key (AII-727)",
    async () => {
      const env = environments.get("disableRetries");
      if (!env) throw new Error('environment "disableRetries" did not start');
      const key = randomUUID();
      const hash = sha256(randomUUID());
      await callObject(env.baseUrl(), "Operator", key, "issue", issueBody({ hash, email: "sleep-test@eudoxus.ai" }));

      const sleepMs = 8_000;
      const inFlight = callObject<RefreshResult>(env.baseUrl(), "Operator", key, "refresh", {
        presentedHash: hash,
        sleepMs,
      });
      // Give the exclusive invocation a moment to be admitted and start sleeping before
      // racing describe against it — otherwise describe could simply win an admission race
      // that says nothing about concurrency with an in-flight exclusive call.
      await new Promise((resolve) => setTimeout(resolve, 1_000));

      const start = Date.now();
      const description = await callObject<DescribeResult>(env.baseUrl(), "Operator", key, "describe", {});
      const elapsed = Date.now() - start;

      expect(description.email).toBe("sleep-test@eudoxus.ai");
      // A bounded wait, not a timing race: describe must resolve well before the sleep's
      // own deadline, not merely before some arbitrary long test timeout.
      expect(elapsed).toBeLessThan(sleepMs - 2_000);

      const refreshed = await inFlight;
      expect(refreshed.status).toBe("ok");
    },
    20_000,
  );

  // AII-727: RestateRefreshAuthority has only ever met a faked fetch (operator-object.test.ts)
  // or the plain unit-level branches — never the real ingress, and never the revoke call this
  // path triggers. Reuses this describe block's own shared container/environments so no
  // second boot is needed.
  it(
    "RestateRefreshAuthority.rotate: a deauthorized identity is denied and revoke is called exactly once against the real ingress; describe returns all-null afterward",
    async () => {
      const env = environments.get("disableRetries");
      if (!env) throw new Error('environment "disableRetries" did not start');
      const key = randomUUID();
      const raw = randomUUID();
      const hash = sha256(raw);
      await callObject(env.baseUrl(), "Operator", key, "issue", issueBody({ hash, email: "denied@eudoxus.ai" }));

      vi.mocked(getEffectiveAllowlist).mockReturnValue({ entries: [], source: "env" });
      vi.mocked(matchAccessEntry).mockReturnValue(null);

      const revokeCalls: string[] = [];
      const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
        if (url.endsWith("/revoke")) revokeCalls.push(url);
        return fetch(url, init);
      });

      const authority = new RestateRefreshAuthority({
        ingressBaseUrl: env.baseUrl(),
        accessTokenTtlMs: 3600_000,
        fetchImpl: fetchImpl as unknown as typeof fetch,
      });

      const outcome = await authority.rotate({ refreshToken: raw, clientId: key });
      expect(outcome).toEqual({ status: "denied", description: "Identity no longer authorized" });
      expect(revokeCalls).toHaveLength(1);

      const description = await callObject<DescribeResult>(env.baseUrl(), "Operator", key, "describe", {});
      expect(description).toEqual({ email: null, rotatedAt: null, expiresAt: null });
    },
    20_000,
  );
});
