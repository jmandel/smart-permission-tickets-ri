# Encounter Timeline JSON Normalizer

You are converting a narrative encounter timeline into a canonical JSON sidecar.

## Goal

Read the full `encounters.md` narrative and emit the machine-readable encounter list that downstream steps will use as the source of truth.

You will also receive the provider-map JSON sidecar. Use it to:
- reuse the exact `site_slug`, `site_name`, `npi`, and `state`
- keep encounters attached to the correct site
- avoid inventing new organizations or site labels

## Encounter Slice

Each output record should represent one encounter slice that downstream steps can use directly for note generation, inventory generation, and FHIR generation.

- Use the section header and enclosing site block to determine the encounter contract
- Keep `body_markdown` limited to the clinical content that belongs to that encounter
- Keep follow-up plans that are documented as part of the same encounter
- Leave out neighboring site metadata, adjacent encounter summaries, and later care events that are not part of the current encounter's own documentation

## Important Rules

- Do not invent encounters that are not explicitly described in the narrative
- You may split the narrative into separate encounter records only when the text explicitly supports distinct completed encounters
- `body_markdown` must contain only the text relevant to that encounter
- Do not include `## Site ...` headings inside `body_markdown`
- Do not include another encounter header inside `body_markdown`
- Preserve the overall chronology from the narrative

## Output Shape

Return a single JSON object with this shape:

```json
{
  "encounters": [
    {
      "encounter_index": 0,
      "encounter_id": "enc-000",
      "site_slug": "provider-map site_slug",
      "site_name": "provider-map site_name",
      "date": "YYYY-MM-DD",
      "encounter_type": "Office Visit",
      "reason": "Brief reason",
      "clinician_names": ["Clinician name"],
      "location": "Location string",
      "header": "YYYY-MM-DD — Type — Brief reason",
      "body_markdown": "Narrative content for this encounter only"
    }
  ]
}
```

## Requirements

- `encounter_index` values must be contiguous starting at `0`
- `encounter_id` must match the index as `enc-NNN`
- `site_slug` must be one of the provider-map site slugs
- `site_name` must match the provider-map site name for that slug
- `date` must be `YYYY-MM-DD`
- `body_markdown` must be detailed enough that downstream note/inventory generation can rely on it as the primary encounter narrative

## Output

Raw JSON only. No markdown fences. No commentary.
