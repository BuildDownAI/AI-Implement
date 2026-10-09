import type { RepoMapping } from "../config.js";
import { resolveProvider } from "./index.js";
import type { ProviderConfig, TicketIssue, TicketingProvider } from "./types.js";
import { getRunnerMode } from "../runner-mode.js";

export type KeyLookupResult =
  | { kind: "found"; provider: TicketingProvider; issue: TicketIssue; failedProviderIds: string[] }
  | { kind: "ambiguous"; providerIds: string[] }
  | { kind: "none"; failedProviderIds: string[] };

/**
 * Resolves and caches TicketingProvider instances per provider id.
 *
 * - One Linear provider serves all Linear mappings (no per-mapping state).
 * - One Jira provider per cloudId (one per orchestrator deployment in Phase 2).
 *   The Jira provider reads getMappings() on every operation to pick up admin
 *   edits without restart.
 */
export class ProviderRegistry {
  private linearProvider: Promise<TicketingProvider> | null = null;
  private jiraProvider: Promise<TicketingProvider> | null = null;
  private filesystemProvider: Promise<TicketingProvider> | null = null;

  constructor(
    private readonly config: ProviderConfig,
    private readonly getMappings: () => Record<string, RepoMapping>,
  ) {}

  async forMapping(mapping: RepoMapping): Promise<TicketingProvider> {
    if (mapping.ticketingProvider === "filesystem") {
      if (getRunnerMode().mode !== "local") {
        throw new Error("Filesystem tickets require local runner mode (RUNNER_MODE=local)");
      }
      this.filesystemProvider ??= resolveProvider("filesystem", this.config, { getMappings: this.getMappings });
      return this.filesystemProvider;
    }
    if (mapping.ticketingProvider === "linear") {
      this.linearProvider ??= resolveProvider("linear", this.config);
      return this.linearProvider;
    }
    if (mapping.ticketingProvider === "jira") {
      this.jiraProvider ??= resolveProvider("jira", this.config, { getMappings: this.getMappings });
      return this.jiraProvider;
    }
    throw new Error(`Unknown ticketingProvider on mapping: ${mapping.ticketingProvider}`);
  }

  /**
   * Returns the unique providers needed to cover all mappings (one per
   * provider id). Snapshot polling iterates this set rather than calling
   * forMapping per-mapping.
   */
  async forAllMappings(mappings: RepoMapping[]): Promise<TicketingProvider[]> {
    const ids = new Set(mappings.map((m) => m.ticketingProvider));
    const providers: TicketingProvider[] = [];
    for (const id of ids) {
      const m = mappings.find((mm) => mm.ticketingProvider === id);
      if (!m) continue;
      try {
        providers.push(await this.forMapping(m));
      } catch (err) {
        console.warn(
          `[registry] Skipping provider "${id}" — construction failed: ${(err as Error).message}`,
        );
      }
    }
    return providers;
  }

  /** Look key up in every tracker that has a mapping, in provider-id order. */
  async findByKeyInAnyTracker(key: string): Promise<KeyLookupResult> {
    const providers = (await this.forAllMappings(Object.values(this.getMappings()))).sort((a, b) =>
      a.id.localeCompare(b.id),
    );
    const settled = await Promise.allSettled(providers.map((p) => p.findByKey(key)));
    const hits: { provider: TicketingProvider; issue: TicketIssue }[] = [];
    const failedProviderIds: string[] = [];
    settled.forEach((r, i) => {
      const provider = providers[i];
      if (r.status === "rejected") failedProviderIds.push(provider.id);
      else if (r.value) hits.push({ provider, issue: r.value });
    });
    if (hits.length >= 2) return { kind: "ambiguous", providerIds: hits.map((h) => h.provider.id) };
    if (hits.length === 1) return { kind: "found", ...hits[0], failedProviderIds };
    return { kind: "none", failedProviderIds };
  }

  /** Drop cached provider instances. Called when admin upserts a mapping. */
  invalidate(): void {
    this.linearProvider = null;
    this.jiraProvider = null;
    this.filesystemProvider = null;
  }
}
