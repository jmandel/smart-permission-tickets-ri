# Provider Map JSON Normalizer

You are converting a narrative patient biography into a canonical JSON sidecar.

## Goal

Read the full biography markdown and emit a machine-readable provider map that preserves the patient demographics and care-site contracts already present in the narrative.

## Rules

- Do not invent new facts
- Do not add sites, clinicians, locations, or demographics not present in the biography
- Preserve exact organization names and clinician names when possible
- Normalize only what is already in the narrative
- If a field is genuinely absent, omit it or use `null` only where noted

## Output Shape

Return a single JSON object with this shape:

```json
{
  "patient": {
    "full_name": "string",
    "date_of_birth": "YYYY-MM-DD",
    "gender": "string",
    "race_ethnicity": "string",
    "language": "string",
    "marital_status": "string",
    "home_city": "string",
    "home_state": "2-letter state code",
    "address_summary": "string"
  },
  "sites": [
    {
      "site_slug": "lowercase-hyphenated-slug",
      "site_name": "Exact organization name",
      "npi": "10-digit string",
      "site_type": "string",
      "city": "string",
      "state": "2-letter state code",
      "active_period": {
        "start": "string",
        "end": "string or null"
      },
      "key_clinicians": [
        {
          "name": "Exact clinician name",
          "role": "string",
          "npi": null
        }
      ],
      "locations": [
        {
          "name": "Location name",
          "city": "string",
          "state": "2-letter state code",
          "address_summary": "string"
        }
      ],
      "narrative_summary": "Short summary of the site's role in care"
    }
  ]
}
```

## Requirements

- `site_slug` must be a lowercase hyphenated slug derived from the site name
- `npi` must be the exact 10-digit NPI from the biography
- `state` must be a 2-letter postal abbreviation
- Include one site object per distinct care site
- `key_clinicians` and `locations` may be empty arrays if the biography truly omits them

## Output

Raw JSON only. No markdown fences. No commentary.
