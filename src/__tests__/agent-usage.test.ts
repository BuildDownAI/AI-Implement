import { describe, it, expect } from "vitest";
import { aggregateUsage, normalizeInvocation, summarizeInvocations } from "../agent-usage.js";
import type { ResolvedAgentSnapshotV1 } from "../run-config.js";
import type { InvocationAttributionV1, RunTelemetry } from "../pipeline/types.js";

const mk = (stage: string, agent: "claude" | "codex", provider: "anthropic" | "openai", authMode: string) => ({
  sel: { agent, provider, model: `m-${stage}`, accountProfileId: `p-${stage}`, invocationTimeoutMs: 60_000 },
  src: { agent: "project", provider: "project", model: "project", accountProfileId: "project", invocationTimeoutMs: "job-deadline" },
  prof: { id: `p-${stage}`, identity: "acct", revision: 2, agent, provider, authMode },
});

function snapshot(): ResolvedAgentSnapshotV1 {
  const p = mk("planning", "claude", "anthropic", "anthropic-api-key");
  const i = mk("implementation", "codex", "openai", "codex-subscription");
  const r = mk("review", "codex", "openai", "openai-api-key");
  return {
    version: 1,
    snapshotId: "snap-1",
    configRevisions: {
      orchestratorDefault: { configRevisionId: "r1", revision: 1 },
      project: { configRevisionId: "r2", revision: 1 },
    },
    stages: { planning: p.sel, implementation: i.sel, review: r.sel },
    sources: { planning: p.src, implementation: i.src, review: r.src },
    profiles: { planning: p.prof, implementation: i.prof, review: r.prof },
  } as unknown as ResolvedAgentSnapshotV1;
}

const snap = snapshot();

function claim(stage: "planning" | "implementation" | "review", over: Partial<InvocationAttributionV1> = {}): InvocationAttributionV1 {
  const s = snap.stages[stage];
  return {
    version: 1,
    invocationId: `inv-${stage}`,
    stage,
    snapshotId: "snap-1",
    agent: s.agent,
    provider: s.provider,
    model: s.model,
    profileId: snap.profiles[stage].id,
    authMode: snap.profiles[stage].authMode,
    limit: null,
    outcome: "success",
    usage: { availability: "complete", tokensIn: 100, tokensOut: 10, costUsd: 0.5, costStatus: "reported" },
    ...over,
  };
}

const tel = (over: Partial<RunTelemetry> = {}): RunTelemetry => ({
  outcome: "success", numTurns: 1, durationMs: 1, costUsd: null, tokensIn: null, tokensOut: null, ...over,
});

