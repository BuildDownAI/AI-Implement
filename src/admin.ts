import http from "node:http";
import crypto from "node:crypto";
import {
  getMappings,
  DEFAULT_MAX_IN_PROGRESS_AI_ISSUES,
  DEFAULT_EXECUTION_MODE,
  DEFAULT_SESSION_MODE,
  DEFAULT_MACHINE_CPUS,
  DEFAULT_MACHINE_MEMORY_MB,
  DEFAULT_PLANNING_ENABLED,
  DEFAULT_PLANNING_WORKFLOW_FILE,
  DEFAULT_AUTO_APPROVE_PLANS,
  DEFAULT_PROVIDER,
  upsertMapping,
  updateMappingCap,
  deleteMapping,
} from "./config.js";
import type { RepoMapping, ExecutionMode, SessionMode, ClaudeProvider } from "./config.js";
import {
  getRunnerMode,
  setRunnerMode,
  VALID_RUNNER_MODES,
  isRunnerMode,
  setFlySecretsMinVersion,
} from "./runner-mode.js";
import { getDb, listDispatched, deleteDispatched, getReaperSummary, listReaperActions, getDispatchedIds } from "./dedup.js";
import { getLastSweepAt } from "./reaper.js";
import { listLog, getInFlightJobs, updateJobStatus, getJobById, getPulls } from "./log.js";
import { getStepsByJobId } from "./step-log.js";
import { listMachines, destroyMachine, listAppSecrets, setAppSecrets, unsetAppSecret } from "./fly-machines.js";
import { removeAIWorkingLabel, fetchAIImplementIssueSnapshot, type LinearIssue } from "./linear.js";
import { selectBlockers } from "./poll-selection.js";
import { adminHtml } from "./admin-html.js";
import { getOrchestratorSettings, setOrchestratorSetting } from "./orchestrator-settings.js";

const SESSION_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

function createSession(): string {
  const token = crypto.randomBytes(32).toString("hex");
  getDb()
    .prepare("INSERT INTO admin_sessions (token, expires_at) VALUES (?, ?)")
    .run(token, Date.now() + SESSION_TTL_MS);
  return token;
}

function isValidSession(token: string | undefined): boolean {
  if (!token) return false;
  const row = getDb()
    .prepare("SELECT expires_at FROM admin_sessions WHERE token = ?")
    .get(token) as { expires_at: number } | undefined;
  if (!row) return false;
  if (Date.now() > row.expires_at) {
    getDb().prepare("DELETE FROM admin_sessions WHERE token = ?").run(token);
    return false;
  }
  return true;
}

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

function shapeIssue(i: LinearIssue, bucket: "ready" | "needs-planning") {
  return {
    id: i.id,
    identifier: i.identifier,
    title: i.title,
    teamKey: i.team.key,
    stateName: i.state.name,
    stateType: i.state.type,
    bucket,
  };
}

function getToken(req: http.IncomingMessage): string | undefined {
  const auth = req.headers.authorization;
  if (auth?.startsWith("Bearer ")) return auth.slice(7);
  return undefined;
}

export interface AdminConfig {
  adminAccessCode: string;
  flySessionsToken: string | null;
  flySessionsApp: string | null;
  flySessionsRegion: string | null;
  linearApiKey: string;
  githubAppId: string;
  githubAppPrivateKey: string;
}

