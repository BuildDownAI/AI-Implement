import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { notify, notifyCompletion, notifyDeploy, notifyKgRefreshOutcome } from "../notify.js";
import type { DeployNotification, Notification } from "../notify.js";

const notification: Notification = {
  issueIdentifier: "TEST-5",
  issueTitle: "Fix the thing",
  issueUrl: "https://linear.app/issue/TEST-5",
  repoFullName: "org/repo",
  phase: "implementation",
};

describe("notify (dispatch)", () => {
  beforeEach(() => { vi.stubGlobal("fetch", vi.fn()); });
  afterEach(() => { vi.restoreAllMocks(); });

  describe("slack", () => {
    it("sends a blocks message to the webhook URL", async () => {
      vi.mocked(fetch).mockResolvedValueOnce({ ok: true, status: 200 } as Response);

      await notify("slack", "https://webhook.example.com/slack", notification);

      expect(fetch).toHaveBeenCalledOnce();
      const [url, opts] = vi.mocked(fetch).mock.calls[0];
      expect(url).toBe("https://webhook.example.com/slack");
      const body = JSON.parse((opts as RequestInit).body as string);
      expect(body.blocks).toBeDefined();
      expect(body.blocks[0].text.text).toContain("TEST-5");
      expect(body.blocks[0].text.text).toContain("Fix the thing");
      expect(body.blocks[0].text.text).toContain("org/repo");
    });

    it("uses slack by default when type is unrecognised", async () => {
      vi.mocked(fetch).mockResolvedValueOnce({ ok: true, status: 200 } as Response);
      await notify("unknown-type", "https://webhook.example.com/hook", notification);
      const body = JSON.parse((vi.mocked(fetch).mock.calls[0][1] as RequestInit).body as string);
      expect(body.blocks).toBeDefined();
    });

    it("throws on non-ok response", async () => {
      vi.mocked(fetch).mockResolvedValueOnce({ ok: false, status: 500, text: async () => "Server Error" } as Response);
      await expect(notify("slack", "https://webhook.example.com/slack", notification)).rejects.toThrow("500");
    });
  });

  describe("teams", () => {
    it("sends an Adaptive Card to the webhook URL", async () => {
      vi.mocked(fetch).mockResolvedValueOnce({ ok: true, status: 200 } as Response);

      await notify("teams", "https://webhook.example.com/teams", notification);

      expect(fetch).toHaveBeenCalledOnce();
      const [url, opts] = vi.mocked(fetch).mock.calls[0];
      expect(url).toBe("https://webhook.example.com/teams");
      const body = JSON.parse((opts as RequestInit).body as string);
      expect(body.type).toBe("message");
      expect(body.attachments).toHaveLength(1);
      const card = body.attachments[0].content;
      expect(card.type).toBe("AdaptiveCard");
      const facts = card.body[1].facts;
      expect(facts[0].value).toContain("TEST-5");
      expect(facts[1].value).toBe("org/repo");
    });

    it("is case-insensitive for the type parameter", async () => {
      vi.mocked(fetch).mockResolvedValueOnce({ ok: true, status: 200 } as Response);
      await notify("Teams", "https://webhook.example.com/teams", notification);
      const body = JSON.parse((vi.mocked(fetch).mock.calls[0][1] as RequestInit).body as string);
      expect(body.type).toBe("message");
    });

    it("throws on non-ok response", async () => {
      vi.mocked(fetch).mockResolvedValueOnce({ ok: false, status: 500, text: async () => "Server Error" } as Response);
      await expect(notify("teams", "https://webhook.example.com/teams", notification)).rejects.toThrow("500");
    });
  });

  // AII-168: planning and implementation dispatch separately; each must be labelled
  // so one issue's two dispatches don't read as a duplicate run.
  describe("phase label", () => {
    // Returns the dispatch title for a given provider + phase: the slack mrkdwn line
    // (title embedded in a larger string) or the teams TextBlock text (the title alone).
    async function dispatchTitle(type: "slack" | "teams", phase: Notification["phase"]): Promise<string> {
      vi.mocked(fetch).mockResolvedValueOnce({ ok: true, status: 200 } as Response);
      await notify(type, "https://webhook.example.com/hook", { ...notification, phase });
      const body = JSON.parse((vi.mocked(fetch).mock.calls[0][1] as RequestInit).body as string);
      return type === "slack" ? body.blocks[0].text.text : body.attachments[0].content.body[0].text;
    }

    it("slack labels a planning dispatch", async () => {
      expect(await dispatchTitle("slack", "planning")).toContain("AI Planning Dispatched");
    });
    it("slack labels an implementation dispatch", async () => {
      expect(await dispatchTitle("slack", "implementation")).toContain("AI Implementation Dispatched");
    });
    it("teams labels a planning dispatch", async () => {
      expect(await dispatchTitle("teams", "planning")).toBe("AI Planning Dispatched");
    });
    it("teams labels an implementation dispatch", async () => {
      expect(await dispatchTitle("teams", "implementation")).toBe("AI Implementation Dispatched");
    });
  });
});

