// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { accessHtml, accessScript } from "../pages/access.js";

/** A stored grant row for a page that left PAGE_ROUTES must not block saving other grants. */
describe("grant editor with a stale stored row", () => {
  it("drops the stale key from the draft, so the save posts only grantable pages", async () => {
    document.body.innerHTML = accessHtml;
    const w = window as unknown as Record<string, unknown>;
    let init: () => void = () => {};
    const posted: string[][] = [];
    w.esc = (s: unknown) => String(s ?? "");
    w.registerPage = (_route: string, cb: () => void) => { init = cb; };
    w.api = async (url: string, opts?: { method?: string; body?: string }) => {
      if (url === "/api/access-grants") {
        if (opts?.method === "POST") {
          posted.push(JSON.parse(opts.body!).pages);
          return { ok: true, json: async () => ({ granted: posted[0], grantable: ["issues", "pulls"] }) };
        }
        return { ok: true, json: async () => ({ granted: ["issues", "journal"], grantable: ["issues", "pulls"] }) };
      }
      return { ok: true, json: async () => ({ entries: [], env: [], changes: [] }) };
    };
    new Function(accessScript)();
    init();
    await new Promise((r) => setTimeout(r, 0));
    (w.openGrantEditor as () => void)();
    expect(document.getElementById("grant-list")!.innerHTML).not.toMatch(/journal/i);
    await (w.saveGrants as () => Promise<void>)();
    expect(posted).toEqual([["issues"]]);
  });
});
