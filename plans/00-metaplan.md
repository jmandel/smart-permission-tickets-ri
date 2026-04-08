# Reference Implementation — Meta-Plan

## Goal

Build a self-contained, demo-able, developer-friendly reference implementation of the SMART Permission Tickets specification. The implementation should show the full flow working end-to-end: ticket issuance, token exchange, FHIR query filtering, and constrained data return — with realistic synthetic patient data grounded in real record shapes.

## Audience

Serves two audiences equally:
- **Live demo**: Walk stakeholders through the flow visually, showing real JWT validation, real data filtering, clear before/after comparisons
- **Developer sandbox**: Clone, run, experiment — good API surface, curl examples, easy to modify scenarios

## Component Plans

### Plan 1: Overall Architecture & Component Wiring
`01-architecture.md`

- Component diagram: Bun FHIR server, Trusted Issuer, Client App, Demo Dashboard
- Service topology: Docker Compose, ports, inter-service discovery
- Which use cases to demo (primary: UC1 patient access; secondary: UC4 social care, UC3 public health — covers patient-initiated vs B2B, cnf-bound vs unbound, match vs reference subject resolution)
- Two deployment modes: file-backed SQLite and lightweight in-memory SQLite
- Tech stack: Bun + Hono for servers, React + Vite for dashboard, jose for JWT, SQLite for FHIR storage
- How the existing `scripts/keys/` and `scripts/types.ts` get reused

### Plan 2: Bun FHIR Server
`02-fhir-server.md`

- Single-process Bun + TypeScript FHIR server over SQLite
- One logical corpus with site-partitioned virtual views
- SMART on FHIR surface including smart-configuration, dynamic client registration, `/token`, and token introspection
- JWK-based dynamic registration and private-key client authentication as the intended path for `registered`, `key-bound`, and `strict`
- Strict default root surface plus opt-in named mode mounts for looser policies
- Request-scoped visible-set enforcement for `read`, `search`, and limited chaining
- Permission Ticket validation pipeline:
  - signature via issuer JWKS
  - `ticket_type`, `aud`, `exp`, `cnf.jkt` binding
  - subject resolution (match, identifier, reference)
  - compilation into a normalized local authorization envelope
- Token exchange + stateless signed JWT access token issuance with resolved patient binding, plus JWT-backed token introspection
- Strict-mode client-binding enforcement:
  - missing or invalid client assertions fail
  - `cnf.jkt` mismatch fails
- Explicit US Core-aligned search subset rather than generic HAPI proxying
- Sensitive-data handling via abstract ticket semantics and local `meta.security` mapping
- Error responses per spec (`invalid_grant`, `invalid_scope`, etc.)

Supporting docs:
- Server plan: [02-fhir-server.md](./02-fhir-server.md)
- Normalized server input contract: [ticket-input-spec.md](./ticket-input-spec.md)

### Plan 3: Synthetic Data Pipeline
`03-synthetic-data.md`

The most novel component. Fractal expansion approach using LLM augmentation, grounded in real patient record shapes.

- **Seed analysis**: Real records from two sites (~400-500 resources each) establish the "shape" — resource type distribution, encounter patterns, vitals frequency, condition mix, medication patterns
- **Level 0 — Patient biography**: LLM generates a patient's life story and clinical arc (demographics, disease states, life events, care-seeking patterns)
- **Level 1 — Provider map**: Which sites they received care at, when, why. Geographic distribution across states (for jurisdiction filtering demo). Organization identifiers.
- **Level 2 — Encounter timeline**: Per site, what visits occurred. Types (office, ED, telephone, lab, telemedicine). Reasons. Calibrated against real encounter frequency/type distribution.
- **Level 3 — Resource inventory**: Per encounter, what resources should exist. Observations (vitals, labs), conditions assessed, medications prescribed, immunizations given, documents generated. Calibrated against real resource-per-encounter ratios.
- **Level 4 — FHIR resource generation**: Actual FHIR R4 JSON, using real records as structural templates. Real terminology codes (SNOMED, LOINC, ICD-10, RxNorm, CVX). Realistic values (lab ranges, vital sign ranges).
- **Vocabulary grounding**: Curated code catalogs per clinical domain, included in LLM prompts as "code menus." LLM picks from known-good codes. Post-validation against terminology snapshots.
- **Constraint-exercise filtering**: Organization and jurisdiction limits are compiled from site metadata at ingest time, while sensitive data remains explicit on resources via `meta.security`.
- **Multi-site distribution**: Resources loaded into one SQLite corpus and exposed through site-partitioned virtual bases.
- **Validation & loading**: FHIR schema validation, referential integrity checks, deterministic id reminting, and ingest into SQLite.

