# ADR 011: keep the deterministic RDF KG as the memory basis; adopt per-layer; expose a memory-provider socket

**Status:** Accepted

**Date:** 2026-08-25

**References:** KGB-2 (web-docs ingest chain), AII-324 (orchestrator-served KG), AII-424 (refresh decoupling), BDS-25/BDS-39 (learnings conventions)

---

## Context

AI-Implement ships into many companies' environments, with a multi-tenant model coming: any
company deploys the orchestrator and a knowledge graph over its own data. Beyond GitHub and
Linear, customers will eventually bring sources such as Jira/Confluence, Google Docs, and
SharePoint — which sources, we learn only when a customer asks.

An evaluation (2026-08, two passes — one defending the incumbent, one actively trying to
replace it) compared the current KG against the open AI-memory landscape: Graphiti/Zep
(bi-temporal graph memory, LLM extraction, Neo4j-backed), Onyx (enterprise search, 40+
connectors with per-user ACL syncing), Mem0/OpenMemory (agentic session memory), Cognee
(modular ECL memory pipelines), GraphRAG/LightRAG (LLM entity-graph RAG), and store-level
alternatives (Oxigraph, property-graph engines).

Three product constraints were settled during the evaluation:

1. **Tenant-level isolation is sufficient.** One graph per tenant is one trust boundary;
   per-user source-ACL retrieval is not required now.
2. **Self-hosted first**, managed tier later ("both, tiered"). Per-tenant infrastructure must
   stay light — a Neo4j-class service per customer is not acceptable ops weight.
3. **Deterministic-first ingest.** Structured sources ingest at zero token cost; LLM
   extraction is acceptable only as an opt-in, metered tier for unstructured sources.

---

## Decision

**The existing knowledge-graph architecture remains the memory basis.** Its defining
combination — deterministic zero-token ingest of structured dev sources, SHACL-enforced
provenance on every semantic node, git-committed diffable snapshots, curated learnings
comments as memory writes, and OAuth-gated MCP serving — exists in no surveyed alternative,
and each settled constraint independently favors it.

Adoption happens **per layer**, not wholesale:

| Layer | Strategy |
|---|---|
| Structured dev ingestion (git, GitHub, Linear, Jira) | Keep — deterministic spine is the moat |
| Unstructured enterprise sources + connectors | Adopt — MCP-sourced ingestion first; Onyx-class machinery only if per-user ACLs become required |
| Graph model, provenance, snapshot transport | Keep — RDF + SHACL + TriG parts in git |
| Store engine | Keep the model; swap rdflib → Oxigraph (embedded, RocksDB, TriG-compatible) when multi-tenant load demands |
| Serving (`/mcp`, OAuth, refresh tokens, allowlists) | Keep — production-hardened product surface |
| Temporal facts | Borrow Graphiti's bi-temporal idea as RDF validity intervals when a real question demands it |
| LLM extraction | Opt-in metered tier behind the provider interface, never in the deterministic spine |

**A memory-provider interface is the strategic complement.** The de-facto contract is the
five read tools the skills consume (hybrid search, neighbors, path, provenance, staleness
stamp). Formalized in the pattern of `src/providers/` (Linear/Jira), our KG becomes provider
#1, and an external system (Graphiti/Zep, Onyx, a customer's existing memory) can back the
same contract — with capability flags for tools it cannot serve. We compete with these
systems and interoperate with them through the same socket.

---

## Alternatives considered

- **Rebase on Graphiti/Zep** — best-in-class temporal model, but LLM extraction on every
  ingest (cost, non-determinism, memory that can misremember), a Neo4j dependency per
  self-hosted tenant, and no enforced provenance. Rejected as basis; its bi-temporal model is
  worth borrowing natively in RDF.
- **Rebase on Onyx** — the strongest connector + per-user-ACL machinery in open source, but
  it is enterprise search, not a knowledge graph: no relations, no provenance, no
  deterministic spine. Rejected as basis; becomes the adoption candidate for the ACL tier if
  that requirement arrives.
