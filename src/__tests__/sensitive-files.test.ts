import { describe, it, expect } from "vitest";
import { findSensitiveFiles, formatSensitiveFilesError, SensitiveFilesError } from "../pipeline/sensitive-files.js";

// ── findSensitiveFiles ────────────────────────────────────────────────────────

describe("findSensitiveFiles – env files", () => {
  it("blocks .env at the repo root", () => {
    expect(findSensitiveFiles([".env"])).toHaveLength(1);
  });

  it("blocks .env in a subdirectory", () => {
    expect(findSensitiveFiles(["packages/api/.env"])).toHaveLength(1);
  });

  it("blocks .env.local / .env.production / .env.staging", () => {
    expect(findSensitiveFiles([".env.local"])).toHaveLength(1);
    expect(findSensitiveFiles([".env.production"])).toHaveLength(1);
    expect(findSensitiveFiles([".env.staging"])).toHaveLength(1);
  });

  it("blocks suffix variants like prod.env", () => {
    expect(findSensitiveFiles(["prod.env"])).toHaveLength(1);
    expect(findSensitiveFiles(["secrets.env"])).toHaveLength(1);
  });
});

describe("findSensitiveFiles – private keys and certificates", () => {
  it("blocks *.pem files", () => {
    expect(findSensitiveFiles(["server.pem"])).toHaveLength(1);
    expect(findSensitiveFiles(["certs/ca.pem"])).toHaveLength(1);
  });

  it("blocks *.key files", () => {
    expect(findSensitiveFiles(["private.key"])).toHaveLength(1);
    expect(findSensitiveFiles(["config/server.key"])).toHaveLength(1);
  });

  it("blocks *.p12 and *.pfx", () => {
    expect(findSensitiveFiles(["cert.p12"])).toHaveLength(1);
    expect(findSensitiveFiles(["cert.pfx"])).toHaveLength(1);
  });

  it("blocks SSH private key names", () => {
    expect(findSensitiveFiles(["id_rsa"])).toHaveLength(1);
    expect(findSensitiveFiles(["id_ed25519"])).toHaveLength(1);
    expect(findSensitiveFiles(["id_dsa"])).toHaveLength(1);
    expect(findSensitiveFiles(["id_ecdsa"])).toHaveLength(1);
  });

  it("blocks Java KeyStore files", () => {
    expect(findSensitiveFiles(["keystore.jks"])).toHaveLength(1);
    expect(findSensitiveFiles(["app.keystore"])).toHaveLength(1);
  });
});

describe("findSensitiveFiles – cloud credentials", () => {
  it("blocks .aws/credentials wherever it appears", () => {
    expect(findSensitiveFiles([".aws/credentials"])).toHaveLength(1);
    expect(findSensitiveFiles(["home/user/.aws/credentials"])).toHaveLength(1);
  });

  it("blocks GCP service account key files", () => {
    expect(findSensitiveFiles(["serviceAccountKey.json"])).toHaveLength(1);
    expect(findSensitiveFiles(["my-service-account.json"])).toHaveLength(1);
  });

  it("blocks Terraform variable and state files", () => {
    expect(findSensitiveFiles(["terraform.tfvars"])).toHaveLength(1);
    expect(findSensitiveFiles(["prod.tfvars"])).toHaveLength(1);
    expect(findSensitiveFiles(["terraform.tfstate"])).toHaveLength(1);
    expect(findSensitiveFiles(["terraform.tfstate.backup"])).toHaveLength(1);
  });
});

describe("findSensitiveFiles – token and auth files", () => {
  it("blocks .npmrc at the repo root", () => {
    expect(findSensitiveFiles([".npmrc"])).toHaveLength(1);
  });

  it("does not block .npmrc inside node_modules", () => {
    expect(findSensitiveFiles(["node_modules/foo/.npmrc"])).toHaveLength(0);
  });

  it("blocks .netrc and netrc", () => {
    expect(findSensitiveFiles([".netrc"])).toHaveLength(1);
    expect(findSensitiveFiles(["netrc"])).toHaveLength(1);
  });

  it("blocks kubeconfig", () => {
    expect(findSensitiveFiles(["kubeconfig"])).toHaveLength(1);
  });

  it("blocks secrets.json", () => {
    expect(findSensitiveFiles(["secrets.json"])).toHaveLength(1);
  });

  it("blocks Rails master.key and secrets.yml", () => {
    expect(findSensitiveFiles(["config/master.key"])).toHaveLength(1);
    expect(findSensitiveFiles(["config/secrets.yml"])).toHaveLength(1);
  });
});