describe("notifyCompletion", () => {
  beforeEach(() => { vi.stubGlobal("fetch", vi.fn()); });
  afterEach(() => { vi.restoreAllMocks(); });

  const completionBase = {
    issueIdentifier: "TEST-5",
    issueTitle: "Fix the thing",
    issueUrl: "https://linear.app/issue/TEST-5",
    repoFullName: "org/repo",
    conclusion: "success" as const,
    prUrl: "https://github.com/org/repo/pull/42",
    runUrl: "https://github.com/org/repo/actions/runs/123",
    phase: "implementation" as const,
  };

  describe("slack", () => {
    it("sends a completion message with PR and run links", async () => {
      vi.mocked(fetch).mockResolvedValueOnce({ ok: true, status: 200 } as Response);

      await notifyCompletion("slack", "https://webhook.example.com/slack", {
        ...completionBase,
        status: "completed",
      });

      const body = JSON.parse((vi.mocked(fetch).mock.calls[0][1] as RequestInit).body as string);
      const text = body.blocks[0].text.text;
      expect(text).toContain("Completed");
      expect(text).toContain("TEST-5");
      expect(text).toContain("pull/42");
      expect(text).toContain("runs/123");
    });

    it("sends a failure message", async () => {
      vi.mocked(fetch).mockResolvedValueOnce({ ok: true, status: 200 } as Response);

      await notifyCompletion("slack", "https://webhook.example.com/slack", {
        ...completionBase,
        status: "failed",
        conclusion: "failure",
        prUrl: null,
      });

      const body = JSON.parse((vi.mocked(fetch).mock.calls[0][1] as RequestInit).body as string);
      const text = body.blocks[0].text.text;
      expect(text).toContain("Failed");
      expect(text).not.toContain("Pull Request");
    });

    it("sends a timeout message", async () => {
      vi.mocked(fetch).mockResolvedValueOnce({ ok: true, status: 200 } as Response);

      await notifyCompletion("slack", "https://webhook.example.com/slack", {
        ...completionBase,
        status: "timed_out",
        conclusion: "timed_out",
        prUrl: null,
      });

      const body = JSON.parse((vi.mocked(fetch).mock.calls[0][1] as RequestInit).body as string);
      expect(body.blocks[0].text.text).toContain("Timed Out");
    });

    it("sends a review-failed message with the PR link", async () => {
      vi.mocked(fetch).mockResolvedValueOnce({ ok: true, status: 200 } as Response);

      await notifyCompletion("slack", "https://webhook.example.com/slack", {
        ...completionBase,
        status: "review_failed",
        conclusion: "post_push_review_not_approved",
      });

      const body = JSON.parse((vi.mocked(fetch).mock.calls[0][1] as RequestInit).body as string);
      const text = body.blocks[0].text.text;
      expect(text).toContain("Needs Review");
      expect(text).toContain("pull/42");
    });

    it("labels the phase — planning vs implementation", async () => {
      vi.mocked(fetch).mockResolvedValueOnce({ ok: true, status: 200 } as Response);
      await notifyCompletion("slack", "https://webhook.example.com/slack", {
        ...completionBase, status: "completed", phase: "planning",
      });
      const text = JSON.parse((vi.mocked(fetch).mock.calls[0][1] as RequestInit).body as string).blocks[0].text.text;
      expect(text).toContain("AI Planning Completed");
    });

    it("renders the classification (summary, remediation, docs link) on failure", async () => {
      vi.mocked(fetch).mockResolvedValueOnce({ ok: true, status: 200 } as Response);
      await notifyCompletion("slack", "https://webhook.example.com/slack", {
        ...completionBase, status: "failed", conclusion: "exit_1", prUrl: null,
        summary: "Implementation failed.",
        detail: "The runner exited with code 1.",
        remediation: "Check the run logs, then re-dispatch once fixed.",
        docsUrl: "https://docs.builddown.ai/reference/troubleshooting",
      });
      const text = JSON.parse((vi.mocked(fetch).mock.calls[0][1] as RequestInit).body as string).blocks[0].text.text;
      expect(text).toContain("Implementation failed.");
      expect(text).toContain("*Next step:* Check the run logs");
      expect(text).toContain("<https://docs.builddown.ai/reference/troubleshooting|Troubleshooting guide>");
    });


    it("throws on non-ok response", async () => {
      vi.mocked(fetch).mockResolvedValueOnce({ ok: false, status: 500, text: async () => "err" } as Response);
      await expect(
        notifyCompletion("slack", "https://hook.example.com", { ...completionBase, status: "completed" }),
      ).rejects.toThrow("500");
    });
  });

  describe("teams", () => {
    it("sends an Adaptive Card with completion status and facts", async () => {
      vi.mocked(fetch).mockResolvedValueOnce({ ok: true, status: 200 } as Response);

      await notifyCompletion("teams", "https://webhook.example.com/teams", {
        ...completionBase,
        status: "completed",
      });

      const body = JSON.parse((vi.mocked(fetch).mock.calls[0][1] as RequestInit).body as string);
      const card = body.attachments[0].content;
      expect(card.body[0].text).toContain("Completed");
      const facts = card.body[1].facts;
      expect(facts.some((f: { title: string }) => f.title === "PR")).toBe(true);
      expect(facts.some((f: { title: string }) => f.title === "Run")).toBe(true);
    });

    it("omits PR fact when prUrl is null", async () => {
      vi.mocked(fetch).mockResolvedValueOnce({ ok: true, status: 200 } as Response);

      await notifyCompletion("teams", "https://webhook.example.com/teams", {
        ...completionBase,
        status: "failed",
        prUrl: null,
      });

      const body = JSON.parse((vi.mocked(fetch).mock.calls[0][1] as RequestInit).body as string);
      const facts = body.attachments[0].content.body[1].facts;
      expect(facts.some((f: { title: string }) => f.title === "PR")).toBe(false);
    });

    it("labels the phase in the card title", async () => {
      vi.mocked(fetch).mockResolvedValueOnce({ ok: true, status: 200 } as Response);
      await notifyCompletion("teams", "https://webhook.example.com/teams", {
        ...completionBase, status: "completed", phase: "planning",
      });
      const card = JSON.parse((vi.mocked(fetch).mock.calls[0][1] as RequestInit).body as string).attachments[0].content;
      expect(card.body[0].text).toContain("AI Planning Completed");
    });

    it("adds a classification TextBlock with the docs link on failure", async () => {
      vi.mocked(fetch).mockResolvedValueOnce({ ok: true, status: 200 } as Response);
      await notifyCompletion("teams", "https://webhook.example.com/teams", {
        ...completionBase, status: "failed", conclusion: "exit_1", prUrl: null,
        summary: "Implementation failed.",
        remediation: "Check the run logs, then re-dispatch once fixed.",
        docsUrl: "https://docs.builddown.ai/reference/troubleshooting",
      });
      const card = JSON.parse((vi.mocked(fetch).mock.calls[0][1] as RequestInit).body as string).attachments[0].content;
      const textBlocks = card.body.filter((b: { type: string }) => b.type === "TextBlock");
      const classification = textBlocks[textBlocks.length - 1].text;
      expect(classification).toContain("Implementation failed.");
      expect(classification).toContain("[Troubleshooting guide](https://docs.builddown.ai/reference/troubleshooting)");
    });

    it("throws on non-ok response", async () => {
      vi.mocked(fetch).mockResolvedValueOnce({ ok: false, status: 500, text: async () => "err" } as Response);
      await expect(
        notifyCompletion("teams", "https://hook.example.com", { ...completionBase, status: "completed" }),
      ).rejects.toThrow("500");
    });
  });
});