describe("normalizeInvocation", () => {
  it("keeps per-row attribution for mixed Claude/Codex and API/subscription", () => {
    const a = normalizeInvocation(snap, { attribution: claim("planning") })!;
    const b = normalizeInvocation(snap, { attribution: claim("implementation", { usage: null }) })!;
    expect([a.agent, a.provider, a.authMode, a.stage, a.profileId]).toEqual(["claude", "anthropic", "anthropic-api-key", "planning", "p-planning"]);
    expect([b.agent, b.provider, b.authMode, b.stage, b.profileId]).toEqual(["codex", "openai", "codex-subscription", "implementation", "p-implementation"]);
    const agg = aggregateUsage([a, b]);
    expect(agg.rows).toHaveLength(2);
    expect(agg.mixedAuth).toBe(true);
  });

  it("snapshot wins over disagreeing claims and flags them", () => {
    const row = normalizeInvocation(snap, {
      attribution: claim("review", { model: "evil", profileId: "repo-profile", agent: "claude", provider: "anthropic", authMode: "claude-subscription" }),
    })!;
    expect(row.model).toBe("m-review");
    expect(row.profileId).toBe("p-review");
    expect(row.authMode).toBe("openai-api-key");
    expect(row.attribution).toBe("mismatch");
    expect(row.mismatches).toEqual(["agent", "provider", "model", "profileId", "authMode"]);
    expect(JSON.stringify(row)).not.toContain("evil");
    expect(JSON.stringify(row)).not.toContain("repo-profile");
  });

  it("rejects a claim from another snapshot but keeps the observed outcome", () => {
    const row = normalizeInvocation(snap, {
      stage: "review",
      attribution: claim("review", { snapshotId: "other" }),
      telemetry: tel({ outcome: "error" }),
    })!;
    expect(row.attribution).toBe("rejected");
    expect(row.outcome).toBe("error");
    expect(row.usage.tokensIn).toBeNull();
    expect(row.model).toBe("m-review");
  });

  it("drops malformed and credential-shaped attribution without throwing or echoing", () => {
    const secret = "sk-abcdefghijklmnop";
    const row = normalizeInvocation(snap, {
      stage: "planning",
      attribution: { ...claim("planning"), model: secret },
      telemetry: tel({ outcome: "max_turns" }),
    })!;
    expect(row.attribution).toBe("rejected");
    expect(row.outcome).toBe("max_turns");
    expect(JSON.stringify(row)).not.toContain(secret);
    expect(normalizeInvocation(snap, { stage: "planning", attribution: 42 })!.attribution).toBe("rejected");
  });

  it("prefers telemetry over claimed usage and flags disagreement", () => {
    const row = normalizeInvocation(snap, {
      attribution: claim("review"),
      telemetry: tel({ tokensIn: 200, tokensOut: 20, costUsd: 1 }),
    })!;
    expect([row.usage.tokensIn, row.usage.tokensOut, row.usage.costUsd]).toEqual([200, 20, 1]);
    expect(row.mismatches).toContain("usage");
    expect(row.attribution).toBe("mismatch");
  });

  it("fills gaps from claimed usage when telemetry is null, without flagging", () => {
    const row = normalizeInvocation(snap, {
      attribution: claim("review"),
      telemetry: tel({ tokensIn: 100 }),
    })!;
    expect([row.usage.tokensIn, row.usage.tokensOut, row.usage.costUsd]).toEqual([100, 10, 0.5]);
    expect(row.mismatches).toEqual([]);
  });

  it("returns null when no stage is determinable", () => {
    expect(normalizeInvocation(snap, { attribution: "junk" })).toBeNull();
  });

  it("flags a timeout limit that disagrees with the snapshot and accepts max_turns", () => {
    const bad = normalizeInvocation(snap, { attribution: claim("review", { limit: { kind: "timeout_ms", value: 5 } }) })!;
    expect(bad.mismatches).toContain("limit");
    const ok = normalizeInvocation(snap, { attribution: claim("review", { limit: { kind: "max_turns", value: 7 } }) })!;
    expect(ok.mismatches).toEqual([]);
    expect(ok.limit).toEqual({ kind: "max_turns", value: 7 });
  });

  it("keeps zero as zero and absent as null, never pricing tokens", () => {
    const zero = normalizeInvocation(snap, {
      stage: "review", telemetry: tel({ tokensIn: 0, tokensOut: 0, costUsd: 0 }),
    })!;
    expect(zero.usage).toMatchObject({ availability: "complete", tokensIn: 0, costUsd: 0, costStatus: "reported" });
    const none = normalizeInvocation(snap, { stage: "review", telemetry: tel() })!;
    expect(none.usage).toMatchObject({ availability: "unavailable", tokensIn: null, tokensOut: null, costUsd: null, costStatus: "unavailable" });
    const tokensOnly = normalizeInvocation(snap, { stage: "review", telemetry: tel({ tokensIn: 1000, tokensOut: 50 }) })!;
    expect(tokensOnly.usage.costUsd).toBeNull();
  });

  it("preserves cache fields without adding them to input", () => {
    const row = normalizeInvocation(snap, {
      stage: "review", telemetry: tel({ tokensIn: 100, tokensOut: 5, cacheReadTokens: 60, cacheCreationTokens: 10 }),
    })!;
    expect(row.usage).toMatchObject({ tokensIn: 100, cacheReadTokens: 60, cacheCreationTokens: 10 });
    const agg = aggregateUsage([row]);
    expect(agg.totals).toMatchObject({ tokensIn: 100, cacheReadTokens: 60, cacheCreationTokens: 10 });
  });

  it("counts repeated model attempts separately from invocations", () => {
    const row = normalizeInvocation(snap, { attribution: claim("review"), attempts: 3 })!;
    const agg = aggregateUsage([row]);
    expect(agg.invocations).toBe(1);
    expect(agg.attempts).toBe(3);
    expect(normalizeInvocation(snap, { stage: "review", attempts: 0 })!.attempts).toBe(1);
  });
});

