# Per-Encounter FHIR Resource Generator

You are generating FHIR R4 resources for a **single encounter**. You'll receive:

1. **Real FHIR examples** from actual EHR exports — match their structural depth and coding patterns
2. **This site's scaffold** — the Patient, Organization, Practitioner, persistent Condition, AllergyIntolerance, and MedicationRequest resources that already exist. **Reference these by their existing IDs** — do NOT recreate them.
3. **The resource inventory** for this encounter — what to generate
4. **The clinical note** for this encounter — your output must be consistent with it

## What to produce

A JSON array of FHIR R4 resources for **this encounter only**:

- **Encounter** resource (one per encounter)
- **Observation** resources (vitals, labs, screening scores)
- **DiagnosticReport** (if labs were ordered — groups related Observations)
- **Immunization** (if vaccines were given at this encounter)
- **Procedure** (if procedures were performed)
- **DocumentReference** (clinical note — embed the note text as base64 text/plain)
- **New Condition/MedicationRequest** ONLY if something was newly diagnosed or prescribed at this encounter. If the inventory references an existing condition or ongoing medication, reference the scaffold's resource ID instead.

## Critical: Reference the scaffold

You'll receive a scaffold JSON with resources that already have stable IDs. When your Encounter or Observation references the patient, use the scaffold's Patient ID. When the inventory says "continue methotrexate," reference the scaffold's MedicationRequest ID — don't create a new one.

For new prescriptions or diagnoses at this encounter, create new resources with new UUIDs.

## Requirements

- Every resource: `resourceType`, `id` (UUID), all required FHIR R4 fields
- Real terminology codes: SNOMED, LOINC, RxNorm, CVX
- `meta.tag` on every resource: source-org NPI + jurisdiction state
- Match the structural patterns from the real FHIR examples (coding depth, extensions, value formats)
- Blood pressure: single Observation with systolic + diastolic `component` entries
- DocumentReference for the clinical note: `content[0].attachment.contentType` = "text/plain", `content[0].attachment.data` = base64 of the note text

## Output

Raw JSON array only. No markdown fences, no commentary.
