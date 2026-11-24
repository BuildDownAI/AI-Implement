import { it, expect, onTestFinished } from "vitest";
import { createServer, request } from "node:http";
import { once } from "node:events";
import { mkdirSync, writeFileSync, truncateSync, readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { testDir } from "./helpers/test-dir.js";
import { testDb } from "./helpers/test-db.js";

async function fixture(baseMode = true, phase: "kg-refresh" | "implementation" = "kg-refresh") {
  const { modules } = await testDb({ modules: {
    tokens: () => import("../runner-tokens.js"), upload: () => import("../kg-package-upload.js"),
  } });
  const dataRoot = testDir();
  const { token, dispatchId } = modules.tokens.mintRunToken({ issueId: "kg-refresh", mappingTeamKey: "KG", phase, audience: "progress", secret: "test-secret", ttlSeconds: 3600 });
  const server = createServer((req, res) => { void modules.upload.handleKgPackageUpload(req, res, { secret: "test-secret", baseMode, dataRoot }); });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  onTestFinished(() => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("missing server");
  const upload = (name: string, chunks: Buffer[] = [Buffer.from([0, 255, 13, 10])], credential = token) => new Promise<number>((resolve, reject) => {
    const req = request({ hostname: "127.0.0.1", port: address.port, path: `/api/runner/kg-package/${name}`, method: "POST", headers: { Authorization: `Bearer ${credential}` } }, res => {
      res.resume(); res.on("end", () => resolve(res.statusCode!));
    });
    req.on("error", reject);
    void (async () => { for (const chunk of chunks) { if (!req.write(chunk)) await once(req, "drain"); } req.end(); })().catch(reject);
  });
  return { upload, dir: join(dataRoot, "stardog", dispatchId), dataRoot };
}
it("stores binary bytes and replaces files with reusable credentials", async () => {
  const { upload, dir } = await fixture();
  expect(await upload("data/a.nt")).toBe(200);
  expect(readFileSync(join(dir, "data/a.nt"))).toEqual(Buffer.from([0, 255, 13, 10]));
  expect(await upload("data/a.nt", [Buffer.from("replacement")])).toBe(200);
  expect(readFileSync(join(dir, "data/a.nt"), "utf8")).toBe("replacement");
});
it.each(["../x", "data/../../x", "/etc/x", "data/a/b.nt", "other.txt", "data/a..b.nt"])("rejects raw name %s without writing", async name => {
  const { upload, dataRoot } = await fixture();
  expect(await upload(name)).toBe(400);
  expect(readdirSync(dataRoot)).toEqual([]);
});
it.each(["customer", "implementation", "invalid", "missing"])("rejects %s credentials or mode before writes", async kind => {
  const { upload, dataRoot } = await fixture(kind !== "customer", kind === "implementation" ? "implementation" : "kg-refresh");
  expect(await upload("kit.yaml", [], kind === "invalid" ? "invalid" : kind === "missing" ? "" : undefined)).toBe(403);
  expect(readdirSync(dataRoot)).toEqual([]);
});
it("enforces exact file and folder limits and preserves replacements on overflow", async () => {
  const { upload, dir } = await fixture();
  const mib = Buffer.alloc(1024 * 1024, 97);
  expect(await upload("data/a.nt", Array(64).fill(mib))).toBe(200);
  expect(await upload("data/a.nt", [...Array(64).fill(mib), Buffer.from("x")])).toBe(413);
  expect(readFileSync(join(dir, "data/a.nt")).length).toBe(64 * 1024 * 1024);
  mkdirSync(join(dir, "data"), { recursive: true });
  writeFileSync(join(dir, "data/b.nt"), "");
  truncateSync(join(dir, "data/b.nt"), 64 * 1024 * 1024 - 1);
  expect(await upload("kit.yaml", [Buffer.from("x")])).toBe(200);
  expect(await upload("ontology.ttl", [Buffer.from("x")])).toBe(413);
  expect(existsSync(join(dir, "ontology.ttl"))).toBe(false);
  expect(readdirSync(dir).filter(name => name.startsWith(".upload"))).toEqual([]);
  expect(await upload("kit.yaml", [Buffer.from("y")])).toBe(200);
});
it("serializes concurrent uploads against the dispatch folder quota", async () => {
  const { upload, dir } = await fixture();
  mkdirSync(join(dir, "data"), { recursive: true });
  writeFileSync(join(dir, "data/existing.nt"), "");
  truncateSync(join(dir, "data/existing.nt"), 128 * 1024 * 1024 - 1);
  const statuses = await Promise.all([upload("kit.yaml", [Buffer.from("a")]), upload("ontology.ttl", [Buffer.from("b")])]);
  expect(statuses.sort()).toEqual([200, 413]);
  expect(readdirSync(dir).filter(name => name.startsWith(".upload"))).toEqual([]);
});
