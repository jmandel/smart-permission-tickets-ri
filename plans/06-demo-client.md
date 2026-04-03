# Plan 6: Built-In Demo Client

Current implementation cleanup and follow-on design work are tracked in [07-demo-client-remediation.md](./07-demo-client-remediation.md).

## Goal

Add a developer-facing demo client inside the built-in FHIR server UI that makes the Permission Ticket flow tangible end-to-end:

- choose a patient
- choose constraints
- request a Permission Ticket from a simulated issuer
- exchange it for an access token
- query FHIR with that token
- compare the constrained result set to the unconstrained baseline

The point is not to simulate a production app. The point is to make the authorization mechanics and filtering effects visible, inspectable, and easy to experiment with.

## What This Plan Covers

- extending the existing `fhir-server/ui/` React app
- a consent-like constraint form for developer use
- ticket building in the browser plus server-side issuer signing
- JWK-based dynamic client registration when required by mode
- token exchange against the server’s real network and site token endpoints
- filtered FHIR queries against the real server
- preview comparison using the site-specific preview surface
- network-directory onboarding so the viewer discovers sites through the network RLS surface
- artifact inspection: ticket payload, signed JWT, token response, decoded access token, curl examples

## Non-Goals

- building a patient-facing consent UI
- replacing a real SMART client or real issuer implementation
- supporting every server mode equally in phase 1
- adding write APIs or non-read app behavior

## Relationship To Other Plans

### Server Plan

This plan consumes the behaviors described in [02-fhir-server.md](./02-fhir-server.md):

- mode-specific SMART surfaces
- network SMART/RLS surface
- site-specific SMART configuration and auth endpoints
- token exchange
- introspection
- permission-aware FHIR query filtering

### Ticket Boundary

This plan must respect the boundary in [ticket-input-spec.md](./ticket-input-spec.md):

- the demo client builds Permission Ticket claims JSON
- a simulated local issuer signs those claims with ES256
- the server compiles those claims into its normalized local authorization envelope
- the client should not know or care about internal `allowedSites`, reminted ids, SQLite filters, or local label tables

### Patient-Facing UX Work

This plan is distinct from the separate patient-facing `ux/` consent project.

- `ux/` is for patient comprehension and usability research
- this built-in demo client is for developers, reviewers, and demos

The built-in client can borrow concepts from the patient-facing UX, but it should stay developer-oriented and explicitly show technical artifacts.

## Current Foundation

The current server already gives us a strong base:

- a React app mounted at the server root
- patient cards with encounter summaries
- patient-level scenario summaries and encounter summaries in FHIR extensions
- mode-specific FHIR surfaces
- site-specific SMART configuration
- dynamic client registration
- key-based client authentication suitable for `cnf`-bound tickets
- token exchange
- introspection
- a preview-only surface at `/modes/anonymous/...` for local comparison

This means the demo client should build on the existing `fhir-server/ui/` app rather than adding a separate dashboard stack.

## Product Principles

### 1. Show the Real Flow

The demo client should use the real server endpoints and the real token exchange path. It should not fake the access token or short-circuit server filtering.

### 2. Keep The Ticket Spec-Like

The form should drive spec-facing ticket claims:

- subject
- SMART scopes
- periods
- jurisdictions
- organizations
- `details.sensitive.mode`

It should not expose implementation details like `allowedSites` or internal label systems.

### 3. Prefer Concrete Constraints

Every form choice should be grounded in the selected patient’s real data:

- actual sites of care
- actual date range
- actual resource types present
- actual sensitivity impact

### 4. Optimize For Inspection

Every important artifact should be inspectable and copyable:

- ticket payload JSON
- signed ticket JWT
- registration request/response
- token exchange curl
- token response
- decoded access token claims
- final FHIR queries

## Primary UX Model

The built-in client should feel like an “authorization workbench” attached to the selected patient.

### Step 1: Select A Patient

Use the existing patient cards as the entry point.

When the user selects a patient, the demo flow opens with:

- the patient scenario summary
- sites of care
- encounter timeline
- a short explanation of what constraints are interesting for this patient

### Step 2: Configure Constraints

Present a developer-facing form with these controls:

#### Resource Scopes

- one checkbox per resource type actually present for the patient
- optional granular category choices where the current server supports them
  - `Observation?category=...`
  - `DocumentReference?category=...`
  - `Condition?category=...`
  - `DiagnosticReport?category=...`

