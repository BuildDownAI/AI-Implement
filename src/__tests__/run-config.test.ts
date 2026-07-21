import { describe, expect, it } from "vitest";
import { encodeRunConfig, decodeRunConfig, type RunConfigV1 } from "../run-config.js";

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
});
