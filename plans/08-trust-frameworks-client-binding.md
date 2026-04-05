# Plan 8: Trust Frameworks and Client Identity Binding

## Goal

Extend the reference implementation so it can authenticate and reason about clients and ticket issuers through multiple trust-framework models rather than only through locally registered JWKs.

This plan adds two closely related capabilities:

- framework-aware client authentication and registration
- framework-aware ticket binding and issuer trust

The immediate implementation targets are:

- unaffiliated dynamic registration
- `well-known:<uri>` clients with no registration
- UDAP-flavored dynamic registration and client authentication

OpenID Federation is explicitly deferred, but this plan should leave a clean abstraction boundary for it.

## Why This Plan Exists

The current reference implementation is intentionally narrow:

- a client dynamically registers a bare JWK
- the server wraps that JWK into a signed `client_id`
- token exchange authenticates with `private_key_jwt`
- ticket binding is only `cnf.jkt`

That proves possession of a key, but it does not give the server a reusable notion of:

- which trust framework, if any, the client belongs to
- which framework an issuer belongs to
- how to resolve authoritative framework metadata
- how to rotate keys without breaking every ticket binding

This plan introduces a common framework abstraction so the server can answer questions like:

- does this entity belong to TEFCA?
- is this issuer recognized by the SMART Health Issuers allowlist?
- which keys are currently valid for this client entity?
- does the authenticated client satisfy the ticket's intended binding?

## Scope

### Implement Now

- a framework abstraction shared by client auth and issuer trust
- configured framework registry with instance URIs and types
- support for framework-backed client identity binding in tickets
- `well-known:<uri>` client identifiers with no registration
- unaffiliated dynamic registration for one-off clients
- UDAP-flavored dynamic registration and client assertion validation
- SMART configuration extension advertising supported frameworks and binding types

### Defer

- OpenID Federation implementation
- multiple client bindings in one ticket
- CRL / OCSP revocation for UDAP certificate chains
- framework-specific remote metadata databases beyond the first local/configured implementations
- a normative multi-framework interoperability story outside the local spec draft

## Implemented Stories

The current reference implementation now needs to support four concrete stories:

- **Unaffiliated client**: dynamic JWK registration, `private_key_jwt`, optional `cnf.jkt`, local issuer trust.
- **`well-known` client**: no registration, `client_id=well-known:<uri>`, keys resolved from `/.well-known/jwks.json`, optional framework affiliation by allowlist.
- **UDAP client**: UDAP dynamic registration plus token-time certificate validation, with framework selection by trust evaluation of the submitted chain and SAN URI.
- **Framework-backed issuer**: ticket `iss` resolves through the shared framework abstraction to published JWKS and trust-framework membership, while the existing local `/issuer/{slug}` registry continues to work.

## Relationship To Existing Plans

This plan is intentionally cross-cutting.

- It extends [02-fhir-server.md](./02-fhir-server.md) by replacing the current JWK-only client model with a framework-aware client identity model.
- It extends [04-trusted-issuer.md](./04-trusted-issuer.md) by reusing the same framework abstraction for issuer trust.
- It extends [06-demo-client.md](./06-demo-client.md) and [07-demo-client-remediation.md](./07-demo-client-remediation.md) by changing how the demo viewer identifies and authenticates clients.
- It will require updates to [ticket-input-spec.md](./ticket-input-spec.md) because framework-backed client binding is part of the signed ticket input contract.

## Decisions Already Made

These points are treated as fixed for this plan:

- `cnf` remains the binding mechanism for frameworkless clients.
- Framework-backed binding is expressed with a separate `client_binding` object, not by overloading `cnf`.
- The spec-facing wire structure should be:

```json
{
  "client_binding": {
    "binding_type": "framework-entity",
    "framework": "https://example.org/frameworks/tefca",
    "framework_type": "udap",
    "entity_uri": "https://acme.example.org"
  }
}
```

- `client_binding` and `cnf.jkt` may coexist.
- If both are present, both must pass.
- `binding_type` currently has one defined value, `framework-entity`, and is retained to leave room for later binding families without changing the object shape.
- In the reference implementation, `well-known:<uri>` is a literal client identifier that can be recognized without prior registration.
- `well-known:<uri>` may contain a subpath, not only a bare origin.
- Framework metadata is authoritative.
- Entity metadata is not trusted except for key material resolution.
- Membership and key resolution should be re-evaluated with cache TTL, default 1 hour.

