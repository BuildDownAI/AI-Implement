import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import * as restate from "@restatedev/restate-sdk";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getDb } from "../../dedup.js";
import { initMappingsTable } from "../../config.js";
import { appendLog, initLogTable } from "../../log.js";
import { acquire, read } from "../../dispatch-admission.js";
import { mintRunToken, mintPreparedReviewFixToken, verifyRunToken } from "../../runner-tokens.js";
import { handleRunnerResult, ReviewFixIntakeUnavailableError, type RunnerPhase, type HandleRunnerResultInput } from "../../runner-callback.js";
import { SqliteReviewFixAttemptStore } from "../../review-fix-attempt-store.js";
import { createPlanningRunWorkflow, type PlanningRunDependencies } from "../../restate/planning-run-workflow.js";
import { createImplementationRunWorkflow, type ImplementationRunDependencies } from "../../restate/implementation-run-workflow.js";
import { createKgRefreshWorkflow, type KgRefreshWorkflowDependencies } from "../../restate/kg-refresh-workflow.js";
import { createReviewFixAttempt, type ReviewFixAttemptDependencies } from "../../restate/review-fix-attempt.js";
import { createPlanningAdmissionTerminationHook, createPlanningRunIngressClient } from "../../restate/planning-run-client.js";
import { createImplementationAdmissionTerminationHook, createImplementationRunIngressClient } from "../../restate/implementation-run-client.js";
import { createKgRefreshIngressClient } from "../../restate/kg-refresh-production.js";
import { createReviewFixIngressClient, reviewFixResultForwardKey, reviewFixResultIntakeFromForward } from "../../restate/review-fix-client.js";
import { orchestratorTools } from "../../restate/tools.js";
import { JobAccountingPageSchema } from "../../job-accounting.js";
import { makeReviewFixResult } from "../helpers/builders.js";
import { FakeProvider } from "../providers/fake.js";
import { VARIANTS, callService, eventually, journalEntryNames, queryInvocations, startVariants, stopAll, type RestateEnvironment } from "./harness.js";

const SECRET = "runner-intake-test-secret";
// Hold lifecycle work at its first dependency so these tests isolate the real shared
// report handlers and their production accounting writers. Unused dependencies fail closed.
function dependencies<T>(values: Partial<T>): T {
  return values as T;
}
const parked = (): Promise<never> => new Promise(() => {});

function invocations(dispatchId: string) {
  const snapshotId = `snapshot-${dispatchId}`;
  const selection = { agent: "claude", provider: "anthropic", model: "model", accountProfileId: "profile", invocationTimeoutMs: 60_000 };
  const profile = { id: "profile", identity: "account", revision: 1, agent: "claude", provider: "anthropic", authMode: "anthropic-api-key" };
  getDb().prepare(`INSERT INTO run_agent_config_snapshots
    (snapshot_id, dispatch_id, project_key, resolved_config_json, source_map_json, config_revision_ids_json, created_at)
    VALUES (?, ?, 'ENG', ?, ?, ?, 1)`).run(snapshotId, dispatchId,
    JSON.stringify({ stages: { planning: selection, implementation: selection, review: selection }, profiles: { planning: profile, implementation: profile, review: profile } }),
    JSON.stringify(Object.fromEntries(["planning", "implementation", "review"].map((stage) => [stage, Object.fromEntries(Object.keys(selection).map((field) => [field, "project"]))]))),
    JSON.stringify({ orchestratorDefault: { configRevisionId: "r1", revision: 1 }, project: { configRevisionId: "r2", revision: 1 } }));
  return [1, 2].map((index) => ({
    attribution: {
      version: 1, invocationId: `${dispatchId}-call-${index}`, snapshotId, stage: "implementation",
      agent: "claude", provider: "anthropic", model: "model", profileId: "profile",
      authMode: "anthropic-api-key", limit: null, outcome: "success",
      usage: { availability: "complete", tokensIn: 10, tokensOut: 2, costUsd: 0.1, costStatus: "reported" },
    },
  }));
}

