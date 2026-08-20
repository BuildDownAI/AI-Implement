import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

export async function collectPlanningArtifact(
  workspace: string,
  artifactsDir: string,
): Promise<boolean> {
  const commentsDir = join(workspace, "ai-output", "comments");
  let names: string[];
  try {
    names = (await readdir(commentsDir))
      .filter((name) => name.endsWith(".md"))
      .sort();
  } catch {
    return false;
  }
  if (names.length === 0) return false;

  const planningComments = await Promise.all(
    names.map((name) => readFile(join(commentsDir, name), "utf-8")),
  );
  await writeFile(join(artifactsDir, "plan.md"), planningComments.join("\n"), "utf-8");
  return true;
}
