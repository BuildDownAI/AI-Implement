import { describe, expect, it } from "vitest";
import { icon, iconRegistry } from "../icons.js";

describe("icon registry", () => {
  it("includes every icon used by the sidebar", () => {
    const required = ["activity", "inbox", "queue", "git", "alert", "folder", "flow", "bolt", "broadcast", "shield", "cpu", "server", "broom", "key", "settings", "plug", "webhook", "history", "fork", "download"];
    for (const name of required) {
      expect(iconRegistry[name], `missing icon: ${name}`).toBeTruthy();
    }
  });

  it("renders inline SVG with the requested size", () => {
    const svg = icon("alert", 16);
    expect(svg).toMatch(/width="16"/);
    expect(svg).toMatch(/<path d="M10\.29 3\.86/);
  });
});