#### Date Range

- start/end date controls
- default to the full patient timeline
- show the patient’s actual min/max encounter dates as context

#### Site / Jurisdiction / Organization

- site checkboxes for the patient’s actual sites of care
- grouped or labeled by jurisdiction
- jurisdiction toggles can drive the ticket’s `authorization.access.jurisdictions`
- site or organization selection can drive `authorization.access.organizations`

The UI should keep this spec-facing:

- use jurisdictions when the user is making a jurisdiction choice
- use organizations when the user is making an org/site choice
- do not surface server-local `allowedSites`

#### Sensitive Data

- toggle between `sensitive.mode = deny` and `sensitive.mode = allow`
- show how many resources this affects for the selected patient

### Step 3: Hand Off To The App

The landing page should stop at a ticket-and-network handoff.

It should prepare:

- the signed Permission Ticket
- the selected patient summary
- the network SMART/FHIR base
- issuer info
- any demo-only client bootstrap material needed for private-key auth

The viewer app should then do the real work:

- dynamic registration when needed
- network token exchange
- network RLS resolution
- one token exchange per returned site
- one introspection call per returned site
- one set of site-scoped FHIR queries per returned site

The normal flow should stay site-oriented, not global-FHIR-oriented.

### Step 4: Register Client If Needed In The Viewer

Behavior depends on the selected mode:

- `open`
  - no client registration required
- `registered` / `strict`
  - dynamically register a key-based client
- `key-bound`
  - dynamically register or preconfigure a key-based client and authenticate with the matching private key

The preferred model is:

- client generates or is provisioned a keypair
- dynamic registration sends the public key material
- token exchange uses a private-key-based client assertion
- when the ticket carries `cnf.jkt`, the same key material is used to prove the caller is the intended client

In `strict`, this should be mandatory:

- the viewer must present a valid private-key client assertion
- if the Permission Ticket carries `cnf.jkt`, that thumbprint must match the authenticated client key
- token exchange without the correct bound client assertion must fail

### Step 5: Build And Sign The Ticket

The client builds a Permission Ticket payload using:

- `authorization.subject.type = "match"`
- patient name and birthDate from the selected Patient
- selected scopes
- selected periods
- selected jurisdictions and/or organizations
- `details.sensitive.mode`

The important design boundary is:

- **ticket builder**
  - produces claims JSON
- **ticket signer**
  - is a simulated issuer surface under `/issuer/{issuerSlug}`
  - turns claims into an ES256-signed JWT
  - publishes its public key at `/issuer/{issuerSlug}/.well-known/jwks.json`

These should be separate interfaces in code.

## Ticket Signing Strategy

The built-in client should not sign Permission Tickets in the browser.

The intended model is:

- browser builds claims JSON
- issuer surface signs with ES256 under `/issuer/{issuerSlug}/sign-ticket`
- verifier resolves issuer keys from `/issuer/{issuerSlug}/.well-known/jwks.json`

That keeps the demo aligned with the real cross-boundary artifact model while still letting the reference stack simulate the issuer in-process.

## Why The Demo Client Should Not Offer Token Duration In V1

The earlier draft included a “duration” control. The current server does not accept caller-chosen access-token TTL; `expires_in` is controlled by server config.

So in phase 1:

- do not expose a token-duration selector
- show the server-returned `expires_in`

If we later add “requested max TTL” semantics to the server, then the UI can expose a duration control.

## Step 6: Resolve Sites Through The Network Surface

Use the network SMART surface first:

- dynamic registration when needed
- token exchange against `/networks/{networkSlug}/token`
- call `/networks/{networkSlug}/fhir/$resolve-record-locations`

Persist:

- network SMART discovery response
- network registration response
- network token response
- decoded network access token
- network introspection response
- resolved endpoint bundle

## Step 7: Exchange The Ticket Per Returned Site

Use each returned site’s real token endpoint:

- `grant_type=urn:ietf:params:oauth:grant-type:token-exchange`
- `subject_token_type=https://smarthealthit.org/token-type/permission-ticket`
- `subject_token=<signed JWT>`
- private-key client authentication when required by mode
- `client_id` plus `private_key_jwt` client authentication when the mode requires a registered client

Persist:

- SMART discovery response
- registration response
- token response
- decoded access token
- introspection response
- site-specific auth base
- site-specific FHIR base

## Step 8: Query Constrained Results