### Plan 4: Trusted Issuer + Consent Flow
`04-trusted-issuer.md`

- issuer-scoped JWKS endpoints (`/issuer/{slug}/.well-known/jwks.json`) serving issuer public keys
- Consent session API: client redirects patient to issuer, patient approves, issuer mints ticket, redirect back
- Ticket minting: builds PermissionTicket payload per use case, signs with issuer ES256 key
- ID proofing simulation: UI step that shows identity verification (name, DOB confirmation) without real identity verification. Placeholder for integration with real IdP (Clear, etc.)
- CRL endpoint for revocation demo (serves a static revocation list, demonstrates the checking flow)
- How the existing `ux/` consent screen connects (or whether we build a simplified version)

### Plan 5: Network Directory + Record Location Service
`05-network-directory-rls.md`

- network-scoped SMART/FHIR surface at `/networks/{networkSlug}/fhir`
- network token exchange that redeems a signed Permission Ticket into a network-scoped OAuth access token
- directory search for `Endpoint` and `Organization`
- network-level `$resolve-record-locations` operation returning only sites with visible clinical data under the ticket
- response bundles containing `Endpoint` resources with linked `Organization` resources
- clean separation between:
  - issuer surfaces
  - network discovery surfaces
  - site clinical data surfaces

### Plan 6: Built-In Demo Client
`06-demo-client.md`

- Extend the built-in FHIR server UI rather than adding a separate dashboard stack
- Developer-facing authorization workbench: patient selection → constraint configuration → ticket minting → token exchange → constrained FHIR queries
- Route-aware SMART usage: issuer → network SMART/RLS → site-specific SMART config, token endpoints, and FHIR bases
- JWT / curl / request-response artifact inspection
- Before/after comparison using the anonymous baseline view
- Uses issuer-scoped ES256 signing in-stack today, with a clean boundary to later plug in a more external Trusted Issuer flow

Current remediation / refinement plan:
- [07-demo-client-remediation.md](./07-demo-client-remediation.md)

### Plan 8: Trust Frameworks + Client Identity Binding
`08-trust-frameworks-client-binding.md`

- add a shared trust-framework abstraction used for both client auth and issuer trust
- keep unaffiliated dynamic registration while adding:
  - no-registration `well-known:<uri>` clients
  - UDAP-flavored dynamic registration and authentication
- add framework-backed ticket binding via a spec-facing `client_binding` object
- preserve `cnf.jkt` for frameworkless exact-key binding
- reuse the same framework layer for framework-backed issuer trust and JWKS resolution while preserving the local issuer registry
- for UDAP, select the applicable framework by trust evaluation of the presented chain and SAN, not by request extensions
- where one auth surface participates in multiple UDAP trust communities, support `/.well-known/udap?community=<uri>` discovery
- extend SMART configuration to advertise supported frameworks and binding types

### Plan 9: UDAP CRL and Revocation Support
`09-udap-crl-revocation.md`

- add CRL Distribution Points to demo UDAP certificates
- publish demo CRLs from the reference server
- make UDAP certificate-path validation revocation-aware
- stage the work in two phases:
  - Phase 1: interoperable demo PKI and CRL publication
  - Phase 2: runtime CRL enforcement in UDAP registration and token auth
- improve alignment with UDAP revocation expectations and external validation tooling

### Plan 10: Demo Client Types and Just-In-Time Registration
`10-demo-client-types-and-jit-registration.md`

Status: implemented

- add an explicit client-type choice to the **strict-mode** landing/workbench flow:
  - unaffiliated registered client
  - well-known client
  - UDAP client
- move the demo flow to:
  - choose patient
  - choose client type
  - configure ticket
  - launch viewer
- exercise three materially different client paths already supported by the backend:
  - dynamic JWK registration
  - implicit `well-known:<uri>` identity
  - just-in-time UDAP dynamic registration
- make ticket binding shape depend on client type:
  - `cnf.jkt` for unaffiliated exact-key flows
  - `client_binding` for well-known and UDAP flows
- expand the viewer handoff model so the viewer knows how to prepare and authenticate the selected client path
- improve demo artifacts and docs so users can see which client path was used and why

### Plan 11: UDAP Replay Protection and Registration State
`11-udap-replay-and-registration-state.md`

Status: implemented

