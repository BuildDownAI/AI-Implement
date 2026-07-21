export interface ReaperBurstNotification {
  count: number;
  threshold: number;
}

export interface StuckGiveUpNotification {
  issueIdentifier: string;
  issueTitle: string;
  issueUrl: string;
  repoFullName: string;
  runUrl: string | null;
  attempts: number;
  lastRunStatus: string; // "queued" | "in_progress" | "run_not_found"
}

// The run phases that produce a user-facing notification
export type NotificationPhase = "planning" | "implementation" | "dispatch-failed";

export interface Notification {
  issueIdentifier: string;
  issueTitle: string;
  issueUrl: string;
  repoFullName: string;
  phase: NotificationPhase;
  /** Only set for dispatch-failed: the workflow file that was being dispatched. */
  workflowFile?: string;
  /** Only set for dispatch-failed: human-readable hint (e.g. "re-sync required?"). */
  hint?: string;
}

export interface CompletionNotification {
  issueIdentifier: string;
  issueTitle: string;
  issueUrl: string;
  repoFullName: string;
  status: "completed" | "review_failed" | "failed" | "timed_out";
  conclusion: string | null;
  prUrl: string | null;
  runUrl: string | null;
  durationMs?: number | null;
  phase: NotificationPhase;
  summary?: string;
  detail?: string;
  remediation?: string;
  docsUrl?: string;
}

// Human label for a run phase, reused across notification kinds (dispatch, completion, …).
// Keyed on NotificationPhase, so widening that union is a compile error here until the new phase gets a label — no silent fallthrough.
const PHASE_LABELS: Record<NotificationPhase, string> = {
  planning: "AI Planning",
  implementation: "AI Implementation",
  "dispatch-failed": "Dispatch Failed",
};

export async function notifyStuckGiveUp(
  type: string,
  webhookUrl: string,
  n: StuckGiveUpNotification,
): Promise<void> {
  switch (type.toLowerCase()) {
    case "teams":
      return notifyStuckGiveUpTeams(webhookUrl, n);
    case "slack":
    default:
      return notifyStuckGiveUpSlack(webhookUrl, n);
  }
}

export async function notifyReaperBurst(
  type: string,
  webhookUrl: string,
  n: ReaperBurstNotification,
): Promise<void> {
  switch (type.toLowerCase()) {
    case "teams":
      return notifyReaperBurstTeams(webhookUrl, n);
    case "slack":
    default:
      return notifyReaperBurstSlack(webhookUrl, n);
  }
}

export async function notify(type: string, webhookUrl: string, n: Notification): Promise<void> {
  switch (type.toLowerCase()) {
    case "teams":
      return notifyTeams(webhookUrl, n);
    case "slack":
    default:
      return notifySlack(webhookUrl, n);
  }
}

export async function notifyCompletion(
  type: string,
  webhookUrl: string,
  n: CompletionNotification,
): Promise<void> {
  switch (type.toLowerCase()) {
    case "teams":
      return notifyCompletionTeams(webhookUrl, n);
    case "slack":
    default:
      return notifyCompletionSlack(webhookUrl, n);
  }
}

// ---------- Dispatch notifications ----------

async function notifySlack(webhookUrl: string, n: Notification): Promise<void> {
  let text: string;
  if (n.phase === "dispatch-failed") {
    text = `*${PHASE_LABELS[n.phase]}* — \`${n.workflowFile ?? ""}\`\nRepo: \`${n.repoFullName}\``;
    if (n.hint) text += `\n⚠️ Hint: ${n.hint}`;
  } else {
    text = `*${PHASE_LABELS[n.phase]} Dispatched*\n<${n.issueUrl}|${n.issueIdentifier}: ${n.issueTitle}>\nRepo: \`${n.repoFullName}\``;
  }

  const res = await fetch(webhookUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      blocks: [
        {
          type: "section",
          text: { type: "mrkdwn", text },
        },
      ],
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Slack webhook failed: ${res.status} — ${body}`);
  }
}

async function notifyTeams(webhookUrl: string, n: Notification): Promise<void> {
  let bodyBlocks: unknown[];
  if (n.phase === "dispatch-failed") {
    const facts: Array<{ title: string; value: string }> = [
      { title: "Workflow", value: n.workflowFile ?? "" },
      { title: "Target Repo", value: n.repoFullName },
    ];
    if (n.hint) facts.push({ title: "Hint", value: n.hint });
    bodyBlocks = [
      { type: "TextBlock", text: PHASE_LABELS[n.phase], weight: "Bolder", size: "Medium" },
      { type: "FactSet", facts },
    ];
  } else {
    bodyBlocks = [
      {
        type: "TextBlock",
        text: `${PHASE_LABELS[n.phase]} Dispatched`,
        weight: "Bolder",
        size: "Medium",
      },
      {
        type: "FactSet",
        facts: [
          { title: "Issue", value: `[${n.issueIdentifier}: ${n.issueTitle}](${n.issueUrl})` },
          { title: "Target Repo", value: n.repoFullName },
        ],
      },
    ];
  }

  const card = {
    type: "message",
    attachments: [
      {
        contentType: "application/vnd.microsoft.card.adaptive",
        content: {
          $schema: "http://adaptivecards.io/schemas/adaptive-card.json",
          type: "AdaptiveCard",
          version: "1.4",
          body: bodyBlocks,
        },
      },
    ],
  };

  const res = await fetch(webhookUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(card),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Teams webhook failed: ${res.status} — ${body}`);
  }
}

