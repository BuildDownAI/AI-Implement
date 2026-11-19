import http from "node:http";
import { getJobByNonce } from "./log.js";
import { getScopedInstallationToken } from "./github-app-auth.js";
import { gitHubAppErrorChecks, pointAtSetupChecks } from "./setup-checks/recheck.js";

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString()));
    req.on("error", reject);
  });
}

function json(res: http.ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}

export async function handleTokenRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  githubAppId: string,
  githubAppPrivateKey: string,
): Promise<void> {
  let project: string | null = null;
  try {
    const body = JSON.parse(await readBody(req)) as {
      nonce?: string;
      owner?: string;
    };

    if (!body.nonce || !body.owner) {
      json(res, 400, { error: "nonce and owner are required" });
      return;
    }

    const job = getJobByNonce(body.nonce);
    if (!job) {
      json(res, 403, { error: "Invalid or expired nonce" });
      return;
    }

    // Verify the owner matches the job's repo (format: "owner/repo")
    const jobOwner = job.repo?.split("/")[0];
    if (!jobOwner || jobOwner !== body.owner) {
      json(res, 403, { error: "Owner mismatch" });
      return;
    }

    // forceRefresh mirrors the refreshInstallationToken semantics this endpoint had on
    // testing: a vend must return a full-lifetime token, never a cache hit that may be
    // minutes from expiry.
    const repoName = job.repo!.split("/")[1];
    project = job.teamKey;
    const { token, expiresAt } = await getScopedInstallationToken(githubAppId, githubAppPrivateKey, body.owner, { repositories: [repoName], forceRefresh: true });

    json(res, 200, { token, expires_at: expiresAt });
  } catch (err) {
    console.error(`[token-vending] Error${pointAtSetupChecks({ ids: gitHubAppErrorChecks(err), project, cause: "token-vending" })}:`, err);
    json(res, 500, { error: "Failed to generate token" });
  }
}
