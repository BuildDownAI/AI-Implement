import { beforeAll, beforeEach, describe, expect, it, onTestFailed } from "vitest";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type Database from "better-sqlite3";
import { testDir } from "./test-dir.js";
import { testDb } from "./test-db.js";
import { fakeFetch, hangUntilAborted } from "./fake-fetch.js";

// Cleanup runs after a test ends, so each "is gone" check lives in the test after the one that
// created the directory. Tests in a file run in order unless marked concurrent, and none here is.

describe("testDir", () => {
  it("returns an empty directory under the OS temp directory, distinct on each call", () => {
    const first = testDir();
    const second = testDir();

    expect(statSync(first).isDirectory()).toBe(true);
    expect(readdirSync(first)).toEqual([]);
    expect(first.startsWith(join(tmpdir(), "ai-implement-test-"))).toBe(true);
    expect(second).not.toBe(first);
  });

  it("names the directory after the prefix", () => {
    expect(testDir("workflow-sync")).toContain(join(tmpdir(), "ai-implement-workflow-sync-"));
  });

  describe("removes the directory and its contents once the test finishes", () => {
    let created: string;

    it("creates a directory with nested files", () => {
      created = testDir();
      mkdirSync(join(created, "a", "b"), { recursive: true });
      writeFileSync(join(created, "a", "b", "file.txt"), "contents");
    });

    it("finds it gone in the next test", () => {
      expect(existsSync(created)).toBe(false);
    });
  });

  describe("removes the directory when the test fails", () => {
    let created: string;

    it.fails("creates a directory, then fails", () => {
      created = testDir();
      throw new Error("the test fails after creating its directory");
    });

    it("finds it gone in the next test", () => {
      expect(existsSync(created)).toBe(false);
    });
  });

  describe("from a beforeEach", () => {
    const fromHooks: string[] = [];

    beforeEach(() => {
      fromHooks.push(testDir());
    });

    it("gives the test its directory", () => {
      expect(existsSync(fromHooks[0])).toBe(true);
    });

    it("removed the previous test's directory and made a fresh one", () => {
      expect(existsSync(fromHooks[0])).toBe(false);
      expect(existsSync(fromHooks[1])).toBe(true);
    });
  });

  describe("from a beforeAll", () => {
    const prefix = `beforeall-${process.pid}-${Date.now()}`;
    let thrown: unknown;

    beforeAll(() => {
      try {
        testDir(prefix);
      } catch (err) {
        thrown = err;
      }
    });

    it("throws, and creates no directory", () => {
      expect(thrown).toBeInstanceOf(Error);
      expect((thrown as Error).message).toMatch(/inside a test/);
      expect(readdirSync(tmpdir()).filter((name) => name.startsWith(`ai-implement-${prefix}-`))).toEqual([]);
    });
  });
});

