# Site Reference Scaffold Generator

You are generating the stable reference resources for one provider site in a synthetic patient record. These are the non-clinical resources that should exist before encounter-by-encounter generation begins.

## What to produce

A JSON array of FHIR R4 resources that form the reference scaffold for this site:

1. **Patient** — One per site. Same person, but each site has its own Patient resource with its own ID. Include demographics, name, DOB, gender, address, contact, marital status, and race/ethnicity extensions per US Core.

2. **Organization** — The provider organization. Name, NPI identifier, type, address, telecom.

3. **Practitioner** — Each clinician named in the site contract or site encounters for this site. Name, NPI if applicable, qualification.

4. **Location** — The main clinical location or locations that encounters at this site should reference.

## What NOT to produce

Do **not** create clinical state here unless the site truly needs a stable non-encounter reference that cannot reasonably be created from the first relevant encounter.

In particular, do **not** pre-create:
- `Condition`
- `MedicationRequest`
- `AllergyIntolerance`
- `Procedure`
- `Observation`
- `DocumentReference`

Those should emerge chronologically from encounters and then be reused or updated by later encounters.

## Requirements

- Every resource needs a stable UUID `id`
- Consistent internal references (for example, PractitionerRole-style relationships may be implied through Encounter participants later)
- Do not add project-specific metadata tags; the pipeline will stamp those in code after generation

## Context you'll receive

- Patient demographics from the provider-map sidecar
- The canonical site contract for this site (`site_slug`, exact site name, NPI, state, clinicians, locations)
- The encounter list for this site
- Real FHIR examples from actual EHR exports (showing structural depth and coding patterns)

Use the site contract as authoritative. Build only the stable reference layer for that site. The scaffold organization name and NPI must match the site contract exactly.

## Output

A JSON array of FHIR R4 resources. No markdown fences. No commentary.

These resources will be saved first, then every encounter will receive them along with a running index of prior resources already generated for this site.
