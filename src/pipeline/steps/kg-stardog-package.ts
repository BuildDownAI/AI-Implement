import { spawn } from "node:child_process";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { openAsBlob } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Build locally, then transfer the flat package, with its manifest as the final upload. */
export async function sendStardogPackage(input: {
  workspaceDir: string; kgStardogDb?: string; callbackUrl?: string;
  spawnImpl?: typeof spawn; fetchImpl?: typeof fetch;
}): Promise<void> {
  if (!input.kgStardogDb?.trim()) throw new Error("Stardog package requires kgStardogDb");
  const token = process.env.RUN_PROGRESS_TOKEN;
  if (!token || !input.callbackUrl) throw new Error("Stardog package requires callback URL and progress token");
  const dir = await mkdtemp(join(tmpdir(), "kg-package-"));
  try {
    await new Promise<void>((resolve, reject) => {
      const child = (input.spawnImpl ?? spawn)(join(input.workspaceDir, ".venv/bin/python"),
        ["-m", "kg_ingest", "package", "--out", dir, "--database", input.kgStardogDb!],
        { cwd: input.workspaceDir, stdio: ["ignore", "inherit", "inherit"] });
      child.once("error", reject);
      child.once("close", code => code === 0 ? resolve() : reject(new Error(`kg_ingest package failed: ${code}`)));
    });
    const names = (await readdir(dir)).filter(name => name !== "data" && name !== "package.json");
    for (const name of await readdir(join(dir, "data"))) names.push(`data/${name}`);
    names.sort();
    names.push("package.json");
    for (const name of names) {
      if (!/^(kit\.yaml|ontology\.ttl|package\.json|data\/[A-Za-z0-9._-]+\.nt)$/.test(name) || name.includes("..")) throw new Error(`Invalid package file: ${name}`);
      const response = await (input.fetchImpl ?? fetch)(`${input.callbackUrl.replace(/\/$/, "")}/api/runner/kg-package/${name}`, {
        method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/octet-stream" },
        body: await openAsBlob(join(dir, name)), signal: AbortSignal.timeout(120_000),
      });
      if (!response.ok) throw new Error(`Stardog package upload failed: ${name}: HTTP ${response.status}`);
      await response.body?.cancel();
    }
  } finally { await rm(dir, { recursive: true, force: true }); }
}
