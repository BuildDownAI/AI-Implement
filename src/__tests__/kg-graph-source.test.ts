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

it.each([undefined, "sidecar", "STARDOG_RUN", "stardog_run "])("does not seed source from %s", async (backend) => {
  const { modules: { seed, dedup } } = await fixture();
  seed.seedSettingsFromEnv({ KG_BACKEND: backend });
  expect(dedup.getDb().prepare("SELECT 1 FROM settings WHERE key = 'kg_graph_source'").get()).toBeUndefined();
});