describe("findSensitiveFiles – safe files allowed through", () => {
  it("allows normal source files", () => {
    expect(findSensitiveFiles(["src/index.ts", "README.md", "package.json"])).toHaveLength(0);
  });

  it("allows .gitignore and CLAUDE.md", () => {
    expect(findSensitiveFiles([".gitignore", "CLAUDE.md"])).toHaveLength(0);
  });

  it("allows files that contain 'key' in their name but are not keys", () => {
    expect(findSensitiveFiles(["src/hotkeys.ts", "keyboard-shortcut.ts"])).toHaveLength(0);
  });

  it("allows public SSH key (id_rsa.pub)", () => {
    // .pub suffix is not blocked; only the bare private key names are
    expect(findSensitiveFiles(["id_rsa.pub"])).toHaveLength(0);
  });
});

describe("findSensitiveFiles – mixed tracked + untracked PR scenario", () => {
  it("reports sensitive files when mixed with safe changes", () => {
    const staged = [
      ".gitignore",          // safe – tracked modification
      "src/feature.ts",      // safe – new source file
      ".env",                // SENSITIVE – should be blocked
      ".claude/settings.json", // safe
      "private.key",         // SENSITIVE
    ];
    const hits = findSensitiveFiles(staged);
    expect(hits).toHaveLength(2);
    expect(hits.map((h) => h.file)).toEqual(expect.arrayContaining([".env", "private.key"]));
  });

  it("passes a clean mixed diff through without error", () => {
    const staged = [
      ".gitignore",
      "src/feature.ts",
      ".claude/settings.json",
      "bd-project-setup/SKILL.md",
      ".mcp.json",
    ];
    expect(findSensitiveFiles(staged)).toHaveLength(0);
  });
});

describe("findSensitiveFiles – gitignore relaxation scenario", () => {
  it("blocks a sensitive file that was previously gitignored but is now staged", () => {
    // Simulate: .gitignore was modified to remove '.env' protection,
    // then git add -A picks up the pre-existing .env file.
    const staged = [
      ".gitignore",   // the modified gitignore (safe on its own)
      ".env",         // now staged because gitignore no longer ignores it
    ];
    const hits = findSensitiveFiles(staged);
    expect(hits).toHaveLength(1);
    expect(hits[0].file).toBe(".env");
  });

  it("blocks multiple secrets exposed by a gitignore relaxation", () => {
    const staged = [
      ".gitignore",
      ".env.production",
      "config/master.key",
      "src/unchanged.ts",
    ];
    const hits = findSensitiveFiles(staged);
    expect(hits).toHaveLength(2);
    expect(hits.map((h) => h.file)).toEqual(
      expect.arrayContaining([".env.production", "config/master.key"]),
    );
  });
});

// ── formatSensitiveFilesError ─────────────────────────────────────────────────

describe("formatSensitiveFilesError", () => {
  it("includes the file path and description in the message", () => {
    const hits = findSensitiveFiles([".env", "server.pem"]);
    const msg = formatSensitiveFilesError(hits);
    expect(msg).toContain(".env");
    expect(msg).toContain("server.pem");
    expect(msg).toContain("Push blocked");
    expect(msg).toContain(".gitignore");
  });
});

// ── SensitiveFilesError ───────────────────────────────────────────────────────

describe("SensitiveFilesError", () => {
  it("has code SENSITIVE_FILES_BLOCKED", () => {
    const hits = findSensitiveFiles([".env"]);
    const err = new SensitiveFilesError(hits);
    expect(err.code).toBe("SENSITIVE_FILES_BLOCKED");
  });

  it("is an instance of Error", () => {
    const err = new SensitiveFilesError(findSensitiveFiles([".env"]));
    expect(err).toBeInstanceOf(Error);
  });

  it("has a human-readable message that includes the blocked file paths", () => {
    const hits = findSensitiveFiles([".env", "private.key"]);
    const err = new SensitiveFilesError(hits);
    expect(err.message).toContain(".env");
    expect(err.message).toContain("private.key");
    expect(err.message).toContain("Push blocked");
  });

  it("exposes the structured files list", () => {
    const hits = findSensitiveFiles([".env", "server.pem"]);
    const err = new SensitiveFilesError(hits);
    expect(err.files).toHaveLength(2);
    expect(err.files.map((f) => f.file)).toEqual(expect.arrayContaining([".env", "server.pem"]));
  });

  it("has name SensitiveFilesError", () => {
    const err = new SensitiveFilesError(findSensitiveFiles([".env"]));
    expect(err.name).toBe("SensitiveFilesError");
  });
});
