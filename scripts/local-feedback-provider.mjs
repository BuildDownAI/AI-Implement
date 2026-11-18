#!/usr/bin/env node
import { createServer, request as httpRequest } from "node:http";
import { appendFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const DEFAULT_PROVIDER_PORT = 8080;
const DEFAULT_BRIDGE_PORT = 8090;
const MAX_JSON_BYTES = 1_000_000;
const MAX_BRIDGE_BYTES = 1_000_000;
const TARGET_TEXT = "AI-Implement completed this local task.\n";
const PLAN_MARKDOWN = [
  "# Local feedback plan",
  "",
  "1. Read `examples/local-demo/task.md`.",
  "2. Replace `examples/local-demo/message.txt` with `AI-Implement completed this local task.` and exactly one trailing newline.",
  "3. Run `git diff --check` and verify the demo file diff.",
  "",
].join("\n");

const STAGES = new Map([
  ["gpt-local-planning", "planning"],
  ["gpt-local-implementation", "implementation"],
  ["gpt-local-review", "review"],
]);

function parsePositivePort(value, fallback) {
  if (value === undefined || value === "") return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0 || n > 65535) throw new Error(`invalid port: ${value}`);
  return n;
}

function createRecorder(path) {
  let sequence = 0;
  return (event) => {
    sequence += 1;
    const safe = {
      sequence,
      at: new Date().toISOString(),
      model: event.model,
      stage: event.stage,
      request: event.request,
      toolNames: event.toolNames,
      outputCount: event.outputCount,
      outcome: event.outcome,
    };
    if (path) appendFileSync(path, `${JSON.stringify(safe)}\n`);
  };
}

function sse(events) {
  return events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join("");
}

function sendJson(res, status, body) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

