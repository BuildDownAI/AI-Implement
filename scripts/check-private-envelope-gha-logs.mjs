#!/usr/bin/env node
// Synthetic private-envelope smoke for GitHub Actions log masking (AII-984).
//
// Used by .github/workflows/private-envelope-smoke.yml. Consumer jobs call the
// bootstrap/normal/consume/untrusted/fail/end verbs; a separate read-only verifier job
// calls `verify` after those jobs terminate and scans their COMPLETE logs. Everything
// secret-shaped is synthetic and derived deterministically from the run id, so the
// verifier reconstructs the values independently and no payload is ever uploaded.
//
// The bootstrap under test is the real `id: bootstrap` step extracted from the canonical
// workflows/claude-implement.yml and workflows/claude-plan.yml — never a copy.
//
//   node scripts/check-private-envelope-gha-logs.mjs --self-test
//   node scripts/check-private-envelope-gha-logs.mjs <bootstrap|normal|consume|untrusted|fail|end> <kind>
//   node scripts/check-private-envelope-gha-logs.mjs verify
import { createHmac, timingSafeEqual } from "node:crypto";
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { parse } from "yaml";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SALT = "private-envelope-smoke-synthetic-v1";
const END_MARKER = "Cleaning up orphan processes";

// kind -> the job that runs it, its canonical workflow, and the explicit expected outcome.
export const JOBS = [
  { kind: "implement", name: "private-envelope-implement", workflow: "workflows/claude-implement.yml", needs: "IMPLEMENT_RESULT", expected: "success" },
  { kind: "plan", name: "private-envelope-plan", workflow: "workflows/claude-plan.yml", needs: "PLAN_RESULT", expected: "success" },
  { kind: "failure", name: "private-envelope-failure", workflow: "workflows/claude-implement.yml", needs: "FAILURE_RESULT", expected: "success" },
];
const jobFor = (kind) => {
  const job = JOBS.find((j) => j.kind === kind);
  if (!job) throw new Error(`unknown kind: ${kind}`);
  return job;
};

// ---------------------------------------------------------------------------
// Canonical workflow extraction
// ---------------------------------------------------------------------------

/** Parse workflow text; return the bootstrap shell and the Run step's env->output mapping. */
export function extractCanonical(text) {
  const workflow = parse(text);
  const job = Object.values(workflow.jobs ?? {}).find((j) => (j.steps ?? []).some((s) => s.id === "bootstrap"));
  const bootstrap = job?.steps.find((s) => s.id === "bootstrap");
  if (!bootstrap || typeof bootstrap.run !== "string" || bootstrap.run.length === 0) {
    throw new Error("canonical workflow has no `id: bootstrap` run step");
  }
  const mapping = {};
  for (const step of job.steps) {
    if (step === bootstrap) continue;
    for (const [key, value] of Object.entries(step.env ?? {})) {
      const m = typeof value === "string" ? /^\$\{\{\s*steps\.bootstrap\.outputs\.(\w+)\s*\}\}$/.exec(value) : null;
      if (m) mapping[key] = m[1];
    }
  }
  if (Object.keys(mapping).length === 0) throw new Error("canonical workflow maps no bootstrap output into a step env");
  return { run: bootstrap.run, mapping };
}
const canonical = (kind) => extractCanonical(readFileSync(join(ROOT, jobFor(kind).workflow), "utf8"));

// ---------------------------------------------------------------------------
// Deterministic synthetic fixture (identical in consumer jobs and the verifier)
// ---------------------------------------------------------------------------

const ctxFromEnv = (kind, env = process.env) => ({
  kind,
  runId: env.GITHUB_RUN_ID || "local-run",
  attempt: env.GITHUB_RUN_ATTEMPT || "1",
});
const derive = (ctx, label, len = 43) =>
  createHmac("sha256", SALT).update(`${ctx.runId}:${ctx.attempt}:${ctx.kind}:${label}`).digest("base64url").slice(0, len);

