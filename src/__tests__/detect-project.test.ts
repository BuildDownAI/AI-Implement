import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const DETECT_SCRIPT = join(__dirname, "../../session/detect-project.sh");

/** Run detect-project.sh in the given directory, return { stdout, stderr, status } */
function runDetect(
  cwd: string,
  env: Record<string, string> = {},
): { stdout: string; stderr: string; status: number } {
  const result = spawnSync("bash", [DETECT_SCRIPT], {
    cwd,
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin", ...env },
    encoding: "utf8",
  });
  return {
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    status: result.status ?? 1,
  };
}

/** Parse "KEY=value" lines from detect-project.sh stdout into a plain object */
function parseOutput(stdout: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const line of stdout.split("\n")) {
    const m = line.match(/^([A-Z_]+)=(.*)$/);
    if (m) result[m[1]] = m[2];
  }
  return result;
}

let tmpDir: string;

beforeEach(() => {
  tmpDir = join(
    tmpdir(),
    `detect-project-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  mkdirSync(tmpDir, { recursive: true });
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

// ── 1. Auto-detection: package.json with 'dev' script ─────────────────────────

describe("auto-detection: package.json with dev script", () => {
  beforeEach(() => {
    writeFileSync(
      join(tmpDir, "package.json"),
      JSON.stringify({ scripts: { dev: "vite", test: "vitest" } }),
    );
  });

  it("exits 0", () => {
    const { status } = runDetect(tmpDir);
    expect(status).toBe(0);
  });

  it("sets SETUP_CMD to npm install", () => {
    const { stdout } = runDetect(tmpDir);
    expect(parseOutput(stdout).SETUP_CMD).toBe("npm install");
  });

  it("sets DEV_CMD to npm run dev", () => {
    const { stdout } = runDetect(tmpDir);
    expect(parseOutput(stdout).DEV_CMD).toBe("npm run dev");
  });

  it("sets DEV_PORT to 3000", () => {
    const { stdout } = runDetect(tmpDir);
    expect(parseOutput(stdout).DEV_PORT).toBe("3000");
  });

  it("sets READY_CHECK to localhost:3000", () => {
    const { stdout } = runDetect(tmpDir);
    expect(parseOutput(stdout).READY_CHECK).toBe(
      "curl -sf http://localhost:3000/",
    );
  });
});

// ── 2. Auto-detection: package.json with 'start' but no 'dev' script ──────────

describe("auto-detection: package.json with start script only", () => {
  beforeEach(() => {
    writeFileSync(
      join(tmpDir, "package.json"),
      JSON.stringify({ scripts: { start: "node server.js" } }),
    );
  });

  it("sets DEV_CMD to npm start", () => {
    const { stdout } = runDetect(tmpDir);
    expect(parseOutput(stdout).DEV_CMD).toBe("npm start");
  });

  it("sets SETUP_CMD to npm install", () => {
    const { stdout } = runDetect(tmpDir);
    expect(parseOutput(stdout).SETUP_CMD).toBe("npm install");
  });
});

// ── 3. .ai-implement.toml: custom values ──────────────────────────────────────

describe(".ai-implement.toml custom values", () => {
  beforeEach(() => {
    writeFileSync(
      join(tmpDir, ".ai-implement.toml"),
      [
        'setup_cmd = "make install"',
        'dev_cmd = "make serve"',
        "dev_port = 4000",
        'ready_check = "curl -sf http://localhost:4000/health"',
        'verify_cmd = "make test"',
        'teardown_cmd = "make stop"',
        'claude_model = "claude-opus-4-6"',
        "claude_max_turns = 50",
      ].join("\n"),
    );
  });

  it("exits 0", () => {
    expect(runDetect(tmpDir).status).toBe(0);
  });

  it("parses setup_cmd", () => {
    expect(parseOutput(runDetect(tmpDir).stdout).SETUP_CMD).toBe("make install");
  });

  it("parses dev_cmd", () => {
    expect(parseOutput(runDetect(tmpDir).stdout).DEV_CMD).toBe("make serve");
  });

  it("parses dev_port", () => {
    expect(parseOutput(runDetect(tmpDir).stdout).DEV_PORT).toBe("4000");
  });

  it("parses ready_check", () => {
    expect(parseOutput(runDetect(tmpDir).stdout).READY_CHECK).toBe(
      "curl -sf http://localhost:4000/health",
    );
  });

  it("parses verify_cmd", () => {
    expect(parseOutput(runDetect(tmpDir).stdout).VERIFY_CMD).toBe("make test");
  });

  it("parses teardown_cmd", () => {
    expect(parseOutput(runDetect(tmpDir).stdout).TEARDOWN_CMD).toBe("make stop");
  });

  it("parses claude_model", () => {
    expect(parseOutput(runDetect(tmpDir).stdout).CLAUDE_MODEL).toBe(
      "claude-opus-4-6",
    );
  });

  it("parses claude_max_turns", () => {
    expect(parseOutput(runDetect(tmpDir).stdout).CLAUDE_MAX_TURNS).toBe("50");
  });

  it("strips inline TOML comments after scalar values", () => {
    writeFileSync(
      join(tmpDir, ".ai-implement.toml"),
      [
        'setup_cmd = "npm install" # install dependencies',
        "dev_port = 3000 # vite default",
      ].join("\n"),
    );

    const out = parseOutput(runDetect(tmpDir).stdout);
    expect(out.SETUP_CMD).toBe("npm install");
    expect(out.DEV_PORT).toBe("3000");
  });

  it("does not treat section-scoped keys as root config", () => {
    writeFileSync(
      join(tmpDir, ".ai-implement.toml"),
      [
        "[secrets]",
        'required = ["MY_SECRET"]',
        'setup_cmd = "wrong-scope"',
      ].join("\n"),
    );

    const out = parseOutput(runDetect(tmpDir, { MY_SECRET: "set" }).stdout);
    expect(out.SETUP_CMD).toBe("");
    expect(out.REQUIRED_SECRETS).toBe("MY_SECRET");
  });

  it("fails clearly on invalid TOML", () => {
    writeFileSync(
      join(tmpDir, ".ai-implement.toml"),
      'setup_cmd = "npm install',
    );

    const { status, stderr } = runDetect(tmpDir);
    expect(status).toBe(1);
    expect(stderr).toContain("invalid TOML");
  });
});

// ── 4. .ai-implement.toml: required secrets present ──────────────────────────

describe(".ai-implement.toml required secrets — all present", () => {
  beforeEach(() => {
    writeFileSync(
      join(tmpDir, ".ai-implement.toml"),
      ['[secrets]', 'required = ["MY_SECRET", "ANOTHER_SECRET"]'].join("\n"),
    );
  });

  it("exits 0 when all required secrets are set", () => {
    const { status } = runDetect(tmpDir, {
      MY_SECRET: "abc",
      ANOTHER_SECRET: "xyz",
    });
    expect(status).toBe(0);
  });

  it("sets REQUIRED_SECRETS", () => {
    const { stdout } = runDetect(tmpDir, {
      MY_SECRET: "abc",
      ANOTHER_SECRET: "xyz",
    });
    const val = parseOutput(stdout).REQUIRED_SECRETS;
    expect(val).toContain("MY_SECRET");
    expect(val).toContain("ANOTHER_SECRET");
  });

  it("fails on blank secret names in arrays", () => {
    writeFileSync(
      join(tmpDir, ".ai-implement.toml"),
      ['[secrets]', 'required = ["MY_SECRET", ""]'].join("\n"),
    );

    const { status, stderr } = runDetect(tmpDir, {
      MY_SECRET: "abc",
    });
    expect(status).toBe(1);
    expect(stderr).toContain("array of non-empty strings");
  });
});

// ── 5. .ai-implement.toml: missing required secret → exit 1 ──────────────────

describe(".ai-implement.toml required secrets — missing", () => {
  beforeEach(() => {
    writeFileSync(
      join(tmpDir, ".ai-implement.toml"),
      ['[secrets]', 'required = ["MISSING_VAR"]'].join("\n"),
    );
  });

  it("exits 1 when a required secret is missing", () => {
    const { status } = runDetect(tmpDir);
    expect(status).toBe(1);
  });

  it("prints a clear error naming the missing secret", () => {
    const { stderr } = runDetect(tmpDir);
    expect(stderr).toContain("MISSING_VAR");
    expect(stderr).toContain("missing required secret");
  });
});

// ── 6. .ai-implement.toml: optional secrets section ──────────────────────────

describe(".ai-implement.toml optional secrets", () => {
  it("does not fail when optional secrets are absent", () => {
    writeFileSync(
      join(tmpDir, ".ai-implement.toml"),
      ['[secrets]', 'optional = ["NICE_TO_HAVE"]'].join("\n"),
    );
    expect(runDetect(tmpDir).status).toBe(0);
  });

  it("exports OPTIONAL_SECRETS", () => {
    writeFileSync(
      join(tmpDir, ".ai-implement.toml"),
      ['[secrets]', 'optional = ["NICE_TO_HAVE"]'].join("\n"),
    );
    expect(parseOutput(runDetect(tmpDir).stdout).OPTIONAL_SECRETS).toBe(
      "NICE_TO_HAVE",
    );
  });

  it("parses section headers with surrounding whitespace", () => {
    writeFileSync(
      join(tmpDir, ".ai-implement.toml"),
      ['[ secrets ]', 'optional = ["NICE_TO_HAVE"]'].join("\n"),
    );
    expect(parseOutput(runDetect(tmpDir).stdout).OPTIONAL_SECRETS).toBe(
      "NICE_TO_HAVE",
    );
  });
});

// ── 7. External env var takes precedence over TOML ───────────────────────────

describe("external CLAUDE_MODEL env var precedence", () => {
  beforeEach(() => {
    writeFileSync(
      join(tmpDir, ".ai-implement.toml"),
      'claude_model = "claude-haiku-4-5-20251001"',
    );
  });

  it("external CLAUDE_MODEL overrides TOML value", () => {
    const { stdout } = runDetect(tmpDir, {
      CLAUDE_MODEL: "claude-opus-4-6",
    });
    expect(parseOutput(stdout).CLAUDE_MODEL).toBe("claude-opus-4-6");
  });
});

describe("external CLAUDE_MAX_TURNS env var precedence", () => {
  beforeEach(() => {
    writeFileSync(join(tmpDir, ".ai-implement.toml"), "claude_max_turns = 50");
  });

  it("external CLAUDE_MAX_TURNS overrides TOML value", () => {
    const { stdout } = runDetect(tmpDir, {
      CLAUDE_MAX_TURNS: "200",
    });
    expect(parseOutput(stdout).CLAUDE_MAX_TURNS).toBe("200");
  });
});

// ── 8. Unknown project: no sentinel files ─────────────────────────────────────

describe("auto-detection: django project", () => {
  beforeEach(() => {
    writeFileSync(join(tmpDir, "requirements.txt"), "django==5.0.0\n");
    writeFileSync(join(tmpDir, "manage.py"), "#!/usr/bin/env python\n");
  });

  it("sets Django defaults", () => {
    const out = parseOutput(runDetect(tmpDir).stdout);
    expect(out.SETUP_CMD).toBe("pip install -r requirements.txt");
    expect(out.DEV_CMD).toBe("python manage.py runserver 0.0.0.0:8000");
    expect(out.DEV_PORT).toBe("8000");
    expect(out.READY_CHECK).toBe("curl -sf http://localhost:8000/");
  });
});

describe("auto-detection: rails project", () => {
  beforeEach(() => {
    writeFileSync(join(tmpDir, "Gemfile"), 'source "https://rubygems.org"\n');
    writeFileSync(join(tmpDir, "config.ru"), "run Rails.application\n");
  });

  it("sets Rails defaults", () => {
    const out = parseOutput(runDetect(tmpDir).stdout);
    expect(out.SETUP_CMD).toBe("bundle install");
    expect(out.DEV_CMD).toBe("bundle exec rails server -b 0.0.0.0");
    expect(out.DEV_PORT).toBe("3000");
    expect(out.READY_CHECK).toBe("curl -sf http://localhost:3000/");
  });
});

describe("auto-detection: go project", () => {
  beforeEach(() => {
    writeFileSync(join(tmpDir, "go.mod"), "module example.com/app\n");
  });

  it("sets Go defaults", () => {
    const out = parseOutput(runDetect(tmpDir).stdout);
    expect(out.SETUP_CMD).toBe("go build ./...");
    expect(out.DEV_CMD).toBe("go run .");
    expect(out.DEV_PORT).toBe("8080");
    expect(out.READY_CHECK).toBe("curl -sf http://localhost:8080/");
  });
});

describe("auto-detection: docker compose project", () => {
  beforeEach(() => {
    writeFileSync(
      join(tmpDir, "docker-compose.yml"),
      "services:\n  web:\n    image: nginx:latest\n",
    );
  });

  it("sets Docker Compose defaults", () => {
    const out = parseOutput(runDetect(tmpDir).stdout);
    expect(out.SETUP_CMD).toBe("");
    expect(out.DEV_CMD).toBe("docker compose up -d");
    expect(out.DEV_PORT).toBe("3000");
    expect(out.READY_CHECK).toBe("");
    expect(out.TEARDOWN_CMD).toBe("docker compose down");
  });

  it("also detects docker-compose.yaml", () => {
    rmSync(join(tmpDir, "docker-compose.yml"));
    writeFileSync(
      join(tmpDir, "docker-compose.yaml"),
      "services:\n  web:\n    image: nginx:latest\n",
    );

    const out = parseOutput(runDetect(tmpDir).stdout);
    expect(out.DEV_CMD).toBe("docker compose up -d");
    expect(out.TEARDOWN_CMD).toBe("docker compose down");
  });
});

describe("unknown project type", () => {
  it("exits 0 with empty SETUP_CMD and DEV_CMD", () => {
    const { status, stdout } = runDetect(tmpDir);
    expect(status).toBe(0);
    const out = parseOutput(stdout);
    expect(out.SETUP_CMD).toBe("");
    expect(out.DEV_CMD).toBe("");
  });
});
