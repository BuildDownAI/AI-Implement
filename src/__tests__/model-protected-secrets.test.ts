import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import path from "node:path";
import fs from "node:fs";
import crypto from "node:crypto";
import type * as DedupModule from "../dedup.js";
import type * as Mod from "../model-protected-secrets.js";
import { testDb } from "./helpers/test-db.js";

const RTS = "SENTINEL-RUNNER-TOKEN-SECRET-mps";
const ENV = { RUNNER_TOKEN_SECRET: RTS } as NodeJS.ProcessEnv;
const OPENAI = "sk-SENTINEL-OPENAI-KEY-1";
const ANTHROPIC = "sk-ant-SENTINEL-ANTHROPIC-KEY-2";
const BEDROCK = { region: "us-east-1", accessKeyId: "AKIASENTINEL1", secretAccessKey: "SENTINEL-AWS-SECRET-3" };
const REF = "model-account:api";
const OTHER = "model-account:other";

let dedup: typeof DedupModule;
let mod: typeof Mod;
let spies: ReturnType<typeof vi.spyOn>[];
let logged: string[];

function make(env: NodeJS.ProcessEnv = ENV) {
  return mod.createModelProtectedSecrets({ env, db: () => dedup.getDb() });
}
function rows() {
  return dedup.getDb().prepare("SELECT * FROM model_protected_secrets").all() as Array<Record<string, Buffer | string | number>>;
}

beforeEach(async () => {
  ({ dedup, mod } = (await testDb({
    modules: { dedup: () => import("../dedup.js"), mod: () => import("../model-protected-secrets.js") },
  })).modules);
  logged = [];
  spies = (["log", "info", "warn", "error", "debug"] as const).map((m) =>
    vi.spyOn(console, m).mockImplementation((...a: unknown[]) => { logged.push(a.map(String).join(" ")); }),
  );
});

afterEach(() => {
  spies.forEach((s) => s.mockRestore());
});

describe("round trip", () => {
  it("resolves OpenAI and Anthropic keys as strings", () => {
    const s = make();
    expect(s.write(REF, OPENAI)).toEqual({ ok: true });
    expect(s.write(OTHER, ANTHROPIC)).toEqual({ ok: true });
    expect(s.resolve(REF)).toBe(OPENAI);
    expect(s.resolve(OTHER)).toBe(ANTHROPIC);
  });

  it("resolves a Bedrock bundle with and without a session token", () => {
    const s = make();
    s.write(REF, BEDROCK);
    expect(s.resolve(REF)).toEqual(BEDROCK);
    const withToken = { ...BEDROCK, sessionToken: "SENTINEL-SESSION-TOKEN-4" };
    s.write(OTHER, withToken);
    expect(s.resolve(OTHER)).toEqual(withToken);
  });

  it("replaces the row on rewrite with a fresh nonce", () => {
    const s = make();
    s.write(REF, OPENAI);
    const first = rows()[0]!;
    s.write(REF, ANTHROPIC);
    expect(rows()).toHaveLength(1);
    expect((rows()[0]!.nonce as Buffer).equals(first.nonce as Buffer)).toBe(false);
    expect(s.resolve(REF)).toBe(ANTHROPIC);
  });

  it("keeps plaintext out of the raw row", () => {
    const s = make();
    s.write(REF, OPENAI);
    s.write(OTHER, { ...BEDROCK, sessionToken: "SENTINEL-SESSION-TOKEN-4" });
    for (const r of rows()) {
      for (const enc of ["utf8", "hex", "base64"] as const) {
        const blob = [r.ciphertext, r.nonce, r.auth_tag].map((b) => (b as Buffer).toString(enc)).join("|") + String(r.encryption_key_id);
        for (const needle of [OPENAI, "AKIASENTINEL1", "SENTINEL-AWS-SECRET-3", "SENTINEL-SESSION-TOKEN-4"]) {
          expect(blob).not.toContain(needle);
        }
      }
    }
  });
});

