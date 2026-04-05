# Plan 2: Bun FHIR Server

## Goal

Build a single-process Bun + TypeScript FHIR server over SQLite that:
- serves the synthetic corpus as one logical data store
- supports a deliberate US Core-aligned search subset
- enforces Permission Ticket constraints safely for `read` and `search`
- never leaks data outside the permitted slice, even when reference joins or limited chaining are supported

This replaces the earlier HAPI-proxy assumption in the meta-plan. The reference implementation should own its own query engine and authorization boundary rather than proxying to a general-purpose FHIR server.

## What This Plan Covers

- disk-to-SQLite ingest
- server-safe reminted ids
- site-partitioned views over one corpus
- permission compilation and query-time enforcement
- supported FHIR REST surface
- search indexing strategy
- temporal filtering semantics
- sensitive-data handling
- validation and demo behavior

## Non-Goals

- claiming complete US Core server conformance on day 1
- supporting every FHIR search parameter generically
- arbitrary FHIRPath evaluation on the query hot path
- bulk export, transactions, conditional update, history, subscriptions, or write APIs
- exposing local security-label codes or SQLite-specific concepts in the signed ticket spec

## Architecture

### Runtime

- one Bun server process
- one SQLite database
- one logical corpus containing all synthetic patients and all sites
- optional in-memory mode for demos; file-backed mode for local development

### Public Origin Configuration

Advertised SMART/OAuth/FHIR URLs and token audiences should come from an explicit configured public origin, not from request headers.

Recommended environment control:

- `PUBLIC_BASE_URL=https://smart-permission-tickets.example.org`

Use this configured origin for:

- SMART configuration `issuer`, `token_endpoint`, `registration_endpoint`, `introspection_endpoint`, and `fhir_base_url`
- issuer metadata and JWKS base URLs
- access token `aud`
- demo bootstrap issuer metadata
- any server-rendered example links or curls that present absolute public URLs

Do not derive the public origin from `X-Forwarded-*` headers in the default implementation. That creates ambiguous and potentially spoofable public URL construction. If a future deployment needs proxy-aware origin switching, it should be designed as a separate, explicitly constrained feature rather than the default path.

### URL Shape

The server should support a default root policy surface plus named alternate mode mounts.

Default root surface:

- global base: `/fhir`
- site base: `/sites/{siteSlug}/fhir`

Named alternate mode mounts:

- `/modes/{mode}/fhir`
- `/modes/{mode}/sites/{siteSlug}/fhir`

The site slug is not a separate database. It is a request-scoped partition applied before query execution.

Site scoping from the URL must be intersected with any ticket-derived site constraints. A request to `/sites/lone-star-womens-health/fhir` must never return data from any other site even if the ticket would otherwise allow it.

When a request is made through a site-specific FHIR base, that route should act as an additional narrowing constraint. A token minted for a site-specific surface should be audience-bound to that same site-specific FHIR base and should not be replayable against the global base or a different site base.

The root surface should use the default policy bucket, which should normally be `strict`. Alternate modes are opt-in via the `/modes/{mode}/...` prefix.

## SMART / OAuth Surface

The server should expose a standards-shaped SMART on FHIR surface even when running in a permissive demo mode.

## Permission Ticket Issuer Surface

Permission Tickets are public, cross-boundary artifacts. They should not be signed with a local symmetric secret.

The reference implementation should simulate issuer base URLs inside the same server stack, with a stable convention:

- issuer base: `/issuer/{issuerSlug}`
- per-issuer JWKS: `/issuer/{issuerSlug}/.well-known/jwks.json`

Each issuer record should have at least:

- `slug`
- display name
- ES256 signing keypair
- stable `kid`

The ticket `iss` claim should be the full issuer base URL, for example:

- `http://localhost:8091/issuer/reference-demo`

The issuer JWKS should expose the public key under that base URL so the signature is discoverable in the same way SMART Health Cards-style issuer keys are.

