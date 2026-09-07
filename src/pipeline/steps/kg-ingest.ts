import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { PipelineContext, StepModule, StepReporter } from "../types.js";

/** Coded failure raised when the kg_ingest subprocess exits with a non-zero code. */
export class KgIngestError extends Error {
  readonly code = "KG_INGEST_FAILED";
  readonly exitCode: number;
  readonly outputTail: string;
  constructor(exitCode: number, outputTail: string) {
    super(`KG_INGEST_FAILED: exit ${exitCode}\n${outputTail}`);
    this.exitCode = exitCode;
    this.outputTail = outputTail;
  }
}

const MAX_TAIL_LINES = 40;
const MAX_TAIL_BYTES = 8192;

type SpawnImplFn = (
  command: string,
  args: string[],
  options: { cwd: string; stdio: ["ignore", "pipe", "pipe"] },
) => ChildProcess;

interface KgIngestInputs extends Record<string, unknown> {
  /** KG source repo workspace — the directory the ingest runs in. */
  workspaceDir: string;
  /** Absolute path to the cloned code repo. Omit when clone-code-repo was skipped. */
  codeRepoDir?: string;
  /** Injectable spawn for testing. */
  spawnImpl?: SpawnImplFn;
  /** Injectable writeFileSync for testing. */
  writeFileSyncImpl?: (path: string, data: string) => void;
  /** Injectable mkdirSync for testing. */
  mkdirSyncImpl?: (path: string, opts: { recursive: boolean }) => void;
  /** Injectable existsSync for testing. */
  existsSyncImpl?: (path: string) => boolean;
  /** Injectable readdirSync for testing. */
  readdirSyncImpl?: (path: string) => string[];
  /** Injectable readFileSync for testing. */
  readFileSyncImpl?: (path: string, enc: "utf-8") => string;
}

interface KgIngestOutputs extends Record<string, unknown> {
  statsFile: string | null;
}

interface KgStats {
  quads: number;
  vectors?: number;
  docPages?: number;
  durationSec?: number;
}

function tryParseStats(line: string): KgStats | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith("{")) return null;
  try {
    const obj = JSON.parse(trimmed) as unknown;
    if (
      obj !== null &&
      typeof obj === "object" &&
      !Array.isArray(obj) &&
      typeof (obj as Record<string, unknown>).quads === "number"
    ) {
      return obj as KgStats;
    }
  } catch {
    // not a valid JSON stats line
  }
  return null;
}

function fallbackStatsFromParts(
  workspaceDir: string,
  existsFn: (p: string) => boolean,
  readdirFn: (p: string) => string[],
  readFileFn: (p: string, enc: "utf-8") => string,
  durationSec: number,
): KgStats {
  const partsDir = join(workspaceDir, "snapshot", "parts");
  if (!existsFn(partsDir)) return { quads: 0, durationSec };
  let total = 0;
  let files: string[];
  try {
    files = readdirFn(partsDir).filter((f) => f.endsWith(".nt"));
  } catch {
    return { quads: 0, durationSec };
  }
  for (const file of files) {
    try {
      const content = readFileFn(join(partsDir, file), "utf-8");
      total += content.split("\n").filter((l) => l.trim().length > 0).length;
    } catch {
      // skip unreadable files
    }
  }
  return { quads: total, durationSec };
}

export const kgIngestStep: StepModule<KgIngestInputs, KgIngestOutputs> = {
  async run(
    _context: PipelineContext,
    inputs: KgIngestInputs,
    _reporter: StepReporter,
  ): Promise<KgIngestOutputs> {
    const {
      workspaceDir,
      codeRepoDir,
      spawnImpl,
      writeFileSyncImpl: writeFn = writeFileSync,
      mkdirSyncImpl: mkdirFn = (p, o) => mkdirSync(p, o),
      existsSyncImpl: existsFn = existsSync,
      readdirSyncImpl: readdirFn = (p) => readdirSync(p) as string[],
      readFileSyncImpl: readFileFn = (p, enc) => readFileSync(p, enc),
    } = inputs;

    const spawnFn: SpawnImplFn =
      spawnImpl ??
      ((cmd, args, opts) =>
        spawn(cmd, args, opts as Parameters<typeof spawn>[2]) as ChildProcess);

    const args = ["-m", "kg_ingest", "refresh"];
    if (codeRepoDir) args.push("--code-repo", codeRepoDir);

    const trackerDataFile = join(workspaceDir, "tracker-data.json");
    if (existsFn(trackerDataFile)) args.push("--tracker-data", trackerDataFile);

    console.log(`[kg-ingest] python ${args.join(" ")}`);
    const start = Date.now();

    const stdoutLines: string[] = [];
    const tailBuffer: string[] = [];

    await new Promise<void>((resolve, reject) => {
      const proc = spawnFn("python", args, {
        cwd: workspaceDir,
        stdio: ["ignore", "pipe", "pipe"],
      });

      function pushLine(line: string): void {
        tailBuffer.push(line);
        if (tailBuffer.length > MAX_TAIL_LINES) tailBuffer.shift();
      }

      function attachLineReader(stream: NodeJS.ReadableStream, isStdout: boolean): void {
        let buf = "";
        stream.on("data", (chunk: Buffer | string) => {
          buf += typeof chunk === "string" ? chunk : chunk.toString("utf-8");
          let nl: number;
          while ((nl = buf.indexOf("\n")) >= 0) {
            const line = buf.slice(0, nl);
            buf = buf.slice(nl + 1);
            pushLine(line);
            if (isStdout) stdoutLines.push(line);
          }
        });
        stream.on("end", () => {
          if (buf) {
            pushLine(buf);
            if (isStdout) stdoutLines.push(buf);
          }
        });
      }

      attachLineReader(proc.stdout!, true);
      attachLineReader(proc.stderr!, false);

      proc.on("close", (code) => {
        if (code === 0) {
          resolve();
        } else {
          const exitCode = code ?? 1;
          let tail = tailBuffer.join("\n");
          if (tail.length > MAX_TAIL_BYTES) {
            tail = "..." + tail.slice(tail.length - MAX_TAIL_BYTES);
          }
          reject(new KgIngestError(exitCode, tail));
        }
      });

      proc.on("error", (err) => {
        reject(new KgIngestError(1, `spawn error: ${err.message}`));
      });
    });

    const durationSec = (Date.now() - start) / 1000;

    let stats: KgStats | null = null;
    for (const line of stdoutLines) {
      stats = tryParseStats(line);
      if (stats) break;
    }

    if (!stats) {
      stats = fallbackStatsFromParts(workspaceDir, existsFn, readdirFn, readFileFn, durationSec);
    } else if (stats.durationSec === undefined) {
      stats = { ...stats, durationSec };
    }

    const aiOutputDir = join(workspaceDir, "ai-output");
    mkdirFn(aiOutputDir, { recursive: true });
    const statsFile = join(aiOutputDir, "kg-stats.json");
    writeFn(statsFile, JSON.stringify(stats));
    console.log(`[kg-ingest] done in ${durationSec.toFixed(1)}s; wrote ${statsFile}`);

    return { statsFile };
  },
};
