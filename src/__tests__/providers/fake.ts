import type {
  AIImplementSnapshot,
  IssueLifecycleState,
  TicketIssue,
  TicketingProvider,
} from "../../providers/types.js";

interface FakeIssueState {
  issue: TicketIssue;
  phase: "needs_planning" | "planning" | "plan_complete" | "implementing" | "pr_ready" | "cleared";
  lifecycle: IssueLifecycleState;
}

export interface FakeProviderOptions {
  /** Pre-populate the fake with these issues, keyed by id. */
  initialIssues?: TicketIssue[];
  /** If set, a simulated network call delay (ms) for every method. Default 0. */
  latencyMs?: number;
  /** If true, lifecycle verb invocations are recorded for assertions. */
  recordCalls?: boolean;
}

export interface RecordedCall {
  method: string;
  args: unknown[];
  at: number;
}

export class FakeProvider implements TicketingProvider {
  readonly id = "fake";
  private issues = new Map<string, FakeIssueState>();
  private comments = new Map<string, string[]>();
  private calls: RecordedCall[] = [];
  private opts: FakeProviderOptions;

  constructor(opts: FakeProviderOptions = {}) {
    this.opts = opts;
    for (const issue of opts.initialIssues ?? []) {
      this.issues.set(issue.id, { issue, phase: "needs_planning", lifecycle: "active" });
      this.comments.set(issue.id, []);
    }
  }

  // ---- inspection helpers (test-only) ----
  getPhase(issueId: string): FakeIssueState["phase"] | undefined {
    return this.issues.get(issueId)?.phase;
  }
  commentsFor(issueId: string): string[] {
    return this.comments.get(issueId) ?? [];
  }
  setLifecycle(issueId: string, state: IssueLifecycleState): void {
    const entry = this.issues.get(issueId);
    if (entry) entry.lifecycle = state;
  }
  recordedCalls(): RecordedCall[] {
    return [...this.calls];
  }
  reset(): void {
    this.issues.clear();
    this.comments.clear();
    this.calls = [];
  }

  // ---- TicketingProvider ----
  async fetchAIImplementSnapshot(): Promise<AIImplementSnapshot> {
    await this.tick("fetchAIImplementSnapshot", []);
    const needsPlanning: TicketIssue[] = [];
    const readyForImplementation: TicketIssue[] = [];
    const inProgressCountsByScope: Record<string, number> = {};
    for (const { issue, phase } of this.issues.values()) {
      if (phase === "needs_planning") needsPlanning.push(issue);
      else if (phase === "plan_complete") readyForImplementation.push(issue);
      if (phase === "planning" || phase === "implementing") {
        inProgressCountsByScope[issue.scopeKey] = (inProgressCountsByScope[issue.scopeKey] ?? 0) + 1;
      }
    }
    return { needsPlanning, readyForImplementation, inProgressCountsByScope };
  }

  async fetchLifecycleStates(issueIds: string[]): Promise<Map<string, IssueLifecycleState>> {
    await this.tick("fetchLifecycleStates", [issueIds]);
    const result = new Map<string, IssueLifecycleState>();
    for (const id of issueIds) {
      const entry = this.issues.get(id);
      if (entry) result.set(id, entry.lifecycle);
    }
    return result;
  }

  async markPlanningStarted(issueId: string, scopeKey: string): Promise<void> {
    await this.tick("markPlanningStarted", [issueId, scopeKey]);
    this.transition(issueId, "planning");
  }
  async markPlanComplete(issueId: string): Promise<void> {
    await this.tick("markPlanComplete", [issueId]);
    this.transition(issueId, "plan_complete");
  }
  async markPlanningFailed(issueId: string, reason: string): Promise<void> {
    await this.tick("markPlanningFailed", [issueId, reason]);
    this.transition(issueId, "needs_planning");
    this.appendComment(issueId, `Planning failed: ${reason}`);
  }
  async markImplementing(issueId: string, scopeKey: string): Promise<void> {
    await this.tick("markImplementing", [issueId, scopeKey]);
    this.transition(issueId, "implementing");
  }
  async markPrReady(issueId: string, prUrl: string): Promise<void> {
    await this.tick("markPrReady", [issueId, prUrl]);
    this.transition(issueId, "pr_ready");
    this.appendComment(issueId, `PR ready: ${prUrl}`);
  }
  async markImplementationFailed(issueId: string, reason: string): Promise<void> {
    await this.tick("markImplementationFailed", [issueId, reason]);
    this.transition(issueId, "plan_complete");
    this.appendComment(issueId, `Implementation failed: ${reason}`);
  }
  async clearWorkingState(issueId: string): Promise<void> {
    await this.tick("clearWorkingState", [issueId]);
    this.transition(issueId, "cleared");
  }
  async postComment(issueId: string, body: string): Promise<void> {
    await this.tick("postComment", [issueId, body]);
    this.appendComment(issueId, body);
  }

  // ---- internals ----
  private appendComment(issueId: string, body: string): void {
    const arr = this.comments.get(issueId) ?? [];
    arr.push(body);
    this.comments.set(issueId, arr);
  }
  private transition(issueId: string, phase: FakeIssueState["phase"]): void {
    const entry = this.issues.get(issueId);
    if (!entry) {
      this.issues.set(issueId, {
        issue: {
          id: issueId, identifier: issueId, title: "", description: null,
          scopeKey: "", nativeStatus: "",
        },
        phase, lifecycle: "active",
      });
      this.comments.set(issueId, []);
      return;
    }
    entry.phase = phase;
  }
  private async tick(method: string, args: unknown[]): Promise<void> {
    if (this.opts.recordCalls) this.calls.push({ method, args, at: Date.now() });
    if (this.opts.latencyMs) await new Promise((r) => setTimeout(r, this.opts.latencyMs));
  }
}
