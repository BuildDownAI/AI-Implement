# Stored key safety

Every stored key kind adopts three rules:

1. Bind each reference to one destination through the `KeyBinding` Restate Virtual Object.
2. Check that destination at each use, before reading the secret.
3. Add a fixed redaction pattern for each recognizable key shape in `FIXED_REDACTION_PATTERNS`.

Model account keys are the first user. Their reference is `model-account:<name>` and their
plain string destination is `<provider>/<authMode>`, such as `openrouter/openrouter-api-key`.
No key value belongs in an object input, result, state, log or error. The admin HTTP handler
writes the secret locally; it sends only the destination through Restate ingress, whose
request and response bodies are journaled.

The Stardog Run token is the one non-model-account reference that
`model_protected_secrets` accepts, at `kg-store:stardog-run-token`. `POST /api/kg/stardog`
writes it. Only the KG sidecar child environment reads the token, as
`KG_STARDOG_RUN_TOKEN`. The admin page shows `tokenSet`, never the value, and the reference
has no `KeyBinding` destination. The constant lives in `src/kg-secret-refs.ts`;
[kg-sidecar.md](kg-sidecar.md) covers the stored values and how the token reaches the sidecar.

## Storage and handlers

`src/key-bindings.ts` provides the schema initializer and synchronous reader.
`initKeyBindingsTable` creates `key_bindings` at boot with `CREATE TABLE IF NOT EXISTS`.
There is no backfill. The object is the only production writer; synchronous reads use
`readKeyBinding` on the shared SQLite connection.

| Column | Meaning |
|---|---|
| `key_ref` | Primary key; also the object key |
| `destination` | One required destination string |
| `bound_at` | Binding time in epoch milliseconds |

Both handlers are exclusive and execute one SQLite transaction in one `ctx.run`.

| Handler | Input | Result |
|---|---|---|
| `bind` | `{ destination }` | Missing row: insert and `bound`; same destination: `already-bound`; different destination: `conflict`, unchanged |
| `clear` | `{}` | Delete the row and return `{ removed }` (1 or 0) |

The ingress helpers have a five-second timeout and log each result with the reference
and, for bind, destination. They never log key values or raw failures.

Admin credential mutations and profile PATCH operations share a process queue, including
both the ingress round trip and local writes. References can be shared across profiles.
Each ingress helper registers a random operation token in `key_binding_operations`
(`operation_id` primary key, `key_ref`) and sends it as a transport header. The object
checks this fence inside its mutation transaction. The helper removes the token on
completion or timeout, so a delayed invocation cannot mutate a subsequent binding.
Tokens also belong to a process epoch: a restart invalidates outstanding old tokens.
Handler bodies remain destination-only for bind and empty for clear; no secret enters Restate.
DELETE also clears an unowned fallback reference, allowing recovery after a failed
profile revision save left a harmless orphan binding.

## Fail closed

Admin credential PUT binds the head revision's destination before storing anything.
Conflict returns 409; unavailable ingress returns 503. Neither stores a key. A successful
binding may survive a later storage failure or a timeout; a binding without a key is harmless.

DELETE removes the secret first, then clears through the object. A clear failure returns
a sanitized 503 and leaves the binding available for a retry. It never restores the key.

`secret-delete` refuses a key stored on Models & providers that has a destination binding; remove it there or with `DELETE /api/model-accounts/:id/credential`.
To repair an account whose key was deleted by an older `secret-delete`, send
`DELETE /api/model-accounts/:id/credential` to clear the remaining binding.

PATCH refuses a provider or auth mode change while retaining a reference backed by either
a binding or a protected-secret row, including an unreadable secret. Remove the stored key
first. A manually selected reference bound to another destination also returns 409.
Identity and status edits still work when the binding matches.

Checkout checks the binding after validating the reference and before resolving a secret.
A destination mismatch returns `account_mismatch` without a secret read. Legacy keys without
a binding keep their existing behavior, including environment imports. Their next PUT
establishes the binding; `importEnvironmentCredential` is unchanged.

## Adopting the pattern

Choose a reference namespace and canonical destination string for the new key kind. Use
`bindKey` before storing, `clearKeyBinding` after deleting, and `readKeyBinding` before every
secret use. Guard metadata edits that could redirect a stored key. Add the key shape to
fixed evidence redaction and test conflicts, unavailable ingress, deletion ordering and
secret-free mismatch failures. Only admin HTTP handlers call the new object today; do not
add calls from existing Restate handlers during this deployment.

Rollback leaves the table in place; reverted code ignores it.