export function handleAdminRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  config: AdminConfig,
): boolean {
  const url = req.url || "/";
  const method = req.method || "GET";

  // Serve admin HTML
  if (url === "/admin" && method === "GET") {
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(adminHtml);
    return true;
  }

  // Auth endpoint — no token required
  if (url === "/api/auth" && method === "POST") {
    handleAuth(req, res, config.adminAccessCode);
    return true;
  }

  // All other /api routes require auth
  if (url.startsWith("/api/")) {
    if (!isValidSession(getToken(req))) {
      json(res, 401, { error: "Unauthorized" });
      return true;
    }

    if (url === "/api/mappings" && method === "GET") {
      json(res, 200, getMappings());
      return true;
    }

    if (url === "/api/mappings" && method === "POST") {
      handleUpsertMapping(req, res);
      return true;
    }

    // Secrets management: /api/mappings/:teamKey/secrets or /api/mappings/:teamKey/secrets/:name
    // Must be checked before the generic PATCH/DELETE mapping handlers below.
    const secretsMatch = url.match(/^\/api\/mappings\/([^/]+)\/secrets(?:\/([^/]+))?$/);
    if (secretsMatch) {
      const teamKey = decodeURIComponent(secretsMatch[1]);
      const secretSuffix = secretsMatch[2] !== undefined ? decodeURIComponent(secretsMatch[2]) : null;

      if (method === "GET" && secretSuffix === null) {
        handleListSecrets(req, res, config, teamKey);
        return true;
      }
      if (method === "POST" && secretSuffix === null) {
        handleSetSecret(req, res, config, teamKey);
        return true;
      }
      if (method === "DELETE" && secretSuffix !== null) {
        handleUnsetSecret(req, res, config, teamKey, secretSuffix);
        return true;
      }
    }

    if (url.startsWith("/api/mappings/") && method === "PATCH") {
      const teamKey = decodeURIComponent(url.slice("/api/mappings/".length));
      handlePatchMapping(req, res, teamKey);
      return true;
    }

    if (url.startsWith("/api/mappings/") && method === "DELETE") {
      const teamKey = decodeURIComponent(url.slice("/api/mappings/".length));
      const deleted = deleteMapping(teamKey);
      json(res, deleted ? 200 : 404, { deleted });
      return true;
    }

    if (url === "/api/log" && method === "GET") {
      json(res, 200, listLog());
      return true;
    }

    if (url === "/api/pulls" && method === "GET") {
      json(res, 200, { pulls: getPulls() });
      return true;
    }

    const jobStepsMatch = url.match(/^\/api\/jobs\/(\d+)\/steps$/);
    if (jobStepsMatch && method === "GET") {
      const jobId = Number.parseInt(jobStepsMatch[1], 10);
      const job = getJobById(jobId);
      if (!job) { json(res, 404, { error: "job not found" }); return true; }
      json(res, 200, { job, steps: getStepsByJobId(jobId) });
      return true;
    }

    if (url === "/api/linear/issues" && method === "GET") {
      handleListLinearIssues(res, config);
      return true;
    }

    if (url === "/api/blockers" && method === "GET") {
      handleListBlockers(res, config);
      return true;
    }

    if (url === "/api/reaper/summary" && method === "GET") {
      const summary = getReaperSummary();
      json(res, 200, { ...summary, lastSweepAt: getLastSweepAt() });
      return true;
    }

    if (url.startsWith("/api/reaper/recent") && method === "GET") {
      const qs = url.includes("?") ? url.slice(url.indexOf("?") + 1) : "";
      const limitParam = new URLSearchParams(qs).get("limit");
      const n = parseInt(limitParam ?? "20", 10);
      const limit = Math.min(100, Number.isFinite(n) && n > 0 ? n : 20);
      json(res, 200, listReaperActions(limit));
      return true;
    }

    if (url === "/api/dedup" && method === "GET") {
      json(res, 200, listDispatched());
      return true;
    }

    if (url.startsWith("/api/dedup/") && method === "DELETE") {
      const issueId = decodeURIComponent(url.slice("/api/dedup/".length));
      const deleted = deleteDispatched(issueId);
      json(res, deleted ? 200 : 404, { deleted });
      return true;
    }

    if (url === "/api/runner-mode" && method === "GET") {
      json(res, 200, getRunnerMode());
      return true;
    }

    if (url === "/api/runner-mode" && method === "POST") {
      handleSetRunnerMode(req, res);
      return true;
    }

    if (url === "/api/sessions" && method === "GET") {
      handleListSessions(req, res, config);
      return true;
    }

    if (url.startsWith("/api/sessions/") && method === "DELETE") {
      const machineId = decodeURIComponent(url.slice("/api/sessions/".length));
      handleDestroySession(req, res, config, machineId);
      return true;
    }

    if (url === "/api/settings" && method === "GET") {
      handleGetSettings(req, res, config);
      return true;
    }

    if (url === "/api/settings" && method === "POST") {
      handlePostSettings(req, res, config);
      return true;
    }

    if (url === "/api/global-secrets" && method === "GET") {
      handleListGlobalSecrets(req, res, config);
      return true;
    }

    if (url === "/api/global-secrets" && method === "POST") {
      handleSetGlobalSecret(req, res, config);
      return true;
    }

    const globalSecretDeleteMatch = url.match(/^\/api\/global-secrets\/([^/]+)$/);
    if (globalSecretDeleteMatch && method === "DELETE") {
      const secretName = decodeURIComponent(globalSecretDeleteMatch[1]);
      handleUnsetGlobalSecret(req, res, config, secretName);
      return true;
    }

    json(res, 404, { error: "Not found" });
    return true;
  }

  return false;
}