describe("testDb", () => {
  const tableNames = (db: Database.Database) =>
    (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>).map((r) => r.name);

  it("imports the requested modules after the reset, so they read the new database", async () => {
    const { path, modules } = await testDb({ modules: { dedup: () => import("../../dedup.js") } });

    expect(modules.dedup.getDb().name).toBe(path);
    expect(process.env.DEDUP_DB_PATH).toBe(path);
  });

  it("creates the tables boot creates", async () => {
    const { modules } = await testDb({ modules: { dedup: () => import("../../dedup.js") } });

    // One table from each end of initDbTables, plus one getDb() creates on open.
    expect(tableNames(modules.dedup.getDb())).toEqual(expect.arrayContaining(["mappings", "settings", "review_fix_evidence_tombstones", "dispatched"]));
  });

  it("with tables: \"none\", leaves the file unopened, and opening it creates only getDb()'s own tables", async () => {
    const { path, modules } = await testDb({ tables: "none", modules: { dedup: () => import("../../dedup.js") } });

    expect(existsSync(path)).toBe(false);
    const tables = tableNames(modules.dedup.getDb());
    expect(tables).toContain("dispatched");
    expect(tables).not.toContain("settings");
    expect(tables).not.toContain("mappings");
  });

  describe("gives each test its own empty database, and removes it after", () => {
    const previousPath = process.env.DEDUP_DB_PATH;
    let first: { path: string; handle: Database.Database };

    it("writes a row in the first test", async () => {
      const { path, modules } = await testDb({ modules: { log: () => import("../../log.js"), dedup: () => import("../../dedup.js") } });
      modules.log.appendLog({ issueId: "issue-1" });
      first = { path, handle: modules.dedup.getDb() };
      expect(modules.log.listLog()).toHaveLength(1);
    });

    it("finds an empty database at a new path, and the first one closed and gone", async () => {
      const { path, modules } = await testDb({ modules: { log: () => import("../../log.js") } });

      expect(path).not.toBe(first.path);
      expect(modules.log.listLog()).toEqual([]);
      expect(first.handle.open).toBe(false);
      expect(existsSync(dirname(first.path))).toBe(false);
    });

    it("restored DEDUP_DB_PATH after each test", () => {
      expect(process.env.DEDUP_DB_PATH).toBe(previousPath);
    });
  });

  describe("cleans up when the test fails", () => {
    let created: string;

    it.fails("opens a database, then fails", async () => {
      const { path, modules } = await testDb({ modules: { dedup: () => import("../../dedup.js") } });
      created = path;
      modules.dedup.getDb();
      throw new Error("the test fails after opening its database");
    });

    it("finds the directory gone in the next test", () => {
      expect(existsSync(dirname(created))).toBe(false);
    });
  });

  describe("reopen", () => {
    let reopenedHandle: Database.Database;

    it("restarts against the same file: the old handle closes and fresh modules see the earlier rows", async () => {
      const db = await testDb({ modules: { log: () => import("../../log.js"), dedup: () => import("../../dedup.js") } });
      db.modules.log.appendLog({ issueId: "before-restart" });
      const firstHandle = db.modules.dedup.getDb();

      const reopened = await db.reopen();

      expect(firstHandle.open).toBe(false);
      expect(reopened.log).not.toBe(db.modules.log);
      expect(reopened.dedup.getDb().name).toBe(db.path);
      expect(reopened.log.listLog().map((entry) => entry.issueId)).toEqual(["before-restart"]);
      reopenedHandle = reopened.dedup.getDb();
    });

    it("closed the reopened handle when the test finished", () => {
      expect(reopenedHandle.open).toBe(false);
    });
  });

  it("creates tables with the same init functions, in the same order, as main() at boot", () => {
    const source = (file: string) => readFileSync(join(import.meta.dirname, file), "utf8");
    // main() calls each as a bare statement; BOOT_TABLE_INITS calls each on its freshly imported module.
    const boot = [...source("../../index.ts").matchAll(/^\s*(init\w+Tables?)\(\);/gm)].map((m) => m[1]);
    const harness = [...source("test-db.ts").matchAll(/\.(init\w+Tables?)\(\)/g)].map((m) => m[1]);

    expect(boot, "The pattern found no init calls in src/index.ts; update it to match main()'s").not.toEqual([]);
    expect(
      harness,
      "BOOT_TABLE_INITS in test-db.ts must create the tables main() in src/index.ts creates; add or remove the call in both",
    ).toEqual(boot);
  });
});

