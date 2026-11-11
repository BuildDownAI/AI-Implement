export const STAGE_AGENT_CONFIG_VERSION = 1;
export const STAGE_NAMES = ["planning", "implementation", "review"] as const;
export const STAGE_SELECTION_FIELDS = ["agent", "provider", "model", "accountProfileId", "invocationTimeoutMs"] as const;

export const STORED_STAGE_SELECTION_FIELDS = [...STAGE_SELECTION_FIELDS, "fallbackModel", "accounts"] as const;
export type StoredStageSelectionField = (typeof STORED_STAGE_SELECTION_FIELDS)[number];

export type StageName = (typeof STAGE_NAMES)[number];
export type StageSelectionField = (typeof STAGE_SELECTION_FIELDS)[number];
export type StageAgent = "claude" | "codex";
export type ModelProvider = "anthropic" | "bedrock" | "openai";
export type AccountAuthMode =
  | "anthropic-api-key"
  | "bedrock"
  | "claude-subscription"
  | "openai-api-key"
  | "codex-subscription";
export type StageConfigMode = "legacy" | "configured";
export type FieldSource = "orchestrator-default" | "project" | "job-deadline";

export interface AccountProfile {
  id: string;
  identity: string;
  revision: number;
  agent: StageAgent;
  provider: ModelProvider;
  authMode: AccountAuthMode;
  disabled?: boolean;
}

export interface StageSelection {
  agent: StageAgent;
  provider: ModelProvider;
  model: string;
  accountProfileId: string;
  invocationTimeoutMs: number;
}

export type StageSelectionPatch = {
  [K in StageSelectionField]?: StageSelection[K] | null;
} & { fallbackModel?: string | null; accounts?: AccountEntry[] };

export interface AccountEntry { accountProfileId: string; model: string }
export interface StageAccount extends AccountEntry {
  profileRevision: number; agent: StageAgent; provider: ModelProvider; authMode: AccountAuthMode;
}
export type AccountFailure = "resolution_failed" | "unsupported_combination";
export interface StageAccountSelection { chosen: number; skipped: { index: number; accountProfileId: string; reason: AccountFailure }[] }
export class StageAccountError extends Error {
  constructor(stage: StageName, public code: AccountFailure) {
    super(`${stage}.accounts: no entry resolves (${code})`);
  }
}
/** Evaluate each candidate once so selection and fallbacks share exactly the same checks. */
export function chooseStageAccount(entries: readonly StageAccount[], check: (entry: StageAccount) => AccountFailure | null) {
  const normalized = entries.map(entry => ({ ...entry, model: entry.model.trim() ? entry.model : entries[0].model }));
  const results = normalized.map(check);
  const index = results.findIndex(reason => reason === null);
  if (index < 0) return { chosen: null, failure: results[0] ?? "resolution_failed", skipped: [], fallbacks: [] } as const;
  return {
    chosen: { index, ...normalized[index] },
    skipped: normalized.slice(0, index).map((entry, i) => ({ index: i, accountProfileId: entry.accountProfileId, reason: results[i]! })),
    fallbacks: normalized.filter((_, i) => i > index && results[i] === null),
  };
}

export function validateAccounts(value: unknown, stage: string): asserts value is AccountEntry[] {
  if (!Array.isArray(value) || !value.length) throw new Error(`${stage}.accounts[0] must be a non-empty account list`);
  value.forEach((entry, index) => {
    if (!isRecord(entry) || Object.keys(entry).some(k => !["accountProfileId", "model"].includes(k)) ||
        typeof entry.accountProfileId !== "string" || !entry.accountProfileId.trim() || typeof entry.model !== "string" ||
        (index === 0 && !entry.model.trim())) throw new Error(`${stage}.accounts[${index}] is malformed`);
  });
}

