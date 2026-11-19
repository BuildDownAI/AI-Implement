import { createAppJwt, githubAppHeaders } from "./github-app-auth.js";
import { GitHubApiError } from "./github-errors.js";
import { defaultFetchSignal } from "./github.js";

/**
 * Redelivers the GitHub App's failed webhook deliveries when Restate registers.
 *
 * The KG PR-check route (`handleKgPrCheckWebhook`) and the three review handlers on a
 * Restate-lifecycle project (AII-1184) answer 503 while Restate is unavailable; this sweep
 * recovers those deliveries.
 */
const API = "https://api.github.com";
const DEFAULT_WINDOW_MS = 24 * 60 * 60 * 1000;
// Bounds the sweep if a Link header never ends; 100 per page covers 5000 deliveries.
const MAX_PAGES = 50;
const REDELIVERED_EVENTS = new Set([
  "pull_request_review",
  "pull_request_review_comment",
  "issue_comment",
  "pull_request",
]);

export interface RedeliveryDeps {
  appId: string;
  privateKey: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
  windowMs?: number;
}

export interface RedeliveryResult {
  scanned: number;
  redelivered: number;
  skipped: number;
}

/** One App webhook delivery as GitHub lists it, narrowed to the fields the orchestrator reads. */
export interface AppDelivery {
  id: number;
  guid: string;
  delivered_at: string;
  /** "OK" when the orchestrator accepted it, otherwise GitHub's description of the failure. */
  status: string;
  /** The HTTP status the orchestrator answered with. */
  status_code: number;
  event: string;
}

export interface RecentAppDeliveries {
  /** The newest attempt per delivery GUID inside the window. */
  deliveries: AppDelivery[];
  /** The HTTP status of a later page that ended the listing early, or null when it read to the window's end. */
  endedEarlyWith: number | null;
}

function nextCursor(link: string | null): string | null {
  if (!link) return null;
  for (const part of link.split(",")) {
    if (!/rel="next"/.test(part)) continue;
    const url = /<([^>]+)>/.exec(part)?.[1];
    if (!url) return null;
    try {
      return new URL(url).searchParams.get("cursor");
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * The App's webhook deliveries from the last window, newest attempt per GUID. Reads only.
 * Throws a GitHubApiError when GitHub refuses the first page. A later refused page ends the list there, reported in `endedEarlyWith`.
 */
export async function listRecentAppDeliveries(deps: RedeliveryDeps): Promise<RecentAppDeliveries> {
  const doFetch = deps.fetchImpl ?? fetch;
  const now = deps.now ?? Date.now;
  const cutoff = now() - (deps.windowMs ?? DEFAULT_WINDOW_MS);
  const jwt = createAppJwt(deps.appId, deps.privateKey.replace(/\\n/g, "\n"));
  const newest = new Map<string, AppDelivery>();
  let cursor: string | null = null;
  for (let page = 0; page < MAX_PAGES; page++) {
    const path = `/app/hook/deliveries?per_page=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`;
    const res = await doFetch(`${API}${path}`, { headers: githubAppHeaders(jwt), signal: defaultFetchSignal() });
    if (!res.ok) {
      if (page === 0) throw new GitHubApiError({ status: res.status, path: "/app/hook/deliveries", bodyText: await res.text() });
      return { deliveries: [...newest.values()], endedEarlyWith: res.status };
    }
    const items = (await res.json()) as AppDelivery[];
    let reachedWindow = false;
    for (const d of items) {
      if (Date.parse(d.delivered_at) < cutoff) {
        reachedWindow = true;
        continue;
      }
      const prev = newest.get(d.guid);
      if (!prev || Date.parse(d.delivered_at) > Date.parse(prev.delivered_at)) newest.set(d.guid, d);
    }
    cursor = nextCursor(res.headers.get("link"));
    if (reachedWindow || !cursor || items.length === 0) break;
  }
  return { deliveries: [...newest.values()], endedEarlyWith: null };
}

/**
 * Asks GitHub to redeliver the App's failed deliveries of the four review-related events from the
 * last window. GitHub never retries on its own. The KG PR-check route and the review handlers on a
 * Restate-lifecycle project refuse a delivery with 503 while Restate is unavailable (see the module comment above). A redelivery keeps the delivery GUID, so Restate's
 * idempotency key absorbs duplicates. Never throws: failures are logged and skipped.
 */
export async function redeliverFailedAppDeliveries(deps: RedeliveryDeps): Promise<RedeliveryResult> {
  const doFetch = deps.fetchImpl ?? fetch;
  let listed: RecentAppDeliveries;
  try {
    listed = await listRecentAppDeliveries(deps);
  } catch (err) {
    if (err instanceof GitHubApiError) console.warn(`[webhook-redelivery] list failed (${err.status})`);
    else console.warn(`[webhook-redelivery] sweep failed: ${err instanceof Error ? err.message : String(err)}`);
    return { scanned: 0, redelivered: 0, skipped: 0 };
  }
  if (listed.endedEarlyWith !== null) console.warn(`[webhook-redelivery] list failed (${listed.endedEarlyWith})`);

  try {
    const jwt = createAppJwt(deps.appId, deps.privateKey.replace(/\\n/g, "\n"));
    let redelivered = 0;
    let skipped = 0;
    for (const d of listed.deliveries) {
      if (d.status === "OK") continue;
      if (!REDELIVERED_EVENTS.has(d.event)) {
        skipped++;
        continue;
      }
      try {
        const res = await doFetch(`${API}/app/hook/deliveries/${d.id}/attempts`, {
          method: "POST",
          headers: githubAppHeaders(jwt),
          signal: defaultFetchSignal(),
        });
        if (res.ok) {
          redelivered++;
        } else {
          console.warn(`[webhook-redelivery] redelivery of ${d.guid} failed (${res.status})`);
          skipped++;
        }
      } catch (err) {
        console.warn(`[webhook-redelivery] redelivery of ${d.guid} failed: ${err instanceof Error ? err.message : String(err)}`);
        skipped++;
      }
    }
    return { scanned: listed.deliveries.length, redelivered, skipped };
  } catch (err) {
    console.warn(`[webhook-redelivery] sweep failed: ${err instanceof Error ? err.message : String(err)}`);
    return { scanned: listed.deliveries.length, redelivered: 0, skipped: 0 };
  }
}

/**
 * Fire-and-forget sweep for the Restate registration hook. No-op without a webhook secret,
 * since no route accepts webhooks then.
 */
export function sweepOnRegistered(
  config: { githubWebhookSecret: string | null; githubAppId: string; githubAppPrivateKey: string },
  sweep: (deps: RedeliveryDeps) => Promise<RedeliveryResult> = redeliverFailedAppDeliveries,
): void {
  if (!config.githubWebhookSecret) return;
  void sweep({ appId: config.githubAppId, privateKey: config.githubAppPrivateKey })
    .then((r) => console.log(`[webhook-redelivery] scanned ${r.scanned}, redelivered ${r.redelivered}, skipped ${r.skipped}`))
    .catch(() => {});
}
