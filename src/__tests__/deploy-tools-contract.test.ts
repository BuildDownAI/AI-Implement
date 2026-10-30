// The recorded exchanges of `start_deploy` and `get_deploy_posture` (AII-1612): each docs/contracts/<tool>/<scenario>.json
// holds one `{ request, status, response }` made through the real route. The SelfDeploy object is a typed stand-in
// with pinned ids, commit, image and times, so every recording is the same on each run. The control plane copies the
// files, so a change must be on purpose: regenerate with
// UPDATE_CONTRACT_FIXTURES=1 npx vitest run src/__tests__/deploy-tools-contract.test.ts
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { SelfDeployClient, SelfDeployRecord, SelfDeployStartResult, SelfDeployStatus } from "../restate/self-deploy.js";
import { StartDeployArgsSchema } from "../restate/tools.js";
import { testDb } from "./helpers/test-db.js";
import { recordExchange, checkExchange, type Exchange } from "./contract-recorder.js";

const DIR = new URL("../../docs/contracts/start_deploy/", import.meta.url);
const COMMIT = "0123456789abcdef0123456789abcdef01234567";
const IMAGE = `registry.fly.io/builddown-orchestrator-image:testing-${COMMIT.slice(0, 7)}`;
const T = 1_700_000_000_000;
const DEPLOY_ID = "5d1f1c58-6a52-4d3e-9a0e-0c1b7d8f2e41";
const DEPLOY = { scope: "orchestrator:deploy" };
const ARGS = { branch: "testing", requestedBy: "control-plane" };

const record = (over: Partial<SelfDeployRecord> = {}): SelfDeployRecord => ({
  deployId: DEPLOY_ID, phase: "draining", target: { branch: "testing", commit: COMMIT, image: IMAGE, source: "published" },
  requestedBy: "control-plane", startedAt: T, finishedAt: null, reason: null, ...over,
});

/** A SelfDeploy object that answers `start` and `status` with canned, typed values; `starts` counts the start calls. */
function selfDeploy(start: SelfDeployStartResult, deploy: SelfDeployRecord | null = null) {
  const starts: unknown[] = [];
  const client: Pick<SelfDeployClient, "start" | "status"> = {
    start: async (input) => { starts.push(input); return start; },
    status: async (): Promise<SelfDeployStatus> => ({ deploy, options: { applyFlyToml: false } }),
  };
  return { starts, objectClient: (_definition: unknown, _key: string) => client };
}

const started: SelfDeployStartResult = { deployId: DEPLOY_ID, commit: COMMIT, image: IMAGE, alreadyActive: false };

function textOf(recorded: Exchange): string {
  return recorded.response.body.content[0].text;
}

let setDeployHold: () => void;
beforeEach(async () => {
  ({ modules: { setDeployHold } } = await testDb({ modules: { setDeployHold: async () => (await import("../deploy-hold.js")).setDeployHold } }));
});
afterEach(() => {
  vi.unstubAllEnvs();
});

describe("recorded start_deploy exchanges", () => {
  it("started", async () => {
    const object = selfDeploy(started);
    const recorded = await recordExchange("start_deploy", { args: ARGS }, { ...DEPLOY, objectClient: object.objectClient });
    expect(recorded.request).toEqual({ method: "POST", path: "/api/tools/start_deploy", body: { args: ARGS } });
    expect(recorded.response.status).toBe(200);
    expect(recorded.response.body.isError).toBeFalsy();
    expect(JSON.parse(textOf(recorded))).toEqual(started);
    expect(object.starts).toEqual([ARGS]);
    checkExchange("start_deploy", "started", recorded);
  });

  it("already-active", async () => {
    const active = { ...started, alreadyActive: true };
    // SelfDeploy.start sets the hold, so a retry during a drain goes through the real gate.
    setDeployHold();
    const recorded = await recordExchange("start_deploy", { args: ARGS }, { ...DEPLOY, objectClient: selfDeploy(active, record()).objectClient, realHoldGate: true });
    // A second start while a deploy drains returns the same deployId.
    expect(JSON.parse(textOf(recorded))).toEqual({ ...started, alreadyActive: true });
    checkExchange("start_deploy", "already-active", recorded);
  });

  it("image-not-published", async () => {
    const recorded = await recordExchange("start_deploy", { args: ARGS }, { ...DEPLOY, objectClient: selfDeploy({ reason: "image-not-published" }).objectClient });
    expect(recorded.response.body.isError).toBe(true);
    expect(textOf(recorded)).toBe("image-not-published");
    checkExchange("start_deploy", "image-not-published", recorded);
  });

  it.each(["head-unknown", "not-configured"] as const)("answers the refusal %s as the bare code", async (reason) => {
    const recorded = await recordExchange("start_deploy", { args: ARGS }, { ...DEPLOY, objectClient: selfDeploy({ reason }).objectClient });
    expect(recorded.response.body.isError).toBe(true);
    expect(textOf(recorded)).toBe(reason);
  });

  it("read-scope-refused", async () => {
    const object = selfDeploy(started);
    const recorded = await recordExchange("start_deploy", { args: ARGS }, { objectClient: object.objectClient });
    expect(recorded.response.body.isError).toBe(true);
    expect(textOf(recorded)).toBe("forbidden: start_deploy requires the admin role");
    expect(object.starts).toEqual([]);
    checkExchange("start_deploy", "read-scope-refused", recorded);
  });

  it("invalid-args", async () => {
    const object = selfDeploy(started);
    const recorded = await recordExchange("start_deploy", { args: { branch: "feature", requestedBy: "control-plane" } }, { ...DEPLOY, objectClient: object.objectClient });
    expect(recorded.response.body.isError).toBe(true);
    expect(textOf(recorded)).toContain("400");
    expect(object.starts).toEqual([]);
    checkExchange("start_deploy", "invalid-args", recorded);
  });

  it("rejects an unknown argument like invalid-args", async () => {
    const recorded = await recordExchange("start_deploy", { args: { ...ARGS, extra: 1 } }, { ...DEPLOY, objectClient: selfDeploy(started).objectClient });
    expect(recorded.response.body.isError).toBe(true);
    expect(textOf(recorded)).toContain("400");
  });
});

