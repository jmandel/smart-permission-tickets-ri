# Per-Encounter FHIR Resource Generator

You are generating FHIR R4 resources for a **single encounter**. You'll receive:

1. **Real FHIR examples** from actual EHR exports — match their structural depth and coding patterns
2. **This site's canonical contract** — the exact site slug, site name, NPI, state, clinicians, and locations for this encounter
3. **This site's reference scaffold** — Patient, Organization, Practitioner, and Location resources that already exist. Reference these by their existing IDs.
4. **A prior resource index for this same site** — resources already generated from earlier encounters, including their IDs, summary fields, and file paths
5. **A prior resource directory path** — if you need more detail, you may inspect the earlier resource files directly
6. **The structured inventory JSON** for this encounter
7. **The clinical note** for this encounter — your output must be consistent with it

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

FHIR R4 resources for this encounter, one per file. Always include:

- **Encounter** resource (one per encounter)
- **DocumentReference** for the clinical note, embedding the note text as base64 `text/plain`. To base64-encode: write the note to a file in your working directory (e.g., `note.txt`), then run `base64 -w 0 < note.txt`.

Include as needed:

- **Observation** resources (vitals, labs, screening scores)
- **DiagnosticReport** (if labs were ordered or grouped)
- **Immunization** (if vaccines were given)
- **Procedure** (if procedures were performed)
- **ServiceRequest** (if referrals were made — e.g., specialist referral, social services referral)
- **Condition** only if new at this encounter or materially updated from prior state
- **MedicationRequest** only if new at this encounter or materially updated from prior state
- **AllergyIntolerance** only if new at this encounter or materially updated from prior state

Do **not** emit:
- `Patient`
- `Organization`
- `Practitioner`
- `Location`

Those identities must come from the scaffold only.

## Working Context

Treat the provided site contract, encounter contract, scaffold, prior-resource index, structured inventory JSON, and note as the full working context for this step.

- Use the encounter contract as the authoritative slice for what this step should emit
- Use the scaffold and prior-resource index as the chart state available to this encounter
- **When updating or continuing a prior resource** (reusing the same ID), read the full prior resource JSON file to match its coding, structure, and field patterns exactly — then apply only the changes warranted by this encounter. Also read prior resources when creating new resources that reference them (e.g., a MedicationRequest whose reason references a prior Condition)
- Keep the output centered on this encounter's resources and updates to prior chart state

## Workflow

Follow these steps in order.

### Step 1: Plan

Review the encounter contract, inventory JSON, clinical note, scaffold, and prior resources. Decide which resources to emit (new, updated, or skip). Plan their IDs:

- New resources: deterministic human-readable IDs like `enc-003-a1c`, `enc-003-bp`, `enc-003-note`
- Updated prior resources: reuse the exact same ID from the prior resource index

### Step 2: Look up terminology codes

Batch your terminology lookups. Query the terminology DB for all the codes you'll need — conditions, observations, medications, vaccines, encounter type — before you start writing files. This is more efficient than interleaving lookups with file writes.

### Step 3: Write and validate each resource

Create the output directory, then write each resource as a **separate JSON file**:

```bash
mkdir -p resources
```

For each resource:

1. **Write** the resource to `resources/<id>.json` as a single FHIR resource JSON object (not an array, not wrapped in markdown). Use your file-writing tools.
2. **Validate** the resource against the FHIR validator:
   ```bash
   curl -s -X POST http://localhost:<port>/validateResource \
     -H "Content-Type: application/fhir+json" -d @resources/<id>.json
   ```
3. **Fix** any validation errors — edit the file and re-validate until clean, then move to the next resource.

### Step 4: Verify

After all resources are written, list the files in `resources/` to confirm everything is present.

## Resource file conventions

- One FHIR resource per file, as a JSON **object** (not an array)
- File name: `<id>.json` where `<id>` matches the resource's `id` field
- Example: a resource with `"id": "enc-003-bp"` goes in `resources/enc-003-bp.json`
- Do **not** write a combined output file or assemble resources into an array — the pipeline reads individual files

## Terminology Coding — This Is Where Codes Get Resolved

The inventory you receive contains **plain clinical concept names** (e.g., "hemoglobin A1c", "seropositive rheumatoid arthritis", "metformin 500 mg oral tablet") with **no terminology codes**. Your job is to resolve these to real codes as you generate FHIR resources. This is the first step in the pipeline where coded values appear.

The primary systems are:
- **SNOMED CT** (`http://snomed.info/sct`) — conditions, procedures, findings
- **LOINC** (`http://loinc.org`) — observations, lab tests, vital signs, document types
- **RxNorm** (`http://www.nlm.nih.gov/research/umls/rxnorm`) — medications
- **CVX** (`http://hl7.org/fhir/sid/cvx`) — vaccines

