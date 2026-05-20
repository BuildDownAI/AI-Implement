export interface ReaperBurstNotification {
  count: number;
  threshold: number;
}

export interface Notification {
  issueIdentifier: string;
  issueTitle: string;
  issueUrl: string;
  repoFullName: string;
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
  const res = await fetch(webhookUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      blocks: [
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: `*AI Implementation Dispatched*\n<${n.issueUrl}|${n.issueIdentifier}: ${n.issueTitle}>\nRepo: \`${n.repoFullName}\``,
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

async function notifyTeams(webhookUrl: string, n: Notification): Promise<void> {
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
              text: "AI Implementation Dispatched",
              weight: "Bolder",
              size: "Medium",
            },
            {
              type: "FactSet",
              facts: [
                {
                  title: "Issue",
                  value: `[${n.issueIdentifier}: ${n.issueTitle}](${n.issueUrl})`,
                },
                {
                  title: "Target Repo",
                  value: n.repoFullName,
                },
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

function completionLabel(status: string): string {
  switch (status) {
    case "completed":
      return "AI Implementation Completed";
    case "review_failed":
      return "AI Implementation Needs Review";
    case "failed":
      return "AI Implementation Failed";
    case "timed_out":
      return "AI Implementation Timed Out";
    default:
      return "AI Implementation Finished";
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
  const label = completionLabel(n.status);

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
  const label = completionLabel(n.status);

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
