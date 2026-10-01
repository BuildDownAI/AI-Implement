import { parse } from "yaml";

/**
 * Exact per-workflow `workflow_dispatch` input contract (ADR 032, AII-680).
 * A new input needs an entry here with a reason and an ADR update; a count check alone
 * would let one input be swapped for another. KG refresh and gap-analysis dispatch
 * through the implementation template, so they have no list of their own.
 */
export const INPUT_CONTRACT = {
  implement: {
    canonical: "workflows/claude-implement.yml",
    synced: ".github/workflows/claude-implement.yml",
    inputs: {
      run_config: "Transport for the envelope",
      issue_identifier: "run-name: is evaluated before any step; carries no credential",
      run_attempt_token: "run-name: attempt marker for correlation; an identifier, not an authorization",
      runner_image: "Resolved before bootstrap by validate-runner-image",
      job_timeout_minutes: "timeout-minutes is evaluated before bootstrap",
      provider: "Retained: provider setup runs after bootstrap, deployed readers and providerDispatchFields still consume it; no model credential rides with it",
      aws_region: "Retained: Bedrock region setup runs after bootstrap, deployed readers still consume it; nonsecret",
      run_token: "Legacy-template compatibility only; blank on the private transport (credentials.resultToken)",
      run_progress_token: "Legacy-template compatibility only; absent on the private transport (credentials.progressToken)",
      run_publication_token: "Legacy-template compatibility only; absent on the private transport (credentials.publicationToken)",
    },
  },
  plan: {
    canonical: "workflows/claude-plan.yml",
    synced: ".github/workflows/claude-plan.yml",
    inputs: {
      run_config: "Transport for the envelope",
      issue_identifier: "run-name: is evaluated before any step; carries no credential",
      runner_image: "Resolved before bootstrap by validate-runner-image",
      job_timeout_minutes: "timeout-minutes is evaluated before bootstrap",
      provider: "Retained: provider setup runs after bootstrap, deployed readers still consume it; nonsecret",
      aws_region: "Retained: Bedrock region setup runs after bootstrap, deployed readers still consume it; nonsecret",
      run_token: "Legacy-template compatibility only; blank on the private transport",
      run_progress_token: "Legacy-template compatibility only; absent on the private transport",
    },
  },
} as const;

export type WorkflowKey = keyof typeof INPUT_CONTRACT;

export function declaredInputs(yaml: string): string[] {
  return Object.keys((parse(yaml) as any)?.on?.workflow_dispatch?.inputs ?? {});
}

/** Returns one violation per input that is not allowed, missing, or out of order. */
export function checkInputs(key: WorkflowKey, yaml: string): string[] {
  const expected = Object.keys(INPUT_CONTRACT[key].inputs);
  const actual = declaredInputs(yaml);
  const out: string[] = [];
  for (const name of actual) if (!expected.includes(name)) out.push(`unauthorized input "${name}" in ${key} (add to ADR 032 and INPUT_CONTRACT with a reason)`);
  for (const name of expected) if (!actual.includes(name)) out.push(`missing input "${name}" in ${key}`);
  if (out.length === 0 && actual.join() !== expected.join()) out.push(`input order differs in ${key}`);
  return out;
}

/**
 * Receiving audience for the encoded envelope: job -> step name -> env keys. Only the bootstrap
 * mask step reads it from the event file (no env), so the audience is the steps that decode it
 * for validation / the selected diagnostic projection, and the trusted runner step.
 */
export const ENVELOPE_AUDIENCE: Record<WorkflowKey, Record<string, Record<string, string[]>>> = {
  implement: {
    implement: {
      "Validate attempt correlation": ["RUN_CONFIG"],
      "Print dispatch inputs": ["RUN_CONFIG"],
      "Run pipeline": ["AI_IMPLEMENT_RUN_CONFIG"],
    },
  },
  plan: {
    plan: {
      "Print dispatch inputs": ["RUN_CONFIG"],
      "Run planning": ["AI_IMPLEMENT_RUN_CONFIG"],
    },
  },
};

