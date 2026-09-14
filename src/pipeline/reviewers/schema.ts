import type { ReviewerOutputSchema } from "./registry.js";

export const REVIEWER_VERDICT_SCHEMA: ReviewerOutputSchema = {
  type: "object",
  additionalProperties: false,
  required: ["approved", "findings"],
  properties: {
    approved: { type: "boolean" },
    findings: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["severity", "body"],
        properties: {
          severity: { type: "string", enum: ["blocking", "medium", "minor"] },
          body: { type: "string", description: "Self-contained reviewer finding." },
          path: { type: "string" },
          line: { type: "number" },
        },
      },
    },
    summary: {
      type: "string",
      minLength: 1,
      description: "Concise human-readable review summary. Informational only; actionable blockers must be in findings[].",
    },
    checks: {
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
    },
  },
};

export const BUILTIN_REVIEWER_VERDICT_SCHEMA: ReviewerOutputSchema = {
  ...REVIEWER_VERDICT_SCHEMA,
  required: ["approved", "findings", "summary", "checks"],
};
