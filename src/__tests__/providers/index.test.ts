import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { resolveProvider, providerConfigFromEnv } from "../../providers/index.js";
import { UnknownProviderError } from "../../providers/types.js";
import { configureLinearAuth } from "../../linear-app-auth.js";

beforeEach(() => {
  configureLinearAuth("client-id", "client-secret");
});

describe("resolveProvider", () => {
  it("returns LinearProvider for id 'linear'", async () => {
    const p = await resolveProvider("linear", {});
    expect(p.id).toBe("linear");
  });

  it("throws UnknownProviderError for unrecognized id", async () => {
    await expect(resolveProvider("unknown-prov" as never, {})).rejects.toThrow(UnknownProviderError);
  });
});

describe("resolveProvider for jira", () => {
  it("returns a JiraProvider when env config is complete", async () => {
    const p = await resolveProvider("jira", {
      jiraToken: "t", jiraCloudId: "c", jiraSiteUrl: "https://acme.atlassian.net",
    }, { getMappings: () => ({}) });
    expect(p.id).toBe("jira");
  });

  it("throws when getMappings is not provided", async () => {
    await expect(resolveProvider("jira", {
      jiraToken: "t", jiraCloudId: "c", jiraSiteUrl: "https://acme.atlassian.net",
    })).rejects.toThrow(/getMappings/);
  });

  it("throws when jiraToken is missing", async () => {
    await expect(resolveProvider("jira", {
      jiraCloudId: "c", jiraSiteUrl: "https://x",
    }, { getMappings: () => ({}) })).rejects.toThrow();
  });
});

describe("providerConfigFromEnv with Jira vars", () => {
  const originals = {
    JIRA_TOKEN: process.env.JIRA_TOKEN,
    JIRA_CLOUD_ID: process.env.JIRA_CLOUD_ID,
    JIRA_SITE_URL: process.env.JIRA_SITE_URL,
    LINEAR_WORKSPACE_URL: process.env.LINEAR_WORKSPACE_URL,
  };
  afterEach(() => {
    for (const [k, v] of Object.entries(originals)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it("reads JIRA_TOKEN, JIRA_CLOUD_ID, JIRA_SITE_URL from env", () => {
    process.env.JIRA_TOKEN = "t";
    process.env.JIRA_CLOUD_ID = "c";
    process.env.JIRA_SITE_URL = "https://x";
    const cfg = providerConfigFromEnv();
    expect(cfg.jiraToken).toBe("t");
    expect(cfg.jiraCloudId).toBe("c");
    expect(cfg.jiraSiteUrl).toBe("https://x");
  });

  it("reads LINEAR_WORKSPACE_URL from env", () => {
    process.env.LINEAR_WORKSPACE_URL = "https://linear.app/acme";
    expect(providerConfigFromEnv().linearWorkspaceUrl).toBe("https://linear.app/acme");
  });
});