describe("recorded get_deploy_posture exchanges", () => {
  const posture = async (deploy: SelfDeployRecord | null) => {
    vi.stubEnv("AI_IMPLEMENT_SOURCE_COMMIT", "");
    const recorded = await recordExchange("get_deploy_posture", { args: {} }, { objectClient: selfDeploy(started, deploy).objectClient, realHoldGate: true });
    expect(recorded.response.status).toBe(200);
    expect(recorded.response.body.isError).toBeFalsy();
    const body = JSON.parse(textOf(recorded));
    // Every field that existed before selfDeploy is still served.
    for (const key of ["autoDeploy", "watchedRepo", "watchedRef", "runningCommit", "headCommit", "upToDate", "deploy", "runnerChannel", "mergeCost"]) expect(body).toHaveProperty(key);
    expect(body.deploy).toHaveProperty("held");
    expect(body.deploy).toHaveProperty("lastOutcome");
    return { recorded, body };
  };

  it("draining", async () => {
    // SelfDeploy.start claims the global hold before the record reads draining, so a real draining posture has deploy.held true.
    setDeployHold();
    const { recorded, body } = await posture(record());
    expect(body.selfDeploy).toEqual(record());
    checkExchange("get_deploy_posture", "draining", recorded);
  });

  it("succeeded", async () => {
    const done = record({ phase: "succeeded", finishedAt: T + 600_000 });
    const { recorded, body } = await posture(done);
    expect(body.selfDeploy).toEqual(done);
    checkExchange("get_deploy_posture", "succeeded", recorded);
  });

  it("failed", async () => {
    const failed = record({ phase: "failed", finishedAt: T + 4_500_000, reason: "drain-timeout" });
    const { recorded, body } = await posture(failed);
    expect(body.selfDeploy).toEqual(failed);
    checkExchange("get_deploy_posture", "failed", recorded);
  });

  it("serves selfDeploy: null when no deploy was recorded", async () => {
    expect((await posture(null)).body.selfDeploy).toBeNull();
  });
});

describe("start_deploy args.schema.json", () => {
  const argsSchema = StartDeployArgsSchema;
  const schemaFile = new URL("args.schema.json", DIR);
  const schemaText = `${JSON.stringify(z.toJSONSchema(argsSchema), null, 2)}\n`;
  const hint = "Regenerate with UPDATE_CONTRACT_FIXTURES=1 npx vitest run src/__tests__/deploy-tools-contract.test.ts, and tell the control plane: it copies this file.";

  /** The subset of JSON Schema that args.schema.json uses; no validator library is a dependency. */
  function validate(schema: any, value: unknown): boolean {
    switch (schema.type) {
      case "object": {
        if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
        const v = value as Record<string, unknown>;
        if ((schema.required ?? []).some((k: string) => !(k in v))) return false;
        if (schema.additionalProperties === false && Object.keys(v).some((k) => !(k in (schema.properties ?? {})))) return false;
        return Object.entries(schema.properties ?? {}).every(([k, sub]) => !(k in v) || validate(sub, v[k]));
      }
      case "string":
        return typeof value === "string" && (!schema.enum || schema.enum.includes(value)) && value.length >= (schema.minLength ?? 0) && value.length <= (schema.maxLength ?? Infinity);
      default:
        throw new Error(`args.schema.json uses an unsupported schema: ${JSON.stringify(schema)}`);
    }
  }

  const load = () => JSON.parse(readFileSync(schemaFile, "utf8"));

  it("matches the schema in code", () => {
    if (process.env.UPDATE_CONTRACT_FIXTURES === "1") {
      mkdirSync(DIR, { recursive: true });
      writeFileSync(schemaFile, schemaText);
      return;
    }
    if (!existsSync(schemaFile)) throw new Error(`docs/contracts/start_deploy/args.schema.json is missing. ${hint}`);
    if (readFileSync(schemaFile, "utf8") !== schemaText) throw new Error(`args.schema.json differs from the start_deploy input. ${hint}\nActual:\n${schemaText}`);
  });

  it("rejects what the tool rejects", () => {
    const schema = load();
    expect(validate(schema, { branch: "main", requestedBy: "x" })).toBe(true);
    expect(validate(schema, { branch: "testing", requestedBy: "x".repeat(200) })).toBe(true);
    for (const bad of [
      { branch: "feature", requestedBy: "cp" },
      { branch: "main", requestedBy: "" },
      { branch: "main", requestedBy: "x".repeat(201) },
      { branch: "main" },
      { requestedBy: "cp" },
      { branch: "main", requestedBy: "cp", extra: 1 },
    ]) {
      expect(validate(schema, bad), JSON.stringify(bad)).toBe(false);
      expect(argsSchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
  });

  it("accepts the request.args of every recorded start_deploy exchange except invalid-args", () => {
    const schema = load();
    for (const scenario of ["started", "already-active", "image-not-published", "read-scope-refused", "invalid-args"]) {
      const args = JSON.parse(readFileSync(new URL(`${scenario}.json`, DIR), "utf8")).request.args;
      expect(validate(schema, args), scenario).toBe(scenario !== "invalid-args");
    }
  });
});
