import { describe, it, expect, vi } from "vitest";
import { resolveCustomFieldIds, getCachedFieldIds, clearFieldCache, adfParagraph, adfWithLink, STATUS_VALUES } from "../../providers/jira-fields.js";

describe("resolveCustomFieldIds", () => {
  it("returns IDs for AI-Implement Status and AI-Implement Repo by name", async () => {
    const client = {
      listFields: vi.fn().mockResolvedValue([
        { id: "customfield_10001", name: "Other", custom: true },
        { id: "customfield_10042", name: "AI-Implement Status", custom: true },
        { id: "customfield_10043", name: "AI-Implement Repo", custom: true },
      ]),
    };
    const ids = await resolveCustomFieldIds(client as any, { statusOverride: null, repoOverride: null });
    expect(ids.statusFieldId).toBe("customfield_10042");
    expect(ids.repoFieldId).toBe("customfield_10043");
  });

  it("respects explicit overrides without calling listFields", async () => {
    const client = { listFields: vi.fn() };
    const ids = await resolveCustomFieldIds(client as any, {
      statusOverride: "customfield_99",
      repoOverride: "customfield_98",
    });
    expect(ids.statusFieldId).toBe("customfield_99");
    expect(ids.repoFieldId).toBe("customfield_98");
    expect(client.listFields).not.toHaveBeenCalled();
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
      resolveCustomFieldIds(client as any, { statusOverride: null, repoOverride: null }),
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
      resolveCustomFieldIds(client as any, { statusOverride: null, repoOverride: null }),
    ).rejects.toThrow(/Multiple custom fields named/);
  });
});

describe("getCachedFieldIds", () => {
  it("queries listFields once per cache key, then serves from cache", async () => {
    clearFieldCache();
    const client = {
      listFields: vi.fn().mockResolvedValue([
        { id: "customfield_10042", name: "AI-Implement Status", custom: true },
        { id: "customfield_10043", name: "AI-Implement Repo", custom: true },
      ]),
    };
    await getCachedFieldIds("k1", client as any, { statusOverride: null, repoOverride: null });
    await getCachedFieldIds("k1", client as any, { statusOverride: null, repoOverride: null });
    expect(client.listFields).toHaveBeenCalledTimes(1);
  });

  it("treats different cache keys as separate entries", async () => {
    clearFieldCache();
    const client = {
      listFields: vi.fn().mockResolvedValue([
        { id: "customfield_10042", name: "AI-Implement Status", custom: true },
        { id: "customfield_10043", name: "AI-Implement Repo", custom: true },
      ]),
    };
    await getCachedFieldIds("k1", client as any, { statusOverride: null, repoOverride: null });
    await getCachedFieldIds("k2", client as any, { statusOverride: null, repoOverride: null });
    expect(client.listFields).toHaveBeenCalledTimes(2);
  });

  it("re-resolves when the same cache key is called with a changed override", async () => {
    clearFieldCache();
    const client = {
      listFields: vi.fn().mockResolvedValue([
        { id: "customfield_10042", name: "AI-Implement Status", custom: true },
        { id: "customfield_10043", name: "AI-Implement Repo", custom: true },
      ]),
    };
    const a = await getCachedFieldIds("k1", client as any, { statusOverride: "customfield_A", repoOverride: null });
    const b = await getCachedFieldIds("k1", client as any, { statusOverride: "customfield_B", repoOverride: null });
    expect(a.statusFieldId).toBe("customfield_A");
    expect(b.statusFieldId).toBe("customfield_B");
  });
});

describe("STATUS_VALUES", () => {
  it("contains every state in the locked machine", () => {
    expect(Object.values(STATUS_VALUES)).toEqual([
      "Ready", "Planning", "Awaiting Approval", "Plan Approved",
      "Implementing", "PR Ready", "Planning Failed", "Implementation Failed",
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