async function handleListBlockers(
  res: http.ServerResponse,
  config: AdminConfig,
): Promise<void> {
  try {
    const snapshot = await fetchAIImplementIssueSnapshot(config.linearApiKey);
    const allIssues = [...snapshot.readyForImplementation, ...snapshot.needsPlanning];
    const teamRepoMap = getMappings();
    const dispatchedSet = new Set(getDispatchedIds());
    const blockers = selectBlockers(
      allIssues,
      teamRepoMap,
      snapshot.inProgressCountsByTeam,
      (id) => dispatchedSet.has(id),
    );
    const teams = new Set(blockers.map((b) => b.teamKey));
    const byReason: Record<string, number> = {};
    for (const b of blockers) byReason[b.reason] = (byReason[b.reason] ?? 0) + 1;
    json(res, 200, {
      blockers,
      totals: { teams: teams.size, issues: blockers.length, byReason },
    });
  } catch (err) {
    json(res, 502, { error: err instanceof Error ? err.message : String(err) });
  }
}

async function handleListLinearIssues(
  res: http.ServerResponse,
  config: AdminConfig,
): Promise<void> {
  try {
    const snapshot = await fetchAIImplementIssueSnapshot(config.linearApiKey);
    const issues = [
      ...snapshot.readyForImplementation.map((i) => shapeIssue(i, "ready")),
      ...snapshot.needsPlanning.map((i) => shapeIssue(i, "needs-planning")),
    ].sort((a, b) => a.identifier.localeCompare(b.identifier));
    json(res, 200, {
      issues,
      inProgressCountsByTeam: snapshot.inProgressCountsByTeam,
    });
  } catch (err) {
    json(res, 502, { error: err instanceof Error ? err.message : String(err) });
  }
}

