import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// dedup.ts freezes its DB path at import time, so each test sets a unique DEDUP_DB_PATH and
// re-imports the modules fresh (the same isolation pattern admin-session.test.ts uses).
let access: typeof import("../access-entries.js");
let audit: typeof import("../access-audit.js");
let dedup: typeof import("../dedup.js");
let dbPath: string;

beforeEach(async () => {
  vi.resetModules();
  dbPath = path.join(os.tmpdir(), `access-entries-test-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`);
  process.env.DEDUP_DB_PATH = dbPath;
  access = await import("../access-entries.js");
  audit = await import("../access-audit.js");
  dedup = await import("../dedup.js");
  access.initAccessEntriesTable();
  // saveAccessEntries records every write, so the audit table is a hard requirement here.
  audit.initAccessAuditTable();
});

afterEach(() => {
  dedup.closeDb();
  try {
    fs.unlinkSync(dbPath);
  } catch {
    /* ignore */
  }
});

function rawRow(kind: string, value: string) {
  return dedup
    .getDb()
    .prepare("SELECT kind, value, role, provider, subject, added_at, added_by FROM access_entries WHERE kind = ? AND value = ?")
    .get(kind, value) as
    | { kind: string; value: string; role: string; provider: string | null; subject: string | null; added_at: number; added_by: string | null }
    | undefined;
}

describe("listAccessEntries", () => {
  it("returns an empty list before anything is stored — the signal that the env list still applies", () => {
    expect(access.listAccessEntries()).toEqual([]);
  });

  it("orders by kind then value, so the page renders deterministically", () => {
    access.saveAccessEntries(
      [
        { kind: "address", value: "zoe@eudoxus.ai", role: "admin" },
        { kind: "domain", value: "eudoxus.ai", role: "user" },
        { kind: "address", value: "ada@eudoxus.ai", role: "user" },
      ],
      "ricardo@eudoxus.ai",
    );
    expect(access.listAccessEntries().map((e) => `${e.kind}:${e.value}`)).toEqual([
      "address:ada@eudoxus.ai",
      "address:zoe@eudoxus.ai",
      "domain:eudoxus.ai",
    ]);
  });

  it("narrows an unreadable row toward less access rather than more", () => {
    const now = Date.now();
    dedup
      .getDb()
      .prepare("INSERT INTO access_entries (kind, value, role, provider, subject, added_at, added_by) VALUES (?, ?, ?, NULL, NULL, ?, NULL)")
      .run("Domain", "eudoxus.ai", "Admin", now);

    const [entry] = access.listAccessEntries();
    // 'Domain' would have admitted everyone at the company; 'Admin' would have granted management.
    expect(entry.kind).toBe("address");
    expect(entry.role).toBe("user");
  });
});

