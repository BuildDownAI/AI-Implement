import type { ReviewerOutputSchema } from "./registry.js";

const SUMMARY_PROPERTY = {
  type: "string",
  minLength: 1,
  description: "Concise human-readable review summary. Informational only; actionable blockers must be in findings[].",
};

const CHECKS_PROPERTY = {
  type: "array",
  minItems: 1,
  items: {
    type: "object",
    additionalProperties: false,
    required: ["check", "result", "evidence"],
    properties: {
      check: { type: "string", minLength: 1, description: "Concrete behavior, requirement, or risk inspected." },
      result: { type: "string", enum: ["passed", "failed", "not_verified", "not_applicable"] },
      evidence: { type: "string", minLength: 1, description: "Specific files, symbols, diff hunks, or commands inspected; say when evidence is limited." },
    },
  },
};

/**
 * Codex sends these schemas to OpenAI strict mode, which rejects any property missing from
 * `required`. An optional field is therefore required and nullable here, and the step's
 * parser treats null as absent. A field that is required and not nullable must be reported.
 */
export const REVIEWER_VERDICT_SCHEMA: ReviewerOutputSchema = {
  type: "object",
  additionalProperties: false,
  required: ["approved", "findings", "summary", "checks"],
  properties: {
    approved: { type: "boolean" },
    findings: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["severity", "body", "path", "line"],
        properties: {
          severity: { type: "string", enum: ["blocking", "medium", "minor"] },
          body: { type: "string", description: "Self-contained reviewer finding." },
          path: { type: ["string", "null"], description: "File the finding is in, or null." },
          line: { type: ["number", "null"], description: "Line the finding is on, or null." },
        },
      },
    },
    summary: { ...SUMMARY_PROPERTY, type: ["string", "null"] },
    checks: { ...CHECKS_PROPERTY, type: ["array", "null"] },
  },
};

/** Built-in reviewers must report a summary and checks, so neither is nullable. */
export const BUILTIN_REVIEWER_VERDICT_SCHEMA: ReviewerOutputSchema = {
  ...REVIEWER_VERDICT_SCHEMA,
  properties: {
    ...(REVIEWER_VERDICT_SCHEMA.properties as Record<string, unknown>),
    summary: SUMMARY_PROPERTY,
    checks: CHECKS_PROPERTY,
  },
};
