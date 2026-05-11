import { describe, it, expect } from "vitest";
import type { TicketIssue, TicketingProvider } from "../../providers/types.js";

export interface ContractFactoryArgs {
  /** Pre-populate the provider's view of the world with these issues. */
  initialIssues: TicketIssue[];
}

export type ContractProviderFactory = (args: ContractFactoryArgs) => Promise<TicketingProvider>;

const sampleIssue = (overrides: Partial<TicketIssue> = {}): TicketIssue => ({
  id: "issue-1",
  identifier: "TEST-1",
  title: "Sample issue",
  description: "Sample description",
  scopeKey: "TEAM",
  nativeStatus: "Todo (unstarted)",
  ...overrides,
});

/**
 * Run this suite against any TicketingProvider factory to assert that
 * it satisfies the interface contract.
 */
export function runProviderContract(label: string, factory: ContractProviderFactory): void {
  describe(`TicketingProvider contract: ${label}`, () => {
    describe("fetchAIImplementSnapshot", () => {
      it("returns issues bucketed by needsPlanning vs readyForImplementation", async () => {
        const a = sampleIssue({ id: "a", identifier: "TEST-A" });
        const b = sampleIssue({ id: "b", identifier: "TEST-B" });
        const provider = await factory({ initialIssues: [a, b] });
        await provider.markPlanComplete("b");
        const snap = await provider.fetchAIImplementSnapshot();
        expect(snap.needsPlanning.map((i) => i.id)).toEqual(["a"]);
        expect(snap.readyForImplementation.map((i) => i.id)).toEqual(["b"]);
      });

      it("counts in-progress issues by scopeKey", async () => {
        const a = sampleIssue({ id: "a", scopeKey: "TEAM_A" });
        const b = sampleIssue({ id: "b", scopeKey: "TEAM_A" });
        const c = sampleIssue({ id: "c", scopeKey: "TEAM_B" });
        const provider = await factory({ initialIssues: [a, b, c] });
        await provider.markPlanningStarted("a", "TEAM_A");
        await provider.markImplementing("b", "TEAM_A");
        await provider.markImplementing("c", "TEAM_B");
        const snap = await provider.fetchAIImplementSnapshot();
        expect(snap.inProgressCountsByScope).toEqual({ TEAM_A: 2, TEAM_B: 1 });
      });
    });

    describe("fetchLifecycleStates", () => {
      it("returns active for known issues, omits unknown", async () => {
        const a = sampleIssue({ id: "a" });
        const b = sampleIssue({ id: "b" });
        const provider = await factory({ initialIssues: [a, b] });
        const states = await provider.fetchLifecycleStates(["a", "b", "missing"]);
        expect(states.get("a")).toBe("active");
        expect(states.get("b")).toBe("active");
        expect(states.has("missing")).toBe(false);
      });
    });

    describe("lifecycle verbs are state-idempotent", () => {
      it("markPlanningStarted twice does not double-apply state", async () => {
        const a = sampleIssue({ id: "a" });
        const provider = await factory({ initialIssues: [a] });
        await provider.markPlanningStarted("a", "TEAM");
        await provider.markPlanningStarted("a", "TEAM");
        const snap = await provider.fetchAIImplementSnapshot();
        expect(snap.inProgressCountsByScope.TEAM).toBe(1);
      });

      it("markImplementing twice does not double-apply state", async () => {
        const a = sampleIssue({ id: "a" });
        const provider = await factory({ initialIssues: [a] });
        await provider.markImplementing("a", "TEAM");
        await provider.markImplementing("a", "TEAM");
        const snap = await provider.fetchAIImplementSnapshot();
        expect(snap.inProgressCountsByScope.TEAM).toBe(1);
      });
    });

    describe("postComment", () => {
      it("does not throw on a valid call", async () => {
        const a = sampleIssue({ id: "a" });
        const provider = await factory({ initialIssues: [a] });
        await provider.postComment("a", "hello world");
      });
    });

    describe("clearWorkingState", () => {
      it("removes the issue from in-progress count", async () => {
        const a = sampleIssue({ id: "a" });
        const provider = await factory({ initialIssues: [a] });
        await provider.markImplementing("a", "TEAM");
        await provider.clearWorkingState("a");
        const snap = await provider.fetchAIImplementSnapshot();
        expect(snap.inProgressCountsByScope.TEAM ?? 0).toBe(0);
      });
    });

    describe("concurrent lifecycle calls run independently", () => {
      it("two markPlanningStarted calls on the same scopeKey both reflect in the snapshot", async () => {
        const a = sampleIssue({ id: "a" });
        const b = sampleIssue({ id: "b" });
        const provider = await factory({ initialIssues: [a, b] });
        await Promise.all([
          provider.markPlanningStarted("a", "TEAM"),
          provider.markPlanningStarted("b", "TEAM"),
        ]);
        const snap = await provider.fetchAIImplementSnapshot();
        expect(snap.inProgressCountsByScope.TEAM).toBe(2);
      });
    });

    describe("issueUrl", () => {
      it("returns a non-empty string", async () => {
        const a = sampleIssue({ id: "a" });
        const provider = await factory({ initialIssues: [a] });
        const url = provider.issueUrl(a);
        expect(typeof url).toBe("string");
        expect(url.length).toBeGreaterThan(0);
      });
    });

    describe("findByKey", () => {
      it("returns null for an unknown identifier", async () => {
        const provider = await factory({ initialIssues: [] });
        expect(await provider.findByKey("UNKNOWN-99999")).toBeNull();
      });
    });
  });
}
