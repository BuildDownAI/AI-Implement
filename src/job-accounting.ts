import type { RepoMapping } from "./config.js";
import type { TicketingProvider } from "./providers/types.js";

/** The tracker facts a job row saves at dispatch time, since the mapping can change after the job. */
export interface TrackerAccounting {
  trackerKind: string;
  issueUrl: string | null;
}

/** Tracker kind and issue URL for a job whose issue is known only by id, identifier and title (a gap-fill run). */
export function trackerAccounting(
  mapping: RepoMapping,
  provider: TicketingProvider | null,
  issue: { id: string; identifier?: string | null; title?: string | null },
): TrackerAccounting {
  let issueUrl: string | null = null;
  if (provider) {
    try {
      issueUrl = provider.issueUrl({
        id: issue.id,
        identifier: issue.identifier ?? issue.id,
        title: issue.title ?? "",
        description: null,
        scopeKey: "",
        nativeStatus: "",
      });
    } catch {
      issueUrl = null;
    }
  }
  return { trackerKind: mapping.ticketingProvider, issueUrl };
}
