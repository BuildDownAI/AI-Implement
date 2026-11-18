import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const dockerfile = readFileSync("Dockerfile.session", "utf8");
const toolManifest = readFileSync("session/tools.md", "utf8");
const runnerDocs = readFileSync("docs/runner-images.md", "utf8");
const packageJson = JSON.parse(readFileSync("package.json", "utf8")) as {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
};

function readArg(name: string): string {
  const match = dockerfile.match(new RegExp(`^ARG ${name}=([^\\n]+)$`, "m"));
  expect(match, `${name} must be pinned in Dockerfile.session`).not.toBeNull();
  return match![1].trim();
}

describe("Codex runner image support", () => {
  it("installs one pinned Codex CLI in the shared session image", () => {
    const codexVersion = readArg("CODEX_CLI_VERSION");

    expect(dockerfile).toContain('"@openai/codex@${CODEX_CLI_VERSION}"');
    expect(runnerDocs).toContain(`| Codex CLI | \`@openai/codex\` | \`${codexVersion}\``);
    expect(dockerfile).not.toMatch(/FROM .*codex/i);
    expect(dockerfile.match(/@openai\/codex/g)).toHaveLength(1);
  });

  it("smoke-tests Codex after the non-root runner user exists and before runtime entrypoint", () => {
    const userIndex = dockerfile.indexOf("useradd -m -s /bin/bash coder");
    const smokeIndex = dockerfile.indexOf("codex --version");
    const helpIndex = dockerfile.indexOf("codex exec --help");
    const entrypointIndex = dockerfile.indexOf("ENTRYPOINT");

    expect(userIndex).toBeGreaterThan(-1);
    expect(smokeIndex).toBeGreaterThan(userIndex);
    expect(helpIndex).toBeGreaterThan(smokeIndex);
    expect(entrypointIndex).toBeGreaterThan(helpIndex);

    const smokeBlock = dockerfile.slice(userIndex, entrypointIndex);
    expect(smokeBlock).toContain("coder");
    expect(smokeBlock).not.toMatch(/codex exec (?!.*--help)/);
  });

  it("documents the supported Codex exec automation surface", () => {
    const codexVersion = readArg("CODEX_CLI_VERSION");

    expect(toolManifest).toContain("@openai/codex");
    expect(toolManifest).toContain("codex exec --json");
    expect(toolManifest).toContain("codex exec --output-schema <FILE>");

    expect(runnerDocs).toContain("Codex CLI");
    expect(runnerDocs).toContain(`\`@openai/codex\` | \`${codexVersion}\``);
    expect(runnerDocs).toContain("`codex --version` and `codex exec --help`");
    expect(runnerDocs).toContain("`codex exec --json` writes a JSONL stream");
    expect(runnerDocs).toContain("`codex exec --output-schema <FILE>`");
  });

  it("keeps Codex out of application dependencies", () => {
    expect(packageJson.dependencies).not.toHaveProperty("@openai/codex");
    expect(packageJson.devDependencies).not.toHaveProperty("@openai/codex");
    expect(packageJson.dependencies).not.toHaveProperty("openai");
    expect(packageJson.devDependencies).not.toHaveProperty("openai");
  });
});