The user message will include an **Available Tools** section with absolute paths to the terminology database and the FHIR validator URL. Use those exact paths — they are correct for your execution environment.

Always include a human-readable `text` or `display` alongside every code. If you can't find a code you're confident about, use `text` only — downstream validation (step 06) will flag resources with missing or invalid codes.

**Two tools, two purposes:**
1. **Terminology DB** (`sqlite3 <path>`) — for resolving clinical concepts to codes. Use this when you need to find the right code for a concept from the inventory.
2. **FHIR Validator** (`curl` to the validator URL) — for checking structural validity of generated resources. Use this to catch missing required fields, wrong cardinality, etc.

**Coding guidance by resource type:**
- For `Observation.code` and `DiagnosticReport.code`, prefer targeted `http://loinc.org` lookups.
- For `Condition.code` and most `Procedure.code` values, prefer targeted `http://snomed.info/sct` lookups.
- For `MedicationRequest.medicationCodeableConcept`, prefer targeted `http://www.nlm.nih.gov/research/umls/rxnorm` lookups.
- For `Immunization.vaccineCode`, prefer targeted `http://hl7.org/fhir/sid/cvx` lookups.
- For `AllergyIntolerance.code`, prefer a targeted substance/product lookup rather than an unconstrained cross-system search. If the available matches are poor or are clearly the wrong concept class, use `text` only.
- For `ServiceRequest.code`, prefer targeted `http://snomed.info/sct` lookups (e.g., search `'referral social services'` or `'food assistance'`).

### ServiceRequest structure (for referrals)

Required elements: `status`, `intent`, `code`, `subject`. Must-support: `category`, `authoredOn`, `requester`, `occurrence[x]`.

```json
{
  "resourceType": "ServiceRequest",
  "id": "enc-000-food-referral",
  "status": "active",
  "intent": "order",
  "category": [
    {
      "coding": [
        {
          "system": "http://hl7.org/fhir/us/core/CodeSystem/us-core-category",
          "code": "sdoh",
          "display": "SDOH"
        }
      ],
      "text": "Social Determinants of Health"
    }
  ],
  "code": {
    "coding": [
      {
        "system": "http://snomed.info/sct",
        "code": "<looked-up code>",
        "display": "<looked-up display>"
      }
    ],
    "text": "Referral to community food assistance program"
  },
  "subject": { "reference": "Patient/..." },
  "requester": { "reference": "Practitioner/..." },
  "authoredOn": "2026-03-15",
  "reasonReference": [
    { "reference": "Observation/...", "display": "Food insecurity screening" }
  ]
}
```

Use `category: sdoh` for social determinant referrals. Link `reasonReference` to screening Observations when the referral was triggered by a screening result.

### Terminology DB Schema & Query Guide

The database has three tables:

```
concepts(id, system, code, display)        — one row per (system, code) pair
designations(id, concept_id, label, use_code) — all synonyms/labels for a concept
designations_fts(label)                    — FTS5 full-text index on designations
```

Major systems and their URIs:
- `http://snomed.info/sct` — 513K concepts (conditions, procedures, findings)
- `http://loinc.org` — 240K concepts (observations, labs, vital signs, document types)
- `http://www.nlm.nih.gov/research/umls/rxnorm` — 71K concepts (medications)
- `http://hl7.org/fhir/sid/cvx` — 288 concepts (vaccines)

**Use FTS search** when you have a clinical concept name and need to find the right code. FTS searches across all synonyms, not just display names:

```bash
# Find SNOMED for a condition — searches synonyms like "RA", "rheumatic gout", etc.
sqlite3 <DB> "SELECT c.code, c.display FROM designations_fts
  JOIN designations d ON d.id = designations_fts.rowid
  JOIN concepts c ON c.id = d.concept_id
  WHERE designations_fts MATCH 'rheumatoid arthritis'
  AND c.system = 'http://snomed.info/sct'
  ORDER BY bm25(designations_fts) LIMIT 5"
# → 69896004|Rheumatoid arthritis (disorder)
# → 239791005|Seropositive rheumatoid arthritis (disorder)

# Find LOINC for a lab test
sqlite3 <DB> "SELECT c.code, c.display FROM designations_fts
  JOIN designations d ON d.id = designations_fts.rowid
  JOIN concepts c ON c.id = d.concept_id
  WHERE designations_fts MATCH 'hemoglobin a1c'
  AND c.system = 'http://loinc.org'
  ORDER BY bm25(designations_fts) LIMIT 5"
# → 4548-4|Hemoglobin A1c/Hemoglobin.total in Blood

# Find RxNorm for a medication
sqlite3 <DB> "SELECT c.code, c.display FROM designations_fts
  JOIN designations d ON d.id = designations_fts.rowid
  JOIN concepts c ON c.id = d.concept_id
  WHERE designations_fts MATCH 'adalimumab'
  AND c.system = 'http://www.nlm.nih.gov/research/umls/rxnorm'
  ORDER BY bm25(designations_fts) LIMIT 5"
```

