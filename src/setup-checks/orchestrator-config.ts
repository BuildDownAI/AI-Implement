/** Checks of the orchestrator's own environment and settings: the `orchestrator` group. */

import { dirname } from "node:path";
import { allowlistFromEnv, hasAdminAddress } from "../access-entries.js";
import { effectiveAccessCode } from "../admin-session.js";
import { resolveProviders } from "../oauth/providers.js";
import { appCredentialsProblem } from "../github-app-auth.js";
import { SEED_ONCE_SETTINGS } from "../seed-once-settings.js";
import { MAX_POLL_INTERVAL_MS, parsePollIntervalMs } from "../poll-cycle.js";
import { parseBreakerThreshold } from "../dispatch-breaker.js";
import { FLY_PROCESS_LEVEL_SECRETS_SETTING_KEY, isRunnerMode, resolveExecutionPath, resolveFlyProcessLevelSecrets, resolveRunnerCallbackBaseUrl, resolveRunnerMode, RUNNER_MODE_SETTING_KEY, VALID_RUNNER_MODES } from "../runner-mode.js";
import { missingRunnerCallbackConfig } from "../runner-callback.js";
import { ORCHESTRATOR_HEALTH_TIMEOUT_MS } from "../health-body.js";
import type { SetupCheck, SetupCheckContext } from "./index.js";

/** A URL's host name, or null when it does not parse, so the fetch reports the malformed address. */
function hostnameOf(url: string): string | null {
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
}

/** Configuration only: an allowlist outage must never expose bootstrap diagnostics. */
export function isAdminPathConfigured({ env, effectiveAllowlist, allowlistReadAvailable }: Pick<SetupCheckContext, "env" | "effectiveAllowlist" | "allowlistReadAvailable">): boolean {
  if (effectiveAccessCode(env.ADMIN_ACCESS_CODE) !== null) return true;
  let list;
  try {
    list = effectiveAllowlist();
    if (!allowlistReadAvailable()) return true;
  } catch { return true; }
  if (list === null) return true;
  const providers = resolveProviders(env).providers;
  return Boolean(env.OAUTH_REDIRECT_BASE_URL && providers.length > 0 &&
    (providers.some((provider) => provider.id === "builddown") || hasAdminAddress(list.entries)));
}

