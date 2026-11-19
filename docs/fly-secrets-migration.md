# Fly secrets migration

Move an existing deployment from GraphQL secret reads to Fly Machines API secret reads.

## Who needs this

Use this procedure for each deployment that runs Fly Machines and whose build does not contain commit `654e9470` (AII-1910). A deployment with no Fly sessions app does not need this procedure.

Read `sourceCommit` from the orchestrator's `GET /` response. In a repository checkout with the deployment's commit history, run:

```bash
git merge-base --is-ancestor 654e9470 <sourceCommit>
```

Replace `<sourceCommit>` with the reported commit. Exit 0 means the build already contains the change. Exit 1 means the deployment needs the move. If the stamp is missing or null, or Git cannot resolve either commit, the result is unknown. Identify the running build and obtain its history before you continue.

## Before the upgrade

Use a current repository checkout that contains the compare script. Make the sessions app credential available as `FLY_SESSIONS_TOKEN` in the environment. Do not put its value in the command or in the comparison record.

Run this read-only command for **each sessions app** of the deployment. Replace `<sessions app>` with its app name:

```bash
npx tsx scripts/fly-secrets-compare.ts --app <sessions app>
```

For project classification, add `--prefixes` with the actual team keys from all project mappings that use that app. For example, if those keys are SAN and AII:

```bash
npx tsx scripts/fly-secrets-compare.ts --app <sessions app> --prefixes SAN,AII
```

Without `--prefixes`, the script classifies every name except the protection key as global. Check the team keys before you decide which names may reach every machine. The script reports names and classifications, but no values or digests.

Exit 0 means the lists and their digests match. Exit 1 means names or digests differ. Exit 2 means the comparison failed; correct the error and run it again before you upgrade.

Review each difference and record the action or the reason to accept it:

| Group | Action before the upgrade |
|---|---|
| GraphQL-only name | Treat the name as stale. The new build will not see it at launch. If it is no longer needed, remove it with the script's suggested `fly secrets unset <name> -a <sessions app>` command. If it is still needed, set it through the project's Secrets panel at `/admin` and compare again to confirm that the Machines API holds it. |
| Machines-API-only project name | Confirm the team prefix and the project that must receive it. Keep it if that project needs it. Otherwise, remove it directly through the Machines API with the command below, then compare again to confirm it is absent before you upgrade. The new build will see any name left in this store at launch. |
| Machines-API-only global name | Decide if every session machine may receive it. In process-level mode, a global name passes to every implementation, planning and gap-fill machine. If that access is intended, record and accept the difference. Otherwise, remove the global name directly through the Machines API with the command below, then compare again to confirm it is absent before you upgrade. If one project needs it, set a project secret instead and compare again. |
| Protection key | Take no action. Ordinary launch skips this key. Do not remove or replace it to make the lists match. |
| Name in both lists with different digests | Confirm which stored version is intended with the secret owner. After the upgrade, launch uses the Machines API store. Resolve the difference or record why you accept it. |

To remove an unwanted Machines-API-only name, replace `<sessions app>` and `<name>` with the app and exact secret name reported by the comparison. This uses the same DELETE endpoint as `unsetAppSecret` in `src/fly-machines.ts`; it works before the upgrade, when the Secrets panel still lists names through GraphQL. Never use it for the protection key.

```bash
curl --fail --silent --show-error --output /dev/null \
  --request DELETE \
  --header "Authorization: Bearer ${FLY_SESSIONS_TOKEN}" \
  'https://api.machines.dev/v1/apps/<sessions app>/secrets/<name>'
```

Run the comparison again for that app with the same `--prefixes`. Confirm the removed name is absent from the Machines API list before upgrading; review any remaining differences as above. A successful DELETE alone is not the verification.

On 2026-11-13, `ai-implement-testing-sessions` was compared. Its only REST-only (Machines-API-only) name was the protection key. This observation does not replace a comparison of your deployment.

## The upgrade

Use the existing [deploy paths](deployment.md#deploy-paths) to deploy a build that contains `654e9470`.

## After the upgrade

1. Read `sourceCommit` from `GET /` again. Confirm that the ancestry command above exits 0.
2. Run the compare script again for each sessions app, with the same team prefixes. Expect exit 0, or only the differences that you recorded and accepted. Accepted differences still produce exit 1. Exit 2 is a failed check.
3. Call [`get_fly_setup`](mcp-server.md#get_fly_setup) with `{ "args": {} }` as an admin or a service identity with the secrets grant. Confirm the expected app, `configured: true`, `reachable: true`, and the expected names in each group. This check proves that Fly permits secret listing; it does not prove that a machine can launch. You can also check the project's Secrets panel at `/admin` for its expected names.

## If a machine is removed before it starts

Follow the [machine-removal runbook](deployment.md#per-project-secrets-fly), starting with the `fly machine status` instructions.

## Rollback

Use the [deploy paths](deployment.md#deploy-paths) to downgrade to the previous build. A build older than `654e9470` reads GraphQL again. A name set through the Machines API after the upgrade is not in GraphQL merely because it is in the Machines API store. Before you downgrade, compare the lists and confirm that GraphQL has the names and stored versions that the old build needs. The downgrade does not copy secrets between stores or undo removals.