The server may also expose a demo-only ticket-signing helper endpoint under the issuer base, for example:

- `/issuer/{issuerSlug}/sign-ticket`

That helper is for the built-in demo tooling, not part of the Permission Ticket protocol itself.

### Required Endpoints

- `/.well-known/smart-configuration`
- dynamic client registration endpoint
- `/token` for RFC 8693-style token exchange
- token introspection endpoint

The server should also expose SMART configuration relative to each FHIR base:

- `/fhir/.well-known/smart-configuration`
- `/sites/{siteSlug}/fhir/.well-known/smart-configuration`
- `/modes/{mode}/fhir/.well-known/smart-configuration`
- `/modes/{mode}/sites/{siteSlug}/fhir/.well-known/smart-configuration`

The same auth endpoints should be available at both the global and site-specific auth bases, for example:

- `/modes/open/.well-known/smart-configuration`
- `/modes/open/token`
- `/modes/open/introspect`
- `/modes/open/sites/{siteSlug}/token`
- `/modes/open/sites/{siteSlug}/introspect`
- `/modes/open/fhir`
- `/modes/open/sites/{siteSlug}/fhir`

For a site-specific FHIR base, the advertised token / registration / introspection endpoints should be site-specific as well.

### SMART Configuration Extension Shape

Project-specific SMART configuration fields should live under one namespaced extension object rather than as ad hoc top-level keys.

Recommended shape:

```json
{
  "grant_types_supported": [
    "urn:ietf:params:oauth:grant-type:token-exchange"
  ],
  "smart_permission_ticket_types_supported": [
    "https://smarthealthit.org/permission-ticket-type/network-patient-access-v1"
  ],
  "extensions": {
    "https://smarthealthit.org/smart-permission-tickets/smart-configuration": {
      "permission_ticket_profile": "v2",
      "surface_kind": "site",
      "surface_mode": "strict"
    }
  }
}
```

`surface_kind` values:
- `global`
- `site`
- `network`

`surface_mode` values:
- `strict`
- `registered`
- `key-bound`
- `open`
- `anonymous`

These values should be derived from the actual mounted surface, not configured independently.

### Client Registration Model

Support both:
- pre-registered clients for stable demos
- dynamic registration for experimentation

Dynamic registration should be key-based by default, not symmetric-secret-first.

Preferred baseline:

- client registers a JWK or JWKS
- token endpoint authenticates the client with a private-key-based assertion
- when a Permission Ticket carries `cnf.jkt`, the server can verify that:
  - the ticket is bound to a key thumbprint
  - the caller proves possession of the matching private key

For this reference implementation, the intended dynamic-registration path should be:

- the client generates or is provisioned a keypair
- dynamic registration publishes the public key material
- the client keeps the private key locally
- token exchange authenticates with a private-key-based client assertion
- the server rejects exchange attempts that do not present the expected client assertion when the selected mode requires one

This is the cleanest way to ensure the token exchange caller is actually the client to which the ticket was issued.

Symmetric demo shortcuts may still exist for local development, but they should be treated as fallback/demo-only behavior rather than the primary registration model.

The implementation should support named policy buckets so the same server can expose a strict default surface and looser opt-in surfaces at the same time.

### Named Modes

The server should support a small fixed set of named modes rather than arbitrary path-encoded config.

Recommended:

- `strict`
- `registered`
- `key-bound`
- `open`

The root surface should behave as `strict`. The other modes should be available under `/modes/{mode}/...`.

### Token Endpoint Modes

The `/token` behavior should vary by named mode:

#### 1. Open demo mode

- no client assertion required
- unknown clients can exchange a valid Permission Ticket
- intended only for local development and simple demos
- best used when the ticket is not sender-constrained

#### 2. Key-bound mode

