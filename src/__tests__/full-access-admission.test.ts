import { constants, mkdtempSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { checkFullAccessAdmission, CodexFullAccessRefusedError } from "../pipeline/full-access-admission.js";

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true });
});
const fixture = (mode?: number): string => {
  const dir = mkdtempSync(join(tmpdir(), "socket-fixture-"));
  dirs.push(dir);
  const path = join(dir, "docker.sock");
  if (mode !== undefined) {
    writeFileSync(path, "");
    chmodSync(path, mode);
  }
  return path;
};
const nonRootUid = typeof process.geteuid === "function" && process.geteuid() !== 0 ? process.geteuid() : 1000;
const isRoot = typeof process.geteuid === "function" && process.geteuid() === 0;

describe("checkFullAccessAdmission", () => {
  it("admits a non-root user whose Docker socket is absent", () => {
    const report = checkFullAccessAdmission({ uid: () => nonRootUid, socketPaths: [fixture()] });
    expect(report).toEqual({ nonRoot: true, socketPresent: false, socketReadable: false, socketWritable: false, admitted: true });
  });

  it("admits a socket that exists but the model user cannot read or write", () => {
    const report = checkFullAccessAdmission({
      uid: () => nonRootUid,
      socketPaths: ["/x/docker.sock"],
      exists: () => true,
      canAccess: () => false,
    });
    expect(report).toMatchObject({ socketPresent: true, socketReadable: false, socketWritable: false, admitted: true });
  });

  it("refuses root and an unknown uid", () => {
    expect(checkFullAccessAdmission({ uid: () => 0, socketPaths: [fixture()] })).toMatchObject({ nonRoot: false, admitted: false });
    expect(checkFullAccessAdmission({ uid: () => undefined, socketPaths: [fixture()] })).toMatchObject({ nonRoot: false, admitted: false });
  });

  it("refuses a readable or a writable socket (per-mode fake)", () => {
    const only = (m: number) => (_p: string, mode: number) => mode === m;
    expect(checkFullAccessAdmission({ uid: () => nonRootUid, socketPaths: ["/s"], exists: () => true, canAccess: only(constants.R_OK) }))
      .toMatchObject({ socketReadable: true, socketWritable: false, admitted: false });
    expect(checkFullAccessAdmission({ uid: () => nonRootUid, socketPaths: ["/s"], exists: () => true, canAccess: only(constants.W_OK) }))
      .toMatchObject({ socketReadable: false, socketWritable: true, admitted: false });
  });

  // Real filesystem access checks against owned canary files; root bypasses mode bits, so these assert only when non-root.
  it.skipIf(isRoot)("uses real access(2) on an owned fixture: 0o600 is denied, 0o000 is allowed", () => {
    const open = checkFullAccessAdmission({ socketPaths: [fixture(0o600)] });
    expect(open).toMatchObject({ socketPresent: true, socketReadable: true, socketWritable: true, admitted: false });
    const closed = checkFullAccessAdmission({ socketPaths: [fixture(0o000)] });
    expect(closed).toMatchObject({ socketPresent: true, socketReadable: false, socketWritable: false, admitted: true });
  });

  it("the refusal error carries only booleans", () => {
    const err = new CodexFullAccessRefusedError({ nonRoot: true, socketPresent: true, socketReadable: true, socketWritable: false, admitted: false });
    expect(err.code).toBe("CODEX_FULL_ACCESS_REFUSED");
    expect(err.message).toMatch(/^[\w =.,:'-]+$/);
  });
});
