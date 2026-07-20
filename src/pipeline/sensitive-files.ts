import path from "node:path";

/**
 * File patterns that must never be committed by the pipeline.
 *
 * Each entry is checked against both the full repo-relative path and the
 * basename so path-agnostic names (e.g. `.env`) are caught wherever they
 * appear in the tree.
 *
 * Pattern types used here:
 *   exact   – literal string equality against basename
 *   suffix  – file extension check (e.g. ".pem")
 *   segment – substring of the full path (e.g. "/.aws/credentials")
 */

interface SensitivePattern {
  /** Human-readable description surfaced in the error message. */
  description: string;
  match: (filePath: string, basename: string) => boolean;
}

const SENSITIVE_PATTERNS: SensitivePattern[] = [
  // ── Environment / config files ──────────────────────────────────────────
  { description: ".env file",
    match: (_, b) => b === ".env" },
  { description: ".env.* variant",
    // .env.example / .env.sample / .env.template (and e.g. .env.production.example)
    // are intentionally-committed templates with no real values — allow them.
    match: (_, b) =>
      b.startsWith(".env.") &&
      ![".example", ".sample", ".template"].some((t) => b.endsWith(t)) },
  { description: "*.env file",
    match: (_, b) => b !== ".env" && b.endsWith(".env") },
  { description: "Rails master.key",
    match: (_, b) => b === "master.key" },
  { description: "Rails secrets.yml / secrets.yaml",
    match: (_, b) => b === "secrets.yml" || b === "secrets.yaml" },
  { description: "secrets.json",
    match: (_, b) => b === "secrets.json" },
  { description: "Rails config/credentials.yml.enc",
    match: (f) => f === "config/credentials.yml.enc" || f.endsWith("/config/credentials.yml.enc") },

  // ── Private keys and certificates ────────────────────────────────────────
  { description: "PEM file (*.pem)",
    match: (_, b) => b.endsWith(".pem") },
  { description: "private key file (*.key)",
    match: (_, b) => b.endsWith(".key") },
  { description: "PKCS#12 bundle (*.p12)",
    match: (_, b) => b.endsWith(".p12") },
  { description: "PFX bundle (*.pfx)",
    match: (_, b) => b.endsWith(".pfx") },
  { description: "DER certificate (*.der)",
    match: (_, b) => b.endsWith(".der") },
  { description: "Java KeyStore (*.jks / *.keystore)",
    match: (_, b) => b.endsWith(".jks") || b.endsWith(".keystore") },
  { description: "SSH private key (id_rsa / id_ed25519 / id_dsa / id_ecdsa)",
    match: (_, b) => ["id_rsa", "id_ed25519", "id_dsa", "id_ecdsa"].includes(b) },
  { description: "ASC armored key (*.asc)",
    match: (_, b) => b.endsWith(".asc") },

  // ── Cloud provider credentials ───────────────────────────────────────────
  { description: "AWS credentials file",
    match: (f) => f.includes("/.aws/credentials") || f === ".aws/credentials" },
  { description: "GCP service account key (*service-account*.json or serviceAccountKey.json)",
    // Anchored to .json so ordinary source files that mention service accounts
    // (serviceAccount.ts, service_account.py, ServiceAccountController.java, …)
    // are not blocked — GCP keys are always JSON documents.
    match: (_, b) => b === "serviceAccountKey.json" || /service.?account.*\.json$/i.test(b) },
  { description: "Terraform variable file (*.tfvars)",
    match: (_, b) => b.endsWith(".tfvars") },
  { description: "Terraform state file (*.tfstate)",
    match: (_, b) => b.endsWith(".tfstate") || b.endsWith(".tfstate.backup") },

  // ── Database credentials ─────────────────────────────────────────────────
  { description: "PostgreSQL password file (.pgpass / pgpass)",
    match: (_, b) => b === ".pgpass" || b === "pgpass" },
  { description: "Rails database.yml",
    match: (_, b) => b === "database.yml" },

  // ── Token / auth files ───────────────────────────────────────────────────
  { description: ".npmrc (can contain registry auth tokens)",
    match: (f, b) => b === ".npmrc" && !f.startsWith("node_modules/") },
  { description: ".pypirc (PyPI credentials)",
    match: (_, b) => b === ".pypirc" },
  { description: ".netrc / netrc (generic host credentials)",
    match: (_, b) => b === ".netrc" || b === "netrc" },
  { description: "generic token file (*.token)",
    match: (_, b) => b.endsWith(".token") },
  { description: "kubeconfig (Kubernetes credentials)",
    match: (_, b) => b === "kubeconfig" },
  { description: ".htpasswd (basic-auth password file)",
    match: (_, b) => b === ".htpasswd" || b.endsWith(".htpasswd") },
];

export interface SensitiveFileMatch {
  file: string;
  description: string;
}

/**
 * Thrown by the push step when one or more staged files match a sensitive
 * pattern. The `code` property lets callers (e.g. the runner result handler)
 * distinguish this from generic pipeline failures programmatically.
 */
export class SensitiveFilesError extends Error {
  readonly code = "SENSITIVE_FILES_BLOCKED" as const;
  readonly files: SensitiveFileMatch[];

  constructor(hits: SensitiveFileMatch[]) {
    super(formatSensitiveFilesError(hits));
    this.name = "SensitiveFilesError";
    this.files = hits;
  }
}

/**
 * Returns every staged file that matches a sensitive pattern.
 * `stagedFiles` is a list of repo-relative paths (output of
 * `git diff --cached --name-only`).
 */
export function findSensitiveFiles(stagedFiles: string[]): SensitiveFileMatch[] {
  const hits: SensitiveFileMatch[] = [];
  for (const file of stagedFiles) {
    const basename = path.basename(file);
    for (const pattern of SENSITIVE_PATTERNS) {
      if (pattern.match(file, basename)) {
        hits.push({ file, description: pattern.description });
        break; // one match per file is enough
      }
    }
  }
  return hits;
}

/**
 * Formats a human-readable error message for sensitive files found in the
 * staged set.
 */
export function formatSensitiveFilesError(hits: SensitiveFileMatch[]): string {
  const lines = hits.map((h) => `  ${h.file}  (${h.description})`);
  return (
    `Push blocked: ${hits.length} sensitive file(s) would be committed:\n` +
    lines.join("\n") +
    "\n\nRemove these files from the working tree or add them to .gitignore."
  );
}
