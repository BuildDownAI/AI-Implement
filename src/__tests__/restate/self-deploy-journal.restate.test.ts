import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { selfDeployRecovery, createSelfDeploy, createSelfDeployIngressClient, type SelfDeployStatus } from "../../restate/self-deploy.js";
import { callObject, eventually, journalEntries, journalText, queryInvocations, startVariants, stopAll, type RestateEnvironment } from "./harness.js";
import { deployFixture } from "./self-deploy-fixture.js";

describe("SelfDeploy delayed-send journal boundaries", () => {
  const f = deployFixture();
  f.deps.limits = { drainPollMs: 3_600_000, verifyInitialMs: 0, verifyPollMs: 3_600_000 };
  let envs: Map<string, RestateEnvironment>;
  beforeAll(async () => { envs = await startVariants([createSelfDeploy(f.deps), selfDeployRecovery]); }, 60_000);
  afterAll(async () => stopAll(envs));
  it("matches checkDrain, apply and verify command snapshots in both variants", async () => {
    for (const env of envs.values()) {
      f.state.work = true;
      f.state.commit = "old";
      await callObject(env.baseUrl(), "SelfDeploy", "test-app", "start", { branch: "main", requestedBy: "owner" });
      const capture = async (handler: string) => {
        const rows = await queryInvocations(env.adminAPIBaseUrl(), `target_service_name = 'SelfDeploy' AND target_handler_name = '${handler}' AND status = 'completed'`);
        if (rows.length === 0) return [];
        const entries = await journalEntries(env.adminAPIBaseUrl(), String(rows[0].id));
        expect(journalText(entries)).not.toMatch(/secret-fly|secret-kg/);
        return entries.filter(e => String(e.entry_type).startsWith("Command: "))
          .map(e => ({ type: String(e.entry_type).slice("Command: ".length), name: String(e.name ?? "") }));
      };
      await createSelfDeployIngressClient(() => "unowned", env.baseUrl()).releaseUnownedHold();
      const atRelease = await eventually(() => capture("releaseUnownedHold"), c => c.some(e => e.type === "Output"), { label: "completed hold recovery" });
      const atDrain = await eventually(() => capture("checkDrain"), c => c.some(e => e.type === "OneWayCall"), { label: "checkDrain delayed send" });
      // Cancel the drain and start a fresh deploy with a quiet probe. Its first verify mismatches.
      await callObject(env.baseUrl(), "SelfDeploy", "test-app", "cancel", { requestedBy: "owner" });
      f.state.work = false;
      await callObject(env.baseUrl(), "SelfDeploy", "test-app", "start", { branch: "main", requestedBy: "owner" });
      await eventually(() => callObject<SelfDeployStatus>(env.baseUrl(), "SelfDeploy", "test-app", "status", {}), r => r.deploy?.phase === "verifying", { label: "verifying" });
      const atApply = await eventually(() => capture("apply"), c => c.some(e => e.type === "Output"), { label: "completed apply" });
      const atVerify = await eventually(() => capture("verify"), c => c.some(e => e.type === "OneWayCall"), { label: "verify delayed send" });
      for (const [point, commands] of [["releaseUnownedHold", atRelease], ["check-drain", atDrain], ["apply", atApply], ["verify", atVerify]] as const) {
        expect(commands.some(e => e.type === "Sleep")).toBe(false);
        const file = join(import.meta.dirname, "journal-snapshots", `self-deploy.${point}.json`);
        if (process.env.UPDATE_JOURNAL_SNAPSHOTS === "1") writeFileSync(file, `${JSON.stringify(commands, null, 2)}\n`);
        expect(existsSync(file), "Regenerate only with UPDATE_JOURNAL_SNAPSHOTS=1").toBe(true);
        expect(commands, `SelfDeploy ${point} journal changed before a durable wait`).toEqual(JSON.parse(readFileSync(file, "utf8")));
      }
    }
  }, 60_000);
});
