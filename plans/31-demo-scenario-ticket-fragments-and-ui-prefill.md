# Plan 31: Demo Scenario Ticket Fragments and UI Prefill

Status: proposed

## Why This Plan Exists

The reference implementation now has a strong core ticket model and a capable demo UI, but the two are still loosely coupled for non-self-access use cases.

Today:

- the formal ticket schema already supports all seven use cases, including public health investigation via `ticket_type`, `requester`, and `context`
- the demo UI workbench still builds a patient-self ticket by default and derives its controls from an internal consent model rather than from a use-case-specific ticket fragment
- the synthetic patients already encode scenario narratives and use-case tags, but there is no structured, machine-readable scenario payload that the server can surface to the UI

For use cases like tuberculosis investigation, measles exposure, social care referral, payer claims, research, and consult, the missing piece is not new trust or OAuth protocol machinery. The missing piece is a reliable way to attach **spec-shaped ticket defaults** to each sample patient and flow those defaults into the web UI.

This plan introduces a new per-patient scenario artifact whose core payload directly matches the Permission Ticket specification shape. It then stitches that artifact into generated Patient resources via a project-local extension, surfaces it through `/demo/bootstrap`, and teaches the web UI to:

- render the per-use-case requester/context details
- prefill the existing knobs from the ticket fragment rather than from a parallel UI-only model
- merge runtime fields (`iss`, `aud`, `exp`, `jti`, `subject`, optional presenter binding) on top of the scenario fragment when minting demo tickets

The intent is to keep the demo aligned with the actual spec, not to invent a second parallel scenario DSL.

## Design Intent

### 1. Scenario source of truth is a spec-shaped ticket fragment

Each patient gets one new source file:

```text
synth-data/patients/<patient-slug>/ticket-scenarios.json
```

The file contains one or more scenario entries. Each entry has:

- a small amount of demo display metadata
- one `ticket` object whose inner structure directly matches the Permission Ticket specification for the fields that belong in a reusable scenario

The `ticket` object uses the real spec field names:

- `ticket_type`
- `requester`
- `context`
- `access`

It does **not** include runtime envelope fields or subject-specific runtime fields:

- omit `iss`
- omit `aud`
- omit `exp`
- omit `iat`
- omit `jti`
- omit `subject`
- omit `presenter_binding`
- omit `revocation`
- omit `must_understand`

Those are still provided at runtime by the issuer, the selected client/binding mode, and the selected patient.

This keeps the scenario payload maximally close to the real Permission Ticket schema while preserving the distinction between:

- reusable scenario defaults
- runtime minting details

### 2. Use real ticket shape for defaults; keep non-ticket demo metadata outside it

The scenario file should not invent alternate names for ticket content. The `ticket` object is the ticket-shaped part.

Anything not actually part of the signed ticket stays outside `ticket`, for example:

- `id`
- `label`
- `summary`
- `resource_hints`
- optional recommended client mode / binding hints

Example:

```json
{
  "scenarios": [
    {
      "id": "tb-investigation",
      "label": "TB investigation, Case 2024-999",
      "summary": "Public health follow-up request for tuberculosis-related data.",
      "ticket": {
        "ticket_type": "https://smarthealthit.org/permission-ticket-type/public-health-investigation-v1",
        "requester": {
          "resourceType": "Organization",
          "name": "Illinois Department of Public Health"
        },
        "context": {
          "reportable_condition": {
            "coding": [
              {
                "system": "http://snomed.info/sct",
                "code": "56717001",
                "display": "Tuberculosis"
              }
            ],
            "text": "Tuberculosis"
          }
        },
        "access": {
          "permissions": [
            { "kind": "data", "resource_type": "Patient", "interactions": ["read"] },
            { "kind": "data", "resource_type": "Condition", "interactions": ["read", "search"] },
            { "kind": "data", "resource_type": "Observation", "interactions": ["read", "search"] },
            { "kind": "data", "resource_type": "DiagnosticReport", "interactions": ["read", "search"] }
          ],
          "sensitive_data": "exclude"
        }
      },
      "resource_hints": [
        {
          "kind": "code",
          "resource_type": "Condition",
          "system": "http://snomed.info/sct",
          "code": "56717001",
          "label": "Tuberculosis diagnosis"
        }
      ]
    }
  ]
}
```

