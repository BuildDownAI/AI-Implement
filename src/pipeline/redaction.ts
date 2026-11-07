import { envSecrets } from "./failure-classification.js";
import {
  GITHUB_WRITE_CREDENTIAL_KEYS,
  INSTALL_CREDENTIAL_KEYS,
  MODEL_CREDENTIAL_KEYS,
  RUNNER_CREDENTIAL_KEYS,
  parseForwardedSecrets,
} from "./process-env.js";

/**
 * Every secret value to redact from text that leaves the runner (hook output reaches the
 * implement prompt, the PR body and the ticket comment): the values of the forwarded-secret
 * keys, the install, GitHub-write, runner and model credential keys, plus `envSecrets()`'
 * suffix-matched values. Unlike `envSecrets()`, a named key is redacted whatever its length
 * or suffix, because forwarded names such as `DB_PASS` match no suffix.
 */
export function redactionSecrets(): string[] {
  const keys = [
    ...parseForwardedSecrets(),
    ...INSTALL_CREDENTIAL_KEYS,
    ...GITHUB_WRITE_CREDENTIAL_KEYS,
    ...RUNNER_CREDENTIAL_KEYS,
    ...MODEL_CREDENTIAL_KEYS,
  ];
  const named = keys
    .map((key) => process.env[key])
    .filter((value): value is string => typeof value === "string" && value.length > 0);
  return [...new Set([...named, ...envSecrets()])];
}