## Spec-Facing Model

### Frameworkless Binding

For clients outside any trust framework, keep the current sender-constrained story:

```json
{
  "cnf": {
    "jkt": "..."
  }
}
```

This remains useful for:

- one-off demo apps
- single-developer ecosystems
- cases where the issuer wants to bind to an exact key

### Framework-Backed Binding

For framework-backed clients, bind to an entity recognized within a framework:

```json
{
  "client_binding": {
    "binding_type": "framework-entity",
    "framework": "https://example.org/frameworks/smart-health-issuers",
    "framework_type": "well-known",
    "entity_uri": "https://clinic.example.com"
  }
}
```

Semantics:

- `framework` identifies the framework instance, not just a framework family.
- `framework_type` tells the verifier which resolution/authentication family applies.
- `entity_uri` identifies the client entity inside that framework.
- The ticket does not require that these fields appear verbatim as the OAuth `client_id`.
- `binding_type` is currently always `framework-entity`; it is kept so future profiles can add other binding families without introducing a second top-level claim shape.

### Mixed Binding

If a ticket contains both:

- `client_binding`
- `cnf.jkt`

then the verifier must require both:

- the authenticated client resolves to the framework/entity named by `client_binding`
- the authenticated key also matches `cnf.jkt`

This is expected to be unusual, but it gives a strict profile when needed.

## Reference Implementation Model

The reference implementation needs an internal canonical principal even though the spec does not require one.

Use both:

- a structured in-memory representation for evaluation
- a derived canonical string for cache keys, logs, and compact comparisons

Recommended in-memory shape:

```ts
type AuthenticatedClientIdentity = {
  authMode: "unaffiliated" | "well-known" | "udap";
  framework?: {
    uri: string;
    type: "well-known" | "udap";
  };
  entityUri?: string;
  clientId: string;
  publicKeys: JsonWebKey[];
  leafJwkThumbprint?: string;
  certificateThumbprint?: string;
};
```

The canonical string is a derived implementation detail only.

## Framework Abstraction

Add a shared framework subsystem under a new module such as:

- `src/auth/frameworks/`

Recommended concepts:

- `FrameworkRegistry`
- `FrameworkDefinition`
- `FrameworkResolver`
- `ResolvedFrameworkEntity`
- `IssuerTrustDecision`

Every framework type should expose common operations:

- resolve client entity membership
- resolve current client keys
- resolve framework-authoritative metadata
- authenticate client assertion
- resolve issuer membership
- resolve issuer signing keys when applicable

The abstraction should be shared by:

- token endpoint client authentication
- ticket issuer trust validation

Capability flags are enough for now.

Example:

```ts
type FrameworkDefinition = {
  framework: string;
  frameworkType: "well-known" | "udap";
  supportsClientAuth: boolean;
  supportsIssuerTrust: boolean;
  cacheTtlSeconds: number;
};
```

## Framework Config

Add `frameworks` to server config.

Recommended shape:

```json
{
  "frameworks": [
    {
      "framework": "https://example.org/frameworks/tefca",
      "framework_type": "udap",
      "supports_client_auth": true,
      "supports_issuer_trust": true,
      "cache_ttl_seconds": 3600,
      "udap": {
        "trust_anchors": ["... PEM or path ..."]
      }
    },
    {
      "framework": "https://example.org/frameworks/smart-health-issuers",
      "framework_type": "well-known",
      "supports_client_auth": true,
      "supports_issuer_trust": true,
      "cache_ttl_seconds": 3600,
      "well_known": {
        "allowlist": [
          "https://clinic.example.com",
          "https://example.org/demo/client-a"
        ],
        "jwks_relative_path": "/.well-known/jwks.json"
      }
    }
  ]
}
```

Implementation note:

- Start with JSON config plus framework-type-specific classes.
- Do not build a generic plugin marketplace here.

## Client Authentication Modes

### 1. Unaffiliated Dynamic Registration

Keep the current stateless registration model as the fallback path for clients that are not using a framework.

Behavior:

- client posts JWK or JWKS
- server validates and stores it in a signed, restart-safe client descriptor
- issued `client_id` lives in the server namespace
- token exchange authenticates with `private_key_jwt`