Use each issued access token against the exact site FHIR base it was minted for.

Show:

- Patient read
- per-resource-type counts
- browseable resources
- encounter timeline

The core value is comparison, so the UI should show:

- authorized result counts
- preview result counts from the preview surface
- what changed when constraints changed

### Baseline Comparison Rule

The comparison should stay site-specific:

- compare each authorized site session to the matching preview site base
- do not collapse the normal demo flow into one global FHIR comparison surface

## Data Sources

The client should reuse the existing landing-page data where possible:

- patient summary extension
- encounter summary extension
- Patient resources
- Encounter resources

Phase 1 should avoid adding custom server endpoints unless necessary.

If repeated client-side FHIR fanout becomes too noisy or slow, then add one lightweight same-origin demo bootstrap endpoint later. But that should be a follow-on optimization, not the default design assumption.

## UI Structure

Build on the existing `fhir-server/ui/` app.

Suggested components:

- `Hero`
  - existing overview / mode context
- `PersonCard`
  - existing patient selection entry point
- `ConsentWorkbench`
  - selected patient + constraint form
- `AuthFlowPanel`
  - handoff summary only; the viewer owns registration and token exchange
- `TokenInspector`
  - decoded JWT viewer
- `ResultsWorkbench`
  - counts, browseable resources, comparisons
- `EncounterTimelineComparison`
  - included vs excluded encounters
- `DataContract`
  - existing server/data conventions

## State Shape

The demo state should be layered around boundaries, not around widgets.

Suggested high-level sections:

- `selection`
  - selected person
  - selected mode
- `constraints`
  - scopes
  - granular scopes
  - periods
  - jurisdictions
  - organizations/sites
  - sensitive mode
- `routing`
  - selected site sessions
  - per-site SMART config URLs
  - per-site auth bases
  - per-site FHIR bases
- `authArtifacts`
  - SMART discovery response
  - client registration response
  - ticket payload
  - signed ticket
  - token response
  - decoded access token
  - introspection response
- `results`
  - authorized counts
  - preview counts
  - fetched resources
  - selected resource type

## Testing Strategy

The draft needed more emphasis on test boundaries.

### Unit-Level

- constraint-to-ticket-claim mapping
- viewer handoff payload construction
- scope serialization
- sensitive toggle mapping
- ticket artifact rendering helpers

### Integration-Level

Exercise the real server endpoints in a browserless or component-level test harness:

- dynamic registration when required
- JWK-based registration and private-key client authentication when required
- ticket signing
- network token exchange
- `$resolve-record-locations`
- token exchange
- strict-mode rejection when the client assertion is missing or does not match `cnf.jkt`
- site-specific token issuance
- audience-bound token use
- authorized queries
- preview queries against site-specific preview bases
- before/after count changes

### UI-Level

At least one test should prove the user can:

- pick Elena
- exclude Texas / keep California
- deny sensitive data
- authorize
- see OB data excluded

## Phased Implementation

### Phase 1: Single-Patient Demo Flow

- select a patient from existing cards
- configure scopes / dates / site-or-jurisdiction / sensitive mode
- build and sign ticket
- hand off to the viewer
- show decoded ticket artifacts

Target mode:

- `open`

### Phase 2: Authorized Results + Baseline

- authorized resource counts
- preview counts from the preview surface
- browseable resources
- included/excluded encounter visualization

### Phase 3: Viewer-Owned Network Discovery + Site Sessions

- network SMART discovery, token exchange, and RLS resolution
- site-specific SMART discovery per returned site
- per-site token exchange and introspection
- prove audience-bound behavior in the artifact display

### Phase 4: Strict / Registered Mode Support

- dynamic registration flow in the UI
- copy-as-curl for registration and token exchange
- mode selector for developers

### Phase 5: Stronger Issuer Integration

- keep the browser-side ticket builder separate from the issuer signing call
- support choosing among configured issuers when the demo grows beyond one default issuer
- keep the current in-stack issuer path swappable for a more external issuer deployment later

## Acceptance Criteria

This plan is successful when:

- a developer can complete the full flow in-browser without leaving the page
- the UI uses the real token exchange endpoint and the real FHIR endpoints
- the selected constraints are visible in the ticket payload
- the resulting access token is inspectable and clearly tied to the site FHIR base it was minted for
- changing constraints changes the returned result counts in an understandable way
- the demo remains clearly labeled as a developer/demo surface, not a production consent implementation
