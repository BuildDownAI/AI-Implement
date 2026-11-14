import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeDb, getDb } from "../../dedup.js";
import { keyBinding, initKeyBindingsTable, readKeyBinding, bindKey, clearKeyBinding, type KeyBindStatus } from "../../restate/key-binding.js";
import { VARIANTS, callObject, startVariants, stopAll, type RestateEnvironment } from "./harness.js";

describe("KeyBinding", () => {
  let environments: Map<string, RestateEnvironment>;
  beforeAll(async () => {
    process.env.DEDUP_DB_PATH = ":memory:";
    initKeyBindingsTable();
    initKeyBindingsTable();
    environments = await startVariants([keyBinding]);
  }, 120_000);
  afterAll(async () => { await stopAll(environments); closeDb(); });

  describe.each(VARIANTS)("%s", (variant) => {
    const base = () => environments.get(variant)!.baseUrl();
    it("binds once, accepts the same destination, refuses another without mutation, and clears idempotently", async () => {
      const key = `model-account:${randomUUID()}`;
      const bind = (destination: string) => callObject<{ status: KeyBindStatus }>(base(), "KeyBinding", key, "bind", { destination });
      expect(await bind("anthropic/anthropic-api-key")).toEqual({ status: "bound" });
      const row = readKeyBinding(key);
      expect(row).toMatchObject({ destination: "anthropic/anthropic-api-key" });
      initKeyBindingsTable();
      expect(await bind("anthropic/anthropic-api-key")).toEqual({ status: "already-bound" });
      expect(await bind("openrouter/openrouter-api-key")).toEqual({ status: "conflict" });
      expect(readKeyBinding(key)).toEqual(row);
      expect(await callObject(base(), "KeyBinding", key, "clear", {})).toEqual({ removed: 1 });
      expect(await callObject(base(), "KeyBinding", key, "clear", {})).toEqual({ removed: 0 });
      expect(readKeyBinding(key)).toBeUndefined();
    });
    it("serializes competing destinations to one bound and one conflict", async () => {
      const key = `model-account:${randomUUID()}`;
      const results = await Promise.all(["anthropic/anthropic-api-key", "openrouter/openrouter-api-key"].map(destination =>
        bindKey(key, destination, { baseUrl: base() })));
      expect(results.sort()).toEqual(["bound", "conflict"]);
      expect(await clearKeyBinding(key, { baseUrl: base() })).toBe(1);
    });
    it("fences a clear whose ingress request arrives after client failure", async () => {
      const key = `model-account:${randomUUID()}`;
      expect(await bindKey(key, "anthropic/anthropic-api-key", { baseUrl: base() })).toBe("bound");
      let deliver!: () => Promise<Response>;
      await expect(clearKeyBinding(key, { baseUrl: base(), fetchImpl: (async (input, init) => {
        deliver = () => fetch(input, { ...init, signal: undefined });
        throw new Error("ambiguous timeout");
      }) as typeof fetch })).rejects.toThrow("key binding service unavailable");
      expect(await bindKey(key, "anthropic/anthropic-api-key", { baseUrl: base() })).toBe("already-bound");
      expect((await deliver()).ok).toBe(true);
      expect(readKeyBinding(key)?.destination).toBe("anthropic/anthropic-api-key");
      expect(getDb().prepare("SELECT * FROM key_binding_operations").all()).toEqual([]);
    });
    it("fails closed when ingress is unavailable", async () => {
      const key = `model-account:${randomUUID()}`;
      const deps = { baseUrl: base(), fetchImpl: (async () => { throw new Error("offline"); }) as typeof fetch };
      expect(await bindKey(key, "anthropic/anthropic-api-key", deps)).toBe("unavailable");
      expect(readKeyBinding(key)).toBeUndefined();
      await expect(clearKeyBinding(key, deps)).rejects.toThrow("key binding service unavailable");
    });
  });
});
