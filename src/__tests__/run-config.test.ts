import { describe, expect, it } from "vitest";
import {
  encodeRunConfig,
  decodeRunConfig,
  runConfigFromTaskDocument,
  type RunConfigV1,
  type TaskDocumentParams,
} from "../run-config.js";

const full: RunConfigV1 = {
  v: 1,
  issue: { id: "uuid-1", identifier: "AII-1", title: "T", description: "multi\nline ünicode" },
  prNumber: "42",
  baseBranch: "main",
  runnerPhase: "implementation",
  branchPrefix: "pr",
  skillsRepo: "org/skills",
  runnerCallbackUrl: "https://orch.example/runner",
  maxTurns: 50,
  maxIterations: 3,
  commentInstruction: "do the thing",
  sensitiveFiles: { add: ["*.secrets.toml"], allow: [".env", ".env.*"] },
  profiles: ["backend", "webapp"],
  planningContext: { parent: "- AII-0: parent", siblings: "None", dependencies: "- [related] AII-2: dep" },
  dependencyTokenScope: "installation",
};

describe("run-config envelope", () => {
  it("round-trips a full config", () => {
    expect(decodeRunConfig(encodeRunConfig(full))).toEqual(full);
  });
  it("round-trips a minimal config", () => {
    const min: RunConfigV1 = { v: 1, issue: { id: "i", identifier: "AII-2", title: "t", description: "" } };
    expect(decodeRunConfig(encodeRunConfig(min))).toEqual(min);
  });
  it("ignores unknown keys (forward compat)", () => {
    const withExtra = { ...full, futureField: { nested: true } };
    const b64 = Buffer.from(JSON.stringify(withExtra), "utf-8").toString("base64");
    expect(decodeRunConfig(b64).issue.identifier).toBe("AII-1");
  });
  it("throws on unsupported version", () => {
    const b64 = Buffer.from(JSON.stringify({ ...full, v: 2 }), "utf-8").toString("base64");
    expect(() => decodeRunConfig(b64)).toThrow(/unsupported run_config version/i);
  });
  it("throws on malformed base64/JSON and on missing issue block", () => {
    expect(() => decodeRunConfig("not-base64!!!")).toThrow();
    const noIssue = Buffer.from(JSON.stringify({ v: 1 }), "utf-8").toString("base64");
    expect(() => decodeRunConfig(noIssue)).toThrow(/issue/i);
  });
  it("truncates oversized descriptions with a marker", () => {
    const big = { ...full, issue: { ...full.issue, description: "x".repeat(60_000) } };
    const decoded = decodeRunConfig(encodeRunConfig(big));
    expect(decoded.issue.description.length).toBeLessThanOrEqual(40_000 + 100);
    expect(decoded.issue.description).toContain("[truncated by ai-implement");
  });

  it("round-trips profiles", () => {
    const cfg: RunConfigV1 = {
      v: 1,
      issue: { id: "i", identifier: "AII-2", title: "t", description: "" },
      profiles: ["backend", "webapp"],
    };
    expect(decodeRunConfig(encodeRunConfig(cfg)).profiles).toEqual(["backend", "webapp"]);
  });

  it("round-trips planningContext", () => {
    const cfg: RunConfigV1 = {
      v: 1,
      issue: { id: "i", identifier: "AII-2", title: "t", description: "" },
      planningContext: { parent: "- AII-1: parent", siblings: "None", dependencies: "None" },
    };
    expect(decodeRunConfig(encodeRunConfig(cfg)).planningContext).toEqual({
      parent: "- AII-1: parent",
      siblings: "None",
      dependencies: "None",
    });
  });

  it("pickKnownKeys preserves profiles and planningContext", () => {
    const withExtra = {
      ...full,
      futureField: "ignored",
    };
    const b64 = Buffer.from(JSON.stringify(withExtra), "utf-8").toString("base64");
    const decoded = decodeRunConfig(b64);
    expect(decoded.profiles).toEqual(["backend", "webapp"]);
    expect(decoded.planningContext).toEqual({ parent: "- AII-0: parent", siblings: "None", dependencies: "- [related] AII-2: dep" });
    expect((decoded as Record<string, unknown>).futureField).toBeUndefined();
  });

  it("handles empty profiles array and absent planningContext", () => {
    const cfg: RunConfigV1 = {
      v: 1,
      issue: { id: "i", identifier: "AII-2", title: "t", description: "" },
      profiles: [],
    };
    const decoded = decodeRunConfig(encodeRunConfig(cfg));
    expect(decoded.profiles).toEqual([]);
    expect(decoded.planningContext).toBeUndefined();
  });

  it("absent profiles and planningContext decode as undefined", () => {
    const min: RunConfigV1 = { v: 1, issue: { id: "i", identifier: "AII-2", title: "t", description: "" } };
    const decoded = decodeRunConfig(encodeRunConfig(min));
    expect(decoded.profiles).toBeUndefined();
    expect(decoded.planningContext).toBeUndefined();
  });

  it("round-trips dependencyTokenScope: installation", () => {
    const cfg: RunConfigV1 = {
      v: 1,
      issue: { id: "i", identifier: "AII-3", title: "t", description: "" },
      dependencyTokenScope: "installation",
    };
    expect(decodeRunConfig(encodeRunConfig(cfg)).dependencyTokenScope).toBe("installation");
  });

  it("absent dependencyTokenScope decodes as undefined (no key materialized)", () => {
    const min: RunConfigV1 = { v: 1, issue: { id: "i", identifier: "AII-4", title: "t", description: "" } };
    const decoded = decodeRunConfig(encodeRunConfig(min));
    expect(decoded.dependencyTokenScope).toBeUndefined();
    expect("dependencyTokenScope" in decoded).toBe(false);
  });

  it("pickKnownKeys preserves dependencyTokenScope and drops bogus extra keys", () => {
    const withExtra = { ...full, bogusKey: "dropped" };
    const b64 = Buffer.from(JSON.stringify(withExtra), "utf-8").toString("base64");
    const decoded = decodeRunConfig(b64);
    expect(decoded.dependencyTokenScope).toBe("installation");
    expect((decoded as Record<string, unknown>).bogusKey).toBeUndefined();
  });
});

