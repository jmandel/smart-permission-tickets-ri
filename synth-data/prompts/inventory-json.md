# Encounter Inventory JSON Normalizer

You are converting a markdown encounter inventory into a canonical JSON sidecar for a single encounter.

## Goal

Read the encounter contract and the full inventory markdown, then emit a structured JSON representation of the inventory. This is a normalization step, not a creative step.

## Rules

- Do not invent new facts
- Do not add new resources that are not described in the inventory markdown
- Keep this limited to a single encounter
- Do not create patient, organization, practitioner, or location resources here
- Use the encounter contract as the authoritative slice for this JSON sidecar
- Normalize only the resources, updates, and references that belong to this encounter
- Preserve supporting text mentions as text values inside the relevant item when needed, without expanding the scope of the encounter

## Output Shape

Return a single JSON object with this shape:

```json
{
  "encounter_id": "enc-000",
  "encounter_index": 0,
  "site_slug": "site-slug",
  "encounter": {
    "class": "ambulatory",
    "type": "Office Visit",
    "reason": "Brief reason",
    "period_start": "2022-11-08T09:00:00-08:00",
    "period_end": "2022-11-08T09:45:00-08:00",
    "participants": [],
    "service_provider": "Exact site name",
    "location": "Location string"
  },
  "observations": {
    "vitals": [],
    "labs": [],
    "screening": []
  },
  "conditions": [],
  "medications": [],
  "procedures": [],
  "immunizations": [],
  "document_references": [],
  "diagnostic_reports": [],
  "allergies": [],
  "service_requests": []
}
```

## Item Conventions

- Preserve action semantics like `create`, `update-existing`, and `reference-existing`
- Use plain clinical names and descriptions — do NOT include terminology codes (LOINC, SNOMED, RxNorm, CVX). Codes are resolved in a later step against a terminology database.
- For observations: include `name` (individual test or vital name like "hemoglobin A1c", "blood pressure", "white blood cell count"). Do NOT use panel names ("CBC", "CMP") as observation names — those are DiagnosticReports
- For conditions: include `name` (plain clinical name like "seropositive rheumatoid arthritis"), `clinical_status`, `onset_date`, `action`
- For medications: include `name` (drug + dose like "methotrexate 15 mg oral tablet"), `sig`, `status`, `reason`, `action`
- For immunizations: include `name` (vaccine name like "influenza vaccine, inactivated"), `date`, `route`
- For allergies: include `substance` (plain name like "amoxicillin"), `reaction`, `severity`, `action`
- For service requests: include `description` (what was referred for), `reason`, `status`, `recipient` (if known), `action`
- For diagnostic reports: include `type`, `report_state`, and:
  - `observation_names` when `report_state` is `report-with-results` — these MUST be exact names that appear in the observations.vitals, observations.labs, or observations.screening arrays
  - `description` when `report_state` is `summary-only` or `ordered-not-resulted`
  - **Imaging reports** (X-ray, CT, MRI, ultrasound) should use `summary-only` with a `description` of findings — imaging impressions are NOT observations and should NOT be listed as `observation_names`
  - Only lab panels where individual result observations exist in this encounter should use `report-with-results`. The observation_names must be credible for the panel — a CBC needs at minimum WBC, hemoglobin, hematocrit, platelets; not just one component
- If a field is absent, omit it instead of guessing
- Use arrays even when there is only one item

## Output

Raw JSON only. No markdown fences. No commentary.
