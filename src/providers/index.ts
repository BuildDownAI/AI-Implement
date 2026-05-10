import { resolveModuleImport } from "../pipeline/resolve-module.js";
import { LinearProvider } from "./linear.js";
import {
  type ProviderConfig,
  type ProviderFactory,
  type ProviderId,
  type TicketingProvider,
  UnknownProviderError,
} from "./types.js";

const BUILT_IN: Record<string, ProviderFactory> = {
  linear: (config) => new LinearProvider(config),
};

export async function resolveProvider(id: ProviderId, config: ProviderConfig): Promise<TicketingProvider> {
  const custom = await resolveModuleImport<ProviderFactory>(`providers/${id}`);
  if (custom) return custom(config);
  const builtIn = BUILT_IN[id];
  if (builtIn) return builtIn(config);
  throw new UnknownProviderError(id);
}

export function providerConfigFromEnv(): ProviderConfig {
  return {
    linearApiKey: process.env.LINEAR_API_KEY,
  };
}

export type { ProviderId, TicketingProvider, ProviderConfig } from "./types.js";