export function validateDefaultAccounts(config: StageAgentConfigurationV1, profiles: readonly AccountProfile[]): StageAgentConfigurationV1 {
  const result = structuredClone(config);
  for (const stage of STAGE_NAMES) {
    const patch = result.stages?.[stage];
    if (!patch?.accounts) continue;
    validateAccounts(patch.accounts, stage);
    const seen = new Set<string>();
    let subscription = false;
    let first: AccountProfile | undefined;
    for (const [index, entry] of patch.accounts.entries()) {
      const context = `${stage}.accounts[${index}]`;
      const profile = profiles.find(p => p.id === entry.accountProfileId);
      try {
        if (!profile) throw new Error();
        validateAgentProvider(stage, { ...patch, ...entry, agent: profile.agent, provider: profile.provider } as StageSelection, profile);
      } catch { throw new Error(`${context} does not resolve`); }
      if (seen.has(entry.accountProfileId)) throw new Error(`${context} repeats a profile`);
      seen.add(entry.accountProfileId);
      first ??= profile;
      if (profile.agent !== first.agent && !entry.model.trim()) throw new Error(`${context} requires a model for another agent`);
      const isSubscription = profile.authMode.endsWith("subscription");
      if (subscription && !isSubscription) throw new Error(`${context} cannot use paid API after subscription`);
      subscription ||= isSubscription;
    }
    Object.assign(patch, patch.accounts[0], { agent: first!.agent, provider: first!.provider });
    if (patch.accounts.length === 1) delete patch.accounts;
  }
  return result;
}

export interface StageAgentConfigurationV1 {
  version: 1;
  mode: StageConfigMode;
  stages?: Partial<Record<StageName, StageSelectionPatch>>;
}

export interface LegacyStageResolution {
  mode: "legacy";
}

export interface ConfiguredStageResolution {
  mode: "configured";
  stages: Record<StageName, StageSelection>;
  sources: Record<StageName, Record<StageSelectionField, FieldSource>>;
  accountEntries?: Partial<Record<StageName, { index: number; accountProfileId: string; model: string; passes: boolean; reason: AccountFailure | null }[]>>;
  selection: Partial<Record<StageName, StageAccountSelection>>;
  accountFallbacks: Partial<Record<StageName, StageAccount[]>>;
  fallbackModels: Partial<Record<StageName, string>>;
  fallbackModelSources: Partial<Record<StageName, FieldSource>>;
  profiles: Record<StageName, Pick<AccountProfile, "id" | "identity" | "revision" | "agent" | "provider" | "authMode">>;
}

export type StageConfigResolution = LegacyStageResolution | ConfiguredStageResolution;

export interface ResolveStageAgentConfigInput {
  orchestratorDefaults: StageAgentConfigurationV1;
  projectConfig?: StageAgentConfigurationV1 | null;
  accountProfiles: readonly AccountProfile[];
  remainingJobMs?: number;
  checkAccount?: (entry: StageAccount) => AccountFailure | null;
}

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertKnownKeys(value: UnknownRecord, known: readonly string[], context: string): void {
  const unknown = Object.keys(value).filter((key) => !known.includes(key));
  if (unknown.length > 0) {
    throw new Error(`${context} contains unknown key(s)`);
  }
}

export function validateFallbackModel(value: unknown, stage: string): void {
  if (value !== undefined && value !== null && (typeof value !== "string" || value.trim() === "")) {
    throw new Error(`${stage}.fallbackModel must be a non-empty string`);
  }
}

function validateConfigShape(config: StageAgentConfigurationV1, name: string): void {
  if (!isRecord(config)) throw new Error(`${name} must be an object`);
  assertKnownKeys(config, ["version", "mode", "stages"], name);
  if (config.version !== STAGE_AGENT_CONFIG_VERSION) {
    throw new Error(`${name} has unsupported version`);
  }
  if (config.mode !== "legacy" && config.mode !== "configured") {
    throw new Error(`${name}.mode must be legacy or configured`);
  }
  if (config.stages === undefined) return;
  if (!isRecord(config.stages)) throw new Error(`${name}.stages must be an object`);
  assertKnownKeys(config.stages, STAGE_NAMES, `${name}.stages`);
  for (const stage of STAGE_NAMES) {
    const patch = config.stages[stage];
    if (patch === undefined) continue;
    if (!isRecord(patch)) throw new Error(`${name}.stages.${stage} must be an object`);
    if (patch.accounts !== undefined) {
      if (name === "projectConfig") throw new Error("accounts is only supported in orchestrator defaults");
      validateAccounts(patch.accounts, stage);
    }
    validateFallbackModel(patch.fallbackModel, stage);
    assertKnownKeys(patch, STORED_STAGE_SELECTION_FIELDS, `${name}.stages.${stage}`);
  }
}

