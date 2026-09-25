import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Job } from "../log.js";
import type { RepoMapping } from "../config.js";
import type { StaleAdmissionCandidate } from "../dispatch-admission.js";

// confirmAdmissionTerminated (src/index.ts) is sweepStaleAdmissions' real production
// oracle — wired in at poll()'s admission sweep — as opposed to the injected
// CONFIRM_ALL/CONFIRM_NONE fakes exercised in dispatch-admission.test.ts. This file
// covers both AII-783 PR #681 review rounds: a github-actions job whose runId was never
// linked is a reachable, still-possibly-running state (a transient GitHub API hiccup, a
// getClaimedRunIds() exclusion, or a workflowFile/defaultBranch mismatch after a resync),
// not proof nothing launched; and — second round — neither "no dispatch_log row at all"
// nor "a row with no machineId/containerId" is proof either, since both can result from a
// launch that was accepted but whose response/process was lost before it could be
// recorded. All of these must resolve to unconfirmed rather than confirmed-terminated.

vi.mock("../github.js", () => ({
  getWorkflowRunStatus: vi.fn(),
  findWorkflowRunId: vi.fn(),
}));

vi.mock("../fly-machines.js", () => ({
  getMachine: vi.fn(),
}));

vi.mock("../local-docker.js", () => ({
  inspectLocalContainer: vi.fn(),
}));

vi.mock("../github-app-auth.js", () => ({
  getInstallationToken: vi.fn().mockResolvedValue("gh-token-mock"),
}));

vi.mock("../log.js", () => ({
  getJobByDispatchId: vi.fn(),
  getClaimedRunIds: vi.fn().mockReturnValue(new Set()),
  attachJobRunIdIfMissing: vi.fn().mockReturnValue(true),
}));

vi.mock("../config.js", () => ({
  getMappings: vi.fn().mockReturnValue({}),
}));

import { confirmAdmissionTerminated } from "../index.js";
import type { AppConfig } from "../index.js";
import { getWorkflowRunStatus, findWorkflowRunId } from "../github.js";
import { getMachine } from "../fly-machines.js";
import { inspectLocalContainer } from "../local-docker.js";
import { getJobByDispatchId, attachJobRunIdIfMissing } from "../log.js";
import { getMappings } from "../config.js";

const mockConfig = {
  githubAppId: "12345",
  githubAppPrivateKey: "-----BEGIN RSA PRIVATE KEY-----\nmock\n-----END RSA PRIVATE KEY-----",
  flySessionsToken: "fly-token-mock",
  flySessionsApp: "fly-app-mock",
} as unknown as AppConfig;

function makeCandidate(overrides: Partial<StaleAdmissionCandidate> = {}): StaleAdmissionCandidate {
  return {
    dispatchId: "dispatch-1",
    mappingKey: "AII",
    backend: "github-actions",
    lifecycleOwner: { kind: "legacy" },
    ageMs: 7 * 60 * 60 * 1000,
    ...overrides,
  } as StaleAdmissionCandidate;
}

function makeJob(overrides: Partial<Job> = {}): Job {
  return {
    id: 1,
    issueId: "issue-abc",
    issueIdentifier: "AII-783",
    issueTitle: "Some issue",
    teamKey: "AII",
    repo: "org/repo",
    dispatchedAt: Date.now() - 7 * 60 * 60 * 1000,
    dispatchId: "dispatch-1",
    dispatchNumber: 1,
    issueState: null,
    runId: null,
    status: "dispatched",
    conclusion: null,
    prUrl: null,
    completedAt: null,
    notifiedAt: null,
    machineNonce: null,
    executionMode: "github-actions",
    machineId: null,
    runnerMode: null,
    sessionImage: null,
    phase: "implementation",
    contract: null,
    groupingParent: false,
    approved: false,
    failure: null,
    failureCommentedAt: null,
    ...overrides,
  } as Job;
}

function makeMapping(overrides: Partial<RepoMapping> = {}): RepoMapping {
  return {
    owner: "org",
    repo: "repo",
    workflowFile: "claude-implement.yml",
    planningWorkflowFile: "claude-plan.yml",
    defaultBranch: "main",
    ...overrides,
  } as RepoMapping;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getMappings).mockReturnValue({});
  vi.mocked(attachJobRunIdIfMissing).mockReturnValue(true);
});

