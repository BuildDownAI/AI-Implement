import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { testDb } from "./helpers/test-db.js";

async function fixture() {
  return testDb({ modules: {
    seed: () => import("../seed-once-settings.js"),
    kg: () => import("../kg-graph-source.js"),
    dedup: () => import("../dedup.js"),
    secrets: () => import("../model-protected-secrets.js"),
  } });
}
beforeEach(() => vi.stubEnv("RUNNER_TOKEN_SECRET", "kg-test-encryption-key"));
afterEach(() => vi.unstubAllEnvs());

describe("KG graph source", () => {
  it("defaults to sidecar, validates writes, and persists across reopen", async () => {
    const f = await fixture();
    expect(f.modules.kg.getKgGraphSource()).toBe("sidecar");
    f.modules.kg.setKgGraphSource("stardog_run");
    expect((await f.reopen()).kg.getKgGraphSource()).toBe("stardog_run");
    expect(() => f.modules.kg.setKgGraphSource("other" as never)).toThrow("Invalid KG graph source");
  });

  it("round trips stored fields and a long encrypted token without exposing it", async () => {
    const f = await fixture();
    const { kg, dedup } = f.modules;
    vi.stubEnv("KG_STARDOG_DB", "ambient-db");
    expect(kg.getStardogValues()).toEqual({
      db: "", runEndpoint: "", runConsole: "", runPlatform: "https://app.stardog.run",
      namespace: "", graphName: "", tokenSet: false,
    });
    const token = "SENTINEL-" + "t".repeat(1191);
    expect(token).toHaveLength(1200);
    const fields = {
      db: "stored-db", runEndpoint: "https://query.example/sparql", runConsole: "https://console.example/",
      runPlatform: "https://import.example/", namespace: "https://kg.example/", graphName: "builddown-kg",
    };
    kg.setKgGraphSource("stardog_run");
    kg.setStardogValues({ ...fields, token });
    expect(kg.getStardogValues()).toEqual({ ...fields, tokenSet: true });
    const settings = dedup.getDb().prepare("SELECT * FROM settings").all();
    expect(JSON.stringify(settings)).not.toContain(token);
    expect(settings).not.toContainEqual(expect.objectContaining({ key: "kg_stardog_dataset" }));
    const row = dedup.getDb().prepare("SELECT secret_ref, ciphertext FROM model_protected_secrets").get() as { secret_ref: string; ciphertext: Buffer };
    expect(row.secret_ref).toBe(kg.STARDOG_RUN_TOKEN_REF);
    expect(row.ciphertext.toString()).not.toContain(token);
    vi.stubEnv("KG_STARDOG_DATASET", "ambient-dataset");
    expect(kg.stardogChildEnv()).toEqual({
      KG_BACKEND: "stardog_run", KG_STARDOG_DB: fields.db, KG_STARDOG_RUN_ENDPOINT: fields.runEndpoint,
      KG_STARDOG_RUN_CONSOLE: fields.runConsole, KG_STARDOG_RUN_PLATFORM: fields.runPlatform,
      KG_NAMESPACE: fields.namespace, KG_STARDOG_RUN_TOKEN: token,
      KG_STARDOG_DATASET: "tag:stardog:kit:alias:builddown_kg",
    });
    expect((await f.reopen()).kg.stardogChildEnv().KG_STARDOG_RUN_TOKEN).toBe(token);
  });

  it("uses only the dataset environment fallback and supports clearing and partial updates", async () => {
    const { modules: { kg } } = await fixture();
    vi.stubEnv("KG_STARDOG_DATASET", "legacy-dataset");
    expect(kg.stardogChildEnv().KG_STARDOG_DATASET).toBe("legacy-dataset");
    kg.setStardogValues({ graphName: "builddown-kg", token: "stored-token", db: "db" });
    kg.setStardogValues({ runConsole: "https://console.example" });
    expect(kg.getStardogValues()).toMatchObject({ db: "db", tokenSet: true });
    kg.setStardogValues({ graphName: "", token: "", runPlatform: "" });
    expect(kg.stardogDataset()).toBe("legacy-dataset");
    expect(kg.getStardogValues()).toMatchObject({ tokenSet: false, runPlatform: "https://app.stardog.run" });
    vi.stubEnv("KG_STARDOG_DATASET", undefined);
    expect(kg.stardogDataset()).toBeUndefined();
  });

  it("reports unreadable or non-string credentials as not set", async () => {
    const { modules: { kg, secrets } } = await fixture();
    kg.setStardogValues({ token: "stored-token" });
    vi.stubEnv("RUNNER_TOKEN_SECRET", "rotated-key");
    expect(kg.getStardogValues().tokenSet).toBe(false);
    expect(kg.stardogChildEnv().KG_STARDOG_RUN_TOKEN).toBe("");
    vi.stubEnv("RUNNER_TOKEN_SECRET", undefined);
    expect(kg.getStardogValues().tokenSet).toBe(false);
    vi.stubEnv("RUNNER_TOKEN_SECRET", "kg-test-encryption-key");
    secrets.createModelProtectedSecrets().write(kg.STARDOG_RUN_TOKEN_REF, {
      region: "us-east-1", accessKeyId: "access", secretAccessKey: "secret",
    });
    expect(kg.getStardogValues().tokenSet).toBe(false);
  });

  it("rejects invalid fields and rolls back updates when token storage fails", async () => {
    const { modules: { kg, dedup } } = await fixture();
    for (const values of [
      { graphName: "bad/name" }, { namespace: "relative" }, { namespace: "javascript:alert(1)" },
      { runEndpoint: "https://user:password@example.com" }, { db: "bad\nvalue" }, { token: "x".repeat(4097) },
    ]) expect(() => kg.setStardogValues(values)).toThrow();
    expect(dedup.getDb().prepare("SELECT * FROM settings").all()).toEqual([]);
    vi.stubEnv("RUNNER_TOKEN_SECRET", undefined);
    expect(() => kg.setStardogValues({ db: "no-write", token: "token" })).toThrow("key_unavailable");
    vi.stubEnv("RUNNER_TOKEN_SECRET", "kg-test-encryption-key");
    dedup.getDb().exec("CREATE TRIGGER reject_token BEFORE INSERT ON model_protected_secrets BEGIN SELECT RAISE(ABORT, 'no'); END");
    expect(() => kg.setStardogValues({ db: "no-write", token: "token" })).toThrow("write_failed");
    expect(kg.getStardogValues()).toMatchObject({ db: "", tokenSet: false });
  });
});