describe("saveAccessEntries", () => {
  it("stores entries with their provenance and no binding", () => {
    access.saveAccessEntries([{ kind: "address", value: "ada@eudoxus.ai", role: "admin" }], "ricardo@eudoxus.ai");
    const [entry] = access.listAccessEntries();
    expect(entry).toMatchObject({
      kind: "address",
      value: "ada@eudoxus.ai",
      role: "admin",
      provider: null,
      subject: null,
      addedBy: "ricardo@eudoxus.ai",
    });
    expect(entry.addedAt).toBeGreaterThan(0);
  });

  it("trims and lowercases the value, so matching is case-insensitive", () => {
    access.saveAccessEntries([{ kind: "address", value: "  Ada@Eudoxus.AI  ", role: "admin" }], null);
    expect(access.listAccessEntries()[0].value).toBe("ada@eudoxus.ai");
  });

  it("removes entries absent from the next list", () => {
    access.saveAccessEntries(
      [
        { kind: "address", value: "ada@eudoxus.ai", role: "admin" },
        { kind: "address", value: "zoe@eudoxus.ai", role: "user" },
      ],
      null,
    );
    access.saveAccessEntries([{ kind: "address", value: "ada@eudoxus.ai", role: "admin" }], null);
    expect(access.listAccessEntries().map((e) => e.value)).toEqual(["ada@eudoxus.ai"]);
  });

  it("keeps a surviving entry's binding and provenance while updating its role", () => {
    // keeper carries the admin role throughout, so ada is free to start as a user.
    const keeper = { kind: "address" as const, value: "keeper@eudoxus.ai", role: "admin" as const };
    access.saveAccessEntries([{ kind: "address", value: "ada@eudoxus.ai", role: "user" }, keeper], "first@eudoxus.ai");
    access.bindAccessEntry("ada@eudoxus.ai", "google", "google|123");
    dedup.getDb().prepare("UPDATE access_entries SET added_at = ? WHERE value = ?").run(1000, "ada@eudoxus.ai");

    access.saveAccessEntries([{ kind: "address", value: "ada@eudoxus.ai", role: "admin" }, keeper], "second@eudoxus.ai");

    const row = rawRow("address", "ada@eudoxus.ai")!;
    expect(row.role).toBe("admin");
    // A save must not unbind or re-attribute someone who has already signed in.
    expect(row.provider).toBe("google");
    expect(row.subject).toBe("google|123");
    expect(row.added_at).toBe(1000);
    expect(row.added_by).toBe("first@eudoxus.ai");
  });

  it("refuses a domain carrying the admin role", () => {
    expect(() => access.saveAccessEntries([{ kind: "domain", value: "eudoxus.ai", role: "admin" }], null)).toThrow(
      /domain entry cannot carry the admin role/,
    );
  });

  it("refuses an entry that is empty once trimmed", () => {
    expect(() => access.saveAccessEntries([{ kind: "address", value: "   ", role: "user" }], null)).toThrow(
      /cannot be empty/,
    );
  });

  it("writes nothing at all when one entry in the batch is invalid", () => {
    access.saveAccessEntries([{ kind: "address", value: "ada@eudoxus.ai", role: "admin" }], null);
    expect(() =>
      access.saveAccessEntries(
        [
          { kind: "address", value: "zoe@eudoxus.ai", role: "user" },
          { kind: "domain", value: "eudoxus.ai", role: "admin" },
        ],
        null,
      ),
    ).toThrow();
    // Validation runs before the transaction, so the previous list is untouched.
    expect(access.listAccessEntries().map((e) => e.value)).toEqual(["ada@eudoxus.ai"]);
  });
});

describe("allowlistHasNoAdmin", () => {
  beforeEach(() => {
    delete process.env.OAUTH_ALLOWED_DOMAINS;
    delete process.env.OAUTH_ALLOWED_EMAILS;
  });

  it("reports a domain-only env seed, the shape .env.example ships", () => {
    process.env.OAUTH_ALLOWED_DOMAINS = "eudoxus.ai";
    expect(access.allowlistHasNoAdmin()).toBe(true);
  });

  it("is satisfied by one listed address, since env addresses are admins", () => {
    process.env.OAUTH_ALLOWED_DOMAINS = "eudoxus.ai";
    process.env.OAUTH_ALLOWED_EMAILS = "ada@eudoxus.ai";
    expect(access.allowlistHasNoAdmin()).toBe(false);
  });

  it("stays quiet for an empty list, which is a different misconfiguration", () => {
    // Nobody can sign in at all — pointing the operator at the admin role would misdirect them.
    expect(access.allowlistHasNoAdmin()).toBe(false);
  });

  it("stays quiet once a stored list is in force, which the last-admin guard keeps admin-bearing", () => {
    process.env.OAUTH_ALLOWED_DOMAINS = "eudoxus.ai";
    access.saveAccessEntries([{ kind: "address", value: "ada@eudoxus.ai", role: "admin" }], null);
    expect(access.allowlistHasNoAdmin()).toBe(false);
  });
});

