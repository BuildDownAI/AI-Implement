// Restate scenarios for the `AccessBinding` object (AII-1523): concurrent first sign-ins for one
// address and provider serialize to one winner, a replayed step does not write twice, and
// `Operator.refresh` still admits a family after the entry gains a second provider binding.
//
// Run with `npm run test:restate` (binary runtime, no Docker); excluded from `npm test`.
import { randomUUID } from "node:crypto";
import type { RestateEnvironment } from "./harness.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeDb, getDb } from "../../dedup.js";
import { initAccessAuditTable } from "../../access-audit.js";
import { clearAccessBindings, getEffectiveAllowlist, initAccessEntriesTable, isBoundTo, saveAccessEntries, refreshEffectiveAllowlist } from "../../access-entries.js";
import { initMcpOAuthTables } from "../../mcp-oauth.js";
import { RestateRefreshAuthority } from "../../restate/operator-object.js";
import { operatorObject } from "../../restate/operator-object.js";
import { vi } from "vitest";
import { bindAccessIdentity, bindStep, clearAccessBindingsViaObject, type AccessBindStatus } from "../../restate/access-binding.js";
import { accessBinding } from "../../restate/access-binding.js";
import { VARIANTS, callObject, crashAfterFirstCall, startRetryEnabled, startVariants, stopAll } from "./harness.js";
import * as restate from "@restatedev/restate-sdk";
import { serde } from "@restatedev/restate-sdk-zod";
import { z } from "zod";

const rows = (value: string, provider: string) =>
  getDb().prepare("SELECT subject FROM access_entry_bindings WHERE value = ? AND provider = ?").all(value, provider) as { subject: string }[];

vi.mock("../../mcp-auth-events.js", () => ({ recordAuthEvent: vi.fn(), resolveClientPath: vi.fn(() => "unknown") }));