This replaces the current implicit assumption that all registered clients are equivalent. These are specifically unaffiliated registered clients.

### 2. `well-known:<uri>` Clients

Add a no-registration path:

- the client sends `client_id=well-known:<uri>`
- the server parses `<uri>`
- the server checks configured `well-known` frameworks for membership
- if a matching framework is found, classify the client under that framework
- if no matching framework is found, still recognize it as an unaffiliated `well-known` client
- resolve keys from `<uri>/.well-known/jwks.json`

Rules:

- HTTPS or secure local origin only
- fail closed if fetch fails and no valid cache is available
- allow redirects for now
- cache by HTTP headers with local default / max policy

The server should treat the entity as:

- framework-affiliated when it matches a configured framework allowlist
- otherwise unaffiliated but still valid if the `well-known:` identifier is well-formed and resolvable

Reference-implementation wire identifier:

- `client_id=well-known:<uri>`

This wire form is local to the reference implementation. The corresponding spec-facing ticket binding remains the structured `client_binding` object.

### 3. UDAP-Flavored Dynamic Registration

Add a UDAP registration path over `/register`.

To stay close to real UDAP clients, the server should recognize the standard UDAP registration discriminator and request shape:

```json
{
  "udap": "1",
  "software_statement": "eyJ..."
}
```

Behavior:

- parse software statement JWT
- validate `x5c` chain against configured trust anchors
- extract and validate SAN URI
- determine which configured UDAP framework, if any, accepts the request
- if exactly one configured UDAP framework accepts the request, use it
- if zero configured UDAP frameworks accept the request, reject
- if more than one configured UDAP framework accepts the request, reject as ambiguous
- mint a server-namespaced `client_id` for the UDAP client
- persist framework/entity metadata inside a signed stateless descriptor or equivalent

Framework selection is intentionally not carried as a UDAP request extension. The server should evaluate the submitted certificate chain, SAN URI, and any configured community-specific trust rules against each configured UDAP framework and select the unique match, if any.

At token time:

- client authenticates with a UDAP-compatible client assertion
- server re-validates the cert chain and SAN
- server reconstructs the authenticated framework/entity identity

For phase 1:

- support `x5c`
- do full chain validation
- require SAN URI
- leave CRL / OCSP for later

UDAP discovery:

- If the implementation goal is interoperability with real UDAP clients, expose `/.well-known/udap` metadata on relevant auth surfaces.
- The initial implementation does not need full FAST / UDAP ecosystem breadth, but it should expose enough metadata for a real UDAP client to find the registration and token endpoints and understand that UDAP registration is supported.
- If one auth surface participates in multiple UDAP trust communities, the metadata endpoint should support the FAST / HL7 `?community=` query parameter so the client can discover community-specific certificates and metadata. This is discovery-time selection, not a registration or token-request extension.

Reference-implementation UDAP `client_id` format:

- return `client_id` values as `udap:<signed-descriptor>`
- the signed descriptor should carry at least:
  - framework
  - framework type
  - entity URI derived from SAN
  - current registered/public trust material needed by the stateless server

This keeps the returned identifier server-namespaced, restart-safe, and unambiguous while avoiding nested-URI parsing problems.
It also keeps the UDAP identity split explicit:

- registration-time organizational identity comes from the certificate SAN URI
- token-time `iss` / `sub` in the client assertion are the server-assigned `client_id`
- ticket `client_binding.entity_uri` for UDAP should be matched against the SAN-derived entity URI, not the server-assigned `client_id`

## Ticket Validation Changes

The current ticket validator in `auth/tickets.ts` only understands ticket issuer validation and `cnf`.

Extend it to:

- parse `client_binding` when present
- carry `client_binding` through the normalized authorization envelope
- compare `client_binding` against the authenticated client identity at token exchange time

Recommended comparison rules:

- if no `client_binding`, skip framework-entity comparison
- if `client_binding` is present, require exact match on:
  - `framework`
  - `framework_type`
  - `entity_uri`
- if `cnf.jkt` is present, require thumbprint match
- if both are present, require both

For UDAP-authenticated clients specifically:

- `framework` and `framework_type` come from the configured UDAP framework that accepted the presented chain
- `entity_uri` comes from the validated SAN URI on the leaf certificate
- the server-assigned UDAP `client_id` is used for RFC 7523 / UDAP token authentication, but is not the value compared to `client_binding.entity_uri`