async function handleSetRunnerMode(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<void> {
  try {
    const body = JSON.parse(await readBody(req)) as { mode?: string };
    if (!isRunnerMode(body.mode)) {
      json(res, 400, { error: `mode must be one of: ${VALID_RUNNER_MODES.join(", ")}` });
      return;
    }
    setRunnerMode(body.mode);
    const status = getRunnerMode();
    // The DB write succeeded but the RUNNER_MODE env var still wins at
    // runtime. Return 409 so direct API callers (not the UI, which already
    // disables the buttons) can tell their write was overridden.
    if (status.source === "env") {
      json(res, 409, {
        error: "RUNNER_MODE env var is set; persisted to DB but has no effect at runtime until the env var is unset",
        persisted: body.mode,
        ...status,
      });
      return;
    }
    json(res, 200, status);
  } catch {
    json(res, 400, { error: "Invalid request body" });
  }
}

async function handleListSessions(
  _req: http.IncomingMessage,
  res: http.ServerResponse,
  config: AdminConfig,
): Promise<void> {
  if (!config.flySessionsToken || !config.flySessionsApp) {
    json(res, 200, []);
    return;
  }

  try {
    const machines = await listMachines(config.flySessionsToken, config.flySessionsApp);
    const active = machines.filter(
      (m) => m.state === "started" || m.state === "created" || m.state === "starting",
    );

    // Join with jobs table by machine_id for issue metadata
    const jobs = getInFlightJobs();
    const byMachineId = new Map(jobs.filter((j) => j.machineId).map((j) => [j.machineId, j]));

    const sessions = active.map((m) => {
      const job = byMachineId.get(m.id);
      return {
        machineId: m.id,
        machineName: m.name,
        state: m.state,
        region: m.region,
        createdAt: m.created_at,
        issueId: job?.issueId ?? null,
        issueIdentifier: job?.issueIdentifier ?? null,
        issueTitle: job?.issueTitle ?? null,
        teamKey: job?.teamKey ?? null,
        repo: job?.repo ?? null,
        dispatchedAt: job?.dispatchedAt ?? null,
      };
    });

    json(res, 200, sessions);
  } catch (err) {
    console.error("[admin] Failed to list sessions:", err);
    json(res, 500, { error: err instanceof Error ? err.message : String(err) });
  }
}

async function handleDestroySession(
  _req: http.IncomingMessage,
  res: http.ServerResponse,
  config: AdminConfig,
  machineId: string,
): Promise<void> {
  if (!config.flySessionsToken || !config.flySessionsApp) {
    json(res, 503, { error: "Fly sessions config not set" });
    return;
  }

  // Find the job first so we can reset its Linear issue
  const job = getInFlightJobs().find((j) => j.machineId === machineId);

  try {
    await destroyMachine(config.flySessionsToken, config.flySessionsApp, machineId);
  } catch (err) {
    // 404 is fine — machine was already gone
    if (!(err instanceof Error && err.message.includes("404"))) {
      console.error(`[admin] Failed to destroy machine ${machineId}:`, err);
      json(res, 500, { error: err instanceof Error ? err.message : String(err) });
      return;
    }
  }

  if (job) {
    updateJobStatus(job.id, "failed", "destroyed-by-admin");
    if (job.issueId) {
      try {
        await removeAIWorkingLabel(config.linearApiKey, job.issueId);
        deleteDispatched(job.issueId);
      } catch (err) {
        console.error(`[admin] Failed to reset Linear issue ${job.issueIdentifier}:`, err);
      }
    }
  }

  json(res, 200, { destroyed: true });
}

async function handleAuth(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  accessCode: string,
): Promise<void> {
  try {
    const body = JSON.parse(await readBody(req)) as { code?: string };
    if (body.code === accessCode) {
      const token = createSession();
      json(res, 200, { token });
    } else {
      json(res, 403, { error: "Invalid access code" });
    }
  } catch {
    json(res, 400, { error: "Invalid request body" });
  }
}

async function handlePatchMapping(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  teamKey: string,
): Promise<void> {
  try {
    const body = JSON.parse(await readBody(req)) as { maxInProgressAiIssues?: number };
    const max = body.maxInProgressAiIssues;
    if (!Number.isInteger(max) || (max as number) < 1) {
      json(res, 400, { error: "maxInProgressAiIssues must be a positive integer" });
      return;
    }
    const updated = updateMappingCap(teamKey, max as number);
    json(res, updated ? 200 : 404, { updated });
  } catch {
    json(res, 400, { error: "Invalid request body" });
  }
}

async function handleListSecrets(
  _req: http.IncomingMessage,
  res: http.ServerResponse,
  config: AdminConfig,
  teamKey: string,
): Promise<void> {
  if (!config.flySessionsToken || !config.flySessionsApp) {
    json(res, 503, { error: "Fly sessions config not set" });
    return;
  }
  const mappings = getMappings();
  if (!mappings[teamKey]) {
    json(res, 404, { error: "Team not found" });
    return;
  }
  try {
    const allSecrets = await listAppSecrets(config.flySessionsToken, config.flySessionsApp);
    const prefix = `${teamKey.toUpperCase()}_`;
    const teamSecrets = allSecrets
      .filter((s) => s.name.startsWith(prefix))
      .map((s) => ({ name: s.name.slice(prefix.length) }));
    json(res, 200, teamSecrets);
  } catch (err) {
    console.error(`[admin] Failed to list secrets for team ${teamKey}:`, err);
    json(res, 500, { error: err instanceof Error ? err.message : String(err) });
  }
}

async function handleSetSecret(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  config: AdminConfig,
  teamKey: string,
): Promise<void> {
  if (!config.flySessionsToken || !config.flySessionsApp) {
    json(res, 503, { error: "Fly sessions config not set" });
    return;
  }
  const mappings = getMappings();
  if (!mappings[teamKey]) {
    json(res, 404, { error: "Team not found" });
    return;
  }
  let body: { name?: string; value?: string };
  try {
    body = JSON.parse(await readBody(req)) as { name?: string; value?: string };
  } catch {
    json(res, 400, { error: "Invalid request body" });
    return;
  }
  if (!body.name || body.value === undefined || body.value === "") {
    json(res, 400, { error: "name and value are required" });
    return;
  }
  const secretSuffix = body.name.toUpperCase().trim();
  if (!/^[A-Z0-9_]+$/.test(secretSuffix)) {
    json(res, 400, { error: "name must contain only letters, digits, and underscores" });
    return;
  }
  try {
    const fullName = `${teamKey.toUpperCase()}_${secretSuffix}`;
    const minSecretsVersion = await setAppSecrets(
      config.flySessionsToken,
      config.flySessionsApp,
      { [fullName]: body.value },
    );
    if (minSecretsVersion !== null) {
      setFlySecretsMinVersion(minSecretsVersion);
    }
    json(res, 200, { name: secretSuffix });
  } catch (err) {
    console.error(`[admin] Failed to set secret for team ${teamKey}:`, err);
    json(res, 500, { error: err instanceof Error ? err.message : String(err) });
  }
}

async function handleUnsetSecret(
  _req: http.IncomingMessage,
  res: http.ServerResponse,
  config: AdminConfig,
  teamKey: string,
  secretSuffix: string,
): Promise<void> {
  if (!config.flySessionsToken || !config.flySessionsApp) {
    json(res, 503, { error: "Fly sessions config not set" });
    return;
  }
  const mappings = getMappings();
  if (!mappings[teamKey]) {
    json(res, 404, { error: "Team not found" });
    return;
  }
  try {
    const fullName = `${teamKey.toUpperCase()}_${secretSuffix.toUpperCase()}`;
    const minSecretsVersion = await unsetAppSecret(
      config.flySessionsToken,
      config.flySessionsApp,
      fullName,
    );
    if (minSecretsVersion !== null) {
      setFlySecretsMinVersion(minSecretsVersion);
    }
    json(res, 200, { deleted: true });
  } catch (err) {
    if (err instanceof Error) {
      const msg = err.message.toLowerCase();
      if (msg.includes("404") || msg.includes("not found") || msg.includes("could not find")) {
        json(res, 404, { error: "Secret not found" });
        return;
      }
    }
    console.error(`[admin] Failed to unset secret ${secretSuffix} for team ${teamKey}:`, err);
    json(res, 500, { error: err instanceof Error ? err.message : String(err) });
  }
}

function handleGetSettings(
  _req: http.IncomingMessage,
  res: http.ServerResponse,
  config: AdminConfig,
): void {
  const dbSettings = getOrchestratorSettings();
  const envApp = process.env.FLY_SESSIONS_APP || null;
  const envRegion = process.env.FLY_SESSIONS_REGION || null;

  json(res, 200, {
    flySessionsApp: {
      runtimeValue: config.flySessionsApp,
      dbValue: dbSettings.flySessionsApp,
      envValue: envApp,
      overriddenByEnv: envApp !== null,
    },
    flySessionsRegion: {
      runtimeValue: config.flySessionsRegion,
      dbValue: dbSettings.flySessionsRegion,
      envValue: envRegion,
      overriddenByEnv: envRegion !== null,
    },
  });
}

async function handlePostSettings(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  config: AdminConfig,
): Promise<void> {
  let body: { flySessionsApp?: string | null; flySessionsRegion?: string | null };
  try {
    const parsed = JSON.parse(await readBody(req));
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      json(res, 400, { error: "Invalid request body" });
      return;
    }
    body = parsed as typeof body;
  } catch {
    json(res, 400, { error: "Invalid request body" });
    return;
  }

  if ("flySessionsApp" in body) {
    const val = typeof body.flySessionsApp === "string" && body.flySessionsApp.trim()
      ? body.flySessionsApp.trim()
      : null;
    setOrchestratorSetting("flySessionsApp", val);
  }
  if ("flySessionsRegion" in body) {
    const val = typeof body.flySessionsRegion === "string" && body.flySessionsRegion.trim()
      ? body.flySessionsRegion.trim()
      : null;
    setOrchestratorSetting("flySessionsRegion", val);
  }

  const dbSettings = getOrchestratorSettings();
  const envApp = process.env.FLY_SESSIONS_APP || null;
  const envRegion = process.env.FLY_SESSIONS_REGION || null;

  const nextApp = envApp ?? dbSettings.flySessionsApp;
  const nextRegion = envRegion ?? dbSettings.flySessionsRegion;
  const restartRequired = nextApp !== config.flySessionsApp || nextRegion !== config.flySessionsRegion;

  json(res, 200, {
    flySessionsApp: {
      runtimeValue: config.flySessionsApp,
      dbValue: dbSettings.flySessionsApp,
      envValue: envApp,
      overriddenByEnv: envApp !== null,
    },
    flySessionsRegion: {
      runtimeValue: config.flySessionsRegion,
      dbValue: dbSettings.flySessionsRegion,
      envValue: envRegion,
      overriddenByEnv: envRegion !== null,
    },
    restartRequired,
  });
}

