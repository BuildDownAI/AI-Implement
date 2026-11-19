import { describe, expect, it, vi } from "vitest";
import { accessHtml, accessScript } from "../pages/access.js";
import { mountAdminPage } from "../../__tests__/helpers/fixtures/admin-ui.js";

describe("access page Clear bindings", () => {
  it("clears the clicked entry's bindings from a listener, never a value read back from the markup (ADR 002)", async () => {
    const value = 'ada"><img src=x>@eudoxus.ai';
    const cleared: unknown[] = [];
    const payload = {
      source: "db", canEdit: true, changes: [],
      entries: [{ kind: "address", value, role: "admin" }],
      stored: [{ kind: "address", value, role: "admin", addedAt: 1, bindings: [{ provider: "google" }] }],
    };
    const api = async (url: string, init?: { method?: string; body?: string }) => {
      if (url === "/api/access/clear-bindings") {
        cleared.push(JSON.parse(init!.body as string));
        return { ok: true, status: 200, json: async () => payload };
      }
      if (url === "/api/access") return { ok: true, status: 200, json: async () => payload };
      return { ok: true, status: 200, json: async () => ({ granted: [], grantable: [] }) };
    };
    let init: () => void = () => {};
    const { doc } = mountAdminPage({
      html: accessHtml,
      script: accessScript,
      route: "access",
      api,
      before: (w) => {
        w.confirm = () => true;
        // The shared mount never runs a page's init, and this page loads its list only from there.
        w.registerPage = (_route: string, fn: () => void) => { init = fn; };
      },
    });
    init();
    const button = await vi.waitFor(() => {
      const found = [...doc.querySelectorAll("#access-body button")].find((b) => b.textContent === "Clear bindings") as HTMLButtonElement | undefined;
      expect(found).toBeDefined();
      return found!;
    });
    expect([button.getAttribute("onclick"), button.getAttribute("data-value")]).toEqual([null, null]);
    button.click();
    await vi.waitFor(() => expect(cleared).toEqual([{ value }]));
  });
});