## Framework-Aware Error Behavior

OAuth error codes should stay standard, but the descriptions should distinguish framework failures from key-binding failures.

Examples:

- `invalid_client` + `error_description="Client entity https://acme.example.org is not recognized in framework https://example.org/frameworks/tefca"`
- `invalid_client` + `error_description="UDAP certificate SAN does not match registered entity URI"`
- `invalid_grant` + `error_description="Ticket client binding requires framework https://example.org/frameworks/tefca entity https://acme.example.org"`
- `invalid_grant` + `error_description="Client key does not match ticket binding"`

The implementation should also record richer structured diagnostics internally for logs and debugging.

## Issuer Trust Changes

The current issuer model is local and configured in-process.

Keep that working, but make the issuer trust path framework-aware.

Examples:

- a local issuer registry entry still works
- a framework may assert that an issuer entity is trusted
- the same framework subsystem may resolve issuer keys or validate issuer membership

This affects:

- ticket `iss` validation
- issuer metadata / JWKS resolution
- future external issuer federation work

## SMART Configuration Changes

Extend the SMART configuration extension namespace to advertise:

- supported client binding types
- supported frameworks

Recommended addition:

```json
{
  "extensions": {
    "https://smarthealthit.org/smart-permission-tickets/smart-configuration": {
      "permission_ticket_profile": "v2",
      "surface_kind": "global",
      "surface_mode": "strict",
      "supported_client_binding_types": [
        "cnf:jkt",
        "framework-entity"
      ],
      "supported_trust_frameworks": [
        {
          "framework": "https://example.org/frameworks/tefca",
          "framework_type": "udap"
        },
        {
          "framework": "https://example.org/frameworks/smart-health-issuers",
          "framework_type": "well-known"
        }
      ]
    }
  }
}
```

Do not advertise registration-mode details here unless they become necessary later.

## Impact On The Reference Implementation

### Server

The server plan in [02-fhir-server.md](./02-fhir-server.md) currently centers JWK registration and private-key auth.

This plan changes that center of gravity:

- JWK registration becomes the unaffiliated fallback path
- framework-backed client auth becomes a first-class concept
- the token endpoint must authenticate clients through a resolver pipeline, not a direct JWK lookup
- the `RegisteredClient` model must expand to carry framework/entity identity

### Trusted Issuer

The issuer plan in [04-trusted-issuer.md](./04-trusted-issuer.md) currently assumes a local issuer registry and later possible federation.

This plan provides the shared abstraction needed for that later federation story:

- framework resolution can apply to issuers as well as clients
- issuer trust can remain local today but move under the same framework layer

### Demo Client

The demo client plans [06-demo-client.md](./06-demo-client.md) and [07-demo-client-remediation.md](./07-demo-client-remediation.md) assume the viewer primarily registers a JWK and uses `private_key_jwt`.

This plan changes the viewer inputs and flows:

- the viewer may use `well-known:<uri>` without registration
- the viewer may dynamically register under UDAP
- the viewer still needs the current JWK registration path for unaffiliated demos
- artifact inspection should show framework resolution and authenticated principal details, not only decoded JWK registration responses

### Ticket Input Contract

The normalized ticket input contract in [ticket-input-spec.md](./ticket-input-spec.md) must grow to include `client_binding`.

That contract should keep the spec-facing shape rather than leaking the server's internal canonical client namespace.

## Spec Changes

Some of this work is not just a local server change. It changes the Permission Ticket spec shape.

### 1. Add `client_binding`

Add a new optional top-level claim:

```json
{
  "client_binding": {
    "binding_type": "framework-entity",
    "framework": "https://example.org/frameworks/tefca",
    "framework_type": "udap",
    "entity_uri": "https://acme.example.org"
  }
}
```

This is distinct from:

- `sub`
- `requester`
- `cnf`

It identifies the intended redeeming client as a framework-recognized entity, not as a key.

### 2. Preserve `cnf` For Key Binding

Do not redefine `cnf`.

Keep `cnf` for exact proof-of-possession style constraints such as:

- `cnf.jkt`

Framework-backed binding is a different concept and should stay outside `cnf`.

The narrative spec should say this explicitly because reviewers familiar with RFC 7800 will otherwise ask why `client_binding` exists at all.

