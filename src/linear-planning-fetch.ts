import { withLinearToken } from "./linear-app-auth.js";
import { assemblePlanningContext } from "./planning-context-assembly.js";

export interface PlanningFetchParams {
  issueId: string;
  maxPages?: number;
  capBytes?: number;
  fetchImpl?: typeof fetch;
}

const PREFIXES = [
  "## 🏗️ AI Planning: Architecture Analysis",
  "## 🧪 AI Planning: Test Plan",
  "## 🔗 AI Planning: Cross-Story Context",
  "## 🗺 AI Planning: Implementation Map",
  "## ✅ AI Planning: Acceptance Bar",
  "## ⚠️ AI Planning: Risks & Open Questions",
];


export async function fetchPlanningContext(params: PlanningFetchParams): Promise<string> {
  const fetchImpl = params.fetchImpl ?? fetch;
  const maxPages = params.maxPages ?? 3;
  const capBytes = params.capBytes ?? 40000;
  const comments: { body: string; createdAt: string }[] = [];
  let after: string | null = null;

  try {
    for (let p = 0; p < maxPages; p++) {
      const query = `query($id:String!,$after:String){issue(id:$id){comments(first:100,after:$after,orderBy:createdAt){nodes{body createdAt}pageInfo{hasNextPage endCursor}}}}`;
      const resp = await withLinearToken((token) =>
        fetchImpl("https://api.linear.app/graphql", {
          method: "POST",
          headers: { "Content-Type": "application/json", "Authorization": `Bearer ${token}` },
          body: JSON.stringify({ query, variables: { id: params.issueId, after } }),
        }),
      );
      if (!resp.ok) throw new Error(`Linear HTTP ${resp.status}`);
      const data: any = await resp.json();
      const nodes = data?.data?.issue?.comments?.nodes ?? [];
      comments.push(...nodes);
      const pi = data?.data?.issue?.comments?.pageInfo;
      if (!pi?.hasNextPage || !pi.endCursor) break;
      after = pi.endCursor;
    }
  } catch (err) {
    console.warn(`Failed to fetch planning context: ${err}`);
    return "";
  }

  return assemblePlanningContext(comments, PREFIXES, capBytes);
}
