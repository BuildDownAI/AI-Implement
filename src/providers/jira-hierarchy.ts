/**
 * Pure feature-branch hierarchy helpers for the Jira provider. No I/O.
 * Mirrors the leaf / feature-node classification and labeled-ancestor walk
 * that src/providers/linear.ts performs inline, but factored out so the
 * branching decisions can be unit-tested without mocking Jira.
 */

export type ChildState = { designated: boolean; terminal: boolean };

export type Classification = {
  kind: "leaf" | "waiting-parent" | "feature-node-blocked" | "feature-node-ready";
};

/**
 * Classify a candidate by its direct children:
 *   - no children                                   → leaf
 *   - children, none AI-Implement-designated        → waiting-parent (race guard: skip)
 *   - ≥1 designated child, not all terminal         → feature-node-blocked (wait gate: skip)
 *   - ≥1 designated child, all terminal             → feature-node-ready (implement onto own branch)
 * Non-designated children never gate.
 */
export function classifyByChildren(children: ChildState[]): Classification {
  if (children.length === 0) return { kind: "leaf" };
  const designated = children.filter((c) => c.designated);
  if (designated.length === 0) return { kind: "waiting-parent" };
  return designated.every((c) => c.terminal)
    ? { kind: "feature-node-ready" }
    : { kind: "feature-node-blocked" };
}

/**
 * Walk up from `immediateParentKey`, collecting designated ancestor keys while each
 * ancestor is designated, stopping at the first undesignated one. Returns base-most
 * first. Bounded by `cap` levels (matching Linear's depth-5 ancestor query) and a visited-set guard so a corrupted parent cycle terminates without emitting duplicate keys.
 */
export function ancestorChain(
  immediateParentKey: string | null,
  parentOf: (key: string) => string | null,
  isDesignated: (key: string) => boolean,
  cap = 5,
): string[] {
  const chain: string[] = [];
  const visited = new Set<string>();
  let cur = immediateParentKey;
  let depth = 0;
  while (cur && depth < cap && isDesignated(cur) && !visited.has(cur)) {
    visited.add(cur);
    chain.push(cur);
    cur = parentOf(cur);
    depth++;
  }
  return chain.reverse();
}
