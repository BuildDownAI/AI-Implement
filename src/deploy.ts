import { execFile as nodeExecFile } from "node:child_process";
import { promisify } from "node:util";
import crypto from "node:crypto";
import { chmod, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { mintSourceTokenOrJwt } from "./github-app-auth.js";
import { fetchRepoTarball } from "./github.js";
import { getDb } from "./dedup.js";
import type { RestateDrainProbes } from "./restate/drain.js";
import { queryNonCompletedInvocations, restateBindAddress } from "./restate/endpoint.js";
import { RESTATE_ADMIN_BASE_URL } from "./restate/server.js";
import type { SelfDeployTarget } from "./deploy-availability.js";

export interface DeployArgsInput {
  app: string;
  kgToken: string | null;
  kgSourceRepo: string | null;
  sourceCommit: string;
  sourceRepo: string;
  sourceBranch: string;
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

export interface KgSourceRepo {
  owner: string;
  repo: string;
  fullName: string;
}

const GITHUB_OWNER_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/;
const GITHUB_REPO_RE = /^[A-Za-z0-9._-]+$/;

export function parseKgSourceRepo(value: string | null | undefined): KgSourceRepo {
  if (!value?.trim()) {
    throw new Error(`[deploy] KG_SOURCE_REPO must be an owner/repo GitHub repository, got ""`);
  }
  const raw = value.trim();
  const parts = raw.split("/");
  if (parts.length !== 2) {
    throw new Error(`[deploy] KG_SOURCE_REPO must be an owner/repo GitHub repository, got "${raw}"`);
  }

  const [owner, repo] = parts;
  if (!GITHUB_OWNER_RE.test(owner) || !GITHUB_REPO_RE.test(repo) || repo.length > 100) {
    throw new Error(`[deploy] KG_SOURCE_REPO must be an owner/repo GitHub repository, got "${raw}"`);
  }

  return { owner, repo, fullName: `${owner}/${repo}` };
}

/**
 * Resolve the configured KG repository without making a typo fatal to the
 * orchestrator. An absent value returns null (sidecar-less deployment, no warning);
 * a set-but-malformed value warns and disables self-deploy.
 */
export function readKgSourceRepo(
  value: string | null | undefined,
  warn: (message: string) => void = console.warn,
): string | null {
  if (!value?.trim()) return null;
  try {
    return parseKgSourceRepo(value).fullName;
  } catch {
    warn("[deploy] invalid KG_SOURCE_REPO; self-deploy disabled");
    return null;
  }
}

/** Restate invocation state is independent of dispatch_log and reservations. All
 * four probes must prove zero before a replacement can begin. */
export function createRestateDrainProbes(excludeInvocationId?: string): RestateDrainProbes {
  const { host, port } = restateBindAddress();
  const endpointUri = `http://${host}:${port}`;
  const count = (sql: string): number => {
    const row = getDb().prepare(sql).get() as { n: number };
    return row.n;
  };
  return {
    oldDeploymentInvocations: () => queryNonCompletedInvocations(fetch, RESTATE_ADMIN_BASE_URL, endpointUri, excludeInvocationId),
    unresolvedLaunches: async () => count(`SELECT COUNT(*) AS n FROM review_fix_attempts a
      JOIN dispatch_admissions d ON d.dispatch_id = a.dispatch_id
      WHERE d.released_at IS NULL AND a.state = 'launch_intent' AND a.github_run_id IS NULL`),
    unresolvedTerminations: async () => count(`SELECT COUNT(*) AS n FROM review_fix_attempts a
      JOIN dispatch_admissions d ON d.dispatch_id = a.dispatch_id
      WHERE d.released_at IS NULL AND a.authority_revoked_at IS NOT NULL AND a.completed_at IS NULL`),
    activeOwners: async () => count("SELECT COUNT(*) AS n FROM dispatch_admissions WHERE released_at IS NULL AND lifecycle_owner LIKE 'restate:%'"),
  };
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
  opts: { cwd: string; env: NodeJS.ProcessEnv; timeoutMs: number; signal?: AbortSignal },
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, { cwd: opts.cwd, env: opts.env, stdio: ["ignore", "pipe", "pipe"], signal: opts.signal });
    
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

export function deployArgs(input: DeployArgsInput): string[] {
  // An empty stamp leaves the next version unable to tell what it is running.
  // Fail before flyctl is invoked. KG fields are optional — null means sidecar-less build.
  for (const key of ["app", "sourceCommit", "sourceRepo", "sourceBranch"] as const) {
    if (!input[key]) throw new Error(`[deploy] refusing to deploy with an empty ${key}`);
  }

  const args = ["deploy", "--remote-only", "--no-cache"];

  const hasToken = Boolean(input.kgToken);
  const hasRepo = Boolean(input.kgSourceRepo);
  if (hasToken !== hasRepo) {
    throw new Error(`[deploy] kgToken and kgSourceRepo must both be set or both be absent (got token=${hasToken}, repo=${hasRepo})`);
  }
  if (input.kgToken && input.kgSourceRepo) {
    // --build-secret takes only NAME=VALUE, so the token rides in argv; execFile runs flyctl without a shell.
    args.push("--build-secret", `kg_token=${input.kgToken}`);
    args.push("--build-arg", `KG_SOURCE_REPO=${parseKgSourceRepo(input.kgSourceRepo).fullName}`);
  }

  args.push(
    "--build-arg", `SOURCE_COMMIT=${input.sourceCommit}`,
    "--build-arg", `SOURCE_REPO=${input.sourceRepo}`,
    "--build-arg", `SOURCE_BRANCH=${input.sourceBranch}`,
    "--app", input.app,
  );

  return args;
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

/**
 * The configuration a deploy needs. Narrow by design: AppConfig satisfies it
 * structurally, so this module never imports the orchestrator's config type.
 */
export interface StartDeployConfig {
  flyDeployToken: string | null;
  flyOrchestratorApp: string | null;
  selfDeployTarget: SelfDeployTarget | null;
}

/**
 * Whether this orchestrator can deploy itself: a token with deploy rights, an app to
 * deploy, and build stamps naming what to build. KG is optional — null means sidecar-less.
 */
export function canSelfDeploy(config: StartDeployConfig): config is StartDeployConfig & { flyDeployToken: string; flyOrchestratorApp: string; selfDeployTarget: SelfDeployTarget } {
  return Boolean(config.flyDeployToken && config.flyOrchestratorApp && config.selfDeployTarget);
}

const FLYCTL_TIMEOUT_MS = 20 * 60 * 1000;

export interface FlyctlRunInput {
  owner: string;
  repo: string;
  /** The commit the build context is extracted from — never the branch tip. */
  commit: string;
  githubAppId: string;
  githubAppPrivateKey: string;
  args: string[];
  flyDeployToken: string;
  signal: AbortSignal;
}

/**
 * Runs flyctl against the source tarball at `commit`. The `SelfDeploy` object's `flyctl` dependency:
 * the object owns the deadline and aborts `signal`, which kills the subprocess. Never logs argv, which
 * can carry the KG build secret.
 */
export async function runSelfDeployFlyctl(input: FlyctlRunInput): Promise<void> {
  const { owner, repo, commit } = input;
  // Mint and fetch the source before downloading flyctl: auth failures and
  // inaccessible repos surface here with an actionable message, not after 100 MB of I/O.
  const { token: sourceToken, authMode } = await mintSourceTokenOrJwt(
    input.githubAppId, input.githubAppPrivateKey, owner,
    { permissions: { contents: "read" }, repositories: [repo] },
  );
  let tarball: Buffer;
  try {
    tarball = await fetchRepoTarball(sourceToken, owner, repo, commit);
  } catch (err) {
    if (authMode === "public") {
      // Public (unauthenticated) path means the App is not installed on the owner.
      throw new Error(
        `Source repo '${owner}/${repo}' is not accessible. It may be private and the GitHub App is not installed on '${owner}'. Install the App on that org, or add the repository to the existing installation.`,
      );
    }
    throw err;
  }
  const scratch = await deployScratch();
  const flyctl = await resolveFlyctl(scratch);
  const context = await extractSource(tarball, scratch);
  console.log(`[deploy] running flyctl for ${owner}/${repo}@${commit.slice(0, 7)}`);
  await runFlyctl(flyctl, input.args, {
    cwd: context,
    // A deliberate allowlist, not process.env: the orchestrator's environment
    // holds every credential it has, and none of them belong in a build.
    env: { PATH: process.env.PATH ?? "", HOME: scratch, FLY_API_TOKEN: input.flyDeployToken },
    timeoutMs: FLYCTL_TIMEOUT_MS,
    signal: input.signal,
  });
}
