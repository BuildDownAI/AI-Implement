import crypto from "node:crypto";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as WebhookModule from "../webhook.js";
import type * as DedupModule from "../dedup.js";

// ---------- Hoisted mocks ----------

const hoisted = vi.hoisted(() => ({
  refreshAvailability: vi.fn<() => Promise<unknown>>(() => Promise.resolve({})),
}));

vi.mock("../deploy-availability.js", () => ({ refreshAvailability: hoisted.refreshAvailability }));

// ---------- Test infrastructure ----------

class MockRequest extends EventEmitter {
  url?: string;
  method?: string;
  headers: Record<string, string>;

  constructor(
    headers: Record<string, string> = {},
    body?: Buffer | string,
  ) {
    super();
    this.url = "/api/github/webhook";
    this.method = "POST";
    this.headers = headers;
    process.nextTick(() => {
      if (body) this.emit("data", typeof body === "string" ? Buffer.from(body) : body);
      this.emit("end");
    });
  }
}

class MockResponse {
  statusCode = 200;
  headers: Record<string, string> = {};
  body = "";
  private resolver!: () => void;
  done = new Promise<void>((resolve) => {
    this.resolver = resolve;
  });

  writeHead(statusCode: number, headers: Record<string, string>): this {
    this.statusCode = statusCode;
    this.headers = headers;
    return this;
  }

  end(chunk?: string): void {
    this.body = chunk ?? "";
    this.resolver();
  }
}

function sign(secret: string, body: string | Buffer): string {
  const buf = typeof body === "string" ? Buffer.from(body) : body;
  return `sha256=${crypto.createHmac("sha256", secret).update(buf).digest("hex")}`;
}

function makeRequest(
  secret: string,
  event: string,
  payload: unknown,
  signWith?: string,
): { req: MockRequest; res: MockResponse } {
  const body = JSON.stringify(payload);
  const sig = sign(signWith ?? secret, body);
  const req = new MockRequest(
    {
      "x-hub-signature-256": sig,
      "x-github-event": event,
      "content-type": "application/json",
    },
    body,
  );
  return { req, res: new MockResponse() };
}

// ---------- Module isolation ----------

const SECRET = "test-webhook-secret";

let dbPath: string;
let webhook: typeof WebhookModule;
let dedup: typeof DedupModule;

beforeEach(async () => {
  vi.resetModules();
  dbPath = path.join(
    os.tmpdir(),
    `webhook-push-test-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`,
  );
  process.env.DEDUP_DB_PATH = dbPath;
  dedup = await import("../dedup.js");
  webhook = await import("../webhook.js");

  hoisted.refreshAvailability.mockReset();
  hoisted.refreshAvailability.mockResolvedValue({});
});

afterEach(() => {
  dedup.closeDb();
  try {
    fs.unlinkSync(dbPath);
  } catch {
    // ignore
  }
});

// ---------- Push event handling ----------

describe("push events", () => {
  const TARGET = {
    owner: "BuildDownAI",
    repo: "AI-Implement",
    branch: "testing",
    runningCommit: "1111111111111111111111111111111111111111",
  };

  // Not a default parameter for selfDeploy: `undefined` is a case under test.
  async function push(
    ref: string,
    selfDeploy: typeof TARGET | undefined,
    repository: { full_name?: string } = { full_name: `${TARGET.owner}/${TARGET.repo}` },
  ) {
    const { req, res } = makeRequest(SECRET, "push", { ref, repository });
    await webhook.handleGitHubWebhook(
      req as never,
      res as never,
      SECRET,
      "app-id",
      "private-key",
      selfDeploy,
    );
    await res.done;
    return res;
  }

  it("refreshes availability for a push to the watched repo and branch", async () => {
    const res = await push("refs/heads/testing", TARGET);

    expect(hoisted.refreshAvailability).toHaveBeenCalledWith({
      appId: "app-id",
      privateKey: "private-key",
      ...TARGET,
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ refreshed: true });
  });

  it("ignores a push to any other branch", async () => {
    const res = await push("refs/heads/main", TARGET);

    expect(hoisted.refreshAvailability).not.toHaveBeenCalled();
    expect(JSON.parse(res.body)).toEqual({ ignored: true });
  });

  it("ignores a tag push even when the tag shares the branch name", async () => {
    // refs/tags/testing must not be mistaken for refs/heads/testing — the reason
    // the ref is stripped by prefix rather than by taking the last path segment.
    const res = await push("refs/tags/testing", TARGET);

    expect(hoisted.refreshAvailability).not.toHaveBeenCalled();
    expect(JSON.parse(res.body)).toEqual({ ignored: true });
  });

  it("ignores a push when the image carries no self-deploy stamps", async () => {
    const res = await push("refs/heads/testing", undefined);

    expect(hoisted.refreshAvailability).not.toHaveBeenCalled();
    expect(JSON.parse(res.body)).toEqual({ ignored: true });
  });

  it("still answers 200 when the refresh fails, since the poll recomputes anyway", async () => {
    hoisted.refreshAvailability.mockRejectedValueOnce(new Error("HTTP 502"));

    const res = await push("refs/heads/testing", TARGET);

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ refreshed: false });
  });

  it("ignores a push from a different repository even when the branch matches", async () => {
    const res = await push("refs/heads/testing", TARGET, { full_name: "org2/AI-Implement" });

    expect(hoisted.refreshAvailability).not.toHaveBeenCalled();
    expect(JSON.parse(res.body)).toEqual({ ignored: true });
  });
});
