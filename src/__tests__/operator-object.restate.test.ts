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
import { RestateContainer, RestateTestEnvironment } from "@restatedev/restate-sdk-testcontainers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { operatorObject } from "../restate/operator-object.js";

// Pinned to match the image cached by .github/workflows/unit-tests.yml's restate-tests job.
const RESTATE_IMAGE_VERSION = "1.7.10";

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

// Matches what the ingress expects for a virtual object: `${url}/${object}/${key}/${handler}`
// (restate-harness.restate.test.ts documents the same convention for services/workflows).
async function callObject<T>(baseUrl: string, key: string, handler: string, body: unknown): Promise<T> {
  const response = await fetch(`${baseUrl}/Operator/${encodeURIComponent(key)}/${handler}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    throw new Error(`Operator/${key}/${handler} failed: ${response.status} ${await response.text()}`);
  }
  return response.json() as Promise<T>;
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

const VARIANTS = [
  ["alwaysReplay", (container: RestateContainer) => container.alwaysReplay()],
  ["disableRetries", (container: RestateContainer) => container.disableRetries()],
] satisfies Array<[string, (container: RestateContainer) => RestateContainer]>;

describe("Operator object", () => {
  const environments = new Map<string, RestateTestEnvironment>();

  beforeAll(async () => {
    const started = await Promise.all(
      VARIANTS.map(async ([label, configure]) => {
        const env = await RestateTestEnvironment.start({
          services: [operatorObject],
          container: () => configure(new RestateContainer(RESTATE_IMAGE_VERSION)),
        });
        return [label, env] as const;
      }),
    );
    for (const [label, env] of started) {
      environments.set(label, env);
    }
  }, 60_000);

  afterAll(async () => {
    await Promise.all([...environments.values()].map((env) => env.stop()));
  });

  it.each(VARIANTS.map(([label]) => label))(
    "two concurrent refresh calls presenting the current hash both succeed with the same new pair (%s)",
    async (label) => {
      const env = environments.get(label);
      if (!env) throw new Error(`environment "${label}" did not start`);
      const key = randomUUID();
      const raw = randomUUID();
      const hash = sha256(raw);
      await callObject(env.baseUrl(), key, "issue", issueBody({ hash }));

      const [first, second] = await Promise.all([
        callObject<RefreshResult>(env.baseUrl(), key, "refresh", { presentedHash: hash }),
        callObject<RefreshResult>(env.baseUrl(), key, "refresh", { presentedHash: hash }),
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
      await callObject(env.baseUrl(), key, "issue", issueBody({ hash }));

      const rotated = await callObject<RefreshResult>(env.baseUrl(), key, "refresh", { presentedHash: hash });
      expect(rotated.status).toBe("ok");

      // Present the now-rotated-away hash again — immediately, well inside the 30s window.
      const concurrent = await callObject<RefreshResult>(env.baseUrl(), key, "refresh", { presentedHash: hash });
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
      await callObject(env.baseUrl(), key, "issue", issueBody({ hash }));

      const forged = await callObject<RefreshResult>(env.baseUrl(), key, "refresh", { presentedHash: sha256("forged") });
      expect(forged).toEqual({ status: "replay" });

      // The legitimate current hash still works — the forged presentation did not clear state.
      const legitimate = await callObject<RefreshResult>(env.baseUrl(), key, "refresh", { presentedHash: hash });
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
      await callObject(env.baseUrl(), key, "issue", issueBody({ hash, expiresAt: Date.now() - 1000 }));

      const result = await callObject<RefreshResult>(env.baseUrl(), key, "refresh", { presentedHash: hash });
      expect(result).toEqual({ status: "expired" });

      const description = await callObject<DescribeResult>(env.baseUrl(), key, "describe", {});
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
      await callObject(env.baseUrl(), key, "issue", issueBody({ hash }));
      await callObject(env.baseUrl(), key, "revoke", {});

      const result = await callObject<RefreshResult>(env.baseUrl(), key, "refresh", { presentedHash: hash });
      expect(result).toEqual({ status: "replay" });
    },
  );

  it.each(VARIANTS.map(([label]) => label))(
    "describe returns email, rotatedAt, and expiresAt without any hash (%s)",
    async (label) => {
      const env = environments.get(label);
      if (!env) throw new Error(`environment "${label}" did not start`);
      const key = randomUUID();
      const hash = sha256(randomUUID());
      await callObject(env.baseUrl(), key, "issue", issueBody({ hash, email: "describe-test@eudoxus.ai" }));

      const description = await callObject<Record<string, unknown>>(env.baseUrl(), key, "describe", {});
      expect(Object.keys(description).sort()).toEqual(["email", "expiresAt", "rotatedAt"]);
      expect(description.email).toBe("describe-test@eudoxus.ai");
      expect(typeof description.rotatedAt).toBe("number");
      expect(typeof description.expiresAt).toBe("number");
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
      await callObject(env.baseUrl(), key, "issue", issueBody({ hash }));
      const rotated = await callObject<RefreshResult>(env.baseUrl(), key, "refresh", { presentedHash: hash });
      const concurrent = await callObject<RefreshResult>(env.baseUrl(), key, "refresh", { presentedHash: hash });
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
});
