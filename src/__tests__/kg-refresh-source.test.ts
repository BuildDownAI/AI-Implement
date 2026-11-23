import { describe, expect, it } from "vitest";
import { resolveKgRefreshSource, type KgBaseSettings } from "../kg-refresh-source.js";
const base = { kgCodeRepo: "acme/code", kgNamespace: "https://kg.example/", kgGraphName: "graph", kgGraphLabel: "Graph", kgStardogDb: "database" };
describe("refresh source", () => {
  it("uses the code repo identity when all base values exist", () => {
    expect(resolveKgRefreshSource(null, base)).toEqual({ mode: "base", runRepo: "acme/code", ...base });
  });
  it("customer configuration takes precedence", () => {
    expect(resolveKgRefreshSource("acme/kg", {})).toEqual({ mode: "customer", runRepo: "acme/kg" });
  });
  it.each(Object.keys(base) as Array<keyof KgBaseSettings>)("names missing %s and KG_SOURCE_REPO", key => {
    const resolved = resolveKgRefreshSource(null, { ...base, [key]: "" });
    expect(resolved.mode).toBe("unavailable");
    if (resolved.mode === "unavailable") {
      expect(resolved.reason).toContain("KG_SOURCE_REPO");
      expect(resolved.reason).toContain(key.replace(/[A-Z]/g, c => `_${c.toLowerCase()}`));
    }
  });
});