describe("never resolves a value", () => {
  beforeEach(() => { make().write(REF, OPENAI); });

  it("for a row copied to another ref", () => {
    const r = rows()[0]!;
    dedup.getDb().prepare("INSERT INTO model_protected_secrets VALUES (?,?,?,?,?,?)")
      .run(OTHER, r.ciphertext, r.nonce, r.auth_tag, r.encryption_key_id, 1);
    const s = make();
    expect(s.resolve(OTHER)).toBeNull();
    expect(s.open(OTHER)).toEqual({ ok: false, code: "decrypt_failed" });
  });

  for (const col of ["ciphertext", "nonce", "auth_tag"] as const) {
    it(`for a flipped byte in ${col}`, () => {
      const b = Buffer.from(rows()[0]![col] as Buffer);
      b[0] = b[0]! ^ 1;
      dedup.getDb().prepare(`UPDATE model_protected_secrets SET ${col} = ?`).run(b);
      expect(make().resolve(REF)).toBeNull();
    });
    it(`for a truncated ${col}`, () => {
      const b = (rows()[0]![col] as Buffer).subarray(1);
      dedup.getDb().prepare(`UPDATE model_protected_secrets SET ${col} = ?`).run(b);
      expect(make().resolve(REF)).toBeNull();
    });
  }

  it("for another RUNNER_TOKEN_SECRET", () => {
    expect(make({ RUNNER_TOKEN_SECRET: `${RTS}-2` }).resolve(REF)).toBeNull();
  });

  it("for an unknown key id", () => {
    dedup.getDb().prepare("UPDATE model_protected_secrets SET encryption_key_id = 'x'").run();
    expect(make().resolve(REF)).toBeNull();
  });

  it("for a validly encrypted but malformed payload", () => {
    for (const payload of ["not json", JSON.stringify({ t: "api-key", v: 5 }), JSON.stringify({ t: "bedrock", v: { region: "x" } }), JSON.stringify({ t: "other", v: "a" })]) {
      const key = Buffer.from(crypto.hkdfSync("sha256", RTS, "ai-implement", "ai-implement/model-protected-secret-key/v1", 32));
      const nonce = crypto.randomBytes(12);
      const c = crypto.createCipheriv("aes-256-gcm", key, nonce);
      c.setAAD(Buffer.from(JSON.stringify(["model-protected-secret", 1, REF])));
      const ct = Buffer.concat([c.update(payload, "utf8"), c.final()]);
      dedup.getDb().prepare("UPDATE model_protected_secrets SET ciphertext=?, nonce=?, auth_tag=?").run(ct, nonce, c.getAuthTag());
      const s = make();
      expect(s.resolve(REF)).toBeNull();
      expect(s.open(REF)).toEqual({ ok: false, code: "invalid_value" });
    }
  });
});

describe("unavailable states", () => {
  it("returns null without a secret, a row, or a valid ref, and never reads ambient keys", () => {
    make().write(REF, OPENAI);
    for (const env of [{}, { RUNNER_TOKEN_SECRET: "" }]) {
      expect(make({ ...env, ANTHROPIC_API_KEY: "AMBIENT" } as NodeJS.ProcessEnv).resolve(REF)).toBeNull();
    }
    const s = make({ ...ENV, ANTHROPIC_API_KEY: "AMBIENT", OPENAI_API_KEY: "AMBIENT" });
    expect(s.open("model-account:missing")).toEqual({ ok: false, code: "row_missing" });
    expect(s.resolve("ANTHROPIC_API_KEY")).toBeNull();
    expect(s.resolve("model-account:BAD REF")).toBeNull();
  });

  it("fails a write without a key and writes nothing", () => {
    expect(make({}).write(REF, OPENAI)).toEqual({ ok: false, code: "key_unavailable" });
    expect(rows()).toHaveLength(0);
  });
});

describe("validation before write", () => {
  it("rejects bad inputs and writes nothing", () => {
    const s = make();
    const bad: Array<[string, unknown]> = [
      [REF, ""], [REF, "x".repeat(5000)], [REF, 5], [REF, null],
      [REF, { ...BEDROCK, region: "NOPE" }], [REF, { region: "us-east-1", accessKeyId: "a" }],
      [REF, { ...BEDROCK, extra: "x" }], [REF, { ...BEDROCK, kind: "other" }],
      ["bad-ref", OPENAI], ["model-account:", OPENAI],
    ];
    for (const [ref, v] of bad) expect(s.write(ref, v as never).ok).toBe(false);
    expect(rows()).toHaveLength(0);
  });

  it("deletes idempotently without a key", () => {
    make().write(REF, OPENAI);
    expect(make({}).delete(REF)).toEqual({ ok: true });
    expect(rows()).toHaveLength(0);
    expect(make({}).delete(REF)).toEqual({ ok: true });
    expect(make().delete("nope").ok).toBe(false);
  });
});

describe("no leakage", () => {
  it("never puts secrets in logs, results or errors, even with a broken db", () => {
    const outputs: string[] = [];
    const s = make();
    outputs.push(JSON.stringify(s.write(REF, OPENAI)));
    const broken = mod.createModelProtectedSecrets({ env: ENV, db: () => { throw new Error(`boom ${OPENAI} ${RTS}`); } });
    outputs.push(JSON.stringify(broken.write(REF, OPENAI)), JSON.stringify(broken.open(REF)), JSON.stringify(broken.delete(REF)));
    expect(broken.resolve(REF)).toBeNull();
    outputs.push(JSON.stringify(make({}).open(REF)), JSON.stringify(make({}).write(REF, OPENAI)));
    const all = [...outputs, ...logged].join("\n");
    for (const needle of [OPENAI, RTS]) expect(all).not.toContain(needle);
    expect(logged).toEqual([]);
  });

  it("source reads no ambient credential", () => {
    const src = fs.readFileSync(path.join(__dirname, "../model-protected-secrets.ts"), "utf8");
    expect(src).not.toMatch(/API_KEY/);
    expect(src.match(/process\.env/g)).toHaveLength(1);
  });
});
