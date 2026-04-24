import { request as httpsRequest } from "node:https";
import type { ClientRequest, IncomingMessage } from "node:http";
import type { PipelineContext, StepModule, StepReporter } from "../types.js";

interface PostToLinearInputs extends Record<string, unknown> {
  analysisMarkdown: string;
  testPlanMarkdown: string;
  workUnitsMarkdown: string;
  crossStoryMarkdown: string;
}

interface PostToLinearOutputs extends Record<string, unknown> {
  commentCount: number;
}

/** Minimal type for the `https.request` function, for injection in tests. */
export type HttpRequestFn = (
  url: string,
  options: Record<string, unknown>,
  callback: (res: IncomingMessage) => void,
) => ClientRequest;

const LINEAR_GRAPHQL_URL = "https://api.linear.app/graphql";
const POST_COMMENT_RETRY_ATTEMPTS = 3;
const POST_COMMENT_RETRY_DELAY_MS = 500;

const CREATE_COMMENT_MUTATION = `
  mutation($id: String!, $body: String!) {
    commentCreate(input: { issueId: $id, body: $body }) {
      success
    }
  }
`.trim();

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function postCommentOnce(
  issueId: string,
  apiKey: string,
  body: string,
  requestFn: HttpRequestFn,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify({
      query: CREATE_COMMENT_MUTATION,
      variables: { id: issueId, body },
    });

    const req = requestFn(
      LINEAR_GRAPHQL_URL,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: apiKey,
          "Content-Length": Buffer.byteLength(payload),
        },
      },
      (res) => {
        let data = "";
        res.on("data", (chunk: Buffer) => { data += chunk.toString(); });
        res.on("end", () => {
          if (res.statusCode && res.statusCode >= 400) {
            reject(new Error(`Linear API error ${res.statusCode}: ${data}`));
            return;
          }
          try {
            const parsed = JSON.parse(data) as { errors?: { message: string }[] };
            if (parsed.errors?.length) {
              reject(new Error(`Linear GraphQL error: ${parsed.errors[0].message}`));
              return;
            }
          } catch {
            // non-JSON response is unexpected but not necessarily fatal
          }
          resolve();
        });
      },
    );

    req.on("error", reject);
    req.setTimeout(30_000, () => {
      req.destroy(new Error("Linear API request timed out"));
    });
    req.write(payload);
    req.end();
  });
}

async function postComment(
  issueId: string,
  apiKey: string,
  body: string,
  requestFn: HttpRequestFn,
): Promise<void> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= POST_COMMENT_RETRY_ATTEMPTS; attempt++) {
    try {
      await postCommentOnce(issueId, apiKey, body, requestFn);
      return;
    } catch (err) {
      lastError = err;
      if (attempt < POST_COMMENT_RETRY_ATTEMPTS) {
        await sleep(POST_COMMENT_RETRY_DELAY_MS * attempt);
      }
    }
  }
  throw lastError;
}

/**
 * Creates a postToLinearStep with an injectable HTTP request function.
 * Production code uses the default (https.request). Tests inject a mock.
 */
export function createPostToLinearStep(
  requestFn: HttpRequestFn = httpsRequest as unknown as HttpRequestFn,
): StepModule<PostToLinearInputs, PostToLinearOutputs> {
  return {
    async run(
      context: PipelineContext,
      inputs: PostToLinearInputs,
      _reporter: StepReporter,
    ): Promise<PostToLinearOutputs> {
      const { analysisMarkdown, testPlanMarkdown, workUnitsMarkdown, crossStoryMarkdown } = inputs;
      const { issueId } = context.data;

      if (!analysisMarkdown) {
        throw new Error("post-to-linear: analysisMarkdown is required but was empty or missing");
      }
      if (!testPlanMarkdown) {
        throw new Error("post-to-linear: testPlanMarkdown is required but was empty or missing");
      }
      if (!workUnitsMarkdown) {
        throw new Error("post-to-linear: workUnitsMarkdown is required but was empty or missing");
      }

      const apiKey = process.env.LINEAR_API_KEY;
      if (!apiKey) {
        throw new Error("LINEAR_API_KEY environment variable is required for post-to-linear step");
      }

      const comments = [analysisMarkdown, testPlanMarkdown, workUnitsMarkdown];
      if (crossStoryMarkdown) {
        comments.push(crossStoryMarkdown);
      }

      for (const body of comments) {
        await postComment(issueId, apiKey, body, requestFn);
      }

      return { commentCount: comments.length };
    },
  };
}

export const postToLinearStep = createPostToLinearStep();

