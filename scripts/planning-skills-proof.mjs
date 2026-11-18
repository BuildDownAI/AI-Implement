#!/usr/bin/env node
// Opt-in, offline regression proof for the planning skills policy. NOT part of npm test.
//
// Drives the compiled production `setupPlanningWritePolicy` (PLANNING_PROOF_DIST/planning-write-policy.js,
// default ./dist) and the installed `claude` CLI against a loopback synthetic Anthropic-protocol server.
// No live credentials, no model calls, no network beyond 127.0.0.1. All fixtures live in an owned temp
// directory that is removed in a finally block. Exits non-zero on any failed assertion.
//
// Usage: node scripts/planning-skills-proof.mjs   (see docs/codex-parity-validation.md for the Docker form)
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const DIST = resolve(process.env.PLANNING_PROOF_DIST ?? "dist");
const CHILD_TIMEOUT_MS = 45_000;
const { setupPlanningWritePolicy } = await import(pathToFileURL(join(DIST, "planning-write-policy.js")).href);

const versionOf = (bin) => {
  const r = spawnSync(bin, ["--version"], { encoding: "utf8", timeout: 10_000 });
  assert.equal(r.status, 0, `${bin} --version failed: ${r.error?.message ?? r.stderr}`);
  return r.stdout.trim();
};

const skillMd = (name, extra, marker) => `---\nname: ${name}\ndescription: Synthetic planning proof\n${extra}---\n${marker}\n`;
const hookBlock = (key, cmd) =>
  `${key}:\n  PreToolUse:\n    - matcher: Write\n      hooks:\n        - type: command\n          command: ${cmd}\n`;
const mkSkill = (home, name, content) => {
  const dir = join(home, ".claude", "skills", name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "SKILL.md"), content);
};

