# Plan 7: Demo Client Remediation

## Goal

Refactor the built-in demo client and the token-backed viewer so they behave like a real multi-site health app, not a server-debug dashboard. The immediate focus is to fix the current UX, handoff, and query-behavior problems without changing the underlying Permission Ticket model.

This plan is explicitly a follow-on to [06-demo-client.md](./06-demo-client.md). Plan 6 established the broad shape. This plan addresses concrete issues discovered while using the current implementation.

Note: this document records remediation findings as well as the intended target state. Some quoted strings below, such as `Mode strict`, `Use ticket in app`, or `Anonymous`, are examples of the broken UI/content that needed to be removed, not the desired end-state copy.

## Immediate Problems To Fix

### P0 correctness

- hardcoded IG links point at the wrong publisher path
  - current bad path:
    - `https://build.fhir.org/ig/nicktobbes/smart-permission-tickets/`
  - desired path:
    - `https://build.fhir.org/ig/jmandel/smart-permission-tickets-wip/`
- the landing page and workbench still leak a “global `/fhir`” mental model into flows that should stay site-specific
- the viewer currently has an incomplete / brittle site-load path
- the server’s `_count` and paging behavior needs explicit validation and likely fixes
  - the UI currently implies `_count=20` should shape the returned page
  - we need to prove that the server respects `_count`
  - we need `Bundle.link[next]` semantics to work correctly if more data exists

### P1 information architecture

- the hero/header still exposes auth-surface mechanics too prominently
- `About` / developer-help content is not organized like a normal app help surface
- random labels such as `Mode strict` and unlabeled pills appear without context
- buttons and pills are visually conflated
- the workbench still has layout and control-group choices that feel like internal tooling, not a coherent app

### P1 viewer / handoff

- the handoff from ticket builder to app still feels like an extra indirection step
- the app should receive the ticket and do the real work itself
- artifacts should open in purpose-built viewer tabs rather than giant inline blocks
- site browsing, token artifacts, and fetched data should be organized into a clearer app structure
- dynamic registration is currently too symmetric-secret flavored, which is the wrong center of gravity for `cnf`-bound Permission Tickets
- strict mode does not yet have an explicit “missing or wrongly bound client assertion must fail” story in the demo/app plan

## Product Direction

### 1. Treat The Landing Page As A Ticket Builder

The landing page should:

- explain the product briefly
- let the developer pick a patient
- let the developer configure ticket constraints
- hand the signed ticket to the app

It should not try to be the place where the multi-site data experience happens.

### 2. Treat The Viewer As The Client App

The `/viewer` app should become the health-app surface.

It should receive:

- the signed Permission Ticket
- per-site SMART base information
- any required demo client material

For `registered`, `strict`, and `key-bound` flows, that handoff should include client material suitable for private-key authentication:

- client registration metadata
- client public key / JWK
- private key material for the local demo app only

The point is that the viewer app, not the landing page, should be the thing that proves possession of the client key during token exchange.

Then it should:

- register a client if needed
- exchange the ticket separately at each site-specific token endpoint
- introspect / display the resulting site-specific access tokens
- query each site independently
- collate results into a cross-site chart view

### 3. Keep The Model Site-Scoped

The app should avoid talking about a universal “global FHIR surface” in the normal demo flow.

The server may continue to expose a global `/fhir` base for completeness, but the built-in demo client should default to:

- site-specific SMART config
- site-specific token endpoints
- site-specific FHIR browsing

One ticket can still authorize multiple sites, but the client app should represent that as:

- one ticket
- many site sessions
- many site tokens

not as one synthetic universal record store.

### 4. Keep The UI Developer-Friendly But App-Like

The design target is:

- simpler information architecture
- explicit next steps
- clear separation between controls, status, and inspection surfaces
- less “dashboard chrome”
- fewer pills used as buttons
- fewer unlabeled implementation words

## Workstreams

## A. Correctness / Spec Hygiene

### A1. Fix hardcoded IG links

Update all demo UI and server-rendered links to:

- `https://build.fhir.org/ig/jmandel/smart-permission-tickets-wip/`

Current known offenders:

- `fhir-server/ui/src/components/Hero.tsx`
- `fhir-server/src/app.ts`

Acceptance:

- no remaining `nicktobbes` IG links in the repo UI/server surfaces

### A2. Verify `_count` and paging

Review and fix server search paging behavior in:

- `fhir-server/src/store/search.ts`

Required behavior:

- `_count=N` limits returned entries to `N`
- `Bundle.total` still reflects total matching resources
- `Bundle.link[next]` is present when more results are available
- `next` links preserve token-safe site/mode base paths and search parameters