export function buildFixture(ctx) {
  const v = (label, len) => derive(ctx, label, len);
  const plan = ctx.kind === "plan";
  const tokens = {
    resultToken: `synth-result-${v("result")}`,
    progressToken: `synth-progress-${v("progress")}`,
    publicationToken: `synth-publication-${v("publication")}`,
    attemptToken: `synth-attempt-${v("attempt")}`,
  };
  const grant = plan
    // Sealed Fly grant: nonce 16, tag 22 base64url characters.
    ? { version: 1, algorithm: "aes-256-gcm", dispatchId: "dispatch-smoke", backend: "fly", nonce: v("nonce", 16), ciphertext: `synthcipher${v("ciphertext")}`, tag: v("tag", 22) }
    : {
        version: 1, audience: "model-auth", grantId: "grant-smoke", dispatchId: "dispatch-smoke", snapshotId: "snap-smoke",
        projectKey: "proj-smoke", backend: "gha", expiresAt: 1_800_000_000_000, bearer: `synth-bearer-${v("bearer")}`,
        bindings: [{ stage: ctx.kind === "plan" ? "planning" : "implementation", profileId: "prof-api", profileRevision: 1, authMode: "openai-api-key" }],
      };
  const runConfig = Buffer.from(JSON.stringify({
    v: 1,
    issue: { id: "issue-smoke", identifier: "AII-984", title: "synthetic", description: "synthetic" },
    credentials: { version: 1, ...tokens, modelAuthGrant: grant },
  })).toString("base64");
  // Hostile public inputs: the private namespace is the single authority, these must be ignored.
  const hostile = {
    run_token: `synth-hostile-result-${v("hostile-result")}`,
    run_progress_token: `synth-hostile-progress-${v("hostile-progress")}`,
    // The planning workflow has no publication input at all, so there is nothing to hostile-supply.
    ...(plan ? {} : { run_publication_token: `synth-hostile-publication-${v("hostile-publication")}` }),
  };
  const secrets = [
    ["envelope", runConfig],
    ["result", tokens.resultToken],
    ["progress", tokens.progressToken],
    ["publication", tokens.publicationToken],
    ["attempt", tokens.attemptToken],
    ...(plan
      ? [["grant-nonce", grant.nonce], ["grant-ciphertext", grant.ciphertext], ["grant-tag", grant.tag]]
      : [["grant-bearer", grant.bearer]]),
    ["hostile-result", hostile.run_token],
    ["hostile-progress", hostile.run_progress_token],
    ...(plan ? [] : [["hostile-publication", hostile.run_publication_token]]),
  ].map(([label, value]) => ({ label, value }));
  return {
    kind: ctx.kind,
    event: { inputs: { run_config: runConfig, ...hostile } },
    secrets,
    // Output name -> exact value the trusted consumer must receive.
    delivered: { run_token: tokens.resultToken, run_progress_token: tokens.progressToken, run_publication_token: tokens.publicationToken },
    // Values that must never reach any process env at all.
    neverDelivered: secrets.filter((s) => !["result", "progress", "publication"].includes(s.label)).map((s) => s.value),
  };
}

// ---------------------------------------------------------------------------
// Consumers (pure evaluators + thin CLI wrappers)
// ---------------------------------------------------------------------------

const CALLBACK_ENV = /^RUN_(PROGRESS_|PUBLICATION_)?TOKEN$/;
const same = (a, b) => typeof a === "string" && a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

/** Compare a trusted consumer's env to the exact synthetic delivery. Returns { line, problems }. */
export function evaluateTrusted(fx, mapping, env) {
  const problems = [];
  const state = {};
  for (const [envKey, output] of Object.entries(mapping)) {
    state[output] = same(env[envKey], fx.delivered[output]) ? "exact" : "MISMATCH";
    if (state[output] !== "exact") problems.push(envKey);
  }
  for (const envKey of Object.keys(CALLBACK_ENV_KEYS)) {
    if (!(envKey in mapping) && env[envKey] !== undefined && env[envKey] !== "") problems.push(`${envKey}(unmapped)`);
  }
  const grantKeys = Object.keys(env).filter((k) => /GRANT|MODEL_AUTH/i.test(k));
  const leaked = Object.entries(env).some(([k, val]) => !(k in mapping) && fx.neverDelivered.some((s) => typeof val === "string" && val.includes(s)));
  if (grantKeys.length || leaked) problems.push("grant-promoted");
  const result = state.run_token ?? "absent";
  const progress = state.run_progress_token ?? "absent";
  const publication = state.run_publication_token ?? "absent";
  return {
    problems,
    line: problems.length === 0
      ? `PROOF consume kind=${fx.kind} result=${result} progress=${progress} publication=${publication} grant=not-promoted`
      : `PROOF consume kind=${fx.kind} MISMATCH ${problems.join(",")}`,
  };
}
const CALLBACK_ENV_KEYS = { RUN_TOKEN: 1, RUN_PROGRESS_TOKEN: 1, RUN_PUBLICATION_TOKEN: 1 };

