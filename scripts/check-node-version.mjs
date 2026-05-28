import { readFileSync } from "node:fs";
import { join } from "node:path";

const fallbackVersion = "24.15.0";

function readPinnedNodeVersion() {
  try {
    const toolVersions = readFileSync(join(process.cwd(), ".tool-versions"), "utf8");
    const nodeLine = toolVersions
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => line.startsWith("nodejs "));

    return nodeLine?.split(/\s+/)[1] ?? fallbackVersion;
  } catch {
    return fallbackVersion;
  }
}

const expectedVersion = readPinnedNodeVersion();
const expectedMajor = Number(expectedVersion.split(".")[0]);
const actualVersion = process.versions.node;
const actualMajor = Number(actualVersion.split(".")[0]);

if (actualMajor !== expectedMajor) {
  console.error(`AI-Implement local development requires Node ${expectedMajor}.x.`);
  console.error(`Pinned version: ${expectedVersion} (.tool-versions)`);
  console.error(`Current version: ${process.version} (NODE_MODULE_VERSION ${process.versions.modules})`);
  console.error("");
  console.error("This repo uses better-sqlite3 native bindings. If node_modules is built");
  console.error("with one Node major and loaded by another, startup fails with ERR_DLOPEN_FAILED.");
  console.error("");
  console.error("Fix:");
  console.error("  asdf install");
  console.error("  asdf reshim nodejs");
  console.error("  npm ci");
  console.error("");
  console.error("If you already switched to the right Node major, npm rebuild better-sqlite3 is enough.");
  process.exit(1);
}