**Use direct lookup** when you already have a code and want to verify it exists or get its display name:

```bash
sqlite3 <DB> "SELECT code, display FROM concepts
  WHERE system = 'http://loinc.org' AND code = '4548-4'"
# → 4548-4|Hemoglobin A1c/Hemoglobin.total in Blood
```

**Browse synonyms** for a concept to understand what names map to it:

```bash
sqlite3 <DB> "SELECT d.label FROM designations d
  JOIN concepts c ON c.id = d.concept_id
  WHERE c.system = 'http://snomed.info/sct' AND c.code = '69896004'"
# → Rheumatoid arthritis (disorder)
# → Atrophic arthritis
# → Rheumatic gout
# → RA - Rheumatoid arthritis
# → Proliferative arthritis
```

**Use display LIKE** when FTS gives too many results and you want to narrow by the canonical display name:

```bash
sqlite3 <DB> "SELECT code, display FROM concepts
  WHERE system = 'http://loinc.org' AND display LIKE 'Blood pressure%' LIMIT 5"
```

**Tips:**
- FTS `MATCH` uses word-level matching — `'rheumatoid arthritis'` finds entries containing both words in any order
- Results are ranked by BM25 relevance (lower/more negative = better match)
- FTS searches designations (synonyms), so it finds codes even if you use an alternate name
- For exact code verification, query `concepts` directly — much faster than FTS
- Deduplicated results may appear when a concept has multiple matching synonyms — just take the first

## Requirements

- Every emitted resource needs `resourceType`, `id`, and required FHIR R4 fields
- Match the structural patterns from the real FHIR examples
- Blood pressure: single Observation with systolic + diastolic `component` entries
- Reuse prior IDs exactly when updating an existing resource
- The output must describe exactly one encounter, matching the provided encounter contract date and site
- `Encounter.serviceProvider` must reference the scaffold organization for this site
- Encounter participants and locations must reference scaffold practitioner/location IDs only
- Do not add project-specific metadata tags; the pipeline will stamp those in code after generation

### Encounter.class coding

Set `Encounter.class` from `http://terminology.hl7.org/CodeSystem/v3-ActCode` based on the encounter contract's `encounter_type`:

- Office visit, urgent care visit, prenatal visit, lab visit, imaging: `AMB` (ambulatory)
- Emergency department visit: `EMER`
- Inpatient / hospital stay: `IMP`
- Telephone, telemedicine, MyChart message: `VR` (virtual)

Urgent care is **ambulatory** (`AMB`), not emergency (`EMER`).

### Encounter.type coding

Use **SNOMED CT** for `Encounter.type`. Look up the appropriate procedure concept in the terminology DB. Common examples:

- Office visit: search `'office visit'` or `'outpatient visit'` in SNOMED
- Urgent care visit: search `'urgent care visit'` in SNOMED
- Telephone encounter: search `'telephone consultation'` in SNOMED
- Emergency visit: search `'emergency department visit'` in SNOMED
- Prenatal visit: search `'prenatal visit'` in SNOMED
- Annual wellness: search `'annual health examination'` or `'preventive care'` in SNOMED

Format:
```json
"type": [
  {
    "coding": [
      {
        "system": "http://snomed.info/sct",
        "code": "<looked-up code>",
        "display": "<looked-up display>"
      }
    ],
    "text": "Office Visit"
  }
]
```

**Do NOT** reuse `Encounter.class` code systems (`v3-ActCode`) or appointment code systems (`v2-0276`) as type codings — those are different concepts.

## DiagnosticReport / Observation linkage

Use the structured inventory JSON as the contract for whether a DiagnosticReport is backed by actual observations in this encounter.

- If a diagnostic report item has `report_state: "report-with-results"`, emit the named Observation resources and include them in `DiagnosticReport.result`
- If a diagnostic report item has `report_state: "summary-only"`, do not invent missing component observations solely to populate the report
- If a diagnostic report item has `report_state: "ordered-not-resulted"`, do not emit a final result-bearing DiagnosticReport or final lab Observation unless the encounter note clearly contains the actual resulted data
