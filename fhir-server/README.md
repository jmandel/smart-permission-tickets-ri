# Reference FHIR Server

This is a Bun + SQLite FHIR server over the synthetic corpus in [`../synth-data/patients`](../synth-data/patients).

It is intentionally narrow:
- read + search only
- explicit US Core-aligned search subset
- Permission Ticket token exchange
- mode-based policy surfaces

## Start

```bash
cd /home/jmandel/work/smart-permission-tickets/reference-implementation/fhir-server
bun run start
```

Default port is `8091`.

Set an explicit public origin in deployed environments:

```bash
PUBLIC_BASE_URL=https://smart-permission-tickets.example.org
```

The server now uses `PUBLIC_BASE_URL` for advertised SMART/OAuth/FHIR URLs and
token audiences. It does not infer public origin from `X-Forwarded-*` headers.

If the server advertises a public HTTPS origin that the VM cannot reach directly
(for example, TLS terminates on an external proxy), also set an internal
self-fetch origin:

```bash
PUBLIC_BASE_URL=https://smart-permission-tickets.example.org
INTERNAL_BASE_URL=http://127.0.0.1:8091
```

`INTERNAL_BASE_URL` is only used when the server needs to fetch its own
publicly advertised well-known resources, such as a built-in well-known client
JWKS. Wire identifiers and advertised metadata still use `PUBLIC_BASE_URL`.

Open the root UI in a browser:

```bash
open http://localhost:8091/
```

The landing page lists:
- mode surfaces and what each one does
- loaded synthetic patients and sites
- a built-in permission workbench that can:
  - select a patient
  - in `strict` mode, choose a client type before building the ticket:
    - unaffiliated registered client
    - well-known client
    - OIDF client
    - UDAP client
  - choose sites, scopes, dates, ticket lifetime, and the `access.sensitive_data` policy
  - request an ES256-signed Permission Ticket from a simulated issuer
  - prepare one of four client stories:
    - dynamic JWK registration for an unaffiliated app
    - implicit `well-known:<uri>` identity with no registration call
    - OpenID Federation client auth with `client_id=<entity-id>` and a supplied `trust_chain`
    - just-in-time UDAP dynamic registration
  - exchange it for an access token
  - introspect that token
  - hand off only the sites that can actually authorize into the viewer app

In `strict` mode, the workbench now explicitly explains what each client path demonstrates before launch:
- **Unaffiliated registered client**: a one-off app registers a JWK and, in strict/key-bound flows, the ticket binds with `presenter_binding.method = "jkt"`
- **Well-known client**: a framework-affiliated client skips registration and is recognized as `well-known:<entity-uri>` using current JWKS resolution
- **OIDF client**: a framework-affiliated client skips registration, uses `client_id=<entity-id>`, and proves trust with a static `trust_chain` in the `client_assertion` JOSE header
- **UDAP client**: a framework-backed client registers just in time with UDAP DCR and then authenticates with `x5c`

After launch, use the **Ticket** and **Client** artifact menus in the viewer to inspect:
- the chosen presenter-binding shape (`presenter_binding.method = "jkt"`, `presenter_binding.method = "framework_client"`, or no binding)
- the client story and effective `client_id`
- registration request/response payloads when registration occurs
- the well-known framework document and entity JWKS for the implicit-registration path
- a copyable token-exchange cURL template with the correct token endpoint and `client_id`

The demo also includes a live protocol trace:
- open it from **Step 4** in the workbench with **Open Protocol Trace**
- or visit `/trace` directly and attach it to a session via `?session=<viewer-session-id>`
- it streams a session-scoped audit feed over Server-Sent Events from `/demo/events/:sessionId`
- it replays buffered events when opened mid-demo, so you can attach the protocol trace after the viewer has already started
- it makes the trust chain, validation checks, per-site fan-out, and logical data fetches inspectable in real time