function asStageSelection(value: Partial<Record<StageSelectionField, unknown>>, stage: StageName): StageSelection {
  for (const field of STAGE_SELECTION_FIELDS) {
    if (value[field] === undefined || value[field] === null || value[field] === "") {
      throw new Error(`${stage}.${field} is required`);
    }
  }
  const selection = value as StageSelection;
  if (selection.agent !== "claude" && selection.agent !== "codex") {
    throw new Error(`${stage}.agent is unsupported`);
  }
  if (selection.provider !== "anthropic" && selection.provider !== "bedrock" && selection.provider !== "openai") {
    throw new Error(`${stage}.provider is unsupported`);
  }
  if (typeof selection.model !== "string" || selection.model.trim() === "") {
    throw new Error(`${stage}.model must be a non-empty string`);
  }
  if (typeof selection.accountProfileId !== "string" || selection.accountProfileId.trim() === "") {
    throw new Error(`${stage}.accountProfileId must be a non-empty string`);
  }
  if (
    typeof selection.invocationTimeoutMs !== "number" ||
    !Number.isInteger(selection.invocationTimeoutMs) ||
    selection.invocationTimeoutMs <= 0
  ) {
    throw new Error(`${stage}.invocationTimeoutMs must be a positive integer`);
  }
  return {
    agent: selection.agent,
    provider: selection.provider,
    model: selection.model,
    accountProfileId: selection.accountProfileId,
    invocationTimeoutMs: selection.invocationTimeoutMs,
  };
}

function validateAgentProvider(stage: StageName, selection: StageSelection, profile: AccountProfile): void {
  validateAccountProfile(profile);
  if (profile.disabled) throw new Error(`${stage}.accountProfileId is disabled`);
  if (profile.agent !== selection.agent) {
    throw new Error(`${stage}.accountProfileId agent does not match selected agent`);
  }
  if (profile.provider !== selection.provider) {
    throw new Error(`${stage}.accountProfileId provider does not match selected provider`);
  }
  if (selection.agent === "claude") {
    if (selection.provider === "anthropic" && profile.authMode === "anthropic-api-key") return;
    if (selection.provider === "anthropic" && profile.authMode === "claude-subscription") return;
    if (selection.provider === "bedrock" && profile.authMode === "bedrock") return;
    throw new Error(`${stage} has unsupported Claude provider/authentication combination`);
  }
  if (selection.provider === "openai" && (profile.authMode === "openai-api-key" || profile.authMode === "codex-subscription")) {
    return;
  }
  throw new Error(`${stage} has unsupported Codex provider/authentication combination`);
}

function validateAccountProfile(profile: AccountProfile): void {
  if (!isRecord(profile)) throw new Error("account profile must be an object");
  if (typeof profile.id !== "string" || profile.id.trim() === "") {
    throw new Error("account profile id must be a non-empty string");
  }
  if (typeof profile.identity !== "string" || profile.identity.trim() === "") {
    throw new Error("account profile identity must be a non-empty string");
  }
  if (!Number.isInteger(profile.revision) || profile.revision <= 0) {
    throw new Error("account profile revision must be a positive integer");
  }
  if (profile.agent !== "claude" && profile.agent !== "codex") {
    throw new Error("account profile agent is unsupported");
  }
  if (profile.provider !== "anthropic" && profile.provider !== "bedrock" && profile.provider !== "openai") {
    throw new Error("account profile provider is unsupported");
  }
  if (
    profile.authMode !== "anthropic-api-key" &&
    profile.authMode !== "bedrock" &&
    profile.authMode !== "claude-subscription" &&
    profile.authMode !== "openai-api-key" &&
    profile.authMode !== "codex-subscription"
  ) {
    throw new Error("account profile authentication mode is unsupported");
  }
  if (profile.disabled !== undefined && typeof profile.disabled !== "boolean") {
    throw new Error("account profile disabled flag must be a boolean");
  }
}

