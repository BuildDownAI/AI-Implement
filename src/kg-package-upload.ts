import type { IncomingMessage, ServerResponse } from "node:http";
import { mkdir, readdir, stat, open, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { verifyRunToken } from "./runner-tokens.js";

const locks = new Map<string, Promise<void>>();
const FILE_LIMIT = 64 * 1024 * 1024;
const FOLDER_LIMIT = 128 * 1024 * 1024;

/** Raw request URL is intentional: URL normalization must not hide traversal. */
export async function handleKgPackageUpload(req: IncomingMessage, res: ServerResponse, input: {
  secret: string; baseMode: boolean; dataRoot: string;
}): Promise<void> {
  const reply = (status: number) => { res.writeHead(status); res.end(); };
  const bearer = /^Bearer\s+(\S+)$/i.exec(req.headers.authorization ?? "")?.[1];
  const verified = bearer && input.secret ? verifyRunToken(bearer, input.secret, "progress", { consume: false }) : undefined;
  if (!input.baseMode || !verified?.ok || verified.claims.phase !== "kg-refresh") { reply(403); return; }
  const name = (req.url ?? "").slice("/api/runner/kg-package/".length);
  if (!/^(kit\.yaml|ontology\.ttl|package\.json|data\/[A-Za-z0-9._-]+\.nt)$/.test(name) || name.includes("..")) { reply(400); return; }
  const dispatchId = verified.claims.dispatchId;
  if (!/^[A-Za-z0-9_-]+$/.test(dispatchId)) { reply(403); return; }
  const dir = join(input.dataRoot, "stardog", dispatchId);
  const previous = locks.get(dir) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>(resolve => { release = resolve; });
  locks.set(dir, current);
  await previous;
  let temporary: string | undefined;
  try {
    await mkdir(join(dir, "data"), { recursive: true });
    let total = 0;
    for (const entry of await readdir(dir, { recursive: true, withFileTypes: true })) {
      if (entry.isFile()) total += (await stat(join(entry.parentPath, entry.name))).size;
    }
    const target = join(dir, name);
    const oldSize = await stat(target).then(s => s.size, (err: NodeJS.ErrnoException) => { if (err.code === "ENOENT") return 0; throw err; });
    temporary = join(dir, `.upload-${randomUUID()}`);
    const file = await open(temporary, "wx");
    let bytes = 0;
    let overflow = false;
    try {
      // Do not destroy the request on overflow: the caller must receive the 413.
      for await (const chunk of req.iterator({ destroyOnReturn: false })) {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        bytes += buffer.length;
        if (bytes > FILE_LIMIT || total - oldSize + bytes > FOLDER_LIMIT) { overflow = true; break; }
        await file.writeFile(buffer);
      }
    } finally { await file.close(); }
    if (overflow) {
      await rm(temporary, { force: true });
      temporary = undefined;
      req.resume(); reply(413); return;
    }
    await rename(temporary, target);
    temporary = undefined;
    console.log(`[kg-package] dispatchId=${dispatchId} name=${name} bytes=${bytes}`);
    reply(200);
  } catch (err) {
    console.error("[kg-package] Upload failed", err);
    if (!res.headersSent) reply(500);
  } finally {
    try { if (temporary) await rm(temporary, { force: true }); }
    finally {
      release();
      if (locks.get(dir) === current) locks.delete(dir);
    }
  }
}