const ENVELOPE_REF = /\binputs\s*(\.\s*run_config\b|\[\s*['"]run_config['"]\s*\])|github\.event\.inputs\b/;
const PAYLOAD_DUMP = /toJSON\(\s*(inputs|github\.event|github)\b/;
const RAW_TOKEN_INPUT = /inputs\.run_(token|progress_token|publication_token)\s*\}\}/;

/** Flags steps that could print or forward the encoded envelope or a decoded credential. */
export function checkDiagnostics(yaml: string, key: WorkflowKey): string[] {
  const doc = parse(yaml) as any;
  const out: string[] = [];
  const audience = ENVELOPE_AUDIENCE[key];

  // Workflow- and job-level env reach every step in scope, so they may never carry the envelope.
  const scoped = (label: string, env: Record<string, unknown> | undefined) => {
    for (const [k, v] of Object.entries(env ?? {})) {
      const val = String(v);
      if (ENVELOPE_REF.test(val)) out.push(`${label}: forwards the envelope to every step as ${k}`);
      if (PAYLOAD_DUMP.test(val)) out.push(`${label}: serializes the dispatch payload`);
      if (RAW_TOKEN_INPUT.test(val) && !/!=\s*''/.test(val)) out.push(`${label}: forwards raw runner token input via ${k}`);
    }
  };
  scoped("workflow env", doc.env);

  for (const [jobName, job] of Object.entries<any>(doc.jobs ?? {})) {
    scoped(`${jobName} job env`, job.env);
    for (const step of job.steps ?? []) {
      const label = `${jobName}/${step.name ?? "(unnamed)"}`;
      const run: string = step.run ?? "";
      const env = step.env ?? {};
      for (const line of run.split("\n")) {
        const l = line.trim();
        if (l.startsWith("#")) continue;
        if (/\b(echo|printf)\b[^|\n]*\$\{?(AI_IMPLEMENT_)?RUN_CONFIG\b/.test(l) && !/\|\s*base64\b/.test(l)) {
          out.push(`${label}: prints the raw envelope`);
        }
        if (/\bjq\s+(-\w+\s+)*'?\.'?\s*(2>|$|\|)/.test(l)) out.push(`${label}: unfiltered jq dump`);
        if (/\bset\s+-\w*x/.test(l) || /\bxtrace\b/.test(l)) out.push(`${label}: shell tracing enabled`);
        if (/\b(echo|printf)\b[^\n]*\$\{?(CREDENTIALS|RESULT_TOKEN|PROGRESS_TOKEN|PUBLICATION_TOKEN|RUN_TOKEN)\b/.test(l)) out.push(`${label}: prints a credential value`);
      }
      const sinks: Array<[string, string]> = [
        ...Object.entries<unknown>(env).map(([k, v]) => [k, String(v)] as [string, string]),
        ...Object.entries<unknown>(step.with ?? {}).map(([k, v]) => [`with.${k}`, String(v)] as [string, string]),
      ];
      if (PAYLOAD_DUMP.test(run) || sinks.some(([, v]) => PAYLOAD_DUMP.test(v))) out.push(`${label}: serializes the dispatch payload`);
      if (ENVELOPE_REF.test(run)) out.push(`${label}: interpolates the envelope into the script`);
      // Only the receiving job/step/key triples in ENVELOPE_AUDIENCE may receive the encoded envelope.
      for (const [k, v] of sinks) {
        if (!ENVELOPE_REF.test(v)) continue;
        const allowed = audience[jobName]?.[step.name ?? ""] ?? [];
        if (!allowed.includes(k)) out.push(`${label}: forwards the envelope as ${k} (not a trusted receiving step/key)`);
      }
      for (const [k, v] of sinks) {
        if (RAW_TOKEN_INPUT.test(v) && !/!=\s*''/.test(v)) out.push(`${label}: forwards raw runner token input via ${k}`);
      }
    }
  }
  return out;
}

export function checkCopyDrift(canonical: string, synced: string): string[] {
  return canonical === synced ? [] : ["synced copy differs from canonical template"];
}