it("seeds values and encrypted token once, preserving even an unreadable token row", async () => {
  const { modules: { kg, seed, dedup } } = await fixture();
  const env = {
    KG_BACKEND: "stardog_run", KG_STARDOG_DB: "graph", KG_NAMESPACE: "https://kg.example/",
    KG_STARDOG_RUN_ENDPOINT: "https://query.example/", KG_STARDOG_RUN_CONSOLE: "https://console.example/",
    KG_STARDOG_RUN_TOKEN: "seed-token", KG_STARDOG_DATASET: "dataset",
  };
  seed.seedSettingsFromEnv(env);
  expect(kg.getKgGraphSource()).toBe("stardog_run");
  expect(kg.stardogChildEnv()).toMatchObject({
    KG_STARDOG_DB: env.KG_STARDOG_DB, KG_NAMESPACE: env.KG_NAMESPACE,
    KG_STARDOG_RUN_ENDPOINT: env.KG_STARDOG_RUN_ENDPOINT, KG_STARDOG_RUN_CONSOLE: env.KG_STARDOG_RUN_CONSOLE,
    KG_STARDOG_RUN_TOKEN: env.KG_STARDOG_RUN_TOKEN,
  });
  const before = dedup.getDb().prepare("SELECT * FROM model_protected_secrets").all();
  vi.stubEnv("RUNNER_TOKEN_SECRET", "rotated");
  seed.seedSettingsFromEnv({ ...env, KG_STARDOG_DB: "changed", KG_STARDOG_RUN_TOKEN: "replacement" });
  expect(kg.getStardogValues().db).toBe("graph");
  expect(dedup.getDb().prepare("SELECT * FROM model_protected_secrets").all()).toEqual(before);
  expect(dedup.getDb().prepare("SELECT 1 FROM settings WHERE key = 'kg_stardog_dataset'").get()).toBeUndefined();
});

