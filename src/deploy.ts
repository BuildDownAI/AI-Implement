import { execFile as nodeExecFile } from "node:child_process";
import { promisify } from "node:util";
import crypto from "node:crypto";
import { chmod, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { clearDeployHold, isDeployHeld, setDeployHold } from "./deploy-hold.js";
import { getScopedInstallationToken } from "./github-app-auth.js";
import { fetchRepoTarball, getBranchSha } from "./github.js";
import { getInFlightWork } from "./in-flight-work.js";
import type { SelfDeployTarget } from "./deploy-availability.js";

/**
 * What a /mcp probe says about a freshly released version.
*
* - 401 is success: alive and OAuth-gated.
* - 503 means /mcp is not serving, from either an absent KG sidecar or an unset OAUTH_REDIRECT_BASE_URL
* (the status alone cannot tell them apart) so the body is carried through rather than parsed.
*/
export type McpProbe =
| { serving: true }
| { serving: false; reason: "mcp-unavailable"; detail: string }
| { serving: false; reason: "not-responding"; status: number };

export interface DeployArgsInput {
  app: string;
  kgToken: string;
  sourceCommit: string;
  sourceRepo: string;
  sourceBranch: string;
}

export interface RunDeployInput {
  app: string;
  flyDeployToken: string;
  owner: string;
  repo: string;
  branch: string;
  /** The commit to deploy — resolved by the caller, not the branch tip. */
  commit: string;
  githubAppId: string;
  githubAppPrivateKey: string;
  pollIntervalMs: number;
}

const execFile = promisify(nodeExecFile);

// flyctl is fetched per deploy rather than baked into the image:
// it is 108 MB extracted, and /data is a 1 GB volume that belongs to the database.
const FLYCTL_VERSION = "0.4.82";
const FLYCTL_SHA256: Record<string, string> = {
  x86_64: "154d2f12bc267dee9bd4152702b436aef5889a350972631f636124175dd7117c",
  arm64: "6501e1990200c83ed75fd7a00884b5c7f9a3ce180217f98ba2b8f3f3604e11f4",
};
// Only the tail of flyctl's output is kept: flyctl's errors land at the end, the head is apt output.
const FLYCTL_LOG_TAIL_BYTES = 64 * 1024;

// The KG repository the image clones at build time. The Dockerfile holds the other
// copy of this; the two must agree or the scoped token cannot read it and the build
// fail-softs to a sidecar-less image.
const KG_OWNER = "BuildDownAI";
const KG_REPO = "knowledge-graph-ai-implement";

const DEPLOY_TIMEOUT_MS = 20 * 60 * 1000;
// A runner job is force-terminated 60 minutes after its dispatch,
// so with new dispatches paused the in-flight set always drains.
// this bounds a monitor that has itself stopped working, not the normal case.
const DRAIN_TIMEOUT_MS = 75 * 60 * 1000;

/**
 * Builds and releases a new version of this orchestrator.
*
* On success this never returns: the release replaces the machine, so the process is
* SIGTERMed inside the flyctl await and no catch or finally runs. The hold is
* therefore released at boot, not here. Only a failure — which happens before the
* machine is touched — comes back to this function.
*/
export async function runDeploy(input: RunDeployInput): Promise<void> {
  const { app, flyDeployToken, owner, repo, branch, commit, githubAppId, githubAppPrivateKey, pollIntervalMs } = input;
  
  setDeployHold();
  try {
    // Setting the hold above is what makes this terminate: new dispatches have stopped,
    // so the in-flight set only shrinks from here.
    await waitForQuiet(DRAIN_TIMEOUT_MS, drainPollMs(pollIntervalMs));
    
    const scratch = await deployScratch();
    const flyctl = await resolveFlyctl(scratch);
    
    const source = await getScopedInstallationToken(githubAppId, githubAppPrivateKey, owner, {
      permissions: { contents: "read" },
      repositories: [repo],
    });
    const context = await extractSource(
      await fetchRepoTarball(source.token, owner, repo, commit),
      scratch,
    );
    
    const kg = await getScopedInstallationToken(githubAppId, githubAppPrivateKey, KG_OWNER, {
      permissions: { contents: "read" },
      repositories: [KG_REPO],
    });
    
    console.log(`[deploy] deploying ${owner}/${repo}@${commit.slice(0, 7)} to ${app}`);
    await runFlyctl(
      flyctl,
      deployArgs({
        app,
        kgToken: kg.token,
        sourceCommit: commit,
        sourceRepo: `${owner}/${repo}`,
        sourceBranch: branch,
      }),
      {
        cwd: context,
        // A deliberate allowlist, not process.env: the orchestrator's environment
        // holds every credential it has, and none of them belong in a build.
        env: { PATH: process.env.PATH ?? "", HOME: scratch, FLY_API_TOKEN: flyDeployToken },
        timeoutMs: DEPLOY_TIMEOUT_MS,
      },
    );
  } catch (err) {
    clearDeployHold();
    throw err;
  }
}

/** Holds until nothing is executing. Logs only when the blocking set changes. */
async function waitForQuiet(timeoutMs: number, pollMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let reported = "";

  for (;;) {
    const blocking = getInFlightWork();
    if (blocking.length === 0) return;

    const summary = blocking.map((w) => `${w.count} ${w.kind}`).join(", ");
    if (summary !== reported) {
      console.log(`[deploy] waiting for work to drain — ${summary}`);
      reported = summary;
    }

    if (Date.now() >= deadline) {
      throw new Error(`[deploy] work did not drain within ${Math.round(timeoutMs / 60000)}m — ${summary}`);
    }
    await sleep(pollMs);
  }
}

/**
 * How often to re-check the in-flight set. The set is mutated by the poll loop, so
 * checking faster than it runs observes nothing new; half an interval bounds how long
 * a drain sits on stale state. The floor protects a very short configured interval.
 */
export function drainPollMs(pollIntervalMs: number): number {
  return Math.max(5_000, Math.floor(pollIntervalMs / 2));
}

/**
 * Runs flyctl, keeping a bounded tail of its output and logging it only on failure.
*
* spawn rather than execFile (the shape local-docker uses) because a --no-cache build
* far exceeds execFile's 1 MB buffer, which kills the child with ENOBUFS mid-build.
*/
function runFlyctl(
  binary: string,
  args: string[],
  opts: { cwd: string; env: NodeJS.ProcessEnv; timeoutMs: number },
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, { cwd: opts.cwd, env: opts.env, stdio: ["ignore", "pipe", "pipe"] });
    
    // Chunks with a running total, not string concat: re-slicing a 64 KB string on
    // every chunk would allocate hundreds of megabytes across one build.
    const chunks: string[] = [];
    let size = 0;
    const capture = (d: Buffer) => {
      const s = d.toString();
      chunks.push(s);
      size += s.length;
      while (size > FLYCTL_LOG_TAIL_BYTES && chunks.length > 1) size -= chunks.shift()!.length;
    };
    child.stdout.on("data", capture);
    child.stderr.on("data", capture);
    
    const fail = (message: string) => {
      if (chunks.length) console.error(`[deploy] flyctl output (tail):\n${chunks.join("")}`);
      reject(new Error(message));
    };
    
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      fail(`[deploy] flyctl timed out after ${Math.round(opts.timeoutMs / 60000)}m`);
    }, opts.timeoutMs);
    timer.unref();
    
    child.on("error", (err) => { clearTimeout(timer); fail(`[deploy] flyctl failed to start: ${err.message}`); });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else fail(`[deploy] flyctl exited ${code}`);
    });
  });
}

