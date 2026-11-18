import { expect, it } from "vitest";
import { FLY_GRAPHQL_URL, runFlySecretsCompare } from "../../scripts/fly-secrets-compare.js";
import { FLY_API_BASE } from "../fly-machines.js";
import { MODEL_AUTH_ENV } from "../model-auth-contract.js";
import { fakeFetch, type Reply } from "./helpers/fake-fetch.js";

const token = "token-sentinel-private";
const digest = "digest-sentinel-private";
const body = "reply-body-sentinel-private";
const secret = (name: string, hash = digest) => ({ name, digest: hash, ignoredValue: body });
const graph = (secrets: unknown[]) => ({ json: { data: { app: { secrets } }, ignored: body } });
const rest = (secrets: unknown[]) => ({ json: { secrets, ignored: body } });
function harness(graphql: Reply = graph([]), machines: Reply = rest([])) {
  const fake = fakeFetch({ "POST /graphql": graphql, "GET /v1/apps/sessions-test/secrets": machines });
  const output: string[] = [];
  const errors: string[] = [];
  return {
    fake, output, errors,
    run: (args: string[] = [], env: NodeJS.ProcessEnv = { FLY_SESSIONS_TOKEN: token }) => runFlySecretsCompare(
      ["--app", "sessions-test", ...args],
      { env, fetchImpl: fake.fetch, stdout: (line) => output.push(line), stderr: (line) => errors.push(line) },
    ),
  };
}
function noLeaks(lines: string[]) {
  for (const sentinel of [token, digest, "other-digest-private", body]) expect(lines.join("\n")).not.toContain(sentinel);
}

it.each([false, true])("reports all groups and classifications (json=%s), using exactly two reads", async (json) => {
  const h = harness(graph([secret("COMMON"), secret("CHANGED"), secret("STALE")]),
    rest([secret("COMMON"), secret("CHANGED", "other-digest-private"), secret("SAN_KEY"), secret("SAND_KEY"), secret("AII_KEY"), secret(MODEL_AUTH_ENV.protectionKey)]));
  expect(h.fake.calls).toEqual([]);
  expect(await h.run(["--prefixes", "SAN,AII,AI", ...(json ? ["--json"] : [])])).toBe(1);
  expect(h.fake.calls.map((call) => [call.method, call.url.href])).toEqual([
    ["POST", FLY_GRAPHQL_URL], ["GET", `${FLY_API_BASE}/apps/sessions-test/secrets`],
  ]);
  for (const call of h.fake.calls) expect(call.headers.get("Authorization")).toBe(`Bearer ${token}`);
  expect(JSON.parse(h.fake.calls[0].body)).toEqual({
    query: "query($appName: String!) { app(name: $appName) { secrets { name digest createdAt } } }",
    variables: { appName: "sessions-test" },
  });
  expect(h.fake.calls[1].body).toBe("");
  const printed = h.output.join("\n");
  if (json) {
    const report = JSON.parse(printed);
    expect(report.same).toBe(false);
    expect(report.inBoth).toEqual([
      { name: "CHANGED", digestDiffers: true, classification: "global: passes to every machine in process-level mode" },
      { name: "COMMON", digestDiffers: false, classification: "global: passes to every machine in process-level mode" },
    ]);
    expect(report.graphqlOnly).toEqual([{ name: "STALE", classification: "global: passes to every machine in process-level mode", suggestion: "fly secrets unset STALE -a sessions-test" }]);
    expect(report.machinesOnly).toEqual([
      { name: "AII_KEY", classification: "project" },
      { name: MODEL_AUTH_ENV.protectionKey, classification: "protection key: launch skips it" },
      { name: "SAND_KEY", classification: "global: passes to every machine in process-level mode" },
      { name: "SAN_KEY", classification: "project" },
    ]);
  } else {
    for (const text of ["In both lists.", "CHANGED (digest differs)", "GraphQL only (stale)", "fly secrets unset STALE -a sessions-test", "Machines API only", "SAN_KEY — project", "SAND_KEY — global: passes to every machine in process-level mode", `${MODEL_AUTH_ENV.protectionKey} — protection key: launch skips it`]) expect(printed).toContain(text);
  }
  expect(h.errors).toEqual([]);
  noLeaks([...h.output, ...h.errors]);
});

it("treats omitted prefixes as global", async () => {
  const h = harness(graph([]), rest([secret("SAN_KEY")]));
  expect(await h.run()).toBe(1);
  expect(h.output.join("\n")).toContain("SAN_KEY — global: passes to every machine in process-level mode");
});

it.each([{ secrets: [] }, { secrets: [secret("SAME")] }])("exits 0 for equal lists: %j", async ({ secrets }) => {
  const h = harness(graph(secrets), rest(secrets));
  expect(await h.run(["--json"])).toBe(0);
  expect(JSON.parse(h.output[0]).same).toBe(true);
  noLeaks(h.output);
});

it.each([
  [graph([secret("SAME")]), rest([secret("SAME", "other-digest-private")])],
  [graph([secret("OLD")]), rest([])],
  [graph([]), rest([secret("NEW")])],
])("exits 1 for each kind of difference", async (graphql, machines) => {
  const h = harness(graphql, machines);
  expect(await h.run()).toBe(1);
});

it.each([false, true])("requires credentials before requests (json=%s)", async (json) => {
  const h = harness();
  expect(await h.run(json ? ["--json"] : [], {})).toBe(2);
  expect([...h.output, ...h.errors].join()).toContain("FLY_SESSIONS_TOKEN");
  expect(h.fake.calls).toEqual([]);
});

it("rejects missing app and invalid arguments without requests or echoing input", async () => {
  const h = harness();
  for (const args of [[], ["--app", `!${body}`], ["--unknown", token], ["--app", "sessions-test", "--prefixes", body]]) {
    expect(await runFlySecretsCompare(args, { env: { FLY_SESSIONS_TOKEN: token }, fetchImpl: h.fake.fetch, stderr: (line) => h.errors.push(line) })).toBe(2);
  }
  expect(h.fake.calls).toEqual([]);
  noLeaks(h.errors);
});

const failures: Reply[] = [
  { status: 403, text: body },
  () => { throw new Error(`${body} ${token} ${digest}`); },
  { text: body },
  { json: { errors: [{ message: body }], data: { app: { secrets: [] } } } },
  { json: null },
  graph([ { name: "KEY", digest: 42 } ]),
  graph([ { name: `KEY\n${body}`, digest } ]),
  graph([secret("DUP"), secret("DUP")]),
];
it.each(failures)("handles GraphQL failure without leaking remote details: %j", async (reply) => {
  for (const json of [false, true]) {
    const h = harness(reply);
    expect(await h.run(json ? ["--json"] : [])).toBe(2);
    expect([...h.output, ...h.errors]).toEqual([json ? JSON.stringify({ error: "status" in reply && reply.status === 403 ? "HTTP 403" : "Secret comparison failed" }) : "status" in reply && reply.status === 403 ? "HTTP 403" : "Secret comparison failed"]);
    noLeaks([...h.output, ...h.errors]);
  }
});

it.each([{ status: 503, text: body }, { text: body }, { json: {} }, rest([{ name: "KEY" }]), () => { throw new Error(body); }])("handles Machines failure safely: %j", async (reply) => {
  const h = harness(graph([]), reply);
  expect(await h.run(["--json"])).toBe(2);
  noLeaks([...h.output, ...h.errors]);
});