describe("notifyDeploy", () => {
  const deployBase: DeployNotification = {
    kind: "deployed",
    appName: "ai-implement-testing-orchestrator",
    region: "iad",
    imageRef: "registry.fly.io/ai-implement-testing-orchestrator:deployment-01H9RK9EYO9PGNBYAKGXSHV0PH",
    downtimeMs: 42_000,
  };

  const sentBody = () => JSON.parse((vi.mocked(fetch).mock.calls[0][1] as RequestInit).body as string);
  const slackText = (): string => sentBody().blocks[0].text.text;
  const teamsFacts = (): Array<{ title: string; value: string }> =>
    sentBody().attachments[0].content.body.find((b: { type: string }) => b.type === "FactSet").facts;

  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
    vi.mocked(fetch).mockResolvedValue({ ok: true, status: 200 } as Response);
  });
  afterEach(() => { vi.restoreAllMocks(); });

  describe("slack", () => {
    // The broadcast is the whole point of AII-255: the team must be pinged that dispatches are
    // pausing. The two boot notices answer that ping, so they must stay quiet.
    it("broadcasts to the channel on shutdown", async () => {
      await notifyDeploy("slack", "https://webhook.example.com/slack", {
        ...deployBase, kind: "shutdown", downtimeMs: null,
      });
      expect(slackText()).toContain("<!channel>");
      expect(slackText()).toContain("Orchestrator restarting");
    });

    it.each(["deployed", "restarted"] as const)("does not broadcast on %s", async (kind) => {
      await notifyDeploy("slack", "https://webhook.example.com/slack", { ...deployBase, kind });
      expect(slackText()).not.toContain("<!channel>");
    });

    it("omits the version on shutdown and shows it once back up", async () => {
      await notifyDeploy("slack", "https://webhook.example.com/slack", {
        ...deployBase, kind: "shutdown", downtimeMs: null,
      });
      expect(slackText()).not.toContain("Version:");

      vi.mocked(fetch).mockClear();
      await notifyDeploy("slack", "https://webhook.example.com/slack", deployBase);
      expect(slackText()).toContain("Version:");
    });

    // Only the deployment tag is readable; the registry host is noise that would wrap the line.
    it("renders the deployment tag rather than the whole image reference", async () => {
      await notifyDeploy("slack", "https://webhook.example.com/slack", deployBase);
      expect(slackText()).toContain("`deployment-01H9RK9EYO9PGNBYAKGXSHV0PH`");
      expect(slackText()).not.toContain("registry.fly.io");
    });

    it("falls back to the whole reference when it carries no tag", async () => {
      await notifyDeploy("slack", "https://webhook.example.com/slack", {
        ...deployBase, imageRef: "some-untagged-reference",
      });
      expect(slackText()).toContain("`some-untagged-reference`");
    });

    it("renders downtime through formatDuration", async () => {
      await notifyDeploy("slack", "https://webhook.example.com/slack", { ...deployBase, downtimeMs: 125_000 });
      expect(slackText()).toContain("Down for 2m 5s");
    });

    // A boot with no preceding shutdown record (hard kill, first boot) has nothing to measure.
    it("omits downtime when it was not measured", async () => {
      await notifyDeploy("slack", "https://webhook.example.com/slack", { ...deployBase, downtimeMs: null });
      expect(slackText()).not.toContain("Down for");
    });

    it("omits the region when unknown", async () => {
      await notifyDeploy("slack", "https://webhook.example.com/slack", { ...deployBase, region: null });
      expect(slackText()).not.toContain("Region:");
      expect(slackText()).toContain("App: `ai-implement-testing-orchestrator`");
    });

    it("uses slack by default when type is unrecognised", async () => {
      await notifyDeploy("unknown-type", "https://webhook.example.com/hook", deployBase);
      expect(sentBody().blocks).toBeDefined();
    });

    it("throws on non-ok response", async () => {
      vi.mocked(fetch).mockResolvedValue({ ok: false, status: 500, text: async () => "err" } as Response);
      await expect(
        notifyDeploy("slack", "https://webhook.example.com/slack", deployBase),
      ).rejects.toThrow("500");
    });
  });

  describe("teams", () => {
    it("carries app, region, version and downtime as facts", async () => {
      await notifyDeploy("teams", "https://webhook.example.com/teams", deployBase);
      const byTitle = Object.fromEntries(teamsFacts().map((f) => [f.title, f.value]));
      expect(byTitle).toEqual({
        App: "ai-implement-testing-orchestrator",
        Region: "iad",
        Version: "deployment-01H9RK9EYO9PGNBYAKGXSHV0PH",
        "Down for": "42s",
      });
    });

    it("titles the card by event kind", async () => {
      await notifyDeploy("teams", "https://webhook.example.com/teams", { ...deployBase, kind: "restarted" });
      expect(sentBody().attachments[0].content.body[0].text).toContain("Orchestrator back up");
    });

    it("omits the version fact on shutdown", async () => {
      await notifyDeploy("teams", "https://webhook.example.com/teams", {
        ...deployBase, kind: "shutdown", downtimeMs: null,
      });
      expect(teamsFacts().some((f) => f.title === "Version")).toBe(false);
    });

    // Slack broadcast syntax has no Teams equivalent — it would render as literal text in the card.
    it("never emits slack mention syntax", async () => {
      await notifyDeploy("teams", "https://webhook.example.com/teams", {
        ...deployBase, kind: "shutdown", downtimeMs: null,
      });
      expect((vi.mocked(fetch).mock.calls[0][1] as RequestInit).body as string).not.toContain("<!channel>");
    });

    it("throws on non-ok response", async () => {
      vi.mocked(fetch).mockResolvedValue({ ok: false, status: 500, text: async () => "err" } as Response);
      await expect(
        notifyDeploy("teams", "https://webhook.example.com/teams", deployBase),
      ).rejects.toThrow("500");
    });
  });

  describe("kgDegraded", () => {
    it("slack / kgDegraded=true shows warning line on deployed", async () => {
      await notifyDeploy("slack", "https://webhook.example.com/slack", { ...deployBase, kgDegraded: true });
      expect(slackText()).toContain("⚠️ KG embeddings missing — /mcp is lexical-only");
    });

    it("slack / kgDegraded=false emits no warning", async () => {
      await notifyDeploy("slack", "https://webhook.example.com/slack", { ...deployBase, kgDegraded: false });
      expect(slackText()).not.toContain("KG embeddings missing");
    });

    it("slack / kgDegraded absent emits no warning", async () => {
      await notifyDeploy("slack", "https://webhook.example.com/slack", deployBase);
      expect(slackText()).not.toContain("KG embeddings missing");
    });

    it("slack / kgDegraded=true shows warning on restarted", async () => {
      await notifyDeploy("slack", "https://webhook.example.com/slack", { ...deployBase, kind: "restarted", kgDegraded: true });
      expect(slackText()).toContain("⚠️ KG embeddings missing — /mcp is lexical-only");
    });

    it("teams / kgDegraded=true shows warning TextBlock in card body", async () => {
      await notifyDeploy("teams", "https://webhook.example.com/teams", { ...deployBase, kgDegraded: true });
      const cardBody: Array<{ type: string; text?: string }> = sentBody().attachments[0].content.body;
      expect(JSON.stringify(cardBody)).toContain("KG embeddings missing");
    });

    it("teams / kgDegraded=false emits no warning in card body", async () => {
      await notifyDeploy("teams", "https://webhook.example.com/teams", { ...deployBase, kgDegraded: false });
      const cardBody = sentBody().attachments[0].content.body;
      expect(JSON.stringify(cardBody)).not.toContain("KG embeddings missing");
    });

    it("teams / kgDegraded absent emits no warning in card body", async () => {
      await notifyDeploy("teams", "https://webhook.example.com/teams", deployBase);
      const cardBody = sentBody().attachments[0].content.body;
      expect(JSON.stringify(cardBody)).not.toContain("KG embeddings missing");
    });
  });

  describe("availability notice", () => {
    const available: DeployNotification = {
      ...deployBase,
      kind: "available",
      imageRef: null,
      downtimeMs: null,
      commit: "def5678abcdef0123456789",
    };

    it("names the waiting commit as the version, shortened", async () => {
      await notifyDeploy("slack", "https://webhook.example.com/slack", available);
      expect(slackText()).toContain("def5678");
      expect(slackText()).not.toContain("def5678abcdef");
    });

    it("does not broadcast — an invitation, not an interruption", async () => {
      // Only the shutdown notice earns an @channel: it is the one telling people
      // their dispatches have stopped. This one is asking for a decision.
      await notifyDeploy("slack", "https://webhook.example.com/slack", available);
      expect(slackText()).not.toContain("<!channel>");
      expect(slackText()).toContain("Deployment available");
    });

    it("carries the commit on teams as well, with no per-provider work", async () => {
      await notifyDeploy("teams", "https://webhook.example.com/teams", available);
      expect(teamsFacts()).toContainEqual({ title: "Version", value: "def5678" });
    });

    it("omits the version rather than rendering an empty one without a commit", async () => {
      await notifyDeploy("teams", "https://webhook.example.com/teams", { ...available, commit: null });
      expect(teamsFacts().map((f) => f.title)).not.toContain("Version");
    });

    it("never falls back to the image ref", async () => {
      // There is no image for an available deployment. A stale ref would name the
      // *running* version as though it were the one waiting — worse than showing none.
      await notifyDeploy("teams", "https://webhook.example.com/teams", {
        ...available,
        commit: null,
        imageRef: "registry.fly.io/ai-implement-testing-orchestrator:deployment-STALE",
      });
      expect(teamsFacts().map((f) => f.title)).not.toContain("Version");
    });
  });
});