- **Mem0 / Letta-class session memory** — a different layer (agent/session memory), not an
  institutional KG. Complementary, never a replacement.
- **GraphRAG / LightRAG / Cognee** — LLM entity extraction over corpora that, for us, are
  already structured. Pays tokens for flexibility we do not need. Their global-summary idea
  (community summaries) is worth borrowing as derived subsystem cards.
- **Build nothing new; continue exactly as-is** — rejected in the narrow sense: the provider
  socket, MCP-sourced ingestion, and the Oxigraph path are real adoptions the evaluation
  surfaced.

---

## Consequences

- The multi-tenant KG story stays deployable as files + Python in the orchestrator image;
  no new per-tenant service.
- Three work items follow this ADR: the memory-provider interface (AII), the MCP-source
  ingester (KGB), and the Oxigraph spike (KGB). Filed parked; promoted on demand.
- Customer-brought memory systems integrate through the lanes worked out below — never by
  displacing the orchestrator's operational GitHub/Linear access.
- The zero-token, provenance-enforced, self-hostable combination is the stated competitive
  position against Zep/Mem0/GraphRAG-class systems.

---

## Worked example: a customer arrives with a GBrain vault + MCP server

The expected near-term case. Three integration lanes; the third is a redirect.

### Lane 1 — GBrain as a knowledge *source* (works today, no new code)

GBrain's substance is a git-backed markdown vault — the shape the spine ingester already
eats. Clone the vault as a sibling checkout, add it to the tenant KG's `sources.yml` under
`secondary_repos:`, refresh. Every vault page becomes a `Doc` node with title + snippet;
their "Compiled Truth" pages become searchable cards next to the tenant's issues and PRs.
This is the day-one answer: their source of truth is files in git, and files in git are our
native food. The MCP-server route (reading the vault through their server instead of git) is
what the MCP-source ingester (KGB-12) adds — needed only when the customer will expose the
MCP endpoint but not the repo.

### Lane 2 — GBrain as the memory *provider* (after the provider interface, AII-433)

If the customer wants GBrain to *be* the memory rather than feed ours: an adapter maps the
five-tool contract onto GBrain's search. State the capability flags up front — GBrain can
serve hybrid-search-shaped queries over its pages, but it has **no equivalent of
`kg_neighbors`, `kg_path`, or `kg_provenance`**: no typed graph, no enforced provenance.
Skills degrade gracefully (the dual-target rules already handle missing capabilities), but
recon quality drops: no issue-relation walks, no provenance chains, no exact-key boost over
typed Issue nodes. Sellable as "your memory, our discipline — with these named gaps."

### Lane 3 — "use GBrain for GitHub and Linear access": no, redirect it

The likely customer misconception. GBrain's MCP server exposes memory pages *about* GitHub
and Linear (webhook-fed timelines), not GitHub and Linear themselves. The orchestrator's
operational core — polling for labeled issues, dispatching runs, opening PRs, callbacks,
completing tickets on merge — needs real API access with real credentials (the GitHub App,
the Linear client-credentials app). No memory system, ours included, sits in that path.

The legitimate instinct underneath is **avoiding double ingestion**. If their GBrain already
ingests Linear/GitHub events, offer the choice explicitly: keep both (recommended — GBrain
pages ride in as Lane-1 Doc nodes *alongside* our typed, related, provenanced
Issue↔PR↔Commit spine, which their compiled pages cannot replicate and which costs zero
tokens, so the duplication is nearly free), or Lane 2 with the named capability losses.

One-line version: "Point us at your GBrain repo and it is searchable inside AI-Implement the
same day; if you want GBrain to be the memory engine itself, that is the provider socket
with three named capability gaps; and the pipeline's GitHub/Linear operations keep their own
credentials regardless."
