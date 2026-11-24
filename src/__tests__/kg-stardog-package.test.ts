import { it, expect, vi, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import type { ChildProcess, spawn } from "node:child_process";
import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { sendStardogPackage } from "../pipeline/steps/kg-stardog-package.js";
import { testDir } from "./helpers/test-dir.js";
afterEach(() => vi.unstubAllEnvs());
it("builds with the workspace venv and database, uploads bytes with manifest last, cleans up", async () => {
  vi.stubEnv("RUN_PROGRESS_TOKEN", "progress");
  const workspaceDir = testDir();
  let output = "";
  const spawnImpl = vi.fn((command, args, options) => {
    expect(command).toBe(join(workspaceDir, ".venv/bin/python"));
    expect(options.cwd).toBe(workspaceDir);
    output = args[4];
    expect(args).toEqual(["-m", "kg_ingest", "package", "--out", output, "--database", "db"]);
    mkdirSync(join(output, "data"));
    for (const name of ["kit.yaml", "ontology.ttl", "data/a.nt", "package.json"]) writeFileSync(join(output, name), Buffer.from([0, 255, 13, 10]));
    const child = new EventEmitter();
    queueMicrotask(() => child.emit("close", 0));
    return child as ChildProcess;
  }) as unknown as typeof spawn;
  const names: string[] = [];
  const fetchImpl = vi.fn(async (url, init) => {
    names.push(String(url));
    expect(init.headers.Authorization).toBe("Bearer progress");
    expect(Buffer.from(await init.body.arrayBuffer())).toEqual(Buffer.from([0, 255, 13, 10]));
    return new Response(null);
  }) as unknown as typeof fetch;
  await sendStardogPackage({ workspaceDir, kgStardogDb: "db", callbackUrl: "https://orch/", spawnImpl, fetchImpl });
  expect(names).toHaveLength(4);
  expect(names.at(-1)).toBe("https://orch/api/runner/kg-package/package.json");
  expect(existsSync(output)).toBe(false);
});
it("fails before spawning or sending without a database", async () => {
  const spawnImpl = vi.fn(); const fetchImpl = vi.fn();
  await expect(sendStardogPackage({ workspaceDir: "/workspace", spawnImpl, fetchImpl })).rejects.toThrow("kgStardogDb");
  expect(spawnImpl).not.toHaveBeenCalled(); expect(fetchImpl).not.toHaveBeenCalled();
});
it.each(["command", "upload"])("fails the run on %s failure", async failure => {
  vi.stubEnv("RUN_PROGRESS_TOKEN", "progress");
  const spawnImpl = vi.fn((_command, args) => {
    const output = args[4];
    mkdirSync(join(output, "data"));
    writeFileSync(join(output, "package.json"), "{}");
    const child = new EventEmitter();
    queueMicrotask(() => child.emit("close", failure === "command" ? 1 : 0));
    return child as ChildProcess;
  }) as unknown as typeof spawn;
  const fetchImpl = vi.fn(async () => new Response(null, { status: 500 }));
  await expect(sendStardogPackage({ workspaceDir: testDir(), kgStardogDb: "db", callbackUrl: "https://orch", spawnImpl, fetchImpl })).rejects.toThrow(failure === "command" ? "package failed" : "upload failed");
  if (failure === "command") expect(fetchImpl).not.toHaveBeenCalled();
});