Default demo trust-framework surfaces are also enabled out of the box:
- a built-in `well-known` framework document at `/demo/frameworks/well-known-reference.json` with two sample client entities hosted under `/demo/clients/...`
- a built-in OIDF trust fabric with:
  - the Trust Anchor at `/federation/anchor/.well-known/openid-federation`
  - the App Network, Provider Network, demo app, ticket issuer, and one provider-site leaf per discovered site
- a built-in demo well-known JWKS surface at `/.well-known/jwks.json`, plus entity-local JWKS surfaces under `/demo/clients/<slug>/.well-known/jwks.json`
- a built-in UDAP framework advertising `/.well-known/udap` metadata, including RS256-signed `signed_metadata`, trusting both the demo EC and demo RSA roots for client registration, and chaining discovery metadata to the demo RSA root for RS256-oriented interoperability testing

## OIDF Consumption Model

OIDF client authentication and OIDF issuer trust intentionally behave differently:

- **Client authentication** is static and offline.
  - the client sends a complete `trust_chain` in the `client_assertion` JOSE header
  - the token endpoint validates that chain in memory
  - no network fetches occur on the token request path
- **Issuer trust** is discovery-driven.
  - the server starts from the allowlisted issuer leaf entity ID
  - it fetches the real entity configuration from the entity's own origin
  - it follows the published `metadata.federation_entity.federation_fetch_endpoint`
  - it verifies the resulting trust chain and any required trust mark

OIDF trust is explicitly allowlisted:

- configured `trustAnchors` define which terminal anchors are accepted
- configured `trustedLeaves` define which OIDF leaves may be used for:
  - client authentication
  - issuer trust
- a valid-looking chain for an unallowlisted leaf is rejected

`INTERNAL_BASE_URL` is only a loopback rewrite for this server's own advertised
origin. If an OIDF URL points at some other host, the resolver fetches that
foreign URL as-is.

## Issuer Key Publication and Trust Policy

`PermissionTicket` issuers stay framework-neutral on the wire. The verifier starts
from `iss` and consults an ordered issuer-trust policy list in
`ServerConfig.issuerTrust.policies`.

Supported policy types:
- `direct_jwks`
  - allowlist exact issuer URLs
  - resolve signing keys from `${iss}/.well-known/jwks.json`
- `oidf`
  - resolve issuer trust through the configured OIDF resolver
  - optionally require predicates such as anchor membership or a trust mark
- `udap`
  - start at `GET {iss}/.well-known/udap`
  - validate the returned `signed_metadata` against configured UDAP trust anchors
  - optionally require predicates such as `udap_chains_to`

Current demo runtime default:

```ts
issuerTrust: {
  policies: [
    {
      type: "direct_jwks",
      trustedIssuers: [
        "https://.../issuer/reference-demo",
      ],
    },
  ],
}
```

That means the built-in demo data holders currently trust only allowlisted issuer
URLs and derive the key publication path from `iss`. OIDF and UDAP issuer trust are
implemented and tested, but they are not enabled in the default demo holder policy.

Example richer policies:

```ts
issuerTrust: {
  policies: [
    {
      type: "oidf",
      require: {
        kind: "all",
        rules: [
          { kind: "issuer_url_in", values: ["https://issuer.example.org/issuer/demo"] },
          { kind: "oidf_chain_anchored_in", entityIds: ["https://anchor.example.org"] },
          { kind: "oidf_has_trust_mark", trustMarkTypes: ["https://example.org/trust-marks/permission-ticket-issuer"] },
        ],
      },
    },
    {
      type: "udap",
      require: {
        kind: "all",
        rules: [
          { kind: "issuer_url_in", values: ["https://issuer.example.org/issuer/demo"] },
          { kind: "udap_chains_to", trustAnchors: ["https://example.org/trust-communities/provider-network"] },
        ],
      },
    },
  ],
}
```

Policy evaluation is ordered. The first policy that both matches and resolves trust
becomes the active verification path for that incoming ticket.

When this repo intentionally publishes the same issuer through more than one
mechanism, shared `kid` values are kept aligned with publication-level tests.
Runtime verification does not re-fetch secondary sources after the selected
primary policy path succeeds.

## Stable Demo Crypto Lockfile

