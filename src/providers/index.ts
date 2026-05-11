import { resolveModuleImport } from "../pipeline/resolve-module.js";
import { LinearProvider } from "./linear.js";
import { createJiraProviderFromConfig } from "./jira.js";
import type { RepoMapping } from "../config.js";
import {
  type ProviderConfig,
  type ProviderFactory,
  type ProviderId,
  type TicketingProvider,
  UnknownProviderError,
} from "./types.js";

export interface ResolveOptions {
  /** Required when constructing a Jira provider; ignored for Linear. */
  getMappings?: () => Record<string, RepoMapping>;
}

const BUILT_IN: Record<string, (config: ProviderConfig, opts: ResolveOptions) => TicketingProvider> = {
  linear: (config) => new LinearProvider(config),
  jira: (config, opts) => {
    if (!opts.getMappings) {
      throw new Error("resolveProvider for Jira requires opts.getMappings");
    }
    return createJiraProviderFromConfig(config, opts.getMappings);
  },
};

export async function resolveProvider(
  id: ProviderId,
  config: ProviderConfig,
  opts: ResolveOptions = {},
): Promise<TicketingProvider> {
  const custom = await resolveModuleImport<ProviderFactory>(`providers/${id}`);
  if (custom) return custom(config);
  const builtIn = BUILT_IN[id];
  if (builtIn) return builtIn(config, opts);
  throw new UnknownProviderError(id);
}

export function providerConfigFromEnv(): ProviderConfig {
  return {
    linearApiKey: process.env.LINEAR_API_KEY,
    linearWorkspaceUrl: process.env.LINEAR_WORKSPACE_URL,
    jiraToken: process.env.JIRA_TOKEN,
    jiraCloudId: process.env.JIRA_CLOUD_ID,
    jiraSiteUrl: process.env.JIRA_SITE_URL,
  };
}

export type { ProviderId, TicketingProvider, ProviderConfig } from "./types.js";
export { ProviderRegistry } from "./registry.js";
