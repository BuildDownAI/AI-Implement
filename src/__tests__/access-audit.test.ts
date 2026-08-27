import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// dedup.ts freezes its DB path at import time, so each test sets a unique DEDUP_DB_PATH and
// re-imports the modules fresh (the same isolation pattern the sibling suites use).
let audit: typeof import("../access-audit.js");
let access: typeof import("../access-entries.js");
let dedup: typeof import("../dedup.js");
let dbPath: string;

beforeEach(async () => {
  vi.resetModules();
  dbPath = path.join(os.tmpdir(), `access-audit-test-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`);
  process.env.DEDUP_DB_PATH = dbPath;
  audit = await import("../access-audit.js");
  access = await import("../access-entries.js");
  dedup = await import("../dedup.js");
  audit.initAccessAuditTable();
  access.initAccessEntriesTable();
});

afterEach(() => {
  dedup.closeDb();
  try {
    fs.unlinkSync(dbPath);
  } catch {
    /* ignore */
  }
});

describe("recordAccessChange", () => {
  it("stores both snapshots and the actor", () => {
    audit.recordAccessChange({
      actor: "ricardo@eudoxus.ai",
      action: "save",
      before: [{ kind: "domain", value: "eudoxus.ai", role: "user" }],
      after: [
        { kind: "domain", value: "eudoxus.ai", role: "user" },
        { kind: "address", value: "ada@eudoxus.ai", role: "admin" },
      ],
    });

    const [change] = audit.listAccessChanges();
    expect(change).toMatchObject({ actor: "ricardo@eudoxus.ai", action: "save" });
    expect(change.before).toHaveLength(1);
    expect(change.after).toHaveLength(2);
    expect(change.createdAt).toBeGreaterThan(0);
  });

  it("records an unattributable change as a null actor rather than inventing a person", () => {
    audit.recordAccessChange({ actor: null, action: "recover", before: [], after: [] });
    expect(audit.listAccessChanges()[0]).toMatchObject({ actor: null, action: "recover" });
  });

  it("stores only what an operator edits, never the binding or provenance", () => {
    // An AccessEntry is assignable to AccessEntryInput, so a caller can hand over the wide shape.
    const wide = [
      {
        kind: "address" as const,
        value: "ada@eudoxus.ai",
        role: "admin" as const,
        provider: "google",
        subject: "google|123",
        addedAt: 1700000000000,
        addedBy: "someone@eudoxus.ai",
      },
    ];
    audit.recordAccessChange({ actor: null, action: "save", before: [], after: wide });

    const raw = dedup.getDb().prepare("SELECT after_json FROM access_audit").get() as { after_json: string };
    expect(JSON.parse(raw.after_json)).toEqual([{ kind: "address", value: "ada@eudoxus.ai", role: "admin" }]);
  });
});

describe("listAccessChanges", () => {
  it("returns nothing before any change is made", () => {
    expect(audit.listAccessChanges()).toEqual([]);
  });

  it("orders newest first, breaking ties on id so same-millisecond writes stay ordered", () => {
    for (const value of ["first@eudoxus.ai", "second@eudoxus.ai", "third@eudoxus.ai"]) {
      audit.recordAccessChange({
        actor: null,
        action: "save",
        before: [],
        after: [{ kind: "address", value, role: "admin" }],
      });
    }
    expect(audit.listAccessChanges().map((c) => c.after[0].value)).toEqual([
      "third@eudoxus.ai",
      "second@eudoxus.ai",
      "first@eudoxus.ai",
    ]);
  });

  it("caps the number of rows returned", () => {
    for (let i = 0; i < 5; i++) {
      audit.recordAccessChange({ actor: null, action: "save", before: [], after: [] });
    }
    expect(audit.listAccessChanges(2)).toHaveLength(2);
  });

  it("keeps a row whose snapshot cannot be parsed — it is still evidence a change happened", () => {
    dedup
      .getDb()
      .prepare("INSERT INTO access_audit (created_at, actor, action, before_json, after_json) VALUES (?, ?, ?, ?, ?)")
      .run(Date.now(), "ada@eudoxus.ai", "save", "{not json", "[]");

    const [change] = audit.listAccessChanges();
    expect(change.actor).toBe("ada@eudoxus.ai");
    expect(change.before).toEqual([]);
  });

  it("narrows an unrecognised action to a save", () => {
    dedup
      .getDb()
      .prepare("INSERT INTO access_audit (created_at, actor, action, before_json, after_json) VALUES (?, ?, ?, ?, ?)")
      .run(Date.now(), null, "something-else", "[]", "[]");
    expect(audit.listAccessChanges()[0].action).toBe("save");
  });
});

describe("saveAccessEntries auditing", () => {
  it("records a row for every write, so no change to the list escapes the trail", () => {
    access.saveAccessEntries([{ kind: "address", value: "ada@eudoxus.ai", role: "admin" }], "ricardo@eudoxus.ai");
    access.saveAccessEntries([], "ricardo@eudoxus.ai");

    const changes = audit.listAccessChanges();
    expect(changes).toHaveLength(2);
    // Newest first: the removal, then the addition.
    expect(changes[0].before).toHaveLength(1);
    expect(changes[0].after).toEqual([]);
    expect(changes[1].before).toEqual([]);
    expect(changes[1].after).toEqual([{ kind: "address", value: "ada@eudoxus.ai", role: "admin" }]);
  });

  it("records nothing when the save is rejected", () => {
    expect(() => access.saveAccessEntries([{ kind: "domain", value: "eudoxus.ai", role: "admin" }], null)).toThrow();
    expect(audit.listAccessChanges()).toEqual([]);
  });

  it("does not record the binding of an entry that survives a save", () => {
    // keeper holds the admin role throughout, so ada is free to start as a user.
    const keeper = { kind: "address" as const, value: "keeper@eudoxus.ai", role: "admin" as const };
    access.saveAccessEntries([{ kind: "address", value: "ada@eudoxus.ai", role: "user" }, keeper], null);
    access.bindAccessEntry("ada@eudoxus.ai", "google", "google|123");
    access.saveAccessEntries([{ kind: "address", value: "ada@eudoxus.ai", role: "admin" }, keeper], null);

    const [latest] = audit.listAccessChanges();
    expect(latest.before).toEqual([{ kind: "address", value: "ada@eudoxus.ai", role: "user" }, keeper]);
    expect(latest.after).toEqual([{ kind: "address", value: "ada@eudoxus.ai", role: "admin" }, keeper]);
  });
});
