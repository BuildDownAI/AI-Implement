import { describe, expect, it, vi } from "vitest";
import { JSDOM } from "jsdom";
import { helpersJs } from "../helpers.js";
import { stepperHtml, stepperScript } from "../stepper.js";
import { mountAdminPage, type FakeApiResponse } from "../../__tests__/helpers/fixtures/admin-ui.js";

/** Rail order. Inserting a step renumbers every later one, so this is the spine of the file. */
const STEPS = ["Ticketing", "Config", "Source", "Context", "Execution", "Provider", "Capacity", "Secrets", "Review"];

describe("new-project stepper — step numbering", () => {
  it("declares one block per step and no more", () => {
    for (let i = 0; i < STEPS.length; i++) expect(stepperHtml).toContain(`data-step="${i}"`);
    expect(stepperHtml).not.toContain(`data-step="${STEPS.length}"`);
    const blocks = [...stepperHtml.matchAll(/data-step="(\d)"/g)].map((m) => m[1]);
    expect(blocks.length).toBe(new Set(blocks).size);
  });

  it("keeps LAST_STEP, STEP_LABELS and the markup in agreement", () => {
    expect(stepperScript).toContain(`const LAST_STEP = ${STEPS.length - 1};`);
    const labels = stepperScript.match(/STEP_LABELS = \[(.*?)\]/)?.[1] ?? "";
    expect(labels.split(",").map((s) => s.trim().replace(/'/g, ""))).toEqual(STEPS);
  });

  // Every step must be reachable by collectStep, or its fields are silently dropped when
  // the operator moves past it. Review (the last) collects nothing.
  it("collects every step except Review", () => {
    const body = stepperScript.slice(stepperScript.indexOf("function collectStep"));
    for (let i = 0; i < STEPS.length - 1; i++) {
      expect(body, `collectStep has no branch for step ${i} (${STEPS[i]})`).toContain(`n === ${i}`);
    }
  });
});

describe("new-project stepper", () => {
  it("declares all nine step blocks", () => {
    for (let i = 0; i < STEPS.length; i++) expect(stepperHtml).toContain(`data-step="${i}"`);
  });

  it("splits Ticketing into a system-select step and a provider-specific config step", () => {
    expect(stepperHtml).toContain('id="np-ticketing-provider"');
    expect(stepperHtml).toContain('id="np-linear-config"');
    expect(stepperHtml).toContain('id="np-jira-config"');
    expect(stepperHtml).toContain('id="np-jira-jql"');
    expect(stepperHtml).toContain('id="np-jira-repo-value"');
  });

  it("moves the Linear Team Key out of the Source step into the Ticketing Config step", () => {
    // np-teamKey lives inside np-linear-config (data-step="1"), not data-step="2".
    const linearCfgIdx = stepperHtml.indexOf('id="np-linear-config"');
    const teamKeyIdx = stepperHtml.indexOf('id="np-teamKey"');
    const ownerIdx = stepperHtml.indexOf('id="np-owner"');
    expect(linearCfgIdx).toBeGreaterThan(-1);
    expect(teamKeyIdx).toBeGreaterThan(linearCfgIdx);
    expect(teamKeyIdx).toBeLessThan(ownerIdx);
  });

  it("posts ticketingProvider and ticketingConfig", () => {
    expect(stepperScript).toContain("ticketingProvider:");
    expect(stepperScript).toContain("ticketingConfig:");
  });

  it("offers filesystem ticketing with a local directory input", () => {
    expect(stepperHtml).toContain('<option value="filesystem">Filesystem / local</option>');
    expect(stepperHtml).toContain('id="np-filesystem-config"');
    expect(stepperHtml).toContain('id="np-filesystem-directory"');
    expect(stepperHtml).toContain("/private/tmp/filesystem-local-tickets");
    expect(stepperHtml).toContain("RUNNER_MODE=local");
    expect(stepperHtml).toContain("real GitHub PRs");
  });

  it("declares the input ids the script reads", () => {
    for (const id of ["np-teamKey", "np-owner", "np-repo", "np-defaultBranch", "np-sessionMode", "np-awsRegion", "np-maxAi"]) {
      expect(stepperHtml).toContain(`id="${id}"`);
    }
  });

  it("collects and submits the configured default branch", () => {
    expect(stepperScript).toContain("defaultBranch:");
    expect(stepperScript).toContain("np-defaultBranch");
    expect(stepperScript).toContain("defaultBranch: data.defaultBranch");
  });

  it("exposes navigation handlers on window", () => {
    for (const sym of ["openNewProjectStepper", "closeNewProjectStepper", "stepperBack", "stepperNext", "stepperSubmit"]) {
      expect(stepperScript).toContain(`window.${sym} = ${sym}`);
    }
  });

  it("submits to existing /api/mappings (no new endpoint)", () => {
    expect(stepperScript).toContain("/api/mappings");
    expect(stepperScript).not.toMatch(/\/api\/(projects|new-project|stepper)\b/);
  });

  it("uses window.api/window.esc only", () => {
    const stripped = stepperScript.replace(/window\.api\(/g, "").replace(/window\.esc\(/g, "");
    expect(stripped).not.toMatch(/\bapi\(/);
    expect(stripped).not.toMatch(/\besc\(/);
  });

  it("uses const/let, not var", () => {
    expect(stepperScript).not.toMatch(/\bvar\s+\w/);
  });
});

describe("new-project stepper — filesystem ticketing behavior", () => {
  it.each(["ai-implement", "codex-code-review"])("submits filesystem config and %s reviewer settings", async (reviewProcess) => {
    const dom = new JSDOM(`<!doctype html><body>${stepperHtml}</body>`, { runScripts: "outside-only" });
    const win = dom.window as unknown as Record<string, any>;
    const doc = dom.window.document;
    const posts: any[] = [];
    dom.window.eval(helpersJs);
    win.api = async (path: string, init?: RequestInit) => {
      if (path === "/api/admin/config-status") {
        return { ok: true, json: async () => ({ linear: true, jira: true }) };
      }
      if (path === "/api/mappings" && init?.method === "POST") {
        posts.push(JSON.parse(String(init.body)));
        return { ok: true, json: async () => ({ syncJobId: "sync-1" }) };
      }
      if (path === "/api/mappings/validate") return { ok: true, status: 200, json: async () => ({ valid: true }) };
      if (path === "/api/setup-checks/candidate") return { ok: true, status: 200, json: async () => ({ results: [] }) };
      throw new Error(`unexpected api call ${path}`);
    };
    win.refRepoRowsHtml = () => "";
    win.refRepoStage = () => null;
    win.loadMappings = async () => {};
    win.pollSyncStatus = () => {};
    dom.window.eval(stepperScript);

    win.openNewProjectStepper();
    win.selectExecutionMode("fly-machines");
    (doc.getElementById("np-ticketing-provider") as HTMLSelectElement).value = "filesystem";
    win.onStepperTicketingProviderChange();
    expect(doc.getElementById("np-local-docker-note")?.hasAttribute("hidden")).toBe(false);
    await win.stepperNext();
    (doc.getElementById("np-filesystem-directory") as HTMLInputElement).value = "/private/tmp/filesystem-local-tickets";
    await win.stepperNext();
    (doc.getElementById("np-owner") as HTMLInputElement).value = "BuildDownAI";
    (doc.getElementById("np-repo") as HTMLInputElement).value = "AI-Implement";
    (doc.getElementById("np-defaultBranch") as HTMLInputElement).value = "testing";
    for (let step = 2; step < 7; step++) await win.stepperNext();
    (doc.getElementById("np-review-process") as HTMLSelectElement).value = reviewProcess;
    expect(doc.getElementById("np-review-fix-lifecycle")).toBeNull();
    await win.stepperNext();
    // Create waits for the checks Review runs as it opens.
    await vi.waitFor(() => expect((doc.getElementById("np-setup-check-btn") as HTMLButtonElement).disabled).toBe(false));
    await win.stepperSubmit();

    expect(posts).toHaveLength(1);
    expect(posts[0]).toMatchObject({
      teamKey: "filesystem_BuildDownAI_AI-Implement",
      owner: "BuildDownAI",
      repo: "AI-Implement",
      defaultBranch: "testing",
      ticketingProvider: "filesystem",
      ticketingConfig: { kind: "filesystem", directory: "/private/tmp/filesystem-local-tickets" },
      executionMode: "github-actions",
      sessionMode: "autonomous",
      provider: "anthropic",
      planningEnabled: true,
      autoApprovePlans: true,
      reviewProcess,
    });
    expect(posts[0]).not.toHaveProperty("reviewFixLifecycle");
    // The actual submitted key must also be usable by the filesystem provider.
    const { ProviderRegistry } = await import("../../providers/registry.js");
    const previousMode = process.env.RUNNER_MODE;
    process.env.RUNNER_MODE = "local";
    try {
      const registry = new ProviderRegistry({}, () => ({ [posts[0].teamKey]: posts[0] }));
      const provider = await registry.forMapping(posts[0]);
      await expect(provider.fetchAIImplementSnapshot()).resolves.toHaveProperty("readyForImplementation");
    } finally {
      if (previousMode === undefined) delete process.env.RUNNER_MODE;
      else process.env.RUNNER_MODE = previousMode;
    }
  });

  it("rejects a relative filesystem ticket directory before submitting", async () => {
    const dom = new JSDOM(`<!doctype html><body>${stepperHtml}</body>`, { runScripts: "outside-only" });
    const win = dom.window as unknown as Record<string, any>;
    const doc = dom.window.document;
    const posts: any[] = [];
    dom.window.eval(helpersJs);
    win.api = async (path: string, init?: RequestInit) => {
      if (path === "/api/admin/config-status") return { ok: true, json: async () => ({ linear: true, jira: true }) };
      if (path === "/api/mappings" && init?.method === "POST") posts.push(JSON.parse(String(init.body)));
      return { ok: true, json: async () => ({}) };
    };
    win.refRepoRowsHtml = () => "";
    win.refRepoStage = () => null;
    dom.window.eval(stepperScript);

    win.openNewProjectStepper();
    (doc.getElementById("np-ticketing-provider") as HTMLSelectElement).value = "filesystem";
    win.onStepperTicketingProviderChange();
    await win.stepperNext();
    (doc.getElementById("np-filesystem-directory") as HTMLInputElement).value = "tickets";
    await win.stepperNext();

    expect(posts).toHaveLength(0);
    expect(doc.getElementById("np-error")?.textContent).toContain("absolute path");
  });
});

describe("new-project stepper — the four touch points a new field needs", () => {
  // The initializer and the reset inside openNewProjectStepper are two separate lists.
  // A field added to one and not the other keeps its previous value across a reopen.
  it("resets every field the initializer declares", () => {
    const init = stepperScript.slice(
      stepperScript.indexOf("const data = {"),
      stepperScript.indexOf("let jiraFieldsLoaded"),
    );
    const fields = [...init.matchAll(/(\w+):/g)].map((m) => m[1]);
    expect(fields.length).toBeGreaterThan(20);
    const reset = stepperScript.slice(
      stepperScript.indexOf("function openNewProjectStepper"),
      stepperScript.indexOf("// Clear inputs"),
    );
    for (const field of fields) {
      expect(reset, `data.${field} is declared but never reset on reopen`).toContain(`data.${field} =`);
    }
  });

  it("clears only inputs that exist in the markup", () => {
    const list = stepperScript.match(/const toClear = \[(.*?)\]/s)?.[1] ?? "";
    const ids = [...list.matchAll(/'([^']+)'/g)].map((m) => m[1]);
    expect(ids.length).toBeGreaterThan(8);
    for (const id of ids) {
      expect(stepperHtml, `toClear names ${id}, which no element declares`).toContain(`id="${id}"`);
    }
  });

  it.each([
    ["machineCpuKind", "np-cpu-kind"],
    ["branchPrefix", "np-branch-prefix"],
    ["maxTurns", "np-maxTurns"],
    ["maxIterations", "np-maxIterations"],
    ["prDispatchBudget", "np-prDispatchBudget"],
    ["maxJobMinutes", "np-maxJobMinutes"],
    ["reviewProcess", "np-review-process"],
    ["trustedReviewAuthors", "np-trusted-review-authors"],
  ])("%s is declared, reset, collected and submitted", (field, id) => {
    expect(stepperHtml).toContain(`id="${id}"`);
    expect(stepperScript).toContain(`data.${field} =`);
    expect(stepperScript).toContain(`'${id}'`);
    expect(stepperScript).toMatch(new RegExp(`${field}: data\\.${field}`));
  });
});

describe("new-project stepper — cap validation", () => {
  // Mirrors resolveCap on the server: integer, at least 1, or null for the default. The
  // point of checking here is to name the field rather than round-trip a 400.
  it("rejects a cap that is not a positive integer, and allows a blank one", () => {
    expect(stepperScript).toContain("function badCap(value)");
    expect(stepperScript).toContain("value !== null && (!Number.isInteger(value) || value < 1)");
  });

  it("checks all three optional caps, not only the required one", () => {
    for (const field of ["maxTurns", "maxIterations", "prDispatchBudget", "maxJobMinutes"]) {
      expect(stepperScript).toContain(`'${field}'`);
    }
    expect(stepperScript).toContain("for (const cap of CAP_FIELDS)");
  });

  // parseInt("1.5") is 1, so a decimal would become a different valid number instead of
  // an error. Number() keeps it non-integer so badCap can reject it.
  it("parses with Number rather than parseInt, so a decimal cannot truncate silently", () => {
    expect(stepperScript).not.toContain("parseInt(v, 10)");
    expect(stepperScript).toContain("v === '' ? null : Number(v)");
  });
});

describe("new-project stepper — field placement", () => {
  const stepOf = (id: string): number => {
    const at = stepperHtml.indexOf(`id="${id}"`);
    const before = [...stepperHtml.slice(0, at).matchAll(/data-step="(\d)"/g)];
    return Number(before[before.length - 1][1]);
  };

  it.each([
    ["np-owner", 2],
    ["np-defaultBranch", 2],
    ["np-branch-prefix", 2],
    ["np-sensitive-add", 2],
    ["np-sensitive-allow", 2],
    ["np-skills-repo", 3],
    ["np-dep-token-scope", 3],
    ["np-sessionMode", 4],
    ["np-maxAi", 6],
    ["np-maxTurns", 6],
    ["np-prDispatchBudget", 6],
    ["np-maxJobMinutes", 6],
    ["np-review-process", 6],
    ["np-trusted-review-authors", 6],
  ])("%s sits on step %i", (id, step) => {
    expect(stepOf(id)).toBe(step);
  });

  it("gives the Context step its own heading rather than folding it into Source", () => {
    expect(stepperHtml).toContain('<h3 style="font-size:13px;font-weight:600;margin:0 0 4px">Context</h3>');
  });

  it("renames the Runner step to Execution, so it does not collide with Runner context", () => {
    expect(stepperHtml).toContain('<h3 style="font-size:13px;font-weight:600;margin:0 0 4px">Execution</h3>');
    expect(stepperHtml).not.toContain(">Runner</h3>");
  });
});

describe("new-project stepper — review step", () => {
  it.each([["branchPrefix"], ["caps"], ["reviewProcess"], ["trustedReviewAuthors"]])("has a review row for %s", (key) => {
    expect(stepperHtml).toContain(`data-review="${key}"`);
  });

  const review = () => {
    const doc = new JSDOM(`<!doctype html><body>${stepperHtml}</body>`).window.document;
    return doc.querySelector('[data-step="8"]')!;
  };

  // The review mirrors the rail so a wrong value tells you which step to go back to.
  it("groups its rows under the step each value was set on, then the pinned defaults and the orchestrator's own checks", () => {
    const headings = Array.from(review().querySelectorAll(".section-h h3"), (h) => h.textContent);
    expect(headings).toEqual(["Ticketing", "Source", "Context", "Execution", "Provider", "Capacity", "Secrets", "Pinned defaults", "This orchestrator"]);
  });

  it("puts every review row in a section under its heading", () => {
    const rows = Array.from(review().querySelectorAll(".np-review-row"));
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) expect(row.closest(".np-review-rows")!.parentElement!.querySelector(":scope > .section-h h3")).not.toBeNull();
  });

  // Change goes back to the section's steps, so only a section an operator set has one.
  it("offers Change on each section an operator set, and on neither the pinned defaults nor the orchestrator's", () => {
    const sections = Array.from(review().querySelectorAll(".section-h"), (h) => [h.querySelector("h3")!.textContent, !!h.querySelector(".np-review-change")]);
    expect(sections.filter(([, change]) => !change).map(([name]) => name)).toEqual(["Pinned defaults", "This orchestrator"]);
  });

  it("populates every review slot the markup declares", () => {
    const keys = [...stepperHtml.matchAll(/data-review="(\w+)"/g)].map((m) => m[1]);
    for (const key of keys) {
      expect(stepperScript, `no set('${key}', …) in populateReview`).toContain(`set('${key}'`);
    }
  });

  // Constants, so they live in the markup rather than being written by populateReview.
  it("names the three values the stepper pins and the dialog can change later", () => {
    const pinned = stepperHtml.slice(stepperHtml.indexOf("Pinned defaults"));
    expect(pinned).toContain("claude-implement.yml");
    expect(pinned).toContain("claude-plan.yml");
    expect(pinned).toContain("Extra env");
  });
});

describe("new-project stepper — review process and trusted authors", () => {
  it("renders the select options and the exact hints", () => {
    expect(stepperHtml).toContain('<option value="claude-code-review">Claude Code Review</option>');
    expect(stepperHtml).toContain('<option value="claude-code-review-repository-fix">Claude Code Review, repository auto-fix</option>');
    expect(stepperHtml).toContain("Extra bot or user logins whose review findings count, in addition to the review process's own authors. A trusted author can approve a PR.");
  });

  it("resets the select, sends both fields, and escapes authors in the summary", () => {
    expect(stepperScript).toContain("reviewProcessEl.value = 'ai-implement'");
    expect(stepperScript).toContain("reviewProcess: data.reviewProcess");
    expect(stepperScript).toContain("trustedReviewAuthors: data.trustedReviewAuthors");
    expect(stepperScript).toContain("window.esc(l)");
    expect(stepperScript).toContain("split('\\n')");
  });
});

const reply = (status: number, body: unknown): FakeApiResponse => ({ ok: status < 400, status, json: async () => body });
type Answer = FakeApiResponse | Promise<FakeApiResponse>;
type Body = Record<string, unknown>;

/** A setup-check row of project AII's unless the extras say otherwise. */
const result = (id: string, state: string, extra: Body = {}) => ({ id, group: "github", tier: "core", title: `Title of ${id}`, state, detail: `Detail of ${id}`, project: "AII", ...extra });

/**
 * The stepper mounted as the Projects page mounts it, with the candidate checks answering `candidate` and the save's
 * validation answering `validate` (by default no rows, and accepted), and a record of what each route was sent.
 */
function mountStepper(options: { candidate?: (body: Body) => Answer; validate?: (body: Body) => Answer; save?: (body: Body) => Answer } = {}) {
  const candidates: Body[] = [];
  const validations: Body[] = [];
  const saves: Body[] = [];
  const { win, doc } = mountAdminPage({
    html: stepperHtml,
    script: stepperScript,
    route: "projects",
    api: async (url, init) => {
      if (url === "/api/admin/config-status") return reply(200, { linear: true, jira: true });
      const body = JSON.parse(init?.body ?? "{}");
      if (url === "/api/mappings/validate") {
        validations.push(body);
        return options.validate ? options.validate(body) : reply(200, { valid: true });
      }
      if (url === "/api/setup-checks/candidate") {
        candidates.push(body);
        return options.candidate ? options.candidate(body) : reply(200, { results: [] });
      }
      if (url === "/api/mappings" && init?.method === "POST") {
        saves.push(body);
        return options.save ? options.save(body) : reply(200, { syncJobId: null });
      }
      throw new Error(`unexpected api call ${url}`);
    },
    // These come from the Projects page, which the stepper is mounted inside.
    before: (w) => {
      w.refRepoRowsHtml = () => "";
      w.refRepoStage = () => null;
      w.loadMappings = async () => {};
      w.pollSyncStatus = () => {};
    },
  });
  const el = <T extends HTMLElement = HTMLElement>(id: string) => doc.getElementById(id) as T;
  const input = (id: string, value: string) => {
    const field = el<HTMLInputElement>(id);
    field.value = value;
    field.dispatchEvent(new win.Event("input"));
  };
  const shownStep = () => Number((Array.from(doc.querySelectorAll("#np-step-body [data-step]")) as HTMLElement[]).find((b) => !b.hidden)!.dataset.step);
  const error = () => (el("np-error").classList.contains("hidden") ? null : el("np-error").textContent);
  const next = () => win.stepperNext() as Promise<void>;
  const checkButton = () => el<HTMLButtonElement>("np-setup-check-btn");
  const create = () => el<HTMLButtonElement>("np-create");
  /** Waits until Review's checks have answered, which gives the button back. */
  const settled = () => vi.waitFor(() => expect(checkButton().disabled).toBe(false));
  /** Opens the stepper and fills Linear team AII and acme/widgets on main, ending on Source. */
  async function toSource() {
    win.openNewProjectStepper();
    await next();
    input("np-teamKey", "AII");
    await next();
    input("np-owner", "acme");
    input("np-repo", "widgets");
    input("np-defaultBranch", "main");
  }
  /** Walks on from Source to Review, as Continue does. */
  async function toReview() {
    await toSource();
    for (let step = 2; step < 8; step++) await next();
  }
  const section = (key: string) => doc.querySelector(`.np-review-section[data-section="${key}"]`) as HTMLElement;
  const ids = (key: string) => Array.from(section(key).querySelectorAll(".setup-check-item .setup-check-id"), (item) => item.textContent);
  return { win, doc, el, input, shownStep, error, next, checkButton, create, settled, toSource, toReview, section, ids, candidates, validations, saves };
}

describe("new-project stepper — Create refused by the server", () => {
  // The step comes from where the markup puts the setting; a Linear project's key is asked for on Ticketing Config.
  it.each([
    ["defaultBranch", 2],
    ["teamKey", 1],
    ["machineCpuKind", 4],
  ] as const)("goes back to the step holding %s, step %i, whose Continue returns to Review", async (field, step) => {
    const error = "The setting was refused.";
    const m = mountStepper({ save: () => reply(400, { error, field }) });
    await m.toReview();
    await m.settled();
    await m.win.stepperSubmit();
    expect([m.shownStep(), m.error(), m.el("np-next").textContent]).toEqual([step, error, "Back to review"]);
  });

  it("stays on Review for a refusal that names no setting", async () => {
    const m = mountStepper({ save: () => reply(400, { error: "Invalid request body" }) });
    await m.toReview();
    await m.settled();
    await m.win.stepperSubmit();
    expect([m.shownStep(), m.error()]).toEqual([8, "Invalid request body"]);
  });
});

// Closing the stepper does not stop a Create already sent, and the stepper can be opened again for another project before it answers.
describe("new-project stepper — a Create answered after the stepper opened again", () => {
  function pendingSave() {
    let answer: (reply: FakeApiResponse) => void = () => {};
    const saved = new Promise<FakeApiResponse>((resolve) => { answer = resolve; });
    return { saved, answer };
  }

  it("leaves the new form where it is when the refusal arrives", async () => {
    const save = pendingSave();
    const m = mountStepper({ save: () => save.saved });
    await m.toReview();
    await m.settled();
    const submitted = m.win.stepperSubmit() as Promise<void>;
    m.win.closeNewProjectStepper();
    m.win.openNewProjectStepper();
    save.answer(reply(400, { error: "The setting was refused.", field: "defaultBranch" }));
    await submitted;
    expect([m.shownStep(), m.error(), m.el("np-next").textContent]).toEqual([0, null, "Continue →"]);
  });

  it("keeps the new form open, and seeds the secrets the first project was created with, when the save succeeds", async () => {
    const save = pendingSave();
    const secretsSent: Array<{ url: string; body: Body }> = [];
    const m = mountStepper({ save: () => save.saved });
    const api = m.win.api as (url: string, init?: RequestInit) => Promise<FakeApiResponse>;
    m.win.api = async (url: string, init?: RequestInit) => {
      if (url.endsWith("/secrets")) {
        secretsSent.push({ url, body: JSON.parse(String(init?.body ?? "{}")) });
        return reply(200, {});
      }
      return api(url, init);
    };
    await m.toReview();
    m.win.addSecretRow();
    (m.doc.querySelector(".np-secret-name") as HTMLInputElement).value = "TOKEN";
    (m.doc.querySelector(".np-secret-value") as HTMLInputElement).value = "first";
    await m.settled();
    const submitted = m.win.stepperSubmit() as Promise<void>;
    m.win.closeNewProjectStepper();
    m.win.openNewProjectStepper();
    save.answer(reply(200, { syncJobId: null }));
    await submitted;
    expect(m.el("np-stepper-wrap").hasAttribute("hidden")).toBe(false);
    expect(secretsSent).toEqual([{ url: "/api/mappings/AII/secrets", body: { name: "TOKEN", value: "first" } }]);
  });
});

describe("new-project stepper — Review's setup checks", () => {
  it("shows a section's rows waiting on the same check as one item", async () => {
    const waiting = (id: string) => result(id, "cannot-verify", { group: "tracker", fix: "f", waitsOnCheck: "tracker.provider" });
    const m = mountStepper({ candidate: () => reply(200, { results: [waiting("tracker.linear.team-access"), waiting("tracker.linear.pickup-label"), result("tracker.linear.workflow-states", "fail", { group: "tracker" })] }) });
    await m.toReview();
    await m.settled();
    expect([...m.ids("ticketing")].sort()).toEqual(["tracker.linear.team-access, tracker.linear.pickup-label", "tracker.linear.workflow-states"]);
  });

  it("runs the checks as Review opens, for the project exactly as Create then saves it", async () => {
    const m = mountStepper();
    await m.toReview();
    await m.settled();
    await m.win.stepperSubmit();
    expect(m.candidates).toHaveLength(1);
    expect(m.candidates[0]).toMatchObject({ teamKey: "AII", owner: "acme", repo: "widgets", defaultBranch: "main", ticketingProvider: "linear" });
    expect(m.saves).toEqual(m.candidates);
  });

  it("places each check under the section holding the settings it reads, the orchestrator's own last", async () => {
    const m = mountStepper({ candidate: () => reply(200, { results: [
      result("tracker.linear.team-access", "warn"),
      result("github.installation", "warn"),
      result("github.skills-repo", "warn"),
      result("github.target-secrets", "warn"),
      result("github.review-process", "warn"),
      result("tracker.linear.credentials", "warn", { project: undefined }),
    ] }) });
    await m.toReview();
    await m.settled();
    expect(["ticketing", "source", "context", "execution", "provider", "capacity", "secrets", "orchestrator"].map((key) => [key, m.ids(key)])).toEqual([
      ["ticketing", ["tracker.linear.team-access"]],
      ["source", ["github.installation"]],
      ["context", ["github.skills-repo"]],
      ["execution", ["github.target-secrets"]],
      ["provider", []],
      ["capacity", ["github.review-process"]],
      ["secrets", []],
      ["orchestrator", ["tracker.linear.credentials"]],
    ]);
    expect(m.section("provider").querySelector(".np-checks-card")).toBeNull();
  });

  it("lists a section's open checks worst first, folds the passing and not-applicable ones, and shades every other check across the fold", async () => {
    const m = mountStepper({ candidate: () => reply(200, { results: [
      result("a.pass", "pass"), result("b.not-applicable", "not-applicable"), result("c.warn", "warn"), result("d.fail", "fail"), result("e.cannot-verify", "cannot-verify"),
    ] }) });
    await m.toReview();
    await m.settled();
    const items = Array.from(m.section("source").querySelectorAll(".setup-check-item")) as HTMLElement[];
    expect(m.ids("source")).toEqual(["d.fail", "e.cannot-verify", "c.warn", "a.pass", "b.not-applicable"]);
    expect(items.map((item) => item.hidden)).toEqual([false, false, false, true, true]);
    expect(items.map((item) => item.classList.contains("shaded"))).toEqual([false, true, false, true, false]);
    const fold = m.section("source").querySelector(".np-review-fold button") as HTMLButtonElement;
    expect(fold.textContent).toContain("1 passing, 1 not applicable");
    fold.click();
    expect(items.map((item) => item.hidden)).toEqual([false, false, false, false, false]);
    expect(fold.getAttribute("aria-expanded")).toBe("true");
  });

  // Shown only when it has rows, and then only the rows that need attention: a passing one alone shows a note and no check.
  it.each([
    ["has no rows", [], true, []],
    ["has only passing rows", [result("env.poll-interval", "pass", { project: undefined })], false, []],
    ["has a failing row", [result("env.poll-interval", "pass", { project: undefined }), result("restate", "fail", { project: undefined })], false, ["restate"]],
  ] as [string, Body[], boolean, string[]][])("shows the orchestrator's section only for what needs attention, when it %s", async (_case, results, hidden, shown) => {
    const m = mountStepper({ candidate: () => reply(200, { results }) });
    await m.toReview();
    await m.settled();
    expect(m.section("orchestrator").hidden).toBe(hidden);
    expect(m.ids("orchestrator")).toEqual(shown);
    if (!hidden) expect(m.section("orchestrator").querySelector(".np-checks-body")!.textContent).not.toBe("");
  });

  // The message's facts, not its wording: every failing check is named.
  it.each([
    ["one of the project's own core checks fails", [result("github.installation", "fail")]],
    ["two of its required checks fail", [result("github.installation", "fail"), result("github.workflow-default-branch", "fail", { tier: "mode" })]],
  ] as [string, Body[]][])("refuses Create, naming what fails, while %s", async (_case, results) => {
    const m = mountStepper({ candidate: () => reply(200, { results }) });
    await m.toReview();
    await m.settled();
    expect(m.create().disabled).toBe(true);
    for (const row of results) expect(m.error()).toContain(row.title as string);
    await m.win.stepperSubmit();
    expect(m.saves).toHaveLength(0);
  });

  // Only what a step in this window can fix blocks, and a check that could not run never does.
  it.each([
    ["an optional feature fails", result("github.skills-repo", "fail", { tier: "feature" })],
    ["an orchestrator-wide check fails", result("restate", "fail", { project: undefined })],
    ["a required check cannot verify", result("github.installation", "cannot-verify")],
    ["a check that can never be verified fails", result("github.target-secrets", "fail", { tier: "mode", verifiable: false })],
    ["a required check warns", result("github.installation", "warn")],
  ] as [string, Body][])("leaves Create open when %s", async (_case, row) => {
    const m = mountStepper({ candidate: () => reply(200, { results: [row] }) });
    await m.toReview();
    await m.settled();
    expect(m.create().disabled).toBe(false);
    expect(m.error()).toBeNull();
    await m.win.stepperSubmit();
    expect(m.saves).toHaveLength(1);
  });

  it("holds Create and the button while the checks run, shows nothing old, then offers a re-check", async () => {
    let answer!: (value: FakeApiResponse) => void;
    const m = mountStepper({ candidate: () => new Promise((resolve) => { answer = resolve; }) });
    await m.toReview();
    expect(m.checkButton().disabled).toBe(true);
    expect(m.create().disabled).toBe(true);
    await m.win.stepperSubmit();
    expect(m.saves).toHaveLength(0);
    answer(reply(200, { results: [result("c.warn", "warn")] }));
    await m.settled();
    expect(m.checkButton().disabled).toBe(false);
    expect(m.create().disabled).toBe(false);
    expect(m.ids("source")).toEqual(["c.warn"]);
  });

  it("clears the last answer's checks while a re-check runs, since they may no longer hold", async () => {
    let answer!: (value: FakeApiResponse) => void;
    let calls = 0;
    const m = mountStepper({ candidate: () => (++calls === 1 ? reply(200, { results: [result("c.warn", "warn")] }) : new Promise((resolve) => { answer = resolve; })) });
    await m.toReview();
    await m.settled();
    expect(m.ids("source")).toEqual(["c.warn"]);
    const again = m.win.checkSetup();
    expect(m.ids("source")).toEqual([]);
    answer(reply(200, { results: [result("d.fail", "fail")] }));
    await again;
    expect(m.ids("source")).toEqual(["d.fail"]);
  });

  it("shows the button only on Review", async () => {
    const m = mountStepper();
    await m.toSource();
    expect(m.checkButton().hidden).toBe(true);
    for (let step = 2; step < 8; step++) await m.next();
    expect(m.checkButton().hidden).toBe(false);
  });

  it("runs the checks again only once the project changed", async () => {
    const m = mountStepper();
    await m.toReview();
    await m.settled();
    m.win.stepperBack();
    await m.next();
    expect(m.candidates).toHaveLength(1);
    m.win.changeReviewSection("source");
    m.input("np-repo", "gadgets");
    await m.next();
    await m.settled();
    expect(m.candidates.map((c) => c.repo)).toEqual(["widgets", "gadgets"]);
  });

  it("never lets an older answer replace a newer one", async () => {
    const answers: ((value: FakeApiResponse) => void)[] = [];
    const m = mountStepper({ candidate: () => new Promise((resolve) => { answers.push(resolve); }) });
    await m.toReview();
    const again = m.win.checkSetup();
    answers[1](reply(200, { results: [result("newer", "warn")] }));
    await again;
    answers[0](reply(200, { results: [result("older", "warn")] }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(m.ids("source")).toEqual(["newer"]);
  });

  // The save's refusal is relayed as it came; a failed run's own error code never is.
  it.each([
    ["the save would refuse the project", () => reply(400, { error: "branchPrefix invalid: no spaces allowed" }), "branchPrefix invalid: no spaces allowed", null],
    ["the run fails on the orchestrator", () => reply(500, { error: "setup-checks-failed" }), null, "setup-checks-failed"],
    ["the request itself fails", () => { throw new Error("network down"); }, null, "network down"],
  ] as [string, () => Answer, string | null, string | null][])("says so in the error area, and leaves Create open, when %s", async (_case, candidate, relayed, withheld) => {
    const m = mountStepper({ candidate });
    await m.toReview();
    await m.settled();
    expect(m.error()).not.toBeNull();
    if (relayed) expect(m.error()).toContain(relayed);
    if (withheld) expect(m.error()).not.toContain(withheld);
    expect(m.create().disabled).toBe(false);
    expect(m.section("source").querySelector(".np-checks-card")).toBeNull();
  });

  it("keeps its message to Review, where Back to review shows it again", async () => {
    const m = mountStepper({ candidate: () => reply(200, { results: [result("github.installation", "fail")] }) });
    await m.toReview();
    await m.settled();
    expect(m.error()).not.toBeNull();
    m.win.changeReviewSection("context");
    expect(m.error()).toBeNull();
    await m.next();
    expect(m.shownStep()).toBe(8);
    expect(m.error()).toContain("Title of github.installation");
    expect(m.candidates).toHaveLength(1);
  });
});

describe("new-project stepper — Review's Change", () => {
  it("goes to the section's first step with its values kept, and that step's Continue reads Back to review", async () => {
    const m = mountStepper();
    await m.toReview();
    m.win.changeReviewSection("source");
    expect(m.shownStep()).toBe(2);
    expect(m.el<HTMLInputElement>("np-repo").value).toBe("widgets");
    expect(m.el("np-next").textContent).toBe("Back to review");
    expect(m.el("np-next").hidden).toBe(false);
  });

  it("walks a section of two steps, returning from its last", async () => {
    const m = mountStepper();
    await m.toReview();
    m.win.changeReviewSection("ticketing");
    expect([m.shownStep(), m.el("np-next").textContent]).toEqual([0, "Continue →"]);
    await m.next();
    expect([m.shownStep(), m.el("np-next").textContent]).toEqual([1, "Back to review"]);
    await m.next();
    expect(m.shownStep()).toBe(8);
  });

  it("stays on the step while its own checks refuse it", async () => {
    const m = mountStepper();
    await m.toReview();
    m.win.changeReviewSection("source");
    m.input("np-repo", "");
    await m.next();
    expect(m.shownStep()).toBe(2);
    expect(m.error()).not.toBeNull();
  });

  it("reads Continue again once it has returned", async () => {
    const m = mountStepper();
    await m.toReview();
    m.win.changeReviewSection("secrets");
    await m.next();
    m.win.stepperBack();
    expect([m.shownStep(), m.el("np-next").textContent]).toEqual([7, "Continue →"]);
  });
});

describe("new-project stepper — Continue asks the save", () => {
  const refuse = (field: string, error = `Refused ${field}`) => () => reply(400, { error, field });

  it("sends the project as entered once the step's own checks pass", async () => {
    const m = mountStepper();
    m.win.openNewProjectStepper();
    await m.next();
    m.input("np-teamKey", "AII");
    await m.next();
    expect(m.validations).toHaveLength(2);
    expect(m.validations[1]).toMatchObject({ teamKey: "AII", ticketingProvider: "linear", owner: "", repo: "" });
    expect(m.shownStep()).toBe(2);
  });

  it("sends nothing while the step's own checks refuse it", async () => {
    const m = mountStepper();
    m.win.openNewProjectStepper();
    await m.next();
    await m.next();
    expect(m.validations).toHaveLength(1);
    expect(m.error()).not.toBeNull();
  });

  it("stays on the step, showing the refusal, when the save refuses one of its fields", async () => {
    const m = mountStepper({ validate: (body) => (body.repo ? refuse("branchPrefix", "branchPrefix invalid: no spaces allowed")() : reply(200, { valid: true })) });
    await m.toSource();
    await m.next();
    expect(m.shownStep()).toBe(2);
    expect(m.error()).toBe("branchPrefix invalid: no spaces allowed");
  });

  it("continues past a refusal of a field on a step not reached yet, which that step's Continue meets", async () => {
    const m = mountStepper({ validate: refuse("owner") });
    m.win.openNewProjectStepper();
    await m.next();
    m.input("np-teamKey", "AII");
    await m.next();
    expect(m.shownStep()).toBe(2);
    expect(m.error()).toBeNull();
  });

  it("returns to the earlier step holding a refused field, and shows the refusal there", async () => {
    const m = mountStepper({ validate: (body) => (body.repo ? refuse("ticketingProvider", "Filesystem tickets require local runner mode")() : reply(200, { valid: true })) });
    await m.toSource();
    await m.next();
    expect(m.shownStep()).toBe(0);
    expect(m.error()).toBe("Filesystem tickets require local runner mode");
    expect(m.el<HTMLInputElement>("np-repo").value).toBe("widgets");
  });

  it("shows a refusal of a field no step holds on the step it came from", async () => {
    const m = mountStepper({ validate: (body) => (body.repo ? refuse("workflowFile")() : reply(200, { valid: true })) });
    await m.toSource();
    await m.next();
    expect([m.shownStep(), m.error()]).toEqual([2, "Refused workflowFile"]);
  });

  it.each([
    ["linear", 1],
    ["filesystem", 2],
  ] as const)("places a %s project's key on step %i, where it comes from", async (provider, keyStep) => {
    const m = mountStepper({ validate: (body) => (body.ticketingProvider === provider && (provider === "linear" ? body.teamKey : true) ? refuse("teamKey")() : reply(200, { valid: true })) });
    m.win.openNewProjectStepper();
    m.el<HTMLSelectElement>("np-ticketing-provider").value = provider;
    m.win.onStepperTicketingProviderChange();
    await m.next();
    if (provider === "linear") m.input("np-teamKey", "AII");
    else m.input("np-filesystem-directory", "/tmp/tickets");
    await m.next();
    // A key refused from Config stays there for Linear, and waits for Source otherwise.
    expect(m.shownStep()).toBe(keyStep === 1 ? 1 : 2);
    expect(m.error()).toBe(keyStep === 1 ? "Refused teamKey" : null);
  });

  it.each([
    ["the request fails", () => { throw new Error("network down"); }],
    ["the orchestrator answers 500", () => reply(500, { error: "boom" })],
  ] as [string, () => Answer][])("continues when %s, since Create validates again", async (_case, validate) => {
    const m = mountStepper({ validate });
    await m.toSource();
    await m.next();
    expect([m.shownStep(), m.error()]).toEqual([3, null]);
  });

  it("holds Continue while the save answers, and drops an answer once the stepper has moved on", async () => {
    let answer!: (value: FakeApiResponse) => void;
    const m = mountStepper({ validate: (body) => (body.teamKey ? new Promise((resolve) => { answer = resolve; }) : reply(200, { valid: true })) });
    m.win.openNewProjectStepper();
    await m.next();
    m.input("np-teamKey", "AII");
    const pending = m.next();
    expect(m.el<HTMLButtonElement>("np-next").disabled).toBe(true);
    m.win.stepperBack();
    answer(refuse("teamKey")());
    await pending;
    expect([m.shownStep(), m.error()]).toEqual([0, null]);
  });

  it("asks the save on Back to review too, keeping a refused step in place", async () => {
    const m = mountStepper({ validate: (body) => (body.branchPrefix ? refuse("branchPrefix")() : reply(200, { valid: true })) });
    await m.toReview();
    m.win.changeReviewSection("source");
    m.input("np-branch-prefix", "bad prefix");
    await m.next();
    expect([m.shownStep(), m.error()]).toEqual([2, "Refused branchPrefix"]);
  });
});

describe("new-project stepper — Jira repository values", () => {
  // Whoever administers the Jira field names its options, so a quote in one must stay inside its option.
  const VALUE = 'acme/app"><option value="injected';

  it("lists each option as one choice, its value and its text as Jira has them", async () => {
    const { win, doc } = mountAdminPage({
      html: stepperHtml,
      script: stepperScript,
      route: "projects",
      api: async (url) => (url.startsWith("/api/jira/field-options") ? reply(200, [{ value: VALUE }]) : reply(200, {})),
    });
    const field = doc.getElementById("np-jira-repo-field") as HTMLSelectElement;
    field.innerHTML = '<option value="customfield_1">Repo</option>';
    await win.onStepperRepoFieldChange();
    const options = Array.from((doc.getElementById("np-jira-repo-value") as HTMLSelectElement).options);
    expect(options.map((o) => [o.value, o.textContent])).toEqual([["", "(select)"], [VALUE, VALUE]]);
  });
});

describe("new-project Fly CPU kind", () => {
  async function mountFly() {
    const posts: unknown[] = [];
    let error: string | undefined;
    const mounted = mountAdminPage({
      html: stepperHtml, script: stepperScript, route: "projects",
      before: (win) => {
        win.refRepoRowsHtml = () => "";
        win.refRepoStage = () => null;
      },
      api: async (url, init) => {
        if (url === "/api/mappings" && init?.method === "POST") {
          posts.push(JSON.parse(init.body!));
          return { ok: !error, status: error ? 400 : 200, json: async () => error ? { error } : {} };
        }
        if (url === "/api/mappings/validate") return reply(200, { valid: true });
        if (url === "/api/setup-checks/candidate") return reply(200, { results: [] });
        return { ok: true, status: 200, json: async () => ({ linear: true, jira: true }) };
      },
    });
    const { win, doc } = mounted;
    const field = (id: string) => doc.getElementById(id) as HTMLInputElement;
    // Continue validates the step on the server before it moves on, so each one is awaited.
    const next = () => win.stepperNext() as Promise<void>;
    // Create waits for Review's checks, which give their button back once they answer.
    const submit = async () => {
      await vi.waitFor(() => expect((doc.getElementById("np-setup-check-btn") as HTMLButtonElement).disabled).toBe(false));
      await win.stepperSubmit();
    };
    async function execution() {
      await next();
      field("np-teamKey").value = "AII";
      await next();
      field("np-owner").value = "BuildDownAI";
      field("np-repo").value = "AI-Implement";
      field("np-defaultBranch").value = "testing";
      await next();
      await next();
      win.selectExecutionMode("fly-machines");
    }
    win.openNewProjectStepper();
    await execution();
    return { ...mounted, field, posts, next, submit, execution, refuse: (message?: string) => { error = message; } };
  }

  it("reviews and submits the kind, preserves it across Back/Next, and resets on reopen", async () => {
    const { win, doc, field, posts, next, submit, execution } = await mountFly();
    const select = doc.querySelector<HTMLSelectElement>("#np-cpu-kind")!;
    expect(select.value).toBe("shared");
    expect(Array.from(select.options, (o) => o.value)).toEqual(["shared", "performance"]);
    expect(select.nextElementSibling?.textContent).toBe("Fly limits a shared CPU. Use performance for a project whose tests use the CPU for more than some minutes. Performance needs 2048 MB or more for each CPU.");
    expect(select.closest("#np-fly-fields")!.hasAttribute("hidden")).toBe(false);
    select.value = "performance";
    field("np-cpus").value = "4";
    field("np-mem").value = "8192";
    await next();
    win.stepperBack();
    expect(select.value).toBe("performance");
    for (let i = 0; i < 4; i++) await next();
    expect(doc.querySelector('[data-review="runner"]')?.textContent).toContain("4cpu performance / 8192 MB");
    await submit();
    expect(posts[0]).toMatchObject({ machineCpuKind: "performance", machineCpus: 4, machineMemoryMb: 8192 });
    win.openNewProjectStepper();
    expect(select.value).toBe("shared");
    await execution();
    for (let i = 0; i < 4; i++) await next();
    expect(doc.querySelector('[data-review="runner"]')?.textContent).toContain("2cpu shared / 4096 MB");
    await submit();
    expect(posts[1]).toMatchObject({ machineCpuKind: "shared" });
  });

  it("shows the server message literally and keeps values for correction and retry", async () => {
    const { win, doc, field, posts, next, submit, refuse } = await mountFly();
    field("np-cpu-kind").value = "performance";
    field("np-cpus").value = "4";
    field("np-mem").value = "2048";
    for (let i = 0; i < 4; i++) await next();
    const error = "Performance needs more memory <b>per CPU</b>";
    refuse(error);
    await submit();
    expect(posts[0]).toMatchObject({ machineCpuKind: "performance", machineCpus: 4, machineMemoryMb: 2048 });
    expect(doc.getElementById("np-error")?.textContent).toContain(error);
    expect(doc.querySelector("#np-error b")).toBeNull();
    expect(doc.getElementById("np-stepper-wrap")!.hasAttribute("hidden")).toBe(false);
    for (let i = 0; i < 4; i++) win.stepperBack();
    expect(["np-cpu-kind", "np-cpus", "np-mem"].map((id) => field(id).value)).toEqual(["performance", "4", "2048"]);
    field("np-mem").value = "8192";
    for (let i = 0; i < 4; i++) await next();
    refuse();
    await submit();
    expect(posts[1]).toMatchObject({ machineCpuKind: "performance", machineCpus: 4, machineMemoryMb: 8192 });
  });

  it("hides the control with Fly fields for GitHub Actions and filesystem", async () => {
    const { win, doc, field } = await mountFly();
    win.selectExecutionMode("github-actions");
    expect(doc.getElementById("np-cpu-kind")!.closest("#np-fly-fields")!.hasAttribute("hidden")).toBe(true);
    win.selectExecutionMode("fly-machines");
    field("np-ticketing-provider").value = "filesystem";
    win.onStepperTicketingProviderChange();
    expect(doc.getElementById("np-cpu-kind")!.closest("#np-fly-fields")!.hasAttribute("hidden")).toBe(true);
  });
});
