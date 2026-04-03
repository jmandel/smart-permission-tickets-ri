# Plan 5: Network Directory + Record Location Service

## Goal

Add a network-scoped SMART/FHIR surface, exposed by the reference server itself, that lets an app:

- obtain a network access token by redeeming a signed Permission Ticket
- resolve which sites have visible records under that ticket
- discover the endpoint and organization metadata needed to connect to those sites

This surface should behave like another SMART/FHIR server role in the stack, not like a special out-of-band side channel.

## Why This Exists

The current demo can prepare a list of sites for the viewer, but that is only a halfway-house approximation of the real boundary.

Longer-term, the app should not be handed a patient-specific site list as an authoritative fact. Instead:

- the app should know a broad network or directory
- the app should redeem a Permission Ticket at a network SMART surface
- the app should call a network FHIR operation to learn only the sites that actually have visible records under that ticket

This protects both:

- the user, by not showing denied/empty sites
- the app, by not leaking unnecessary patient-site membership information

## What This Plan Covers

- how the reference server should expose the network role in-process
- URL shape for the network SMART/FHIR surface
- network token exchange semantics
- directory resource search
- a record-location operation driven by an OAuth access token
- response bundle shapes
- relationship to site SMART surfaces
- how the built-in demo landing page and viewer should use the network surface
- example request/response payloads

## Non-Goals

- implementing full XCPD, XCA, or IHE-style cross-community exchange
- exposing every possible healthcare directory resource at v1
- returning candidate sites that fail ticket-based visibility rules
- using the Permission Ticket directly as an API parameter after token exchange

## Runtime Role In The Stack

The reference stack should expose three distinct roles:

- Permission Ticket issuer:
  - `/issuer/{issuerSlug}`
- network directory + record-location SMART/FHIR surface:
  - `/networks/{networkSlug}/fhir`
- site clinical SMART/FHIR surfaces:
  - `/sites/{siteSlug}/fhir`

These roles may live inside one Bun process in the reference implementation, but their URLs and responsibilities should stay distinct.

In practice for this repo, that means:

- the existing Bun reference server should expose the network SMART/FHIR base
- the built-in demo client should use that base
- the built-in viewer should use it as the canonical site-discovery step

## URL Shape

Recommended base convention:

- network FHIR base:
  - `/networks/{networkSlug}/fhir`
- network SMART config:
  - `/networks/{networkSlug}/fhir/.well-known/smart-configuration`
- network token endpoint:
  - `/networks/{networkSlug}/token`
- network introspection endpoint:
  - `/networks/{networkSlug}/introspect`
- network client registration endpoint:
  - `/networks/{networkSlug}/register`

Example:

- `http://localhost:8091/networks/reference/fhir`
- `http://localhost:8091/networks/reference/fhir/.well-known/smart-configuration`
- `http://localhost:8091/networks/reference/token`

This should feel like another SMART/FHIR surface, not a custom non-OAuth API.

## Authentication Model

The app should not call the network RLS with a raw Permission Ticket parameter.

Instead:

1. app obtains a signed Permission Ticket from the issuer
2. app performs token exchange against the network token endpoint
3. network token endpoint validates:
   - issuer signature via issuer JWKS
   - `ticket_type`
   - `aud`
   - `exp`
   - client binding requirements such as `cnf.jkt`
4. network token endpoint issues a network-scoped access token
5. app calls network FHIR APIs with `Authorization: Bearer ...`

This keeps the network surface aligned with the site SMART surfaces.

### Network Access Token Audience

The network access token should be audience-bound to the network FHIR base, for example:

- `aud = http://localhost:8091/networks/reference/fhir`

It should not be valid at:

- `/sites/{siteSlug}/fhir`
- `/fhir`

Likewise, a site-bound access token should not be valid at the network base.

## Network SMART Surface

The network SMART configuration should advertise:

- `authorization_endpoint` only if needed later
- `token_endpoint`
- `registration_endpoint`
- `introspection_endpoint`
- `scopes_supported`
- token endpoint auth methods

The relevant scopes here are not clinical site scopes. They are network-directory / RLS scopes.

Recommended initial scopes:

- `system/Endpoint.rs`
- `system/Organization.rs`
- `system/$resolve-record-locations`

These can be implicit in the issued network token at first, but the surface should be designed so they can become explicit later.

### Example SMART Config