- if the Permission Ticket includes `cnf.jkt`, require proof from the matching key
- client registration should normally provide the public key material up front
- token exchange should require proof of possession from the corresponding private key
- recognition can still be based on key thumbprint alone when appropriate, without making a human-managed `client_id` foundational

#### 3. Registered-client mode

- accept pre-registered and dynamically registered clients
- validate client assertion using the registered key material
- still relatively permissive operationally

#### 4. Strict mode

- require a registered client
- require client authentication
- require consistency between client keying material and any `cnf` binding in the ticket

In practice, `strict` should prefer:

- dynamic or pre-registered JWK-based clients
- private-key client authentication
- enforcement that `cnf.jkt` in the ticket matches the authenticated client key

Intended strict-mode behavior:

- token exchange without a client assertion fails
- token exchange with an invalid or unverifiable client assertion fails
- token exchange with a key that does not match the registered client fails
- if the Permission Ticket carries `cnf.jkt`, token exchange with a non-matching client key fails
- only a correctly authenticated, correctly bound client can redeem the ticket

The important design point is that the endpoint shape stays standards-like while local policy controls how strict the server is. The URL should select from a small set of named behavior buckets, not carry arbitrary inline JSON or freeform mode configuration.

### Site-Bound vs Global Token Endpoints

There are two valid issuance contexts:

- global auth endpoints, such as `/token` or `/modes/open/token`
- site-specific auth endpoints, such as `/sites/{siteSlug}/token` or `/modes/open/sites/{siteSlug}/token`

Global token endpoints issue tokens usable against the matching global FHIR base for that mode. Site-specific token endpoints issue tokens further narrowed to exactly one site and audience-bound to that site-specific FHIR base.

This gives the implementation two clean behaviors:

- a client can obtain one cross-site token when the ticket authorizes multiple sites and then use the global FHIR base
- a client can obtain a site-specific token directly from a site-specific SMART configuration document and use only that site’s FHIR base

## Token Exchange And Access Token Shape

### Token Endpoint Behavior

The token endpoint should behave as an OAuth endpoint, not as a FHIR endpoint.

For the currently supported Permission Ticket flow:

- require `grant_type = urn:ietf:params:oauth:grant-type:token-exchange`
- require `subject_token_type = https://smarthealthit.org/token-type/permission-ticket`
- require `subject_token`
- require a supported Permission Ticket `ticket_type`
- if request `scope` is present, intersect it with the scopes granted by the Permission Ticket

Token failures should return OAuth-style JSON errors such as:

- `invalid_request`
- `invalid_grant`
- `invalid_scope`
- `unsupported_grant_type`
- `invalid_client`

### Access Token

The token exchange result should be a stateless signed JWT access token in a local server-defined format.

That access token should carry everything the FHIR server needs to authorize later requests without looking up server-side session state, including:

- issuer / audience / expiry
- granted SMART scopes
- resolved patient binding
- allowed patient aliases
- allowed sites
- allowed resource types
- date window + semantics
- sensitive mode
- any ticket identifiers needed for audit
- `cnf` binding when applicable

The `aud` claim should identify the exact FHIR base that the token is valid for:

- global base token -> global FHIR base audience
- site-specific token -> site-specific FHIR base audience

That way the server can reject replay of a site-specific token on the global base, or replay of a global token on a site-specific base when those are meant to be distinct authorization contexts.

### Local Permission Ticket Extensions

The reference implementation uses a small number of implementation-defined extensions under the ticket `details` object.

Current local fields:

- `details.dateSemantics`
- `details.sensitive.mode`

These should be documented as local extensions rather than implied to be base-spec fields.

## Viewer Handoff Boundary

The landing-page ticket builder should not hand impossible sites to the viewer.

Before building the viewer launch payload, the server should:

- validate the signed Permission Ticket
- compile the local authorization envelope
- intersect each requested site with the site-bound route rules
- drop any site that would fail site-specific token issuance, including sites left with zero visible encounters after filtering

