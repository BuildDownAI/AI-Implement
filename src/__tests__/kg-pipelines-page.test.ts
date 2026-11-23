import { describe, expect, it, vi } from "vitest";
import { JSDOM } from "jsdom";
import { kgPipelinesHtml, kgPipelinesScript } from "../admin-ui/pages/kg-pipelines.js";
import { mountAdminPage, type FakeApi } from "./helpers/fixtures/admin-ui.js";

interface ApiCall {
  url: string;
  init?: {
    method?: string;
    body?: string;
    headers?: Record<string, string>;
  };
}

const SETTINGS = {
  kgGraphSource: "sidecar",
  kg_stardog_db: "builddown-kg",
  kg_stardog_run_endpoint: "https://tenant.stardog.run/kg",
  kg_stardog_run_console: "https://console.stardog.run",
  kg_stardog_run_platform: "https://import.stardog.run",
  stardogTokenSet: true,
  kgCustomerRepo: false,
};

function response(status: number, body: unknown): {
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
} {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

function toolAnswer(body: Record<string, unknown>): unknown {
  return { content: [{ type: "text", text: JSON.stringify(body) }] };
}

function mount(api: FakeApi): { win: any; doc: Document } {
  const dom = new JSDOM(`<!doctype html><body>${kgPipelinesHtml}</body>`, {
    runScripts: "outside-only",
    url: "http://localhost/admin#kg-pipelines",
  });
  const win = dom.window as unknown as Record<string, any>;
  win.api = api;
  win.registerPage = () => {};
  // Same helpers authJs installs, so a page that interpolated a value with innerHTML
  // would be caught here rather than made safe by a pass-through stub.
  win.esc = (value: unknown) => {
    const holder = dom.window.document.createElement("div");
    holder.textContent = String(value == null ? "" : value);
    return holder.innerHTML;
  };
  win.escAttr = (value: unknown) =>
    String(value == null ? "" : value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#x27;");
  win.eval(kgPipelinesScript);
  return { win, doc: dom.window.document as Document };
}

function cardHtml(id: string): string {
  const start = kgPipelinesHtml.indexOf(`<div class="card" id="${id}"`);
  expect(start, `no card carries id="${id}"`).toBeGreaterThan(-1);
  const nextCard = kgPipelinesHtml.indexOf('<div class="card"', start + 1);
  return kgPipelinesHtml.slice(start, nextCard === -1 ? kgPipelinesHtml.length : nextCard);
}

describe("KG page — Graph source card", () => {
  it("is a card of its own, apart from the Backend control", () => {
    const sourceCard = cardHtml("kg-graph-source-card");
    const refreshCard = cardHtml("kg-refresh-card");
    expect(sourceCard).toContain("Graph source");
    expect(sourceCard).toContain('id="kg-graph-source"');
    expect(sourceCard).not.toContain('id="kg-backend-controls"');
    expect(refreshCard).toContain('id="kg-backend-controls"');
    expect(refreshCard).not.toContain('id="kg-graph-source"');
  });

  it("loads the effective source, Stardog values and graph details", async () => {
    const { win } = mount(async (url) => {
      if (url === "/api/settings") return response(200, SETTINGS);
      throw new Error(`unexpected api call ${url}`);
    });
    await win.loadKgGraphSettings();

    const doc = win.document as Document;
    expect((doc.getElementById("kg-graph-source") as HTMLSelectElement).value).toBe("sidecar");
    expect((doc.getElementById("kg-stardog-db") as HTMLInputElement).value).toBe("builddown-kg");
    expect((doc.getElementById("kg-stardog-endpoint") as HTMLInputElement).value).toBe(
      "https://tenant.stardog.run/kg",
    );
    expect((doc.getElementById("kg-stardog-console") as HTMLInputElement).value).toBe(
      "https://console.stardog.run",
    );
    expect((doc.getElementById("kg-stardog-import-host") as HTMLInputElement).value).toBe(
      "https://import.stardog.run",
    );
    expect((doc.getElementById("kg-stardog-token") as HTMLInputElement).type).toBe("password");
    expect(doc.getElementById("kg-stardog-token-status")?.textContent).toBe("Token set");
    expect(doc.getElementById("kg-graph-customer-repo-note")?.hidden).toBe(true);
    expect(doc.body.textContent).toContain("Stardog bills each query.");
    expect(doc.body.textContent).not.toContain("Dataset");
    expect(doc.body.textContent).not.toContain("Graph details");
    expect((doc.getElementById("kg-namespace") as HTMLInputElement).value).toBe("");
    expect((doc.getElementById("kg-graph-name") as HTMLInputElement).value).toBe("");
  });

  it("defaults an empty import host and shows the customer-repo note when set", async () => {
    const { win } = mount(async (url) => {
      if (url === "/api/settings") {
        return response(200, {
          ...SETTINGS,
          kg_stardog_run_platform: "",
          kgGraphSource: "stardog_run",
          kgCustomerRepo: true,
        });
      }
      throw new Error(`unexpected api call ${url}`);
    });
    await win.loadKgGraphSettings();

    const doc = win.document as Document;
    expect((doc.getElementById("kg-stardog-import-host") as HTMLInputElement).value).toBe(
      "https://app.stardog.run",
    );
    expect((doc.getElementById("kg-graph-source") as HTMLSelectElement).value).toBe("stardog_run");
    expect(doc.getElementById("kg-graph-customer-repo-note")?.hidden).toBe(false);
    expect(doc.getElementById("kg-graph-customer-repo-note")?.textContent).toBe(
      "Only a base-repo refresh loads Stardog. With a customer KG repo, nothing refreshes the Stardog graph.",
    );
  });

  it("keeps hostile settings values literal, adds no markup or handler attributes, and runs nothing", async () => {
    const hostile = {
      kgGraphSource: '<img src=x onerror="alert(1)">',
      kg_stardog_db: '"><svg onload=alert(1)>',
      kg_stardog_run_endpoint: '"><script>window.__kgPwned = 1</script>',
      kg_stardog_run_console: "' onfocus='alert(1)",
      kg_stardog_run_platform: '"><iframe srcdoc="<script>alert(1)</script>">',
      stardogTokenSet: false,
      kgCustomerRepo: true,
    };
    const { win } = mount(async (url) => {
      if (url === "/api/settings") return response(200, hostile);
      throw new Error(`unexpected api call ${url}`);
    });
    await win.loadKgGraphSettings();

    const doc = win.document as Document;
    expect((doc.getElementById("kg-graph-source") as HTMLSelectElement).value).toBe("sidecar");
    expect((doc.getElementById("kg-stardog-db") as HTMLInputElement).value).toBe(hostile.kg_stardog_db);
    expect((doc.getElementById("kg-stardog-endpoint") as HTMLInputElement).value).toBe(
      hostile.kg_stardog_run_endpoint,
    );
    expect((doc.getElementById("kg-stardog-console") as HTMLInputElement).value).toBe(
      hostile.kg_stardog_run_console,
    );
    expect((doc.getElementById("kg-stardog-import-host") as HTMLInputElement).value).toBe(
      hostile.kg_stardog_run_platform,
    );
    expect(doc.getElementById("kg-stardog-token-status")?.textContent).toBe("Token not set");
    expect(doc.getElementById("kg-graph-customer-repo-note")?.hidden).toBe(false);

    expect(doc.querySelector("img, svg, iframe, script")).toBeNull();
    for (const id of ["kg-graph-source", "kg-stardog-db", "kg-stardog-endpoint", "kg-stardog-console", "kg-stardog-import-host"]) {
      const el = doc.getElementById(id)!;
      expect(el.getAttribute("onerror"), `${id} gained onerror`).toBeNull();
      expect(el.getAttribute("onload"), `${id} gained onload`).toBeNull();
      expect(el.getAttribute("onfocus"), `${id} gained onfocus`).toBeNull();
    }
    expect((win as Record<string, unknown>).__kgPwned).toBeUndefined();
  });
});

describe("KG page — switching the graph source", () => {
  it("retries a 503 with the same Idempotency-Key, then uses a fresh key for the next save", async () => {
    const calls: ApiCall[] = [];
    let switchAttempt = 0;
    const { win } = mount(async (url, init) => {
      calls.push({ url, init });
      if (url === "/api/settings") return response(200, SETTINGS);
      if (url === "/api/tools/set_kg_graph_source") {
        switchAttempt += 1;
        if (switchAttempt <= 3) return response(503, { error: "restate-unavailable" });
        const source = JSON.parse(init!.body!).args.source;
        return response(200, toolAnswer({ switched: true, source }));
      }
      throw new Error(`unexpected api call ${url}`);
    });
    await win.loadKgGraphSettings();
    const doc = win.document as Document;
    const select = doc.getElementById("kg-graph-source") as HTMLSelectElement;

    select.value = "stardog_run";
    await win.saveKgGraphSource();

    const firstSaveCalls = calls.filter((c) => c.url === "/api/tools/set_kg_graph_source").slice(0, 4);
    expect(firstSaveCalls).toHaveLength(4);
    const firstKeys = firstSaveCalls.map((c) => c.init?.headers?.["Idempotency-Key"]);
    expect(new Set(firstKeys).size).toBe(1);
    expect(firstKeys[0]).toMatch(/^[A-Za-z0-9._:-]{1,128}$/);
    expect(select.value).toBe("stardog_run");

    select.value = "sidecar";
    await win.saveKgGraphSource();

    const allSwitchCalls = calls.filter((c) => c.url === "/api/tools/set_kg_graph_source");
    expect(allSwitchCalls).toHaveLength(5);
    const secondKey = allSwitchCalls[4]?.init?.headers?.["Idempotency-Key"];
    expect(secondKey).toMatch(/^[A-Za-z0-9._:-]{1,128}$/);
    expect(secondKey).not.toBe(firstKeys[0]);
    expect(select.value).toBe("sidecar");
  });

  it("shows the wake-up message while the switch waits", async () => {
    let release!: (value: ReturnType<typeof response>) => void;
    const pending = new Promise<ReturnType<typeof response>>((resolve) => {
      release = resolve;
    });
    const { win } = mount(async (url) => {
      if (url === "/api/settings") return response(200, SETTINGS);
      if (url === "/api/tools/set_kg_graph_source") return pending;
      throw new Error(`unexpected api call ${url}`);
    });
    await win.loadKgGraphSettings();
    const doc = win.document as Document;
    (doc.getElementById("kg-graph-source") as HTMLSelectElement).value = "stardog_run";

    const saving = win.saveKgGraphSource();
    await Promise.resolve();
    await Promise.resolve();
    expect(doc.getElementById("kg-graph-source-status")?.textContent).toBe(
      "Switching\u2026 Stardog can take up to 5 minutes to wake.",
    );

    release(response(200, toolAnswer({ switched: true, source: "stardog_run" })));
    await saving;
  });

  it("stops after ten 503s, restores the old source, and shows the reload message", async () => {
    const calls: ApiCall[] = [];
    const { win } = mount(async (url, init) => {
      calls.push({ url, init });
      if (url === "/api/settings") return response(200, SETTINGS);
      if (url === "/api/tools/set_kg_graph_source") return response(503, { error: "restate-unavailable" });
      throw new Error(`unexpected api call ${url}`);
    });
    await win.loadKgGraphSettings();
    const doc = win.document as Document;
    const select = doc.getElementById("kg-graph-source") as HTMLSelectElement;
    select.value = "stardog_run";

    await win.saveKgGraphSource();

    const switchCalls = calls.filter((c) => c.url === "/api/tools/set_kg_graph_source");
    expect(switchCalls).toHaveLength(10);
    expect(new Set(switchCalls.map((c) => c.init?.headers?.["Idempotency-Key"])).size).toBe(1);
    expect(select.value).toBe("sidecar");
    expect(doc.getElementById("kg-graph-source-status")?.textContent).toBe(
      "The switch may still be running. Reload the page to see the source.",
    );
  });

  it("shows a switched:false error, restores the old source, and sends exactly one request", async () => {
    const errorText = "stardog-values-missing <img src=x onerror=alert(1)>";
    const calls: ApiCall[] = [];
    const { win } = mount(async (url, init) => {
      calls.push({ url, init });
      if (url === "/api/settings") return response(200, SETTINGS);
      if (url === "/api/tools/set_kg_graph_source") {
        return response(200, toolAnswer({
          switched: false,
          error: errorText,
        }));
      }
      throw new Error(`unexpected api call ${url}`);
    });
    await win.loadKgGraphSettings();
    const doc = win.document as Document;
    const select = doc.getElementById("kg-graph-source") as HTMLSelectElement;
    select.value = "stardog_run";

    await win.saveKgGraphSource();

    expect(calls.filter((c) => c.url === "/api/tools/set_kg_graph_source")).toHaveLength(1);
    expect(select.value).toBe("sidecar");
    const error = doc.getElementById("kg-graph-source-error");
    expect(error?.hidden).toBe(false);
    expect(error?.textContent).toContain(errorText);
    expect(doc.querySelector("img")).toBeNull();
  });

  it("does not retry a terminal non-503 response, shows its error, and restores the old source", async () => {
    const calls: ApiCall[] = [];
    const { win } = mount(async (url, init) => {
      calls.push({ url, init });
      if (url === "/api/settings") return response(200, SETTINGS);
      if (url === "/api/tools/set_kg_graph_source") {
        return response(500, { error: "no-sidecar-graph" });
      }
      throw new Error(`unexpected api call ${url}`);
    });
    await win.loadKgGraphSettings();
    const doc = win.document as Document;
    const select = doc.getElementById("kg-graph-source") as HTMLSelectElement;
    select.value = "stardog_run";

    await win.saveKgGraphSource();

    expect(calls.filter((c) => c.url === "/api/tools/set_kg_graph_source")).toHaveLength(1);
    expect(select.value).toBe("sidecar");
    const error = doc.getElementById("kg-graph-source-error");
    expect(error?.hidden).toBe(false);
    expect(error?.textContent).toContain("no-sidecar-graph");
    expect(doc.getElementById("kg-graph-source-status")?.textContent).toBe("");
  });
});

describe("KG page — Stardog values", () => {
  it("does not save after a failed initial settings load, then enables saving after a successful load", async () => {
    const calls: ApiCall[] = [];
    let settingsAttempt = 0;
    const { win } = mount(async (url, init) => {
      calls.push({ url, init });
      if (url === "/api/settings") {
        settingsAttempt += 1;
        return settingsAttempt === 1
          ? response(500, { error: "settings-unavailable" })
          : response(200, SETTINGS);
      }
      throw new Error(`unexpected api call ${url}`);
    });
    const doc = win.document as Document;
    const select = doc.getElementById("kg-graph-source") as HTMLSelectElement;
    const saveButton = doc.getElementById("btn-kg-stardog-save") as HTMLButtonElement;

    await win.loadKgGraphSettings();

    expect(select.disabled).toBe(true);
    expect(saveButton.disabled).toBe(true);
    select.value = "stardog_run";
    (doc.getElementById("kg-stardog-db") as HTMLInputElement).value = "";
    (doc.getElementById("kg-stardog-token") as HTMLInputElement).value = "SENTINEL-initial-load-token";

    await win.saveKgGraphSource();
    await win.saveKgStardog();

    expect(calls.filter((c) => c.url === "/api/settings" && c.init?.method === "POST")).toHaveLength(0);
    expect(calls.filter((c) => c.url === "/api/kg/stardog")).toHaveLength(0);
    expect(calls.filter((c) => c.url === "/api/tools/set_kg_graph_source")).toHaveLength(0);
    expect(doc.getElementById("kg-graph-source-error")?.textContent).toContain("before switching");
    expect(doc.getElementById("kg-stardog-error")?.textContent).toContain("before saving");

    await win.loadKgGraphSettings();

    expect(select.disabled).toBe(false);
    expect(saveButton.disabled).toBe(false);
    expect(select.value).toBe("sidecar");
    expect((doc.getElementById("kg-stardog-db") as HTMLInputElement).value).toBe("builddown-kg");
  });

  it("saves the non-secret fields, sends the token once, and leaves no token in the DOM", async () => {
    const calls: ApiCall[] = [];
    const token = "SENTINEL-stardog-token-page-test";
    const { win } = mountAdminPage({ html: kgPipelinesHtml, script: kgPipelinesScript, route: "kg-pipelines", api: async (url, init) => {
      calls.push({ url, init });
      if (url === "/api/settings" && !init) return response(200, SETTINGS);
      if (url === "/api/settings" && init?.method === "POST") return response(200, SETTINGS);
      if (url === "/api/kg/stardog" && init?.method === "POST") return response(200, { tokenSet: true });
      throw new Error(`unexpected api call ${url}`);
    } });
    await win.loadKgGraphSettings();
    const doc = win.document as Document;
    (doc.getElementById("kg-stardog-db") as HTMLInputElement).value = "new-db";
    (doc.getElementById("kg-stardog-endpoint") as HTMLInputElement).value = "https://new.stardog.run/kg";
    (doc.getElementById("kg-stardog-console") as HTMLInputElement).value = "https://new.stardog.run";
    (doc.getElementById("kg-stardog-import-host") as HTMLInputElement).value = "https://new-import.stardog.run";
    for (const [id, value] of [["kg-namespace", "https://new.example/"], ["kg-graph-name", "new-graph"], ["kg-code-repo", "Org/repo"], ["kg-graph-label", "New label"]]) {
      (doc.getElementById(id) as HTMLInputElement).value = " " + value + " ";
    }
    (doc.getElementById("kg-stardog-token") as HTMLInputElement).value = token;

    (doc.getElementById("btn-kg-stardog-save") as HTMLButtonElement).click();
    await vi.waitFor(() => expect(doc.getElementById("kg-stardog-save-status")?.textContent).toBe("Saved, including the token."));

    expect(calls.filter((c) => c.url === "/api/settings" && c.init?.method === "POST")).toHaveLength(1);
    const settingsPost = calls.find((c) => c.url === "/api/settings" && c.init?.method === "POST");
    expect(JSON.parse(settingsPost!.init!.body!)).toEqual({
      kg_namespace: "https://new.example/",
      kg_graph_name: "new-graph",
      kg_code_repo: "Org/repo",
      kg_graph_label: "New label",
      kg_stardog_db: "new-db",
      kg_stardog_run_endpoint: "https://new.stardog.run/kg",
      kg_stardog_run_console: "https://new.stardog.run",
      kg_stardog_run_platform: "https://new-import.stardog.run",
    });
    const tokenCalls = calls.filter((c) => c.url === "/api/kg/stardog");
    expect(tokenCalls).toHaveLength(1);
    expect(calls.indexOf(tokenCalls[0]!)).toBeGreaterThan(calls.indexOf(settingsPost!));
    expect(JSON.parse(tokenCalls[0]!.init!.body!)).toEqual({ token });
    expect((doc.getElementById("kg-stardog-token") as HTMLInputElement).value).toBe("");
    expect(doc.getElementById("kg-stardog-token-status")?.textContent).toBe("Token set");
    expect(doc.documentElement.outerHTML).not.toContain(token);
    expect(doc.body.textContent).not.toContain(token);
  });

  it("sends no token request when the token field is empty", async () => {
    const calls: ApiCall[] = [];
    const { win } = mount(async (url, init) => {
      calls.push({ url, init });
      if (url === "/api/settings" && !init) return response(200, SETTINGS);
      if (url === "/api/settings" && init?.method === "POST") return response(200, SETTINGS);
      if (url === "/api/kg/stardog") throw new Error("token request should not be sent");
      throw new Error(`unexpected api call ${url}`);
    });
    await win.loadKgGraphSettings();
    const doc = win.document as Document;
    (doc.getElementById("kg-stardog-token") as HTMLInputElement).value = "";

    await win.saveKgStardog();

    expect(calls.filter((c) => c.url === "/api/kg/stardog")).toHaveLength(0);
    expect(doc.getElementById("kg-stardog-token-status")?.textContent).toBe("Token set");
  });

  it("keeps Save disabled during a pending save when the settings poll reloads", async () => {
    const calls: ApiCall[] = [];
    let releaseSettingsPost!: (value: ReturnType<typeof response>) => void;
    const pendingSettingsPost = new Promise<ReturnType<typeof response>>((resolve) => {
      releaseSettingsPost = resolve;
    });
    const { win } = mount(async (url, init) => {
      calls.push({ url, init });
      if (url === "/api/settings" && !init) return response(200, SETTINGS);
      if (url === "/api/settings" && init?.method === "POST") return pendingSettingsPost;
      if (url === "/api/kg/stardog" && init?.method === "POST") return response(200, { tokenSet: true });
      throw new Error(`unexpected api call ${url}`);
    });
    await win.loadKgGraphSettings();
    const doc = win.document as Document;
    const saveButton = doc.getElementById("btn-kg-stardog-save") as HTMLButtonElement;
    (doc.getElementById("kg-stardog-token") as HTMLInputElement).value = "SENTINEL-pending-save-token";

    const saving = win.saveKgStardog();
    await Promise.resolve();
    await Promise.resolve();
    expect(saveButton.disabled).toBe(true);

    await win.loadKgGraphSettings();
    expect(saveButton.disabled).toBe(true);

    await win.saveKgStardog();
    expect(calls.filter((c) => c.url === "/api/settings" && c.init?.method === "POST")).toHaveLength(1);
    expect(calls.filter((c) => c.url === "/api/kg/stardog")).toHaveLength(0);

    releaseSettingsPost(response(200, SETTINGS));
    await saving;

    expect(calls.filter((c) => c.url === "/api/kg/stardog")).toHaveLength(1);
    expect(saveButton.disabled).toBe(false);
  });
});