// ---------- Completion notifications ----------

function formatDuration(ms: number): string {
  const totalSeconds = Math.round(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes === 0) return `${seconds}s`;
  if (seconds === 0) return `${minutes}m`;
  return `${minutes}m ${seconds}s`;
}

function completionEmoji(status: string): string {
  switch (status) {
    case "completed":
      return ":white_check_mark:";
    case "review_failed":
      return ":warning:";
    case "failed":
      return ":x:";
    case "timed_out":
      return ":hourglass:";
    default:
      return ":question:";
  }
}

function completionLabel(status: string, phase: NotificationPhase): string {
  const phaseLabel = PHASE_LABELS[phase]; // "AI Planning" | "AI Implementation"
  switch (status) {
    case "completed":
      return `${phaseLabel} Completed`;
    case "review_failed":
      return `${phaseLabel} Needs Review`;
    case "failed":
      return `${phaseLabel} Failed`;
    case "timed_out":
      return `${phaseLabel} Timed Out`;
    default:
      return `${phaseLabel} Finished`;
  }
}

function completionTeamsIcon(status: string): string {
  switch (status) {
    case "completed":
      return "&#x2705;";
    case "review_failed":
      return "&#x26A0;";
    case "failed":
      return "&#x274C;";
    case "timed_out":
      return "&#x23F3;";
    default:
      return "&#x2753;";
  }
}

async function notifyCompletionSlack(
  webhookUrl: string,
  n: CompletionNotification,
): Promise<void> {
  const emoji = completionEmoji(n.status);
  const label = completionLabel(n.status, n.phase);

  let text = `${emoji} *${label}*\n<${n.issueUrl}|${n.issueIdentifier}: ${n.issueTitle}>\nRepo: \`${n.repoFullName}\``;
  if (n.prUrl) {
    text += `\nPR: <${n.prUrl}|View Pull Request>`;
  }
  if (n.runUrl) {
    text += `\nRun: <${n.runUrl}|View Workflow Run>`;
  }
  if (n.durationMs != null) {
    text += `\nDuration: ${formatDuration(n.durationMs)}`;
  }
  if (n.summary) text += `\n\n${n.summary}`;
  if (n.detail) text += `\n${n.detail}`;
  if (n.remediation) text += `\n*Next step:* ${n.remediation}`;
  if (n.docsUrl) text += `\n<${n.docsUrl}|Troubleshooting guide>`;

  const res = await fetch(webhookUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      blocks: [
        {
          type: "section",
          text: { type: "mrkdwn", text },
        },
      ],
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Slack webhook failed: ${res.status} — ${body}`);
  }
}

// ---------- Reaper burst alerts ----------

async function notifyStuckGiveUpSlack(
  webhookUrl: string,
  n: StuckGiveUpNotification,
): Promise<void> {
  let text = `:rotating_light: *AI Implementation Stuck — Needs Human*\n<${n.issueUrl}|${n.issueIdentifier}: ${n.issueTitle}>\nRepo: \`${n.repoFullName}\`\nAttempts: ${n.attempts}\nLast status: \`${n.lastRunStatus}\``;
  if (n.runUrl) {
    text += `\nRun: <${n.runUrl}|View Workflow Run>`;
  }

  const res = await fetch(webhookUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      blocks: [{ type: "section", text: { type: "mrkdwn", text } }],
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Slack webhook failed: ${res.status} — ${body}`);
  }
}

async function notifyStuckGiveUpTeams(
  webhookUrl: string,
  n: StuckGiveUpNotification,
): Promise<void> {
  const facts: Array<{ title: string; value: string }> = [
    { title: "Issue", value: `[${n.issueIdentifier}: ${n.issueTitle}](${n.issueUrl})` },
    { title: "Repo", value: n.repoFullName },
    { title: "Attempts", value: String(n.attempts) },
    { title: "Last status", value: n.lastRunStatus },
  ];
  if (n.runUrl) {
    facts.push({ title: "Run", value: `[View Workflow Run](${n.runUrl})` });
  }

  const card = {
    type: "message",
    attachments: [
      {
        contentType: "application/vnd.microsoft.card.adaptive",
        content: {
          $schema: "http://adaptivecards.io/schemas/adaptive-card.json",
          type: "AdaptiveCard",
          version: "1.4",
          body: [
            {
              type: "TextBlock",
              text: "&#x1F6A8; AI Implementation Stuck \u2014 Needs Human",
              weight: "Bolder",
              size: "Medium",
            },
            { type: "FactSet", facts },
          ],
        },
      },
    ],
  };

  const res = await fetch(webhookUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(card),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Teams webhook failed: ${res.status} — ${body}`);
  }
}

