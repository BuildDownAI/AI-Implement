import type { Step } from "./types.js";

const CREDENTIAL_KEYS = new Set(["githubToken", "machineNonce"]);
const CREDENTIAL_SUFFIXES = ["Token", "Secret", "Nonce"];

function isCredentialKey(key: string): boolean {
  return CREDENTIAL_KEYS.has(key) || CREDENTIAL_SUFFIXES.some((suffix) => key.endsWith(suffix));
}

function redactValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactValue);
  if (value !== null && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
    return redactRecord(value as Record<string, unknown>);
  }
  return value;
}

function redactRecord(record: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    if (isCredentialKey(key)) continue;
    out[key] = redactValue(value);
  }
  return out;
}

/**
 * Returns a copy of `step` whose `inputs` and `outputs` carry no credential: the keys `githubToken` and
 * `machineNonce`, and any key ending in `Token`, `Secret` or `Nonce`, are removed (nested plain objects
 * included). Everything else is kept as plain JSON. Runs in the runner's reporter and again in the
 * orchestrator's callback, before the step reaches the Restate ingress, which journals request bodies.
 */
export function redactStepCredentials(step: Step): Step {
  const out = { ...step };
  if (step.inputs && typeof step.inputs === "object") out.inputs = redactRecord(step.inputs);
  if (step.outputs && typeof step.outputs === "object") out.outputs = redactRecord(step.outputs);
  return out;
}