describe("saveAccessEntries — the last-admin guard", () => {
  const ada = { provider: "google", sub: "google|123", email: "ada@eudoxus.ai" };

  it("refuses a save that would leave the stored list with no admin", () => {
    access.saveAccessEntries([{ kind: "address", value: "ada@eudoxus.ai", role: "admin" }], null);

    expect(() =>
      access.saveAccessEntries([{ kind: "domain", value: "eudoxus.ai", role: "user" }], null),
    ).toThrow(/nobody able to administer/);
    expect(access.listAccessEntries().map((e) => e.value)).toEqual(["ada@eudoxus.ai"]);
  });

  it("allows demoting yourself while another admin remains", () => {
    access.saveAccessEntries(
      [
        { kind: "address", value: "ada@eudoxus.ai", role: "admin" },
        { kind: "address", value: "cam@eudoxus.ai", role: "admin" },
      ],
      null,
    );

    access.saveAccessEntries(
      [
        { kind: "address", value: "ada@eudoxus.ai", role: "user" },
        { kind: "address", value: "cam@eudoxus.ai", role: "admin" },
      ],
      "ada@eudoxus.ai",
      { mustAdmit: ada },
    );

    const roles = Object.fromEntries(access.listAccessEntries().map((e) => [e.value, e.role]));
    expect(roles).toEqual({ "ada@eudoxus.ai": "user", "cam@eudoxus.ai": "admin" });
  });

  it("refuses emptying the list, so the handover to the database stays one-way", () => {
    access.saveAccessEntries([{ kind: "address", value: "ada@eudoxus.ai", role: "admin" }], null);

    // The self-lockout guard fires first: it evaluates the stored rows, which an empty save leaves
    // with nothing to match, regardless of what the environment would fall back to.
    expect(() => access.saveAccessEntries([], "ada@eudoxus.ai", { mustAdmit: ada })).toThrow(
      /remove your own access/,
    );
    expect(access.listAccessEntries()).toHaveLength(1);
  });
});

describe("bindAccessEntry", () => {
  it("records the provider identity an address resolved to", () => {
    access.saveAccessEntries([{ kind: "address", value: "ada@eudoxus.ai", role: "admin" }], null);
    access.bindAccessEntry("Ada@Eudoxus.ai", "google", "google|123");

    const row = rawRow("address", "ada@eudoxus.ai")!;
    expect(row.provider).toBe("google");
    expect(row.subject).toBe("google|123");
  });

  it("binds once — a later sign-in cannot re-point an entry at another subject", () => {
    access.saveAccessEntries([{ kind: "address", value: "ada@eudoxus.ai", role: "admin" }], null);
    access.bindAccessEntry("ada@eudoxus.ai", "google", "google|123");
    access.bindAccessEntry("ada@eudoxus.ai", "microsoft", "ms|999");

    const row = rawRow("address", "ada@eudoxus.ai")!;
    expect(row.provider).toBe("google");
    expect(row.subject).toBe("google|123");
  });

  it("ignores domain entries, which admit many identities and bind to none", () => {
    access.saveAccessEntries(
      [
        { kind: "domain", value: "eudoxus.ai", role: "user" },
        { kind: "address", value: "keeper@eudoxus.ai", role: "admin" },
      ],
      null,
    );
    access.bindAccessEntry("eudoxus.ai", "google", "google|123");

    const row = rawRow("domain", "eudoxus.ai")!;
    expect(row.provider).toBeNull();
    expect(row.subject).toBeNull();
  });

  // The three above assert on the stored row. Authorization reads the cache instead, so a binding
  // that reaches the database and not the cache passes all of them while doing nothing.
  it("takes effect against the live allowlist, without a refresh in between", () => {
    access.saveAccessEntries([{ kind: "address", value: "ada@eudoxus.ai", role: "admin" }], null);
    // Warms the cache with the entry still unbound, and pins the pre-bind behaviour. Skip it and
    // the assertion below passes vacuously, because a cold cache re-reads and sees the binding.
    expect(access.recheckIdentity({ provider: "google", sub: "google|123", email: "ada@eudoxus.ai" }).status).toBe("ok");

    access.bindAccessEntry("ada@eudoxus.ai", "google", "google|123");

    const reassigned = access.recheckIdentity({ provider: "microsoft", sub: "ms|999", email: "ada@eudoxus.ai" });
    expect(reassigned.status).toBe("denied");
  });

  it("keeps admitting the identity it bound to", () => {
    access.saveAccessEntries([{ kind: "address", value: "ada@eudoxus.ai", role: "admin" }], null);
    access.recheckIdentity({ provider: "google", sub: "google|123", email: "ada@eudoxus.ai" });
    access.bindAccessEntry("ada@eudoxus.ai", "google", "google|123");

    expect(access.recheckIdentity({ provider: "google", sub: "google|123", email: "ada@eudoxus.ai" }).status).toBe("ok");
  });
});