async function notifyReaperBurstSlack(
  webhookUrl: string,
  n: ReaperBurstNotification,
): Promise<void> {
  const res = await fetch(webhookUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      blocks: [
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: `:warning: *Reaper burst alert*: destroyed *${n.count}* machines in a single sweep (threshold: ${n.threshold})`,
          },
        },
      ],
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Slack webhook failed: ${res.status} — ${body}`);
  }
}

async function notifyReaperBurstTeams(
  webhookUrl: string,
  n: ReaperBurstNotification,
): Promise<void> {
  const card = {
    type: "message",
    attachments: [
      {
        contentType: "application/vnd.microsoft.card.adaptive",
        content: {
          $schema: "http://adaptivecards.io/schemas/adaptive-card.json",
          type: "AdaptiveCard",
          version: "1.4",
          body: [
            {
              type: "TextBlock",
              text: "&#x26A0; Reaper Burst Alert",
              weight: "Bolder",
              size: "Medium",
            },
            {
              type: "FactSet",
              facts: [
                { title: "Machines destroyed", value: String(n.count) },
                { title: "Threshold", value: String(n.threshold) },
              ],
            },
          ],
        },
      },
    ],
  };

  const res = await fetch(webhookUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(card),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Teams webhook failed: ${res.status} — ${body}`);
  }
}

async function notifyCompletionTeams(
  webhookUrl: string,
  n: CompletionNotification,
): Promise<void> {
  const icon = completionTeamsIcon(n.status);
  const label = completionLabel(n.status, n.phase);

  const facts = [
    {
      title: "Issue",
      value: `[${n.issueIdentifier}: ${n.issueTitle}](${n.issueUrl})`,
    },
    {
      title: "Repo",
      value: n.repoFullName,
    },
  ];
  if (n.prUrl) {
    facts.push({ title: "PR", value: `[View Pull Request](${n.prUrl})` });
  }
  if (n.runUrl) {
    facts.push({ title: "Run", value: `[View Workflow Run](${n.runUrl})` });
  }
  if (n.durationMs != null) {
    facts.push({ title: "Duration", value: formatDuration(n.durationMs) });
  }

  const classification: string[] = [];
  if (n.summary) classification.push(n.summary);
  if (n.detail) classification.push(n.detail);
  if (n.remediation) classification.push(`**Next step:** ${n.remediation}`);
  if (n.docsUrl) classification.push(`[Troubleshooting guide](${n.docsUrl})`);

  const card = {
    type: "message",
    attachments: [
      {
        contentType: "application/vnd.microsoft.card.adaptive",
        content: {
          $schema: "http://adaptivecards.io/schemas/adaptive-card.json",
          type: "AdaptiveCard",
          version: "1.4",
          body: [
            {
              type: "TextBlock",
              text: `${icon} ${label}`,
              weight: "Bolder",
              size: "Medium",
            },
            {
              type: "FactSet",
              facts,
            },
            ...(classification.length
              ? [{
                  type: "TextBlock",
                  text: classification.join("\n\n"),
                  wrap: true 
                }]
              : []),
          ],
        },
      },
    ],
  };

  const res = await fetch(webhookUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(card),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Teams webhook failed: ${res.status} — ${body}`);
  }
}