Tests to add:

- `_count=1` on a known multi-result search returns one entry
- `Bundle.total > entry.length`
- `Bundle.link[next]` exists and fetches the next page
- paging works on both site-specific and mode-prefixed bases

This is a P0 before more viewer polish because the app is increasingly relying on search pagination semantics.

## B. Landing Page IA

### B1. Simplify the hero

The hero should contain:

- app title
- short description
- high-level counters
- a normal top-right menu

The hero should not contain:

- inline auth-surface selector tabs
- ambiguous mode pills with no explanation

### B2. Move surface help into About

The `Surfaces` concept should either:

- move into the About page entirely
- or stay as a small menu item that deep-links into the relevant About section

The menu should explain in a few words:

- what each surface is for
- how to get its base URLs
- when a developer would choose it

Not:

- “Open the same demo app against a different auth surface”

### B3. Add real info affordances

Ambiguous words such as `Mode` should deep-link to explanation:

- via `?` / `i` affordances
- or via links into the About panel in a new tab

Random standalone pills that only say `Mode strict` should not remain unexplained.

## C. Ticket Builder UX

### C1. Clarify constraint semantics

When no constraint is applied, the copy should say:

- `All sites`
- `All dates`
- `All supported resources`

not:

- `All 5 sites`
- or wording that makes the summary feel tied to the current count instead of the policy meaning

### C2. Fix “sites in scope” presentation

Replace pill-like site action rows with clearer structure:

- likely a simple list or compact table
- show current scope, not buttons disguised as tags

### C3. Eliminate “extra click” handoff

Do not force:

- click `Use ticket in app`
- then click another obvious next step

Instead, once a valid ticket is prepared, show direct next actions immediately:

- `Open health app`
- `Copy app link`
- `Copy ticket JWT`

The UI should feel like a completed handoff state, not a modal half-step.

### C4. Distinguish buttons from pills

Throughout the workbench:

- buttons should look like buttons
- informational tags should look passive
- links should look like links

No more controls that read like pills/tags.

## D. Viewer / App Architecture

### D1. Make `/viewer` the real app

The viewer should be the primary client app for the demo.

It should own:

- client registration
- token exchange
- introspection
- per-site session state
- site query execution
- chart collation

The landing page should not duplicate that logic.

The viewer should also be the place where key-bound client identity becomes concrete:

- register client key material
- perform private-key client auth
- bind `cnf.jkt` tickets to the same client key

### D2. Handoff contract

Define one stable handoff payload into `/viewer`, likely containing:

- selected patient summary
- signed ticket
- per-site SMART bases
- mode
- any demo-only client bootstrap info if needed
- client registration / key material needed for the viewer to authenticate itself

The viewer should be able to fully reconstruct its state from that payload.

This handoff shape should live in reusable UI-side library code, not component-local ad hoc structs.

For local demo purposes, the handoff may carry private key material directly. That is acceptable only because this is a same-origin localhost reference implementation. The plan should still keep this clearly marked as demo-only behavior.

### D3. Viewer structure

The viewer page should be reorganized into clear sections:

- patient summary / context
- site sessions
- access / token exchange artifacts
- chart timeline
- resource library
- query console

Avoid side-by-side layouts that make unlike things compete visually.

Preferred structure:

- top: patient + session summary
- then: site sessions
- then: chart timeline / resource library
- then: advanced query / raw inspection

### D4. Artifact inspection

Large JSON blobs should not dominate the primary app surface.

Instead:

- primary page shows concise summaries + copy buttons
- “Open details” launches a generic artifact viewer in a new tab

The artifact viewer should accept:

- title
- type
- JSON/text content or fetch target

and render:

- pretty JSON by default
- expandable sections where helpful
- copy button

This generic viewer should support:

- signed ticket
- token response
- decoded JWT claims
- introspection payload
- arbitrary raw FHIR JSON

### D5. Keep token artifacts separate

Do not collapse:

- SMART discovery
- access token response
- token introspection
- decoded client registration / client assertion context

into one combined session object on the page.

These are different artifacts with different meanings and should stay visibly separate.

Preferred layout:

- site rows
- artifact columns

For example:

- column 1: SMART discovery
- column 2: token response
- column 3: introspection
- optional additional columns: decoded token claims, registration response, client assertion details

Each cell should offer direct actions:

- `Copy`
- `Open in new tab`

The main page should show a concise matrix or grid view, while the full payloads render in dedicated artifact-viewer tabs.

### D6. Make key-based registration the app story

Preferred app story:

- generate or load a demo keypair
- dynamically register the public key
- authenticate token exchange with a private-key client assertion
- when the Permission Ticket includes `cnf.jkt`, verify it matches the client key thumbprint