- add in-memory `jti` replay prevention for UDAP software statements and client assertions
- add in-memory active-registration state for UDAP re-registration and cancellation semantics
- keep the signed self-contained UDAP client descriptor, but reject superseded `client_id`s in-process
- explicitly document the restart caveat:
  - process restarts clear replay and active-registration state
  - older signed UDAP `client_id`s may become valid again until a fresh registration supersedes them
- treat this as a reference-implementation hardening slice, not a production-grade persistence design

### Plan 12: Permission Ticket Spec and Implementation Alignment
`12-permission-ticket-spec-implementation-alignment.md`

- align the core ticket validator with the current spec where the gaps are real:
  - required `exp`
  - `invalid_grant` for ticket-binding failures
  - accurate SMART config grant-type advertisement
- formalize the currently implicit `network-patient-access-v1` `details` semantics:
  - `dateSemantics`
  - `sensitive.mode`
- implement framework-aware `aud` validation so tickets can target trust-network membership, not only one URL
- implement Permission Ticket revocation checking distinct from UDAP certificate CRLs
- explicitly document which mismatches should be fixed in code, which should be fixed in the spec, and which are intentionally deferred

### Plan 13: Demo Event Visualization
`13-demo-event-visualization.md`

- add a live event visualization to the reference server so authorization decisions, token exchanges, and FHIR queries are observable in real time during demos
- two-panel hybrid layout: compact living summary (left) + scrollable audit feed (right)
- every important event leaves lasting visual state (pills, badges, status dots); small events leave small traces
- SSE-based event streaming scoped per demo session via `X-Demo-Session` header
- every visual element is clickable → opens artifact viewer with full request/response/JWT detail
- server-side instrumentation at ~20 natural decision points; client-side event posting from the viewer
- educational focus: makes trust chain, fan-out, per-site independence, and scope narrowing tangible

### Plan 14: Permission Ticket Portable-Kernel Redesign
`14-permission-ticket-portable-kernel-redesign.md`

- define a smaller, enforceable Permission Ticket portable kernel and rewrite the formal spec around it
- keep JWT / token exchange / URI `ticket_type` / a unified `presenter_binding` container with independent key/framework sub-bindings
- make `access.permissions` the normative rights model; SMART scopes are a coarse projection
- define portable common filtering: one coarse `data_period`, one `sensitive_data` switch (default `exclude`), coarse `jurisdictions`, positive `source_organizations`
- remove `authority` — legal basis is implied by `ticket_type` + `requester` type + `context.kind`
- remove `regrant` / `derivedFrom` — may revisit as client-attenuable model later
- add `must_understand` for profile-specific must-understand extensibility (inspired by JWS `crit`)
- add `supporting_artifacts` for optional audit/review material not needed for yes/no
- `requester` is issuer-attested; recipient trusts it for policy but does not independently verify
- all kernel fields are must-understand when present; unknown fields safe to ignore unless in `must_understand`
- move weaker semantics out of the common shell and into `context`, `supporting_artifacts`, or profile-specific space
- work through all seven use cases with minimum enforceable examples

### Plan 15: Spec / Reference-Implementation Schema Unification and Migration
`15-spec-refimpl-schema-unification-and-migration.md`

- make one canonical Permission Ticket schema shared by:
  - the main spec
  - spec-generation scripts
  - the reference implementation server and UI
- use Zod as the executable source of truth for the ticket wire model
- derive:
  - runtime parsing/validation
  - TypeScript types
  - JSON Schema for spec publication and example checking
- migrate the reference implementation from the old ticket model (`cnf`, `client_binding`, `authorization`, `details`) to the new portable-kernel model (`presenter_binding`, `subject`, `access`, `context`)
- update the server, UI, visualizer, tests, and smoke paths in a coordinated sequence
- preserve current resource-filtering and revocation behavior where compatible, while moving to `access.permissions` as the canonical authorization model

### Plan 20: Viewer Clinical Banner and Density Refresh
`20-viewer-clinical-banner-and-density-refresh.md`

Status: implemented

- make the viewer feel more like a compact clinical application and less like a generic demo shell
- derive patient identity context from the signed ticket and loaded `Patient` resources, not duplicated launch-only demographics
- replace the generic viewer header with a patient-banner pattern showing name, DOB/age, and gender when available
- improve action hierarchy by keeping navigation primary and operational utilities secondary
- tighten the overview strip into denser insight cards
- further simplify site summaries so they show only the clinically useful information at a glance
- preserve the separation established by Plans 17 and 18:
  - protocol detail stays in Protocol Trace
  - the viewer stays focused on clinical data and selection/exploration

### Plan 21: Add OpenID Federation 1.0 Support
`21-add-openid-federation-support.md`

Status: implemented on `main`