This keeps the viewer handoff aligned with actual authorization behavior and avoids leaking unusable sites into the app.

### Token Introspection

The server should also support token introspection for issued access tokens.

Because the access tokens are stateless signed JWTs, introspection can be simple:

- validate signature
- validate issuer / audience / expiry
- validate `cnf`-related constraints when applicable
- return `active: true|false`
- mirror the relevant authorization claims from the token

That means introspection does not need a server-side token store for normal operation.

The introspection response should be shaped in a standards-recognizable way, while still returning the fields that matter for this implementation, for example:

- `active`
- `scope`
- `client_id` if known
- `sub`
- `aud`
- `exp`
- `iat`
- `patient`
- any locally useful mirrored authorization claims such as allowed sites, allowed resource types, date semantics, date window, and sensitive mode

This is mainly useful for:

- debugging demos
- inspecting compiled authorization envelopes
- confirming patient binding
- verifying that token exchange produced the expected constrained access token

### Why Stateless JWTs

- easy to inspect in demos
- no server-side session store required
- later FHIR requests can be authorized directly from token contents
- works well with sender-constrained tickets and key-bound clients

### Required Strict-Mode Test Coverage

The implementation and tests should treat strict-mode client binding as a first-class requirement, not optional polish.

Minimum coverage:

- missing client assertion -> token exchange rejected
- malformed or invalid client assertion -> token exchange rejected
- assertion signed by the wrong key for the registered client -> token exchange rejected
- `cnf.jkt` mismatch between Permission Ticket and authenticated client key -> token exchange rejected
- matching JWK-registered client plus correct private-key assertion -> token exchange succeeds

### Patient Binding

The token exchange process must resolve the ticket subject to an actual patient binding before issuing the access token.

At minimum:
- the access token should carry the resolved patient binding as claims
- the token response should return a `patient` value in the SMART style when a concrete patient is resolved

Because this implementation may authorize multiple site-qualified patient aliases for one logical person, the token should distinguish:

- `patient`
  - a concrete patient id returned in the token response for SMART-style client use
- internal patient-alias claims
  - the full site-qualified alias set used by the server for authorization

This lets the wire response stay familiar while the server still enforces the richer local authorization model.

### Subject Resolution Output

Subject resolution should therefore produce:

- zero matches -> token exchange fails
- one resolved patient context -> token issued with `patient` response field and matching claims
- multiple site-qualified aliases for the same authorized person -> token issued with the full alias set in claims; the implementation may still return a representative `patient` field where appropriate for the active base context

## The Key Boundary

### Signed Permission Ticket Claims

The signed ticket should remain a portable authorization artifact. In current repo terms, this is the layer represented by:

- `authorization.subject`
- `authorization.access.scopes`
- `authorization.access.periods`
- `authorization.access.organizations`
- `authorization.access.jurisdictions`
- ticket-type-specific `details`

This layer should stay independent of local storage and query implementation.

### Local Compiled Authorization Envelope

The FHIR server should not execute directly against the raw signed-ticket claims. It should first compile them into a normalized local envelope, for example:

- resolved site-qualified patient aliases
- allowed sites
- allowed resource types
- date window + semantics
- sensitive-data mode
- optional query-shaping constraints derived from ticket type or local policy

This is the layer documented in [ticket-input-spec.md](./ticket-input-spec.md).

### Why This Boundary Is Good

- the ticket spec stays portable
- the server can optimize freely
- the server can remint ids and normalize patient identity without changing the signed claims
- the implementation can evolve its internal authorization model without forcing spec churn

## Suggested Software Structure

The implementation should keep the core cutpoints explicit in code rather than collapsing them into one large Bun server module.

### Suggested Modules

- `ingest/`
  - load files from disk
  - remint deterministic server ids
  - rewrite references
  - populate SQLite and search indexes
- `auth/tickets/`
  - validate signed Permission Tickets
  - resolve subject
  - compile signed claims into the normalized local authorization envelope
