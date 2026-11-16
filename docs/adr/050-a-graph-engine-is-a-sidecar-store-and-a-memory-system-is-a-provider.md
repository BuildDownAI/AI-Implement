# 050. A graph engine is a sidecar store, and a memory system is a provider

**Status:** Accepted
**Date:** 2026-11-12
**References:** ADR 011, docs/kg-sidecar.md § "Memory provider contract", docs/kg-architecture.md, AII-1878

## Context

Two seams exist for a KG connector. The sidecar has a `Store` class (`kg_query/store.py` in the KG base) with one method that runs a SPARQL query; `KG_BACKEND` selects the store, and the orchestrator passes that value to the sidecar. The orchestrator has a `MemoryProvider` interface (`src/kg-provider.ts`); `MEMORY_PROVIDER` selects it, and `sidecar` is the only provider. `docs/kg-architecture.md` called the store seam "evaluated, not committed".

## Decision

1. An engine that holds our RDF graph is a `Store` in the sidecar.
2. A system with its own memory model is a `MemoryProvider` in the orchestrator.
3. A deployment on an external engine has no KG repo of its own. The image takes sidecar code from the base KG repo, and the orchestrator holds the access values.

## Consequences

- The store seam is committed. The seven `kg_*` tools stay written one time.
- The graph namespace can no longer come only from `sources.yml` in a customer repo.
- ADR 011's store row (rdflib to Oxigraph) stays valid; Stardog is one more store.
