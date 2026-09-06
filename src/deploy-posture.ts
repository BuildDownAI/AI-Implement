import { getDeployPolicy } from "./deploy-policy.js";
import { readStampedTarget, resolveDeployTarget, getAvailability } from "./deploy-availability.js";
import { isDeployHeld } from "./deploy-hold.js";
import { getInFlightWork } from "./in-flight-work.js";
import { getDeployOutcome } from "./deploy-notify.js";
import { resolveDefaultRunnerImage, stripImageTag, resolveChannelCommit } from "./repo-image.js";

export interface RunnerChannelPosture {
  image: string | null;
  channelTag: string | null;
  channelCommit: string | null;
  matchesHead: boolean | null;
}

export interface DeployPosture {
  autoDeploy: boolean;
  watchedRepo: string | null;
  watchedRef: string | null;
  runningCommit: string | null;
  headCommit: string | null;
  upToDate: boolean | null;
  deploy: {
    held: boolean;
    inFlight: boolean;
    lastOutcome: string | null;
  };
  runnerChannel: RunnerChannelPosture;
  mergeCost: "deploy+image" | "image" | "none";
}

/**
 * Maps watched branch names to their runner build channel tags.
 *
 * Intentionally hardcoded to this orchestrator's own build branches: `main`
 * builds the `:latest` runner image and `testing` builds `:next`. This is the
 * correct scope since `get_deploy_posture` reports this orchestrator's own
 * posture, not a target repo's.
 */
export function channelTagForRef(watchedRef: string | null): string | null {
  if (watchedRef === "testing") return "next";
  if (watchedRef === "main") return "latest";
  return null;
}

/**
 * Derives the landing cost for a merge to the watched branch.
 * autoDeploy dominates: when it is on every merge triggers a deploy and a runner
 * image build. When off, only the branches that have a corresponding runner build
 * schedule contribute an image build; everything else is a no-op.
 */
export function deriveMergeCost(
  autoDeploy: boolean,
  watchedRef: string | null,
): "deploy+image" | "image" | "none" {
  if (autoDeploy) return "deploy+image";
  if (watchedRef === "main" || watchedRef === "testing") return "image";
  return "none";
}

export async function getDeployPosture(opts?: {
  fetchImpl?: typeof fetch;
  /** Pre-resolved default runner image from boot config. When provided, avoids
   *  re-reading process.env; falls back to resolveDefaultRunnerImage(process.env)
   *  when absent (test paths that don't inject opts). */
  defaultImage?: string;
}): Promise<DeployPosture> {
  const policy = getDeployPolicy();
  const stamped = readStampedTarget(process.env);
  const target = resolveDeployTarget(stamped, policy);

  const availability = getAvailability();
  const runningCommit = availability?.runningCommit ?? null;
  const headCommit = availability?.headCommit ?? null;
  const upToDate: boolean | null =
    runningCommit !== null && headCommit !== null ? runningCommit === headCommit : null;

  const held = isDeployHeld();
  const inFlight = getInFlightWork().some((w) => w.kind === "runner-job" && w.count > 0);
  const outcome = getDeployOutcome();

  const watchedRef = target?.branch ?? null;
  const watchedRepo = target ? `${target.owner}/${target.repo}` : null;
  const channelTag = channelTagForRef(watchedRef);

  const rawImage = opts?.defaultImage ?? resolveDefaultRunnerImage(process.env).image;
  const imageBase = stripImageTag(rawImage);

  let channelCommit: string | null = null;
  let matchesHead: boolean | null = null;

  if (imageBase !== null && channelTag !== null) {
    try {
      channelCommit = await resolveChannelCommit(imageBase, channelTag, opts?.fetchImpl);
    } catch {
      // resolveChannelCommit is best-effort; any unexpected throw yields null
    }
    if (channelCommit !== null && headCommit !== null) {
      matchesHead = channelCommit === headCommit;
    }
  }

  return {
    autoDeploy: policy.autoDeploy,
    watchedRepo,
    watchedRef,
    runningCommit,
    headCommit,
    upToDate,
    deploy: {
      held,
      inFlight,
      lastOutcome: outcome?.kind ?? null,
    },
    runnerChannel: {
      image: imageBase,
      channelTag,
      channelCommit,
      matchesHead,
    },
    mergeCost: deriveMergeCost(policy.autoDeploy, watchedRef),
  };
}
