# Access model

Who may sign in to an orchestrator, and how that decision is made, stored, audited, and recovered.

This is the reference for `src/access-entries.ts`, `src/access-page-grants.ts`, `src/access-audit.ts`, `src/access-recovery.ts`, `src/oauth/authorize.ts`, and the authorization halves of `src/admin-session.ts` and `src/mcp.ts`. `CLAUDE.md` carries the summary and points here.

## The list

One row per entry in `access_entries`, keyed on `(kind, value)`:

| Column | Meaning |
|--------|---------|
| `kind` | `domain` (a whole email domain) or `address` (one person) |
| `value` | The domain or address, lowercased and trimmed on write |
| `role` | `user` or `admin` |
| `provider` / `subject` | Legacy. No longer read; kept so a rollback keeps working. Bindings live in `access_entry_bindings` (below) |
| `added_at` / `added_by` | When it was written, and the address of whoever wrote it |

Two rules are enforced at write time rather than left to the caller:

- **A domain admits as `user`. Only a listed address may be `admin`.** A domain entry saved with `admin` is refused. This is what makes "grandfather the existing identities as admin" a coherent instruction — a domain admits an unbounded set with nobody to enumerate.
- **The list is capped at 200 entries**, because it is scanned on every authenticated request.

## Where the list comes from

`OAUTH_ALLOWED_DOMAINS` and `OAUTH_ALLOWED_EMAILS` **seed** the allowlist. They apply while nothing is stored, and the **first save at `/admin#access` hands authority to the database permanently** — from then on the environment values are displayed on that page as stale, and never consulted.

The handover is deliberately operator-driven, never a boot-time migration. Two consequences worth knowing:

- An existing deployment that never opens the Access page behaves exactly as it did before the page existed.
- The fallback is a safety net, not a revert. An empty stored table means the environment values apply again, so a lost volume degrades to the seed rather than locking everyone out. Emptying the list deliberately is refused: the self-lockout guard sees a stored list that no longer admits its author.

## Sign-in providers

`providersFromEnv` (`src/oauth/providers.ts`) builds the list of OIDC providers once at boot,
and `configureOAuthProviders` seeds it. Each provider is an `OidcProviderConfig`: `id`,
`label`, `issuer` (the discovery base URL), `clientId`, `clientSecret`, `scopes`
(`openid email profile`). A provider is included only when it is fully credentialed, and
BuildDown is listed first because `/mcp/authorize` uses the first provider when the client names none:

| Provider | Env vars | Issuer |
|---|---|---|
| BuildDown | `BUILDDOWN_OIDC_ISSUER`, `BUILDDOWN_OIDC_CLIENT_ID`, `BUILDDOWN_OIDC_CLIENT_SECRET` | `BUILDDOWN_OIDC_ISSUER`, which must start with `https://` (otherwise the provider is left out with one boot warning) |
| Google | `GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET` | `https://accounts.google.com` |
| Microsoft | `MICROSOFT_OAUTH_CLIENT_ID`, `MICROSOFT_OAUTH_CLIENT_SECRET`, `MICROSOFT_OAUTH_TENANT` | `https://login.microsoftonline.com/<tenant>/v2.0` |

The control plane's set-up writes the BuildDown variables; a customer configures no SSO for it.
`loadConfig` (`src/index.ts`) drops Microsoft when `MICROSOFT_OAUTH_TENANT` is `common`,
`organizations` or `consumers`, because the email-verified rule holds only for a single-tenant
issuer. SSO also needs `OAUTH_REDIRECT_BASE_URL`; without it redirect URIs cannot be built.
A provider only proves who a person is. The allowlist above decides whether they get in.

## How a request is decided

```mermaid
flowchart TD
    R["Authenticated request<br/>(admin UI or /mcp)"] --> S{"Session or token<br/>valid?"}
    S -- no --> U["401"]
    S -- yes --> A{"Carries an<br/>address?"}
    A -- "no — access code" --> ADM["Admitted as admin<br/>(exempt from re-check)"]
    A -- yes --> L{"Allowlist<br/>readable?"}
    L -- "never loaded" --> E["503 — not 401,<br/>so nobody is signed out"]
    L -- yes --> M{"Matches an<br/>entry?"}
    M -- no --> D["401, and the<br/>session is revoked"]
    M -- yes --> R2{"Entry's role"}
    R2 -- admin --> ADM
    R2 -- user --> USR["Signed in.<br/>/mcp allowed;<br/>granted pages only"]
```