```json
{
  "issuer": "http://localhost:8091/networks/reference/fhir",
  "jwks_uri": "http://localhost:8091/issuer/reference-demo/.well-known/jwks.json",
  "token_endpoint": "http://localhost:8091/networks/reference/token",
  "registration_endpoint": "http://localhost:8091/networks/reference/register",
  "introspection_endpoint": "http://localhost:8091/networks/reference/introspect",
  "grant_types_supported": ["urn:ietf:params:oauth:grant-type:token-exchange"],
  "token_endpoint_auth_methods_supported": ["private_key_jwt"],
  "scopes_supported": [
    "system/Endpoint.rs",
    "system/Organization.rs",
    "system/$resolve-record-locations"
  ]
}
```

## Network Token Exchange

The network token endpoint should use the same token exchange shape as the site token endpoints:

- `grant_type = urn:ietf:params:oauth:grant-type:token-exchange`
- `subject_token_type = urn:ietf:params:oauth:token-type:jwt`
- `subject_token = <signed Permission Ticket>`
- client authentication via `private_key_jwt` when required

### Example Token Request

```http
POST /networks/reference/token
Content-Type: application/x-www-form-urlencoded

grant_type=urn:ietf:params:oauth:grant-type:token-exchange&
subject_token_type=urn:ietf:params:oauth:token-type:jwt&
subject_token=eyJ...&
client_id=eyJ...&
client_assertion_type=urn:ietf:params:oauth:client-assertion-type:jwt-bearer&
client_assertion=eyJ...
```

### Example Token Response

```json
{
  "access_token": "eyJ...",
  "token_type": "Bearer",
  "expires_in": 3600,
  "scope": "system/Endpoint.rs system/Organization.rs system/$resolve-record-locations"
}
```

## Record Location Service Operation

### Operation Name

Define a system-level operation on the network base:

- `POST /networks/{networkSlug}/fhir/$resolve-record-locations`

This is the onboarding entrypoint for apps that hold a Permission Ticket and want to know where they can actually retrieve visible data.

### Invocation Model

The operation should be authorized by the network access token. It should not require the Permission Ticket again as an input parameter.

Minimal invocation:

```http
POST /networks/reference/fhir/$resolve-record-locations
Authorization: Bearer eyJ...
Content-Type: application/fhir+json

{
  "resourceType": "Parameters"
}
```

Optional parameters can be added later, for example:

- `includeOrganizations`
- `includeLocations`
- `return = endpoint | identifier`

But v1 should stay simple.

### Semantics

The operation should return only sites where:

- the patient has records
- the Permission Ticket can authorize access for that site
- visible clinical content remains after ticket filtering

It should not return sites that are reduced to:

- only `Patient`
- only supporting context resources such as `Organization`, `Practitioner`, or `Location`

This avoids recreating the information leak where a site is revealed despite having no visible clinical content under the ticket.

This operation is the preferred onboarding step for apps in the reference implementation.

### Response Shape

Return a FHIR `Bundle` of type `collection`.

The bundle should primarily contain:

- `Endpoint` resources for connectable site FHIR bases
- linked `Organization` resources describing the managing organizations

Optionally later:

- `Location`
- `HealthcareService`

The app can then:

1. read `Endpoint.address`
2. fetch base-relative SMART config from that FHIR base
3. dynamically register if needed
4. redeem the same Permission Ticket at the site token endpoint
5. query that site’s FHIR base

### Endpoint Resource Conventions

Each returned `Endpoint` should include:

- stable `identifier`
- `status = active`
- `connectionType` indicating an HL7 FHIR REST endpoint
- `name`
- `managingOrganization`
- `address` equal to the site FHIR base URL

Recommended identifier namespace:

- `system = urn:smart-permission-tickets:endpoint-id`

### Example RLS Response

```json
{
  "resourceType": "Bundle",
  "type": "collection",
  "entry": [
    {
      "fullUrl": "http://localhost:8091/networks/reference/fhir/Endpoint/eastbay-primary-care",
      "resource": {
        "resourceType": "Endpoint",
        "id": "eastbay-primary-care",
        "identifier": [
          {
            "system": "urn:smart-permission-tickets:endpoint-id",
            "value": "eastbay-primary-care"
          }
        ],
        "status": "active",
        "name": "Eastbay Primary Care Associates FHIR",
        "connectionType": {
          "system": "http://terminology.hl7.org/CodeSystem/endpoint-connection-type",
          "code": "hl7-fhir-rest"
        },
        "managingOrganization": {
          "reference": "Organization/eastbay-primary-care-associates",
          "display": "Eastbay Primary Care Associates"
        },
        "address": "http://localhost:8091/sites/eastbay-primary-care-associates/fhir"
      }
    },
    {
      "fullUrl": "http://localhost:8091/networks/reference/fhir/Organization/eastbay-primary-care-associates",
      "resource": {
        "resourceType": "Organization",
        "id": "eastbay-primary-care-associates",
        "name": "Eastbay Primary Care Associates",
        "identifier": [
          {
            "system": "http://hl7.org/fhir/sid/us-npi",
            "value": "1589043712"
          }
        ],
        "address": [
          {
            "state": "CA"
          }
        ]
      }
    }
  ]
}
```

