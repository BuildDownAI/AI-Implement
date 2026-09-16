import { describe, expect, it } from "vitest";
import { service, type Context } from "@restatedev/restate-sdk";
import { connect } from "@restatedev/restate-sdk-clients";
import { RestateTestEnvironment } from "@restatedev/restate-sdk-testcontainers";
import { createRestateEndpointHandler, services } from "../restate/endpoint.js";

// Disarmed per AII-567: no live callback URL, no real token anywhere in this
// file. The global setupFile (clear-runner-credentials.ts) already deletes
// RUN_TOKEN / RUNNER_CALLBACK_URL / RUN_PROGRESS_TOKEN before every test, and
// nothing here reads or sets them.

const echoService = service({
  name: "restateHarnessEcho",
  handlers: {
    ping: async (_ctx: Context, input: string): Promise<string> => `pong:${input}`,
  },
});

// endpoint.ts's own `services` stays empty until the first workflow migrates
// (ADR 017, ADR 018); registering it here alongside the harness's trivial
// echo service proves the module's export shape and createRestateEndpointHandler
// call signature actually work, not just the SDK/testcontainers in isolation.
describe("Restate harness", () => {
  it("builds an endpoint handler from endpoint.ts's (empty) service set", () => {
    expect(services).toEqual([]);
    expect(typeof createRestateEndpointHandler()).toBe("function");
  });

  it(
    "boots RestateTestEnvironment and round-trips a call with alwaysReplay enabled",
    async () => {
      const environment = await RestateTestEnvironment.start({
        services: [...services, echoService],
        alwaysReplay: true,
      });
      try {
        const ingress = connect({ url: environment.baseUrl() });
        const result = await ingress.serviceClient(echoService).ping("hello");
        expect(result).toBe("pong:hello");
      } finally {
        await environment.stop();
      }
    },
    60_000,
  );

  it(
    "boots RestateTestEnvironment and round-trips a call with disableRetries enabled",
    async () => {
      const environment = await RestateTestEnvironment.start({
        services: [...services, echoService],
        disableRetries: true,
      });
      try {
        const ingress = connect({ url: environment.baseUrl() });
        const result = await ingress.serviceClient(echoService).ping("world");
        expect(result).toBe("pong:world");
      } finally {
        await environment.stop();
      }
    },
    60_000,
  );
});