const STARDOG_SEED_ENV = {
  KG_BACKEND: "stardog_run",
  KG_STARDOG_DB: "graph",
  KG_STARDOG_RUN_ENDPOINT: "https://query.example/",
  KG_STARDOG_RUN_CONSOLE: "https://console.example/",
  KG_NAMESPACE: "https://kg.example/",
  KG_STARDOG_RUN_TOKEN: "seed-token",
} as const;

it.each([
  ["KG_STARDOG_DB", { db: "" }, "db"],
  ["KG_STARDOG_RUN_ENDPOINT", { runEndpoint: "" }, "runEndpoint"],
  ["KG_STARDOG_RUN_CONSOLE", { runConsole: "" }, "runConsole"],
  ["KG_NAMESPACE", { namespace: "" }, "namespace"],
] as const)("keeps a cleared %s value cleared after reboot and reseed", async (variable, clear, field) => {
  const f = await fixture();
  f.modules.seed.seedSettingsFromEnv(STARDOG_SEED_ENV);
  expect(f.modules.kg.getStardogValues()[field]).toBe(STARDOG_SEED_ENV[variable]);
  f.modules.kg.setStardogValues(clear);
  expect(f.modules.kg.getStardogValues()[field]).toBe("");
  const restarted = await f.reopen();
  restarted.seed.seedSettingsFromEnv(STARDOG_SEED_ENV);
  expect(restarted.kg.getStardogValues()[field]).toBe("");
});

it("keeps a cleared token cleared after reboot and reseed", async () => {
  const f = await fixture();
  f.modules.seed.seedSettingsFromEnv(STARDOG_SEED_ENV);
  expect(f.modules.kg.getStardogValues().tokenSet).toBe(true);
  f.modules.kg.setStardogValues({ token: "" });
  expect(f.modules.kg.getStardogValues().tokenSet).toBe(false);
  const restarted = await f.reopen();
  restarted.seed.seedSettingsFromEnv(STARDOG_SEED_ENV);
  expect(restarted.kg.getStardogValues().tokenSet).toBe(false);
  expect(restarted.kg.getStardogRunToken()).toBeUndefined();
  expect(restarted.dedup.getDb().prepare("SELECT * FROM model_protected_secrets").all()).toEqual([]);
});

it("keeps a sidecar switch after reboot and reseed with KG_BACKEND=stardog_run", async () => {
  const f = await fixture();
  f.modules.seed.seedSettingsFromEnv(STARDOG_SEED_ENV);
  expect(f.modules.kg.getKgGraphSource()).toBe("stardog_run");
  f.modules.kg.setKgGraphSource("sidecar");
  const restarted = await f.reopen();
  restarted.seed.seedSettingsFromEnv(STARDOG_SEED_ENV);
  expect(restarted.kg.getKgGraphSource()).toBe("sidecar");
});

it("keeps pre-seed saves, clears, and a sidecar choice through reboot and seeds only untouched values", async () => {
  const f = await fixture();
  f.modules.kg.setKgGraphSource("sidecar");
  f.modules.kg.setStardogValues({ db: "saved-db", runConsole: "", token: "saved-token" });
  const restarted = await f.reopen();
  restarted.seed.seedSettingsFromEnv(STARDOG_SEED_ENV);
  expect(restarted.kg.getKgGraphSource()).toBe("sidecar");
  expect(restarted.kg.getStardogValues()).toMatchObject({
    db: "saved-db", runConsole: "", runEndpoint: STARDOG_SEED_ENV.KG_STARDOG_RUN_ENDPOINT,
    namespace: STARDOG_SEED_ENV.KG_NAMESPACE, tokenSet: true,
  });
  expect(restarted.kg.getStardogRunToken()).toBe("saved-token");
});