async function handleListGlobalSecrets(
  _req: http.IncomingMessage,
  res: http.ServerResponse,
  config: AdminConfig,
): Promise<void> {
  if (!config.flySessionsToken || !config.flySessionsApp) {
    json(res, 503, { error: "Fly sessions config not set" });
    return;
  }
  try {
    const allSecrets = await listAppSecrets(config.flySessionsToken, config.flySessionsApp);
    const teamPrefixes = Object.keys(getMappings()).map((k) => `${k.toUpperCase()}_`);
    const globalSecrets = allSecrets
      .filter((s) => !teamPrefixes.some((prefix) => s.name.startsWith(prefix)))
      .map((s) => ({ name: s.name, createdAt: s.created_at }));
    json(res, 200, globalSecrets);
  } catch (err) {
    console.error("[admin] Failed to list global secrets:", err);
    json(res, 500, { error: err instanceof Error ? err.message : String(err) });
  }
}

async function handleSetGlobalSecret(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  config: AdminConfig,
): Promise<void> {
  if (!config.flySessionsToken || !config.flySessionsApp) {
    json(res, 503, { error: "Fly sessions config not set" });
    return;
  }
  let body: { name?: string; value?: string };
  try {
    const parsed = JSON.parse(await readBody(req));
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      json(res, 400, { error: "Invalid request body" });
      return;
    }
    body = parsed as typeof body;
  } catch {
    json(res, 400, { error: "Invalid request body" });
    return;
  }
  if (!body.name || body.value === undefined || body.value === "") {
    json(res, 400, { error: "name and value are required" });
    return;
  }
  const name = body.name.toUpperCase().trim();
  if (!/^[A-Z0-9_]+$/.test(name)) {
    json(res, 400, { error: "name must contain only letters, digits, and underscores" });
    return;
  }
  const teamPrefixes = Object.keys(getMappings()).map((k) => `${k.toUpperCase()}_`);
  if (teamPrefixes.some((prefix) => name.startsWith(prefix))) {
    json(res, 400, { error: `Secret name must not start with a team key prefix (${teamPrefixes.join(", ")})` });
    return;
  }
  try {
    const minVersion = await setAppSecrets(config.flySessionsToken, config.flySessionsApp, { [name]: body.value });
    if (minVersion !== null) setFlySecretsMinVersion(minVersion);
    json(res, 200, { name });
  } catch (err) {
    console.error("[admin] Failed to set global secret:", err);
    json(res, 500, { error: err instanceof Error ? err.message : String(err) });
  }
}