describe("parseAccessEntries", () => {
  const ok = (raw: unknown) => {
    const parsed = access.parseAccessEntries(raw);
    if (!parsed.ok) throw new Error(`expected accept, got: ${parsed.error}`);
    return parsed.entries;
  };
  const rejection = (raw: unknown) => {
    const parsed = access.parseAccessEntries(raw);
    return parsed.ok ? null : parsed.error;
  };

  it("accepts a well-formed list and normalizes each value", () => {
    expect(
      ok([
        { kind: "domain", value: " Eudoxus.AI ", role: "user" },
        { kind: "address", value: "Ada@Eudoxus.ai", role: "admin" },
      ]),
    ).toEqual([
      { kind: "domain", value: "eudoxus.ai", role: "user" },
      { kind: "address", value: "ada@eudoxus.ai", role: "admin" },
    ]);
  });

  it("accepts an empty list — clearing the stored list is a legitimate edit", () => {
    expect(ok([])).toEqual([]);
  });

  it("rejects anything that is not an array of objects", () => {
    expect(rejection(undefined)).toMatch(/must be an array/);
    expect(rejection("eudoxus.ai")).toMatch(/must be an array/);
    expect(rejection([null])).toMatch(/must be an object/);
  });

  it("rejects an unknown kind or role rather than coercing it", () => {
    expect(rejection([{ kind: "wildcard", value: "eudoxus.ai", role: "user" }])).toMatch(/kind must be/);
    expect(rejection([{ kind: "address", value: "ada@eudoxus.ai", role: "owner" }])).toMatch(/role must be/);
  });

  it("rejects a missing or blank value", () => {
    expect(rejection([{ kind: "address", role: "admin" }])).toMatch(/non-empty string/);
    expect(rejection([{ kind: "address", value: "   ", role: "admin" }])).toMatch(/non-empty string/);
  });

  it("rejects an address that is not an address, which would otherwise save and match nobody", () => {
    expect(rejection([{ kind: "address", value: "eudoxus.ai", role: "admin" }])).toMatch(/not an email address/);
    expect(rejection([{ kind: "address", value: "ada@localhost", role: "admin" }])).toMatch(/not an email address/);
  });

  it("rejects a domain that is not a domain, for the same reason", () => {
    expect(rejection([{ kind: "domain", value: "ada@eudoxus.ai", role: "user" }])).toMatch(/not a domain/);
    expect(rejection([{ kind: "domain", value: "localhost", role: "user" }])).toMatch(/not a domain/);
  });

  it("rejects a duplicate, including one that only collides after normalizing", () => {
    expect(
      rejection([
        { kind: "address", value: "ada@eudoxus.ai", role: "admin" },
        { kind: "address", value: "ADA@eudoxus.ai", role: "user" },
      ]),
    ).toMatch(/listed twice/);
  });

  it("allows the same value under both kinds, which are different entries", () => {
    // Nonsensical in practice, but they key differently and neither shadows the other.
    expect(ok([
      { kind: "domain", value: "eudoxus.ai", role: "user" },
      { kind: "address", value: "ada@eudoxus.ai", role: "admin" },
    ])).toHaveLength(2);
  });

  it("bounds the list, since it is scanned on every authenticated request", () => {
    const many = Array.from({ length: 201 }, (_, i) => ({
      kind: "address" as const,
      value: `user${i}@eudoxus.ai`,
      role: "user" as const,
    }));
    expect(rejection(many)).toMatch(/at most/);
    expect(access.parseAccessEntries(many.slice(0, 200)).ok).toBe(true);
  });
});

