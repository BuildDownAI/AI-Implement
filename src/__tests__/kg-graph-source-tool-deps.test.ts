// The `set_kg_graph_source` restart step (AII-1974) as src/index.ts binds it. With no
// sidecar at boot and no provider, switching to stardog_run must start the sidecar, install
// a probed provider whose capabilities are filled, and let a kg_* call reach it — with no
// orchestrator restart. The Stardog client is faked; the sidecar is a fake that only sets
// KG_SIDECAR_URL, and its HTTP is a queued `http.request` mock.
import { PassThrough } from "node:stream";
import http from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createKgGraphSourceToolDeps } from "../index.js";
import {
  SidecarMemoryProvider, getKgMemoryProvider, setKgMemoryProvider, sidecarHealth, sidecarHealthFields,
} from "../kg-provider.js";
import { setKgGraphSourceTool, setKgGraphSourceToolDeps } from "../restate/tools.js";
import { getDb } from "../dedup.js";
import { initSettingsTable } from "../runner-mode.js";
import { setKgGraphSource, setStardogValues } from "../kg-graph-source.js";
import { testDir } from "./helpers/test-dir.js";

const SIDECAR_URL = "http://127.0.0.1:8765/mcp";
const TOOLS = [
  { name: "kg_search" }, { name: "kg_neighbors" }, { name: "kg_hybrid_search" },
  { name: "kg_semantic_search" }, { name: "kg_path" }, { name: "kg_provenance" },
];
const ADMIN = { kind: "system", email: null, role: "admin", grants: [] } as const;

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
    getDb().prepare("DELETE FROM settings WHERE key = 'kg_graph_source'").run();
    setKgMemoryProvider(null);
    delete process.env.KG_SIDECAR_URL;
    resetHealth();
    mockHttpRequest = vi.fn();
    vi.spyOn(http, "request").mockImplementation(mockHttpRequest as never);
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    setKgMemoryProvider(null);
    setKgGraphSourceToolDeps(null);
    delete process.env.KG_SIDECAR_URL;
    delete process.env.RUNNER_TOKEN_SECRET;
    resetHealth();
  });

  function resetHealth(): void {
    Object.assign(sidecarHealth, { reachable: false, toolsListed: false, lastError: null, checkedAt: null });
  }

  function queueConnectionError(): void {
    const proxyReq = new PassThrough();
    mockHttpRequest.mockImplementationOnce(() => {
      process.nextTick(() => proxyReq.emit("error", Object.assign(new Error("ECONNREFUSED"), { code: "ECONNREFUSED" })));
      return proxyReq;
    });
  }

  /** The tool's Restate context with each step run immediately. The fake tool's log captures lines. */
  function toolContext() {
    return {
      request: () => ({ id: "inv-test", target: { handler: "set_kg_graph_source" } }),
      objectClient: () => ({ acquireSwitch: async () => ({ acquired: true }), releaseSwitch: async () => {} }),
      run: async (name: unknown, action?: unknown) => {
        // This fake handles both ctx.run(action) and ctx.run(name, action).
        const fn = typeof name === "function" ? (name as () => unknown) : (action as () => unknown);
        return fn();
      },
    } as never;
  }

  function logTo(logs: string[]) {
    return (from: string, to: string, ok: boolean) => {
      logs.push(`[kg] graph source ${from} -> ${to}: ${ok ? "ok" : "failed"}`);
    };
  }

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

  it("fails the switch when the restart leaves no sidecar URL", async () => {
    const kgDir = testDir("kg-tool-deps");
    // The fake restart resolves without setting KG_SIDECAR_URL, as a failed start does.
    const deps = createKgGraphSourceToolDeps({ sidecar: { restart: async () => {} }, kgDir });
    const logs: string[] = [];
    setKgGraphSourceToolDeps({ ...deps, countTriples: async () => 7, log: logTo(logs) });
    const result = await setKgGraphSourceTool(toolContext(), { caller: ADMIN, args: { source: "stardog_run" } });
    const body = JSON.parse(result.content[0].text);
    expect(body).toMatchObject({ switched: false, error: "sidecar-restart-failed" });
    expect(body.message).toContain("source row was already saved");
    expect(logs).toEqual(["[kg] graph source sidecar -> stardog_run: failed"]);
    expect(getKgMemoryProvider()).toBeNull();
  });

  it("fails the switch when the restarted sidecar is unreachable", async () => {
    const kgDir = testDir("kg-tool-deps");
    const deps = createKgGraphSourceToolDeps({
      sidecar: { restart: async () => { process.env.KG_SIDECAR_URL = SIDECAR_URL; } },
      kgDir,
    });
    const logs: string[] = [];
    setKgGraphSourceToolDeps({ ...deps, countTriples: async () => 7, log: logTo(logs) });
    queueConnectionError();
    const result = await setKgGraphSourceTool(toolContext(), { caller: ADMIN, args: { source: "stardog_run" } });
    const body = JSON.parse(result.content[0].text);
    expect(body).toMatchObject({ switched: false, error: "sidecar-restart-failed" });
    expect(body.message).toContain("source row was already saved");
    expect(logs).toEqual(["[kg] graph source sidecar -> stardog_run: failed"]);
    expect(sidecarHealth.reachable).toBe(false);
  });

  it("clears an existing provider's cached Stardog error after a tested switch", async () => {
    const kgDir = testDir("kg-tool-deps");
    // The served namespace is injected so the full probe reaches its kg_neighbors call.
    const existing = new SidecarMemoryProvider(SIDECAR_URL, async () => "https://kg.example/");
    setKgMemoryProvider(existing);

    // A full probe against the old remote store caches its authentication error.
    setKgGraphSource("stardog_run");
    queueResponse(JSON.stringify({ jsonrpc: "2.0", id: "probe-tools-list", result: { tools: TOOLS } }));
    queueResponse(JSON.stringify({ jsonrpc: "2.0", id: "probe-kg-neighbors", result: { isError: true, content: [{ type: "text", text: "Unauthorized" }] } }));
    expect((await existing.probe()).lastError).toBe("Unauthorized");
    expect(sidecarHealthFields().kgUnavailable).toBe(true);

    const deps = createKgGraphSourceToolDeps({
      sidecar: { restart: async () => { process.env.KG_SIDECAR_URL = SIDECAR_URL; } },
      kgDir,
    });
    deps.saveGraphSource("stardog_run");
    // The restart's list-only probe sends tools/list only; it must not re-issue the store call.
    queueResponse(toolsList());
    await deps.restartSidecar();

    expect(getKgMemoryProvider()).toBe(existing);
    expect(sidecarHealthFields().kgUnavailable).toBe(false);
    expect(sidecarHealthFields().sidecar.lastError).toBeNull();
    expect(mockHttpRequest).toHaveBeenCalledTimes(3);
  });
});