### 3. The UI should derive its knobs from `ticket.access`, not from a parallel scenario DSL

The current workbench state is modeled as `ConsentState` in `ui/src/types.ts`, and `buildTicketPayload()` currently hardcodes patient self-access in `ui/src/demo.ts`.

Plan 31 keeps the knobs, but makes them a projection of the real ticket fragment:

- resource scope controls derive from `ticket.access.permissions`
- location controls derive from `ticket.access.responder_filter`
- date controls derive from `ticket.access.data_period`
- sensitive-data control derives from `ticket.access.sensitive_data`

This is the important design rule:

- the scenario payload is the authoritative use-case default
- the workbench controls are an editable projection of that payload
- the final minted ticket is produced by taking the scenario `ticket` fragment and overlaying the current dial state back into the real `access` structure

That avoids the anti-pattern of maintaining:

- one scenario schema
- one internal UI schema
- one final ticket schema

for the same semantic content.

### 4. Store once per patient; fan out to every site-local Patient alias during enrichment

Each synthetic person appears as multiple site-local `Patient` resources. Hand-editing each generated Patient would be brittle.

The correct source-of-truth pattern is:

1. author `ticket-scenarios.json` once at the patient root
2. load it during synth-data enrichment
3. inject the same serialized scenario payload into every generated site-local `Patient` resource via a project-local extension

This matches the existing patient-summary extension pattern already used by:

- `synth-data/steps/enrichment.ts`
- `fhir-server/src/store/store.ts`

The new extension should therefore be:

- patient-level
- generated automatically
- identical across all aliases for a given person

That keeps `/demo/bootstrap` deterministic regardless of which site-local Patient record the store sees first.

### 5. Use a private Patient extension as a transport layer, with JSON serialized as a string

FHIR R4 does not offer a native arbitrary JSON value type on `Extension`. For this internal demo transport use case, the simplest approach is:

- define a new project-local Patient extension URL
- store the scenario bundle as canonical JSON serialized into `valueString`

For example:

```text
https://smarthealthit.org/fhir/StructureDefinition/smart-permission-tickets-demo-scenarios
```

This extension is not intended as an interoperability artifact. It is a transport mechanism from the synthetic-data pipeline into the runtime demo bootstrap.

The server should:

- parse it leniently
- validate it against a shared schema
- ignore it safely if malformed
- preserve old behavior for patients that do not yet carry the extension

### 6. Draft all sample-patient scenarios in the source synthetic-data folders

This plan is not only about plumbing. It includes authoring a first-pass scenario file for every sample patient.

Target shape:

- one `ticket-scenarios.json` file per patient
- at least one scenario entry per patient
- room for multiple scenario entries later if a patient supports more than one demo angle

Initial authoring pass:

- `elena-reyes`: UC1 patient self-access
- `denise-walker`: UC1 patient self-access
- `sarah-mitchell`: UC1 patient self-access with labeled sensitive-data defaults
- `harold-washington`: UC2 delegated access
- `aisha-patel`: UC2 delegated access
- `robert-davis`: UC3 public health, tuberculosis
- `marcus-johnson`: UC3 public health, measles
- `maria-chen`: UC4 social care referral
- `james-thornton`: UC5 payer claims
- `carlos-medina`: UC5 payer claims
- `patricia-okafor`: UC6 research
- `kevin-park`: UC7 provider consult
- `lisa-nakamura`: UC7 provider consult

This authoring pass should be manual and explicit. It is better to have 13 deliberate scenario files than to auto-infer ticket fragments unreliably from raw FHIR.

### 7. Supporting case details can be demo metadata, not base-ticket expansion

For public health and other B2B stories, the demo may want to show:

- local case IDs
- referral labels
- claim numbers
- consult labels
- supporting-resource highlights

Those should live in the demo scenario metadata unless and until the formal spec says they belong in `context`.

That preserves the current spec discipline:

- base ticket carries only must-understand workflow fields
- demo metadata can still render richer case context in the UI

Plan 31 does **not** expand the formal UC3 schema beyond `reportable_condition`.

## Settled Decisions

- **Scenario payloads will be spec-shaped.** The core `ticket` object in each scenario uses Permission Ticket field names and nesting directly.
- **Scenario files live once per patient root.** They are not hand-maintained separately per site-local Patient alias.
- **The pipeline fans them out via Patient extension injection.** This reuses the same pattern already used for patient summary text.
- **The extension is a project-local transport layer.** It carries canonical JSON serialized into `valueString`.
- **The UI derives its dial defaults from `ticket.access`.** No second semantic access DSL is introduced.
- **Runtime fields remain runtime.** `iss`, `aud`, `exp`, `jti`, `subject`, and presenter binding are still assembled when the demo mints a ticket.
- **Supporting case details stay outside the signed `ticket` fragment unless already defined by the formal spec.**
- **Draft all sample patients, not just TB.** TB is the forcing function, but the pattern should cover all seven use cases.

## Phases

### Phase 1: Shared scenario schema and patient-root source files

Work:

- Add a new shared schema module, for example:
  - `reference-implementation/shared/demo-ticket-scenarios.ts`
- Define a `DemoTicketScenario` schema with:
  - `id`
  - `label`
  - optional `summary`
  - `ticket`
  - optional `resource_hints`
  - optional non-ticket UI recommendation metadata
- Define `ticket` by deriving from the shared Permission Ticket schema, not by rewriting it by hand:
  - keep `ticket_type`, `requester`, `context`, `access`
  - omit runtime envelope and subject fields
  - preserve ticket-type-specific validation
- Add `ticket-scenarios.json` to each patient folder under `synth-data/patients/<slug>/`
- Add a lightweight authoring guideline describing:
  - which fields belong in `ticket`
  - which fields belong outside it
  - how much detail is appropriate in `resource_hints`

Goal: one validated, spec-shaped scenario source file exists per patient.

### Phase 2: Stitch scenario files into generated content through enrichment

Work:

- Extend `synth-data/steps/enrichment.ts`:
  - load `ticket-scenarios.json` from the patient root
  - validate it with the shared schema
  - serialize it to canonical JSON
  - inject it into every generated site-local `Patient` via a new extension URL
- Preserve the current patient-summary and encounter-summary injection behavior
- Decide whether enrichment should:
  - fail hard on invalid scenario files
  - or warn and continue without scenario injection

Recommendation:

- fail hard in synth-data generation so scenario mistakes are caught early
- fail soft in the server runtime if an already-generated bundle contains malformed extension content

Goal: the generated content carries scenario metadata uniformly across all Patient aliases.

### Phase 3: Parse scenario extensions into runtime bootstrap

Work:

- Extend `fhir-server/src/store/store.ts`:
  - add a new extension constant
  - add a helper to parse JSON-valued Patient extensions
  - validate with the shared schema
  - surface scenarios in `DemoPersonSummary`
- Extend `ui/src/types.ts`:
  - add `ticketScenarios` (or equivalently named field) to `PersonInfo`
- Update `/demo/bootstrap` types and smoke coverage so the new field is visible to the UI

Goal: every demo person can carry zero or more structured scenario definitions into the web app.

### Phase 4: Teach the web UI to render scenario details and prefill from ticket fragments

Work:

- Extend the workbench state so a selected person may also select a scenario
- Use the selected scenario's `ticket` fragment to initialize:
  - requester details
  - context details
  - access-related dials
- Refactor `buildTicketPayload()` in `ui/src/demo.ts` so it no longer hardcodes patient self-access:
  - start from the selected scenario `ticket` fragment
  - merge in runtime `subject`
  - merge in runtime `iss`, `aud`, `exp`, `jti`
  - merge in optional `presenter_binding`
  - overlay the current dial state back onto `access`
- Add a scenario-details panel in the workbench to show:
  - use-case label
  - requester summary
  - context summary
  - optional case metadata like local case ID

Goal: selecting a patient/use-case scenario visibly changes the rendered ticket details and pre-populates the existing controls from the spec-shaped scenario fragment.

