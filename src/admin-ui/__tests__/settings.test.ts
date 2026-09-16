import { describe, expect, it } from "vitest";
import { settingsHtml, settingsScript } from "../pages/settings.js";

describe("linear pickup label card", () => {
  it("declares the expected ids", () => {
    for (const id of [
      "settings-pickup-label",
      "settings-pickup-label-source",
      "settings-pickup-label-error",
    ]) {
      expect(settingsHtml).toContain(`id="${id}"`);
    }
  });

  it("is positioned right after the Fly Sessions App card", () => {
    const flyIdx = settingsHtml.indexOf("Fly Sessions App");
    const pickupIdx = settingsHtml.indexOf("Linear Pickup Label");
    const kgIdx = settingsHtml.indexOf("KG Refresh");
    expect(flyIdx).toBeGreaterThan(-1);
    expect(pickupIdx).toBeGreaterThan(flyIdx);
    expect(pickupIdx).toBeLessThan(kgIdx);
  });

  it("shows the warning visibly, without needing JS", () => {
    const cardStart = settingsHtml.indexOf("Linear Pickup Label");
    const cardBody = settingsHtml.slice(cardStart, settingsHtml.indexOf("KG Refresh"));
    expect(cardBody).toContain(
      "Changing this label changes which Linear issues this orchestrator dispatches. Change it only for a planned migration. Issues that carry the old label stop dispatching at the next poll. The lifecycle labels (AI-Planning, AI-Working, Plan-Complete, Ready for Review) do not change.",
    );
    expect(cardBody).toContain('class="warning"');
    expect(cardBody).not.toMatch(/class="warning[^"]*hidden/);
  });

  it("has the expected placeholder and buttons wired to the right handlers", () => {
    expect(settingsHtml).toContain('placeholder="AI-Implement"');
    expect(settingsHtml).toContain('onclick="savePickupLabel()"');
    expect(settingsHtml).toContain('onclick="resetPickupLabel()"');
    expect(settingsHtml).toContain('id="settings-pickup-label-error" class="error hidden"');
  });

  it("exposes savePickupLabel and resetPickupLabel on window", () => {
    expect(settingsScript).toContain("window.savePickupLabel = savePickupLabel");
    expect(settingsScript).toContain("window.resetPickupLabel = resetPickupLabel");
  });

  it("populates the input and source line from data.linearPickupLabel", () => {
    expect(settingsScript).toContain("pickupLabelInput.value = data.linearPickupLabel.value || ''");
    expect(settingsScript).toContain("data.linearPickupLabel.value === null ? ' (default)' : ' (from settings)'");
  });

  it("saves the trimmed input or null", () => {
    const save = settingsScript.slice(settingsScript.indexOf("async function savePickupLabel"));
    const body = save.slice(0, save.indexOf("\n  }"));
    expect(body).toContain(
      "window.api('/api/settings', { method: 'POST', body: JSON.stringify({ linearPickupLabel: val }) })",
    );
    expect(body).toContain("document.getElementById('settings-pickup-label').value.trim() || null");
  });

  it("resets unconditionally to null", () => {
    const reset = settingsScript.slice(settingsScript.indexOf("async function resetPickupLabel"));
    const body = reset.slice(0, reset.indexOf("\n  }"));
    expect(body).toContain(
      "window.api('/api/settings', { method: 'POST', body: JSON.stringify({ linearPickupLabel: null }) })",
    );
  });

  it("shows a 400 in the card's own error div, distinct from the page-level one", () => {
    const save = settingsScript.slice(settingsScript.indexOf("async function savePickupLabel"));
    const body = save.slice(0, save.indexOf("\n  }"));
    expect(body).toContain("document.getElementById('settings-pickup-label-error')");
    expect(body).not.toContain("getElementById('settings-error')");
  });
});