The server now treats the demo crypto bundle as a lockfile:

- if the file already exists, it is reused
- if it is missing entries the current server needs, it is grown in place
- if it does not exist yet, it is created automatically at boot

Normal operators do not need to pregenerate it.

Bundle path resolution:
- `DEMO_CRYPTO_BUNDLE_PATH=/abs/path/to/demo-crypto-bundle.json`, if set
- otherwise `reference-implementation/fhir-server/.demo-crypto-bundle.json`

The conventional default file is gitignored in this repo.

What the lockfile stabilizes across restarts:
- local ticket issuer signing keys
- OIDF fixed-role entities
- one OIDF provider-site leaf per discovered `siteSlug`
- the built-in well-known demo client
- UDAP EC and RSA CA/client key material

Provider sites are first-class OIDF members of the Provider Network. Each site
publishes its own entity configuration under:
- `/federation/leafs/provider-sites/<siteSlug>/.well-known/openid-federation`

and the Provider Network federation fetch endpoint publishes subordinate statements
for every discovered site leaf.

Growth behavior:
- missing provider-site entries are added automatically when the site inventory grows
- missing fixed roles are added automatically
- existing keys are preserved
- stale extra entries are left alone
- if nothing is missing, the file is not rewritten

OIDF entity configurations, subordinate statements, and trust marks are re-minted
when served. This keeps their `iat`/`exp` fresh indefinitely while preserving the
same signing keys from the lockfile.

What the lockfile does not stabilize:
- UDAP leaf certificate bytes issued from the stable CA/client keys
- OIDF JWT bytes themselves, since those are intentionally re-minted with fresh time claims

The offline generator script still exists for inspection or explicit fresh
materialization:

```bash
cd /home/jmandel/work/smart-permission-tickets/reference-implementation
bun run scripts/generate-demo-crypto-bundle.ts > fhir-server/.demo-crypto-bundle.json
```

But it is no longer required for normal boot.

## Data Assumptions

The server does not require synthetic resources to carry repeated site/jurisdiction `meta.tag` entries.

Instead it derives:
- organization identity from ingested `Organization` resources
- jurisdiction/state from site-level Organization or Location address metadata

The only FHIR-facing labels the server relies on directly for filtering are `meta.security` labels on resources.

## Smoke Test

```bash
cd /home/jmandel/work/smart-permission-tickets/reference-implementation/fhir-server
bun run smoke:http
```

This boots the server on an ephemeral port and verifies:
- SMART config
- CapabilityStatement
- dynamic registration
- open token exchange
- strict token exchange
- introspection
- guarded read
- search
- site partitioning
- sensitive-mode filtering
- anonymous preview access

Mode-focused integration tests:

```bash
cd /home/jmandel/work/smart-permission-tickets/reference-implementation/fhir-server
bun test
```

These cover:
- `strict`, `registered`, `key-bound`, `open`, and `anonymous`
- issuance behavior per mode
- post-issuance token use
- proof enforcement for `key-bound`
- mode-bound token replay rejection
- demo bootstrap payload and demo helper logic

## Modes

The server exposes one default root surface plus named mode mounts.

Default root:
- `/fhir`
- `/sites/:siteSlug/fhir`
- `/.well-known/smart-configuration`
- `/register`
- `/token`
- `/introspect`

Named mode mounts:
- `/modes/strict/...`
- `/modes/registered/...`
- `/modes/key-bound/...`
- `/modes/open/...`
- `/modes/anonymous/...`

### `strict`

- registered client required at `/token`
- FHIR requests require a Bearer access token

### `registered`

- same FHIR token requirement
- client must still be known/registered

### `key-bound`

- intended for `presenter_binding.method = "jkt"` sender-constrained flows
- FHIR requests still require a Bearer access token

### `open`

- open token exchange
- no client auth required at `/modes/open/token`
- FHIR requests still require a Bearer access token

### `anonymous`

- no access token required for FHIR reads/searches
- intended only for local developer exploration
- still respects site path partitioning, e.g. `/modes/anonymous/sites/:siteSlug/fhir/...`
- does not apply ticket-based filtering because there is no token

