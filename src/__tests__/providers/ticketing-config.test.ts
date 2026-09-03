import { describe, it, expect, vi } from "vitest";
import { validateTicketingConfig, DEFAULT_TICKETING_CONFIG } from "../../providers/ticketing-config.js";
import { resolveCustomFieldIds } from "../../providers/jira-fields.js";
import type { JiraMappingConfig } from "../../providers/ticketing-config.js";

const jiraBase = { kind: "jira", jql: "project = ENG", repoFieldValue: "owner/repo" };

describe("validateTicketingConfig", () => {
  it("returns the linear default for a null config on the linear provider", () => {
    expect(validateTicketingConfig("linear", null)).toEqual(DEFAULT_TICKETING_CONFIG);
  });

  it("throws when kind does not match the provider", () => {
    expect(() => validateTicketingConfig("jira", { kind: "linear" })).toThrow(/must match ticketingProvider/);
  });

  it("requires a non-empty jql and repoFieldValue for jira", () => {
    expect(() => validateTicketingConfig("jira", { kind: "jira", repoFieldValue: "owner/repo" })).toThrow(/jql/);
    expect(() => validateTicketingConfig("jira", { kind: "jira", jql: "project = ENG" })).toThrow(/repoFieldValue/);
  });

  it("keeps a valid field override, trimmed", () => {
    const cfg = validateTicketingConfig("jira", {
      ...jiraBase,
      statusFieldOverride: "  customfield_10042  ",
    }) as JiraMappingConfig;
    expect(cfg.statusFieldOverride).toBe("customfield_10042");
  });

  // The bug this file exists for: a blank-but-present override used to survive
  // validation and reach jira-fields.ts as a literal field id.
  it.each([
    ["empty string", ""],
    ["whitespace only", "   "],
    ["a non-string", 42],
    ["null", null],
    ["undefined", undefined],
  ])("normalizes a %s field override to null", (_label, value) => {
    const cfg = validateTicketingConfig("jira", {
      ...jiraBase,
      statusFieldOverride: value,
      repoFieldOverride: value,
      profilesFieldOverride: value,
    }) as JiraMappingConfig;
    expect(cfg.statusFieldOverride).toBeNull();
    expect(cfg.repoFieldOverride).toBeNull();
    expect(cfg.profilesFieldOverride).toBeNull();
  });
});

describe("blank overrides no longer reach jira-fields as field ids", () => {
  const fields = [
    { id: "customfield_10042", name: "AI-Implement Status", custom: true },
    { id: "customfield_10043", name: "AI-Implement Repo", custom: true },
  ];

  const overridesFrom = (cfg: JiraMappingConfig) => ({
    statusOverride: cfg.statusFieldOverride ?? null,
    repoOverride: cfg.repoFieldOverride ?? null,
    profilesOverride: cfg.profilesFieldOverride ?? null,
  });

  it('falls back to discovery by name for an "" override rather than using it as an id', async () => {
    const cfg = validateTicketingConfig("jira", {
      ...jiraBase,
      statusFieldOverride: "",
      repoFieldOverride: "",
    }) as JiraMappingConfig;
    const client = { listFields: vi.fn().mockResolvedValue(fields) };

    const ids = await resolveCustomFieldIds(client as any, overridesFrom(cfg));

    expect(ids.statusFieldId).toBe("customfield_10042");
    expect(ids.repoFieldId).toBe("customfield_10043");
  });

  it("still calls listFields when every override is whitespace-only", async () => {
    const cfg = validateTicketingConfig("jira", {
      ...jiraBase,
      statusFieldOverride: "   ",
      repoFieldOverride: "   ",
      profilesFieldOverride: "   ",
    }) as JiraMappingConfig;
    const client = { listFields: vi.fn().mockResolvedValue(fields) };

    const ids = await resolveCustomFieldIds(client as any, overridesFrom(cfg));

    // Before the fix these were truthy, so the all-overrides-set short-circuit
    // returned "   " for all three and listFields was never called.
    expect(client.listFields).toHaveBeenCalled();
    expect(ids.statusFieldId).toBe("customfield_10042");
    expect(ids.repoFieldId).toBe("customfield_10043");
  });
});
