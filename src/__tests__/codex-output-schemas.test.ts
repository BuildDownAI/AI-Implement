import { describe, expect, it } from "vitest";
import { REVIEW_VERDICT_JSON_SCHEMA } from "../pipeline/review-verdict.js";
import { BUILTIN_REVIEWER_VERDICT_SCHEMA, REVIEWER_VERDICT_SCHEMA } from "../pipeline/reviewers/schema.js";
import codeReviewReviewer from "../pipeline/reviewers/code-review.js";
import gapAnalysisReviewer from "../pipeline/reviewers/gap-analysis.js";

/**
 * Every schema passed as `jsonSchema` reaches `codex exec --output-schema`, which sends it to OpenAI
 * structured outputs in strict mode. Strict mode rejects the whole request (HTTP 400
 * `invalid_json_schema`) unless every object closes `additionalProperties` and lists every property
 * in `required`; an optional field must be required and nullable instead.
 */
function strictModeViolations(schema: unknown, path = "$", out: string[] = []): string[] {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) return out;
  const node = schema as Record<string, unknown>;
  const properties = node.properties as Record<string, unknown> | undefined;
  if (properties) {
    if (node.additionalProperties !== false) out.push(`${path}: additionalProperties must be false`);
    const required = new Set(Array.isArray(node.required) ? node.required : []);
    const missing = Object.keys(properties).filter((key) => !required.has(key));
    if (missing.length) out.push(`${path}: required must include ${missing.join(", ")}`);
    for (const [key, child] of Object.entries(properties)) strictModeViolations(child, `${path}.${key}`, out);
  }
  if (node.items) strictModeViolations(node.items, `${path}[]`, out);
  for (const branch of Array.isArray(node.anyOf) ? node.anyOf : []) strictModeViolations(branch, `${path}|`, out);
  return out;
}

describe("Codex output schemas satisfy OpenAI strict mode", () => {
  const schemas: Record<string, unknown> = {
    REVIEW_VERDICT_JSON_SCHEMA,
    REVIEWER_VERDICT_SCHEMA,
    BUILTIN_REVIEWER_VERDICT_SCHEMA,
    [`reviewer:${codeReviewReviewer.id}`]: codeReviewReviewer.outputSchema,
    [`reviewer:${gapAnalysisReviewer.id}`]: gapAnalysisReviewer.outputSchema,
  };

  for (const [name, schema] of Object.entries(schemas)) {
    it(`${name} requires every property and closes every object`, () => {
      expect(strictModeViolations(schema)).toEqual([]);
    });
  }

  it("flags an optional property, the shape that failed the live Codex review", () => {
    expect(strictModeViolations({
      type: "object",
      additionalProperties: false,
      required: ["title"],
      properties: { title: { type: "string" }, location: { type: "string" } },
    })).toEqual(["$: required must include location"]);
  });
});
