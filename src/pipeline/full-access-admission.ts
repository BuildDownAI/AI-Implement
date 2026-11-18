import { accessSync, constants } from "node:fs";

/**
 * Pre-spawn admission for Codex implementation full access (AII-1437). Full access trusts the disposable GHA job as
 * the isolation boundary, so it is refused when the model user is root or can read or write the host Docker socket
 * that GitHub mounts into container jobs (the socket merely existing is normal and allowed). Reports booleans only:
 * no uid, group, path or Docker inventory leaves this function.
 */
export const HOST_DOCKER_SOCKET_PATHS = ["/var/run/docker.sock", "/run/docker.sock"] as const;

export interface FullAccessAdmissionReport {
  readonly nonRoot: boolean;
  readonly socketPresent: boolean;
  readonly socketReadable: boolean;
  readonly socketWritable: boolean;
  readonly admitted: boolean;
}

export interface FullAccessAdmissionDeps {
  /** Effective uid of the process that will spawn the model; undefined where the platform has none. */
  uid?: () => number | undefined;
  /** True when `mode` (fs.constants R_OK / W_OK) access to the path succeeds as the current user. */
  canAccess?: (path: string, mode: number) => boolean;
  /** True when the path exists, regardless of permissions. */
  exists?: (path: string) => boolean;
  socketPaths?: readonly string[];
}

const defaultUid = (): number | undefined => (typeof process.geteuid === "function" ? process.geteuid() : undefined);
const defaultCanAccess = (path: string, mode: number): boolean => {
  try {
    accessSync(path, mode);
    return true;
  } catch {
    return false;
  }
};
const defaultExists = (path: string): boolean => defaultCanAccess(path, constants.F_OK);

export function checkFullAccessAdmission(deps: FullAccessAdmissionDeps = {}): FullAccessAdmissionReport {
  const uid = (deps.uid ?? defaultUid)();
  const canAccess = deps.canAccess ?? defaultCanAccess;
  const exists = deps.exists ?? defaultExists;
  const paths = deps.socketPaths ?? HOST_DOCKER_SOCKET_PATHS;
  // An unknown uid cannot be proven non-root, so it fails closed.
  const nonRoot = uid !== undefined && uid !== 0;
  const socketPresent = paths.some((p) => exists(p));
  const socketReadable = paths.some((p) => canAccess(p, constants.R_OK));
  const socketWritable = paths.some((p) => canAccess(p, constants.W_OK));
  return { nonRoot, socketPresent, socketReadable, socketWritable, admitted: nonRoot && !socketReadable && !socketWritable };
}

export class CodexFullAccessRefusedError extends Error {
  readonly code = "CODEX_FULL_ACCESS_REFUSED";
  readonly report: FullAccessAdmissionReport;
  constructor(report: FullAccessAdmissionReport) {
    super(
      `Codex implementation full access refused before spawn: nonRoot=${report.nonRoot} dockerSocketPresent=${report.socketPresent} `
        + `dockerSocketReadable=${report.socketReadable} dockerSocketWritable=${report.socketWritable}`,
    );
    this.name = "CodexFullAccessRefusedError";
    this.report = report;
  }
}