describe("AccessBinding object", () => {
  let environments: Map<string, RestateEnvironment>;

  beforeAll(async () => {
    process.env.DEDUP_DB_PATH = ":memory:";
    initAccessEntriesTable();
    initAccessAuditTable();
    environments = await startVariants([accessBinding, operatorObject]);
  }, 120_000);

  afterAll(async () => {
    await stopAll(environments);
    closeDb();
  });

  describe.each(VARIANTS)("%s", (variant) => {
    const env = () => {
      const e = environments.get(variant);
      if (!e) throw new Error(`environment "${variant}" did not start`);
      return e;
    };

    it("two concurrent binds with different subjects give one bound and one conflict", async () => {
      const key = `${randomUUID()}@eudoxus.ai`;
      const results = await Promise.all([
        callObject<{ status: AccessBindStatus }>(env().baseUrl(), "AccessBinding", key, "bind", { provider: "google", subject: "g-1" }),
        callObject<{ status: AccessBindStatus }>(env().baseUrl(), "AccessBinding", key, "bind", { provider: "google", subject: "g-2" }),
      ]);
      expect(results.map((r) => r.status).sort()).toEqual(["bound", "conflict"]);
      expect(rows(key, "google")).toHaveLength(1);
    });

    it("binds each provider once, and the same subject again is already-bound", async () => {
      const key = `${randomUUID()}@eudoxus.ai`;
      const bind = (provider: string, subject: string) =>
        callObject<{ status: AccessBindStatus }>(env().baseUrl(), "AccessBinding", key, "bind", { provider, subject });
      expect((await bind("google", "g-1")).status).toBe("bound");
      expect((await bind("builddown", "u-9")).status).toBe("bound");
      expect((await bind("google", "g-1")).status).toBe("already-bound");
      expect((await bind("google", "g-2")).status).toBe("conflict");
    });

    it("concurrent bind and clear for one address end in exactly one of two states", async () => {
      const key = `${randomUUID()}@eudoxus.ai`;
      saveAccessEntries([{ kind: "address", value: "ada@eudoxus.ai", role: "admin" }, { kind: "address", value: key, role: "user" }], null);
      const base = env().baseUrl();
      const seen = new Set<string>();
      for (let i = 0; i < 20; i++) {
        getDb().prepare("DELETE FROM access_entry_bindings WHERE value = ?").run(key);
        // The pre-existing binding a clear must remove; the raced bind uses another provider.
        bindStep(key, "microsoft", "m-1");
        const [bound, cleared] = await Promise.all([
          callObject<{ status: AccessBindStatus }>(base, "AccessBinding", key, "bind", { provider: "google", subject: "g-1" }),
          callObject<{ removed: number }>(base, "AccessBinding", key, "clear", { actor: null }),
        ]);
        expect(bound.status).toBe("bound");
        const left = (getDb().prepare("SELECT provider FROM access_entry_bindings WHERE value = ?").all(key) as { provider: string }[]).map((r) => r.provider);
        // cleared-then-bound: only the new google row; bound-then-cleared: nothing. Never the old microsoft row.
        if (left.length === 1) {
          expect(left).toEqual(["google"]);
          expect(cleared.removed).toBe(1);
        } else {
          expect(left).toEqual([]);
          expect(cleared.removed).toBe(2);
        }
        seen.add(String(left.length));
      }
      expect(seen.size).toBeGreaterThan(0);
    }, 60_000);

    it("clear is idempotent: a second clear deletes nothing and succeeds", async () => {
      const key = `${randomUUID()}@eudoxus.ai`;
      bindStep(key, "google", "g-1");
      expect((await callObject<{ removed: number }>(env().baseUrl(), "AccessBinding", key, "clear", { actor: null })).removed).toBe(1);
      expect((await callObject<{ removed: number }>(env().baseUrl(), "AccessBinding", key, "clear", { actor: null })).removed).toBe(0);
      expect(rows(key, "google")).toEqual([]);
    });
  });

  it("clearAccessBindingsViaObject clears through the object, and with the ingress down throws without deleting", async () => {
    const env = environments.get("disableRetries")!;
    const key = `${randomUUID()}@eudoxus.ai`;
    saveAccessEntries([{ kind: "address", value: "ada@eudoxus.ai", role: "admin" }, { kind: "address", value: key, role: "user" }], null);
    bindStep(key, "google", "g-1");
    const down = (async () => { throw new Error("ECONNREFUSED"); }) as unknown as typeof fetch;
    await expect(clearAccessBindingsViaObject(key, "ada@eudoxus.ai", { baseUrl: env.baseUrl(), fetchImpl: down })).rejects.toThrow();
    expect(rows(key, "google")).toHaveLength(1);
    expect(await clearAccessBindingsViaObject(key, "ada@eudoxus.ai", { baseUrl: env.baseUrl() })).toBe(1);
    expect(rows(key, "google")).toEqual([]);
  }, 30_000);

  it("already-bound refreshes a stale cache, so the next sign-in makes zero ingress calls", async () => {
    const env = environments.get("disableRetries")!;
    const addr = `${randomUUID()}@eudoxus.ai`;
    saveAccessEntries([{ kind: "address", value: "ada@eudoxus.ai", role: "admin" }, { kind: "address", value: addr, role: "user" }], null);
    // The binding lands behind the cache (another process bound it); the cache is stale.
    expect(bindStep(addr, "google", "g-1")).toBe("bound");
    const counted = vi.fn((...a: Parameters<typeof fetch>) => fetch(...a));
    const deps = { baseUrl: env.baseUrl(), fetchImpl: counted as unknown as typeof fetch };
    const entry = () => getEffectiveAllowlist()!.entries.find((e) => e.value === addr)!;
    expect(isBoundTo(entry(), { provider: "google", sub: "g-1" })).toBe(false);

    expect(await bindAccessIdentity(addr, "google", "g-1", deps)).toBe("already-bound");
    expect(counted).toHaveBeenCalled();
    counted.mockClear();
    expect(isBoundTo(entry(), { provider: "google", sub: "g-1" })).toBe(true); // routes skip the ingress now
    expect(counted).not.toHaveBeenCalled();
  }, 30_000);

  it("Operator.refresh (RestateRefreshAuthority.rotate) admits a builddown family after the entry also has a google binding, and denies a mismatched sub", async () => {
    const env = environments.get("disableRetries");
    if (!env) throw new Error('environment "disableRetries" did not start');
    saveAccessEntries([{ kind: "address", value: "ada@eudoxus.ai", role: "admin" }], null);
    expect(bindStep("ada@eudoxus.ai", "builddown", "u-9")).toBe("bound");
    expect(bindStep("ada@eudoxus.ai", "google", "g-1")).toBe("bound");
    refreshEffectiveAllowlist();
    initMcpOAuthTables();

    const authority = new RestateRefreshAuthority({
      ingressBaseUrl: env.baseUrl(),
      accessTokenTtlMs: 3600_000,
      refreshKeySecret: "test-secret",
    });
    const issue = async (sub: string) => {
      const clientId = randomUUID();
      const issued = await authority.issue({ clientId, email: "ada@eudoxus.ai", sub, provider: "builddown" });
      if (issued.status !== "ok") throw new Error("issue failed");
      return { clientId, refreshToken: issued.refreshToken };
    };

    const good = await issue("u-9");
    expect((await authority.rotate(good)).status).toBe("ok");

    const bad = await issue("someone-else");
    expect(await authority.rotate(bad)).toEqual({ status: "denied", description: "Identity no longer authorized" });
  }, 30_000);
});

