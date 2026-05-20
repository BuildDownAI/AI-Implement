import { describe, expect, it } from "vitest";
import { resolveExecutionPath } from "../runner-mode.js";

describe("resolveExecutionPath", () => {
  describe("shadow mode", () => {
    it("returns both for shadow + github-actions mapping", () => {
      expect(resolveExecutionPath("shadow", "github-actions")).toBe("both");
    });

    it("returns both for shadow + fly-machines mapping", () => {
      expect(resolveExecutionPath("shadow", "fly-machines")).toBe("both");
    });
  });

  describe("gha override", () => {
    it("returns github-actions for gha + github-actions mapping", () => {
      expect(resolveExecutionPath("gha", "github-actions")).toBe("github-actions");
    });

    it("returns github-actions for gha + fly-machines mapping (override)", () => {
      expect(resolveExecutionPath("gha", "fly-machines")).toBe("github-actions");
    });
  });

  describe("fly override", () => {
    it("returns fly-machines for fly + github-actions mapping (override)", () => {
      expect(resolveExecutionPath("fly", "github-actions")).toBe("fly-machines");
    });

    it("returns fly-machines for fly + fly-machines mapping", () => {
      expect(resolveExecutionPath("fly", "fly-machines")).toBe("fly-machines");
    });
  });

  describe("local override", () => {
    it("returns local-docker for local + github-actions mapping", () => {
      expect(resolveExecutionPath("local", "github-actions")).toBe("local-docker");
    });

    it("returns local-docker for local + fly-machines mapping", () => {
      expect(resolveExecutionPath("local", "fly-machines")).toBe("local-docker");
    });
  });

  describe("default mode — respects per-team executionMode", () => {
    it("returns github-actions when mapping is github-actions", () => {
      expect(resolveExecutionPath("default", "github-actions")).toBe("github-actions");
    });

    it("returns fly-machines when mapping is fly-machines", () => {
      expect(resolveExecutionPath("default", "fly-machines")).toBe("fly-machines");
    });
  });
});
