// The `set_kg_graph_source` restart step (AII-1974) as src/index.ts binds it. With no
// sidecar at boot and no provider, switching to stardog_run must start the sidecar, install
// a probed provider whose capabilities are filled, and let a kg_* call reach it — with no
// orchestrator restart. The Stardog client is faked; the sidecar is a fake that only sets
// KG_SIDECAR_URL, and its HTTP is a queued `http.request` mock.
import { PassThrough } from "node:stream";
import http from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createKgGraphSourceToolDeps } from "../index.js";
import { SidecarMemoryProvider, getKgMemoryProvider, setKgMemoryProvider } from "../kg-provider.js";
import { getDb } from "../dedup.js";
import { initSettingsTable } from "../runner-mode.js";
import { setStardogValues } from "../kg-graph-source.js";
import { testDir } from "./helpers/test-dir.js";

const SIDECAR_URL = "http://127.0.0.1:8765/mcp";
const TOOLS = [{ name: "kg_search" }, { name: "kg_neighbors" }, { name: "kg_hybrid_search" }];

function toolsList(): string {
  return JSON.stringify({ jsonrpc: "2.0", id: "probe-tools-list", result: { tools: TOOLS } });
}

describe("createKgGraphSourceToolDeps restart step (AII-1974)", () => {
  let mockHttpRequest: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    getDb();
    initSettingsTable();
    process.env.RUNNER_TOKEN_SECRET = "kg-graph-source-tool-deps-test-key";
    setStardogValues({ db: "builddown-kg", namespace: "https://kg.example/", token: "test-run-token" });
    setKgMemoryProvider(null);
    mockHttpRequest = vi.fn();
    vi.spyOn(http, "request").mockImplementation(mockHttpRequest as never);
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    setKgMemoryProvider(null);
    delete process.env.RUNNER_TOKEN_SECRET;
  });

  function queueResponse(body: string): void {
    const proxyReq = new PassThrough();
    const proxyRes = new PassThrough();
    Object.assign(proxyRes, { statusCode: 200, headers: { "content-type": "application/json" } });
    mockHttpRequest.mockImplementationOnce((_opts: unknown, cb: (res: unknown) => void) => {
      process.nextTick(() => {
        cb(proxyRes);
        proxyRes.push(body);
        proxyRes.push(null);
      });
      return proxyReq;
    });
  }

  it("starts the sidecar, installs a probed provider, and a kg_* call reaches it", async () => {
    const kgDir = testDir("kg-tool-deps");
    let starts = 0;
    const deps = createKgGraphSourceToolDeps({
      sidecar: {
        restart: async () => {
          starts += 1;
          // A real KgSidecar.start() sets this once it is ready; the orchestrator's boot left it unset.
          process.env.KG_SIDECAR_URL = SIDECAR_URL;
        },
      },
      kgDir,
    });
    deps.saveGraphSource("stardog_run");

    // The probe fills the provider's capabilities; list-only sends one tools/list.
    queueResponse(toolsList());
    await deps.restartSidecar();

    expect(starts).toBe(1);
    const provider = getKgMemoryProvider();
    expect(provider).toBeInstanceOf(SidecarMemoryProvider);
    expect(provider!.capabilities).toMatchObject({ hybridSearch: true, neighbors: true });

    // The next kg_* call reaches the newly installed provider (same instance /mcp reads).
    queueResponse(JSON.stringify({ jsonrpc: "2.0", id: "call-kg_search", result: { hits: [{ iri: "x" }] } }));
    await expect(provider!.callKgTool("kg_search", { query: "x" })).resolves.toEqual({ ok: true, result: { hits: [{ iri: "x" }] } });
  });

  it("keeps an existing provider rather than negotiating a second session", async () => {
    const kgDir = testDir("kg-tool-deps");
    const existing = new SidecarMemoryProvider(SIDECAR_URL);
    setKgMemoryProvider(existing);
    process.env.KG_SIDECAR_URL = SIDECAR_URL;
    const deps = createKgGraphSourceToolDeps({ sidecar: { restart: async () => {} }, kgDir });

    // list-only for the remote row just saved; one tools/list.
    deps.saveGraphSource("stardog_run");
    queueResponse(toolsList());
    await deps.restartSidecar();

    expect(getKgMemoryProvider()).toBe(existing);
  });
});
