/**
 * Break-glass access recovery, run on the host when nobody can sign in.
 *
 *   node dist/access-recovery.js --email you@example.com [--only]
 *
 * There is no standing credential: the authority is shell access, which already implies reading
 * the database and every secret. The change is audited with a null actor, because nobody
 * authenticated for it.
 */

import { initAccessAuditTable } from "./access-audit.js";
import { initAccessEntriesTable, listAccessEntries, parseAccessEntries, saveAccessEntries } from "./access-entries.js";
import { notifyText } from "./notify.js";

export interface AccessRecoveryDependencies {
  initTables: () => void;
  listEntries: typeof listAccessEntries;
  saveEntries: typeof saveAccessEntries;
  notify: typeof notifyText;
  writeStdout: (text: string) => void;
  writeStderr: (text: string) => void;
  /** The only two environment values this command reads. */
  notifyWebhookUrl: string | undefined;
  appName: string | undefined;
}

const DEFAULT_DEPENDENCIES: AccessRecoveryDependencies = {
  initTables: () => {
    // A separate process from the orchestrator, so neither table exists here until asked for.
    initAccessEntriesTable();
    initAccessAuditTable();
  },
  listEntries: listAccessEntries,
  saveEntries: saveAccessEntries,
  notify: notifyText,
  writeStdout: (text) => process.stdout.write(text),
  writeStderr: (text) => process.stderr.write(text),
  notifyWebhookUrl: process.env.NOTIFY_WEBHOOK_URL,
  appName: process.env.FLY_APP_NAME,
};

const USAGE = `Usage: node dist/access-recovery.js --email <address> [--only]

  --email <address>  the address to grant admin
  --only             replace the whole list with this address, rather than adding to it
`;

export async function runAccessRecovery(
  args: string[],
  deps: AccessRecoveryDependencies = DEFAULT_DEPENDENCIES,
): Promise<number> {
  let email = "";
  let only = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--email" && args[i + 1]) email = args[++i] as string;
    else if (arg === "--only") only = true;
    else if (arg === "--help" || arg === "-h") {
      deps.writeStdout(USAGE);
      return 0;
    } else {
      deps.writeStderr(`Unknown argument: ${arg}\n\n${USAGE}`);
      return 1;
    }
  }

  if (!email) {
    deps.writeStderr(`--email is required\n\n${USAGE}`);
    return 1;
  }

  const address = email.trim().toLowerCase();

  // One try around every step that touches the database, so opening it, reading it and writing to
  // it all fail the same way. The guard at the bottom of the file is then a last resort for a bug,
  // not a second error path.
  try {
    deps.initTables();

    // Dropping any existing row for this address first makes recovery idempotent, and lets it
    // promote someone whose role is what locked them out rather than refusing as a duplicate.
    const kept = only
      ? []
      : deps.listEntries().filter((e) => !(e.kind === "address" && e.value === address));
    const desired = [
      ...kept.map(({ kind, value, role }) => ({ kind, value, role })),
      { kind: "address", value: address, role: "admin" },
    ];

    // The same validator the admin route uses, so the command cannot write a shape the UI rejects.
    const parsed = parseAccessEntries(desired);
    if (!parsed.ok) {
      deps.writeStderr(`${parsed.error}\n`);
      return 1;
    }

    deps.saveEntries(parsed.entries, null, { action: "recover" });
  } catch (err) {
    deps.writeStderr(`Recovery failed: ${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }

  deps.writeStdout(
    `Added ${address} as admin${only ? ", replacing the previous list" : ""}.\n` +
      `Recorded in the access audit with no actor.\n` +
      `In effect within one poll interval — no restart needed.\n`,
  );

  if (deps.notifyWebhookUrl) {
    // Best-effort: a recovery that worked must not report failure because a webhook was down.
    try {
      await deps.notify(
        deps.notifyWebhookUrl,
        `Access recovery ran on ${deps.appName ?? "this orchestrator"}: ${address} granted admin` +
          `${only ? " (list replaced)" : ""}. Performed on the host, with no authenticated user.`,
      );
    } catch (err) {
      deps.writeStderr(`Notification failed: ${err instanceof Error ? err.message : String(err)}\n`);
    }
  }
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runAccessRecovery(process.argv.slice(2))
    .then((exitCode) => process.exit(exitCode))
    .catch((err) => {
      process.stderr.write(`Recovery failed: ${err instanceof Error ? err.message : String(err)}\n`);
      process.exit(1);
    });
}