describe("aggregateUsage", () => {
  it("ignores byte-equivalent duplicate delivery", () => {
    const row = normalizeInvocation(snap, { attribution: claim("planning") })!;
    const agg = aggregateUsage([row, { ...row }]);
    expect(agg.invocations).toBe(1);
    expect(agg.duplicatesIgnored).toBe(1);
    expect(agg.totals.tokensIn).toBe(100);
  });

  it("surfaces a conflicting identity and keeps the first", () => {
    const a = normalizeInvocation(snap, { attribution: claim("planning") })!;
    const b = normalizeInvocation(snap, {
      attribution: claim("planning", { usage: { availability: "complete", tokensIn: 999, tokensOut: 1, costUsd: 9, costStatus: "reported" } }),
    })!;
    const agg = aggregateUsage([a, b]);
    expect(agg.conflicts).toBe(1);
    expect(agg.totals.tokensIn).toBe(100);
  });

  it("counts distinct ids with identical usage separately", () => {
    const a = normalizeInvocation(snap, { attribution: claim("planning") })!;
    const b = normalizeInvocation(snap, { attribution: claim("planning", { invocationId: "inv-other" }) })!;
    expect(aggregateUsage([a, b]).totals.tokensIn).toBe(200);
  });

  it("reports complete, partial, and unavailable cost", () => {
    const priced = normalizeInvocation(snap, { attribution: claim("planning") })!;
    const pricedB = normalizeInvocation(snap, { attribution: claim("review", { invocationId: "x" }) })!;
    const unpriced = normalizeInvocation(snap, { attribution: claim("review", { invocationId: "y", usage: null }) })!;
    const complete = aggregateUsage([priced, pricedB]);
    expect(complete.costStatus).toBe("complete");
    expect(complete.usageStatus).toBe("complete");
    expect(complete.totals.costUsd).toBe(1);
    const partial = aggregateUsage([priced, unpriced]);
    expect(partial.costStatus).toBe("partial");
    expect(partial.usageStatus).toBe("partial");
    expect(partial.totals.costUsd).toBe(0.5);
    const none = aggregateUsage([unpriced]);
    expect(none).toMatchObject({ costStatus: "unavailable", usageStatus: "unavailable" });
    expect(none.totals.costUsd).toBeNull();
    expect(aggregateUsage([]).costStatus).toBe("unavailable");
  });

  it("never reports complete cost for a mixed subscription run", () => {
    const api = normalizeInvocation(snap, { attribution: claim("planning") })!;
    const sub = normalizeInvocation(snap, { attribution: claim("implementation") })!;
    const agg = aggregateUsage([api, sub]);
    expect(agg.mixedAuth).toBe(true);
    expect(agg.costStatus).toBe("partial");
    expect(agg.rows.map((r) => r.authMode)).toEqual(["anthropic-api-key", "codex-subscription"]);
  });

  it("keeps a zero sum distinct from a null sum", () => {
    const zero = normalizeInvocation(snap, { stage: "review", telemetry: tel({ tokensIn: 0, tokensOut: 0 }) })!;
    expect(aggregateUsage([zero]).totals.tokensIn).toBe(0);
    expect(aggregateUsage([zero]).totals.cacheReadTokens).toBeNull();
  });
});

describe("summarizeInvocations", () => {
  it("counts unattributable observations instead of throwing", () => {
    const out = summarizeInvocations(snap, [{ attribution: claim("planning") }, { attribution: null }]);
    expect(out.invocations).toBe(1);
    expect(out.unattributable).toBe(1);
  });
});
