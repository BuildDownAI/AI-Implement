import http from "node:http";
import { getJobByNonce } from "./log.js";
import { getInstallationToken } from "./github-app-auth.js";

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

    const token = await getInstallationToken(githubAppId, githubAppPrivateKey, body.owner);
    const expiresAt = new Date(Date.now() + 55 * 60 * 1000).toISOString();

    json(res, 200, { token, expires_at: expiresAt });
  } catch (err) {
    console.error("[token-vending] Error:", err);
    json(res, 500, { error: "Failed to generate token" });
  }
}
