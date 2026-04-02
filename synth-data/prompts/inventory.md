# Encounter Resource Inventory Generator

You are generating a detailed resource inventory for a single encounter. You'll receive the encounter contract and encounter narrative, plus broader patient background. Your job is to describe what this encounter needs to create, update, or merely reference from prior chart state.

This is for one encounter only. Do not describe a second completed encounter in the same inventory.

Use the encounter contract as the authoritative slice. Use broader background only to understand prior context, not to widen the inventory beyond this encounter.

## What to produce

A markdown document listing the FHIR resources relevant to this encounter. For each item, describe the **clinical concept** clearly enough that a downstream coding step can find the right terminology code. Do NOT include terminology codes (LOINC, SNOMED, RxNorm, CVX) — those will be resolved later against a terminology database. Focus on clinical meaning, not coding.

Organize by resource type:

### Encounter
- Class (ambulatory, emergency, etc.)
- Type and reason
- Period (start/end datetime)
- Participants (practitioner references)
- Service provider (organization)
- Location

Do not create new patient, organization, practitioner, or location resources here. Those identities already come from the site's reference scaffold.

### Observations — Vitals
For each vital sign, specify:
- What it is (e.g., "blood pressure", "heart rate", "body weight", "BMI", "oxygen saturation", "respiratory rate", "body temperature")
- Value and unit
- For BP: systolic and diastolic component values

### Observations — Labs
For each **individual** lab result:
- Test name (e.g., "hemoglobin A1c", "TSH", "rheumatoid factor", "BUN", "hemoglobin", "white blood cell count", "platelet count")
- Value, unit, reference range
- Flag (normal, high, low, critical)
- Specimen type if relevant

**Important**: Only list individual test results here — NOT panel/report names. "CBC", "CMP", and "lipid panel" are DiagnosticReports, not Observations. The individual components (hemoglobin, WBC, platelets, glucose, BUN, creatinine, LDL, etc.) are the Observations. If the encounter narrative says "CBC was normal" without listing individual values, do NOT create observations for it — list it as a `summary-only` DiagnosticReport instead.

### Observations — Screening
- Tool name (e.g., "PHQ-2 depression screening", "AUDIT-C alcohol screening")
- Score and interpretation

### Conditions
- Condition name in plain clinical language (e.g., "type 2 diabetes mellitus", "seropositive rheumatoid arthritis", "missed abortion")
- Clinical status (active, resolved, etc.)
- Onset date
- Action: `create`, `update-existing`, or `reference-existing`
- Whether this is a new diagnosis at this encounter or a known condition being reassessed
- If updating existing state, describe what changed at this encounter

### MedicationRequests
- Drug name and dose in plain language (e.g., "methotrexate 15 mg oral tablet, once weekly", "adalimumab 40 mg subcutaneous injection, every 2 weeks")
- Sig (dosage instructions as text)
- Status (active, stopped, etc.)
- Reason (which condition)
- Action: `create`, `update-existing`, or `reference-existing`
- If updating existing state, describe what changed (dose, stop, restart, etc.)

### Immunizations
- Vaccine name in plain language (e.g., "influenza vaccine, inactivated", "Tdap", "pneumococcal conjugate PCV15")
- Date, site, route

### DocumentReferences
- Document type (progress note, ED note, patient instructions, discharge summary)
- A brief description of what the note should contain (2-3 sentences summarizing the clinical narrative)

### DiagnosticReports (if labs or imaging were ordered)
- Report type in plain language (e.g., "comprehensive metabolic panel", "complete blood count", "lipid panel", "right ankle X-ray")
- Report state:
  - `report-with-results` if this encounter contains named individual lab observations (in the Observations section above) that back this report. A `report-with-results` must be backed by a credible number of components — e.g., a CBC needs at minimum WBC, hemoglobin, hematocrit, and platelets; a CMP needs glucose, BUN, creatinine, electrolytes, etc. If you only have 1-2 values from a multi-component panel, use `summary-only` instead.
  - `summary-only` if the narrative says the panel was normal/reviewed but does not give individual component values, OR if it's an imaging report (X-ray, CT, MRI, ultrasound) with an impression/finding
  - `ordered-not-resulted` if the test was ordered but no results are available yet
- If `report-with-results`, list the exact observation names that back this report — these MUST match names that appear in the Observations — Labs section above
- If `summary-only` or `ordered-not-resulted`, include a short description explaining findings or what is/isn't available

**Key rule**: DiagnosticReports and Observations are different things. A panel name ("CBC", "CMP") is a DiagnosticReport. Individual test results ("hemoglobin", "glucose", "BUN") are Observations. Do not list panel names as Observations.

### AllergyIntolerance (only if new allergies discovered at this encounter)
- Substance in plain language (e.g., "amoxicillin", "penicillin class", "shellfish")
- Reaction type and severity
- Action: `create`, `update-existing`, or `reference-existing`

### ServiceRequest (if referrals were made at this encounter)
- What was referred for (e.g., "referral to community food assistance program", "rheumatology consultation")
- Reason / indication
- Status (active, completed)
- Recipient organization or service if known
- Action: `create`, `update-existing`, or `reference-existing`

## Important: No terminology codes at this stage

Do NOT include LOINC, SNOMED, RxNorm, CVX, or other terminology codes. Use clear, specific clinical language instead. A downstream step will resolve concepts to codes using a terminology database. Your job is to describe the clinical meaning precisely enough that the right code can be found later.

Good: "hemoglobin A1c, value 7.8%, unit %, reference range 4.0-5.6%, flag high"
Bad: "LOINC 4548-4, value 7.8%"

Good: "seropositive rheumatoid arthritis, both hands and wrists"
Bad: "SNOMED 69896004"

Good: "methotrexate 15 mg oral tablet, once weekly on Fridays"
Bad: "RxNorm 105586"

## Calibration

- Office visit: ~8 vital sign observations + 1-2 screening + 0-10 lab observations + 1 progress note
- Telephone: 0-1 observations + maybe a telephone encounter note
- Lab visit: 5-15 lab observations + 1 diagnostic report + 0 vitals
- ED visit: 8 vitals + 10-20 labs + possibly procedures + ED note + discharge instructions

## Style

Be exhaustive about clinical relevance, but do not force every reassessed chronic problem or continued long-term medication to become a new resource. The goal is a complete manifest of:
- what this encounter creates
- what this encounter updates
- what this encounter simply depends on from prior state

Keep descriptions concise.

If broader context appears in the narrative, keep the inventory centered on the current encounter's resources and updates to prior chart state.