function resolveStage(
  stage: StageName,
  defaults: StageSelectionPatch | undefined,
  override: StageSelectionPatch | undefined,
  remainingJobMs: number | undefined,
): { selection: StageSelection; sources: Record<StageSelectionField, FieldSource> } {
  const merged: Partial<Record<StageSelectionField, unknown>> = {};
  const sources = {} as Record<StageSelectionField, FieldSource>;
  for (const field of STAGE_SELECTION_FIELDS) {
    const projectValue = override?.[field];
    if (projectValue !== undefined && projectValue !== null) {
      merged[field] = projectValue;
      sources[field] = "project";
      continue;
    }
    merged[field] = defaults?.[field];
    sources[field] = "orchestrator-default";
  }
  const selection = asStageSelection(merged, stage);
  if (remainingJobMs !== undefined) {
    if (!Number.isInteger(remainingJobMs) || remainingJobMs <= 0) throw new Error("remainingJobMs must be a positive integer");
    if (selection.invocationTimeoutMs > remainingJobMs) {
      selection.invocationTimeoutMs = remainingJobMs;
      sources.invocationTimeoutMs = "job-deadline";
    }
  }
  return { selection, sources };
}

/** Shared effective merge and checks for preparation and current diagnostics. */
function stageAccountCandidates(input: ResolveStageAgentConfigInput, stage: StageName, profileById: Map<string, AccountProfile>) {
  const defaults = input.orchestratorDefaults.stages?.[stage];
  const override = input.projectConfig?.stages?.[stage];
  const first = defaults?.accounts?.[0];
  const firstProfile = first && profileById.get(first.accountProfileId);
  const base = first ? { ...defaults, ...first, agent: firstProfile?.agent ?? defaults?.agent ?? "claude", provider: firstProfile?.provider ?? defaults?.provider ?? "anthropic" } : defaults;
  const resolved = resolveStage(stage, base, override, input.remainingJobMs);
  const raw = defaults?.accounts && override?.accountProfileId == null ? defaults.accounts : [{ accountProfileId: resolved.selection.accountProfileId, model: resolved.selection.model }];
  const entries = raw.map((entry, index) => {
    const p = profileById.get(entry.accountProfileId);
    return { ...entry, ...(index === 0 ? resolved.selection : {}), profileRevision: p?.revision ?? 0,
      agent: index === 0 ? resolved.selection.agent : p?.agent!, provider: index === 0 ? resolved.selection.provider : p?.provider!, authMode: p?.authMode! };
  });
  const check = (entry: StageAccount): AccountFailure | null => {
    const p = profileById.get(entry.accountProfileId);
    try { if (!p) throw new Error(); validateAgentProvider(stage, { ...resolved.selection, ...entry }, p); }
    catch { return "resolution_failed"; }
    return input.checkAccount?.(entry) ?? null;
  };
  return { resolved, entries, check };
}