export function evaluateUntrusted(fx, env) {
  const present = Object.keys(env).filter((k) => CALLBACK_ENV.test(k) || /GRANT|MODEL_AUTH/i.test(k));
  const leaked = Object.values(env).some((val) => fx.secrets.some((s) => val.includes(s.value)));
  return present.length === 0 && !leaked
    ? `PROOF untrusted kind=${fx.kind} callback-env=absent`
    : `PROOF untrusted kind=${fx.kind} MISMATCH callback-env=present`;
}

// ---------------------------------------------------------------------------
// Log inspection
// ---------------------------------------------------------------------------

const TS = /^\uFEFF?\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z /;
export const logLines = (log) => log.split(/\r?\n/).map((l) => l.replace(TS, "").trim());
export const hasLogEnd = (log) => logLines(log).some((l) => l.includes(END_MARKER));

/** The ordered proof markers a complete job log must contain. */
export function expectedMarkers(fx, mapping) {
  const k = fx.kind;
  const headers = Object.keys(mapping).map((key) => `${key}: ***`);
  const consume = (name) =>
    `PROOF ${name} kind=${k} result=exact progress=exact publication=${"RUN_PUBLICATION_TOKEN" in mapping ? "exact" : "absent"} grant=not-promoted`;
  return [
    `PROOF bootstrap kind=${k} exit=0`,
    ...fx.secrets.map((s) => `PROOF normal-output kind=${k} ${s.label}=***`),
    ...headers,
    consume("consume"),
    `PROOF untrusted kind=${k} callback-env=absent`,
    ...(k === "failure" ? [consume("consume-failing"), `PROOF deliberate-failure kind=${k}`] : []),
    `PROOF end kind=${k}`,
  ];
}

/** Returns problem strings; they name labels and lines only, never secret values. */
export function inspectJobLog(fx, mapping, log) {
  const problems = [];
  if (typeof log !== "string" || log.trim() === "") return ["log is empty or unavailable"];
  if (!hasLogEnd(log)) problems.push("log is incomplete: no job-cleanup end marker");
  for (const { label, value } of fx.secrets) if (log.includes(value)) problems.push(`EXPOSED ${label} in raw log`);
  const lines = logLines(log);
  if (lines.some((l) => l.includes("MISMATCH"))) problems.push("trusted consumer reported MISMATCH");
  let cursor = 0;
  for (const marker of expectedMarkers(fx, mapping)) {
    // Env header lines may repeat per consumer step; markers must appear in order.
    const at = lines.indexOf(marker, cursor);
    if (at === -1) problems.push(`missing/out-of-order marker: ${marker}`);
    else cursor = at + 1;
  }
  return problems;
}

export function evaluateNeeds(results) {
  const problems = [];
  for (const job of JOBS) {
    const got = results[job.needs];
    if (got !== job.expected) problems.push(`${job.name}: result ${JSON.stringify(got)}, expected ${job.expected}`);
  }
  return problems;
}

export function selectJobs(apiJobs) {
  const problems = [];
  const selected = {};
  for (const job of JOBS) {
    const matches = (apiJobs ?? []).filter((j) => j.name === job.name);
    if (matches.length !== 1) problems.push(`${job.name}: expected exactly one job, found ${matches.length}`);
    else selected[job.kind] = matches[0];
  }
  return { selected, problems };
}