`anonymous` is deliberately different from `open`.

## Mode-Bound Tokens

Issued access tokens are bound to the mode that issued them.

That means:
- a token from `/token` is valid only for the default `strict` FHIR surface
- a token from `/modes/open/token` is valid only for `/modes/open/fhir/...`
- a token from `/modes/key-bound/token` is valid only for `/modes/key-bound/fhir/...`

This prevents a token minted under one policy bucket from being replayed against another.

## SMART / OAuth Endpoints

Examples:

```bash
curl http://localhost:8091/.well-known/smart-configuration
curl http://localhost:8091/modes/open/.well-known/smart-configuration
curl http://localhost:8091/networks/reference/fhir/.well-known/smart-configuration
curl http://localhost:8091/fhir/.well-known/udap
curl http://localhost:8091/.well-known/jwks.json
```

The UDAP discovery response includes:
- `signed_metadata`, signed as an RS256 JWT with an `x5c` certificate header
- a discovery certificate chain that, in the default demo UDAP framework, chains to the built-in demo RSA UDAP trust anchor
- demo certificate revocation lists (CRLs) published under `/.well-known/udap/crls/<framework-slug>/<ca-id>.crl`
- `udap_profiles_supported` including `udap_dcr`, `udap_authn`, and `udap_authz`
- `token_endpoint_auth_signing_alg_values_supported` including `RS256` and `ES256`
- `registration_endpoint_jwt_signing_alg_values_supported` including `RS256` and `ES256`
- `grant_types_supported` including `client_credentials` for the UDAP B2B workflow
- `udap_authorization_extensions_supported` and `udap_authorization_extensions_required` including `hl7-b2b`

The strict-mode demo now intentionally exercises four different client identity models:

- **Unaffiliated registered client**
  - runtime behavior: POSTs a JWK to `/register`
  - ticket behavior: uses `presenter_binding.method = "jkt"` in strict/key-bound flows

- **Well-known client**
  - runtime behavior: skips registration and uses `client_id=well-known:<entity-uri>`
  - ticket behavior: uses `presenter_binding.method = "framework_client"`
  - discovery/demo metadata:
    - framework JSON: `/demo/frameworks/well-known-reference.json`
    - sample entity metadata: `/demo/clients/well-known-alpha`
    - sample entity JWKS: `/demo/clients/well-known-alpha/.well-known/jwks.json`

- **OIDF client**
  - runtime behavior: skips registration and uses `client_id=<entity-id>`
  - token behavior: sends `trust_chain` in the `client_assertion` JOSE header
  - ticket behavior: uses `presenter_binding.method = "framework_client"`
  - discovery/demo metadata:
    - demo app entity configuration: `/federation/leafs/demo-app/.well-known/openid-federation`
    - app-network fetch endpoint: `/federation/networks/app/federation_fetch_endpoint`

- **UDAP client**
  - runtime behavior: does just-in-time UDAP registration at `/register`, then authenticates with `x5c` and `udap=1`
  - ticket behavior: uses `presenter_binding.method = "framework_client"`
  - discovery/demo metadata:
    - UDAP discovery: `/.well-known/udap`

UDAP hardening in the reference implementation now includes:
- in-memory replay prevention for UDAP software-statement and client-assertion `jti` values
- in-memory active-registration tracking for UDAP re-registration and cancellation
- superseded or canceled UDAP `client_id`s are rejected within the current server process

Known reference-implementation limitation:
- server restarts clear the replay cache and active-registration map
- after a restart, older signed UDAP `client_id`s may become valid again until a fresh registration supersedes them
- this is intentional for the demo/reference server and is not a production persistence model

Permission Ticket support is advertised in SMART config via:
- `grant_types_supported` including `client_credentials` and `urn:ietf:params:oauth:grant-type:token-exchange`
- `smart_permission_ticket_types_supported`

Local surface metadata is carried under:
- `extensions["https://smarthealthit.org/smart-permission-tickets/smart-configuration"]`