describe("runConfigFromTaskDocument", () => {
  const ISSUE_ID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

  it("builds a minimal RunConfigV1 from title and description", () => {
    const params: TaskDocumentParams = { title: "My Task", description: "Do the thing." };
    const result = runConfigFromTaskDocument(params, ISSUE_ID);
    expect(result.v).toBe(1);
    expect(result.issue.id).toBe(ISSUE_ID);
    expect(result.issue.title).toBe("My Task");
    expect(result.issue.description).toBe("Do the thing.");
  });

  it("uses the provided identifier", () => {
    const params: TaskDocumentParams = { title: "T", description: "", identifier: "DEV-42" };
    const result = runConfigFromTaskDocument(params, ISSUE_ID);
    expect(result.issue.identifier).toBe("DEV-42");
  });

  it("falls back to a DEV-timestamp identifier when none is provided", () => {
    const params: TaskDocumentParams = { title: "T", description: "" };
    const result = runConfigFromTaskDocument(params, ISSUE_ID);
    expect(result.issue.identifier).toMatch(/^DEV-\d+$/);
  });

  it("maps baseBranch to config.baseBranch", () => {
    const params: TaskDocumentParams = { title: "T", description: "", baseBranch: "main" };
    const result = runConfigFromTaskDocument(params, ISSUE_ID);
    expect(result.baseBranch).toBe("main");
  });

  it("maps profiles to config.profiles", () => {
    const params: TaskDocumentParams = {
      title: "T",
      description: "",
      profiles: ["backend", "webapp"],
    };
    const result = runConfigFromTaskDocument(params, ISSUE_ID);
    expect(result.profiles).toEqual(["backend", "webapp"]);
  });

  it("maps maxTurns to config.maxTurns", () => {
    const params: TaskDocumentParams = { title: "T", description: "", maxTurns: 50 };
    const result = runConfigFromTaskDocument(params, ISSUE_ID);
    expect(result.maxTurns).toBe(50);
  });

  it("maps maxIterations to config.maxIterations", () => {
    const params: TaskDocumentParams = { title: "T", description: "", maxIterations: 3 };
    const result = runConfigFromTaskDocument(params, ISSUE_ID);
    expect(result.maxIterations).toBe(3);
  });

  it("omits optional keys when absent (no spurious undefined properties)", () => {
    const params: TaskDocumentParams = { title: "T", description: "" };
    const result = runConfigFromTaskDocument(params, ISSUE_ID);
    expect("baseBranch" in result).toBe(false);
    expect("profiles" in result).toBe(false);
    expect("maxTurns" in result).toBe(false);
    expect("maxIterations" in result).toBe(false);
  });

  it("produces a config that round-trips through encode/decode", () => {
    const params: TaskDocumentParams = {
      title: "T",
      description: "Body.",
      identifier: "DEV-9",
      baseBranch: "main",
      profiles: ["backend"],
      maxTurns: 10,
      maxIterations: 2,
    };
    const config = runConfigFromTaskDocument(params, ISSUE_ID);
    const decoded = decodeRunConfig(encodeRunConfig(config));
    expect(decoded.issue.identifier).toBe("DEV-9");
    expect(decoded.baseBranch).toBe("main");
    expect(decoded.profiles).toEqual(["backend"]);
    expect(decoded.maxTurns).toBe(10);
    expect(decoded.maxIterations).toBe(2);
  });
});
