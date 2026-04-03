# Provider Map JSON Normalizer

You are converting a narrative patient biography into a canonical JSON sidecar.

## Goal

Extract a machine-readable JSON from the biography's `## Provider Map` section. This section lists the clinical care providers where the patient has visits — extract exactly those, nothing else.

## Rules

- Extract only organizations listed under the `## Provider Map` heading
- Do not invent new facts or add organizations not in that section
- Preserve exact organization names and clinician names
- Every site must have an `npi` (10-digit string) and `state` (2-letter code)

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