async function handleUnsetGlobalSecret(
  _req: http.IncomingMessage,
  res: http.ServerResponse,
  config: AdminConfig,
  secretName: string,
): Promise<void> {
  if (!config.flySessionsToken || !config.flySessionsApp) {
    json(res, 503, { error: "Fly sessions config not set" });
    return;
  }
  const upperName = secretName.toUpperCase();
  if (!/^[A-Z0-9_]+$/.test(upperName)) {
    json(res, 400, { error: "name must contain only letters, digits, and underscores" });
    return;
  }
  const teamPrefixes = Object.keys(getMappings()).map((k) => `${k.toUpperCase()}_`);
  if (teamPrefixes.some((prefix) => upperName.startsWith(prefix))) {
    json(res, 400, { error: `Secret name must not start with a team key prefix (${teamPrefixes.join(", ")})` });
    return;
  }
  try {
    const minVersion = await unsetAppSecret(config.flySessionsToken, config.flySessionsApp, upperName);
    if (minVersion !== null) setFlySecretsMinVersion(minVersion);
    json(res, 200, { deleted: true });
  } catch (err) {
    if (err instanceof Error) {
      const msg = err.message.toLowerCase();
      if (msg.includes("404") || msg.includes("not found") || msg.includes("could not find")) {
        json(res, 404, { error: "Secret not found" });
        return;
      }
    }
    console.error(`[admin] Failed to unset global secret ${secretName}:`, err);
    json(res, 500, { error: err instanceof Error ? err.message : String(err) });
  }
}

