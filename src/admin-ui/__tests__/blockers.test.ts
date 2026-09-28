import { JSDOM } from "jsdom";
import { describe, expect, it } from "vitest";
import { blockersHtml, blockersScript } from "../pages/blockers.js";

type CapacityByMapping = Record<string, { used: number; cap: number; source: "reservations" }>;

function escapeText(value: unknown): string {
  return String(value == null ? "" : value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function mountBlockers(fixtures: {
  ok?: boolean;
  reject?: boolean;
  totals?: { teams: number; issues: number; byReason: Record<string, number> };
  capacityByMapping?: CapacityByMapping | null;
}): { win: any; doc: Document } {
  const { ok = true, reject = false, totals = { teams: 0, issues: 0, byReason: {} }, capacityByMapping = {} } = fixtures;
  const dom = new JSDOM(`<!DOCTYPE html><body>${blockersHtml}</body>`, {
    runScripts: "dangerously",
    url: "http://localhost/admin#blockers",
  });
  const win = dom.window as any;
  win.esc = escapeText;
  win.escAttr = escapeText;
  win.safeUrl = (value: unknown) => String(value == null ? "#" : value);
  win.registerPage = () => {};
  win.api = async (url: string) => {
    if (url !== "/api/blockers") return { ok: true, status: 200, json: async () => ({}) };
    if (reject) throw new Error("network unavailable");
    if (!ok) return { ok: false, status: 502, json: async () => ({ error: "upstream unavailable" }) };
    return { ok: true, status: 200, json: async () => ({ blockers: [], totals, capacityByMapping }) };
  };
  const script = dom.window.document.createElement("script");
  script.textContent = blockersScript;
  dom.window.document.head.appendChild(script);
  return { win, doc: dom.window.document as Document };
}

describe("blockers page", () => {
  it("declares the expected ids", () => {
    for (const id of ["blockers-subtitle", "blockers-error", "blockers-kpis", "blockers-body", "blockers-empty", "kpi-blocked-total", "kpi-blocked-teams", "kpi-blocked-concurrency", "kpi-blocked-dedup"]) {
      expect(blockersHtml).toContain(`id="${id}"`);
    }
  });
  it("registers route + exposes loadBlockers", () => {
    expect(blockersScript).toContain("window.registerPage('blockers'");
    expect(blockersScript).toContain("window.loadBlockers = loadBlockers");
  });
  it("calls /api/blockers", () => {
    expect(blockersScript).toContain("/api/blockers");
  });
  it("uses window.api/window.esc only", () => {
    const stripped = blockersScript.replace(/window\.api\(/g, "").replace(/window\.esc\(/g, "");
    expect(stripped).not.toMatch(/\bapi\(/);
    expect(stripped).not.toMatch(/\besc\(/);
  });
  it("links issues through the provider-resolved issueUrl, never a hardcoded tracker host", () => {
    expect(blockersScript).toContain("window.safeUrl(b.issueUrl)");
    expect(blockersScript).not.toContain("linear.app");
  });

  it("uses const/let, not var", () => {
    expect(blockersScript).not.toMatch(/\bvar\s+\w/);
  });
});

describe("blockers page capacity projection (AII-797)", () => {
  it("reports teams at capacity from capacityByMapping, not the blocked-issue count", async () => {
    const { win, doc } = mountBlockers({
      totals: { teams: 1, issues: 4, byReason: { concurrency: 4, dedup: 0 } },
      capacityByMapping: { AII: { used: 3, cap: 3, source: "reservations" } },
    });
    await win.loadBlockers();
    // capacityByMapping reports 1 team at cap, independent of the 4 blocked issues
    // totals.byReason.concurrency counts for that same team.
    expect(doc.getElementById("kpi-blocked-concurrency")?.textContent).toBe("1");
  });

  it("counts a team at cap from reservations with zero blocked issues on record", async () => {
    const { win, doc } = mountBlockers({
      totals: { teams: 0, issues: 0, byReason: {} },
      capacityByMapping: { AII: { used: 3, cap: 3, source: "reservations" } },
    });
    await win.loadBlockers();
    expect(doc.getElementById("kpi-blocked-concurrency")?.textContent).toBe("1");
  });

  it("renders unavailable, never 0, when the capacity payload is malformed", async () => {
    const { win, doc } = mountBlockers({
      totals: { teams: 0, issues: 0, byReason: {} },
      capacityByMapping: null,
    });
    await win.loadBlockers();
    expect(doc.getElementById("kpi-blocked-concurrency")?.textContent).toBe("—");
  });

  it("hides the KPI grid behind the error banner rather than showing 0 when /api/blockers fails", async () => {
    const { win, doc } = mountBlockers({ ok: false });
    await win.loadBlockers();
    expect((doc.getElementById("blockers-kpis") as HTMLElement).hidden).toBe(true);
    expect((doc.getElementById("blockers-error") as HTMLElement).hidden).toBe(false);
  });

  it("hides the KPI grid when the blockers request rejects", async () => {
    const { win, doc } = mountBlockers({ reject: true });
    await win.loadBlockers();
    expect((doc.getElementById("blockers-kpis") as HTMLElement).hidden).toBe(true);
    expect((doc.getElementById("blockers-error") as HTMLElement).textContent).toContain("Capacity data unavailable");
  });
});
