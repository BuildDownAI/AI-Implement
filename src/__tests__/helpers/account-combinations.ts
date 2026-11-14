import type { AccountAuthMode, ModelProvider, StageAgent } from "../../agent-config.js";

const legal = new Set([
  "claude/anthropic/anthropic-api-key", "claude/anthropic/claude-subscription",
  "claude/bedrock/bedrock", "codex/openai/openai-api-key", "codex/openai/codex-subscription",
  "claude/openrouter/openrouter-api-key", "codex/openrouter/openrouter-api-key",
]);

/** Exhaustive matrix shared by the save, resolution and dispatch validation tests. */
export const accountCombinations = (["claude", "codex"] as StageAgent[]).flatMap(agent =>
  (["anthropic", "bedrock", "openai", "openrouter"] as ModelProvider[]).flatMap(provider =>
    (["anthropic-api-key", "bedrock", "claude-subscription", "openai-api-key", "codex-subscription", "openrouter-api-key"] as AccountAuthMode[])
      .map(authMode => ({ agent, provider, authMode, permitted: legal.has(`${agent}/${provider}/${authMode}`) }))));
