import { describe, it, expect, beforeEach } from "vitest";
import type * as LogModule from "../log.js";
import { testDb } from "./helpers/test-db.js";

let log: typeof LogModule;

beforeEach(async () => {
  ({ log } = (await testDb({ modules: { log: () => import("../log.js") } })).modules);
});

describe("getLatestTeamKeyForIssue", () => {
  it("returns the newest non-null team_key, skipping NULL rows", () => {
    log.appendLog({ issueId: "i1", teamKey: "A" });
    log.appendLog({ issueId: "i1", teamKey: "B" });
    log.appendLog({ issueId: "i1" });
    log.appendLog({ issueId: "other", teamKey: "Z" });
    expect(log.getLatestTeamKeyForIssue("i1")).toBe("B");
  });

  it("returns null for an issue with no rows", () => {
    expect(log.getLatestTeamKeyForIssue("missing")).toBeNull();
  });

  it("returns null when every row has a NULL team_key", () => {
    log.appendLog({ issueId: "i2" });
    log.appendLog({ issueId: "i2" });
    expect(log.getLatestTeamKeyForIssue("i2")).toBeNull();
  });
});