/** Synthetic Anthropic-protocol server that replies with one scripted tool_use per main-loop request. */
function startProvider(actions, records) {
  let step = 0;
  const server = http.createServer(async (req, res) => {
    let data = "";
    for await (const c of req) data += c;
    let b = {};
    try { b = JSON.parse(data); } catch { /* non-JSON probe */ }
    if (req.url?.includes("count_tokens")) {
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ input_tokens: 100 }));
    }
    if (!req.url?.includes("/messages")) { res.writeHead(404); return res.end("{}"); }
    const main = Array.isArray(b.tools) && b.tools.some((t) => t.name === "Skill");
    const action = main ? actions[step++] : undefined;
    if (main) records.push({ tools: b.tools.map((t) => t.name), messages: b.messages });
    const content = action
      ? { type: "tool_use", id: `tool_${step}`, name: action[0], input: action[1] }
      : { type: "text", text: "Synthetic protocol fixture finished." };
    const message = { id: `msg_${Date.now()}`, type: "message", role: "assistant", model: b.model ?? "claude-sonnet-4-6", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 100, output_tokens: 1 } };
    const stop = action ? "tool_use" : "end_turn";
    if (!b.stream) {
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ ...message, content: [content], stop_reason: stop }));
    }
    res.writeHead(200, { "content-type": "text/event-stream" });
    const send = (event, payload) => res.write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`);
    send("message_start", { type: "message_start", message });
    send("content_block_start", { type: "content_block_start", index: 0, content_block: action ? { type: "tool_use", id: content.id, name: content.name, input: {} } : { type: "text", text: "" } });
    send("content_block_delta", { type: "content_block_delta", index: 0, delta: action ? { type: "input_json_delta", partial_json: JSON.stringify(content.input) } : { type: "text_delta", text: content.text } });
    send("content_block_stop", { type: "content_block_stop", index: 0 });
    send("message_delta", { type: "message_delta", delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: 1 } });
    send("message_stop", { type: "message_stop" });
    res.end();
  });
  return new Promise((ok, fail) => {
    server.once("error", fail);
    server.listen(0, "127.0.0.1", () => ok(server));
  });
}

/** Spawn claude with a hard timeout; always resolves with {code, signal, out, err, timedOut} or rejects on spawn error. */
function runClaude(args, opts) {
  return new Promise((ok, fail) => {
    const child = spawn("claude", args, { ...opts, stdio: ["ignore", "pipe", "pipe"] });
    let out = "", err = "", timedOut = false;
    child.stdout.on("data", (c) => (out += c));
    child.stderr.on("data", (c) => (err += c));
    const timer = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, CHILD_TIMEOUT_MS);
    child.once("error", (e) => { clearTimeout(timer); fail(e); });
    child.once("close", (code, signal) => { clearTimeout(timer); ok({ code, signal, out, err, timedOut }); });
  });
}

const root = realpathSync(mkdtempSync(join(tmpdir(), "bd-planning-skills-proof-")));
const closers = [];
try {
  const claudeVersion = versionOf("claude");
  console.log(JSON.stringify({ claudeVersion, network: "loopback synthetic provider only", realModelCalls: 0 }));

  // ---- 1. Production-policy source validation (no CLI needed) ----
  const policyCase = (label, { home, ws, content, name = "synthetic-proof" }) => {
    mkSkill(home, name, content);
    const policy = setupPlanningWritePolicy(ws, { skillNames: [name], homeDir: home });
    try {
      assert(!policy.args.includes("--plugin-dir"), `${label}: source must be excluded`);
    } finally { policy.cleanup(); }
    console.log(`PASS ${label}`);
  };
  const mkWs = (n) => { const w = join(root, n); mkdirSync(join(w, "ai-output", "comments"), { recursive: true }); return w; };
  const hook = `touch ${join(root, "never-ran")}`;
  policyCase("quoted hooks key excluded", { home: join(root, "h1"), ws: mkWs("w1"), content: skillMd("synthetic-proof", hookBlock('"hooks"', hook), "X") });
  policyCase("single-quoted hooks key excluded", { home: join(root, "h2"), ws: mkWs("w2"), content: skillMd("synthetic-proof", hookBlock("'hooks'", hook), "X") });
  policyCase("malformed YAML hooks excluded", { home: join(root, "h3"), ws: mkWs("w3"), content: `---\nname: synthetic-proof\n"hooks": [unterminated\n  PreToolUse: {{\n---\nX\n` });
  const wsOverlap = mkWs("w4");
  policyCase("source inside workspace excluded", { home: join(wsOverlap, "home"), ws: wsOverlap, content: skillMd("synthetic-proof", "", "X") });
  policyCase("source in '..selected-home' under workspace excluded", { home: join(wsOverlap, "..selected-home"), ws: wsOverlap, content: skillMd("synthetic-proof", "", "X") });

  // ---- 2. Native Claude session ----
  const ws = mkWs("sandbox");
  const home = join(root, "home");
  mkSkill(home, "synthetic-proof", skillMd("synthetic-proof", "allowed-tools: Bash, Edit\n", "PROBE_SKILL_LOADED. Attempt only the synthetic proof operations."));
  const repoHook = join(root, "repo-hook-ran");
  const untrusted = (name, marker) => skillMd(name, hookBlock("hooks", `touch ${repoHook}`), marker);
  mkdirSync(join(ws, ".claude", "skills", "bd-untrusted-proof"), { recursive: true });
  mkdirSync(join(ws, ".claude", "commands"), { recursive: true });
  writeFileSync(join(ws, ".claude", "skills", "bd-untrusted-proof", "SKILL.md"), untrusted("bd-untrusted-proof", "UNTRUSTED_REPO_SKILL_LOADED"));
  writeFileSync(join(ws, ".claude", "commands", "bd-untrusted-command.md"), untrusted("bd-untrusted-command", "UNTRUSTED_REPO_COMMAND_LOADED"));
  const edit = join(ws, "bd-proof-edit.txt");
  const outside = join(ws, "bd-proof-outside.md");
  const inside = join(ws, "ai-output", "comments", "bd-proof.md");
  const bash = join(root, "bash-ran");
  writeFileSync(edit, "original");

  const policy = setupPlanningWritePolicy(ws, { skillNames: ["synthetic-proof"], homeDir: home });
  closers.push(policy.cleanup);
  assert(policy.args.includes("--plugin-dir"), "trusted skill plugin missing");
  const actions = [
    ["Skill", { skill: "ai-implement-planning-skills:synthetic-proof" }],
    ["Skill", { skill: "bd-untrusted-proof" }],
    ["Skill", { skill: "bd-untrusted-command" }],
    ["Bash", { command: `touch ${bash}` }],
    ["Edit", { file_path: edit, old_string: "original", new_string: "changed" }],
    ["Write", { file_path: outside, content: "forbidden" }],
    ["Write", { file_path: inside, content: "allowed" }],
  ];
  const records = [];
  const server = await startProvider(actions, records);
  closers.push(() => server.close());
  const args = ["--print", "--verbose", "--output-format", "stream-json", "--max-turns", "8", "--dangerously-skip-permissions", ...policy.args, "Run the synthetic tool-enforcement proof."];
  const run = await runClaude(args, {
    cwd: ws,
    env: { PATH: process.env.PATH, HOME: home, ANTHROPIC_API_KEY: "synthetic-local-provider", ANTHROPIC_BASE_URL: `http://127.0.0.1:${server.address().port}`, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1" },
  });

  const messages = JSON.stringify(records.flatMap((r) => r.messages ?? []));
  const init = run.out.split("\n").flatMap((line) => {
    try { const x = JSON.parse(line); return x.type === "system" && x.subtype === "init" ? [{ skills: x.skills, slash_commands: x.slash_commands }] : []; } catch { return []; }
  });
  console.log(JSON.stringify({ code: run.code, timedOut: run.timedOut, requests: records.length, init, stderrTail: run.err.slice(-500) }));

  // All assertions run before cleanup.
  assert(!run.timedOut, "claude timed out");
  assert.equal(run.code, 0, `claude exited ${run.code} (${run.signal ?? "no signal"})`);
  assert(init.length > 0, "no system/init message captured");
  assert(messages.includes("PROBE_SKILL_LOADED"), "trusted Skill did not load");
  assert(!existsSync(bash), "Bash was not denied");
  assert.equal(readFileSync(edit, "utf8"), "original", "Edit was not denied");
  assert(!existsSync(outside), "Write outside ai-output/comments was not blocked");
  assert(existsSync(inside) && readFileSync(inside, "utf8") === "allowed", "allowed comments Write did not succeed");
  assert(!JSON.stringify(init).includes("bd-untrusted-"), "repository skill/command advertised in init discovery");
  assert(/unknown skill/i.test(messages), "explicit Unknown skill response missing");
  assert(!messages.includes("UNTRUSTED_REPO_SKILL_LOADED") && !messages.includes("UNTRUSTED_REPO_COMMAND_LOADED"), "repository content loaded");
  assert(!existsSync(repoHook), "repository hook executed");
  console.log("PASS native Claude: trusted Skill, Bash/Edit/outside-Write denied, comments Write allowed, repository skill/command/hook excluded");
} finally {
  for (const close of closers.reverse()) { try { close(); } catch { /* best effort */ } }
  rmSync(root, { recursive: true, force: true });
}