Recommended explanation:

- `cnf` expresses key-level proof-of-possession constraints.
- `client_binding` expresses entity-level trust-framework membership.
- These are orthogonal concerns and may coexist in one ticket.

The narrative should also explicitly note that this profile is intentionally not using `cnf.jku` for framework-backed binding because `jku` names a JWK Set URL, while `client_binding` names an authenticated framework entity that may resolve keys through framework-specific rules.

### 3. Define Combined Semantics

The spec should define:

- `client_binding` alone means the client must authenticate as the named framework/entity
- `cnf.jkt` alone means the client must prove possession of the exact key
- if both are present, both must pass

### 4. Update Logical Model

Update [input/fsh/PermissionTicket.fsh](../../input/fsh/PermissionTicket.fsh) to represent the new field.

Suggested direction:

- add `client_binding 0..1 BackboneElement`
- include `binding_type`, `framework`, `framework_type`, and `entity_uri`

### 5. Update Narrative Spec

Update [input/pagecontent/index.md](../../input/pagecontent/index.md) to cover:

- framework-aware client authentication
- `client_binding`
- coexistence with `cnf`
- examples for:
  - unaffiliated exact-key binding
  - `well-known` framework binding
  - UDAP framework binding

### 6. Update Conformance Language

Data Holder requirements should expand to say:

- if `client_binding` is present, the Data Holder SHALL authenticate the client as the named framework/entity
- if both `client_binding` and `cnf` are present, the Data Holder SHALL enforce both

Client and issuer requirements should expand to say:

- issuers MAY bind a ticket to a framework-recognized client entity using `client_binding`
- issuers SHOULD use `client_binding` when the identity target is intended to survive key rotation

## Execution Style

This plan should be executed as a checklist, not as a loose narrative.

For each phase:

- complete the code tasks
- complete the phase-specific tests
- update this document by checking off completed items
- do not start the next phase until the current phase has a clear exit state

Implementation should prefer incremental compatibility:

- preserve the current JWK-only path until the framework-aware path is proven
- land internal abstractions before landing new wire behavior
- keep tests green at each step

## Phased Implementation Checklist

### [x] Phase 1: Core Types, Config, and Abstraction Boundary

Objective:
- introduce the internal trust-framework model without changing external behavior yet

Primary file targets:
- `reference-implementation/fhir-server/src/store/model.ts`
- `reference-implementation/fhir-server/src/auth/clients.ts`
- `reference-implementation/fhir-server/src/auth/tickets.ts`
- `reference-implementation/fhir-server/src/app.ts`
- new `reference-implementation/fhir-server/src/auth/frameworks/*`

Checklist:
- [x] add framework-aware types to `src/store/model.ts`
- [x] add an internal authenticated-client identity shape separate from the current `RegisteredClient`
- [x] add framework config shape and parsing
- [x] create a new `src/auth/frameworks/` area for registry / resolver logic
- [x] define a framework registry interface
- [x] define a framework resolver interface
- [x] define a resolved-entity result shape shared by client auth and issuer trust
- [x] refactor current JWK registration lookup behind the new abstraction without changing behavior
- [x] keep current unaffiliated dynamic registration working exactly as before

Exit criteria:
- [x] server still supports existing dynamic JWK registration
- [x] existing token exchange behavior is unchanged for current tests
- [x] framework abstractions exist and the current unaffiliated path still works

### [x] Phase 2: Ticket Model and Spec-Wire Support

Objective:
- teach the server and spec artifacts about `client_binding`

Primary file targets:
- `reference-implementation/fhir-server/src/auth/tickets.ts`
- `reference-implementation/fhir-server/src/store/model.ts`
- `reference-implementation/plans/ticket-input-spec.md`
- `input/fsh/PermissionTicket.fsh`
- `input/pagecontent/index.md`

Checklist:
- [x] add `client_binding` to the TypeScript `PermissionTicket` type
- [x] add `client_binding` to the normalized authorization envelope
- [x] parse and validate `client_binding` in ticket handling
- [x] enforce combined semantics for `client_binding` and `cnf.jkt`
- [x] update `ticket-input-spec.md` so internal compiled input can carry client binding information where needed
- [x] update the logical model in `PermissionTicket.fsh`
- [x] update narrative spec text in `index.md`
- [x] add at least one example ticket using `client_binding`
- [x] add explanatory spec text distinguishing `client_binding` from `cnf`

