import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { notify, notifyCompletion } from "../notify.js";

const notification = {
  issueIdentifier: "TEST-5",
  issueTitle: "Fix the thing",
  issueUrl: "https://linear.app/issue/TEST-5",
  repoFullName: "org/repo",
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

    it("throws on non-ok response", async () => {
      vi.mocked(fetch).mockResolvedValueOnce({ ok: false, status: 500, text: async () => "err" } as Response);
      await expect(
        notifyCompletion("teams", "https://hook.example.com", { ...completionBase, status: "completed" }),
      ).rejects.toThrow("500");
    });
  });
});
