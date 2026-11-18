// loadConfig's boot behaviors that share a decision with a setup check (AII-1532, pinned by AII-1544): boot reads the environment
// through the same functions the checks judge it with, so what a check reports is what boot did.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as IndexModule from "../index.js";
import { testDb } from "./helpers/test-db.js";

let index: typeof IndexModule;
let warn: ReturnType<typeof vi.spyOn>;

beforeEach(async () => {
  ({ index } = (await testDb({ modules: { index: () => import("../index.js") } })).modules);
  vi.stubEnv("GITHUB_APP_ID", "1");
  vi.stubEnv("GITHUB_APP_PRIVATE_KEY", "key");
  vi.spyOn(console, "log").mockImplementation(() => {});
  warn = vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("loadConfig", () => {
  it("refuses the published placeholder access code, as env.admin-access-code reports it", () => {
    vi.stubEnv("ADMIN_ACCESS_CODE", "your-secret-access-code");
    expect(index.loadConfig().adminAccessCode).toBeNull();
    vi.stubEnv("ADMIN_ACCESS_CODE", "a-real-code");
    expect(index.loadConfig().adminAccessCode).toBe("a-real-code");
  });

  it("reads the poll interval from POLL_INTERVAL_MS with the parse env.poll-interval judges", () => {
    vi.stubEnv("POLL_INTERVAL_MS", "120000");
    expect(index.loadConfig().pollIntervalMs).toBe(120_000);
    // The shared parse keeps a value's leading digits, so the check and boot read "90000ms" alike.
    vi.stubEnv("POLL_INTERVAL_MS", "90000ms");
    expect(index.loadConfig().pollIntervalMs).toBe(90_000);
  });

  it("logs each sign-in provider it drops, naming what is missing", () => {
    vi.stubEnv("GOOGLE_OAUTH_CLIENT_ID", "client-id");
    index.loadConfig();
    expect(warn).toHaveBeenCalledWith("[main] google sign-in disabled: GOOGLE_OAUTH_CLIENT_SECRET not set");
  });
});
