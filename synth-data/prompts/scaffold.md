# Site Scaffold Generator

You are generating the "persistent" FHIR resources for one provider site in a synthetic patient record. These are the resources that exist once per site and get referenced by all encounter-specific resources.

## What to produce

A JSON array of FHIR R4 resources that form the stable scaffold for this site:

1. **Patient** — One per site. Same person, but each site has its own Patient resource with its own ID. Include demographics, name, DOB, gender, address, contact, marital status, race/ethnicity extensions per US Core.

2. **Organization** — The provider organization. Name, NPI identifier, type, address, telecom.

3. **Practitioner** — Each clinician mentioned in the biography/encounters for this site. Name, NPI if applicable, qualification.

4. **AllergyIntolerance** — Known allergies, created once and referenced by subsequent encounters.

5. **Condition (persistent)** — Active or historical conditions that span multiple encounters. E.g., "seropositive rheumatoid arthritis" is a single Condition resource referenced at every rheumatology visit, not a new one per encounter. Include clinical status, verification status, onset date, SNOMED code.

6. **MedicationRequest (ongoing)** — Active long-term medications. These get referenced/updated across encounters but the initial prescription is a single resource. Include RxNorm code, dosage, status.

Each resource needs:
- A stable UUID `id`
- Proper `meta.tag` for source-org (NPI) and jurisdiction (state)
- Consistent internal references (Conditions reference the Patient, MedicationRequests reference the Patient and a requester Practitioner)

## Context you'll receive

- The patient biography (full clinical arc and provider map)
- The encounter timeline for this site (so you know which conditions/meds are relevant here)
- Real FHIR examples from actual EHR exports (showing the structural depth and coding patterns you should match)

## Output

A JSON array of FHIR R4 resources. No markdown fences — raw JSON only.

These resources will be saved and then passed as context to per-encounter generation, so downstream agents can reference them by ID.