export function resolveStageAgentConfig(input: ResolveStageAgentConfigInput): StageConfigResolution {
  if (input.projectConfig === null || input.projectConfig === undefined) return { mode: "legacy" };
  validateConfigShape(input.projectConfig, "projectConfig");
  if (input.projectConfig.mode === "legacy") return { mode: "legacy" };
  validateConfigShape(input.orchestratorDefaults, "orchestratorDefaults");
  if (input.orchestratorDefaults.mode !== "configured") {
    throw new Error("project opted into stage configuration but orchestrator defaults are not configured");
  }

  const profileById = new Map<string, AccountProfile>();
  for (const profile of input.accountProfiles) {
    validateAccountProfile(profile);
    if (profileById.has(profile.id)) throw new Error("account profile id must be unique");
    profileById.set(profile.id, profile);
  }
  const stages = {} as Record<StageName, StageSelection>;
  const sources = {} as Record<StageName, Record<StageSelectionField, FieldSource>>;
  const profiles = {} as ConfiguredStageResolution["profiles"];
  const fallbackModels: ConfiguredStageResolution["fallbackModels"] = {};
  const fallbackModelSources: ConfiguredStageResolution["fallbackModelSources"] = {};

  const selection: ConfiguredStageResolution["selection"] = {};
  const accountFallbacks: ConfiguredStageResolution["accountFallbacks"] = {};
  for (const stage of STAGE_NAMES) {
    const defaults = input.orchestratorDefaults.stages?.[stage];
    const { resolved, entries, check } = stageAccountCandidates(input, stage, profileById);
    const projectFallback = input.projectConfig.stages?.[stage]?.fallbackModel;
    const fallback = projectFallback ?? input.orchestratorDefaults.stages?.[stage]?.fallbackModel;
    if (fallback != null) {
      fallbackModels[stage] = fallback;
      fallbackModelSources[stage] = projectFallback != null ? "project" : "orchestrator-default";
    }
    const choice = chooseStageAccount(entries, check);
    if (!choice.chosen) {
      // Preserve the existing fixed resolver messages for flat configurations.
      if (!defaults?.accounts && choice.failure === "resolution_failed") {
        const p = profileById.get(resolved.selection.accountProfileId);
        if (!p) throw new Error(`${stage}.accountProfileId does not reference a known profile`);
        validateAgentProvider(stage, resolved.selection, p);
      }
      throw new StageAccountError(stage, choice.failure);
    }
    if (defaults?.accounts) {
      selection[stage] = { chosen: choice.chosen.index, skipped: choice.skipped };
      if (choice.fallbacks.length) accountFallbacks[stage] = choice.fallbacks;
    }
    if (choice.chosen.index > 0) {
      // Later entries supply their own profile fields; a blank model inherits
      // the first candidate's effective model, including its project override.
      for (const field of ["accountProfileId", "agent", "provider"] as const) {
        resolved.sources[field] = "orchestrator-default";
      }
      if (entries[choice.chosen.index].model.trim()) resolved.sources.model = "orchestrator-default";
    }
    for (const field of ["accountProfileId", "agent", "provider", "model"] as const) resolved.selection[field] = choice.chosen[field] as never;
    if (fallback === resolved.selection.model) {
      if (!defaults?.accounts || input.projectConfig.stages?.[stage]?.accountProfileId != null) {
        throw new Error(`${stage}.fallbackModel must differ from model`);
      }
      // Backend selection can make the stage fallback redundant for this run.
      delete fallbackModels[stage];
      delete fallbackModelSources[stage];
    }
    const profile = profileById.get(resolved.selection.accountProfileId);
    if (!profile) throw new Error(`${stage}.accountProfileId does not reference a known profile`);
    validateAgentProvider(stage, resolved.selection, profile);
    stages[stage] = resolved.selection;
    sources[stage] = resolved.sources;
    profiles[stage] = {
      id: profile.id,
      identity: profile.identity,
      revision: profile.revision,
      agent: profile.agent,
      provider: profile.provider,
      authMode: profile.authMode,
    };
  }

  return { mode: "configured", stages, sources, profiles, fallbackModels, fallbackModelSources, selection, accountFallbacks, accountEntries: inspectStageAccounts(input) };
}

/** Current checks for the resolved admin view, including stages with no usable account. */
export function inspectStageAccounts(input: ResolveStageAgentConfigInput): NonNullable<ConfiguredStageResolution["accountEntries"]> {
  const entries: NonNullable<ConfiguredStageResolution["accountEntries"]> = {};
  for (const stage of STAGE_NAMES) {
    let candidates: ReturnType<typeof stageAccountCandidates>;
    try {
      candidates = stageAccountCandidates(input, stage, new Map(input.accountProfiles.map(p => [p.id, p])));
    } catch {
      // Diagnostics must remain available when a stage cannot form a complete
      // selection (for example after defaults are returned to legacy mode).
      entries[stage] = [];
      continue;
    }
    const firstModel = candidates.entries[0].model;
    entries[stage] = candidates.entries.map((entry, index) => {
      const normalized = { ...entry, model: entry.model.trim() ? entry.model : firstModel };
      const reason = candidates.check(normalized);
      return { index, accountProfileId: entry.accountProfileId, model: normalized.model, passes: reason === null, reason };
    });
  }
  return entries;
}

export function describeInvocationLimit(selection: Pick<StageSelection, "agent" | "invocationTimeoutMs">): string {
  if (selection.agent === "claude") {
    return `Claude native turn limits remain separate; this stage also has an elapsed timeout of ${selection.invocationTimeoutMs}ms.`;
  }
  return `Codex is bounded by elapsed time (${selection.invocationTimeoutMs}ms) and the existing AI-Implement loop iteration cap.`;
}