describe("notifyKgRefreshOutcome", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
    vi.mocked(fetch).mockResolvedValue({ ok: true, status: 200 } as Response);
  });
  afterEach(() => { vi.restoreAllMocks(); });

  const sentBody = () => JSON.parse((vi.mocked(fetch).mock.calls[0][1] as RequestInit).body as string);
  const slackText = (): string => sentBody().blocks[0].text.text;
  const teamsBody = (): Array<{ type: string; text?: string }> => sentBody().attachments[0].content.body;

  describe("slack", () => {
    it("sends a success message with check-mark emoji", async () => {
      await notifyKgRefreshOutcome("slack", "https://hook.example.com/slack", { outcome: "success" });
      expect(slackText()).toContain(":white_check_mark:");
      expect(slackText()).toContain("KG Refresh succeeded");
    });

    it("sends a no-new-data message noting graph is current", async () => {
      await notifyKgRefreshOutcome("slack", "https://hook.example.com/slack", { outcome: "no-new-data" });
      expect(slackText()).toContain("KG Refresh: graph is current");
      expect(slackText()).toContain("no new data to ingest");
    });

    it("sends a failure message with x emoji", async () => {
      await notifyKgRefreshOutcome("slack", "https://hook.example.com/slack", { outcome: "failure" });
      expect(slackText()).toContain(":x:");
      expect(slackText()).toContain("KG Refresh failed");
    });

    it("includes summary and detail when provided on failure", async () => {
      await notifyKgRefreshOutcome("slack", "https://hook.example.com/slack", {
        outcome: "failure",
        summary: "KG Refresh hit the time limit.",
        detail: "Failure code: TIMEOUT",
      });
      expect(slackText()).toContain("KG Refresh hit the time limit.");
      expect(slackText()).toContain("Failure code: TIMEOUT");
    });

    it("uses slack by default for unrecognised type", async () => {
      await notifyKgRefreshOutcome("other", "https://hook.example.com/other", { outcome: "success" });
      expect(sentBody().blocks).toBeDefined();
    });

    it("throws on non-ok response", async () => {
      vi.mocked(fetch).mockResolvedValueOnce({ ok: false, status: 500, text: async () => "err" } as Response);
      await expect(
        notifyKgRefreshOutcome("slack", "https://hook.example.com/slack", { outcome: "success" }),
      ).rejects.toThrow("500");
    });
  });

  describe("teams", () => {
    it("sends an Adaptive Card with success title", async () => {
      await notifyKgRefreshOutcome("teams", "https://hook.example.com/teams", { outcome: "success" });
      const body = teamsBody();
      expect(body[0].text).toContain("KG Refresh succeeded");
      expect(body[0].text).toContain("&#x2705;");
    });

    it("sends a no-new-data card with descriptive TextBlock", async () => {
      await notifyKgRefreshOutcome("teams", "https://hook.example.com/teams", { outcome: "no-new-data" });
      const body = teamsBody();
      expect(body[0].text).toContain("KG Refresh: graph is current");
      expect(JSON.stringify(body)).toContain("No new data to ingest");
    });

    it("sends a failure card with failure icon", async () => {
      await notifyKgRefreshOutcome("teams", "https://hook.example.com/teams", { outcome: "failure" });
      const body = teamsBody();
      expect(body[0].text).toContain("&#x274C;");
      expect(body[0].text).toContain("KG Refresh failed");
    });

    it("includes summary and detail in failure card body", async () => {
      await notifyKgRefreshOutcome("teams", "https://hook.example.com/teams", {
        outcome: "failure",
        summary: "KG Refresh hit the time limit.",
        detail: "Failure code: TIMEOUT",
      });
      const bodyText = JSON.stringify(teamsBody());
      expect(bodyText).toContain("KG Refresh hit the time limit.");
      expect(bodyText).toContain("Failure code: TIMEOUT");
    });

    it("is case-insensitive for the type parameter", async () => {
      await notifyKgRefreshOutcome("Teams", "https://hook.example.com/teams", { outcome: "success" });
      expect(sentBody().type).toBe("message");
    });

    it("throws on non-ok response", async () => {
      vi.mocked(fetch).mockResolvedValueOnce({ ok: false, status: 500, text: async () => "err" } as Response);
      await expect(
        notifyKgRefreshOutcome("teams", "https://hook.example.com/teams", { outcome: "failure" }),
      ).rejects.toThrow("500");
    });
  });
});