- adds a spec-aligned OIDF framework path for:
  - automatic-registration-style client authentication via `trust_chain`
  - metadata-policy resolution
  - OIDF-backed issuer trust and trust-mark verification
- Phases 1 through 7 are implemented on `main`
- the trust-chain shape and validation model were corrected after RFC review and are now folded directly into the canonical Plan 21 text
- Phase 7 UI / Protocol Trace integration, including the OIDF client demo flow, is now on `main`

### Plan 24: Demo Crypto Bundle and OIDF Re-Minting
`24-demo-crypto-bundle-and-oidf-remint.md`

Status: implemented on `main`

- fixes the long-running demo expiry bug by re-minting OIDF entity statements and trust marks on fetch
- revises the provider-side OIDF topology so each site is a discoverable Provider Network leaf
- adds one optional generated crypto-bundle file that can stabilize demo keys across restarts, including per-site OIDF keys
- keeps zero-config behavior working when no bundle is present
- prefers one explicit stored bundle over a seed-based derivation scheme
- Phases 1 through 6 are implemented on `main`

### Plan 25: Issuer Key Publication and Cross-Source Consistency
`25-issuer-key-publication-and-cross-source-consistency.md`

Status: in progress

- rewrites the spec so issuer public-key publication gives equal billing to direct JWKS, OIDF entity configurations, and UDAP discovery rooted at `iss`
- keeps `PermissionTicket` serialization framework-neutral and makes issuer-framework participation purely verifier-side
- adds a generic ordered issuer-trust policy model so the verifier can support direct JWKS, OIDF, and UDAP while the current demo holder runtime stays on allowlisted direct-JWKS resolution by default
- adds publication-level consistency tests for issuers that this repo exposes through more than one mechanism, without requiring token-time secondary-source checks
- Phases 1 through 4 are implemented on `main`, including the explicit verifier-side issuer-trust policy model, the direct-JWKS default runtime path, and the JWKS + OIDF publication-consistency tests

## Dependencies Between Plans

```
Plan 3 (Synthetic Data) ──→ Plan 2 (FHIR Server) ──→ Plan 6 (Built-In Demo Client)
                                      ↑                   ↑
Plan 4 (Trusted Issuer) ─────────────┘                   │
                                      ↑                   │
Plan 5 (Network Directory + RLS) ────────────────────────┘
                                      ↑
Plan 8 (Trust Frameworks + Client Identity Binding) ─────┘
                                      ↑
Plan 9 (UDAP CRL + Revocation) ───────┘
                                      ↑
Plan 10 (Demo Client Types + JIT Registration) ─────────┘
                                      ↑
Plan 11 (UDAP Replay + Registration State) ─────────────┘
                                      ↑
Plan 12 (Ticket Spec/Impl Alignment) ───────────────────┘
                                      ↑
Plan 13 (Demo Event Visualization) ────────────────────┘
                                      ↑
Plan 14 (Portable-Kernel Redesign) ────────────────────┘
                                      ↑
Plan 15 (Schema Unification + Ref Impl Migration) ─────┘
                                      ↑
Plan 21 (OpenID Federation 1.0 Support) ───────────────┘
                                      ↑
Plan 24 (Demo Crypto Bundle + Site OIDF Leaves) ──────┘
                                      ↑
Plan 23 (Generalize OIDF Consumption) ────────────────┘
                                      ↑
Plan 25 (Issuer Key Publication + Cross-Source Consistency) ─┘
                                      ↑
Plan 20 (Viewer Banner + Density Refresh) ─────────────┘
                                      ↑
Plan 1 (Architecture) ───────────────┘ (informs all others)
```

