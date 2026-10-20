/** AII-1437: execution-policy contract, credentials namespace, dispatch guard, probe marker, Fly/local rejection. */
import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import {
  EPHEMERAL_FULL_ACCESS_ASSERTION,
  EPHEMERAL_FULL_ACCESS_EXTRA_ENV,
  hasEphemeralFullAccessOptIn,
  parseExecutionPolicy,
} from "../model-auth-contract.js";
import {
  decodeRunConfig,
  decodeTrustedRunConfig,
  diagnosticProjection,
  encodeRunConfig,
  encodeTrustedRunConfig,
  validateRunCredentials,
  type RunConfigV1,
} from "../run-config.js";
import { assertExecutionPolicyCapability, buildEnvelopeDispatchInputs } from "../github.js";
import { __clearWorkflowProbeCacheForTests, resolveWorkflowCapabilities } from "../workflow-probe.js";
import { buildSessionMachineConfig } from "../fly-machines.js";
import { buildLocalRunnerEnv } from "../local-docker.js";

const context = { version: 1, dispatchId: "d1", projectKey: "p", backend: "gha", modelAuthUrl: "https://orch.example.com" };
const policy = { version: 1, implementationSandbox: "ephemeral-full-access", dispatchId: "d1", projectKey: "p", backend: "gha", ephemeralRunnerAsserted: true };
const base = { v: 1, issue: { id: "i", identifier: "A-1", title: "t", description: "d" } } as never as RunConfigV1;
const withPolicy = { ...base, credentials: { version: 1, modelAuthContext: context, executionPolicy: policy } } as never as RunConfigV1;

describe("parseExecutionPolicy", () => {
  it("accepts the exact versioned shape", () => {
    expect(parseExecutionPolicy(policy)).toEqual({ ok: true, value: policy });
  });
  it.each([
    ["missing", undefined],
    ["boolean", true],
    ["unknown field", { ...policy, extra: 1 }],
    ["wrong version", { ...policy, version: 2 }],
    ["other sandbox", { ...policy, implementationSandbox: "danger-full-access" }],
    ["non-gha backend", { ...policy, backend: "fly" }],
    ["false assertion", { ...policy, ephemeralRunnerAsserted: false }],
    ["string assertion", { ...policy, ephemeralRunnerAsserted: "true" }],
    ["empty dispatch", { ...policy, dispatchId: "" }],
    ["empty project", { ...policy, projectKey: "" }],
  ])("rejects %s", (_n, raw) => {
    expect(parseExecutionPolicy(raw).ok).toBe(false);
  });
});

describe("hasEphemeralFullAccessOptIn", () => {
  it("is true only for the exact name and value", () => {
    expect(hasEphemeralFullAccessOptIn({ [EPHEMERAL_FULL_ACCESS_EXTRA_ENV]: EPHEMERAL_FULL_ACCESS_ASSERTION })).toBe(true);
    for (const env of [undefined, null, {}, { [EPHEMERAL_FULL_ACCESS_EXTRA_ENV]: "true" }, { [EPHEMERAL_FULL_ACCESS_EXTRA_ENV]: "" },
      { [EPHEMERAL_FULL_ACCESS_EXTRA_ENV.toLowerCase()]: EPHEMERAL_FULL_ACCESS_ASSERTION }]) {
      expect(hasEphemeralFullAccessOptIn(env)).toBe(false);
    }
  });
});

