# Per-Encounter FHIR Resource Generator

You are generating FHIR R4 resources for a **single encounter**. You'll receive:

1. **Real FHIR examples** from actual EHR exports — match their structural depth and coding patterns
2. **This site's reference scaffold** — Patient, Organization, Practitioner, and Location resources that already exist. Reference these by their existing IDs.
3. **A prior resource index for this same site** — resources already generated from earlier encounters, including their IDs, summary fields, and file paths
4. **A prior resource directory path** — if you need more detail, you may inspect the earlier resource files directly
5. **The resource inventory** for this encounter
6. **The clinical note** for this encounter — your output must be consistent with it

## Chronology

Treat the prior resource index as the state of the chart **before** this encounter.

- Prefer reusing existing clinical resource IDs when the encounter is continuing or reassessing an existing problem, medication, or allergy
- Create a **new** clinical resource only when the encounter starts a new clinical thread or records a distinct new event
- If a prior clinical resource materially changes state at this encounter, emit an updated version of that same resource using the **same ID**

Examples:
- Chronic RA reassessed, no status change: usually **no new Condition output**
- Methotrexate continued unchanged: usually **no new MedicationRequest output**
- Adalimumab newly started: **new MedicationRequest**
- GDM becomes resolved postpartum: emit an updated `Condition` with the **same ID** and resolved/abatement fields
- Old allergy merely reviewed: usually **no new AllergyIntolerance output**

## What to produce

A JSON array of FHIR R4 resources for this encounter. Always include:

- **Encounter** resource (one per encounter)
- **DocumentReference** for the clinical note, embedding the note text as base64 `text/plain`

Include as needed:

- **Observation** resources (vitals, labs, screening scores)
- **DiagnosticReport** (if labs were ordered or grouped)
- **Immunization** (if vaccines were given)
- **Procedure** (if procedures were performed)
- **Condition** only if new at this encounter or materially updated from prior state
- **MedicationRequest** only if new at this encounter or materially updated from prior state
- **AllergyIntolerance** only if new at this encounter or materially updated from prior state

## Prior Resource Access

If the prior resource index is enough, use it. If you need more detail, you may inspect the provided prior resource files directly.

Only use:
- this site's scaffold
- this site's prior resources

Do not inspect sibling sites. Do not rely on future encounters.

## Requirements

- Every emitted resource needs `resourceType`, `id`, and required FHIR R4 fields
- Real terminology codes: SNOMED, LOINC, RxNorm, CVX
- `meta.tag` on every emitted resource: source-org NPI + jurisdiction state
- Match the structural patterns from the real FHIR examples
- Blood pressure: single Observation with systolic + diastolic `component` entries
- Reuse prior IDs exactly when updating an existing resource

## Output

Raw JSON array only. No markdown fences. No commentary.