Matching runs in precedence order, and stops at the first hit:

| Order | Entry | Matches when |
|-------|-------|--------------|
| 1 | Address, bound for the identity's provider | The binding's `subject` equals the identity's `sub` |
| 2 | Address, unbound for the identity's provider | The entry's value equals the verified email; the callback then binds |
| 3 | Domain | The email's domain equals the entry's value |

A `builddown` identity may also be admitted by its organization role claim, which sits outside this table: see [Organization role from BuildDown](#organization-role-from-builddown).

An address entry outranks a domain entry: it is the more specific grant, and the only one that can carry `admin`. A malformed identifier with no `@` has a domain equal to itself, and is excluded from rule 3 so it cannot match a domain entry.

## Roles

`admin` may use every admin route, every declared `/mcp` write tool, and privileged `/mcp` reads whose handler role is `admin`. `user` may sign in, reach every user-role `/mcp` read tool, and open the read paths of whichever admin pages have been granted; every other `/api/` route answers 403, except the identity probe the SPA needs in order to know it is signed in, and a declared `/mcp` tool above the caller's role answers a role error. Nothing is granted until someone grants it, so a new deployment starts with `user` meaning user-role `/mcp` reads and nothing else. See [Page grants](#page-grants).

**A domain never confers `admin`, at any point — including while the environment seed is in force.** A domain grant asserts only that someone shares a domain with an operator, which an identity provider will issue to anyone it admits there: contractors, service accounts, a departed employee whose account still resolves. Granting administration on that basis turns authorization from a decision about a person into an attribute check, and the audit trail then records who acted while nobody ever decided that person could act. Adding one address is the entire cost of avoiding that.

An access-code session has no entry to take a role from and is treated as `admin`, because the code is a shared secret whose holder already has full access. It is still refused on the Access page, since a change to who gets in must be attributable to someone.

### A seed with no admin

A deployment configured with `OAUTH_ALLOWED_DOMAINS` alone admits everyone as `user`, so signing in succeeds and the whole admin UI answers 403. That is a **misconfiguration, not a lockout** — the recovery command is not involved, and the fix is to set `OAUTH_ALLOWED_EMAILS` and restart.

It is surfaced three ways, because the symptom otherwise looks like a broken UI rather than a setting: a `[main]` warning at boot, a banner on the sign-in page, and this document. A stored list cannot reach that state at all — the last-admin guard refuses a save that would leave it without one.

## Organization role from BuildDown

A person who signs in through the `builddown` provider is admitted on the `builddown_org_role` claim the control plane puts in the ID token when they belong to the organization that owns this orchestrator. `authorize()` (`src/oauth/authorize.ts`) turns it into a synthetic address entry for the verified email.

| Claim | Admitted as |
|-------|-------------|
| `owner` | `admin` |
| `admin` | `admin` |
| `member` | `user` |

- **`builddown` only.** The same claim from any other provider is ignored. `provider` is set by the callback route, never by the token.
- **Exact values only.** Any other value (wrong case, empty, a non-string, absent) is ignored, and the identity then needs a stored entry as before. The email must be verified.
- **A stored entry wins unless the claim is higher.** A stored `admin` entry plus a `member` claim admits as `admin`; a stored `user` entry or domain entry plus an `admin` claim admits as `admin`. Equal roles use the stored entry. This is the one route to `admin` without an address entry.
- **Never persisted as an entry.** Sign-in still binds through `AccessBinding` before admission and writes only the address's `builddown` row in `access_entry_bindings`, not an `access_entries` row. The fail-closed rules are the stored path's: `conflict` (a different `sub` for the same address) and `unavailable` (Restate unreachable) deny. Because the synthetic entry carries no bindings, every claim sign-in makes one `AccessBinding` call, so repeat sign-ins are also denied while Restate is down.
- **Removal takes effect at the next sign-in.** A token without the claim and without a stored entry is refused, even though the binding row remains. A role change likewise lands at the next sign-in.
- **Observability.** The `[oauth]` and `[mcp-oauth]` admit lines name the source, `stored` or `org-claim`.

- **Later requests.** Sign-in records the claim-granted role in `org_claim_roles` (keyed by address and provider, holding the `sub`) after the binding succeeds. `recheckIdentity` (admin sessions, `/mcp`), MCP refresh rotation and the Restate refresh authority consult it for `builddown` identities with the same `sub`, so a claim-admitted session is not refused on its next request. A sign-in through `builddown` without the claim, or a refusal, clears the row; until then an existing session or refresh chain stays valid, as a stored entry's removal is not instantaneous either. It is a role cache, not an allowlist entry: it is never listed or edited at `/admin#access`.

## Page grants

What a `user` may open beyond `/mcp`. Stored one row per page in `access_page_grants`, edited from the **User page access** control on `/admin#access`, and **empty until someone grants something**.

**Grants are global, not per-person.** One set applies to every `user` on the orchestrator. Per-user grants are unbuilt; the table is keyed on the page alone.

**Grantability is a property of the page, and lives only on the server.** `PAGE_ROUTES` in `src/access-page-grants.ts` maps each grantable page to the exact API paths it may read, and is the single definition of what can be granted — a page is grantable *because* someone declared what it reads. Two consequences follow without anyone maintaining a second list: a page added to the sidebar is ungrantable until it appears there, and an endpoint added later is Admin-only until it is listed.

Currently grantable: Issues, Pipelines, Pull requests, Blockers, Reports, Pipelines & steps, Sessions, Reaper, Audit log, Customizations. Read the constant rather than this sentence when it matters.

**A grant admits exact paths by `GET`, and nothing else.** Prefix matching is deliberately unsupported, because a prefix would also grant sub-paths added under it later — the opposite of failing closed. The useful consequence is that every mutating route stays Admin-only for free: `DELETE /api/dedup/{id}` is refused for a user holding the Audit grant, without anyone having to enumerate it.

**A page grant can include a read path that another page also uses, and granting that page then exposes that data too.** The current case: the Reports grant includes `/api/log`, the read behind the Pipelines page's Jobs card, so the Reports page can show the Agent attribution card. A user granted only Reports can therefore read the whole job log. The operator accepted this on 2026-10-09 ([AII-972](https://linear.app/eudoxus/issue/AII-972/show-agent-attribution-and-usage-availability-in-reports), PR #963); it is a decision, not an accident. Before adding a shared path to a grant, check what else that path returns.

### What grants do not restrict

**Page grants govern the admin UI. They do not govern what a user can read.** User-role `/mcp` reads are open to every allowlisted identity — a `user` granted nothing still reaches the project inventory, fleet report, tenant health, runner mode, and in-flight jobs. "Granted nothing" therefore means "no admin pages", never "sees nothing", and an operator deciding what to grant should treat user-role MCP reads as the floor rather than the ceiling. Privileged read tools, such as review-fix attempt/activity inspection, may still require `admin`. What a `user` cannot do over `/mcp` is write: the few write tools that exist there are on a declared list in `src/mcp.ts`, each with a required role resolved on every call, and everything else that mutates stays on the admin API (see [mcp-server.md](mcp-server.md), ADR 015).

This does not defeat the credential rule below: MCP's project listing selects its fields explicitly and omits `extraEnv`, so the runner environment values never leave through it.

### Credential-bearing pages

A page whose data includes credentials or infrastructure control is never grantable, and the grant editor **shows it greyed with the reason** rather than hiding it — so a client can see what exists and ask, rather than assume the page is missing.

The test for a page in this position: if it makes no sense without the sensitive data, it is permanently ineligible; if the sensitive part can be trimmed without harming what the page is for, converting it becomes a decision someone can make. Overview is the live example — it is excluded only because the project-mapping payload it reads carries `extraEnv`.

### Admin-only elements inside a granted page

Some controls sit on a page a `user` may open. They are withheld in the SPA by a `window.isAdmin()` check at each call site: the Audit page's dedup **Delete**, the Sessions page's **Destroy**, and the Pipelines row click that opens the job drawer.

These markers are **cosmetic only**. Each control calls a route that exact-path `GET` matching already refuses, so a marker someone forgets to add yields a 403, never a leak. The Pipelines drawer is the reason its row click is withheld rather than its endpoint granted: the drawer reads `/api/mappings`, which is the same `extraEnv`-carrying payload that makes Overview ineligible.

### Grants are not audited

`access_audit` covers the allowlist only. A grant change writes `granted_by` and `granted_at` on the row, but nothing reads them yet and the Access page's change log will never show a grant — even though both controls sit on that page. The provenance is stored in advance of the general audit facility, which is separate, unbuilt work.

### In the SPA

Three behaviors are worth knowing before reading `src/admin-ui/`:

- **The router does not route until the session identity has resolved.** A page's init runs exactly once, so a page rendered against an unknown role would keep that render for the life of the tab. `auth.js` calls `startRouting()` once the identity is known, and the router ignores every hashchange before that.
- **Ungranted nav items are hidden, not removed**, and the router treats a hidden item as unreachable — so typing the hash gains nothing over clicking. A `user` granted nothing lands on a page explaining that state rather than a blank panel.
- **The sidebar is computed once, at sign-in.** A grant changed mid-session does not appear until the user reloads. The server enforces the new set immediately either way, so the stale nav can only under-offer, never over-permit.

## Binding

An entry is **declared** by address and **matched** per provider once bound. `access_entry_bindings` holds one row per `(address, provider)` with the OIDC `sub`. The first successful sign-in through a provider binds that provider; from then on that provider matches on the `sub` alone, while a provider not yet bound still matches on the verified email. So one address can sign in through Google, BuildDown and Microsoft, each bound once.

- A **rename** keeps its role — the `sub` is stable across an address change.
- A **reassigned address inherits nothing** — per provider, a new holder presents a different `sub` and does not match.
- **Each provider binds once.** A later sign-in cannot re-point it at another subject.
- Domain entries never bind, because they admit many identities.

Binds go through the `AccessBinding` Restate virtual object (`src/restate/access-binding.ts`), keyed by the address. Its exclusive `bind` handler serializes two first sign-ins: the first returns `bound`, the second `conflict` and is refused (log `subject mismatch for <provider>`). **Fail closed:** if the Restate ingress is unreachable, sign-in is denied (log `binding unavailable`) and nothing is admitted without a recorded binding. Already-bound identities still match from the cache, but a first sign-in through a provider needs Restate. Each result logs one line (`bound`, `already-bound`, `conflict`, `unavailable`) with address and provider only. Entries that already carried a legacy `provider`/`subject` are copied into the table once at startup.

**The object is the single writer of bindings, for bind and for clear.** Its exclusive `clear` handler deletes the address's rows, nulls the legacy `provider`/`subject` columns and writes the `clear-bindings` audit entry in one `ctx.run` and one SQLite transaction, so a `bind` in flight when an admin clears is ordered before or after it, never interleaved. The admin route calls `clear` through the ingress and fails with an error if Restate is unreachable; it never falls back to a direct delete. Both `bound` and `already-bound` refresh this process's cached list (a stale cache would otherwise send the same identity through the ingress on every sign-in until the TTL expires); `conflict` and `unavailable` do not. Removing an entry deletes its bindings in the same transaction. The Access page lists each address's bound providers and has a **Clear bindings** action (admin only, audited as `clear-bindings`).

### Re-pointing a bound entry

When an address changes hands — someone leaves and their address is reassigned — the entry stays bound to the departed person's subject and the new holder matches nothing. They fall through to domain admission as `user`, or are denied outright.

**One save cannot fix it.** A save updates the role of a surviving entry and leaves its bindings alone, by design, since that is what lets a rename keep its role. The fix is two saves:

1. Remove the entry, and save. The row and its bindings are deleted. (Or use **Clear bindings** on the Access page to reset every provider at once.)
2. Add the address back, and save. It is inserted fresh and unbound, and binds again on the new holder's first sign-in.

The page shows the bound providers, but not their subjects. Check the audit trail or the `access_entry_bindings` rows if a newly-admitted person is being refused a role the list appears to give them.

## Re-checking, and freshness

Every authenticated request re-checks the identity against the list in force — the admin gate in `src/admin-session.ts` and the `/mcp` gate in `src/mcp.ts` share one matcher. A removal therefore ends a session on the requester's **next request**, rather than at token expiry, which for `/mcp` would otherwise be up to an hour.

The list is held in memory, so the re-check costs no query. It is re-read in two situations:

- **Immediately, on any write this process makes** — a save or a first-sign-in binding. Revocation through the admin UI is never delayed.
- **Once per poll interval otherwise**, bounded by `POLL_INTERVAL_MS`. This covers writes made by *another process* — in practice the recovery command — which cannot invalidate this process's cache.

That second case is why recovery needs no restart. It also means a hand-edit of the database converges within a poll instead of never.

**Grants are not cached, and deliberately so.** They are read from the table on each request that needs them, which is only ever a non-admin's — the admin check short-circuits before the read. A grant therefore takes effect on the next request with no window at all, and the query is confined to the sessions that a cache would have been protecting.

## Failure behavior

Authorization is **fail-closed**, and the two failure modes are deliberately different:

- **A read fails while a good list is cached** — the cached list keeps serving, and a warning is logged at most once per window rather than on every request. Nobody is ejected by a transient database fault.
- **A read fails with nothing ever cached** — the admin UI and `/mcp` deny, while polling and dispatch continue unaffected. The next request retries.

A denial caused by an unreadable list answers **503, never 401**. The distinction is load-bearing: the admin SPA treats 401 as "your session ended" and logs the user out, so returning 401 here would sign out every operator over a database hiccup.

## The audit trail

Every change to the list writes a row to `access_audit`: when, who, which action (`save` or `recover`), and a before/after snapshot of the list. Snapshots are narrowed to `{kind, value, role}` at write time, so no caller can widen what gets stored.

The trail has **no retention policy, deliberately** — it grows only when a human changes who can sign in, and pruning is the anti-goal for an audit record. It is scoped to access changes only; the general facility across every mutating admin route is separate, unbuilt work.

The Access page renders the recent entries, summarizing each as added / removed / role changed with counts.

## Guards on a save

- **Self-lockout** — a save whose resulting list would not admit its own author is refused.
- **Last admin** — a save whose resulting list has entries but no `admin` address is refused, so a stored list can never become unadministrable. An *empty* result is allowed by this guard, since that hands authority back to the environment rather than leaving nobody in charge — but no request can produce one: the route requires a signed-in identity, and the self-lockout guard then refuses a list that would not admit them. Emptying the table is a database operation, not an admin-UI one, which is what makes the handover in **Where the list comes from** permanent rather than merely sticky.
- **A signed-in identity is required.** `POST /api/access` answers 403 to a session with no address, because the change could not be attributed to anyone.

Self-lockout and last-admin both run *inside* the transaction and against the real post-write result, so neither can be fooled by predicting the outcome, and a refusal rolls the whole save back including its audit row. The shape rules above — a domain cannot be `admin`, and the 200-entry cap — are checked earlier, before the transaction opens.

## Recovery from lockout

When nobody can sign in, recovery is a **command run on the host**, not a credential:

```bash
fly ssh console -a <app>
node dist/access-recovery.js --email you@example.com          # add, keeping the existing list
node dist/access-recovery.js --email you@example.com --only   # replace the list entirely
```

There is no standing credential to steal: the authority is shell access, which already implies reading the database and every secret. The change is audited with a **null actor**, since nobody authenticated for it, and announced on the notification webhook if one is configured — a failed notification does not fail the recovery.

Adding an address already on the list **promotes** it rather than failing as a duplicate, which matters because a mangled role is one of the ways to get locked out. The change takes effect within one poll interval; no restart is needed.

## Access-code sessions

The deprecated `ADMIN_ACCESS_CODE` path remains for local development. Such a session carries no address, so it is **exempt from the re-check** — there is nothing to match — is treated as `admin`, and is **read-only on the Access page**, enforced server-side rather than only hidden in the UI.

On a BuildDown-managed orchestrator, `ADMIN_ACCESS_CODE` is a break-glass code that only BuildDown holds, for sign-in while the control plane is down. Removing the access-code path needs a replacement for that role (see [AII-856](https://linear.app/eudoxus/issue/AII-856/no-scripting-credential-for-the-admin-api-survives-the-access-code)).

Apart from that role, it holds no architectural responsibility, which is what keeps the deprecated path deletable.

## Not yet built

**A general audit trail.** `access_audit` covers the sign-in allowlist and nothing else. Every other mutating admin route — runner mode, mappings, secrets, deploy policy, dedup clearing, and page grants themselves — changes behavior with no record of who did it. The Audit log page's subtitle promises this and currently shows the dispatch dedup ledger.

**Per-person grants.** The grant set is global: every `user` on an orchestrator sees the same pages. The table is keyed on the page alone, so distinguishing two users means a schema change, not a setting.

**Re-pointing a bound entry in one step.** Today it takes a remove-then-add pair of saves, and binding state is never shown on the page. Surfacing which entries are bound, and letting a save clear a binding explicitly, are both open.

## Model-account and stage-configuration admin API (AII-962)

Admin-only: none of these paths is in `PAGE_ROUTES`, so a granted non-admin gets 403 on every one of them (a grant never reaches a non-GET anyway).

| Route | Purpose |
|---|---|
| `GET` / `POST /api/model-accounts`, `PATCH /api/model-accounts/:id` | Profile list (safe projection plus readiness, `credentialSet`, `credentialUpdatedAt`) and revision writes. Bodies carry metadata and a protected `credentialRef` only; any other key (`apiKey`, `session`, `token`, ...) is a 400. Reads never return `credentialRef`. |
| `PUT` / `DELETE /api/model-accounts/:id/credential` | Write-only API key for `openai-api-key` / `anthropic-api-key` profiles; body `{ "apiKey" }`, response `{ ref, result }`, value never returned or logged. Admin-only. |
| `POST /api/model-accounts/:id/chatgpt-pairing` | Mints a single-use, 15-minute pairing code for a `codex-subscription` profile (AII-1501); returns `{ code, expiresAt, command }` once and stores only the hash. Admin-only. |
| `GET /api/model-accounts/:id/chatgpt-status` | Admin-only; not in `PAGE_ROUTES`, so a page grant never reaches it. Returns `{ connected, email, secondsLeft, lastRefresh }` for a `codex-subscription` profile and never a token. The Models & Providers page calls it after pairing (AII-1501). |
| `POST /api/chatgpt-pairing/upload` | **Not behind the admin session gate**: routed in `src/index.ts` before it. The bearer pairing code is the only authentication (single use, bound to one profile, spent before the import runs); every unknown, expired, used or superseded code gets one fixed 401. Body limit 64 KB. |
| `GET` / `PUT /api/agent-defaults` | Orchestrator stage defaults. Validated against profiles in one transaction. |
| `GET` / `PUT /api/mappings/:key/agent-config` | Project opt-in (`enabled`) and partial stage overrides. A supplied field replaces the stored one, `null` returns it to inheritance, omitted fields stay. |
| `GET /api/mappings/:key/agent-config/resolved` | Actual values, per-field sources, resolution failure code, account readiness (`ready`, `sign-in required`, `refresh failed (transient)`, `missing`, `unknown`), and session recovery state for `claude-subscription` only. |

Ordinary mapping CRUD never reads `enabled` or `agentConfig`. Opt-in calls `inspectAgentReadiness` for the backend dispatch would use (`deps.agentConfig`, bound in `src/index.ts`) and refuses with 409/422 and a fixed code. GitHub Actions opt-in answers `unsupported_backend` until managed GHA credentials land (AII-1420/AII-970); template codes name the existing workflow sync. Claude subscription profiles cannot be opted in. Readiness is validated **before** anything is committed: the candidate project config is resolved read-only (`resolveCandidateProjectStageConfig`) and passed to `inspectAgentReadiness(request, deps, candidate)`, so a pending or refused inspection leaves the opt-in, config head and revision untouched. SQLite is synchronous, so no transaction spans the await; instead `readStageInputsFingerprint` (defaults head, project head, every profile's head revision, status and permissions) is taken before inspecting and re-checked inside the committing transaction (`setProjectStageConfig(..., expectedInputs)`). If any input moved, the PUT answers 409 `stale_inputs` and writes nothing, so stale readiness never overwrites a newer accepted write. PUTs for one project are also serialised. Dispatch checks readiness again.