By default the extension also advertises built-in demo trust frameworks:
- `https://smarthealthit.org/trust-frameworks/reference-demo-oidf`
- `https://smarthealthit.org/trust-frameworks/reference-demo-well-known`
- `https://smarthealthit.org/trust-frameworks/reference-demo-udap`

To exercise the built-in UDAP registration helper against the RSA demo client instead of the default EC demo client:

```bash
cd /home/jmandel/work/smart-permission-tickets/reference-implementation/fhir-server
DEMO_UDAP_ALG=RS256 bun run src/demo-udap-registration.ts
```

Implemented `surface_kind` values:
- `global`
- `site`
- `network`

Implemented `surface_mode` values:
- `strict`
- `registered`
- `key-bound`
- `open`
- `anonymous`

Dynamic registration:

```bash
curl -X POST http://localhost:8091/register \
  -H 'content-type: application/json' \
  -d '{
    "client_name": "Local Dev Client",
    "token_endpoint_auth_method": "private_key_jwt",
    "jwk": { "...": "public JWK here" }
  }'
```

Dynamic registrations are self-contained and restart-safe in this reference server:
- the returned `client_id` is a signed client descriptor
- the registered public JWK is embedded in that signed descriptor
- a server restart does not lose dynamically registered clients

Demo UDAP registration helper:

```bash
cd /home/jmandel/work/smart-permission-tickets/reference-implementation/fhir-server
bun run demo:udap-register
```

This fetches `/.well-known/udap`, builds a standards-shaped `software_statement`
using the built-in demo UDAP certificate, and POSTs it to the server's
registration endpoint so you can see the full registration exchange against a
vanilla local server. The bundled helper still uses ES256, but the server also
accepts RS256 for UDAP software statements and client assertions.

Token exchange:

```bash
curl -X POST http://localhost:8091/modes/open/token \
  -H 'content-type: application/x-www-form-urlencoded' \
  --data-urlencode 'grant_type=urn:ietf:params:oauth:grant-type:token-exchange' \
  --data-urlencode 'subject_token_type=https://smarthealthit.org/token-type/permission-ticket' \
  --data-urlencode "subject_token=$SIGNED_PERMISSION_TICKET"
```

The token endpoint behaves like an OAuth endpoint, not a FHIR endpoint:
- token failures return JSON with `error` and `error_description`
- `subject_token_type` is required and must be `https://smarthealthit.org/token-type/permission-ticket`
- if request `scope` is present, it narrows the issued access and cannot exceed what the Permission Ticket allows
- Permission Tickets must include `exp`, and the server rejects tickets that omit it or are already expired
- ticket `aud` may identify explicit recipient URLs or trust-framework identifiers; the server validates both surface URL membership and configured framework membership
- if `revocation` is present, the ticket must also carry `jti`; the server fetches the revocation list from `revocation.url`, caches it by HTTP policy, and fails closed if revocation status cannot be determined

This reference implementation currently recognizes one subject token type:

- `https://smarthealthit.org/token-type/permission-ticket`

Introspection:

```bash
curl -X POST http://localhost:8091/introspect \
  -H 'content-type: application/x-www-form-urlencoded' \
  --data-urlencode 'client_id=<registered-client-id>' \
  --data-urlencode 'client_assertion_type=urn:ietf:params:oauth:client-assertion-type:jwt-bearer' \
  --data-urlencode 'client_assertion=<private-key-jwt>' \
  --data-urlencode "token=$ACCESS_TOKEN"
```

## Permission Ticket Issuers

The stack also simulates Permission Ticket issuer base URLs.

Default issuer:

- `/issuer/reference-demo`
- `/issuer/reference-demo/.well-known/jwks.json`
- `/issuer/reference-demo/sign-ticket`

Examples:

```bash
curl http://localhost:8091/issuer/reference-demo
curl http://localhost:8091/issuer/reference-demo/.well-known/jwks.json
curl -X POST http://localhost:8091/issuer/reference-demo/sign-ticket \
  -H 'content-type: application/json' \
  -d '{
    "iss": "http://localhost:8091/issuer/reference-demo",
    "aud": "http://localhost:8091",
    "exp": 1760000000,
    "jti": "example-ticket-id",
    "ticket_type": "https://smarthealthit.org/permission-ticket-type/patient-self-access-v1",
    "presenter_binding": {
      "method": "jkt",
      "jkt": "example-proof-key-thumbprint"
    },
    "subject": {
      "patient": {
        "resourceType": "Patient",
        "name": [{ "family": "Reyes", "given": ["Elena"] }],
        "birthDate": "1989-09-14"
      }
    },
    "access": {
      "permissions": [
        { "kind": "data", "resource_type": "*", "interactions": ["read", "search"] }
      ],
      "sensitive_data": "exclude"
    }
  }'
```

The sign-ticket helper is demo-only. It exists so the built-in UI can request a public, issuer-scoped Permission Ticket instead of minting one with a local symmetric secret in the browser.

Permission Ticket expiry follows normal JWT semantics:

- `exp` is required
- `exp` must be a NumericDate in the future

The built-in demo UI exposes this as a ticket lifetime choice, including bounded options such as `1 hour`, `1 day`, `7 days`, `30 days`, `1 year`, and a long-lived `10 years (demo stand-in for never)` option.

This reference implementation currently supports one Permission Ticket type end to end:

- `https://smarthealthit.org/permission-ticket-type/patient-self-access-v1`

The other ticket types described in the specification remain illustrative/profile targets for future implementation.

## Local Authorization Semantics

The reference server compiles the signed ticket into local authorization semantics for date filtering and sensitive-data handling. These are implementation behaviors derived from the common Permission Ticket claims model, not extra wire fields that callers should place in the ticket payload.

- date filtering uses generated/recorded timing semantics
- sensitive-data handling defaults to `deny`
- the server can also resolve tickets into an `allow` mode

The server maps these semantics to its own internal date handling and sensitive-data label set. Ticket callers do not need to know the raw `meta.security` labels or local query model used by the demo corpus.

## FHIR Base URLs

Global base:
- `/fhir`

Site-partitioned base:
- `/sites/:siteSlug/fhir`

Network-partitioned base:
- `/networks/:networkSlug/fhir`

Mode + global base:
- `/modes/:mode/fhir`

Mode + site base:
- `/modes/:mode/sites/:siteSlug/fhir`

Mode + network base:
- `/modes/:mode/networks/:networkSlug/fhir`

Examples:

```bash
curl http://localhost:8091/fhir/metadata
curl http://localhost:8091/sites/lone-star-womens-health/fhir/metadata
curl http://localhost:8091/networks/reference/fhir/metadata
curl http://localhost:8091/modes/anonymous/fhir/Patient?_count=5
curl http://localhost:8091/modes/anonymous/sites/lone-star-womens-health/fhir/DiagnosticReport?_count=10
curl http://localhost:8091/modes/open/networks/reference/fhir/Organization?_count=5
```

Network OAuth/token surfaces use the same path prefix without `/fhir`:
- `/networks/:networkSlug/register`
- `/networks/:networkSlug/token`
- `/networks/:networkSlug/introspect`
- `/modes/:mode/networks/:networkSlug/register`
- `/modes/:mode/networks/:networkSlug/token`
- `/modes/:mode/networks/:networkSlug/introspect`

Example:

```bash
curl -X POST http://localhost:8091/networks/reference/token \
  -H 'content-type: application/x-www-form-urlencoded' \
  --data-urlencode 'grant_type=urn:ietf:params:oauth:grant-type:token-exchange' \
  --data-urlencode 'subject_token_type=https://smarthealthit.org/token-type/permission-ticket' \
  --data-urlencode "subject_token=$SIGNED_PERMISSION_TICKET"
```

Network-only operation:
- `POST /networks/:networkSlug/fhir/$resolve-record-locations`
- resolves which record locations inside the named network can satisfy the current token's authorization envelope

Example:

