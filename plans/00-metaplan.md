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

## Dependencies Between Plans

```
Plan 3 (Synthetic Data) ──→ Plan 2 (FHIR Server) ──→ Plan 6 (Built-In Demo Client)
                                      ↑                   ↑
Plan 4 (Trusted Issuer) ─────────────┘                   │
                                      ↑                   │
Plan 5 (Network Directory + RLS) ────────────────────────┘
                                      ↑
Plan 1 (Architecture) ───────────────┘ (informs all others)
```

- Plan 1 sets the foundation — tech choices, topology, deployment model
- Plan 3 (synthetic data) and Plan 4 (issuer) can proceed in parallel
- Plan 2 (FHIR server) depends on having data to serve and tickets to validate
- Plan 5 (network directory + RLS) depends on issuer validation behavior and the same site-visibility model used by the server
- Plan 6 (built-in demo client) depends on the server behavior being stable enough to expose and inspect

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
| Trust chain verification | Simplified (issuer URL allowlist, not full federation) |
| Revocation checking | Structural (CRL endpoint exists, checking works, but CRL is static) |
| Client registration | Real enough for the reference server (preconfigured clients plus restart-safe dynamic registration, with JWK/private-key auth as the intended path) |

## Next Steps

Write each plan in detail, starting with whichever the author wants to go deep on first. Plan 3 (synthetic data) is likely the most novel and benefits most from early design work. Plan 1 (architecture) is the natural foundation.