- `auth/tokens/`
  - token exchange
  - stateless JWT minting and verification
  - token introspection
- `auth/clients/`
  - pre-registered clients
  - dynamic client registration
  - key-thumbprint recognition for `cnf`-bound flows
- `routing/modes/`
  - map root and `/modes/{mode}` surfaces to named policy buckets
- `policy/sensitive/`
  - map `sensitive.mode` to the local sensitive-category set
- `policy/dates/`
  - generated-window and care-window semantics
  - date-overlap evaluation
- `fhir/visible-set/`
  - compile request context + verified token claims into the request-scoped visible set
- `fhir/read/`
  - guarded `GET [type]/[id]`
- `fhir/search/`
  - supported search-parameter parsing
  - SQL generation only against the visible set
- `fhir/capability/`
  - CapabilityStatement
  - SMART configuration document

### Important Cutpoints

These boundaries should be reflected directly in the software:

1. signed ticket claims -> normalized local authorization envelope
2. normalized envelope -> stateless access-token claims
3. request URL + verified token -> visible-set materialization
4. visible set -> read/search/chaining execution
5. stored rows -> FHIR response shaping

If those cutpoints stay clean, the implementation can evolve internally without confusing spec-facing behavior with local query mechanics.

### Interfaces Worth Stabilizing Early

The exact function names can vary, but the plan should preserve these conceptual interfaces:

- `validatePermissionTicket(jwt, mode) -> ValidatedTicket`
- `resolveSubject(validatedTicket, db) -> SubjectResolution`
- `compileAuthorizationEnvelope(validatedTicket, subjectResolution, routeContext) -> AuthorizationEnvelope`
- `mintAccessToken(envelope, clientContext) -> string`
- `verifyAccessToken(jwt, routeContext) -> AuthorizationEnvelope`
- `introspectAccessToken(jwt) -> IntrospectionResult`
- `materializeVisibleSet(db, envelope, requestContext) -> VisibleSetHandle`
- `executeRead(db, visibleSet, requestContext) -> Resource | NotFound`
- `executeSearch(db, visibleSet, requestContext) -> Bundle`

### What Not To Over-Abstract

- do not build a generic FHIR ORM
- do not evaluate arbitrary FHIRPath on every request
- do not make every search parameter plugin-based before the subset is stable
- do not force the signed-ticket model and the local compiled envelope to share one TypeScript type

The plan should favor simple modules with explicit data handoff over framework-heavy abstraction.

## Upstream Spec Guidance

Experience from the spike suggests a few things that are good candidates for clearer upstream specification:

### 1. Sensitive sharing should be abstract, not label-coded

Good spec-facing shape:
- `sensitive.mode = deny|allow`

Bad spec-facing shape:
- raw `meta.security` code lists
- implementation-specific label slugs

The server can map `sensitive.mode` to an implementation-defined enumerated sensitive-category set.

### 2. Ticket time windows need explicit semantics

The implementation now distinguishes:
- `generated-during-period`
- `care-overlap`

The default should be explicit. For this reference implementation, the default is:
- `generated-during-period`

That means authored/recorded/document/issued timing, then encounter fallback, with interval overlap.

### 3. Subject resolution belongs before query execution

The signed ticket can identify a patient by match, identifier, or reference. The server should compile that into resolved local patient aliases before it executes FHIR queries. Local patient aliases should not be baked into the signed-ticket spec as the only subject model.

### 4. Granular category/code filters should stay narrow

The base ticket spec should keep SMART scopes and high-level constraints central. More granular query-shaping should remain ticket-type-specific or implementation-specific unless there is clear evidence that it belongs in the base ticket model.

## Data Model

### Resource Storage

Canonical source of truth:
- one row per served resource
- raw rewritten FHIR JSON stored in SQLite