Exit criteria:
- [x] ticket parsing accepts framework-backed bindings
- [x] ticket validation rejects malformed or inconsistent bindings
- [x] spec docs and examples no longer describe `cnf.jkt` as the only client-binding path

### [x] Phase 3: `well-known:<uri>` Client Path

Objective:
- support no-registration clients whose keys come from `/.well-known/jwks.json`

Primary file targets:
- `reference-implementation/fhir-server/src/app.ts`
- `reference-implementation/fhir-server/src/auth/clients.ts`
- new `reference-implementation/fhir-server/src/auth/frameworks/well-known.ts`

Checklist:
- [x] recognize `client_id=well-known:<uri>` on token requests
- [x] parse and validate allowed `well-known` URI forms
- [x] enforce HTTPS or secure local origin rules
- [x] fetch `/.well-known/jwks.json` relative to the entity URI
- [x] add caching for JWKS fetches
- [x] classify the client as framework-affiliated when it matches a configured framework allowlist
- [x] classify the client as unaffiliated `well-known` when it does not match a configured framework but remains resolvable
- [x] fail closed when the JWKS cannot be obtained and no valid cache entry exists
- [x] surface authenticated framework/entity identity to ticket validation

Exit criteria:
- [x] a `well-known:<uri>` client can authenticate without registration
- [x] framework-affiliated and unaffiliated `well-known` flows are both distinguishable internally
- [x] ticket `client_binding` can match a `well-known` client entity

### [x] Phase 4: SMART Config and Framework Advertisement

Objective:
- advertise the new trust-framework capabilities on SMART surfaces

Primary file targets:
- `reference-implementation/fhir-server/src/app.ts`
- `reference-implementation/fhir-server/src/network-directory.ts`

Checklist:
- [x] extend SMART configuration extension output with supported binding types
- [x] extend SMART configuration extension output with supported frameworks
- [x] ensure site and mode surfaces advertise the same framework information consistently where appropriate
- [x] verify global, site, and network SMART config surfaces remain coherent after the change

Exit criteria:
- [x] SMART config advertises framework-aware capabilities on all intended surfaces
- [x] existing SMART config fields remain correct

### [x] Phase 5: UDAP Registration

Objective:
- add standards-shaped UDAP dynamic registration

Primary file targets:
- `reference-implementation/fhir-server/src/app.ts`
- new `reference-implementation/fhir-server/src/auth/frameworks/udap.ts`
- possibly `reference-implementation/fhir-server/src/auth/clients.ts`

Checklist:
- [x] accept UDAP registration requests using the standard `udap=1` request shape
- [x] parse software statement JWT
- [x] validate JWT signature using leaf cert from `x5c`
- [x] validate X.509 chain to a configured trust anchor
- [x] validate SAN URI and software statement `iss` / `sub`
- [x] evaluate the request against configured UDAP frameworks
- [x] accept when exactly one framework matches
- [x] reject when zero frameworks match
- [x] reject when more than one framework matches
- [x] mint server-namespaced UDAP `client_id` values as `udap:<signed-descriptor>`
- [x] encode framework, framework type, and SAN-derived entity URI in the signed descriptor
- [x] preserve re-registration semantics for same SAN URI with renewed or rotated certs

Exit criteria:
- [x] a standards-shaped UDAP registration succeeds for a trusted chain
- [x] framework selection comes from trust evaluation, not request extensions
- [x] renewed certs with the same SAN URI can update the effective registration state

### [x] Phase 6: UDAP Token Authentication and Discovery

Objective:
- support token-time UDAP client authentication and UDAP metadata discovery

Primary file targets:
- `reference-implementation/fhir-server/src/app.ts`
- new `reference-implementation/fhir-server/src/auth/frameworks/udap.ts`

Checklist:
- [x] accept UDAP token requests carrying `udap=1`
- [x] validate UDAP client assertions with `x5c`
- [x] revalidate chain and SAN on token requests
- [x] verify token-time `iss` / `sub` against the registered UDAP `client_id`
- [x] reconstruct framework and SAN-derived entity identity at token time
- [x] expose `/.well-known/udap`
- [x] include enough metadata for a real UDAP client to discover registration and token endpoints
- [x] add support for `?community=<uri>` where one auth surface participates in multiple UDAP trust communities
- [x] support community-specific certificate / metadata selection at discovery time

