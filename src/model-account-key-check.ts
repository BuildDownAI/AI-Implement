import type { AccountProfileProjection } from "./agent-config-store.js";
import type { CredentialFailureCode, CredentialRequest, CredentialResolution } from "./model-credentials.js";

const OPENROUTER_HOST = "https://openrouter.ai";
const OPENROUTER_KEY_PATH = "/api/v1/key";

type Unchecked = "not-checked";
export interface ModelAccountKeyCheckResult {
  profileId: string;
  profile: Unchecked | "not-found" | "disabled" | "unsupported-auth-mode" | "ok";
  credential: Unchecked | "set" | CredentialFailureCode;
  binding: Unchecked | "ok" | "missing" | "mismatch";
  provider: Unchecked | "pass" | "fail (no answer)" | `fail (key refused, status ${number})` | `fail (status ${number})`;
}

export interface ModelAccountKeyCheckDeps {
  readProfile(profileId: string): AccountProfileProjection | null;
  /** Reads the binding for the selected revision's private credential reference. */
  readBinding(profileId: string, revision: number): { destination: string } | undefined;
  resolveCredential(request: CredentialRequest): CredentialResolution;
  fetch: typeof fetch;
}

/** Run inside one durable step: no secret-bearing intermediate value may be journaled. */
export async function checkModelAccountKey(profileId: string, deps: ModelAccountKeyCheckDeps): Promise<ModelAccountKeyCheckResult> {
  const result: ModelAccountKeyCheckResult = {
    profileId, profile: "not-checked", credential: "not-checked", binding: "not-checked", provider: "not-checked",
  };
  // Storage failures have no state in the protocol. Never expose their exception text.
  try {
    const profile = deps.readProfile(profileId);
    if (!profile) return { ...result, profile: "not-found" };
    if (profile.status !== "active") return { ...result, profile: "disabled" };
    if (profile.provider !== "openrouter" || profile.authMode !== "openrouter-api-key") {
      return { ...result, profile: "unsupported-auth-mode" };
    }
    result.profile = "ok";
    const binding = deps.readBinding(profileId, profile.revision);
    result.binding = !binding ? "missing" : binding.destination === "openrouter/openrouter-api-key" ? "ok" : "mismatch";
    if (result.binding === "mismatch") return result;
    const credential = deps.resolveCredential({ profileId, revision: profile.revision, provider: "openrouter", authMode: "openrouter-api-key" });
    if (!credential.ok) return { ...result, credential: credential.code };
    if (credential.secret.kind !== "api-key") return { ...result, credential: "secret_invalid" };
    result.credential = "set";
    try {
      const response = await deps.fetch(OPENROUTER_HOST + OPENROUTER_KEY_PATH, {
        method: "GET", headers: { Authorization: `Bearer ${credential.secret.apiKey}` },
        redirect: "manual", signal: AbortSignal.timeout(20_000),
      });
      result.provider = response.ok ? "pass"
        : response.status === 401 || response.status === 403 ? `fail (key refused, status ${response.status})`
        : `fail (status ${response.status})`;
    } catch {
      result.provider = "fail (no answer)";
    }
    return result;
  } catch {
    throw new Error("could not check the model account key");
  }
}
