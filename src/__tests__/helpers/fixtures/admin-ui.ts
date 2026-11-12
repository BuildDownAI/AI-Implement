import { JSDOM } from "jsdom";
import { helpersJs } from "../../../admin-ui/helpers.js";

/** The part of a fetch `Response` the admin page scripts read. */
export interface FakeApiResponse {
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
}

/** Stands in for `window.api`, the SPA's fetch wrapper (`src/admin-ui/auth.ts`). */
export type FakeApi = (url: string, init?: { method?: string; body?: string }) => Promise<FakeApiResponse>;

// A page script adds its own functions to window (loadIssues, loadBlockers, ...), so the window is untyped.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AdminPageWindow = any;

/**
 * Mounts one admin page's markup and script in jsdom the way the SPA runs it: the shared helpers
 * `helpersJs` puts on `window` run as they do in production, `window.api` answers from the test,
 * and `registerPage` does nothing, so the test calls the page's loader itself.
 */
export function mountAdminPage(options: {
  html: string;
  script: string;
  route: string;
  api: FakeApi;
  /** Runs before the page script, for globals the page reads at load (other scripts' functions, dialog methods). */
  before?: (win: AdminPageWindow) => void;
}): { win: AdminPageWindow; doc: Document } {
  const dom = new JSDOM(`<!DOCTYPE html><body>${options.html}</body>`, {
    runScripts: "dangerously",
    url: `http://localhost/admin#${options.route}`,
  });
  const win: AdminPageWindow = dom.window;
  // The real helpers.ts script, so the escaping, badge and time helpers are production's own.
  const helpers = dom.window.document.createElement("script");
  helpers.textContent = helpersJs;
  dom.window.document.head.appendChild(helpers);
  win.registerPage = () => {};
  win.api = options.api;
  options.before?.(win);
  const script = dom.window.document.createElement("script");
  script.textContent = options.script;
  dom.window.document.head.appendChild(script);
  return { win, doc: dom.window.document as Document };
}