Exit criteria:
- [x] a registered UDAP client can authenticate at `/token`
- [x] community discovery is available where configured
- [x] ticket `client_binding.entity_uri` for UDAP is matched against SAN-derived identity, not server-assigned `client_id`

### [x] Phase 7: Issuer Trust Reuse

Objective:
- reuse the same framework abstraction for ticket issuer trust

Primary file targets:
- `reference-implementation/fhir-server/src/auth/tickets.ts`
- `reference-implementation/fhir-server/src/auth/issuers.ts`
- new or expanded `reference-implementation/fhir-server/src/auth/frameworks/*`

Checklist:
- [x] route issuer trust through the shared framework abstraction where appropriate
- [x] allow configured frameworks to validate issuer membership
- [x] allow configured frameworks to resolve issuer signing keys where appropriate
- [x] preserve current local issuer registry behavior as a fallback
- [x] keep issuer-trust decisions visible in logs / diagnostics

Exit criteria:
- [x] local issuer trust still works
- [x] at least one framework-backed issuer-trust path works through the shared abstraction

### [x] Phase 8: Cleanup, Docs, and Demo Integration

Objective:
- finish the user-facing and maintainer-facing surface after the core mechanics are in place

Primary file targets:
- `input/pagecontent/index.md`
- `input/fsh/PermissionTicket.fsh`
- `reference-implementation/plans/00-metaplan.md`
- `reference-implementation/plans/references/*.md`
- `reference-implementation/fhir-server/ui/*` as needed

Checklist:
- [x] update examples and docs to show unaffiliated, `well-known`, and UDAP stories
- [x] update demo UI artifact inspection to show framework resolution details where useful
- [x] update reference notes if implementation decisions differ from the current open questions
- [x] remove stale wording that implies only JWK registration exists
- [x] ensure the metaplan summary still matches the detailed plan

Exit criteria:
- [x] docs, examples, and demo surfaces reflect the implemented behavior
- [x] Plan 08 can be used as the current source of truth

## Testing Checklist

Execution model:
- use `bun test` in `reference-implementation/fhir-server` for automated coverage
- extend existing route-level tests in `reference-implementation/fhir-server/test/modes.test.ts`
- keep resolver tests deterministic with local fixtures and in-process HTTP handlers
- avoid live network dependencies in automated tests

### [ ] A. Test Harness and Fixtures

Primary file targets:
- `reference-implementation/fhir-server/test/*`
- new `reference-implementation/fhir-server/test/fixtures/*`
- new `reference-implementation/fhir-server/test/helpers/*`

Checklist:
- [ ] add fixture JWKS documents
- [x] add fixture PEM / DER certificate chains for at least two UDAP frameworks
- [x] add helpers to mint software statements in tests
- [ ] add helpers to mint UDAP client assertions in tests
- [ ] add helpers to advance time or override cache timestamps
- [x] add local HTTP handlers for `well-known` JWKS responses
- [ ] add local HTTP handlers for UDAP metadata responses

### [ ] B. Unit Tests

Recommended target files:
- new `reference-implementation/fhir-server/src/auth/frameworks/*.test.ts`
- `reference-implementation/fhir-server/src/auth/tickets.test.ts` if added

Checklist:
- [ ] test `client_binding` parsing and validation
- [ ] test coexistence of `client_binding` and `cnf.jkt`
- [ ] test canonical authenticated-principal derivation
- [x] test `well-known:<uri>` parsing and normalization
- [x] test invalid `well-known:<uri>` forms
- [ ] test framework-registry selection rules
- [x] test UDAP framework selection from chain + SAN + configured framework definitions
- [ ] test binding comparison for exact `framework`
- [ ] test binding comparison for exact `framework_type`
- [ ] test binding comparison for exact `entity_uri`
- [ ] test AND semantics when both `client_binding` and `cnf.jkt` are present
- [ ] test cache TTL behavior with fake time

### [ ] C. Resolver / Component Tests