function readBounded(req, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > maxBytes) {
        reject(Object.assign(new Error("too large"), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

async function readJson(req, maxBytes) {
  const raw = await readBounded(req, maxBytes);
  try {
    const parsed = JSON.parse(raw.toString("utf8"));
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not object");
    return parsed;
  } catch {
    throw Object.assign(new Error("malformed json"), { status: 400 });
  }
}

function toolNames(tools) {
  return (Array.isArray(tools) ? tools : []).map((tool) => (typeof tool?.name === "string" ? tool.name : null)).filter(Boolean);
}

function chooseTool(tools, suffix) {
  return toolNames(tools).find((name) => name === suffix || name.endsWith(suffix));
}

function outputCount(input) {
  return Array.isArray(input) ? input.filter((item) => item?.type === "function_call_output").length : 0;
}

function completed(respId, inputTokens = 11, outputTokens = 7) {
  return {
    type: "response.completed",
    response: {
      id: respId,
      usage: {
        input_tokens: inputTokens,
        input_tokens_details: null,
        output_tokens: outputTokens,
        output_tokens_details: null,
        total_tokens: inputTokens + outputTokens,
      },
    },
  };
}

function message(id, text) {
  return {
    type: "response.output_item.done",
    output_index: 0,
    item: { type: "message", role: "assistant", id, content: [{ type: "output_text", text }] },
  };
}

function functionCall(callId, name, args) {
  return {
    type: "response.output_item.done",
    output_index: 0,
    item: { type: "function_call", call_id: callId, name, arguments: JSON.stringify(args) },
  };
}

function planningEvents(body, count, respId) {
  if (count === 0) {
    const name = chooseTool(body.tools, "repo_read");
    return name ? [functionCall("call_plan_read", name, { path: "examples/local-demo/task.md" })] : [message("msg_missing_repo_read", "missing repo_read")];
  }
  if (count === 1) {
    const name = chooseTool(body.tools, "comments_write");
    return name ? [functionCall("call_plan_write", name, { name: "plan.md", content: PLAN_MARKDOWN })] : [message("msg_missing_comments_write", "missing comments_write")];
  }
  return [message(`msg_${respId}`, "plan complete")];
}

function implementationEvents(body, count, respId) {
  if (count === 0) {
    const name = chooseTool(body.tools, "exec_command");
    const cmd = [
      "node -e \"require('fs').writeFileSync('examples/local-demo/message.txt', 'AI-Implement completed this local task.\\n')\"",
      "git diff --check",
    ].join(" && ");
    return name ? [functionCall("call_impl_write", name, { cmd })] : [message("msg_missing_exec_command", "missing exec_command")];
  }
  return [message(`msg_${respId}`, "Completed the local demo file update and diff check.")];
}

function reviewEvents(respId) {
  return [
    message(
      `msg_${respId}`,
      JSON.stringify({
        approved: true,
        blocking_issues: [],
        score: 100,
        progress_delta: 100,
        feedback: "The demo file was updated exactly as required.",
      }),
    ),
  ];
}

function eventsFor(body, requestNumber) {
  const stage = STAGES.get(String(body.model));
  if (!stage) return { status: 400, stage: "unknown", events: [] };
  const count = outputCount(body.input);
  const respId = `resp_${stage}_${requestNumber}`;
  let items;
  if (stage === "planning") items = planningEvents(body, count, respId);
  else if (stage === "implementation") items = implementationEvents(body, count, respId);
  else items = reviewEvents(respId);
  return {
    status: 200,
    stage,
    events: [{ type: "response.created", response: { id: respId } }, ...items, completed(respId)],
  };
}

export function createResponsesFixtureServer(options = {}) {
  const record = createRecorder(options.eventLogPath);
  const failure = options.failureMode ?? "none";
  let requests = 0;
  const server = createServer(async (req, res) => {
    if (req.headers.upgrade || req.method !== "POST" || req.url !== "/v1/responses") {
      res.writeHead(404).end();
      return;
    }
    requests += 1;
    let body;
    try {
      body = await readJson(req, options.maxJsonBytes ?? MAX_JSON_BYTES);
    } catch (error) {
      sendJson(res, error.status ?? 400, { error: "bad_request" });
      return;
    }
    const result = eventsFor(body, requests);
    const names = toolNames(body.tools);
    const count = outputCount(body.input);
    if (failure === "hang") {
      record({ model: String(body.model ?? ""), stage: result.stage, request: requests, toolNames: names, outputCount: count, outcome: "hang" });
      return;
    }
    if (failure === "500") {
      record({ model: String(body.model ?? ""), stage: result.stage, request: requests, toolNames: names, outputCount: count, outcome: "synthetic_500" });
      sendJson(res, 500, { error: "synthetic_failure" });
      return;
    }
    if (result.status !== 200) {
      record({ model: String(body.model ?? ""), stage: result.stage, request: requests, toolNames: names, outputCount: count, outcome: "rejected" });
      sendJson(res, result.status, { error: "unsupported_model" });
      return;
    }
    record({ model: String(body.model), stage: result.stage, request: requests, toolNames: names, outputCount: count, outcome: "ok" });
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
    res.end(sse(result.events));
  });
  server.on("upgrade", (_req, socket) => {
    socket.end("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
  });
  return server;
}

function allowedBridgePath(pathname) {
  return pathname === "/load" || pathname === "/persist" || pathname === "/disposition";
}

function createBridgeProxyServer(options = {}) {
  const targetPort = parsePositivePort(options.targetPort ?? process.env.LOCAL_FEEDBACK_BRIDGE_TARGET_PORT, 0);
  if (!targetPort) throw new Error("bridge target port is required");
  const targetHost = options.targetHost ?? process.env.LOCAL_FEEDBACK_BRIDGE_TARGET_HOST ?? "host.docker.internal";
  if (targetHost !== "host.docker.internal") throw new Error("bridge target host must be host.docker.internal");
  const timeoutMs = Number(options.timeoutMs ?? process.env.LOCAL_FEEDBACK_BRIDGE_TIMEOUT_MS ?? 30_000);
  const maxBytes = options.maxBytes ?? MAX_BRIDGE_BYTES;
  return createServer(async (req, res) => {
    if (req.method !== "POST" || typeof req.url !== "string" || !allowedBridgePath(req.url)) {
      sendJson(res, 404, { error: "not_found" });
      return;
    }
    let body;
    try {
      body = await readBounded(req, maxBytes);
      JSON.parse(body.toString("utf8"));
    } catch (error) {
      sendJson(res, error.status ?? 400, { error: "bad_request" });
      return;
    }
    const upstream = httpRequest(
      {
        host: targetHost,
        port: targetPort,
        method: "POST",
        path: req.url,
        headers: {
          "content-type": req.headers["content-type"] ?? "application/json",
          "content-length": String(body.length),
          ...(req.headers.authorization ? { authorization: req.headers.authorization } : {}),
        },
        timeout: timeoutMs,
      },
      (upstreamRes) => {
        res.writeHead(upstreamRes.statusCode ?? 502, {
          "content-type": upstreamRes.headers["content-type"] ?? "application/json",
        });
        upstreamRes.pipe(res);
      },
    );
    upstream.on("timeout", () => upstream.destroy(new Error("timeout")));
    upstream.on("error", () => sendJson(res, 502, { error: "bridge_unavailable" }));
    upstream.end(body);
  });
}

export function createLocalFeedbackFixture(options = {}) {
  const provider = createResponsesFixtureServer(options.provider);
  const bridge = createBridgeProxyServer(options.bridge);
  return { provider, bridge };
}

async function listen(server, port, host) {
  await new Promise((resolve) => server.listen(port, host, resolve));
}

export async function runSidecar(options = {}) {
  const providerPort = parsePositivePort(options.providerPort ?? process.env.LOCAL_FEEDBACK_PROVIDER_PORT, DEFAULT_PROVIDER_PORT);
  const bridgePort = parsePositivePort(options.bridgePort ?? process.env.LOCAL_FEEDBACK_BRIDGE_PORT, DEFAULT_BRIDGE_PORT);
  const host = options.host ?? process.env.LOCAL_FEEDBACK_HOST ?? "0.0.0.0";
  const provider = createResponsesFixtureServer({
    eventLogPath: options.eventLogPath ?? process.env.LOCAL_FEEDBACK_EVENT_LOG,
    failureMode: options.failureMode ?? process.env.LOCAL_FEEDBACK_FAILURE_MODE ?? "none",
  });
  const bridge = createBridgeProxyServer({
    targetHost: options.bridgeTargetHost ?? process.env.LOCAL_FEEDBACK_BRIDGE_TARGET_HOST,
    targetPort: options.bridgeTargetPort ?? process.env.LOCAL_FEEDBACK_BRIDGE_TARGET_PORT,
  });
  await Promise.all([listen(provider, providerPort, host), listen(bridge, bridgePort, host)]);
  if (options.readyFile ?? process.env.LOCAL_FEEDBACK_READY_FILE) {
    writeFileSync(options.readyFile ?? process.env.LOCAL_FEEDBACK_READY_FILE, JSON.stringify({ providerPort, bridgePort }));
  }
  return { provider, bridge, providerPort, bridgePort };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  runSidecar().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
