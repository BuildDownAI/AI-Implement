/**
 * The `ReviewFixAttempt` workflow's definition type, for the SDK's typed ingress client.
 * `import type` only, so the delivery client shares it without a runtime import of the workflow.
 */
import type { createReviewFixAttempt } from "./review-fix-attempt.js";

export type ReviewFixAttemptDefinition = ReturnType<typeof createReviewFixAttempt>;