describe("credentials namespace", () => {
  it("round-trips through the trusted codec only", () => {
    expect(decodeTrustedRunConfig(encodeTrustedRunConfig(withPolicy)).credentials?.executionPolicy).toEqual(policy);
  });

  it("generic encode, decode and diagnostics neither emit nor accept it as authority", () => {
    const generic = encodeRunConfig(withPolicy);
    expect(Buffer.from(generic, "base64").toString()).not.toContain("ephemeral-full-access");
    expect(JSON.stringify(decodeRunConfig(encodeTrustedRunConfig(withPolicy)))).not.toContain("ephemeral-full-access");
    expect(JSON.stringify(decodeRunConfig(generic))).not.toContain("executionPolicy");
    expect(JSON.stringify(diagnosticProjection(withPolicy))).not.toContain("ephemeral-full-access");
    // A policy smuggled into a top-level generic field is dropped by the known-key allowlist.
    const smuggled = Buffer.from(JSON.stringify({ ...base, executionPolicy: policy, implementationSandbox: "ephemeral-full-access" })).toString("base64");
    expect(decodeRunConfig(smuggled)).not.toHaveProperty("executionPolicy");
    expect(decodeTrustedRunConfig(smuggled).credentials).toBeUndefined();
  });

  it.each([
    ["without a launch context", { executionPolicy: policy }],
    ["with a mismatched dispatch", { modelAuthContext: context, executionPolicy: { ...policy, dispatchId: "other" } }],
    ["with a mismatched project", { modelAuthContext: context, executionPolicy: { ...policy, projectKey: "other" } }],
    ["with a false assertion", { modelAuthContext: context, executionPolicy: { ...policy, ephemeralRunnerAsserted: false } }],
    ["with an unknown field", { modelAuthContext: context, executionPolicy: { ...policy, extra: 1 } }],
  ])("rejects a policy %s", (_n, creds) => {
    expect(() => validateRunCredentials({ version: 1, ...creds })).toThrow("executionPolicy");
  });
});

describe("dispatch writers", () => {
  const mapping = { owner: "o", repo: "r", workflowFile: "w.yml", defaultBranch: "main", provider: "anthropic", maxTurns: null, maxIterations: null, maxJobMinutes: null, branchPrefix: null, skillsRepo: null } as never;
  const issue = { id: "i", identifier: "A-1", title: "t", description: "d" };
  const opts = { runnerPhase: "implementation" as const, retryPolicy: null, privateTransport: true, runToken: "rt", runProgressToken: "pt" };

  it("buildEnvelopeDispatchInputs carries the policy only inside the trusted credentials", () => {
    const inputs = buildEnvelopeDispatchInputs(mapping, issue, { ...opts, credentials: withPolicy.credentials });
    expect(decodeTrustedRunConfig(inputs.run_config as string).credentials?.executionPolicy).toEqual(policy);
    expect(decodeRunConfig(inputs.run_config as string)).not.toHaveProperty("credentials");
    expect(JSON.stringify({ ...inputs, run_config: "" })).not.toContain("ephemeral-full-access");
  });

  it("refuses to downgrade the policy to a public transport", () => {
    expect(() => buildEnvelopeDispatchInputs(mapping, issue, { ...opts, privateTransport: false, credentials: withPolicy.credentials })).toThrow(/protected run transport/);
  });

  it("assertExecutionPolicyCapability refuses a workflow without the capability marker", () => {
    expect(() => assertExecutionPolicyCapability(withPolicy.credentials, { supportsExecutionPolicy: false }, "o/r/w.yml@main")).toThrow(/github-hosted-execution-policy-v2/);
    expect(() => assertExecutionPolicyCapability(withPolicy.credentials, {}, "o/r/w.yml@main")).toThrow();
    expect(() => assertExecutionPolicyCapability(withPolicy.credentials, { supportsExecutionPolicy: true }, "o/r/w.yml@main")).not.toThrow();
    // Dispatches that carry no policy are unaffected by an old workflow.
    expect(() => assertExecutionPolicyCapability({ version: 1 }, {}, "o/r/w.yml@main")).not.toThrow();
    expect(() => assertExecutionPolicyCapability(undefined, {}, "o/r/w.yml@main")).not.toThrow();
  });
});

