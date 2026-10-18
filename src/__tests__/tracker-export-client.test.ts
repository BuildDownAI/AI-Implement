import { describe, it, expect } from "vitest";
import { createProductionTrackerExportServices, createTrackerExportIngressClient } from "../restate/tracker-export.js";

const INPUT = { team: "ENG", cursor: null };
const PAGE = { issues: [], pageInfo: { hasNextPage: false, endCursor: null } };

const respond = (status: number, body: unknown): typeof fetch =>
  (async () => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })) as typeof fetch;

describe("createTrackerExportIngressClient", () => {
  it("returns the page on success", async () => {
    const client = createTrackerExportIngressClient("http://restate.test", { fetchImpl: respond(200, PAGE) });
    expect(await client.page(INPUT)).toEqual({ ok: true, page: PAGE });
  });

  it.each(["tracker-unavailable", "tracker-failed"] as const)("maps a terminal %s", async (code) => {
    const status = code === "tracker-unavailable" ? 503 : 502;
    const client = createTrackerExportIngressClient("http://restate.test", {
      fetchImpl: respond(status, { code: status, message: `${code}: detail` }),
    });
    expect(await client.page(INPUT)).toEqual({ ok: false, code });
  });

  it("maps a connection error to unavailable without throwing", async () => {
    const client = createTrackerExportIngressClient("http://restate.test", {
      fetchImpl: (async () => { throw new TypeError("fetch failed"); }) as typeof fetch,
    });
    expect(await client.page(INPUT)).toEqual({ ok: false, code: "unavailable" });
  });

  it("maps an unrelated HTTP error to unavailable", async () => {
    const client = createTrackerExportIngressClient("http://restate.test", { fetchImpl: respond(500, { message: "boom" }) });
    expect(await client.page(INPUT)).toEqual({ ok: false, code: "unavailable" });
  });
});

describe("createProductionTrackerExportServices", () => {
  it("returns the TrackerExport service the boot list registers", () => {
    const { services } = createProductionTrackerExportServices();
    expect(services.map((service) => service.name)).toEqual(["TrackerExport"]);
  });
});