## Network Directory Search

The network base should also expose ordinary FHIR read/search for directory resources so apps can inspect general network metadata.

Recommended initial resources:

- `Endpoint`
- `Organization`

Possible later additions:

- `Location`
- `HealthcareService`

### Example Directory Searches

Search endpoints by organization name:

```http
GET /networks/reference/fhir/Endpoint?name=eastbay
Authorization: Bearer eyJ...
```

Search organizations by NPI:

```http
GET /networks/reference/fhir/Organization?identifier=http://hl7.org/fhir/sid/us-npi|1589043712
Authorization: Bearer eyJ...
```

Read a specific endpoint:

```http
GET /networks/reference/fhir/Endpoint/eastbay-primary-care
Authorization: Bearer eyJ...
```

Directory search is generic network metadata.

`$resolve-record-locations` is patient-and-ticket-specific authorized discovery.

The two should stay distinct.

## App Flow Using The Network Surface

Recommended app sequence:

1. obtain a signed Permission Ticket from the issuer
2. dynamically register a client if required
3. exchange the ticket at `/networks/{networkSlug}/token`
4. call `/networks/{networkSlug}/fhir/$resolve-record-locations`
5. receive the authorized endpoint bundle
6. for each returned `Endpoint.address`:
   - fetch `/.well-known/smart-configuration` relative to that base
   - perform site-specific token exchange
   - query the site FHIR base

This means the app never has to be handed a patient-specific site list as an out-of-band launch payload.

### Built-In Demo Usage

The built-in demo should use the same sequence:

1. landing page builds Permission Ticket claims
2. landing page gets the ticket signed by the configured issuer
3. landing page hands the signed ticket, issuer info, network SMART/FHIR base, and client bootstrap material to the viewer
4. viewer exchanges the ticket at the network token endpoint
5. viewer calls `$resolve-record-locations`
6. viewer only renders sites returned by that operation
7. viewer performs per-site SMART discovery and site-bound token exchange for those returned sites

The landing page should stop passing concrete site lists to the viewer once this flow is implemented.

## Relationship To Site SMART Surfaces

The network surface is for:

- authorized discovery
- network directory browsing

The site surfaces are for:

- clinical data access
- site-specific SMART config
- site-specific token exchange

So the intended handoff is:

- network token -> discover visible sites
- site tokens -> retrieve data from those sites

## OperationDefinition Sketch

The reference implementation should eventually expose a formal `OperationDefinition` for:

- `$resolve-record-locations`

At minimum it should state:

- `code = resolve-record-locations`
- `system = true`
- `type = false`
- `instance = false`
- input is optional/empty `Parameters`
- output is a `Bundle`

The semantics should say:

- caller must present a valid network access token derived from a Permission Ticket
- returned endpoints are limited to sites with visible clinical content under that ticket

## Privacy And Leakage Rules

The network RLS should be stricter than generic site-hinting.

It should not:

- return raw candidate sites
- return sites that fail site-specific token exchange
- return sites left with only supporting context

It may later incorporate:

- differential privacy or hint obfuscation
- broader network-directory querying outside patient-specific resolution

But the RLS response itself should be a clean authorized set.

## Initial Implementation Slice

Phase 1 should implement:

- `/networks/{networkSlug}/fhir`
- `/networks/{networkSlug}/fhir/.well-known/smart-configuration`
- `/networks/{networkSlug}/token`
- `/networks/{networkSlug}/introspect`
- `Endpoint` and `Organization` read/search
- `POST /networks/{networkSlug}/fhir/$resolve-record-locations`

Phase 1 can derive its response from the same underlying local authorization compilation already used by the site token flow:

- resolve patient aliases
- evaluate ticket constraints
- reduce to sites with visible encounters
- emit one `Endpoint` + linked `Organization` per surviving site, including the site-local `Patient` reference needed for follow-on site queries

That gives the system a realistic API contract before we optimize or generalize the internals.