This is important because otherwise the demo does not really prove that the exchanging client is the same client the ticket was meant for.

### D7. Make strict-mode binding failures explicit

The viewer and server plan should make strict-mode binding behavior obvious:

- strict-mode exchange without a client assertion should fail
- strict-mode exchange with an invalid assertion should fail
- strict-mode exchange with a client key that does not match the registered client should fail
- if the Permission Ticket carries `cnf.jkt`, strict-mode exchange with a non-matching client key should fail

The demo UI should surface these failures as meaningful artifacts, not generic “token exchange failed” messages.

## E. Query Experience

### E1. Cross-site query console

Keep the Postman-like console, but make its place in the app clearer:

- it is an advanced tool
- it should not visually compete with the chart/timeline

### E2. Capability-driven planning

The viewer should not hardcode a thin list of resource types for retrieval.

It should:

- inspect each site CapabilityStatement
- inspect the ticket scopes
- derive which resource searches or reads are reasonable
- gracefully skip unsupported queries

This is now a core architectural requirement, not optional polish.

### E3. Graceful degradation

The app should continue loading even if:

- a query is unsupported
- a query fails for one site
- a resource type is not available at one site

Those failures should be captured per site / per query and shown in a secondary inspection surface.

## F. Copy / Terminology

Specific content adjustments:

- replace `Anonymous` / `anonymous` column headers where a more contextual word is better
  - for example `Preview`
- use plain labels like:
  - `All sites`
  - `Preview`
  - `Open raw JSON`
  - `Open health app`
- remove phrases that imply the app is about “demoing all auth surfaces” on the main path

## G. Code Structure

The implementation should be reorganized into reusable libraries rather than growing component-local logic.

Minimum cutpoints:

- `ui/src/lib/ticket-builder.ts`
  - ticket payload construction
  - consent summary text
  - handoff payload construction
- `ui/src/lib/viewer-client.ts`
  - client registration
  - token exchange
  - introspection
  - FHIR fetch helpers
- `ui/src/lib/viewer-model.ts`
  - capability-driven query planning
  - resource collation
  - timeline shaping
  - groupings
- `ui/src/lib/artifact-viewer.ts`
  - generic artifact rendering / routing model

Components should become thinner orchestration layers over these libraries.

## Suggested Delivery Order

### Phase 1: correctness and content

- fix IG URLs
- fix `_count` + paging semantics and tests
- remove misleading global-surface language from the landing path
- simplify header / About
- make JWK-based dynamic registration and strict-mode client-binding semantics explicit in the viewer handoff and docs

### Phase 2: ticket builder cleanup

- fix button vs pill semantics
- clarify summaries and scope displays
- remove extra-click handoff
- clean up sites-in-scope and preview wording

### Phase 3: viewer stabilization

- finish the per-site session viewer
- move artifacts to secondary viewers
- improve page information architecture
- make site sessions, timeline, and resource library robust

### Phase 4: richer inspection

- generic artifact viewer tabs
- better raw JSON viewers
- improved query console / pagination browsing

## Acceptance Criteria

The remediation is complete when:

- all IG links point to the correct build URL
- the main demo flow no longer depends on the global `/fhir` surface
- one ticket leads to separate site token exchanges in the viewer
- `_count` and pagination are proven by tests
- strict mode is proven to reject missing / invalid / wrongly bound client assertions
- buttons and pills are visually distinct throughout
- About / developer-help content is discoverable without cluttering the main path
- artifacts are inspectable without giant inline JSON blocks dominating the main pages
- the viewer can load and collate multi-site data without brittle hardcoded resource assumptions

## Files Likely To Change

### Server

- `reference-implementation/fhir-server/src/app.ts`
- `reference-implementation/fhir-server/src/store/search.ts`
- `reference-implementation/fhir-server/test/modes.test.ts`
- `reference-implementation/fhir-server/src/smoke-test.ts`

### UI

- `reference-implementation/fhir-server/ui/src/components/Hero.tsx`
- `reference-implementation/fhir-server/ui/src/components/DataContract.tsx`
- `reference-implementation/fhir-server/ui/src/components/PermissionWorkbench.tsx`
- `reference-implementation/fhir-server/ui/src/components/Viewer.tsx`
- `reference-implementation/fhir-server/ui/src/styles.css`
- `reference-implementation/fhir-server/ui/src/demo.ts`
- `reference-implementation/fhir-server/ui/src/lib/artifact-viewer.ts`
- `reference-implementation/fhir-server/ui/src/lib/viewer-client.ts`
- `reference-implementation/fhir-server/ui/src/lib/viewer-model.ts`
