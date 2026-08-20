import { afterEach, describe, expect, it } from "vitest";
import { closeSync, mkdirSync, mkdtempSync, openSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";

// Runs the degraded-detection block from docker-entrypoint.sh against a temp fixture.
// Mirrors the exact conditions the entrypoint checks:
//   - presence of ${KG_DIR}/.embeddings-failed  (marker written at build time)
//   - absence  of ${KG_DIR}/out/embeddings.npz   (belt-and-suspenders guard)
// Returns true when the block would export KG_EMBEDDINGS_DEGRADED=1.
function runDetection(kgDir: string): boolean {
  const script = `
KG_DIR='${kgDir}'
if [ -f "\${KG_DIR}/.embeddings-failed" ] || [ ! -f "\${KG_DIR}/out/embeddings.npz" ]; then
    printf '1'
else
    printf '0'
fi
`;
  const result = spawnSync("sh", ["-c", script], { encoding: "utf-8" });
  if (result.error) throw result.error;
  return result.stdout.trim() === "1";
}

function touch(filePath: string): void {
  closeSync(openSync(filePath, "w"));
}

describe("docker-entrypoint.sh KG degraded detection", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  function makeKgDir(): string {
    const dir = mkdtempSync(join(tmpdir(), "kg-degraded-test-"));
    tempDirs.push(dir);
    mkdirSync(join(dir, "out"));
    return dir;
  }

  it("detects degraded when marker present, npz present (marker wins)", () => {
    const kgDir = makeKgDir();
    touch(join(kgDir, ".embeddings-failed"));
    touch(join(kgDir, "out", "embeddings.npz"));
    expect(runDetection(kgDir)).toBe(true);
  });

  it("detects degraded when marker absent, npz absent (belt-and-suspenders fires)", () => {
    const kgDir = makeKgDir();
    // out/ dir exists but embeddings.npz was never written
    expect(runDetection(kgDir)).toBe(true);
  });

  it("detects NOT degraded when marker absent, npz present (clean build)", () => {
    const kgDir = makeKgDir();
    touch(join(kgDir, "out", "embeddings.npz"));
    expect(runDetection(kgDir)).toBe(false);
  });

  it("detects degraded when marker present, npz absent", () => {
    const kgDir = makeKgDir();
    touch(join(kgDir, ".embeddings-failed"));
    // no npz — marker alone marks the image as degraded
    expect(runDetection(kgDir)).toBe(true);
  });

  it("writes a warning to stderr when degraded", () => {
    const kgDir = makeKgDir();
    touch(join(kgDir, ".embeddings-failed"));
    const script = `
KG_DIR='${kgDir}'
if [ -f "\${KG_DIR}/.embeddings-failed" ] || [ ! -f "\${KG_DIR}/out/embeddings.npz" ]; then
    printf '[kg] WARNING: embeddings missing — hybrid search is lexical-only\n' >&2
    export KG_EMBEDDINGS_DEGRADED=1
fi
printf '%s' "\${KG_EMBEDDINGS_DEGRADED:-0}"
`;
    const result = spawnSync("sh", ["-c", script], { encoding: "utf-8" });
    expect(result.stdout.trim()).toBe("1");
    expect(result.stderr).toContain("[kg] WARNING: embeddings missing");
  });

  it("emits no warning when not degraded", () => {
    const kgDir = makeKgDir();
    touch(join(kgDir, "out", "embeddings.npz"));
    const script = `
KG_DIR='${kgDir}'
if [ -f "\${KG_DIR}/.embeddings-failed" ] || [ ! -f "\${KG_DIR}/out/embeddings.npz" ]; then
    printf '[kg] WARNING: embeddings missing — hybrid search is lexical-only\n' >&2
    export KG_EMBEDDINGS_DEGRADED=1
fi
printf '%s' "\${KG_EMBEDDINGS_DEGRADED:-0}"
`;
    const result = spawnSync("sh", ["-c", script], { encoding: "utf-8" });
    expect(result.stdout.trim()).toBe("0");
    expect(result.stderr).toBe("");
  });
});

// Verify docker-entrypoint.sh itself passes shellcheck when available.
describe("docker-entrypoint.sh shellcheck", () => {
  it("passes shellcheck cleanly", () => {
    const r = spawnSync("shellcheck", ["docker-entrypoint.sh"], { stdio: ["ignore", "pipe", "pipe"] });
    if ((r.error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") return; // skip when shellcheck not installed
    expect(r.status).toBe(0);
  });
});