### Phase 5: Render supporting case context in the demo UI

Work:

- Use `resource_hints` or equivalent semantic selectors to highlight relevant resources in the viewer/workbench
- Keep these hints demo-only; they are not part of the signed ticket
- Ensure hint matching is semantic rather than site-local-ID-dependent where possible

Good first-pass resource hint types:

- coded resource selector:
  - `resource_type`
  - `system`
  - `code`
  - optional `label`
- direct local reference selector only if needed later

Goal: TB and other scenario cards can show meaningful supporting artifacts without putting those artifacts into the core ticket schema.

### Phase 6: Author the initial scenario set for all sample patients

Work:

- Draft scenario files for all 13 synthetic patients
- Ensure each file has:
  - one clean primary scenario
  - realistic requester/context details
  - access defaults consistent with the published scenario
- For UC3 patients in particular:
  - Robert Davis: tuberculosis
  - Marcus Johnson: measles
- Confirm that the underlying generated FHIR data actually contains resources that make the scenario legible in the viewer
- If supporting resources are not reliable enough, inject or adjust source synthetic data accordingly

Goal: every sample patient ships with at least one reviewable, runnable scenario.

### Phase 7: Tests and documentation

Work:

- Shared-schema tests:
  - valid scenario files pass
  - malformed files fail clearly
- Enrichment tests:
  - scenario files are injected onto every site-local Patient alias
- Store/bootstrap tests:
  - parsed scenarios appear in `listDemoPersons()`
  - malformed extension content fails soft in runtime
- UI/demo tests:
  - selecting a UC3 TB scenario renders the public-health requester/context
  - dial defaults are derived from `ticket.access`
  - final minted ticket contains the scenario's `ticket_type`, `requester`, and `context`
  - UC1 behavior still works when no explicit scenario is selected
- Docs:
  - update `reference-implementation/README.md`
  - document the patient-root scenario file pattern for synthetic-data contributors

Goal: the scenario pipeline is deterministic, reviewable, and documented.

## Acceptance Criteria

- Every synthetic patient folder contains a `ticket-scenarios.json` file with at least one validated scenario entry.
- The scenario `ticket` payload uses real Permission Ticket field names and structure for `ticket_type`, `requester`, `context`, and `access`.
- Generated site-local `Patient` resources all receive the same scenario extension payload for a given patient.
- `/demo/bootstrap` exposes parsed ticket scenarios for each person through `PersonInfo`.
- The web UI can render scenario-specific requester/context details for all use cases.
- The workbench dials are derived from scenario `ticket.access` defaults rather than from a separate scenario DSL.
- `buildTicketPayload()` can mint non-self tickets by merging a scenario ticket fragment with runtime subject and envelope fields.
- TB and measles public-health scenarios render cleanly in the UI and mint valid UC3 tickets.
- Supporting case details can be shown in the UI without expanding the formal UC3 base-ticket schema.
- Existing self-access behavior continues to work for patients whose selected scenario is UC1 or when no scenario is selected.

## Non-Goals

- Expanding the formal Permission Ticket specification's UC3 schema beyond `reportable_condition`
- Making the Patient extension itself an interoperability standard
- Inferring scenario ticket fragments purely from raw FHIR resources at runtime
- Eliminating the current workbench knobs; this plan repopulates them from spec-shaped defaults rather than removing them
- Generalized ticket-authoring workflows for external users; this is a demo/bootstrap authoring pattern for curated synthetic patients

## Estimated Scope

Medium to large:

- one new shared scenario-schema module
- one new patient-root scenario JSON file per synthetic patient
- enrichment changes to inject a new Patient extension
- store/bootstrap changes to parse and expose scenarios
- UI type changes plus workbench refactor so scenario fragments drive defaults
- tests across shared schema, synth-data enrichment, store/bootstrap, and UI demo behavior

The highest-risk part is not schema definition. It is the inverse mapping between:

- spec-shaped `ticket.access`
- editable UI knob state
- final rebuilt ticket payload

That mapping must stay lossless enough that the UI does not drift away from the actual ticket semantics.
