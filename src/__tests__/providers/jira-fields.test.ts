import { describe, it, expect, vi } from "vitest";
import { resolveCustomFieldIds, getCachedFieldIds, clearFieldCache, adfParagraph, adfWithLink, STATUS_VALUES } from "../../providers/jira-fields.js";

const baseOverrides = { statusOverride: null, repoOverride: null, profilesOverride: null };
const baseFields = [
  { id: "customfield_10042", name: "AI-Implement Status", custom: true },
  { id: "customfield_10043", name: "AI-Implement Repo", custom: true },
];

describe("resolveCustomFieldIds", () => {
  it("returns IDs for AI-Implement Status and AI-Implement Repo by name", async () => {
    const client = {
      listFields: vi.fn().mockResolvedValue([
        { id: "customfield_10001", name: "Other", custom: true },
        { id: "customfield_10042", name: "AI-Implement Status", custom: true },
        { id: "customfield_10043", name: "AI-Implement Repo", custom: true },
      ]),
    };
    const ids = await resolveCustomFieldIds(client as any, baseOverrides);
    expect(ids.statusFieldId).toBe("customfield_10042");
    expect(ids.repoFieldId).toBe("customfield_10043");
  });

  it("respects explicit overrides without calling listFields when all three are set", async () => {
    const client = { listFields: vi.fn() };
    const ids = await resolveCustomFieldIds(client as any, {
      statusOverride: "customfield_99",
      repoOverride: "customfield_98",
      profilesOverride: "customfield_97",
    });
    expect(ids.statusFieldId).toBe("customfield_99");
    expect(ids.repoFieldId).toBe("customfield_98");
    expect(ids.profilesFieldId).toBe("customfield_97");
    expect(client.listFields).not.toHaveBeenCalled();
  });

  it("calls listFields when only status and repo overrides are set (profiles override absent)", async () => {
    const client = {
      listFields: vi.fn().mockResolvedValue([
        { id: "customfield_10043", name: "AI-Implement Repo", custom: true },
      ]),
    };
    await resolveCustomFieldIds(client as any, {
      statusOverride: "customfield_99",
      repoOverride: "customfield_98",
      profilesOverride: null,
    });
    expect(client.listFields).toHaveBeenCalledTimes(1);
  });

  it("uses lookup for the field whose override is null", async () => {
    const client = {
      listFields: vi.fn().mockResolvedValue([
        { id: "customfield_x", name: "AI-Implement Repo", custom: true },
      ]),
    };
    const ids = await resolveCustomFieldIds(client as any, {
      statusOverride: "customfield_status_override",
      repoOverride: null,
      profilesOverride: null,
    });
    expect(ids.statusFieldId).toBe("customfield_status_override");
    expect(ids.repoFieldId).toBe("customfield_x");
    expect(client.listFields).toHaveBeenCalledTimes(1);
  });

  it("throws if expected field not found", async () => {
    const client = {
      listFields: vi.fn().mockResolvedValue([
        { id: "customfield_10042", name: "AI-Implement Status", custom: true },
      ]),
    };
    await expect(
      resolveCustomFieldIds(client as any, baseOverrides),
    ).rejects.toThrow(/AI-Implement Repo/);
  });

  it("throws if multiple fields share the same name", async () => {
    const client = {
      listFields: vi.fn().mockResolvedValue([
        { id: "customfield_10042", name: "AI-Implement Status", custom: true },
        { id: "customfield_10999", name: "AI-Implement Status", custom: true },
        { id: "customfield_10043", name: "AI-Implement Repo", custom: true },
      ]),
    };
    await expect(
      resolveCustomFieldIds(client as any, baseOverrides),
    ).rejects.toThrow(/Multiple custom fields named/);
  });
});

describe("resolveCustomFieldIds — profilesFieldId (lenient resolution)", () => {
  it("resolves profilesFieldId when AI-Implement Profiles field is present", async () => {
    const client = {
      listFields: vi.fn().mockResolvedValue([
        ...baseFields,
        { id: "customfield_10200", name: "AI-Implement Profiles", custom: true },
      ]),
    };
    const ids = await resolveCustomFieldIds(client as any, baseOverrides);
    expect(ids.profilesFieldId).toBe("customfield_10200");
  });

  it("returns null (no throw) when AI-Implement Profiles field is absent", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const client = { listFields: vi.fn().mockResolvedValue(baseFields) };
    const ids = await resolveCustomFieldIds(client as any, baseOverrides);
    expect(ids.profilesFieldId).toBeNull();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("AI-Implement Profiles"));
    warnSpy.mockRestore();
  });

  it("returns null (no throw) when multiple fields share the profiles name, warns about override", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const client = {
      listFields: vi.fn().mockResolvedValue([
        ...baseFields,
        { id: "customfield_10200", name: "AI-Implement Profiles", custom: true },
        { id: "customfield_10201", name: "AI-Implement Profiles", custom: true },
      ]),
    };
    const ids = await resolveCustomFieldIds(client as any, baseOverrides);
    expect(ids.profilesFieldId).toBeNull();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("profilesFieldOverride"));
    warnSpy.mockRestore();
  });

  it("uses profilesOverride directly without lookup when set", async () => {
    const client = { listFields: vi.fn().mockResolvedValue(baseFields) };
    const ids = await resolveCustomFieldIds(client as any, {
      statusOverride: null,
      repoOverride: null,
      profilesOverride: "customfield_explicit_profiles",
    });
    expect(ids.profilesFieldId).toBe("customfield_explicit_profiles");
  });

  it("does not call listFields when all three overrides are set (profiles included)", async () => {
    const client = { listFields: vi.fn() };
    const ids = await resolveCustomFieldIds(client as any, {
      statusOverride: "customfield_s",
      repoOverride: "customfield_r",
      profilesOverride: "customfield_p",
    });
    expect(ids.profilesFieldId).toBe("customfield_p");
    expect(client.listFields).not.toHaveBeenCalled();
  });
});