describe("matchAccessEntry", () => {
  const entry = (over: Partial<import("../access-entries.js").AccessEntry> = {}) => ({
    kind: "address" as const,
    value: "ada@eudoxus.ai",
    role: "admin" as const,
    provider: null as string | null,
    subject: null as string | null,
    addedAt: 0,
    addedBy: null as string | null,
    ...over,
  });

  const ada = { provider: "google", sub: "google|123", email: "ada@eudoxus.ai" };

  it("prefers an address over a domain, so the more specific grant carries the role", () => {
    const domain = entry({ kind: "domain", value: "eudoxus.ai", role: "user" });
    const address = entry({ value: "ada@eudoxus.ai", role: "admin" });
    expect(access.matchAccessEntry(ada, [domain, address])).toBe(address);
  });

  it("matches an unbound address on the email", () => {
    const address = entry();
    expect(access.matchAccessEntry(ada, [address])).toBe(address);
  });

  it("keeps matching a bound entry after the address changes — a rename does not cost the role", () => {
    const address = entry({ provider: "google", subject: "google|123" });
    const renamed = { provider: "google", sub: "google|123", email: "a.lovelace@eudoxus.ai" };
    expect(access.matchAccessEntry(renamed, [address])).toBe(address);
  });

  it("refuses a bound entry to a different subject, so a reassigned address inherits nothing", () => {
    const domain = entry({ kind: "domain", value: "eudoxus.ai", role: "user" });
    const address = entry({ provider: "google", subject: "google|123", role: "admin" });
    const newHolder = { provider: "google", sub: "google|999", email: "ada@eudoxus.ai" };

    // Falls through to ordinary domain admission rather than inheriting admin.
    expect(access.matchAccessEntry(newHolder, [domain, address])).toBe(domain);
  });

  it("does not match a bound entry through a second provider — the known cost of binding", () => {
    const address = entry({ provider: "google", subject: "google|123" });
    const viaMicrosoft = { provider: "microsoft", sub: "ms|123", email: "ada@eudoxus.ai" };
    expect(access.matchAccessEntry(viaMicrosoft, [address])).toBeNull();
  });

  it("returns null when nothing matches", () => {
    expect(access.matchAccessEntry({ provider: "google", sub: "x", email: "stranger@evil.com" }, [entry()])).toBeNull();
  });
});