describe("fakeFetch", () => {
  const API = "https://api.test";

  it("answers each route and records every request as a server would read it", async () => {
    const github = fakeFetch({
      "GET /repos/acme/app": { json: { default_branch: "main" } },
      "POST /repos/acme/app/pulls": { status: 201, json: { number: 7 } },
    });

    const repo = await github.fetch(`${API}/repos/acme/app?ref=main`);
    const pull = await github.fetch(`${API}/repos/acme/app/pulls`, {
      method: "POST",
      headers: { Authorization: "Bearer token" },
      body: JSON.stringify({ title: "Sync" }),
    });

    expect([repo.status, await repo.json()]).toEqual([200, { default_branch: "main" }]);
    expect([pull.status, await pull.json()]).toEqual([201, { number: 7 }]);
    expect(github.calls.map((c) => `${c.method} ${c.path}`)).toEqual(["GET /repos/acme/app", "POST /repos/acme/app/pulls"]);
    expect(github.calls[0].url.searchParams.get("ref")).toBe("main");
    expect(github.calls[1].headers.get("authorization")).toBe("Bearer token");
    expect(JSON.parse(github.calls[1].body)).toEqual({ title: "Sync" });
  });

  it("sends text and headers when the reply has no json", async () => {
    const api = fakeFetch({ "GET /check-runs": { status: 403, text: "unavailable", headers: { "x-reason": "scope" } } });

    const res = await api.fetch(`${API}/check-runs`);

    expect([res.status, res.ok, res.headers.get("x-reason"), await res.text()]).toEqual([403, false, "scope", "unavailable"]);
  });

  it("serves a list of replies in order, one per request", async () => {
    const api = fakeFetch({ "GET /issues": [{ json: { page: 1 } }, { json: { page: 2 } }] });

    const pages = [await (await api.fetch(`${API}/issues`)).json(), await (await api.fetch(`${API}/issues`)).json()];

    expect(pages).toEqual([{ page: 1 }, { page: 2 }]);
  });

  it("passes the request to a function reply, which can keep state between requests", async () => {
    const comments: unknown[] = [];
    const api = fakeFetch({
      "POST /issues/42/comments": (call) => {
        comments.push(JSON.parse(call.body));
        return { status: 201, json: { id: comments.length } };
      },
      "GET /issues/42/comments": () => new Response(JSON.stringify(comments), { headers: { "content-type": "application/json" } }),
    });

    await api.fetch(`${API}/issues/42/comments`, { method: "POST", body: JSON.stringify({ body: "first" }) });
    const listed = await (await api.fetch(`${API}/issues/42/comments?per_page=100`)).json();

    expect(listed).toEqual([{ body: "first" }]);
  });

  it("records the signal the caller passed, and none when it passed none", async () => {
    const api = fakeFetch({ "GET /ping": { text: "pong" } });
    const controller = new AbortController();

    await api.fetch(`${API}/ping`, { signal: controller.signal });
    await api.fetch(`${API}/ping`);

    expect(api.calls[0].signal).toBe(controller.signal);
    expect(api.calls[1].signal).toBeUndefined();
  });

  it("lets a function reply that throws reject the request like a network error, without failing the test", async () => {
    const api = fakeFetch({
      "GET /down": () => {
        throw new TypeError("fetch failed");
      },
    });

    await expect(api.fetch(`${API}/down`)).rejects.toThrow(new TypeError("fetch failed"));
    expect(api.calls).toHaveLength(1);
  });

  describe("hangUntilAborted", () => {
    it("rejects with the abort's reason once the caller aborts", async () => {
      const api = fakeFetch({ "POST /register": hangUntilAborted });
      const controller = new AbortController();
      const reason = new Error("deadline");

      const pending = api.fetch(`${API}/register`, { method: "POST", signal: controller.signal });
      await new Promise((resolve) => setTimeout(resolve, 5));
      controller.abort(reason);

      await expect(pending).rejects.toBe(reason);
    });

    it("rejects at once when the signal has already fired, with a timeout's own reason", async () => {
      const api = fakeFetch({ "GET /slow": hangUntilAborted });
      const signal = AbortSignal.timeout(1);
      await new Promise((resolve) => setTimeout(resolve, 20));

      await expect(api.fetch(`${API}/slow`, { signal })).rejects.toBe(signal.reason);
      expect((signal.reason as Error).name).toBe("TimeoutError");
    });

    it("stays pending when the caller passed no signal", async () => {
      const api = fakeFetch({ "GET /stall": hangUntilAborted });

      const outcome = await Promise.race([
        api.fetch(`${API}/stall`).then(
          () => "settled",
          () => "settled",
        ),
        new Promise((resolve) => setTimeout(() => resolve("pending"), 20)),
      ]);

      expect(outcome).toBe("pending");
    });
  });

  describe("a request with no route", () => {
    let errors: string[] = [];

    it.fails("throws to the caller and still fails the test when the caller swallows it", async () => {
      onTestFailed(({ task }) => {
        errors = (task.result?.errors ?? []).map((e) => e.message);
      });
      const api = fakeFetch({ "GET /repos/acme/app": { json: {} } });

      await expect(api.fetch(`${API}/repos/acme/app/pulls`, { method: "POST" })).rejects.toThrow(
        "fakeFetch: no route for POST /repos/acme/app/pulls",
      );
      await api.fetch(`${API}/repos/acme/app/pulls`, { method: "POST" }).catch(() => undefined);
      expect(api.calls).toHaveLength(2);
    });

    it("failed it with a message naming the method and path", () => {
      expect(errors).toEqual([
        "fakeFetch: no route for POST /repos/acme/app/pulls\nfakeFetch: no route for POST /repos/acme/app/pulls",
      ]);
    });
  });

  describe("more requests than a route's list of replies", () => {
    let errors: string[] = [];

    it.fails("fails the test", async () => {
      onTestFailed(({ task }) => {
        errors = (task.result?.errors ?? []).map((e) => e.message);
      });
      const api = fakeFetch({ "GET /issues": [{ json: { page: 1 } }] });

      await api.fetch(`${API}/issues`);
      await api.fetch(`${API}/issues`).catch(() => undefined);
    });

    it("failed it naming the route and the count", () => {
      expect(errors).toEqual(["fakeFetch: GET /issues was requested 2 times; its route has 1 replies"]);
    });
  });

  describe("install", () => {
    const original = globalThis.fetch;

    it("replaces the global fetch for the test", async () => {
      const api = fakeFetch({ "GET /ping": { text: "pong" } });
      api.install();

      expect(globalThis.fetch).toBe(api.fetch);
      expect(await (await fetch(`${API}/ping`)).text()).toBe("pong");
    });

    it("restored the global fetch when the test finished", () => {
      expect(globalThis.fetch).toBe(original);
    });
  });
});