export const ORCHESTRATOR_CONFIG_CHECKS: readonly SetupCheck[] = [
  {
    id: "model.credentials-adopted",
    title: "Model credential adoption",
    group: "orchestrator",
    tier: "core",
    onAdminPath: false,
    run: ({ env, orchestratorDefaults, projectStageConfig, mappings }) => {
      const hasEnv = Boolean(env.ANTHROPIC_API_KEY || env.CLAUDE_CODE_OAUTH_TOKEN);
      const configured = orchestratorDefaults()?.config.mode === "configured";
      if (hasEnv && !configured) return [{
        state: "warn",
        detail: "An environment model credential exists without configured defaults",
        fix: "Run node dist/model-account-cli.js adopt-env.",
      }];
      const keys = Object.keys(mappings());
      if (!configured) return keys.length === 0
        ? [{ state: "pass", detail: "No environment model credential or project mappings" }]
        : [{ state: "fail", detail: "no model access configured", fix: "Configure model access and orchestrator defaults before adopting projects." }];
      const pending = keys.filter((key) => projectStageConfig(key)?.config.mode !== "configured");
      if (pending.length > 0) return [{
        state: "warn",
        detail: `Projects without configured model access: ${pending.join(", ")}`,
        fix: "Run node dist/model-account-cli.js adopt-projects. Existing legacy rows are explicit opt-outs and are skipped; configure those projects explicitly.",
      }];
      return [{ state: "pass", detail: hasEnv
        ? "Defaults and all mapped projects are configured; environment credential is unused"
        : "Defaults and all mapped projects are configured" }];
    },
  },
  {
    id: "env.github-app",
    title: "GitHub App credentials",
    group: "orchestrator",
    tier: "core",
    onAdminPath: true,
    run: ({ env }) => {
      const problem = appCredentialsProblem(env);
      if (problem) return [{ state: "fail", detail: problem, fix: "Set GITHUB_APP_ID and GITHUB_APP_PRIVATE_KEY. The private key is the PEM file from the GitHub App's settings page." }];
      return [{ state: "pass", detail: "Both set, and the key parses" }];
    },
  },
  {
    id: "env.admin-access-code",
    title: "Admin access code",
    group: "orchestrator",
    tier: "core",
    onAdminPath: true,
    run: ({ env }) => {
      if (!env.ADMIN_ACCESS_CODE) return [{ state: "not-applicable", detail: "ADMIN_ACCESS_CODE not set" }];
      if (effectiveAccessCode(env.ADMIN_ACCESS_CODE) === null) {
        return [{
          state: "fail",
          detail: "ADMIN_ACCESS_CODE is the published .env.example placeholder, so the orchestrator refuses it",
          fix: "Set a real access code, or unset ADMIN_ACCESS_CODE and sign in with SSO.",
        }];
      }
      return [{ state: "pass", detail: "Set, and not the placeholder" }];
    },
  },
  {
    id: "env.runner-mode",
    title: "Runner mode variable",
    group: "orchestrator",
    tier: "core",
    onAdminPath: false,
    run: ({ env }) => {
      if (!env.RUNNER_MODE) return [{ state: "pass", detail: "RUNNER_MODE not set, so the stored runner mode applies" }];
      if (isRunnerMode(env.RUNNER_MODE)) return [{ state: "pass", detail: `RUNNER_MODE=${env.RUNNER_MODE}` }];
      return [{
        state: "warn",
        detail: `RUNNER_MODE=${env.RUNNER_MODE} is not a runner mode, so it is ignored`,
        fix: `Set RUNNER_MODE to one of ${VALID_RUNNER_MODES.join(", ")}, or unset it.`,
      }];
    },
  },
  {
    id: "env.poll-interval",
    title: "Poll interval",
    group: "orchestrator",
    tier: "core",
    onAdminPath: false,
    run: ({ env }) => {
      const raw = env.POLL_INTERVAL_MS;
      const ms = parsePollIntervalMs(raw);
      if (!raw) return [{ state: "pass", detail: `POLL_INTERVAL_MS not set, so the poll runs every ${ms} ms` }];
      const runsAsSet = ms > 0 && ms <= MAX_POLL_INTERVAL_MS;
      if (runsAsSet && /^\d+$/.test(raw)) return [{ state: "pass", detail: `The poll runs every ${ms} ms` }];
      return [{
        state: "fail",
        detail: `POLL_INTERVAL_MS=${raw} is read as ${ms}, so the poll runs ${runsAsSet ? `every ${ms} ms` : "every millisecond"}`,
        fix: "Set POLL_INTERVAL_MS to a whole number of milliseconds, such as 60000, or unset it.",
      }];
    },
  },
  {
    id: "env.breaker-threshold",
    title: "Dispatch breaker threshold",
    group: "orchestrator",
    tier: "core",
    onAdminPath: false,
    run: ({ env }) => {
      const raw = env.DISPATCH_BREAKER_THRESHOLD;
      const value = parseBreakerThreshold(raw);
      if (value > 0) {
        const parks = `an issue parks after ${Math.ceil(value)} failures`;
        return [{ state: "pass", detail: raw === undefined ? `DISPATCH_BREAKER_THRESHOLD not set, so ${parks}` : `So ${parks}` }];
      }
      return [{
        state: "fail",
        detail: `DISPATCH_BREAKER_THRESHOLD=${raw} is read as ${value}, which turns the breaker off`,
        fix: "Unset DISPATCH_BREAKER_THRESHOLD (default 3) or set a positive number.",
      }];
    },
  },
  {
    id: "settings.seeded",
    title: "Seed-once variables",
    group: "orchestrator",
    tier: "core",
    onAdminPath: false,
    run: ({ env, readSetting }) => {
      const findings: string[] = [];
      for (const setting of SEED_ONCE_SETTINGS) {
        const seed = setting.seedValue(env[setting.variable]);
        if (seed === null) continue;
        const row = readSetting(setting.key);
        if (typeof seed !== "string") findings.push(`${setting.variable} is invalid (${seed.error}), so it has no effect.`);
        else if (row === null) findings.push(`${setting.variable} has no saved value, so the next boot saves it again.`);
        else if (row !== seed) findings.push(`${setting.variable} differs from the value saved on ${setting.page}, so it has no effect.`);
      }
      if (findings.length === 0) return [{ state: "pass", detail: "No seed-once variable conflicts with its saved value" }];
      return [{
        state: "warn",
        detail: findings.join(" "),
        fix: "Change each setting on its admin page, then remove the variable from the environment.",
      }];
    },
  },
  {
    id: "settings.env-override",
    title: "Variables that override saved settings",
    group: "orchestrator",
    tier: "core",
    onAdminPath: false,
    run: ({ env, readSetting }) => {
      const findings: string[] = [];
      const mode = resolveRunnerMode(env.RUNNER_MODE, null);
      const savedMode = resolveRunnerMode(undefined, readSetting(RUNNER_MODE_SETTING_KEY));
      if (mode.source === "env" && savedMode.source === "db" && mode.mode !== savedMode.mode) {
        findings.push(`RUNNER_MODE=${mode.mode} overrides the runner mode saved on /admin#runners (${savedMode.mode}).`);
      }
      const secrets = resolveFlyProcessLevelSecrets(env.FLY_PROCESS_LEVEL_SECRETS, null);
      const savedSecrets = resolveFlyProcessLevelSecrets(undefined, readSetting(FLY_PROCESS_LEVEL_SECRETS_SETTING_KEY));
      if (secrets.source === "env" && savedSecrets.source === "db" && secrets.enabled !== savedSecrets.enabled) {
        findings.push(`FLY_PROCESS_LEVEL_SECRETS overrides the setting saved on /admin#runners (${savedSecrets.enabled ? "on" : "off"}).`);
      }
      if (findings.length === 0) return [{ state: "pass", detail: "No variable overrides a saved runner setting" }];
      return [{ state: "warn", detail: findings.join(" "), fix: "Unset the variable and restart, so the saved setting applies." }];
    },
  },
  {
    id: "settings.allowlist-env",
    title: "Allowlist variables",
    group: "orchestrator",
    tier: "core",
    onAdminPath: false,
    run: ({ env, storedAccessEntries }) => {
      if (allowlistFromEnv(env).length === 0) {
        return [{ state: "pass", detail: "Neither OAUTH_ALLOWED_DOMAINS nor OAUTH_ALLOWED_EMAILS admits anyone" }];
      }
      if (storedAccessEntries().length === 0) {
        return [{ state: "pass", detail: "The OAUTH_ALLOWED_* variables are in force, since no list is saved at /admin#access" }];
      }
      return [{
        state: "warn",
        detail: "The OAUTH_ALLOWED_* variables admit people, but the list saved at /admin#access is in force, so they have no effect",
        fix: "Remove OAUTH_ALLOWED_DOMAINS and OAUTH_ALLOWED_EMAILS from the environment.",
      }];
    },
  },
  {
    id: "volume.database",
    title: "Database location",
    group: "orchestrator",
    tier: "core",
    onAdminPath: true,
    run: ({ env, databasePath, onSeparateFilesystem }) => {
      const db = databasePath();
      if (db.fellBack) {
        return [{
          state: "fail",
          detail: `The directory of ${db.configured} could not be created, so the database fell back to ${db.path}`,
          fix: "Make that directory writable, or set DEDUP_DB_PATH to a writable path. On Fly, mount the volume at /data in fly.toml.",
        }];
      }
      if (!env.FLY_APP_NAME) return [{ state: "pass", detail: `The database is ${db.path}` }];
      if (onSeparateFilesystem(dirname(db.path))) {
        return [{ state: "pass", detail: `The database is ${db.path}, on a mounted volume` }];
      }
      return [{
        state: "fail",
        detail: `The database is ${db.path}, on the machine's root filesystem rather than a mounted volume, so a restart or deploy loses it`,
        fix: "Mount a volume over the database directory in fly.toml, under [[mounts]] with destination = \"/data\".",
      }];
    },
  },
  {
    id: "restate",
    title: "Restate engine",
    group: "orchestrator",
    tier: "core",
    onAdminPath: true,
    run: ({ restateStatus }) => {
      const { sidecar, registration } = restateStatus();
      const detail = `The sidecar is ${sidecar.state} and the endpoint registration is ${registration.state}`;
      if (sidecar.state === "ready" && registration.state === "registered") return [{ state: "pass", detail }];
      return [{ state: "fail", detail, fix: "Read the [restate] lines in the orchestrator log, which name the cause. The orchestrator does not dispatch until Restate serves." }];
    },
  },
  {
    id: "callback.config",
    title: "Runner callback",
    group: "orchestrator",
    tier: "core",
    onAdminPath: false,
    run: ({ env }) => {
      const callback = resolveRunnerCallbackBaseUrl(env);
      const missing = missingRunnerCallbackConfig({
        runnerCallbackBaseUrl: callback.url,
        runnerTokenSecret: env.RUNNER_TOKEN_SECRET || null,
      });
      if (missing.length > 0) {
        return [{
          state: "fail",
          detail: `${missing.join(" and ")} not set, so runs cannot report back and planning is refused`,
          fix: "Set RUNNER_CALLBACK_BASE_URL to the orchestrator's public address and RUNNER_TOKEN_SECRET to a long random value.",
        }];
      }
      const derived = callback.source === "local-default" ? ", derived for RUNNER_MODE=local" : "";
      return [{ state: "pass", detail: `Runs report to ${callback.url}${derived}` }];
    },
  },
  {
    id: "callback.reachable",
    title: "Runner callback reachable",
    group: "orchestrator",
    tier: "core",
    onAdminPath: false,
    run: async ({ env, runnerMode, orchestratorHealthAt, orchestratorInstanceId }) => {
      const { url } = resolveRunnerCallbackBaseUrl(env);
      if (!url) return [{ state: "cannot-verify", detail: "No callback address is set, so there is none to reach", fix: "More information is needed. Address the callback.config check first." }];
      // A local runner reaches the orchestrator through host.docker.internal, which resolves inside its container only.
      if (runnerMode().mode === "local") return [{ state: "not-applicable", detail: "The runner mode is local, so runs reach the orchestrator from containers on this host" }];
      if (hostnameOf(url) === "host.docker.internal") return [{ state: "not-applicable", detail: `${url} resolves only inside a local runner's container` }];
      const read = await orchestratorHealthAt(url);
      if (read.outcome === "health-body") {
        if (read.instanceId === orchestratorInstanceId()) return [{ state: "pass", detail: `${url} answered as this orchestrator, so runs can report their results there` }];
        return [{
          state: "fail",
          detail: `${url} answered as a different orchestrator, which refuses this one's runs, so a finished run's results would be lost`,
          fix: "Set RUNNER_CALLBACK_BASE_URL to this orchestrator's own public address.",
        }];
      }
      const seen = read.outcome === "other-response"
        ? `${url} answered HTTP ${read.status} without the orchestrator's health response, so it reaches a proxy, a tunnel, another site, or a path the orchestrator does not serve`
        : read.timedOut
          ? `Nothing answered at ${url} within ${ORCHESTRATOR_HEALTH_TIMEOUT_MS / 1000} seconds`
          : `${url} could not be reached (${read.error})`;
      return [{
        state: "fail",
        detail: `${seen}. Runs report their results there, so a finished run would report nowhere.`,
        fix: "Check RUNNER_CALLBACK_BASE_URL for a typo, then that its DNS name, and any proxy or tunnel in front of it, lead to this orchestrator.",
      }];
    },
  },
  {
    id: "runner.fly-sessions",
    title: "Fly sessions",
    group: "orchestrator",
    tier: "mode",
    onAdminPath: false,
    run: ({ runnerMode, mappings, flySessions, runnerBackendSource }) => {
      const mode = runnerMode().mode;
      const onFly = Object.entries(mappings())
        .filter(([, mapping]) => ["fly-machines", "both"].includes(resolveExecutionPath(mode, mapping.executionMode)))
        .map(([key]) => key);
      if (onFly.length === 0) return [{ state: "not-applicable", detail: "No project runs on Fly Machines" }];
      if (runnerBackendSource() === "not-loaded") return [{
        state: "fail",
        detail: "Restate has not answered yet, so the sessions app cannot be read",
        fix: "Wait for Restate to serve; read the [restate] lines in the orchestrator log.",
      }];
      const fly = flySessions();
      const missing = [fly.token ? null : "FLY_SESSIONS_TOKEN", fly.app ? null : "the sessions app"].filter((name) => name !== null);
      if (missing.length === 0) {
        return [{ state: "pass", detail: `Projects on Fly Machines: ${onFly.join(", ")}. The token and the sessions app are set.` }];
      }
      return [{
        state: "fail",
        detail: `${missing.join(" and ")} not set, so these projects cannot dispatch on Fly Machines: ${onFly.join(", ")}`,
        fix: "Set FLY_SESSIONS_TOKEN, and save the sessions app on /admin#settings.",
      }];
    },
  },
  {
    id: "admin.path",
    title: "Admin sign-in",
    group: "orchestrator",
    tier: "core",
    onAdminPath: true,
    run: ({ env }) => {
      const providers = resolveProviders(env).providers.map((p) => p.id);
      const codeSet = effectiveAccessCode(env.ADMIN_ACCESS_CODE) !== null;
      if (providers.length === 0 && !codeSet) {
        return [{
          state: "fail",
          detail: "No sign-in provider is configured and ADMIN_ACCESS_CODE is not set, so /admin and every /api/ route answer 503",
          fix: "Configure a sign-in provider (preferred), or set ADMIN_ACCESS_CODE.",
        }];
      }
      const paths = [...(providers.length > 0 ? [`SSO (${providers.join(", ")})`] : []), ...(codeSet ? ["the access code"] : [])];
      return [{ state: "pass", detail: `Admins sign in with ${paths.join(" and ")}` }];
    },
  },
  {
    id: "admin.providers",
    title: "Sign-in providers",
    group: "orchestrator",
    tier: "core",
    onAdminPath: true,
    run: ({ env }) => {
      const { dropped } = resolveProviders(env);
      if (dropped.length === 0) return [{ state: "pass", detail: "No sign-in provider is partly configured" }];
      return [{
        state: "warn",
        detail: dropped.map(({ id, reason }) => `${id} is disabled: ${reason}.`).join(" "),
        fix: "Correct each variable named, or unset that provider's variables.",
      }];
    },
  },
  {
    id: "admin.redirect-url",
    title: "Sign-in return address",
    group: "orchestrator",
    tier: "core",
    onAdminPath: true,
    run: ({ env }) => {
      if (resolveProviders(env).providers.length === 0) return [{ state: "not-applicable", detail: "No sign-in provider is configured" }];
      if (env.OAUTH_REDIRECT_BASE_URL) return [{ state: "pass", detail: `Sign-in returns to ${env.OAUTH_REDIRECT_BASE_URL}` }];
      return [{
        state: "fail",
        detail: "A sign-in provider is configured but OAUTH_REDIRECT_BASE_URL is not set, so every sign-in route answers 503",
        fix: "Set OAUTH_REDIRECT_BASE_URL to the orchestrator's public address.",
      }];
    },
  },
  {
    id: "admin.allowlist",
    title: "Admin in the sign-in allowlist",
    group: "orchestrator",
    tier: "core",
    onAdminPath: true,
    run: ({ env, effectiveAllowlist }) => {
      const providers = resolveProviders(env).providers.map((p) => p.id);
      if (providers.length === 0) return [{ state: "not-applicable", detail: "No sign-in provider is configured" }];
      if (providers.includes("builddown")) {
        return [{
          state: "pass",
          detail: "BuildDown sign-in is configured, so owners and admins of the BuildDown organization are admins through its role claim, which /admin#access neither lists nor overrides",
        }];
      }
      const list = effectiveAllowlist();
      if (list === null) {
        return [{ state: "cannot-verify", detail: "The sign-in allowlist could not be read", fix: "Read the [access] lines in the orchestrator log." }];
      }
      if (hasAdminAddress(list.entries)) return [{ state: "pass", detail: "The sign-in allowlist names an admin address" }];
      if (effectiveAccessCode(env.ADMIN_ACCESS_CODE) !== null) {
        return [{ state: "pass", detail: "The sign-in allowlist names no admin, but the access code still reaches admin" }];
      }
      return [{
        state: "fail",
        detail: list.entries.length === 0
          ? "The sign-in allowlist is empty, so sign-in admits nobody"
          : "The sign-in allowlist names no admin address, so nobody can administer this orchestrator",
        fix: "Add an admin address to OAUTH_ALLOWED_EMAILS. A domain admits its addresses as user only.",
      }];
    },
  },
];
