import type { PipelineContext, StepModule, StepReporter } from "../types.js";
import { resolveProvider, providerConfigFromEnv } from "../../providers/index.js";

interface PostToTicketingInputs extends Record<string, unknown> {
  analysisMarkdown: string;
  testPlanMarkdown: string;
  workUnitsMarkdown: string;
  crossStoryMarkdown: string;
}

interface PostToTicketingOutputs extends Record<string, unknown> {
  commentCount: number;
}

export const postToTicketingStep: StepModule<PostToTicketingInputs, PostToTicketingOutputs> = {
  async run(
    context: PipelineContext,
    inputs: PostToTicketingInputs,
    _reporter: StepReporter,
  ): Promise<PostToTicketingOutputs> {
    const { analysisMarkdown, testPlanMarkdown, workUnitsMarkdown, crossStoryMarkdown } = inputs;
    const { issueId, ticketingProvider } = context.data;

    if (!analysisMarkdown) throw new Error("post-to-ticketing: analysisMarkdown is required");
    if (!testPlanMarkdown) throw new Error("post-to-ticketing: testPlanMarkdown is required");
    if (!workUnitsMarkdown) throw new Error("post-to-ticketing: workUnitsMarkdown is required");

    const provider = await resolveProvider(ticketingProvider, providerConfigFromEnv());

    const comments = [analysisMarkdown, testPlanMarkdown, workUnitsMarkdown];
    if (crossStoryMarkdown) comments.push(crossStoryMarkdown);

    for (const body of comments) {
      await provider.postComment(issueId, body);
    }

    return { commentCount: comments.length };
  },
};

export default postToTicketingStep;
