// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
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

  it("warns under the Sessions App Name field that a change leaves in-flight runs in the old app", () => {
    const note = "Change it only when no Fly run is in flight. A change applies to the next dispatch. Runs in flight stay in the old app; the kept KG machine is cleaned in its own app.";
    const noteIdx = settingsHtml.indexOf(note);
    expect(noteIdx).toBeGreaterThan(settingsHtml.indexOf('id="settings-sessions-app-source"'));
    expect(noteIdx).toBeLessThan(settingsHtml.indexOf("Sessions Region"));
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

describe("runner image prefixes card", () => {
  const fnBody = (name: string) => {
    const from = settingsScript.slice(settingsScript.indexOf(`async function ${name}`));
    return from.slice(0, from.indexOf("\n  }"));
  };

  it("declares the ids, placeholder and handlers, after the KG Refresh card", () => {
    for (const id of [
      "settings-runner-image-prefixes",
      "settings-runner-image-prefixes-source",
    ]) {
      expect(settingsHtml).toContain(`id="${id}"`);
    }
    expect(settingsHtml).toContain('id="settings-runner-image-prefixes-error" class="error hidden"');
    expect(settingsHtml).toContain('placeholder="ghcr.io/acme/"');
    expect(settingsHtml).toContain('onclick="saveRunnerImagePrefixes()"');
    expect(settingsHtml).toContain('onclick="clearRunnerImagePrefixes()"');
    expect(settingsHtml.indexOf("Runner Image Prefixes")).toBeGreaterThan(settingsHtml.indexOf("KG Refresh"));
  });

  it("exposes both handlers on window", () => {
    expect(settingsScript).toContain("window.saveRunnerImagePrefixes = saveRunnerImagePrefixes");
    expect(settingsScript).toContain("window.clearRunnerImagePrefixes = clearRunnerImagePrefixes");
  });

  it("fills the input and source line from data.runnerImageAllowedPrefixes using textContent", () => {
    expect(settingsScript).toContain("const prefixes = data.runnerImageAllowedPrefixes");
    expect(settingsScript).toContain("getElementById('settings-runner-image-prefixes').value = prefixes.value || ''");
    expect(settingsScript).toContain("getElementById('settings-runner-image-prefixes-source').textContent");
    expect(settingsScript).toContain("'Built-in: ' + (prefixes.builtIn || []).join(', ')");
    expect(settingsScript).toContain("|| 'none'");
  });

  it("saves the trimmed input or null, and clear posts null", () => {
    expect(fnBody("saveRunnerImagePrefixes")).toContain(
      "getElementById('settings-runner-image-prefixes').value.trim() || null",
    );
    expect(fnBody("clearRunnerImagePrefixes")).toContain("postRunnerImagePrefixes(null)");
    expect(fnBody("postRunnerImagePrefixes")).toContain(
      "JSON.stringify({ runnerImageAllowedPrefixes: val })",
    );
  });

  it("shows a 400 error in its own error element and never uses innerHTML", () => {
    const body = fnBody("postRunnerImagePrefixes");
    expect(body).toContain("getElementById('settings-runner-image-prefixes-error')");
    expect(body).toContain("errEl.textContent = data.error");
    expect(body).not.toContain("getElementById('settings-error')");
    expect(body).not.toContain("innerHTML");
  });
});

describe("orchestrator agent defaults card", () => {
  it("is declared with its own error element and no raw credential field", () => {
    expect(settingsHtml).toContain('id="settings-agent-defaults-mode"');
    expect(settingsHtml).toContain('id="settings-agent-defaults-error" class="error hidden"');
    expect(settingsHtml).toContain("When defaults are on, a new project starts configured. An existing project keeps its mode.");
    expect(settingsHtml).toContain("new projects start configured, existing projects keep their mode");
    expect(settingsHtml).toContain('onclick="saveAgentDefaultsMode()"');
    const dom = document.createElement("div");
    dom.innerHTML = settingsHtml;
    expect(dom.textContent).not.toMatch(/opt in|opt-in|opts in|opted-in/i);
    expect(settingsHtml).toContain("Changes apply to the next run");
  });
});


describe("runner backend source line", () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  it.each([
    ["not-loaded", "sessions-test", "Restate has not answered yet"],
    ["not-loaded", null, "Restate has not answered yet"],
    ["restate", "sessions-test", "Active: sessions-test (source: restate)"],
    ["restate", null, "Not configured — add a sessions app name to enable Fly dispatch"],
  ])("renders %s with app %s", async (runnerBackendSource, runtimeValue, expected) => {
    document.body.innerHTML = settingsHtml;
    const responses: Record<string, unknown> = {
      "/api/settings": {
        runnerBackendSource,
        flySessionsApp: { runtimeValue },
        flySessionsRegion: { runtimeValue: null },
        linearPickupLabel: { value: null, effective: "AI-Implement" },
        retryPolicyDefaults: {},
      },
      "/api/global-secrets": [],
      "/api/agent-defaults": { configured: false, mode: "legacy", stages: {} },
    };
    vi.stubGlobal("api", vi.fn(async (url: string) => {
      if (!(url in responses)) throw new Error("Unexpected request: " + url);
      return { ok: true, status: 200, json: async () => responses[url] };
    }));
    vi.stubGlobal("esc", (s: string) => s);
    vi.stubGlobal("isAdmin", () => false);
    let init = () => {};
    vi.stubGlobal("registerPage", (_: string, fn: () => void) => { init = fn; });
    new Function(settingsScript)();
    init();
    await vi.waitFor(() => {
      expect(document.getElementById("settings-sessions-app-source")!.textContent).toBe(expected);
    });
  });

  it("removes the retired source wording", () => {
    expect(settingsScript).not.toContain("source: fallback");
    expect(settingsScript).not.toContain("Restate not read yet");
  });
});