/** Pure. `status` is 0 when the request itself failed (refused, timed out). */
export function interpretMcpProbe(status: number, body = ""): McpProbe {
  if (status === 401) return { serving: true };
  if (status === 503) return { serving: false, reason: "mcp-unavailable", detail: body };
  return { serving: false, reason: "not-responding", status };
}

export function deployArgs(input: DeployArgsInput): string[] {
  // An empty value is the failure this function exists to prevent: an empty build
  // secret fail-softs to a sidecar-less image, and an empty stamp leaves the next
  // version unable to tell what it is running. Fail before flyctl is invoked.
  for (const [key, value] of Object.entries(input)) {
    if (!value) throw new Error(`[deploy] refusing to deploy with an empty ${key}`);
  }
  
  return [
    "deploy",
    "--remote-only",
    "--no-cache",
    // --build-secret takes only NAME=VALUE, so the token rides in argv; execFile runs flyctl without a shell.
    "--build-secret", `kg_token=${input.kgToken}`,
    "--build-arg", `SOURCE_COMMIT=${input.sourceCommit}`,
    "--build-arg", `SOURCE_REPO=${input.sourceRepo}`,
    "--build-arg", `SOURCE_BRANCH=${input.sourceBranch}`,
    "--app", input.app,
  ];
}