describe("workflow probe: supportsExecutionPolicy", () => {
  const MARKER = "# ai-implement-capability: github-hosted-execution-policy-v2\n";
  const ENVELOPE = "on:\n  workflow_dispatch:\n    inputs:\n      run_config:\n        required: true\n";
  const probe = (yaml: string) => {
    __clearWorkflowProbeCacheForTests();
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ type: "file", encoding: "base64", content: Buffer.from(yaml).toString("base64") }), { status: 200 }));
    return resolveWorkflowCapabilities({ owner: "o", repo: "r", workflowFile: "w.yml", token: "t", ref: "main", fetchImpl: fetchImpl as unknown as typeof fetch });
  };
  it("is true only for an envelope workflow carrying the marker", async () => {
    expect((await probe(MARKER + ENVELOPE)).supportsExecutionPolicy).toBe(true);
    expect((await probe(ENVELOPE)).supportsExecutionPolicy).toBe(false);
    expect((await probe("# ai-implement-capability: ephemeral-execution-policy-v1\n" + ENVELOPE)).supportsExecutionPolicy).toBe(false);
    expect((await probe(MARKER + "on: workflow_dispatch\n")).supportsExecutionPolicy).toBe(false);
  });
  it("is not implied by the private-run-config marker", async () => {
    expect((await probe("# ai-implement-capability: private-run-config-v1\n" + ENVELOPE)).supportsExecutionPolicy).toBe(false);
  });
});

describe("Fly and local never accept the opt-in or the launch variable", () => {
  const fly = {
    image: "img", issueId: "i", issueIdentifier: "ENG-1", issueTitle: "t", issueDescription: "d", owner: "o", repo: "r",
    defaultBranch: "main", githubToken: "gt", sessionToken: "st", machineNonce: "n",
  };
  const local = { ...fly, image: "local", orchestratorUrl: "http://host" };
  const names = [EPHEMERAL_FULL_ACCESS_EXTRA_ENV, "AI_IMPLEMENT_EXECUTION_POLICY", "ai_implement_execution_policy"];
  it.each(names)("buildSessionMachineConfig rejects %s", (name) => {
    expect(() => buildSessionMachineConfig({ ...fly, extraEnv: { [name]: EPHEMERAL_FULL_ACCESS_ASSERTION } })).toThrow(/not supported on Fly/);
  });
  it.each(names)("buildLocalRunnerEnv rejects %s", (name) => {
    expect(() => buildLocalRunnerEnv({ ...local, extraEnv: { [name]: EPHEMERAL_FULL_ACCESS_ASSERTION } } as never)).toThrow(/not supported in local Docker/);
  });
  it("an ordinary extraEnv is untouched", () => {
    expect(buildSessionMachineConfig({ ...fly, extraEnv: { FOO: "bar" } }).config.env).toMatchObject({ FOO: "bar" });
  });
});

describe("every GHA dispatch writer agrees on the policy", () => {
  const read = (f: string) => readFileSync(f, "utf-8");
  const writers = ["src/index.ts", "src/comment-gapfill-drain.ts", "src/planning-launch.ts"];

  it("implementation-phase writers mark their phase and guard the workflow capability", () => {
    for (const f of ["src/index.ts", "src/comment-gapfill-drain.ts"]) {
      const text = read(f);
      expect(text, f).toMatch(/ghaManagedCredentials\([^)]*\{ extraEnv: mapping\.extraEnv \}\)/);
      expect(text, f).toContain("assertExecutionPolicyCapability(");
    }
  });

  it("the planning writer omits the implementation marker, so planning cannot carry the policy", () => {
    const text = read("src/planning-launch.ts");
    expect(text).toMatch(/ghaManagedCredentials\(managedDecision, config\.runnerCallbackBaseUrl\)/);
  });

  it("no other module calls ghaManagedCredentials", () => {
    const hits = readdirSync("src").filter((f) => f.endsWith(".ts") && read(`src/${f}`).includes("ghaManagedCredentials(") && f !== "managed-dispatch-auth.ts");
    expect(hits.map((f) => `src/${f}`).sort()).toEqual([...writers].sort());
  });
});
