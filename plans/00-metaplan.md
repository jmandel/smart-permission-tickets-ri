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

- Component diagram: Data Holder proxy, HAPI FHIR instance(s), Trusted Issuer, Client App, Demo Dashboard
- Service topology: Docker Compose, ports, inter-service discovery
- Which use cases to demo (primary: UC1 patient access; secondary: UC4 social care, UC3 public health — covers patient-initiated vs B2B, cnf-bound vs unbound, match vs reference subject resolution)
- Two deployment modes: full (HAPI + Docker) and lightweight (in-memory, single process, no Docker)
- Tech stack: Bun + Hono for servers, React + Vite for dashboard, jose for JWT, Docker for HAPI
- How the existing `scripts/keys/` and `scripts/types.ts` get reused

### Plan 2: Data Holder Proxy
`02-data-holder-proxy.md`

- `.well-known/smart-configuration` endpoint (advertises token exchange + supported ticket types)
- `POST /token` — RFC 8693 token exchange handler:
  - Client assertion validation (signature, iss/sub, aud, exp)
  - Permission Ticket validation pipeline (signature via issuer JWKS, ticket_type, aud, exp, cnf.jkt binding)
  - Subject resolution (match by demographics, identifier lookup, reference resolution)
  - Scope intersection calculation (requested vs ticket vs client registration)
  - JWT access token issuance encoding constraints
- FHIR request proxying to HAPI:
  - Scope gating (reject unauthorized resource types)
  - Period pre-filtering (resource-type → date-search-parameter mapping, appended to HAPI queries)
  - Organization/jurisdiction pre-filtering via `meta.tag` (applied at data load time, queried via `_tag`)
  - Post-filter safety net (double-check results before returning)
- Access token design: stateless JWT carrying scope + constraints
- Error responses per spec (invalid_grant, invalid_scope, etc.)

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
- **Constraint-exercise tagging**: Resources tagged with `meta.tag` for source organization and jurisdiction, so the demo can show visible filtering differences.
- **Multi-site distribution**: Resources assigned to correct HAPI instances per the provider map.
- **Validation & loading**: FHIR schema validation, referential integrity checks, transaction Bundle loading into HAPI.

### Plan 4: Trusted Issuer + Consent Flow
`04-trusted-issuer.md`

- JWKS endpoint (`/.well-known/jwks.json`) serving issuer public keys
- Consent session API: client redirects patient to issuer, patient approves, issuer mints ticket, redirect back
- Ticket minting: builds PermissionTicket payload per use case, signs with issuer ES256 key
- ID proofing simulation: UI step that shows identity verification (name, DOB confirmation) without real identity verification. Placeholder for integration with real IdP (Clear, etc.)
- CRL endpoint for revocation demo (serves a static revocation list, demonstrates the checking flow)
- How the existing `ux/` consent screen connects (or whether we build a simplified version)

### Plan 5: Demo Dashboard / Client App
`05-demo-dashboard.md`

- Step-by-step guided walkthrough mode: scenario selection → ID proofing → consent → token exchange → FHIR queries → filtered results
- Split-view visualization: "what the app sees" on one side, "what the server is doing" (validation steps, filtering decisions) on the other
- JWT viewer at each step (decoded headers, payloads, signatures)
- API call inspector (shows actual HTTP requests and responses)
- Before/after comparison: "all patient data at this Data Holder" vs "data authorized by this ticket"
- Developer mode: copy curl commands, inspect tokens, modify scenarios
- Use case switcher: jump between UC1/UC3/UC4/UC6 to show different flow patterns

## Dependencies Between Plans

```
Plan 3 (Synthetic Data) ──→ Plan 2 (Data Holder Proxy) ──→ Plan 5 (Dashboard)
                                      ↑
Plan 4 (Trusted Issuer) ─────────────┘
                                      ↑
Plan 1 (Architecture) ───────────────┘ (informs all others)
```

- Plan 1 sets the foundation — tech choices, topology, deployment model
- Plan 3 (synthetic data) and Plan 4 (issuer) can proceed in parallel
- Plan 2 (proxy) depends on having data to serve and tickets to validate
- Plan 5 (dashboard) depends on all backend components being defined

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
| FHIR data storage | Real (HAPI FHIR server) |
| ID proofing | Simulated (UI placeholder, confirms identity without real verification) |
| Trust chain verification | Simplified (issuer URL allowlist, not full federation) |
| Revocation checking | Structural (CRL endpoint exists, checking works, but CRL is static) |
| Client registration | Simplified (keys pre-configured, not dynamic registration) |

## Next Steps

Write each plan in detail, starting with whichever the author wants to go deep on first. Plan 3 (synthetic data) is likely the most novel and benefits most from early design work. Plan 1 (architecture) is the natural foundation.