Recommended `resources` columns:
- `resource_pk`
- `site_slug`
- `representative_patient_slug`
- `scope_class`
- `resource_type`
- `source_logical_id`
- `server_logical_id`
- `source_ref`
- `server_ref`
- `care_start`
- `care_end`
- `care_source_rule`
- `care_source_kind`
- `generated_start`
- `generated_end`
- `generated_source_rule`
- `generated_source_kind`
- `last_updated`
- `raw_json`

### Namespacing And IDs

The synthetic generator is allowed to emit human-readable local ids like `enc-000` and `enc-000-note`. Those are not globally safe.

At ingest time, the server should remint deterministic server ids:

- patient-scoped resources: namespace by site + source patient ref + resource type + source id
- site-scoped resources: namespace by site + semantic site-level key

Then rewrite all references using the reminted ids.

### Supporting Tables

- `resource_patient_memberships`
  - which site-qualified patient aliases can see a resource
- `patient_aliases`
  - maps source patient refs to reminted server patient refs
- `resource_tokens`
  - token/string-ish indexed search values
- `resource_refs`
  - normalized references for joins and chaining
- `resource_labels`
  - `meta.security` and selected derived demo labels, with organization/jurisdiction metadata computed from ingest context

## Temporal Model

Store two different windows:

### Generated Window

Used by default for ticket date filtering.

Definition:
- recorded/authored/document/issued timing where present
- otherwise encounter fallback
- interval overlap semantics

### Care Window

Stored separately for future explicit use cases where the ticket intends clinical-episode overlap rather than generated-data timing.

### Why Both Matter

Chronic conditions can have onset dates earlier than the encounter that documented them. Using onset/abatement alone for all ticket periods over-includes data. The generated window is the better default for permission filtering.

## Sensitive Data Model

### Public Contract

Public tickets expose only:

```json
"sensitive": {
  "mode": "deny"
}
```

or

```json
"sensitive": {
  "mode": "allow"
}
```

Default:
- `deny`

Semantics:
- unlabeled resources are non-sensitive
- only labels from the implementation's enumerated sensitive-category set count
- `deny` excludes resources carrying any sensitive label from that set
- `allow` includes them

### Internal Mapping

The server maps that simple mode onto the local sensitive label set. In the current corpus, real `meta.security` labels already include domains like:

- sexuality / reproductive health
- mental health
- HIV

The set should be enumerated in implementation code and mirrored in documentation, not exposed as a raw list in the ticket spec.

## Query Safety Model

This is the core design decision from the spike.

### Always Build A Visible Set First

For every request:

1. validate token
2. compile local authorization envelope
3. intersect URL site context, token scopes, ticket constraints, and request parameters
4. materialize `visible_resources`
5. execute search/read/chaining only inside `visible_resources`

Do not execute a broad query and filter only at the end.

### Implementation Shape

Use a request-scoped temp table or CTE:

```sql
CREATE TEMP TABLE visible_resources(resource_pk INTEGER PRIMARY KEY);
```

Populate it using:
- allowed patient aliases
- allowed sites
- allowed resource types
- date window semantics
- sensitive mode
- jurisdiction/org/tag filters
- granular category rules if applicable

Then every `read`, `search`, and chained join must start from `visible_resources`.

### Read Semantics

For `GET [type]/[id]`:
- resolve server id
- check membership in `visible_resources`
- if not visible, return `404`

This avoids leaking the existence of out-of-scope resources.

### Search Semantics

For `GET/POST [type]?...`:
- filter starting rows to `visible_resources`
- only then apply requested search parameters

### Chaining / Includes

Support only a whitelist of chain/include behaviors.

Every chained join must stay inside the visible set:
- starting resource must be visible
- joined target must also be visible

No join may be allowed to pull hidden resources into the response.

## Search Surface

### Initial Endpoints

- `GET /metadata`
- `GET /fhir/{type}`
- `POST /fhir/{type}/_search`
- `GET /fhir/{type}/{id}`
- same under `/sites/{siteSlug}/fhir`

