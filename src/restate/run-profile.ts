/**
 * The run-profile contract (AII-1244). Every per-pipeline runner-settings object, one per backend, meets it:
 *
 * - `get` (shared) returns `{ config, source }`, or null for a pipeline with neither a stored profile nor a default.
 * - `set` (exclusive, ingressPrivate) takes a strict partial patch, merges it over the stored profile or the default,
 *   validates the result, and answers 400 on a bad field; it returns the new view.
 * - `seed` (exclusive) takes a complete config and writes it only when nothing is stored.
 *
 * `FlyMachineProfile` and `GhaRunProfile` are the two implementations; the tools service routes by backend.
 */
import { FlyMachineProfile } from "./fly-machine-profile.js";
import { GhaRunProfile } from "./gha-run-profile.js";

export interface RunProfileView<C> {
  config: C;
  source: "profile" | "default";
}

/** The backends that have a run profile (`local-docker` has none). */
export type RunProfileBackend = "fly-machines" | "github-actions";

export const RUN_PROFILE_BACKENDS: readonly RunProfileBackend[] = ["fly-machines", "github-actions"];

/** The handlers every run-profile object has. */
export const RUN_PROFILE_HANDLERS = ["get", "set", "seed"] as const;

/** Backend to the Virtual Object that holds its profile. */
export const RUN_PROFILE_OBJECTS = {
  "fly-machines": FlyMachineProfile,
  "github-actions": GhaRunProfile,
} as const;

export function isRunProfileBackend(value: string): value is RunProfileBackend {
  return (RUN_PROFILE_BACKENDS as readonly string[]).includes(value);
}