- Plan 1 sets the foundation — tech choices, topology, deployment model
- Plan 3 (synthetic data) and Plan 4 (issuer) can proceed in parallel
- Plan 2 (FHIR server) depends on having data to serve and tickets to validate
- Plan 5 (network directory + RLS) depends on issuer validation behavior and the same site-visibility model used by the server
- Plan 6 (built-in demo client) depends on the server behavior being stable enough to expose and inspect
- Plan 8 (trust frameworks + client identity binding) extends the server, issuer, and demo-client plans once the current JWK-only path is stable enough to generalize
- Plan 9 (UDAP CRL + revocation) extends Plan 8 once UDAP trust roots, signed metadata, and token-time certificate validation are in place
- Plan 10 (demo client types + just-in-time registration) extends Plans 6, 7, and 8 once the backend client stories are implemented and stable enough to expose directly in the UI
- Plan 11 (UDAP replay + registration state) hardens Plan 8 after interoperability is in place, while intentionally remaining in-memory and restart-local for the reference implementation
- Plan 12 (ticket spec / implementation alignment) is the follow-on cleanup and completion pass for the currently implemented Permission Ticket model, especially around `exp`, audience semantics, revocation, and ticket-type-specific `details`
- Plan 13 (demo event visualization) adds a live event visualization so every authorization decision, token exchange, and FHIR query is observable during demos — making the protocol's trust chain, fan-out, and per-site independence tangible and inspectable
- Plan 14 (portable-kernel redesign) is a design-first precursor to any deeper spec or implementation rewrite of the Permission Ticket shell
- Plan 15 (schema unification + reference-implementation migration) is the execution plan that turns Plan 14 into a shared canonical schema and a migrated working reference implementation
- Plan 24 (demo crypto bundle + site OIDF leaves) is a follow-on to Plan 21 that makes provider sites first-class OIDF leaves, fixes OIDF JWT expiry by re-minting on fetch, and adds an optional bundle file for stable demo keys across restarts. It is fully implemented on `main`.
- Plan 23 (generalize OIDF entity consumption) is the follow-on to Plans 21 and 24 that turns the current demo-local OIDF resolver into a generic allowlist-based consumer. It is fully implemented on `main`, including allowlist-based OIDF client trust, discovery-driven issuer trust, external-origin coverage tests, and README/diagnostic cleanup.
- Plan 25 (issuer key publication + cross-source consistency) is the follow-on hardening/spec-clarification plan after Plans 23 and 24: it broadens the issuer-key publication model to cover direct JWKS, OIDF, and UDAP discovery rooted at `iss`, keeps `PermissionTicket` serialization framework-neutral, adds an explicit ordered issuer-trust policy model, adds publication-level consistency tests for issuers exposed through more than one mechanism, and includes UDAP issuer resolution from `iss` under explicit verifier policy. Plan 25 is complete on `main`.
- Plan 20 (viewer clinical banner + density refresh) is a follow-on viewer polish pass after Plans 17, 18, and 19: it keeps protocol detail in Protocol Trace while making the viewer itself feel more like a compact clinical application

## Seed Data Available

Real patient records from two Wisconsin health systems (gitignored in `.seed-data/`):

| | UnityPoint Health | UW Medical Foundation |
|---|---|---|
| Resources | ~482 | ~372 |
| Time span | 7.5 yrs (2018-2026) | 6 yrs (2019-2025) |
| Observations | 358 (74%) — vitals, PHQ-2 | 147 (40%) — vitals, labs |
| Documents | 51 | 69 |
| Conditions | 53 — post-concussion, GERD, HTN | 17 — allergies, post-concussion |
| Encounters | 34 — phone, office, lab, telehealth | 19 — ambulatory, ED |
| Medications | 18 | 8 |
| Immunizations | 19 | 0 (empty array) |
| Practitioners | 29 | 60 |
| Organizations | 5 | 7 |

Key patterns to replicate in synthetic data:
- Vitals-heavy observation distribution (most obs are BP, HR, weight, SpO2, BMI)
- Cross-site clinical continuity (same conditions at both sites)
- Realistic encounter type mix (telephone, office, ED, lab, telemedicine)
- Large document reference component (progress notes, ED notes, imaging)
- ~400-500 resources per site is a realistic patient record size
- Mix of standard codes (SNOMED, LOINC) and proprietary codes (Epic OIDs)

## What's Real vs Simulated

| Aspect | Implementation |
|---|---|
| JWT signing/verification | Real (ES256 via jose) |
| Token exchange (RFC 8693) | Real |
| Ticket validation (all checks) | Real |
| Subject resolution | Real (match, identifier, reference) |
| Scope intersection | Real |
| FHIR query filtering | Real (pre-filter + post-filter) |
| FHIR data storage | Real (Bun + SQLite FHIR server) |
| ID proofing | Simulated (UI placeholder, confirms identity without real verification) |
| Trust chain verification | Simplified today, with Plan 8 expanding this toward framework-aware validation for UDAP and well-known clients/issuers |
| Revocation checking | Structural (CRL endpoint exists, checking works, but CRL is static) |
| UDAP certificate revocation | Not yet implemented for trust-framework PKI; planned in Plan 9 |
| Client registration | Real enough for the reference server (preconfigured clients plus restart-safe dynamic registration, with JWK/private-key auth as the intended path) |

## Next Steps

Write each plan in detail, starting with whichever the author wants to go deep on first. Plan 3 (synthetic data) is likely the most novel and benefits most from early design work. Plan 1 (architecture) is the natural foundation.
