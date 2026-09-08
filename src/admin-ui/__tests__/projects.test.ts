import { describe, expect, it } from "vitest";
import { projectsHtml, projectsScript } from "../pages/projects.js";

describe("projects Edit dialog — single GitHub repo entry", () => {
  it("asks for the repo once, as one owner/repo input", () => {
    expect(projectsHtml).toContain('id="md-github-repo"');
    expect(projectsHtml).not.toContain('id="md-owner"');
    expect(projectsHtml).not.toContain('id="md-repo"');
  });

  it("splits the combined input into owner and repo before submitting", () => {
    expect(projectsScript).toContain("function splitGithubRepo(");
    expect(projectsScript).toContain("splitGithubRepo(document.getElementById('md-github-repo').value)");
    expect(projectsScript).toContain("owner: ghParts ? ghParts.owner : ''");
    expect(projectsScript).toContain("repo: ghParts ? ghParts.repo : ''");
  });

  it("populates the combined input from a loaded mapping's owner and repo", () => {
    expect(projectsScript).toContain("document.getElementById('md-github-repo').value =");
  });

  it("keeps Repo Field Value as an optional override and sends null when blank", () => {
    // The Edit dialog keeps the override (unlike the stepper) for instances whose
    // repo-field options carry friendly labels rather than owner/repo.
    expect(projectsHtml).toContain('id="md-jira-repo-value"');
    expect(projectsScript).toContain("rawRepoFieldValue === '' ? null : rawRepoFieldValue");
  });

  it("warns on a leftover repo clause in the JQL", () => {
    expect(projectsScript).toContain("function detectRepoFilterInJql(");
    expect(projectsScript).toContain("detectRepoFilterInJql(jql, repoFieldOverride)");
  });
});

/**
 * Extracts splitGithubRepo from the script string and evaluates it. The script is
 * a template literal, so every regex in it is double-escaped in the source; only
 * running the emitted text proves the escaping survived.
 */
function loadSplitGithubRepo(): (raw: unknown) => { owner: string; repo: string } | null {
  const start = projectsScript.indexOf("  function splitGithubRepo(");
  expect(start).toBeGreaterThan(-1);
  const end = projectsScript.indexOf("\n  }\n", start) + "\n  }\n".length;
  const src = projectsScript.slice(start, end);
  return new Function(`${src}; return splitGithubRepo;`)() as (
    raw: unknown,
  ) => { owner: string; repo: string } | null;
}

describe("projects splitGithubRepo", () => {
  const split = loadSplitGithubRepo();

  it("splits owner/repo", () => {
    expect(split("acme-corp/backend")).toEqual({ owner: "acme-corp", repo: "backend" });
  });

  it("accepts a pasted GitHub URL", () => {
    expect(split("https://github.com/acme-corp/backend.git")).toEqual({ owner: "acme-corp", repo: "backend" });
  });

  it("rejects a bare repo name and empty input", () => {
    expect(split("backend")).toBeNull();
    expect(split("")).toBeNull();
    expect(split(null)).toBeNull();
  });
});