describe("getEffectiveAllowlist", () => {
  beforeEach(() => {
    // An ambient value would otherwise decide these tests — the same leak that makes
    // the step suites fail inside a dev-run container.
    delete process.env.OAUTH_ALLOWED_DOMAINS;
    delete process.env.OAUTH_ALLOWED_EMAILS;
  });

  it("serves the env list while nothing is stored, admitting domains as user and addresses as admin", () => {
    process.env.OAUTH_ALLOWED_DOMAINS = "Eudoxus.AI, ";
    process.env.OAUTH_ALLOWED_EMAILS = " cameron@theaboutbox.com ,john@oolidata.ai";

    const effective = access.getEffectiveAllowlist()!;
    expect(effective.source).toBe("env");
    expect(effective.entries).toEqual([
      { kind: "domain", value: "eudoxus.ai", role: "user", provider: null, subject: null, addedAt: 0, addedBy: null },
      { kind: "address", value: "cameron@theaboutbox.com", role: "admin", provider: null, subject: null, addedAt: 0, addedBy: null },
      { kind: "address", value: "john@oolidata.ai", role: "admin", provider: null, subject: null, addedAt: 0, addedBy: null },
    ]);
  });

  it("denies everyone when neither the env nor the stored list has anything", () => {
    const effective = access.getEffectiveAllowlist()!;
    expect(effective.source).toBe("env");
    expect(effective.entries).toEqual([]);
  });

  it("applies a save without a manual refresh, so no caller has to remember one", () => {
    process.env.OAUTH_ALLOWED_DOMAINS = "eudoxus.ai";
    // Warm on the env list first; a cold cache would re-read and pass regardless of the save.
    expect(access.getEffectiveAllowlist()!.source).toBe("env");

    access.saveAccessEntries([{ kind: "address", value: "ada@eudoxus.ai", role: "admin" }], null);

    expect(access.getEffectiveAllowlist()!.source).toBe("db");
  });

  it("hands authority to the stored list once a row exists, ignoring the env from then on", () => {
    process.env.OAUTH_ALLOWED_DOMAINS = "eudoxus.ai";
    access.saveAccessEntries([{ kind: "address", value: "ada@eudoxus.ai", role: "admin" }], null);
    access.refreshEffectiveAllowlist();

    const effective = access.getEffectiveAllowlist()!;
    expect(effective.source).toBe("db");
    expect(effective.entries.map((e) => e.value)).toEqual(["ada@eudoxus.ai"]);
  });

  it("falls back to the env list if the stored list ceases to exist", () => {
    process.env.OAUTH_ALLOWED_DOMAINS = "eudoxus.ai";
    access.saveAccessEntries([{ kind: "address", value: "ada@eudoxus.ai", role: "admin" }], null);
    access.refreshEffectiveAllowlist();
    expect(access.getEffectiveAllowlist()!.source).toBe("db");

    // A restored-from-empty volume must fall back rather than lock everyone out.
    dedup.getDb().prepare("DELETE FROM access_entries").run();
    access.refreshEffectiveAllowlist();
    expect(access.getEffectiveAllowlist()!.source).toBe("env");
  });

  it("holds the list in memory, so the per-request check costs no query", () => {
    process.env.OAUTH_ALLOWED_DOMAINS = "eudoxus.ai";
    expect(access.getEffectiveAllowlist()!.source).toBe("env");

    // Inserted behind the module's back: every write it owns refreshes the cache itself, so only
    // a read that re-queries could observe this row.
    dedup
      .getDb()
      .prepare(
        "INSERT INTO access_entries (kind, value, role, provider, subject, added_at, added_by) VALUES ('address', 'ada@eudoxus.ai', 'admin', NULL, NULL, 0, NULL)",
      )
      .run();
    expect(access.getEffectiveAllowlist()!.source).toBe("env");

    access.refreshEffectiveAllowlist();
    expect(access.getEffectiveAllowlist()!.source).toBe("db");
  });

  it("keeps serving the last good list when a read fails", () => {
    process.env.OAUTH_ALLOWED_DOMAINS = "eudoxus.ai";
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(access.getEffectiveAllowlist()!.entries).toHaveLength(1);

    dedup.getDb().exec("DROP TABLE access_entries");
    access.refreshEffectiveAllowlist();

    // Nobody is ejected by a database problem.
    expect(access.getEffectiveAllowlist()!.entries).toHaveLength(1);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("re-reads after one poll interval, so a write from another process lands without a restart", () => {
    vi.useFakeTimers();
    try {
      process.env.OAUTH_ALLOWED_DOMAINS = "eudoxus.ai";
      expect(access.getEffectiveAllowlist()!.source).toBe("env");

      // Stands in for the recovery command: a write this process cannot be told about, so only
      // the age of the cached list can bring it into effect.
      dedup
        .getDb()
        .prepare(
          "INSERT INTO access_entries (kind, value, role, provider, subject, added_at, added_by) VALUES ('address', 'ada@eudoxus.ai', 'admin', NULL, NULL, 0, NULL)",
        )
        .run();
      expect(access.getEffectiveAllowlist()!.source).toBe("env");

      vi.advanceTimersByTime(60_000);
      expect(access.getEffectiveAllowlist()!.source).toBe("db");
    } finally {
      vi.useRealTimers();
    }
  });

  it("warns once per window while a read keeps failing, not on every request", () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      process.env.OAUTH_ALLOWED_DOMAINS = "eudoxus.ai";
      expect(access.getEffectiveAllowlist()!.entries).toHaveLength(1);
      dedup.getDb().exec("DROP TABLE access_entries");

      vi.advanceTimersByTime(60_000);
      access.getEffectiveAllowlist(); // the window elapsed: one failed read, one warning
      access.getEffectiveAllowlist(); // inside the new window: no read, no warning
      access.getEffectiveAllowlist();

      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      warn.mockRestore();
      vi.useRealTimers();
    }
  });

  it("returns null when a read fails with nothing cached, and recovers on a later call", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    dedup.getDb().exec("DROP TABLE access_entries");
    expect(access.getEffectiveAllowlist()).toBeNull();
    expect(error).toHaveBeenCalled();

    // The next call retries rather than staying disabled until a restart.
    access.initAccessEntriesTable();
    process.env.OAUTH_ALLOWED_DOMAINS = "eudoxus.ai";
    expect(access.getEffectiveAllowlist()!.source).toBe("env");
    error.mockRestore();
  });
});