describe("getCachedFieldIds", () => {
  it("queries listFields once per cache key, then serves from cache", async () => {
    clearFieldCache();
    const client = { listFields: vi.fn().mockResolvedValue(baseFields) };
    await getCachedFieldIds("k1", client as any, { statusOverride: null, repoOverride: null, profilesOverride: null });
    await getCachedFieldIds("k1", client as any, { statusOverride: null, repoOverride: null, profilesOverride: null });
    expect(client.listFields).toHaveBeenCalledTimes(1);
  });

  it("treats different cache keys as separate entries", async () => {
    clearFieldCache();
    const client = { listFields: vi.fn().mockResolvedValue(baseFields) };
    await getCachedFieldIds("k1", client as any, { statusOverride: null, repoOverride: null, profilesOverride: null });
    await getCachedFieldIds("k2", client as any, { statusOverride: null, repoOverride: null, profilesOverride: null });
    expect(client.listFields).toHaveBeenCalledTimes(2);
  });

  it("re-resolves when the same cache key is called with a changed override", async () => {
    clearFieldCache();
    const client = { listFields: vi.fn().mockResolvedValue(baseFields) };
    const a = await getCachedFieldIds("k1", client as any, { statusOverride: "customfield_A", repoOverride: null, profilesOverride: null });
    const b = await getCachedFieldIds("k1", client as any, { statusOverride: "customfield_B", repoOverride: null, profilesOverride: null });
    expect(a.statusFieldId).toBe("customfield_A");
    expect(b.statusFieldId).toBe("customfield_B");
  });

  it("re-resolves when profilesOverride changes for the same cache key", async () => {
    clearFieldCache();
    const client = { listFields: vi.fn().mockResolvedValue(baseFields) };
    const a = await getCachedFieldIds("k1", client as any, { statusOverride: null, repoOverride: null, profilesOverride: null });
    const b = await getCachedFieldIds("k1", client as any, { statusOverride: null, repoOverride: null, profilesOverride: "customfield_P" });
    expect(a.profilesFieldId).toBeNull();
    expect(b.profilesFieldId).toBe("customfield_P");
    expect(client.listFields).toHaveBeenCalledTimes(2);
  });
});

describe("resolveCustomFieldIds — epicLinkFieldId", () => {
  it("resolves Epic Link field id when present (best-effort)", async () => {
    const client = { listFields: async () => ([
      { id: "customfield_10100", name: "AI-Implement Status", custom: true },
      { id: "customfield_10101", name: "AI-Implement Repo", custom: true },
      { id: "customfield_10014", name: "Epic Link", custom: true },
    ]) };
    const ids = await resolveCustomFieldIds(client as any, baseOverrides);
    expect(ids.epicLinkFieldId).toBe("customfield_10014");
  });
  it("leaves epicLinkFieldId undefined when no Epic Link field exists", async () => {
    const client = { listFields: async () => ([
      { id: "customfield_10100", name: "AI-Implement Status", custom: true },
      { id: "customfield_10101", name: "AI-Implement Repo", custom: true },
    ]) };
    const ids = await resolveCustomFieldIds(client as any, baseOverrides);
    expect(ids.epicLinkFieldId).toBeUndefined();
  });
});

describe("resolveCustomFieldIds — epicLinkFieldId", () => {
  it("resolves Epic Link field id when present (best-effort)", async () => {
    const client = { listFields: async () => ([
      { id: "customfield_10100", name: "AI-Implement Status", custom: true },
      { id: "customfield_10101", name: "AI-Implement Repo", custom: true },
      { id: "customfield_10014", name: "Epic Link", custom: true },
    ]) };
    const ids = await resolveCustomFieldIds(client as any, { statusOverride: null, repoOverride: null });
    expect(ids.epicLinkFieldId).toBe("customfield_10014");
  });
  it("leaves epicLinkFieldId undefined when no Epic Link field exists", async () => {
    const client = { listFields: async () => ([
      { id: "customfield_10100", name: "AI-Implement Status", custom: true },
      { id: "customfield_10101", name: "AI-Implement Repo", custom: true },
    ]) };
    const ids = await resolveCustomFieldIds(client as any, { statusOverride: null, repoOverride: null });
    expect(ids.epicLinkFieldId).toBeUndefined();
  });
});

describe("STATUS_VALUES", () => {
  it("contains every state in the locked machine", () => {
    expect(Object.values(STATUS_VALUES)).toEqual([
      "Ready", "Planning", "Awaiting Approval", "Plan Approved",
      "Implementing", "PR Ready", "Merged", "Planning Failed", "Implementation Failed",
    ]);
  });
});

describe("ADF helpers", () => {
  it("adfParagraph wraps text in a single-paragraph ADF doc", () => {
    const doc = adfParagraph("hello") as any;
    expect(doc.type).toBe("doc");
    expect(doc.content[0].content[0]).toEqual({ type: "text", text: "hello" });
  });

  it("adfWithLink includes a link mark on the label", () => {
    const doc = adfWithLink("PR opened: ", "PR-123", "https://example.com/pr/123") as any;
    const linkText = doc.content[0].content[1];
    expect(linkText.text).toBe("PR-123");
    expect(linkText.marks[0]).toEqual({
      type: "link",
      attrs: { href: "https://example.com/pr/123" },
    });
  });
});
