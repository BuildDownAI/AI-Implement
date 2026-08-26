import { describe, it, expect, vi } from "vitest";
import { runAccessRecovery, type AccessRecoveryDependencies } from "../access-recovery.js";
import type { AccessEntry } from "../access-entries.js";

/** A stored row, with the provenance fields the command never sets itself. */
function entry(kind: "address" | "domain", value: string, role: "user" | "admin" = "user"): AccessEntry {
  return { kind, value, role, provider: null, subject: null, addedAt: 0, addedBy: null };
}

/**
 * Fake dependencies throughout: the storage behaviour is the access-entries suite's job, so these
 * assert only what the command itself decides — which list it computes, and how it reports.
 */
function deps(overrides: Partial<AccessRecoveryDependencies> = {}) {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const saved: Array<Parameters<AccessRecoveryDependencies["saveEntries"]>> = [];
  const notified: Array<[string, string]> = [];

  const base: AccessRecoveryDependencies = {
    initTables: vi.fn(),
    listEntries: () => [],
    saveEntries: ((...args) => { saved.push(args); }) as AccessRecoveryDependencies["saveEntries"],
    notify: async (url, message) => { notified.push([url, message]); },
    writeStdout: (text) => { stdout.push(text); },
    writeStderr: (text) => { stderr.push(text); },
    notifyWebhookUrl: undefined,
    appName: undefined,
    ...overrides,
  };
  return { deps: base, stdout, stderr, saved, notified };
}

describe("runAccessRecovery arguments", () => {
  it("prints usage and succeeds for --help, touching nothing", async () => {
    const d = deps();
    expect(await runAccessRecovery(["--help"], d.deps)).toBe(0);
    expect(d.stdout.join("")).toContain("Usage: node dist/access-recovery.js");
    expect(d.saved).toHaveLength(0);
    expect(d.deps.initTables).not.toHaveBeenCalled();
  });

  it("refuses to run without --email", async () => {
    const d = deps();
    expect(await runAccessRecovery([], d.deps)).toBe(1);
    expect(d.stderr.join("")).toContain("--email is required");
    expect(d.saved).toHaveLength(0);
  });

  it("refuses an unknown argument rather than ignoring it", async () => {
    const d = deps();
    expect(await runAccessRecovery(["--email", "ada@example.com", "--wipe"], d.deps)).toBe(1);
    expect(d.stderr.join("")).toContain("Unknown argument: --wipe");
    expect(d.saved).toHaveLength(0);
  });

  it("rejects a malformed address with the validator's own message, and writes nothing", async () => {
    const d = deps();
    expect(await runAccessRecovery(["--email", "not-an-email"], d.deps)).toBe(1);
    expect(d.stderr.join("")).toContain("is not an email address");
    expect(d.saved).toHaveLength(0);
  });
});

describe("runAccessRecovery list construction", () => {
  it("initializes its tables — a separate process, where nothing else has", async () => {
    const d = deps();
    await runAccessRecovery(["--email", "ada@example.com"], d.deps);
    expect(d.deps.initTables).toHaveBeenCalled();
  });

  it("adds to the existing list by default, leaving domain entries intact", async () => {
    const d = deps({
      listEntries: () => [entry("address", "cam@example.com", "admin"), entry("domain", "example.com")],
    });
    expect(await runAccessRecovery(["--email", "ada@example.com"], d.deps)).toBe(0);

    expect(d.saved[0]![0]).toEqual([
      { kind: "address", value: "cam@example.com", role: "admin" },
      { kind: "domain", value: "example.com", role: "user" },
      { kind: "address", value: "ada@example.com", role: "admin" },
    ]);
  });

  it("promotes an address already listed instead of failing as a duplicate", async () => {
    const d = deps({ listEntries: () => [entry("address", "ada@example.com", "user")] });
    expect(await runAccessRecovery(["--email", "ADA@Example.com"], d.deps)).toBe(0);

    // One entry, now admin — the demotion that could have caused the lockout is undone.
    expect(d.saved[0]![0]).toEqual([{ kind: "address", value: "ada@example.com", role: "admin" }]);
  });

  it("replaces the whole list under --only", async () => {
    const d = deps({
      listEntries: () => [entry("address", "cam@example.com", "admin"), entry("domain", "example.com")],
    });
    expect(await runAccessRecovery(["--email", "ada@example.com", "--only"], d.deps)).toBe(0);

    expect(d.saved[0]![0]).toEqual([{ kind: "address", value: "ada@example.com", role: "admin" }]);
    expect(d.stdout.join("")).toContain("replacing the previous list");
  });

  it("records the change as a recovery by nobody", async () => {
    const d = deps();
    await runAccessRecovery(["--email", "ada@example.com"], d.deps);

    const [, actor, opts] = d.saved[0]!;
    expect(actor).toBeNull();
    expect(opts).toEqual({ action: "recover" });
  });

  it("returns a failure code when the save is refused", async () => {
    const d = deps({
      saveEntries: () => { throw new Error("database is locked"); },
    });
    expect(await runAccessRecovery(["--email", "ada@example.com"], d.deps)).toBe(1);
    expect(d.stderr.join("")).toContain("Recovery failed: database is locked");
  });

  it("returns a failure code when the tables cannot be created", async () => {
    // Same path as a save failure: one try covers every step that touches the database.
    const d = deps({ initTables: () => { throw new Error("unable to open database file"); } });
    expect(await runAccessRecovery(["--email", "ada@example.com"], d.deps)).toBe(1);
    expect(d.stderr.join("")).toContain("Recovery failed: unable to open database file");
  });
});

describe("runAccessRecovery notification", () => {
  it("announces the recovery when a webhook is configured", async () => {
    const d = deps({ notifyWebhookUrl: "https://hooks.example.com/abc", appName: "orchestrator-prod" });
    await runAccessRecovery(["--email", "ada@example.com"], d.deps);

    expect(d.notified).toHaveLength(1);
    const [url, message] = d.notified[0]!;
    expect(url).toBe("https://hooks.example.com/abc");
    expect(message).toContain("orchestrator-prod");
    expect(message).toContain("ada@example.com");
    expect(message).toContain("no authenticated user");
  });

  it("stays silent when no webhook is configured", async () => {
    const d = deps();
    await runAccessRecovery(["--email", "ada@example.com"], d.deps);
    expect(d.notified).toHaveLength(0);
  });

  it("still succeeds when the webhook is down — the access change is what mattered", async () => {
    const d = deps({
      notifyWebhookUrl: "https://hooks.example.com/abc",
      notify: async () => { throw new Error("503"); },
    });
    expect(await runAccessRecovery(["--email", "ada@example.com"], d.deps)).toBe(0);
    expect(d.stderr.join("")).toContain("Notification failed");
  });
});