export const jobState = (apiJob, job) =>
  apiJob.status !== "completed" ? "pending" : apiJob.conclusion === job.expected ? "ready" : `conclusion ${apiJob.conclusion}, expected ${job.expected}`;

export async function retry(fn, { attempts, delayMs, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) }) {
  let last;
  for (let i = 1; i <= attempts; i++) {
    try {
      const out = await fn(i);
      if (out !== undefined) return out;
      last = new Error("not ready");
    } catch (err) {
      last = err;
    }
    if (i < attempts) await sleep(delayMs);
  }
  throw new Error(`gave up after ${attempts} attempts: ${last?.message ?? last}`);
}

// ---------------------------------------------------------------------------
// Real bootstrap execution
// ---------------------------------------------------------------------------

export function parseOutputs(text) {
  const lines = text.split("\n");
  const outputs = {};
  for (let i = 0; i < lines.length; i++) {
    const m = /^([a-z_]+)<<(.+)$/.exec(lines[i]);
    if (!m) continue;
    const end = lines.indexOf(m[2], i + 1);
    outputs[m[1]] = lines.slice(i + 1, end).join("\n");
    i = end;
  }
  return outputs;
}

/** Run the canonical bootstrap shell against the synthetic event. stdio decides who sees ::add-mask::. */
export function runBootstrap(kind, { stdio, outputPath, env = process.env }) {
  const fx = buildFixture(ctxFromEnv(kind, env));
  const dir = mkdtempSync(join(env.RUNNER_TEMP || tmpdir(), "private-envelope-"));
  try {
    const eventPath = join(dir, "event.json");
    writeFileSync(eventPath, JSON.stringify(fx.event), { mode: 0o600 });
    const res = spawnSync("sh", ["-e", "-c", canonical(kind).run], {
      env: { PATH: env.PATH, GITHUB_EVENT_PATH: eventPath, GITHUB_OUTPUT: outputPath },
      stdio,
      encoding: "utf8",
    });
    return { fx, res };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// CLI verbs
// ---------------------------------------------------------------------------

const out = (line) => process.stdout.write(`${line}\n`);

async function verify() {
  const env = process.env;
  const problems = [];
  const need = (k) => { if (!env[k]) throw new Error(`missing env ${k}`); return env[k]; };
  const repo = need("GITHUB_REPOSITORY");
  const runId = need("GITHUB_RUN_ID");
  const attempt = env.GITHUB_RUN_ATTEMPT || "1";
  const api = env.GITHUB_API_URL || "https://api.github.com";
  const headers = { Authorization: `Bearer ${need("GH_TOKEN")}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" };

  problems.push(...evaluateNeeds(Object.fromEntries(JOBS.map((j) => [j.needs, env[j.needs]]))));

  const listJobs = async () => {
    const res = await fetch(`${api}/repos/${repo}/actions/runs/${runId}/attempts/${attempt}/jobs?per_page=100`, { headers });
    if (!res.ok) throw new Error(`jobs list HTTP ${res.status}`);
    const { jobs } = await res.json();
    const { selected, problems: sel } = selectJobs(jobs);
    if (sel.length) return { selected, sel };
    if (JOBS.some((j) => jobState(selected[j.kind], j) === "pending")) return undefined; // retry
    return { selected, sel };
  };
  let jobs;
  try {
    jobs = await retry(listJobs, { attempts: 6, delayMs: 10_000 });
  } catch (err) {
    problems.push(`jobs not completed: ${err.message}`);
  }
  if (jobs) {
    problems.push(...jobs.sel);
    const summary = [`## Private envelope smoke evidence`, "", `Run: ${env.GITHUB_SERVER_URL || "https://github.com"}/${repo}/actions/runs/${runId} (attempt ${attempt})`, ""];
    for (const job of JOBS) {
      const apiJob = jobs.selected[job.kind];
      if (!apiJob) continue;
      const state = jobState(apiJob, job);
      if (state !== "ready") { problems.push(`${job.name}: ${state}`); continue; }
      const fx = buildFixture({ kind: job.kind, runId, attempt });
      const { mapping } = canonical(job.kind);
      let log;
      try {
        log = await retry(async () => {
          const res = await fetch(`${api}/repos/${repo}/actions/jobs/${apiJob.id}/logs`, { headers, redirect: "follow" });
          if (!res.ok) throw new Error(`logs HTTP ${res.status}`);
          const text = await res.text();
          return hasLogEnd(text) ? text : undefined; // incomplete: retry, bounded
        }, { attempts: 5, delayMs: 10_000 });
      } catch (err) {
        problems.push(`${job.name}: log unavailable or incomplete (${err.message})`);
        continue;
      }
      const found = inspectJobLog(fx, mapping, log);
      problems.push(...found.map((p) => `${job.name}: ${p}`));
      out(`${found.length ? "FAIL" : "OK  "} ${job.name} job=${apiJob.id} conclusion=${apiJob.conclusion} lines=${log.split("\n").length} checkedValues=${fx.secrets.length}`);
      summary.push(`- \`${job.name}\` job ${apiJob.id}, conclusion \`${apiJob.conclusion}\`, ${log.split("\n").length} log lines, ${fx.secrets.length} synthetic values absent: ${found.length ? "FAIL" : "pass"} (${apiJob.html_url})`);
    }
    if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, `${summary.join("\n")}\n`);
  }
  if (problems.length) {
    for (const p of problems) process.stderr.write(`::error::${p}\n`);
    process.exit(1);
  }
  out("PROOF verify all-jobs-ok");
}

function consumerVerb(verb, kind) {
  const fx = buildFixture(ctxFromEnv(kind));
  const { mapping } = canonical(kind);
  if (verb === "bootstrap") {
    // The real step: stdout/stderr go straight to the Actions runner so ::add-mask:: takes effect,
    // and GITHUB_OUTPUT is the step's real output file.
    out(`::group::bootstrap ${kind}`);
    const { res } = runBootstrap(kind, { stdio: ["ignore", "inherit", "inherit"], outputPath: process.env.GITHUB_OUTPUT });
    out("::endgroup::");
    if (res.status !== 0) { out(`PROOF bootstrap kind=${kind} exit=${res.status}`); process.exit(1); }
    out(`PROOF bootstrap kind=${kind} exit=0`);
  } else if (verb === "normal") {
    // Deliberately emit every value after masking; the verifier requires each to be `***`.
    for (const s of fx.secrets) out(`PROOF normal-output kind=${kind} ${s.label}=${s.value}`);
    process.stderr.write(`stderr ${fx.secrets.map((s) => s.value).join(" ")}\n`);
  } else if (verb === "consume" || verb === "fail") {
    const { line, problems } = evaluateTrusted(fx, mapping, process.env);
    out(verb === "fail" ? line.replace("PROOF consume ", "PROOF consume-failing ") : line);
    if (problems.length) process.exit(1);
    if (verb === "fail") {
      out(`PROOF deliberate-failure kind=${kind}`);
      process.stderr.write("::error::Deliberate synthetic failure of a trusted consumer\n");
      process.exit(1);
    }
  } else if (verb === "untrusted") {
    const line = evaluateUntrusted(fx, process.env);
    out(line);
    if (line.includes("MISMATCH")) process.exit(1);
  } else if (verb === "end") {
    out(`PROOF end kind=${kind}`);
  } else {
    throw new Error(`unknown verb: ${verb}`);
  }
}

// ---------------------------------------------------------------------------
// Self-test
// ---------------------------------------------------------------------------

function syntheticLog(fx, mapping, { mask = true, drop = () => false, tail = true } = {}) {
  const hide = (s) => (mask ? fx.secrets.reduce((acc, { value }) => acc.split(value).join("***"), s) : s);
  const lines = ["##[group]Run actions/checkout@v4"];
  for (const m of expectedMarkers(fx, mapping)) {
    if (m.startsWith("PROOF normal-output")) {
      const label = m.split(" ")[3].split("=")[0];
      lines.push(hide(`PROOF normal-output kind=${fx.kind} ${label}=${fx.secrets.find((s) => s.label === label).value}`));
    } else if (m.endsWith(": ***")) {
      lines.push(`  ${m}`);
    } else lines.push(m);
  }
  if (tail) lines.push("Post job cleanup.", END_MARKER);
  return lines.filter((l) => !drop(l)).map((l) => `2026-10-01T10:00:00.0000000Z ${l}`).join("\n");
}

function selfTest() {
  const failures = [];
  let count = 0;
  const check = (name, ok) => { count++; if (!ok) failures.push(name); };
  const ctx = (kind) => ({ kind, runId: "123456", attempt: "1" });
  const fail = (name, problems) => check(name, problems.length > 0);

  // 1. The real bootstrap, extracted from the canonical YAML, locally (sh; no Actions runner).
  for (const kind of ["implement", "plan"]) {
    const dir = mkdtempSync(join(tmpdir(), "private-envelope-selftest-"));
    try {
      const outputPath = join(dir, "output");
      writeFileSync(outputPath, "");
      const env = { PATH: process.env.PATH, RUNNER_TEMP: dir, GITHUB_RUN_ID: "123456", GITHUB_RUN_ATTEMPT: "1" };
      const { fx, res } = runBootstrap(kind, { stdio: ["ignore", "pipe", "pipe"], outputPath, env });
      const { mapping } = canonical(kind);
      check(`${kind}: real bootstrap exits 0`, res.status === 0);
      const masks = new Set(res.stdout.split("\n").filter((l) => l.startsWith("::add-mask::")).map((l) => l.slice(12)));
      for (const s of fx.secrets) check(`${kind}: bootstrap masks ${s.label}`, masks.has(s.value));
      check(`${kind}: bootstrap prints only mask commands`, res.stdout.trim().split("\n").every((l) => l.startsWith("::add-mask::")));
      const outputs = parseOutputs(readFileSync(outputPath, "utf8"));
      const consumerEnv = { PATH: "x", ...Object.fromEntries(Object.entries(mapping).map(([k, o]) => [k, outputs[o] ?? ""])) };
      const trusted = evaluateTrusted(fx, mapping, consumerEnv);
      check(`${kind}: exact delivery`, trusted.problems.length === 0);
      check(`${kind}: publication ${kind === "plan" ? "excluded" : "delivered"}`, ("RUN_PUBLICATION_TOKEN" in mapping) === (kind !== "plan"));
      check(`${kind}: hostile public inputs ignored`, !Object.values(outputs).some((v) => fx.secrets.filter((s) => s.label.startsWith("hostile")).some((s) => s.value === v)));
      check(`${kind}: untrusted step sees nothing`, evaluateUntrusted(fx, { PATH: "x" }).endsWith("callback-env=absent"));
      // Negative consumer proofs.
      fail(`${kind}: wrong result value fails`, evaluateTrusted(fx, mapping, { ...consumerEnv, RUN_TOKEN: "wrong" }).problems);
      fail(`${kind}: missing progress value fails`, evaluateTrusted(fx, mapping, { ...consumerEnv, RUN_PROGRESS_TOKEN: "" }).problems);
      fail(`${kind}: hostile value delivered fails`, evaluateTrusted(fx, mapping, { ...consumerEnv, RUN_TOKEN: fx.event.inputs.run_token }).problems);
      fail(`${kind}: promoted grant env fails`, evaluateTrusted(fx, mapping, { ...consumerEnv, AI_IMPLEMENT_MODEL_AUTH_GRANT: "x" }).problems);
      fail(`${kind}: attempt token in env fails`, evaluateTrusted(fx, mapping, { ...consumerEnv, OTHER: fx.neverDelivered[1] }).problems);
      check(`${kind}: callback env in untrusted step fails`, evaluateUntrusted(fx, { RUN_TOKEN: "x" }).includes("MISMATCH"));
      check(`${kind}: secret in untrusted env fails`, evaluateUntrusted(fx, { X: fx.secrets[1].value }).includes("MISMATCH"));
      if (kind === "plan") fail("plan: publication in planning env fails", evaluateTrusted(fx, mapping, { ...consumerEnv, RUN_PUBLICATION_TOKEN: fx.delivered.run_publication_token }).problems);

      // 2. Log inspection.
      const good = syntheticLog(fx, mapping);
      check(`${kind}: complete masked log passes`, inspectJobLog(fx, mapping, good).length === 0);
      for (const s of fx.secrets) {
        fail(`${kind}: exposed ${s.label} fails`, inspectJobLog(fx, mapping, `${good}\n2026-10-01T10:00:01.0Z leak ${s.value}`));
      }
      fail(`${kind}: unmasked log fails`, inspectJobLog(fx, mapping, syntheticLog(fx, mapping, { mask: false })));
      fail(`${kind}: truncated log (no end marker) fails`, inspectJobLog(fx, mapping, syntheticLog(fx, mapping, { tail: false })));
      fail(`${kind}: empty log fails`, inspectJobLog(fx, mapping, ""));
      fail(`${kind}: log cut after bootstrap fails`, inspectJobLog(fx, mapping, good.split("\n").slice(0, 3).join("\n") + `\n${END_MARKER}`));
      for (const m of expectedMarkers(fx, mapping)) {
        fail(`${kind}: missing marker fails: ${m.slice(0, 40)}`, inspectJobLog(fx, mapping, syntheticLog(fx, mapping, { drop: (l) => l.trim() === m })));
      }
      fail(`${kind}: wrong consumer proof fails`, inspectJobLog(fx, mapping, good.replace("result=exact", "result=MISMATCH")));
      fail(`${kind}: consumer reporting MISMATCH fails`, inspectJobLog(fx, mapping, `${good}\n2026-10-01T10:00:01.0Z PROOF consume kind=${kind} MISMATCH RUN_TOKEN`));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
  // Failure job: deliberate-failure markers required.
  {
    const fx = buildFixture(ctx("failure"));
    const { mapping } = canonical("failure");
    const good = syntheticLog(fx, mapping);
    check("failure: complete log passes", inspectJobLog(fx, mapping, good).length === 0);
    fail("failure: log without deliberate failure marker fails", inspectJobLog(fx, mapping, good.replace(`PROOF deliberate-failure kind=failure`, "")));
  }
  // Fixture determinism and isolation.
  check("fixture is deterministic", JSON.stringify(buildFixture(ctx("implement"))) === JSON.stringify(buildFixture(ctx("implement"))));
  check("fixture differs per run id", buildFixture(ctx("implement")).secrets[1].value !== buildFixture({ ...ctx("implement"), runId: "999" }).secrets[1].value);

  // 3. Job/needs evaluation: skipped, failed, unexpected-success and missing jobs never pass.
  const goodNeeds = { IMPLEMENT_RESULT: "success", PLAN_RESULT: "success", FAILURE_RESULT: "success" };
  check("expected needs pass", evaluateNeeds(goodNeeds).length === 0);
  fail("skipped consumer fails", evaluateNeeds({ ...goodNeeds, IMPLEMENT_RESULT: "skipped" }));
  fail("cancelled consumer fails", evaluateNeeds({ ...goodNeeds, PLAN_RESULT: "cancelled" }));
  fail("failure consumer that failed fails", evaluateNeeds({ ...goodNeeds, FAILURE_RESULT: "failure" }));
  fail("deliberate failure skipped fails", evaluateNeeds({ ...goodNeeds, FAILURE_RESULT: "skipped" }));
  fail("missing needs result fails", evaluateNeeds({}));
  const apiJobs = JOBS.map((j, i) => ({ id: i + 1, name: j.name }));
  check("all jobs selected", selectJobs(apiJobs).problems.length === 0);
  fail("missing job fails", selectJobs(apiJobs.slice(1)).problems);
  fail("duplicate job fails", selectJobs([...apiJobs, apiJobs[0]]).problems);
  check("in-progress job is pending", jobState({ status: "in_progress" }, JOBS[0]) === "pending");
  check("wrong conclusion is not ready", jobState({ status: "completed", conclusion: "failure" }, JOBS[2]) !== "ready");
  check("expected conclusion is ready", jobState({ status: "completed", conclusion: "success" }, JOBS[2]) === "ready");

  // 4. Bounded retries.
  let calls = 0;
  const noSleep = async () => {};
  retry(async () => { calls++; return undefined; }, { attempts: 3, delayMs: 0, sleep: noSleep })
    .then(() => check("retry gives up", false), () => { check("retry is bounded at 3 attempts", calls === 3); finish(); });

  // 5. Smoke workflow shape (no shadow implementation, no secrets, minimal permissions).
  const smokeText = readFileSync(join(ROOT, ".github/workflows/private-envelope-smoke.yml"), "utf8");
  const smoke = parse(smokeText);
  check("smoke triggers on feature-branch PRs", smoke.on?.pull_request?.branches?.includes("ai-implement/feature/**"));
  check("smoke has no secrets reference", !/secrets\./.test(smokeText));
  check("smoke uploads no artifact", !/upload-artifact|actions\/cache/.test(smokeText));
  check("smoke has no unsafe PR triggers", !smoke.on.pull_request_target && !smoke.on.workflow_run);
  check("smoke top-level permissions are empty", JSON.stringify(smoke.permissions) === "{}");
  check("smoke defines no jq mask of its own", !/add-mask/.test(smokeText) && !/\bjq\b/.test(smokeText));
  for (const job of JOBS) {
    const sj = smoke.jobs?.[job.kind === "failure" ? "failure-consumer" : `${job.kind}-consumer`];
    check(`${job.name}: job present with exact name`, sj?.name === job.name);
    check(`${job.name}: contents:read only`, JSON.stringify(sj?.permissions) === JSON.stringify({ contents: "read" }));
    const steps = sj?.steps ?? [];
    check(`${job.name}: bootstrap step id`, steps.some((s) => s.id === "bootstrap" && s.run?.includes(`bootstrap ${job.kind}`)));
    const trusted = steps.filter((s) => s.name?.startsWith("Trusted consumer"));
    const { mapping } = canonical(job.kind);
    const want = Object.fromEntries(Object.entries(mapping).map(([k, o]) => [k, `\${{ steps.bootstrap.outputs.${o} }}`]));
    check(`${job.name}: trusted consumer env matches canonical Run step`, trusted.length >= 1 && trusted.every((s) => JSON.stringify(s.env) === JSON.stringify(want)));
    const untrusted = steps.find((s) => s.name?.startsWith("Untrusted"));
    check(`${job.name}: untrusted step has no env`, untrusted && untrusted.env === undefined);
    check(`${job.name}: end step runs always`, steps.some((s) => s.run?.includes(`end ${job.kind}`) && s.if === "always()"));
  }
  check("verifier needs every consumer and runs always", ["implement-consumer", "plan-consumer", "failure-consumer"].every((n) => smoke.jobs.verifier?.needs?.includes(n)) && smoke.jobs.verifier?.if === "always()");
  check("verifier permissions are contents:read + actions:read", JSON.stringify(smoke.jobs.verifier?.permissions) === JSON.stringify({ contents: "read", actions: "read" }));
  // Extraction must fail loudly when the bootstrap step is gone.
  try { extractCanonical("jobs:\n  a:\n    steps:\n      - run: echo\n"); check("missing bootstrap step throws", false); } catch { check("missing bootstrap step throws", true); }

  function finish() {
    if (failures.length) {
      for (const f of failures) process.stderr.write(`self-test FAIL: ${f}\n`);
      process.stderr.write(`self-test: ${failures.length} of ${count} checks failed\n`);
      process.exit(1);
    }
    out(`self-test: ${count} checks passed`);
  }
}

// ---------------------------------------------------------------------------

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [cmd, kind] = process.argv.slice(2);
  try {
    if (cmd === "--self-test") selfTest();
    else if (cmd === "verify") await verify();
    else if (cmd && kind) consumerVerb(cmd, kind);
    else throw new Error("usage: --self-test | verify | <bootstrap|normal|consume|untrusted|fail|end> <implement|plan|failure>");
  } catch (err) {
    process.stderr.write(`::error::${err.message}\n`);
    process.exit(1);
  }
}
