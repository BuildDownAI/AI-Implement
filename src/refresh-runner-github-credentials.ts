import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { refreshRunnerGithubCredentials } from "./runner-token.js";

export function tokenFromOrigin(workspaceDir: string): string | null {
  const result = spawnSync("git", ["remote", "get-url", "origin"], {
    cwd: workspaceDir,
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.status !== 0) return null;

  try {
    const remote = new URL(result.stdout.toString().trim());
    if (remote.username !== "x-access-token" || !remote.password) return null;
    return decodeURIComponent(remote.password);
  } catch {
    return null;
  }
}

export function repositoryCoordinates(): { owner: string; repo: string } {
  const [repositoryOwner = "", repositoryName = ""] =
    (process.env.GITHUB_REPOSITORY ?? "").split("/", 2);
  const owner = process.env.GITHUB_OWNER?.trim() || repositoryOwner.trim();
  const repo = process.env.GITHUB_REPO?.trim() || repositoryName.trim();
  if (!owner || !repo) {
    throw new Error("Missing GITHUB_OWNER/GITHUB_REPO (or GITHUB_REPOSITORY)");
  }
  return { owner, repo };
}

export async function refreshRunnerGithubCredentialsFromEnvironment(
  workspaceDir = process.cwd(),
): Promise<void> {
  const currentToken = tokenFromOrigin(workspaceDir)
    || process.env.GITHUB_TOKEN?.trim()
    || process.env.GH_TOKEN?.trim();
  if (!currentToken) throw new Error("Missing current GitHub token");

  const { owner, repo } = repositoryCoordinates();
  await refreshRunnerGithubCredentials({
    currentToken,
    orchestratorUrl: process.env.ORCHESTRATOR_URL,
    machineNonce: process.env.MACHINE_NONCE,
    owner,
    repo,
    workspaceDir,
    strict: true,
  });
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : "";
if (invokedPath === import.meta.url) {
  await refreshRunnerGithubCredentialsFromEnvironment().catch((err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[runner-token] Credential refresh failed: ${message}`);
    process.exitCode = 1;
  });
}