it("keeps a token cleared before the first seed absent through reboot and seed", async () => {
  const f = await fixture();
  f.modules.kg.setStardogValues({ token: "" });
  expect(f.modules.kg.getStardogValues().tokenSet).toBe(false);
  const restarted = await f.reopen();
  restarted.seed.seedSettingsFromEnv(STARDOG_SEED_ENV);
  expect(restarted.kg.getStardogValues().tokenSet).toBe(false);
  expect(restarted.kg.getStardogRunToken()).toBeUndefined();
  expect(restarted.dedup.getDb().prepare("SELECT * FROM model_protected_secrets").all()).toEqual([]);
});

it("still seeds a value that was never seeded or saved on a later boot", async () => {
  const f = await fixture();
  f.modules.seed.seedSettingsFromEnv({});
  const restarted = await f.reopen();
  restarted.seed.seedSettingsFromEnv({
    KG_STARDOG_DB: "graph",
    KG_STARDOG_RUN_ENDPOINT: "https://query.example/",
    KG_STARDOG_RUN_TOKEN: "seed-token",
  });
  expect(restarted.kg.getStardogValues()).toMatchObject({
    db: "graph", runEndpoint: "https://query.example/", tokenSet: true,
  });
  expect(restarted.kg.getStardogRunToken()).toBe("seed-token");
});

it.each([undefined, "sidecar", "STARDOG_RUN", "stardog_run "])("does not seed source from %s", async (backend) => {
  const { modules: { seed, dedup } } = await fixture();
  seed.seedSettingsFromEnv({ KG_BACKEND: backend });
  expect(dedup.getDb().prepare("SELECT 1 FROM settings WHERE key = 'kg_graph_source'").get()).toBeUndefined();
});

it.each([undefined, ""])("continues seeding without an encryption key (%s) and retries next boot", async (key) => {
  const f = await fixture();
  vi.stubEnv("RUNNER_TOKEN_SECRET", key);
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  try {
    const env = { KG_BACKEND: "stardog_run", KG_STARDOG_DB: "graph", KG_STARDOG_RUN_TOKEN: "SENTINEL-seed-token" };
    expect(() => f.modules.seed.seedSettingsFromEnv(env)).not.toThrow();
    expect(f.modules.kg.getStardogValues()).toMatchObject({ db: "graph", tokenSet: false });
    expect(f.modules.dedup.getDb().prepare("SELECT * FROM model_protected_secrets").all()).toEqual([]);
    expect(f.modules.dedup.getDb().prepare("SELECT 1 FROM settings WHERE key = ?").get(f.modules.kg.KG_STARDOG_RUN_TOKEN_HANDLED_SETTING_KEY)).toBeUndefined();
    expect(warn).toHaveBeenCalledOnce();
    expect(JSON.stringify(warn.mock.calls)).not.toContain(env.KG_STARDOG_RUN_TOKEN);
    vi.stubEnv("RUNNER_TOKEN_SECRET", "configured-key");
    const restarted = await f.reopen();
    restarted.seed.seedSettingsFromEnv(env);
    expect(restarted.kg.stardogChildEnv().KG_STARDOG_RUN_TOKEN).toBe(env.KG_STARDOG_RUN_TOKEN);
    expect(restarted.dedup.getDb().prepare("SELECT 1 FROM settings WHERE key = ?").get(restarted.kg.KG_STARDOG_RUN_TOKEN_HANDLED_SETTING_KEY)).toBeDefined();
  } finally { warn.mockRestore(); }
});