async function handleUpsertMapping(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<void> {
  try {
    const body = JSON.parse(await readBody(req)) as {
      teamKey?: string;
      owner?: string;
      repo?: string;
      workflowFile?: string;
      defaultBranch?: string;
      maxInProgressAiIssues?: number;
      executionMode?: string;
      sessionMode?: string;
      machineCpus?: number;
      machineMemoryMb?: number;
      planningEnabled?: boolean;
      planningWorkflowFile?: string;
      autoApprovePlans?: boolean;
      extraEnv?: Record<string, string>;
      provider?: string;
      awsRegion?: string | null;
    };

    if (!body.teamKey || !body.owner || !body.repo) {
      json(res, 400, { error: "teamKey, owner, and repo are required" });
      return;
    }

    const maxInProgressAiIssues =
      body.maxInProgressAiIssues ?? DEFAULT_MAX_IN_PROGRESS_AI_ISSUES;
    if (!Number.isInteger(maxInProgressAiIssues) || maxInProgressAiIssues < 1) {
      json(res, 400, { error: "maxInProgressAiIssues must be a positive integer" });
      return;
    }

    const validExecutionModes: ExecutionMode[] = ["github-actions", "fly-machines"];
    const executionMode = (body.executionMode ?? DEFAULT_EXECUTION_MODE) as ExecutionMode;
    if (!validExecutionModes.includes(executionMode)) {
      json(res, 400, { error: "executionMode must be 'github-actions' or 'fly-machines'" });
      return;
    }

    const validSessionModes: SessionMode[] = ["autonomous", "interactive", "hybrid"];
    const sessionMode = (body.sessionMode ?? DEFAULT_SESSION_MODE) as SessionMode;
    if (!validSessionModes.includes(sessionMode)) {
      json(res, 400, { error: "sessionMode must be 'autonomous', 'interactive', or 'hybrid'" });
      return;
    }

    const machineCpus = body.machineCpus ?? DEFAULT_MACHINE_CPUS;
    if (!Number.isInteger(machineCpus) || machineCpus < 1) {
      json(res, 400, { error: "machineCpus must be a positive integer" });
      return;
    }

    const machineMemoryMb = body.machineMemoryMb ?? DEFAULT_MACHINE_MEMORY_MB;
    if (!Number.isInteger(machineMemoryMb) || machineMemoryMb < 256) {
      json(res, 400, { error: "machineMemoryMb must be an integer >= 256" });
      return;
    }

    const planningEnabled = body.planningEnabled ?? DEFAULT_PLANNING_ENABLED;
    const planningWorkflowFile = body.planningWorkflowFile ?? DEFAULT_PLANNING_WORKFLOW_FILE;
    const autoApprovePlans = body.autoApprovePlans ?? DEFAULT_AUTO_APPROVE_PLANS;

    if (planningEnabled && !planningWorkflowFile) {
      json(res, 400, { error: "planningWorkflowFile is required when planningEnabled is true" });
      return;
    }

    let extraEnv: Record<string, string> = {};
    if (body.extraEnv !== undefined) {
      if (typeof body.extraEnv !== "object" || Array.isArray(body.extraEnv) || body.extraEnv === null) {
        json(res, 400, { error: "extraEnv must be a plain object" });
        return;
      }
      if (!Object.values(body.extraEnv).every((v) => typeof v === "string")) {
        json(res, 400, { error: "extraEnv values must all be strings" });
        return;
      }
      extraEnv = body.extraEnv as Record<string, string>;
    }

    const validProviders: ClaudeProvider[] = ["anthropic", "bedrock"];
    const provider = (body.provider ?? DEFAULT_PROVIDER) as ClaudeProvider;
    if (!validProviders.includes(provider)) {
      json(res, 400, { error: "provider must be 'anthropic' or 'bedrock'" });
      return;
    }

    const awsRegionRaw = typeof body.awsRegion === "string" ? body.awsRegion.trim() : "";
    const awsRegion = awsRegionRaw.length > 0 ? awsRegionRaw : null;
    if (provider === "bedrock" && !awsRegion) {
      json(res, 400, { error: "awsRegion is required when provider is 'bedrock'" });
      return;
    }
    if (provider === "bedrock" && executionMode === "fly-machines") {
      json(res, 400, {
        error: "provider 'bedrock' is not supported with executionMode 'fly-machines'",
      });
      return;
    }

    const mapping: RepoMapping = {
      owner: body.owner,
      repo: body.repo,
      workflowFile: body.workflowFile || "claude-implement.yml",
      defaultBranch: body.defaultBranch || "main",
      maxInProgressAiIssues,
      executionMode,
      sessionMode,
      machineCpus,
      machineMemoryMb,
      planningEnabled,
      planningWorkflowFile,
      autoApprovePlans,
      extraEnv,
      provider,
      awsRegion,
    };

    upsertMapping(body.teamKey, mapping);
    json(res, 200, { teamKey: body.teamKey, ...mapping });
  } catch {
    json(res, 400, { error: "Invalid request body" });
  }
}