describe("runner result to workflow accounting", () => {
  let environments: Map<string, RestateEnvironment>;
  const store = new SqliteReviewFixAttemptStore();
  let caseNumber = 0;
  let callback: Server;
  let callbackUrl: string;
  const callbackInputs = new Map<string, HandleRunnerResultInput>();

  beforeAll(async () => {
    getDb();
    initLogTable();
    initMappingsTable();
    // Exercise HTTP delivery at the callback boundary, with the production handler
    // and real workflow clients; only tracker/backend lifecycle work is synthetic.
    callback = createServer(async (request, response): Promise<void> => {
      if (request.url !== "/runner/result" || request.method !== "POST") {
        response.writeHead(404).end();
        return;
      }
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const input = callbackInputs.get(request.headers.authorization ?? "");
      if (!input) { response.writeHead(401).end(); return; }
      const result = await handleRunnerResult({
        ...input, authorization: request.headers.authorization,
        body: JSON.parse(Buffer.concat(chunks).toString()),
      });
      response.writeHead(result.status, { "content-type": "application/json" }).end(JSON.stringify(result.body));
    });
    await new Promise<void>((resolve) => callback.listen(0, "127.0.0.1", resolve));
    callbackUrl = `http://127.0.0.1:${(callback.address() as AddressInfo).port}/runner/result`;
    environments = await startVariants([
      createPlanningRunWorkflow(dependencies<PlanningRunDependencies>({ reserve: parked })),
      createImplementationRunWorkflow(dependencies<ImplementationRunDependencies>({ reserve: parked })),
      createKgRefreshWorkflow(dependencies<KgRefreshWorkflowDependencies>({
        kgSourceRepo: "o/kg", resolveDispatchRecord: () => ({}) as never,
        recordDispatchRow: parked,
      })),
      createReviewFixAttempt(dependencies<ReviewFixAttemptDependencies>({ store })),
      orchestratorTools,
      restate.service({ name: "IntakeStarter", handlers: {
        async kg(ctx: restate.Context, input: { triggerId: string }): Promise<void> {
          ctx.workflowSendClient<ReturnType<typeof createKgRefreshWorkflow>>({ name: "KgRefresh" }, input.triggerId).run(input);
        },
      } }),
    ]);
  }, 120_000);
  afterAll(async () => {
    await new Promise<void>((resolve, reject) => callback?.close((error) => error ? reject(error) : resolve()));
    await stopAll(environments);
  });

  for (const [variant] of VARIANTS) {
    it.each(["planning", "implementation", "implementation-failure", "review-fix", "kg-refresh"] as const)(
      `${variant}: %s keeps its credential after an unavailable forward, then records every call once`,
      async (kind) => {
        const env = environments.get(variant)!;
        const dispatchId = randomUUID();
        const prNumber = 100 + caseNumber++;
        const issueId = dispatchId;
        const phase: RunnerPhase = kind === "review-fix" || kind === "implementation-failure" ? "implementation" : kind;
        const deadlineAt = Date.now() + 3_600_000;
        let token: string;
        let reviewFix: ReturnType<typeof makeReviewFixResult> | undefined;
        if (kind === "review-fix") {
          getDb().prepare(`INSERT INTO dispatch_admissions
            (dispatch_id, mapping_key, issue_scope, issue_id, installation_id, repository, pr_number,
             lifecycle_owner, phase, backend, created_at)
            VALUES (?, 'ENG', 'pr', 'o/r#42', '1', 'o/r', ?, ?, 'implementation', 'github-actions', ?)`)
            .run(dispatchId, prNumber, `restate:${dispatchId}`, Date.now());
          getDb().prepare(`INSERT INTO review_fix_attempts
            (attempt_id, dispatch_id, mapping_key, installation_id, repository, pr_number, issue_scope,
             issue_id, owner, state, created_at, deadline_at, task_snapshot_json, finding_versions_json)
            VALUES (?, ?, 'ENG', '1', 'o/r', ?, 'pr', 'o/r#42', ?, 'prepared', ?, ?, '{}', '[]')`)
            .run(dispatchId, dispatchId, prNumber, dispatchId, Date.now(), deadlineAt);
          await store.bindExecution(dispatchId, { githubRunId: 555, githubRunAttempt: 1 }, Date.now());
          token = mintPreparedReviewFixToken({ attemptId: dispatchId, audience: "result", secret: SECRET }).token;
          reviewFix = makeReviewFixResult({ attemptId: dispatchId, repository: "o/r", prNumber, deadlineAt });
        } else {
          token = mintRunToken({ dispatchId, phase, issueId, mappingTeamKey: "ENG", ttlSeconds: 3600, secret: SECRET }).token;
          if (kind !== "kg-refresh") {
            expect(acquire({
              dispatchId, mappingKey: "ENG", scope: { kind: "issue", issueScope: "ENG", issueId },
              kind: phase, backend: "github-actions", lifecycleOwner: { kind: "restate", attemptId: dispatchId }, cap: 100,
            }).ok).toBe(true);
          }
          const workflow = kind === "planning" ? "PlanningRun" : phase === "implementation" ? "ImplementationRun" : "KgRefresh";
          const input = kind === "kg-refresh" ? { triggerId: dispatchId } : {
            dispatchId, teamKey: "ENG", issueId, issueIdentifier: "ENG-1", backend: "github-actions",
            ...(kind === "planning" ? { planningContext: {} } : { launchContext: {}, maxJobMinutes: 60 }),
          };
          if (kind === "kg-refresh") {
            await callService(env.baseUrl(), "IntakeStarter", "kg", input);
          } else {
          const submitted = await fetch(`${env.baseUrl()}/${workflow}/${dispatchId}/run/send`, {
            method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(input),
          });
          expect(submitted.ok, await submitted.text()).toBe(true);
          }
          await eventually(async () => {
            const response = await fetch(`${env.baseUrl()}/${workflow}/${dispatchId}/status`, {
              method: "POST", headers: { "content-type": "application/json" }, body: "{}",
            });
            expect(response.ok).toBe(true);
            return await response.json() as { step: string | null };
          }, (value) => value.step === "reserve");
        }
        appendLog({ issueId, teamKey: "ENG", repo: "o/r", dispatchId, phase });
        const calls = invocations(dispatchId);
        let unavailable = true;
        const fetchImpl: typeof fetch = async (input, init) => {
          if (unavailable) throw new Error("injected Restate outage");
          return fetch(input, init);
        };
        const planning = createPlanningRunIngressClient(env.baseUrl(), { fetchImpl });
        const implementation = createImplementationRunIngressClient(env.baseUrl(), { fetchImpl });
        const review = createReviewFixIngressClient(env.baseUrl(), { fetchImpl });
        const kg = createKgRefreshIngressClient(env.baseUrl(), { fetchImpl });
        const provider = new FakeProvider({ recordCalls: true });
        const input: HandleRunnerResultInput = {
          authorization: `Bearer ${token}`, secret: SECRET,
          body: { phase, outcome: kind === "implementation-failure" ? "failure" : "success", noWork: kind === "implementation", comments: [], prUrl: "https://github.com/o/r/pull/42", reviewFix, invocations: calls as never },
          resolveProvider: async () => provider,
          checkPlanningAdmissionTermination: createPlanningAdmissionTerminationHook({ ingress: planning, legacy: async () => {}, readAdmission: read }),
          checkImplementationAdmissionTermination: createImplementationAdmissionTerminationHook({ ingress: implementation, legacy: async () => {}, readAdmission: read }),
          kgRefreshClient: kg,
          onReviewFixResult: async (result) => {
            const outcome = reviewFixResultIntakeFromForward(result.attemptId,
              await review.result(result.attemptId, result, { idempotencyKey: reviewFixResultForwardKey(result) }));
            if (!outcome) throw new ReviewFixIntakeUnavailableError();
            return outcome;
          },
        };
        callbackInputs.set(`Bearer ${token}`, input);
        const post = (): Promise<Response> => fetch(callbackUrl, {
          method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
          body: JSON.stringify(input.body),
        });
        expect((await post()).status).toBe(503);
        if (kind !== "review-fix") expect(verifyRunToken(token, SECRET, "result", { consume: false }).ok).toBe(true);
        unavailable = false;
        expect((await post()).status).toBe(200);
        const workflowName = kind === "review-fix" ? "ReviewFixAttempt" : kind === "planning" ? "PlanningRun" : phase === "implementation" ? "ImplementationRun" : "KgRefresh";
        const forwarded = await queryInvocations(env.adminAPIBaseUrl(),
          `target_service_name = '${workflowName}' AND target_service_key = '${dispatchId}' AND target_handler_name = '${kind === "review-fix" ? "result" : "report"}'`);
        const steps = (await Promise.all(forwarded.map((row) => journalEntryNames(env.adminAPIBaseUrl(), String(row.id))))).flat();
        expect(steps).toContain("record-usage");
        if (phase === "implementation" && kind !== "review-fix") {
          expect(getDb().prepare("SELECT status FROM dispatch_log WHERE dispatch_id = ?").get(dispatchId)).toEqual({ status: "dispatched" });
        }
        const effects = provider.recordedCalls().length;
        expect((await post()).status).toBe(200);
        expect(provider.recordedCalls()).toHaveLength(effects);
        const beforeConflict = getDb().prepare("SELECT * FROM model_invocation_attribution WHERE dispatch_id = ?").all(dispatchId);
        // Change a valid sanitized usage value, keeping the same token and transport key.
        calls[0].attribution.usage.tokensIn = 999;
        expect((await post()).status).toBe(409);
        expect(getDb().prepare("SELECT * FROM model_invocation_attribution WHERE dispatch_id = ?").all(dispatchId)).toEqual(beforeConflict);
        calls[0].attribution.usage.tokensIn = 10;
        expect((await post()).status).toBe(200);
        if (kind === "review-fix") {
          const beforeRelease = getDb().prepare("SELECT * FROM model_invocation_attribution WHERE dispatch_id = ?").all(dispatchId);
          expect(beforeRelease).toHaveLength(2);
          expect(await store.releaseOwner(dispatchId, "finalized")).toEqual({ status: "released" });
          expect(read(dispatchId)?.releasedAt).toEqual(expect.any(Number));
          // Keep the production forwarding key: a retry after release may be
          // answered by transport idempotency without re-entering the handler.
          const retried = await post();
          expect(retried.ok, await retried.text()).toBe(true);
          expect(getDb().prepare("SELECT * FROM model_invocation_attribution WHERE dispatch_id = ?").all(dispatchId)).toEqual(beforeRelease);
        }
        const rows = getDb().prepare("SELECT invocation_id FROM model_invocation_attribution WHERE dispatch_id = ?").all(dispatchId);
        expect(rows).toHaveLength(2);
        // Lifecycle work is parked above; project a finished job before querying
        // the accounting API, which deliberately serves finished jobs only.
        getDb().prepare("UPDATE dispatch_log SET status = 'completed', completed_at = ? WHERE dispatch_id = ?")
          .run(Date.now(), dispatchId);
        const answer = await callService<{ content: Array<{ text: string }> }>(env.baseUrl(),
          "orchestratorTools", "list_job_accounting", {
            caller: { kind: "service", email: null, role: "user" }, args: { includeUnsettled: true },
          });
        const page = JobAccountingPageSchema.parse(JSON.parse(answer.content[0].text));
        expect(page.records.find((job) => job.dispatchId === dispatchId)?.invocations).toHaveLength(2);
      },
    );
  }
});
