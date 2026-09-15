import { JSDOM } from "jsdom";
import { describe, expect, it, vi } from "vitest";
import { drawerHtml, drawerScript } from "../drawer.js";
import { componentsCss } from "../components.js";

describe("job drawer", () => {
  it("declares the expected drawer ids", () => {
    for (const id of [
      "job-drawer-wrap",
      "drawer-issue-row",
      "drawer-title",
      "drawer-meta",
      "drawer-failure-alert",
      "drawer-elapsed",
      "drawer-timeline",
      "drawer-steps",
      "drawer-context",
      "drawer-logs-link",
      "drawer-step-count",
    ]) {
      expect(drawerHtml).toContain(`id="${id}"`);
    }
  });

  it("exposes openJobDrawer and closeJobDrawer on window", () => {
    expect(drawerScript).toContain("window.openJobDrawer = openJobDrawer");
    expect(drawerScript).toContain("window.closeJobDrawer = closeJobDrawer");
  });

  it("fetches /api/jobs/:id/steps", () => {
    expect(drawerScript).toMatch(/\/api\/jobs\//);
    expect(drawerScript).toContain("/steps");
  });

  it("uses window.api/window.esc only", () => {
    const stripped = drawerScript.replace(/window\.api\(/g, "").replace(/window\.esc\(/g, "");
    expect(stripped).not.toMatch(/\bapi\(/);
    expect(stripped).not.toMatch(/\besc\(/);
  });

  it("uses const/let, not var", () => {
    expect(drawerScript).not.toMatch(/\bvar\s+\w/);
  });

  it("registers an ESC handler to close the drawer", () => {
    expect(drawerScript).toMatch(/keydown/);
    expect(drawerScript).toMatch(/Escape/);
  });

  it("auto-refreshes the open drawer and stops refreshing on close", () => {
    expect(drawerScript).toContain("const DRAWER_REFRESH_MS = 5000");
    expect(drawerScript).toContain("function startDrawerAutoRefresh");
    expect(drawerScript).toContain("setInterval(function ()");
    expect(drawerScript).toContain("refreshJobDrawer(id, { background: true })");
    expect(drawerScript).toContain("function stopDrawerAutoRefresh");
    expect(drawerScript).toContain("clearInterval(drawerRefreshTimer)");
  });

  it("maps local-docker jobs into the implementation/review timeline", () => {
    expect(drawerScript).toContain("mode === 'local-docker'");
    expect(drawerScript).toContain("post-push review running");
  });

  it("shows review_failed jobs as review attention instead of completed", () => {
    expect(drawerScript).toContain("s === 'review_failed'");
    expect(drawerScript).toContain("Review failed");
    expect(drawerScript).toContain("Review incomplete");
    expect(drawerScript).toContain("post-push review needs attention");
  });

  it("renders passed step records as success badges", () => {
    expect(drawerScript).toContain("step.status === 'completed' || step.status === 'passed'");
  });

  it("hides unavailable workflow logs links without leaving an empty href", () => {
    expect(drawerScript).toContain("hasWorkflowLogs");
    expect(drawerScript).toContain("logsLink.removeAttribute('href')");
  });

  it("normalizes logged owner/repo values before building GitHub URLs", () => {
    expect(drawerScript).toContain("function repoPartsForJob");
    expect(drawerScript).toContain("job.repo.includes('/')");
  });

  it("links the issue through the server-resolved issueUrl instead of guessing the tracker host", () => {
    expect(drawerScript).toContain("window.safeUrl(job.issueUrl)");
    expect(drawerScript).not.toContain("linear.app");
    expect(drawerScript).not.toContain("jiraSiteUrl");
  });

  it("has a global hidden rule that wins over button display styles", () => {
    expect(componentsCss).toContain("[hidden] { display: none !important; }");
  });
});

// ---- Failure evidence render tests (BAC-27112) ----

const BASE_JOB = {
  id: 1,
  issueId: "i-1",
  issueIdentifier: "ENG-1",
  issueTitle: "Test issue",
  teamKey: "ENG",
  repo: "org/repo",
  dispatchedAt: Date.now() - 60000,
  dispatchNumber: 1,
  status: "failed",
  conclusion: "exit_1",
  prUrl: null,
  completedAt: Date.now(),
  executionMode: "github-actions",
  machineId: null,
  runnerMode: null,
  runId: 555,
  failure: null,
};

const FAILED_STEP = {
  id: 1,
  jobId: 1,
  stepId: "feedback-loop",
  stepType: "feedback-loop",
  status: "failed",
  startedAt: new Date().toISOString(),
  endedAt: new Date().toISOString(),
  parentStepId: null,
  inputsJson: "{}",
  outputsJson: JSON.stringify({
    error: "boom",
    failure: {
      category: "transient",
      code: "PROVIDER_OVERLOADED",
      stage: "feedback-loop/review-1",
      attempt: 2,
      retryable: true,
      exitCode: 1,
      signal: null,
      message: "overloaded_error",
      evidence: {
        stderrTail: "<script>alert(1)</script>",
        stdoutTail: "plain stdout",
        truncated: true,
      },
    },
  }),
  logsUrl: null,
};

const PASSED_STEP = {
  id: 2,
  jobId: 1,
  stepId: "clone",
  stepType: "clone",
  status: "completed",
  startedAt: new Date().toISOString(),
  endedAt: new Date().toISOString(),
  parentStepId: null,
  inputsJson: "{}",
  outputsJson: "{}",
  logsUrl: null,
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function mountDrawer(job: unknown, steps: unknown[]): { win: any; doc: Document } {
  const dom = new JSDOM(`<!DOCTYPE html><body>${drawerHtml}</body>`, {
    runScripts: "dangerously",
    url: "http://localhost",
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const win = dom.window as any;
  win.api = async (url: string) => {
    if (url === "/api/mappings") return { ok: true, status: 200, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => ({ job, steps }) };
  };
  win.esc = (s: unknown) =>
    String(s == null ? "" : s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
  win.escAttr = (s: unknown) =>
    String(s == null ? "" : s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  win.safeUrl = (s: unknown) => (s == null ? "#" : String(s));
  const script = dom.window.document.createElement("script");
  script.textContent = drawerScript;
  dom.window.document.head.appendChild(script);
  return { win, doc: dom.window.document as Document };
}

describe("job drawer failure evidence", () => {
  it("opens local logs using the selected job and keeps the drawer open under a modal", async () => {
    const { win, doc } = mountDrawer({ ...BASE_JOB, executionMode: "local-docker", machineId: "a".repeat(64), runId: null }, []);
    win.openLocalJobLogs = vi.fn();
    await win.openJobDrawer(1);
    const button = doc.getElementById("drawer-local-logs")!;
    expect(button.hidden).toBe(false);
    button.click();
    expect(win.openLocalJobLogs).toHaveBeenCalledWith(1, "ENG-1");
    expect(doc.getElementById("drawer-logs-link")!.hidden).toBe(true);
    const modal = doc.createElement("dialog");
    modal.setAttribute("open", "");
    doc.body.appendChild(modal);
    doc.dispatchEvent(new win.KeyboardEvent("keydown", { key: "Escape" }));
    expect(doc.getElementById("job-drawer-wrap")!.hidden).toBe(false);
    win.closeJobDrawer();
    win.close();
  });

  it("shows a Failure evidence details block for a failed step with a record, and none for a passed step", async () => {
    const { win, doc } = mountDrawer(BASE_JOB, [FAILED_STEP, PASSED_STEP]);
    await win.openJobDrawer(1);
    const details = doc.querySelectorAll("#drawer-steps details.failure-evidence");
    expect(details.length).toBe(1);
    const summary = details[0].querySelector("summary")!.textContent || "";
    expect(summary).toContain("Failure evidence");
    expect(summary).toContain("transient/PROVIDER_OVERLOADED");
    expect(summary).toContain("attempt 2");
    expect(details[0].textContent).toContain("evidence truncated");
    win.closeJobDrawer();
  });

  it("shows reviewer-turn exhaustion as review incomplete with reviewer cause, limit, and step evidence", async () => {
    const reviewJob = {
      ...BASE_JOB,
      status: "review_failed",
      conclusion: "REVIEWER_TURNS_EXHAUSTED",
      prUrl: "https://github.com/org/repo/pull/42",
      failure: {
        category: "invalid_output",
        code: "REVIEWER_TURNS_EXHAUSTED",
        stage: "post-push-review.1.reviewer.0.trusted.code-review",
        attempt: 1,
        retryable: false,
        reviewMaxTurns: 45,
        message: "code-review ran out of turns",
        evidence: { truncated: true },
      },
    };
    const reviewStep = {
      ...FAILED_STEP,
      stepId: "post-push-review.1.reviewer.0.trusted.code-review",
      stepType: "custom",
      inputsJson: JSON.stringify({ reviewerId: "code-review", gates: true }),
      outputsJson: JSON.stringify({ failure: reviewJob.failure, partial: { summary: "Checked API validation before interruption." } }),
    };
    const { win, doc } = mountDrawer(reviewJob, [reviewStep, PASSED_STEP]);
    await win.openJobDrawer(1);

    expect(doc.getElementById("drawer-issue-row")!.textContent).toContain("review incomplete");
    expect(doc.getElementById("drawer-failure-alert")!.textContent).toContain("Review incomplete");
    expect(doc.getElementById("drawer-failure-alert")!.textContent).toContain("Cause: reviewer turn limit");
    expect(doc.getElementById("drawer-failure-alert")!.textContent).toContain("Limit: 45 turns");
    expect(doc.getElementById("drawer-failure-alert")!.textContent).toContain("code-review");
    expect(doc.getElementById("drawer-failure-alert")!.textContent).toContain("Checked API validation before interruption.");
    expect(doc.getElementById("drawer-timeline")!.textContent).toContain("post-push review incomplete");
    const details = doc.querySelector("#drawer-steps details.failure-evidence")!;
    expect(details.textContent).toContain("Review status: incomplete");
    expect(details.textContent).toContain("limit 45 turns");
    win.closeJobDrawer();
  });

  it("keeps ordinary code rejection labeled review failed", async () => {
    const reviewJob = {
      ...BASE_JOB,
      status: "review_failed",
      conclusion: "REVIEW_UNAPPROVED",
      prUrl: "https://github.com/org/repo/pull/43",
      failure: {
        category: "invalid_output",
        code: "REVIEW_UNAPPROVED",
        stage: "post-push-review",
        attempt: 1,
        retryable: false,
        message: "blocking issue found",
        evidence: { truncated: true },
      },
    };
    const advisoryFailure = {
      ...FAILED_STEP,
      stepId: "post-push-review.1.reviewer.0.branch.preview",
      inputsJson: JSON.stringify({ reviewerId: "preview", gates: false, reviewerProvenance: "branch" }),
      outputsJson: JSON.stringify({ failure: { code: "REVIEWER_TURNS_EXHAUSTED", reviewMaxTurns: 30, stage: "post-push-review" } }),
    };
    const { win, doc } = mountDrawer(reviewJob, [advisoryFailure, PASSED_STEP]);
    await win.openJobDrawer(1);
    expect(doc.getElementById("drawer-issue-row")!.textContent).toContain("review failed");
    expect(doc.getElementById("drawer-issue-row")!.textContent).not.toContain("review incomplete");
    expect(doc.getElementById("drawer-failure-alert")!.textContent).toContain("Review failed");
    win.closeJobDrawer();
  });

  it("omits the code and attempt segments from the summary when they aren't present (BAC-27112 follow-up)", async () => {
    const stepWithoutCodeOrAttempt = {
      ...FAILED_STEP,
      outputsJson: JSON.stringify({
        error: "boom",
        failure: {
          category: "transient",
          message: "overloaded_error",
          evidence: { truncated: false },
        },
      }),
    };
    const { win, doc } = mountDrawer(BASE_JOB, [stepWithoutCodeOrAttempt, PASSED_STEP]);
    await win.openJobDrawer(1);
    const summary = doc.querySelector("#drawer-steps details.failure-evidence summary")!.textContent || "";
    expect(summary).toContain("transient");
    expect(summary).not.toContain("/");
    expect(summary).not.toContain("attempt");
    win.closeJobDrawer();
  });

  it("renders a stderrTail containing <script> as literal text, not markup", async () => {
    const { win, doc } = mountDrawer(BASE_JOB, [FAILED_STEP, PASSED_STEP]);
    await win.openJobDrawer(1);
    const pre = doc.querySelector("#drawer-steps pre");
    expect(pre).toBeTruthy();
    expect(pre!.textContent).toContain("<script>alert(1)</script>");
    expect(pre!.querySelector("script")).toBeNull();
    win.closeJobDrawer();
  });

  it("gives the evidence panel a stable id keyed on the step id", async () => {
    const { win, doc } = mountDrawer(BASE_JOB, [FAILED_STEP, PASSED_STEP]);
    await win.openJobDrawer(1);
    const details = doc.querySelector("#drawer-steps details.failure-evidence");
    expect(details?.id).toBe("failure-evidence-feedback-loop");
    win.closeJobDrawer();
  });

  it("does not render evidence for a step outputs still carry a failure record for, once the step itself is no longer failed", async () => {
    const staleFailureOnPassedStep = { ...FAILED_STEP, status: "completed" };
    const { win, doc } = mountDrawer(BASE_JOB, [staleFailureOnPassedStep, PASSED_STEP]);
    await win.openJobDrawer(1);
    expect(doc.querySelectorAll("#drawer-steps details.failure-evidence").length).toBe(0);
    win.closeJobDrawer();
  });

  it("does not render evidence when failure.category isn't a string", async () => {
    const badFailure = {
      ...FAILED_STEP,
      outputsJson: JSON.stringify({ error: "boom", failure: { code: "X" } }),
    };
    const { win, doc } = mountDrawer(BASE_JOB, [badFailure, PASSED_STEP]);
    await win.openJobDrawer(1);
    expect(doc.querySelectorAll("#drawer-steps details.failure-evidence").length).toBe(0);
    win.closeJobDrawer();
  });

  it("keeps an open failure-evidence panel open across a background re-render (BAC-27112 follow-up)", async () => {
    const { win, doc } = mountDrawer(BASE_JOB, [FAILED_STEP, PASSED_STEP]);
    await win.openJobDrawer(1);
    const details = doc.querySelector("#drawer-steps details.failure-evidence") as unknown as { open: boolean };
    expect(details).toBeTruthy();
    details.open = true;

    await win.refreshJobDrawer(1, { background: true });

    const detailsAfter = doc.querySelector("#drawer-steps details.failure-evidence") as unknown as { open: boolean };
    expect(detailsAfter).toBeTruthy();
    expect(detailsAfter.open).toBe(true);
    win.closeJobDrawer();
  });

  it("does not start the auto-refresh timer once the job is already terminal", async () => {
    const { win } = mountDrawer(BASE_JOB, [FAILED_STEP, PASSED_STEP]); // BASE_JOB.status === 'failed'
    const setIntervalSpy = vi.spyOn(win, "setInterval");
    await win.openJobDrawer(1);
    expect(setIntervalSpy).not.toHaveBeenCalled();
    win.closeJobDrawer();
  });

  it("starts the auto-refresh timer for a non-terminal job", async () => {
    const runningJob = { ...BASE_JOB, status: "running" };
    const { win } = mountDrawer(runningJob, [PASSED_STEP]);
    const setIntervalSpy = vi.spyOn(win, "setInterval");
    await win.openJobDrawer(1);
    expect(setIntervalSpy).toHaveBeenCalledTimes(1);
    win.closeJobDrawer();
  });

  it("treats dispatch-failed as terminal, matching log.ts's own terminal set", async () => {
    const job = { ...BASE_JOB, status: "dispatch-failed" };
    const { win } = mountDrawer(job, [PASSED_STEP]);
    const setIntervalSpy = vi.spyOn(win, "setInterval");
    await win.openJobDrawer(1);
    expect(setIntervalSpy).not.toHaveBeenCalled();
    win.closeJobDrawer();
  });

  it("resets currentJobTerminal on open, so a running job isn't stuck with auto-refresh disabled by a stale terminal flag from a previously opened terminal job (BAC-27112 follow-up)", async () => {
    const { win } = mountDrawer(BASE_JOB, [FAILED_STEP, PASSED_STEP]); // BASE_JOB.status === 'failed' -> terminal
    await win.openJobDrawer(1);
    win.closeJobDrawer();

    // The next job's own fetch fails, so refreshJobDrawer's success path (which
    // would otherwise update the flag) never runs — only openJobDrawer's own
    // reset can prevent the stale `true` from a prior terminal job leaking in.
    win.api = async (url: string) => {
      if (url === "/api/mappings") return { ok: true, status: 200, json: async () => ({}) };
      return { ok: false, status: 500, json: async () => ({}) };
    };
    const setIntervalSpy = vi.spyOn(win, "setInterval");
    await win.openJobDrawer(2);
    expect(setIntervalSpy).toHaveBeenCalledTimes(1);
    win.closeJobDrawer();
  });

  it("restores each <pre>'s scrollTop alongside the open state on a background re-render (BAC-27112 follow-up)", async () => {
    const { win, doc } = mountDrawer(BASE_JOB, [FAILED_STEP, PASSED_STEP]);
    await win.openJobDrawer(1);
    const pre = doc.querySelector("#drawer-steps pre") as unknown as { scrollTop: number };
    expect(pre).toBeTruthy();
    pre.scrollTop = 42;

    await win.refreshJobDrawer(1, { background: true });

    const preAfter = doc.querySelector("#drawer-steps pre") as unknown as { scrollTop: number };
    expect(preAfter).toBeTruthy();
    expect(preAfter.scrollTop).toBe(42);
    win.closeJobDrawer();
  });

  it("keys the evidence <pre> ids on step.stepId, not the loop index, so scroll restore survives a re-ordered step list (BAC-27112 follow-up)", async () => {
    const secondFailedStep = {
      ...FAILED_STEP,
      id: 3,
      stepId: "implement",
      outputsJson: JSON.stringify({
        error: "boom",
        failure: {
          category: "transient",
          code: "PROVIDER_OVERLOADED",
          stage: "implement",
          attempt: 1,
          retryable: true,
          message: "overloaded_error",
          evidence: { stderrTail: "second step stderr", truncated: false },
        },
      }),
    };
    const { win, doc } = mountDrawer(BASE_JOB, [FAILED_STEP, secondFailedStep]);
    await win.openJobDrawer(1);
    const pre = doc.getElementById("failure-stderr-implement") as unknown as { scrollTop: number } | null;
    expect(pre).toBeTruthy();
    pre!.scrollTop = 77;

    // Re-render with the same two steps in the opposite order — the second step's
    // pre element must keep the id (and therefore the restored scroll position)
    // it had before, rather than trading ids with whatever now sits at its old index.
    win.api = async (url: string) => {
      if (url === "/api/mappings") return { ok: true, status: 200, json: async () => ({}) };
      return { ok: true, status: 200, json: async () => ({ job: BASE_JOB, steps: [secondFailedStep, FAILED_STEP] }) };
    };
    await win.refreshJobDrawer(1, { background: true });

    const preAfter = doc.getElementById("failure-stderr-implement") as unknown as { scrollTop: number } | null;
    expect(preAfter).toBeTruthy();
    expect(preAfter!.scrollTop).toBe(77);
    win.closeJobDrawer();
  });
});