/** flyctl's release assets use `x86_64` where Node reports `x64`. */
export function flyctlArch(nodeArch: string = process.arch): "x86_64" | "arm64" {
  if (nodeArch === "x64") return "x86_64";
  if (nodeArch === "arm64") return "arm64";
  throw new Error(`[deploy] unsupported architecture: ${nodeArch}`);
}

/**
 * Downloads the pinned flyctl into `dir` and returns its path.
*
* The digest is pinned here rather than read from the release's own checksums file:
* a checksum fetched from the same place as the artifact only proves the download
* completed.
*/
export async function resolveFlyctl(dir: string, fetchImpl: typeof fetch = fetch): Promise<string> {
  const arch = flyctlArch();
  const asset = `flyctl_${FLYCTL_VERSION}_Linux_${arch}.tar.gz`;
  const res = await fetchImpl(
    `https://github.com/superfly/flyctl/releases/download/v${FLYCTL_VERSION}/${asset}`,
  );
  if (!res.ok) throw new Error(`[deploy] flyctl download failed: HTTP ${res.status}`);
  
  const bytes = Buffer.from(await res.arrayBuffer());
  const digest = crypto.createHash("sha256").update(bytes).digest("hex");
  if (digest !== FLYCTL_SHA256[arch]) {
    throw new Error(`[deploy] flyctl digest mismatch: expected ${FLYCTL_SHA256[arch]}, got ${digest}`);
  }
  
  const archive = join(dir, asset);
  await writeFile(archive, bytes);
  await execFile("tar", ["-xzf", archive, "-C", dir, "flyctl"]);
  
  const binary = join(dir, "flyctl");
  await chmod(binary, 0o755);
  return binary;
}

/** Scratch space for one deploy. Ephemeral by design — /data belongs to the database. */
export async function deployScratch(): Promise<string> {
  const dir = join(tmpdir(), "ai-implement-deploy");
  await rm(dir, { recursive: true, force: true }); // leftovers from an interrupted run
  await mkdir(dir, { recursive: true });
  return dir;
}

/**
 * Writes a repository tarball to disk and extracts it, returning the build-context path.
 * GitHub wraps the tree in an `<owner>-<repo>-<short-sha>/` directory, which the extract strips.
*/
export async function extractSource(tarball: Buffer, dir: string): Promise<string> {
  const archive = join(dir, "source.tar.gz");
  await writeFile(archive, tarball);
  
  const context = join(dir, "source");
  await mkdir(context, { recursive: true });
  await execFile("tar", ["-xzf", archive, "-C", context, "--strip-components=1"]);
  return context;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export type DeployStart =
  | { started: true; commit: string }
  | { started: false; reason: "deploy-in-progress" | "head-unknown" };

/**
 * The configuration a deploy needs. Narrow by design: AppConfig satisfies it
 * structurally, so this module never imports the orchestrator's config type.
 */
export interface StartDeployConfig {
  flyDeployToken: string | null;
  flyOrchestratorApp: string | null;
  selfDeployTarget: SelfDeployTarget | null;
  pollIntervalMs: number;
  githubAppId: string;
  githubAppPrivateKey: string;
}

/**
 * Builds the trigger's entry point, or undefined when this orchestrator cannot deploy
 * itself — which is what lets the route answer 501 rather than failing partway.
 */
export function makeStartDeploy(
  config: StartDeployConfig,
): (() => Promise<DeployStart>) | undefined {
  if (!config.flyDeployToken || !config.selfDeployTarget || !config.flyOrchestratorApp) {
    return undefined;
  }
  const target = config.selfDeployTarget;
  const app = config.flyOrchestratorApp;
  const flyDeployToken = config.flyDeployToken;

  return async () => {
    const source = await getScopedInstallationToken(config.githubAppId, config.githubAppPrivateKey, target.owner, {
      permissions: { contents: "read" },
      repositories: [target.repo],
    });
    const head = await getBranchSha(source.token, target.owner, target.repo, target.branch);
    if (!head) return { started: false, reason: "head-unknown" };

    // No await between this check and the call below: runDeploy sets the hold
    // synchronously before its first await, so a second request cannot slip past.
    if (isDeployHeld()) return { started: false, reason: "deploy-in-progress" };

    void runDeploy({
      app,
      flyDeployToken,
      owner: target.owner,
      repo: target.repo,
      branch: target.branch,
      commit: head,
      pollIntervalMs: config.pollIntervalMs,
      githubAppId: config.githubAppId,
      githubAppPrivateKey: config.githubAppPrivateKey,
    }).catch((err) => console.error("[deploy] failed:", err));

    return { started: true, commit: head };
  };
}