Checklist:
- [ ] affiliated `well-known` resolution succeeds
- [ ] unaffiliated `well-known` resolution succeeds when JWKS is resolvable
- [ ] `well-known` JWKS rotation is honored after cache expiry
- [ ] `well-known` fetch failure fails closed without cache
- [ ] `well-known` fetch failure uses warm cache when still valid
- [ ] redirect handling behaves as intended
- [ ] UDAP valid chain resolves one framework
- [ ] UDAP untrusted chain resolves no framework
- [ ] UDAP ambiguous chain resolves multiple frameworks and is rejected
- [ ] SAN URI extraction works for expected certs
- [ ] renewed or re-keyed cert with same SAN URI is accepted appropriately
- [ ] mismatched SAN URI vs stored registration identity is rejected
- [ ] unsupported or disallowed signing algorithms are rejected according to phase-1 policy

### [ ] D. End-to-End Server Tests

Primary file target:
- `reference-implementation/fhir-server/test/modes.test.ts`

Checklist:
- [x] SMART config advertises supported trust frameworks and binding types
- [x] `well-known:<uri>` clients can redeem tickets without prior registration
- [x] affiliated `well-known` clients resolve to the expected framework
- [x] unaffiliated `well-known` clients still authenticate when resolvable
- [ ] strict failure occurs when `well-known` JWKS resolution fails without cache
- [x] UDAP registration succeeds with a trusted chain and standard `udap=1` request shape
- [x] UDAP registration fails for untrusted chain
- [x] UDAP registration fails for bad software-statement signature
- [x] UDAP registration fails for SAN mismatch
- [x] UDAP registration fails for ambiguous framework match
- [x] UDAP token request succeeds with `udap=1` and valid `client_assertion`
- [x] UDAP token request fails when token-time chain no longer validates
- [x] UDAP token request fails when SAN no longer matches registered entity
- [x] ticket redemption succeeds for matching `well-known` `client_binding`
- [x] ticket redemption succeeds for matching UDAP `client_binding`
- [x] ticket redemption fails for mismatched framework
- [ ] ticket redemption fails for mismatched entity URI
- [ ] mixed binding succeeds only when both `client_binding` and `cnf.jkt` match
- [ ] mixed binding fails when either `client_binding` or `cnf.jkt` fails
- [x] issuer trust reuse works through the shared framework abstraction
- [x] `/.well-known/udap` discovery endpoint is exposed when configured

### [ ] E. Discovery / Community Tests

Checklist:
- [x] default `/.well-known/udap` response is valid
- [x] `/.well-known/udap?community=<uri>` selects the expected certificate / metadata set
- [x] unknown `community` is handled per configured behavior
- [x] community-specific metadata can steer which UDAP framework a client should attempt
- [x] non-community discovery remains stable when no `community` parameter is supplied

### [ ] F. Negative / Error Tests

Checklist:
- [ ] framework-not-recognized errors are surfaced clearly
- [ ] entity-not-recognized-in-framework errors are surfaced clearly
- [ ] JWKS fetch failure errors are surfaced clearly
- [x] UDAP chain-untrusted errors are surfaced clearly
- [x] UDAP SAN mismatch errors are surfaced clearly
- [x] ambiguous UDAP framework-match errors are surfaced clearly
- [x] ticket `client_binding` mismatch errors are surfaced clearly
- [x] `cnf.jkt` mismatch errors are surfaced clearly

### [ ] G. Manual Interop Checklist

Checklist:
- [ ] curl `/.well-known/udap` and inspect metadata
- [ ] curl `/.well-known/udap?community=<uri>` where configured
- [ ] register a UDAP client with a real-looking software statement and `x5c`
- [ ] redeem a ticket using a `well-known:<uri>` client id
- [ ] show ticket failure after JWKS rotation or framework mismatch
- [ ] confirm demo surfaces remain understandable after the new auth paths are added

### [ ] H. Phase Gate for Implementation Completion

Do not treat Plan 08 as complete until:

- [x] all implemented phases above are checked off
- [x] automated tests pass under `bun test`
- [x] the smoke path still works under `bun run src/smoke-test.ts`
- [x] docs and examples match the implemented behavior
- [x] known deferred items remain clearly marked as deferred

## Deferred Questions

These should be left out of the initial implementation plan:

- OpenID Federation client authentication
- ticket support for multiple acceptable client bindings
- certificate revocation checking for UDAP
- richer framework-hosted metadata discovery protocols
- whether a future spec should add additional exact-cert binding examples beyond the current `cnf.jkt` story
