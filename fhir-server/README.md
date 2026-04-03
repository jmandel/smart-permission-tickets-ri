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

Open the root UI in a browser:

```bash
open http://localhost:8091/
```

The landing page lists:
- mode surfaces and what each one does
- loaded synthetic patients and sites
- a built-in permission workbench that can:
  - select a patient
  - choose sites, scopes, dates, and `sensitive.mode`
  - request an ES256-signed Permission Ticket from a simulated issuer
  - dynamically register a client when needed
  - exchange it for an access token
  - introspect that token
  - hand off only the sites that can actually authorize into the viewer app

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

- intended for `cnf.jkt` sender-constrained flows
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
```

Permission Ticket support is advertised in SMART config via:
- `grant_types_supported` including `urn:ietf:params:oauth:grant-type:token-exchange`
- `smart_permission_ticket_types_supported`

Local surface metadata is carried under:
- `extensions["https://smarthealthit.org/smart-permission-tickets/smart-configuration"]`

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

Token exchange:

```bash
curl -X POST http://localhost:8091/modes/open/token \
  -H 'content-type: application/x-www-form-urlencoded' \
  --data-urlencode 'grant_type=urn:ietf:params:oauth:grant-type:token-exchange' \
  --data-urlencode 'subject_token_type=https://smarthealthit.org/token-type/permission-ticket' \
  --data-urlencode "subject_token=$SIGNED_PERMISSION_TICKET"
```

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
    "sub": "demo-client-patient-123",
    "aud": "http://localhost:8091",
    "ticket_type": "https://smarthealthit.org/permission-ticket-type/network-patient-access-v1",
    "authorization": {
      "subject": {
        "type": "match",
        "traits": {
          "resourceType": "Patient",
          "name": [{ "family": "Reyes", "given": ["Elena"] }],
          "birthDate": "1989-09-14"
        }
      },
      "access": {
        "scopes": ["patient/*.rs"]
      }
    },
    "details": {
      "sensitive": { "mode": "deny" }
    }
  }'
```

The sign-ticket helper is demo-only. It exists so the built-in UI can request a public, issuer-scoped Permission Ticket instead of minting one with a local symmetric secret in the browser.

## FHIR Base URLs

Global base:
- `/fhir`

Site-partitioned base:
- `/sites/:siteSlug/fhir`

Mode + global base:
- `/modes/:mode/fhir`

Mode + site base:
- `/modes/:mode/sites/:siteSlug/fhir`

Examples:

```bash
curl http://localhost:8091/fhir/metadata
curl http://localhost:8091/sites/lone-star-womens-health/fhir/metadata
curl http://localhost:8091/modes/anonymous/fhir/Patient?_count=5
curl http://localhost:8091/modes/anonymous/sites/lone-star-womens-health/fhir/DiagnosticReport?_count=10
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
