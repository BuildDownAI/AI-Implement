# Runner network reach

Who can open a connection to whom, for each runner backend. The orchestrator's Restate server
makes only outbound calls; all its listeners bind loopback.

## The orchestrator

The Restate sidecar binds ingress `127.0.0.1:8081`, admin `127.0.0.1:9070`, and the node port
`127.0.0.1:5122` (`src/restate/server.ts`). The orchestrator's own SDK endpoint binds
`127.0.0.1:9080` by default (`RESTATE_ENDPOINT_HOST`, `src/restate/endpoint.ts`). The Restate
server signs each request with the request-identity key, and an SDK endpoint checks it with
`identityKeys`.

The orchestrator's HTTP server (`server.listen(config.healthPort)`, `src/index.ts`) is the one
listener that is not loopback-bound, so a container can reach it through the host gateway. The
Restate listeners above stay on loopback and are not reachable from a container.

## Local Docker

A local runner container starts with `--add-host host.docker.internal:host-gateway`
(`buildDockerRunArgs`, `src/local-docker.ts`), so it reaches the orchestrator at
`http://host.docker.internal:<port>`. In serve mode the container also publishes its Restate
port on the host loopback only (`-p 127.0.0.1::9080`; Docker picks the host port, read back with
`docker port`). Inside the container the runner listens on `::` port 9080. The orchestrator's
Restate server calls the runner there, signed; the runner refuses unsigned calls. Outside serve
mode the container publishes no port.

The listener and signature check are supplied by AII-2034; this issue only adds the launch
plumbing that publishes the port and passes the identity key. `--add-host` gives the container a
hostname for the host gateway; it does not by itself make a loopback-bound host listener
reachable.

## Fly

The [AII-2038 probe](https://linear.app/eudoxus/issue/AII-2038/decide-aii-2028-and-prove-that-the-orchestrator-can-call-a-fly-session)
(2026-11-23) verified the following behavior. A session machine has no `services` entry;
port 9080 is reachable only on the Fly private network. The orchestrator and its sessions
app are on one Fly private network. A request with no signature gets `401`.

The orchestrator registers the runner at `http://<machineId>.vm.<appName>.internal:9080`.
Restate server 1.7 cannot register a bracketed IPv6 address: its admin returns
`META0003 … h2 pool connection error: unknown host name`. The probe registered and called
the same machine using the Fly hostname. After a hard stop of the machine, the caller
received its terminal failure in about 10 seconds; this is a probe observation, not a
runtime guarantee.

For new pairs, a new orchestrator and its sessions app share their own Fly network
([AII-2056](https://linear.app/eudoxus/issue/AII-2056/plan-a-new-orchestrator-and-its-fly-runners-share-their-own-private)).
The testing orchestrator stays on the default network until
[CON-149](https://linear.app/eudoxus/issue/CON-149/move-the-testing-orchestrator-to-its-own-network-then-explore-the).

## GitHub Actions

A GitHub-hosted runner has no inbound address. It reaches the orchestrator only through the
public URL.
