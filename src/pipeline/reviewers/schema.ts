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
  },
};