### Initial Resource Types

- `Patient`
- `Encounter`
- `Observation`
- `Condition`
- `DiagnosticReport`
- `DocumentReference`
- `MedicationRequest`
- `Procedure`
- `Immunization`
- `ServiceRequest`
- `Organization`
- `Practitioner`
- `Location`

### Initial Search Parameters

Support a narrow, explicit subset aligned with demo needs and US Core expectations:

#### Patient

- `_id`
- `identifier`
- `family`
- `given`
- `name`
- `birthdate`
- `gender`

#### Observation

- `patient`
- `category`
- `code`
- `date`
- `status`
- `_lastUpdated`

#### Condition

- `patient`
- `category`
- `code`
- `clinical-status`
- `encounter`

#### DiagnosticReport

- `patient`
- `category`
- `code`
- `date`
- `status`

#### DocumentReference

- `patient`
- `category`
- `type`
- `date`
- `period`
- `status`

#### Encounter

- `patient`
- `class`
- `type`
- `date`
- `location`
- `status`

#### MedicationRequest

- `patient`
- `status`
- `intent`
- `authoredon`
- `encounter`

### Deliberate Exclusions For V1

- full generic SearchParameter execution
- arbitrary chaining
- generic `_include` / `_revinclude`
- write APIs

## Search Indexing Strategy

Do not rely on JSON traversal at query time for the hot path.

### Use SQLite For

- raw JSON storage
- reminted ids
- request-scoped temp tables
- indexed token/date/ref lookups
- constrained joins

### Use Declarative Extraction At Ingest

For dates:
- JSON rules files and simple path selectors now
- possibly FHIRPath later, but only at ingest time

For search params:
- hand-coded extraction first for the supported subset
- possibly generated from SearchParameter definitions later

## Validation Strategy

### Ingest Validation

- every resource parseable as JSON
- required `resourceType` and `id`
- all reminted ids unique
- all rewritten references resolvable or explicitly tolerated as external references

### Query Validation

- any `read` outside visible set returns `404`
- chained queries do not leak hidden rows
- site-base requests cannot escape their site partition
- date filtering uses the selected semantics consistently
- sensitive mode `deny` excludes all rows carrying enumerated sensitive labels

### Demo Validation Cases

At minimum:
- Elena with `sensitive.mode=deny` hides OB / reproductive data
- Elena with `sensitive.mode=allow` shows it
- Robert with `sensitive.mode=deny` hides HIV and MH-labeled rows
- Denise renal slice only returns NM nephrology data in the chosen date window
- a chained Observation-to-Encounter query stays within visible data

## Phased Implementation

### Phase 1: Loader + Visible Set Engine

- ingest synthetic FHIR into SQLite
- remint ids
- build normalized indexes
- compile local envelope from an already-normalized input
- implement guarded `read`

### Phase 2: Search Subset

- implement core read/search endpoints
- support the explicit resource/search matrix above
- support site-partitioned bases

### Phase 3: Token And Ticket Integration

- validate signed Permission Ticket JWT
- resolve subject
- compile ticket claims into the local envelope
- issue/validate access tokens

### Phase 4: Demo And CapabilityStatement

- advertise only the subset actually implemented
- wire into the demo dashboard
- show before/after filtered views

## Open Questions

- whether sensitive mode belongs in the base spec or remains ticket-type-specific details
- whether generated-time semantics should become an explicit upstream default
- how much granular category filtering should be standardized versus kept local
- whether site-partitioned base URLs should be externally visible in the demo or remain internal routing only

## Recommendation

Proceed with the Bun + SQLite server architecture and make the claim boundary explicit:

- signed ticket claims stay portable and spec-facing
- the data holder compiles them into a normalized local authorization envelope
- the FHIR server executes only against a request-scoped visible set

That preserves spec cleanliness while giving the implementation the freedom it needs to be safe, monitorable, and simple.