describe("AccessBinding replay", () => {
  let env: RestateEnvironment;
  const flaky = crashAfterFirstCall(async (value: string, provider: string, subject: string) => bindStep(value, provider, subject));
  const flakyClear = crashAfterFirstCall(async (value: string) => clearAccessBindings(value, null));
  const replaying = restate.object({
    name: "AccessBinding",
    handlers: {
      bind: restate.handlers.object.exclusive(
        { input: serde.zod(z.object({ provider: z.string(), subject: z.string() })) },
        async (ctx: restate.ObjectContext, input: { provider: string; subject: string }) => ({
          status: await ctx.run("bind", () => flaky(ctx.key, input.provider, input.subject)),
        }),
      ),
      clear: restate.handlers.object.exclusive(
        { input: serde.zod(z.object({ actor: z.string().nullable() })) },
        async (ctx: restate.ObjectContext) => ({ removed: await ctx.run("clear", () => flakyClear(ctx.key)) }),
      ),
    },
  });

  beforeAll(async () => {
    process.env.DEDUP_DB_PATH = ":memory:";
    initAccessEntriesTable();
    initAccessAuditTable();
    env = await startRetryEnabled([replaying]);
  }, 120_000);

  afterAll(async () => {
    await env.stop();
    closeDb();
  });

  it("a replayed clear step deletes nothing extra and returns success", async () => {
    const key = `${randomUUID()}@eudoxus.ai`;
    bindStep(key, "google", "g-1");
    const result = await callObject<{ removed: number }>(env.baseUrl(), "AccessBinding", key, "clear", { actor: null });
    expect(result.removed).toBe(0); // the first attempt deleted the row and crashed; the retry finds nothing
    expect(rows(key, "google")).toEqual([]);
  }, 60_000);

  it("a retried bind after the row committed reports already-bound and writes no second row", async () => {
    const key = `${randomUUID()}@eudoxus.ai`;
    const result = await callObject<{ status: AccessBindStatus }>(env.baseUrl(), "AccessBinding", key, "bind", { provider: "google", subject: "g-1" });
    expect(result.status).toBe("already-bound");
    expect(rows(key, "google")).toEqual([{ subject: "g-1" }]);
  }, 60_000);
});
