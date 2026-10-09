import { createAppJwt, githubAppHeaders } from "./github-app-auth.js";
import { defaultFetchSignal } from "./github.js";

/**
 * Redelivers the GitHub App's failed webhook deliveries when Restate registers.
 *
 * Today only the KG PR-check route (`handleKgPrCheckWebhook`) answers 503 while
 * Restate is unavailable. The three review handlers still write SQLite and answer
 * 200; they gain the 503 path with AII-1184, and this sweep lands first so that
 * path is recoverable from its first day.
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

interface Delivery {
  id: number;
  guid: string;
  delivered_at: string;
  status: string;
  event: string;
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
 * Asks GitHub to redeliver the App's failed review-related webhook deliveries from the last window.
 * GitHub never retries on its own, so this recovers events the webhook route refused with 503 while
 * Restate was down. A redelivery keeps the delivery GUID, so Restate's idempotency key absorbs duplicates.
 * Never throws: failures are logged and skipped.
 */
export async function redeliverFailedAppDeliveries(deps: RedeliveryDeps): Promise<RedeliveryResult> {
  const doFetch = deps.fetchImpl ?? fetch;
  const now = deps.now ?? Date.now;
  const cutoff = now() - (deps.windowMs ?? DEFAULT_WINDOW_MS);
  const privateKey = deps.privateKey.replace(/\\n/g, "\n");
  const newest = new Map<string, Delivery>();

  try {
    const jwt = createAppJwt(deps.appId, privateKey);
    let cursor: string | null = null;
    for (let page = 0; page < MAX_PAGES; page++) {
      const path = `/app/hook/deliveries?per_page=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`;
      const res = await doFetch(`${API}${path}`, { headers: githubAppHeaders(jwt), signal: defaultFetchSignal() });
      if (!res.ok) {
        console.warn(`[webhook-redelivery] list failed (${res.status})`);
        if (page === 0) return { scanned: 0, redelivered: 0, skipped: 0 };
        break;
      }
      const items = (await res.json()) as Delivery[];
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

    let redelivered = 0;
    let skipped = 0;
    for (const d of newest.values()) {
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
    return { scanned: newest.size, redelivered, skipped };
  } catch (err) {
    console.warn(`[webhook-redelivery] sweep failed: ${err instanceof Error ? err.message : String(err)}`);
    return { scanned: newest.size, redelivered: 0, skipped: 0 };
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
