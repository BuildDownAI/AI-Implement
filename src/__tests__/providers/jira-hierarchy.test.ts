import { describe, it, expect } from "vitest";
import { classifyByChildren, ancestorChain } from "../../providers/jira-hierarchy.js";

describe("classifyByChildren", () => {
  it("no children → leaf", () => {
    expect(classifyByChildren([]).kind).toBe("leaf");
  });
  it("children but none designated → waiting-parent (race guard)", () => {
    expect(classifyByChildren([{ designated: false, terminal: false }]).kind).toBe("waiting-parent");
  });
  it("≥1 designated child not all terminal → feature-node-blocked", () => {
    expect(
      classifyByChildren([
        { designated: true, terminal: true },
        { designated: true, terminal: false },
      ]).kind,
    ).toBe("feature-node-blocked");
  });
  it("all designated children terminal and no active undesignated children → feature-node-ready", () => {
    expect(
      classifyByChildren([
        { designated: true, terminal: true },
        { designated: false, terminal: true }, // non-designated but terminal — doesn't gate
      ]).kind,
    ).toBe("feature-node-ready");
  });
  it("AII-349 race guard: designated+terminal children exist but undesignated non-terminal child → waiting-parent", () => {
    // Operator labeled the parent first; some children are Done (by hand) but siblings are
    // not yet labeled. Wait until they are designated or terminal before finalizing/dispatching.
    expect(
      classifyByChildren([
        { designated: true, terminal: true },
        { designated: false, terminal: false }, // not yet labeled, still active
      ]).kind,
    ).toBe("waiting-parent");
  });
  it("AII-349 race guard: all-designated-terminal + multiple undesignated non-terminal → waiting-parent", () => {
    expect(
      classifyByChildren([
        { designated: true, terminal: true },
        { designated: true, terminal: true },
        { designated: false, terminal: false },
        { designated: false, terminal: false },
      ]).kind,
    ).toBe("waiting-parent");
  });
});

describe("ancestorChain", () => {
  const parentOf = (k: string) => ({ "A-3": "A-2", "A-2": "A-1", "A-1": null } as Record<string, string | null>)[k] ?? null;
  it("returns designated ancestors base-most first, stopping at the first undesignated", () => {
    const isDesignated = (k: string) => k === "A-1" || k === "A-2"; // only A-1, A-2 designated
    expect(ancestorChain("A-2", parentOf, isDesignated)).toEqual(["A-1", "A-2"]);
  });
  it("stops at an undesignated parent (PRs to base)", () => {
    expect(ancestorChain("A-2", parentOf, () => false)).toEqual([]);
  });
  it("null immediate parent → empty chain", () => {
    expect(ancestorChain(null, parentOf, () => true)).toEqual([]);
  });
  it("truncates a chain deeper than the cap (base-most first), default cap = 5", () => {
    const links: Record<string, string | null> = {
      "A-6": "A-5", "A-5": "A-4", "A-4": "A-3", "A-3": "A-2", "A-2": "A-1", "A-1": null,
    };
    const chain = ancestorChain("A-6", (k) => links[k] ?? null, () => true);
    expect(chain).toHaveLength(5);
    expect(chain).toEqual(["A-2", "A-3", "A-4", "A-5", "A-6"]); // base-most first; A-1 dropped by cap
  });

  it("does not emit duplicate keys when the parent graph contains a cycle", () => {
    const links: Record<string, string | null> = { "A-2": "A-1", "A-1": "A-2" };
    const chain = ancestorChain("A-2", (k) => links[k] ?? null, () => true);
    expect(new Set(chain).size).toBe(chain.length);
    expect(chain).toEqual(["A-1", "A-2"]);
  });
});
