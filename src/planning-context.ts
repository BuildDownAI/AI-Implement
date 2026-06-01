import type { TicketIssue } from "./providers/types.js";

export interface PlanningContextInputs {
  parent: string;
  siblings: string;
  dependencies: string;
}

interface PlanningContextParams {
  issue: TicketIssue;
  linearApiKey: string | null;
  ticketingProviderId: string;
  fetchImpl?: typeof fetch;
}

const NONE_CONTEXT: PlanningContextInputs = {
  parent: "None",
  siblings: "None",
  dependencies: "None",
};

function toContextValue(lines: string[]): string {
  return lines.length > 0 ? lines.join("\n") : "None";
}

export async function buildPlanningContextInputs(params: PlanningContextParams): Promise<PlanningContextInputs> {
  if (params.ticketingProviderId !== "linear" || !params.linearApiKey) {
    return NONE_CONTEXT;
  }

  const fetchImpl = params.fetchImpl ?? fetch;
  const query = `
    query($id: String!) {
      issue(id: $id) {
        parent {
          id
          identifier
          title
          children(first: 50) {
            nodes { id identifier title }
          }
        }
        relations(first: 50) {
          nodes {
            type
            relatedIssue { identifier title }
          }
        }
      }
    }
  `;

  try {
    const response = await fetchImpl("https://api.linear.app/graphql", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: params.linearApiKey,
      },
      body: JSON.stringify({
        query,
        variables: { id: params.issue.id },
      }),
    });

    if (!response.ok) {
      throw new Error(`Linear HTTP ${response.status}`);
    }

    const payload = (await response.json()) as {
      data?: {
        issue?: {
          parent?: {
            id: string;
            identifier: string;
            title: string;
            children?: {
              nodes?: Array<{ id: string; identifier: string; title: string }>;
            };
          } | null;
          relations?: {
            nodes?: Array<{
              type: string;
              relatedIssue?: { identifier: string; title: string } | null;
            }>;
          };
        } | null;
      };
    };

    const linearIssue = payload.data?.issue;
    const parentNode = linearIssue?.parent ?? null;
    const parent = parentNode
      ? `- ${parentNode.identifier}: ${parentNode.title}`
      : "None";

    const siblings = toContextValue(
      (parentNode?.children?.nodes ?? [])
        .filter((child) => child.id !== params.issue.id)
        .map((child) => `- ${child.identifier}: ${child.title}`),
    );

    const dependencies = toContextValue(
      (linearIssue?.relations?.nodes ?? [])
        .filter((node) => node.relatedIssue)
        .map((node) => `- [${node.type}] ${node.relatedIssue!.identifier}: ${node.relatedIssue!.title}`),
    );

    return { parent, siblings, dependencies };
  } catch (error) {
    console.warn(`[poll] Failed to fetch Linear planning context for ${params.issue.identifier}; using None defaults:`, error);
    return NONE_CONTEXT;
  }
}
