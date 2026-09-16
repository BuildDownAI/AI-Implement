import { createServer, type Http2Server } from "node:http2";
import {
  createEndpointHandler,
  type ServiceDefinition,
  type VirtualObjectDefinition,
  type WorkflowDefinition,
} from "@restatedev/restate-sdk";

/**
 * No workflow has migrated onto Restate yet (ADR 017, ADR 018); this list stays
 * empty until the first run kind registers its workflow module here.
 */
export const services: Array<
  ServiceDefinition<string, unknown> | VirtualObjectDefinition<string, unknown> | WorkflowDefinition<string, unknown>
> = [];

export interface RestateEndpointAddress {
  host: string;
  port: number;
}

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 9080;

/**
 * Localhost-only by default: the Restate server reaches this endpoint over the
 * loopback interface as a sidecar on the same machine (ADR 023, AII-627). Only
 * the host/port are configurable here — exposing the bind beyond loopback is
 * the deploy issue's concern, not this module's.
 */
export function restateEndpointAddress(): RestateEndpointAddress {
  const host = process.env.RESTATE_ENDPOINT_HOST || DEFAULT_HOST;
  const port = Number(process.env.RESTATE_ENDPOINT_PORT) || DEFAULT_PORT;
  return { host, port };
}

export function createRestateEndpointHandler() {
  return createEndpointHandler({ services });
}

export interface RestateEndpointServer {
  host: string;
  port: number;
  server: Http2Server;
  close: () => Promise<void>;
}

export function listenRestateEndpoint(
  address: RestateEndpointAddress = restateEndpointAddress(),
): Promise<RestateEndpointServer> {
  const server = createServer(createRestateEndpointHandler());
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(address.port, address.host, () => {
      server.removeListener("error", reject);
      resolve({
        host: address.host,
        port: address.port,
        server,
        close: () => new Promise((res, rej) => server.close((err) => (err ? rej(err) : res()))),
      });
    });
  });
}