```bash
curl -X POST http://localhost:8091/networks/reference/fhir/$resolve-record-locations \
  -H "authorization: Bearer $ACCESS_TOKEN" \
  -H 'content-type: application/fhir+json' \
  -d '{ "resourceType": "Parameters" }'
```

## Supported Resource Types

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
- `AllergyIntolerance`

## Supported Search Parameters

### Patient

- `_id`
- `identifier`
- `family`
- `given`
- `name`
- `birthdate`
- `gender`

### Observation

- `patient`
- `category`
- `code`
- `date`
- `status`
- `_lastUpdated`

### Condition

- `patient`
- `category`
- `code`
- `clinical-status`
- `encounter`

### DiagnosticReport

- `patient`
- `category`
- `code`
- `date`
- `status`

### DocumentReference

- `patient`
- `category`
- `type`
- `date`
- `period`
- `status`

### Encounter

- `patient`
- `class`
- `type`
- `date`
- `location`
- `status`

### MedicationRequest

- `patient`
- `status`
- `intent`
- `authoredon`
- `encounter`

### Procedure

- `patient`
- `status`
- `code`
- `date`
- `encounter`

### Immunization

- `patient`
- `status`
- `date`

### ServiceRequest

- `patient`
- `status`
- `intent`
- `authoredon`
- `encounter`

### AllergyIntolerance

- `patient`
- `clinical-status`
- `verification-status`
- `code`

## Query Examples

Anonymous exploration in `anonymous` mode:

```bash
curl 'http://localhost:8091/modes/anonymous/fhir/Patient?family=Reyes'
curl 'http://localhost:8091/modes/anonymous/fhir/Observation?category=laboratory&_count=5'
curl 'http://localhost:8091/modes/anonymous/sites/lone-star-womens-health/fhir/DiagnosticReport?_count=20'
```

Authorized FHIR search with a Bearer token:

```bash
curl 'http://localhost:8091/fhir/Observation?patient=r-e65ddcc23a9e6c2f6949c419cf206af9&category=laboratory&_count=5' \
  -H "Authorization: Bearer $ACCESS_TOKEN"
```

Read by reminted server id:

```bash
curl http://localhost:8091/fhir/Patient/r-e65ddcc23a9e6c2f6949c419cf206af9 \
  -H "Authorization: Bearer $ACCESS_TOKEN"
```

Site-partitioned search:

```bash
curl 'http://localhost:8091/sites/eastbay-primary-care-associates/fhir/Encounter?status=finished&_count=10' \
  -H "Authorization: Bearer $ACCESS_TOKEN"
```

POST search:

```bash
curl -X POST http://localhost:8091/fhir/Observation/_search \
  -H 'content-type: application/x-www-form-urlencoded' \
  -H "Authorization: Bearer $ACCESS_TOKEN" \
  --data 'patient=r-e65ddcc23a9e6c2f6949c419cf206af9&category=laboratory&_count=5'
```

## Query Notes

- Search is explicit and limited. Unsupported params fail fast.
- `_count` is supported and capped at `200`.
- `string` search is prefix-style on normalized text.
- `token` search accepts either `code` or `system|code`.
- `date` search accepts:
  - `YYYY-MM-DD`
  - `geYYYY-MM-DD`
  - `gtYYYY-MM-DD`
  - `leYYYY-MM-DD`
  - `ltYYYY-MM-DD`
- `patient` and other references use reminted server ids.

## Authorization Notes

For token-backed modes, access tokens are stateless JWTs carrying the compiled authorization envelope:
- resolved patient aliases
- allowed resource types
- date constraints
- sensitive mode
- optional site limits

The server always materializes a request-scoped visible set before read/search.

For `anonymous` mode, there is no site-token requirement and therefore no ticket-derived filtering on direct site reads. That mode is for local query formulation and debugging only.

## Current Limits

- no write APIs
- no generic SearchParameter execution
- no arbitrary chaining
- no `_include` / `_revinclude`
- sender-constrained proof is demo-grade
- public Permission Tickets are ES256 issuer-signed, but internal access tokens and dynamic client descriptors still use local HS256
