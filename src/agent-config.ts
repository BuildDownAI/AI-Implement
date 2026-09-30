export const STAGE_AGENT_CONFIG_VERSION = 1;
export const STAGE_NAMES = ["planning", "implementation", "review"] as const;
export const STAGE_SELECTION_FIELDS = ["agent", "provider", "model", "accountProfileId", "invocationTimeoutMs"] as const;

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
  allowedProjectKeys?: readonly string[];
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
};

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
  profiles: Record<StageName, Pick<AccountProfile, "id" | "identity" | "revision" | "agent" | "provider" | "authMode">>;
}

export type StageConfigResolution = LegacyStageResolution | ConfiguredStageResolution;

export interface ResolveStageAgentConfigInput {
  projectKey: string;
  orchestratorDefaults: StageAgentConfigurationV1;
  projectConfig?: StageAgentConfigurationV1 | null;
  accountProfiles: readonly AccountProfile[];
  remainingJobMs?: number;
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
    assertKnownKeys(patch, STAGE_SELECTION_FIELDS, `${name}.stages.${stage}`);
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

function assertProfileAuthorized(stage: StageName, selection: StageSelection, profile: AccountProfile, projectKey: string): void {
  if (!Array.isArray(profile.allowedProjectKeys)) {
    throw new Error(`${stage}.accountProfileId permission metadata is required`);
  }
  if (!profile.allowedProjectKeys.includes(projectKey)) {
    throw new Error(`${stage}.accountProfileId is not authorized for this project`);
  }
  validateAgentProvider(stage, selection, profile);
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
  if (!Array.isArray(profile.allowedProjectKeys)) {
    throw new Error("account profile permission metadata is required");
  }
  for (const projectKey of profile.allowedProjectKeys) {
    if (typeof projectKey !== "string" || projectKey.trim() === "") {
      throw new Error("account profile permission metadata is malformed");
    }
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

  for (const stage of STAGE_NAMES) {
    const resolved = resolveStage(
      stage,
      input.orchestratorDefaults.stages?.[stage],
      input.projectConfig.stages?.[stage],
      input.remainingJobMs,
    );
    const profile = profileById.get(resolved.selection.accountProfileId);
    if (!profile) throw new Error(`${stage}.accountProfileId does not reference a known profile`);
    assertProfileAuthorized(stage, resolved.selection, profile, input.projectKey);
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

  return { mode: "configured", stages, sources, profiles };
}

export function describeInvocationLimit(selection: Pick<StageSelection, "agent" | "invocationTimeoutMs">): string {
  if (selection.agent === "claude") {
    return `Claude native turn limits remain separate; this stage also has an elapsed timeout of ${selection.invocationTimeoutMs}ms.`;
  }
  return `Codex is bounded by elapsed time (${selection.invocationTimeoutMs}ms) and the existing AI-Implement loop iteration cap.`;
}