describe("confirmAdmissionTerminated — github-actions, runId never linked", () => {
  it("holds the reservation (unconfirmed) when no mapping is found to retry the run-ID lookup", async () => {
    const job = makeJob({ runId: null, teamKey: "missing-team" });
    vi.mocked(getJobByDispatchId).mockReturnValue(job);
    vi.mocked(getMappings).mockReturnValue({});

    const result = await confirmAdmissionTerminated(mockConfig, makeCandidate());

    expect(result).toBe(false);
    expect(getWorkflowRunStatus).not.toHaveBeenCalled();
  });

  it("holds the reservation when a retried run-ID lookup still finds nothing — a genuinely running attempt must not free capacity", async () => {
    const job = makeJob({ runId: null, teamKey: "AII" });
    vi.mocked(getJobByDispatchId).mockReturnValue(job);
    vi.mocked(getMappings).mockReturnValue({ AII: makeMapping() });
    vi.mocked(findWorkflowRunId).mockResolvedValue(null);

    const result = await confirmAdmissionTerminated(mockConfig, makeCandidate());

    expect(result).toBe(false);
    expect(findWorkflowRunId).toHaveBeenCalledTimes(1);
    expect(getWorkflowRunStatus).not.toHaveBeenCalled();
  });

  it("attaches and checks status when the retried lookup finds the run, resolving to the run's actual status", async () => {
    const job = makeJob({ runId: null, teamKey: "AII" });
    vi.mocked(getJobByDispatchId).mockReturnValue(job);
    vi.mocked(getMappings).mockReturnValue({ AII: makeMapping() });
    vi.mocked(findWorkflowRunId).mockResolvedValue(555);
    vi.mocked(getWorkflowRunStatus).mockResolvedValue({ status: "in_progress" } as never);

    const result = await confirmAdmissionTerminated(mockConfig, makeCandidate());

    expect(result).toBe(false);
    expect(attachJobRunIdIfMissing).toHaveBeenCalledWith(job.id, 555);
    expect(getWorkflowRunStatus).toHaveBeenCalledWith("gh-token-mock", "org", "repo", 555);
  });

  it("confirms terminated only once a linked run's own status is completed", async () => {
    const job = makeJob({ runId: 42, teamKey: "AII" });
    vi.mocked(getJobByDispatchId).mockReturnValue(job);
    vi.mocked(getWorkflowRunStatus).mockResolvedValue({ status: "completed" } as never);

    const result = await confirmAdmissionTerminated(mockConfig, makeCandidate());

    expect(result).toBe(true);
    expect(findWorkflowRunId).not.toHaveBeenCalled();
  });

  it("holds the reservation when a linked run is still in_progress", async () => {
    const job = makeJob({ runId: 42, teamKey: "AII" });
    vi.mocked(getJobByDispatchId).mockReturnValue(job);
    vi.mocked(getWorkflowRunStatus).mockResolvedValue({ status: "in_progress" } as never);

    const result = await confirmAdmissionTerminated(mockConfig, makeCandidate());

    expect(result).toBe(false);
  });

  it("holds the reservation when job.repo is missing", async () => {
    const job = makeJob({ runId: null, repo: null });
    vi.mocked(getJobByDispatchId).mockReturnValue(job);

    const result = await confirmAdmissionTerminated(mockConfig, makeCandidate());

    expect(result).toBe(false);
  });
});

