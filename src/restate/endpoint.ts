// The SDK endpoint for the run lifecycle's durable-execution engine (ADR 017, ADR 018).
// No run kind has migrated onto Restate yet, so the service set stays empty until the
// first workflow module registers here. The Restate server (AII-627) reaches this
// endpoint by push, over HTTP/2 — nothing else calls it, which is why the bind
// address defaults to loopback. The deploy issue (AII-627) is what enforces that this
// endpoint is never reachable from outside the machine; this module only exposes the
// address as configurable so that enforcement has something to point at.
import * as http2 from "node:http2";
import { createEndpointHandler } from "@restatedev/restate-sdk/node";
import type {
  ServiceDefinition,
  VirtualObjectDefinition,
  WorkflowDefinition,
} from "@restatedev/restate-sdk";

export type RestateService =
  | ServiceDefinition<string, unknown>
  | VirtualObjectDefinition<string, unknown>
  | WorkflowDefinition<string, unknown>;

// Empty until a run kind's workflow module registers here (ADR 018 case 1: kg-refresh).
export const RESTATE_SERVICES: RestateService[] = [];

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 9080;

export interface RestateBindAddress {
  host: string;
  port: number;
}

export function restateBindAddress(): RestateBindAddress {
  const host = process.env.RESTATE_ENDPOINT_HOST?.trim() || DEFAULT_HOST;
  const rawPort = process.env.RESTATE_ENDPOINT_PORT?.trim();
  const parsedPort = rawPort === undefined || rawPort === "" ? NaN : Number(rawPort);
  const port = Number.isFinite(parsedPort) ? parsedPort : DEFAULT_PORT;
  return { host, port };
}

export function createRestateEndpointHandler(services: RestateService[] = RESTATE_SERVICES) {
  return createEndpointHandler({ services });
}

// Starts the SDK endpoint as an HTTP/2 server. Not called from orchestrator boot yet —
// the sidecar server and the registration call that would make this reachable are
// AII-627's scope.
export function startRestateEndpoint(
  services: RestateService[] = RESTATE_SERVICES,
): Promise<http2.Http2Server> {
  const { host, port } = restateBindAddress();
  const server = http2.createServer(createRestateEndpointHandler(services));
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => resolve(server));
  });
}