describe("confirmAdmissionTerminated — fly-machines", () => {
  it("holds the reservation when Fly credentials are unavailable to check the backend", async () => {
    const job = makeJob({ executionMode: "fly-machines", machineId: "m-1" });
    vi.mocked(getJobByDispatchId).mockReturnValue(job);

    const result = await confirmAdmissionTerminated(
      { ...mockConfig, flySessionsToken: null, flySessionsApp: null } as AppConfig,
      makeCandidate({ backend: "fly-machines" }),
    );

    expect(result).toBe(false);
    expect(getMachine).not.toHaveBeenCalled();
  });

  it("holds the reservation when a job row exists but no machineId was ever recorded — a lost launch response, not proof nothing launched (AII-783 review, second round)", async () => {
    const job = makeJob({ executionMode: "fly-machines", machineId: null });
    vi.mocked(getJobByDispatchId).mockReturnValue(job);

    const result = await confirmAdmissionTerminated(mockConfig, makeCandidate({ backend: "fly-machines" }));

    expect(result).toBe(false);
    expect(getMachine).not.toHaveBeenCalled();
  });

  it("confirms terminated once the machine is observed stopped", async () => {
    const job = makeJob({ executionMode: "fly-machines", machineId: "m-1" });
    vi.mocked(getJobByDispatchId).mockReturnValue(job);
    vi.mocked(getMachine).mockResolvedValue({ state: "stopped" } as never);

    const result = await confirmAdmissionTerminated(mockConfig, makeCandidate({ backend: "fly-machines" }));

    expect(result).toBe(true);
  });

  it("holds the reservation while the machine is still observed running", async () => {
    const job = makeJob({ executionMode: "fly-machines", machineId: "m-1" });
    vi.mocked(getJobByDispatchId).mockReturnValue(job);
    vi.mocked(getMachine).mockResolvedValue({ state: "started" } as never);

    const result = await confirmAdmissionTerminated(mockConfig, makeCandidate({ backend: "fly-machines" }));

    expect(result).toBe(false);
  });
});

describe("confirmAdmissionTerminated — no matching job row", () => {
  it("holds the reservation when the dispatch_log row itself never existed — indistinguishable from a crash after an accepted launch but before appendLog (AII-783 review, both rounds, on PR #681)", async () => {
    vi.mocked(getJobByDispatchId).mockReturnValue(null);

    const result = await confirmAdmissionTerminated(mockConfig, makeCandidate());

    expect(result).toBe(false);
  });
});

describe("confirmAdmissionTerminated — local-docker", () => {
  it("holds the reservation when a job row exists but no containerId was ever recorded", async () => {
    const job = makeJob({ executionMode: "local-docker", machineId: null });
    vi.mocked(getJobByDispatchId).mockReturnValue(job);

    const result = await confirmAdmissionTerminated(mockConfig, makeCandidate({ backend: "local-docker" }));

    expect(result).toBe(false);
  });

  it("confirms terminated once the container is observed stopped", async () => {
    const job = makeJob({ executionMode: "local-docker", machineId: "c-1" });
    vi.mocked(getJobByDispatchId).mockReturnValue(job);
    vi.mocked(inspectLocalContainer).mockResolvedValue({ status: "exited", running: false, exitCode: 0 });

    const result = await confirmAdmissionTerminated(mockConfig, makeCandidate({ backend: "local-docker" }));

    expect(result).toBe(true);
  });

  it("holds the reservation while the container is still observed running", async () => {
    const job = makeJob({ executionMode: "local-docker", machineId: "c-1" });
    vi.mocked(getJobByDispatchId).mockReturnValue(job);
    vi.mocked(inspectLocalContainer).mockResolvedValue({ status: "running", running: true, exitCode: null });

    const result = await confirmAdmissionTerminated(mockConfig, makeCandidate({ backend: "local-docker" }));

    expect(result).toBe(false);
  });

  it("confirms terminated when docker inspect reports the container already gone", async () => {
    const job = makeJob({ executionMode: "local-docker", machineId: "c-1" });
    vi.mocked(getJobByDispatchId).mockReturnValue(job);
    vi.mocked(inspectLocalContainer).mockRejectedValue(new Error("No such container: c-1"));

    const result = await confirmAdmissionTerminated(mockConfig, makeCandidate({ backend: "local-docker" }));

    expect(result).toBe(true);
  });

  it("holds the reservation when docker inspect fails for an unrelated reason (daemon unreachable)", async () => {
    const job = makeJob({ executionMode: "local-docker", machineId: "c-1" });
    vi.mocked(getJobByDispatchId).mockReturnValue(job);
    vi.mocked(inspectLocalContainer).mockRejectedValue(new Error("Cannot connect to the Docker daemon"));

    const result = await confirmAdmissionTerminated(mockConfig, makeCandidate({ backend: "local-docker" }));

    expect(result).toBe(false);
  });
});
