# Plan 3: Synthetic Data Pipeline

## Purpose

Generate realistic synthetic patient data that:
- Is clinically coherent (medications match diagnoses, lab trends are plausible)
- Spans multiple providers and jurisdictions (demonstrates filtering)
- Uses real terminology codes (SNOMED, LOINC, RxNorm, CVX)
- Matches the shape and density of real patient records (~400-500 resources per site, ~15-20 observations per encounter)
- Exercises every access constraint dimension (scopes, periods, jurisdictions, organizations)

## Approach: Fractal Expansion

Generate data top-down through six levels of increasing detail. Each level is informed by the level above and calibrated against real record patterns from the seed data. LLM calls at each level; subagents for parallelizable work; overall flow stays flat.

```
Level 0+1: Patient Biography + Provider Map
    ↓
Level 2: Encounter Timeline
    ↓
Level 3: Clinical Notes (plain text per encounter — the narrative)
    ↓
Level 4: Resource Inventory (informed by the notes — the structured manifest)
    ↓
Level 5: FHIR Resource Generation
```

The key insight is that **clinical notes come before the resource inventory**. The note is the primary artifact of an encounter — it tells the story in narrative form. The structured FHIR resources are then derived to be consistent with that narrative. This ensures notes and structured data don't contradict each other, matching how real clinical documentation works.

## Artifact Boundary: What Agents Read vs What Code Reads

This pipeline produces two kinds of artifacts, and the boundary matters:

**Agent-readable artifacts (Levels 0–3)**: Plain markdown files. These are written and read by LLMs, not parsers. They should be natural, expressive, and include reasoning, clinical rationale, and narrative color. An agent writing a provider map should feel free to explain *why* the patient ended up at a particular specialist, not just list the fields. Structured data (dates, names, codes) should be present and consistent but lives inside prose or light tables, not rigid schemas. Think of these as "design documents that happen to contain the data."

**Code-readable artifacts (Level 4 output)**: FHIR R4 JSON. These must be valid, parseable, and loadable into HAPI FHIR. No wiggle room — the FHIR validator is the arbiter. Everything upstream exists to make this output correct and realistic.

**The bridge between them**: Level 4 is where agent-readable plans become code-readable FHIR. This step uses:
- Few-shot examples extracted from the real seed records (showing the exact JSON shape)
- Terminology lookup tools (local SQLite databases) for code selection
- The FHIR validator as a final quality gate

---

## Level 0 — Patient Biography

**Input**: A scenario brief (2-3 sentences) + which use cases / access constraint dimensions the patient should exercise.

**Output**: A markdown file describing the patient — demographics, clinical arc, personality, care-seeking patterns. This is a character sketch, not a form.

**Example** (this is the kind of file an agent would produce):

> ### Maria Santos
>
> 56-year-old married Latina woman, originally from Chicago, now living in San Francisco. English-speaking. Works as a school administrator.
>
> **Clinical arc**: Healthy and active until age 50. Diagnosed with Type 2 diabetes in 2018 after a routine wellness visit showed A1c of 7.8%. Started metformin — responded well initially. Moved to California in 2020 for her husband's job, had to find all new providers. Developed hypertension in 2021 (probably brewing for a while, but the move disrupted her care continuity). Added lisinopril. A1c drifted up slightly during the transition year but came back under control by 2022.
>
> The big event: In May 2024, she went to the ED with palpitations and chest tightness after a stressful week at work. Troponin negative, but ECG showed new-onset atrial fibrillation. Started apixaban in the ED, discharged with cardiology follow-up. Now managed by a cardiologist in addition to her PCP. The AFib is paroxysmal — she has episodes every few weeks, usually self-limited.
>
> **Allergies**: Sulfa antibiotics (developed a rash as a teenager), shellfish (GI upset — avoids but carries an epi-pen out of caution).
>
> **Immunizations**: Up to date. Full COVID primary series + boosters. Annual flu shots. Got shingles vaccine in 2023.
>
> **What this patient exercises for the demo**:
> - **Scopes**: Rich data across resource types — conditions, observations (vitals + labs), medications, immunizations, procedures (echo, ECG), documents. A ticket can meaningfully limit which types are returned.
> - **Periods**: Data spans 2018-2025. A ticket limiting to 2022-2024 would exclude the original diabetes diagnosis but include the AFib event.
> - **Jurisdictions**: Care in IL (2015-2020) and CA (2020-present). Filtering by state shows clearly different data.
> - **Organizations**: 3 providers (Chicago PCP, SF PCP, SF cardiology). Filtering by org shows different clinical perspectives on the same patient.

The biography doesn't need to be YAML. It just needs to be clear and complete enough that the next agent can build a provider map and encounter timeline from it.

**LLM prompt strategy**: Provide the scenario brief, calibration notes (real patients have ~3-8 active conditions, ~3-6 medications, ~5-8 encounters/year), and diversity guidance. Let the LLM write a character, not fill in a template.

---

## Level 1 — Provider Map

**Input**: Patient biography from Level 0.

**Output**: A markdown file describing each care site. For each provider, enough structured detail that data generation is consistent (name, NPI, type, state, time range) but also narrative about the provider's role and what kind of data they'd hold.

**Example**:

> ### Providers for Maria Santos
>
> #### Midwest Family Medicine — Chicago, IL
> - **NPI**: 1234567890
> - **Type**: Primary care / family medicine
> - **Active period**: 2015 – June 2020
> - **Key clinicians**: Dr. Robert Chen (PCP), various nurses for vitals
>
> Maria's long-time PCP. This is where she got her diabetes diagnosis and where all her early management happened. Dr. Chen is thorough — full vitals at every visit, annual wellness exams with comprehensive metabolic panels, regular A1c monitoring. He's the one who started her on metformin and did the initial diabetes education.
>
> This site holds: wellness visits, diabetes management encounters, routine labs (CMP, A1c, lipids), immunizations, telephone follow-ups for lab results. Also has a couple of urgent care visits (URI in 2019, back pain in 2018). **No cardiac data** — the AFib hadn't happened yet.
>
> About 30 encounters over 5 years. Roughly 250-300 resources.
>
> #### Pacific Health Partners — San Francisco, CA
> - **NPI**: 0987654321
> - **Type**: Primary care / internal medicine
> - **Active period**: August 2020 – present
> - **Key clinicians**: Dr. Aisha Patel (PCP), lab staff
>
> Maria's PCP after moving to SF. Initial "establish care" visit was mostly records review + getting baseline vitals and labs on their system. Dr. Patel continued the metformin, added lisinopril when BP stayed elevated over two visits. Ongoing diabetes and hypertension management. Referred Maria to cardiology after the ED AFib event.
>
> This site holds: ongoing chronic disease management, the hypertension diagnosis, routine labs, some telephone encounters, a telemedicine visit during a COVID scare. Also holds the shingles vaccine. **This site knows about the AFib** (from the cardiology notes flowing back) but the primary cardiac management is at Bay Area Cardiology.
>
> About 25 encounters over 5 years. Roughly 200-250 resources.
>
> #### Bay Area Cardiology — San Francisco, CA
> - **NPI**: 1122334455
> - **Type**: Cardiology specialty
> - **Active period**: June 2024 – present
> - **Key clinicians**: Dr. James Nakamura (cardiologist), echo tech
>
> Specialist referral after the ED AFib event. Maria sees Dr. Nakamura every 3-4 months. He ordered the initial echocardiogram (normal EF, mild LA enlargement), manages the apixaban, and is monitoring her AFib burden. Also ordered a Holter monitor.
>
> This site holds: cardiology consult notes, echo reports, ECG tracings, Holter results, medication management for apixaban. Relatively few resources but highly specialized.
>
> About 6 encounters over 1 year. Roughly 60-80 resources.

The NPI, state, and time periods are the structured data that downstream steps rely on. The narrative about what each site holds is what guides encounter and resource generation.

**Calibration against seed data**: Real patient had 2 sites with 5-7 sub-organizations each (main practice + lab + sub-departments). Synthetic providers should have a similar internal structure — the main org, its lab, and any associated locations.

---

## Level 2 — Encounter Timeline

**Input**: Patient biography + provider map.

**Output**: A markdown file listing encounters per site. Each encounter has a date, type, reason, and narrative about what happened — enough that the resource inventory step can figure out exactly what FHIR resources to create.

The encounter list should read like a clinical chart summary. Agents reading this should be able to picture the visit. But it also needs consistent dates and encounter types so resource generation is deterministic.

**Encounter type distribution** (calibrated against real data):

| Type | Fraction | Observations/encounter |
|---|---|---|
| Office visit | ~30% | 15-20 (full vitals + screening + possibly labs) |
| Telephone | ~25% | 0-3 (maybe a reported BP) |
| Lab-only | ~15% | 5-15 (just lab results, no vitals) |
| ED visit | ~8% | 20-30 (vitals + labs + imaging + procedures) |
| Telemedicine | ~10% | 0-5 (reported vitals if patient has home devices) |
| Other (imaging, referral, orders) | ~12% | varies |

**Visit frequency**: Real data shows 3-5 encounters/year/site for a chronically ill patient. Scale up for more complex patients, down for healthy ones.

**What the timeline captures per encounter**: Date, type, reason for visit, what happened clinically (new diagnoses, med changes, lab results, referrals), and any key values (specific lab numbers, BP readings) that need to trend realistically across time.

**Clinical coherence checks**: A1c should improve after starting metformin. BP should come down after starting lisinopril. A new AFib diagnosis should trigger anticoagulation within the same or next encounter. Flu vaccines happen in fall. Annual wellness visits are roughly annual.

---

## Level 3 — Resource Inventory

**Input**: Encounter timeline + patient biography.

**Output**: Per encounter, a description of what FHIR resources should be created, updated, or simply referenced from prior state. This is still an agent-readable document — the output describes resources in clinical terms, not FHIR JSON. It should capture enough detail (specific lab values, vital sign readings, medication names and doses, condition codes) that Level 4 can generate FHIR without further clinical reasoning.

This is where the fractal expansion happens at scale — each encounter from Level 2 gets expanded into 5-30 individual resources. **Subagents can parallelize here**: each encounter's inventory is independent, so fan them out.

**Calibration against real data**:
- An office visit typically produces: 1 Encounter + 8-12 Observation (vitals) + 2-4 Observation (screening like PHQ-2) + 0-10 Observation (labs if ordered) + 0-2 Condition or MedicationRequest actions (new, update, or reuse) + 1 DocumentReference (progress note) + 0-1 DiagnosticReport + 0-1 Immunization
- Conditions use SNOMED CT as the primary coding system (real data often includes additional codings like ICD-10, but SNOMED is sufficient for our purposes)
- Medication lifecycle should be explicit at the inventory layer: new start, change, stop, restart, or continue-without-new-resource
- Observations in "exam" and "functional-status" categories are common alongside pure vitals — things like depression screening scores, SDOH assessments

**What matters here**: specific values. The A1c at the March 2018 visit should be 7.8%. The BP at the August 2020 new-patient visit should be 142/88. These numbers were established in the biography and timeline; the inventory locks them in and adds all the surrounding context (the other vitals, the routine labs, the documents).

---

## Level 4 — FHIR Resource Generation

This is where agent-readable artifacts become code-readable FHIR JSON. The boundary is sharp: everything out of this level must pass the FHIR validator.

### Reference Scaffold + Prior State

Rather than pre-creating a large set of persistent clinical resources, the pipeline now creates only a small **reference scaffold** up front for each site:

- `Patient`
- `Organization`
- `Practitioner`
- `Location`

Clinical state then emerges **chronologically** from encounters.

For each encounter, the generator receives:
- the site reference scaffold
- a compact index of prior resources already generated for that site
- file paths for those prior resources, so the agent can inspect them directly if it needs more detail

This keeps the model simple:
- chronic conditions begin at the encounter where they are first diagnosed
- long-term medications begin at the encounter where they are first prescribed
- later encounters reuse those IDs
- if a prior resource materially changes state, the encounter emits an updated resource using the same ID
- if nothing materially changes, the encounter can simply reference prior state without minting a new resource

This is intentionally agentic. We rely on prompt guidance and chronological processing rather than hard temporal sandboxing.

### Few-Shot Examples from Seed Data

The seed records (`.seed-data/`) contain real FHIR resources from two sites. For each resource type, extract 2-3 representative examples, sanitize them (strip PII, randomize identifiers), and use them as few-shot examples in generation prompts. This ensures the generated FHIR matches the structural patterns of real EHR exports.

What to show the agent per resource type:
- **Observation (vital sign)**: A blood pressure with components (systolic + diastolic), showing category coding, LOINC code structure, valueQuantity with units, effectiveDateTime, encounter/subject references
- **Observation (lab)**: A BUN/creatinine or A1c, showing referenceRange, specimen reference, basedOn links
- **Condition**: A condition with SNOMED coding, clinical/verification status, category, onset date (stripped of proprietary codings from real data, just the SNOMED)
- **MedicationRequest**: Including dosageInstruction text, dispenseRequest, medicationReference, reasonCode, status lifecycle
- **Encounter**: Class, type with display text, period, participant, reasonCode, location references

The few-shot examples are sanitized once and stored as part of the pipeline's prompt library. They don't change per patient.

### Terminology Lookup — Existing SQLite Database from Kiln

We already have a production-quality terminology database built for the Kiln project (`/home/jmandel/hobby/kiln/server/db/terminology.sqlite`, 345 MB). We can reuse it directly — no need to build one from scratch.

**What it contains**:
- **SNOMED CT** — 513,765 concepts (US edition, 2023-09-01)
- **LOINC** — 240,606 concepts (version 2.77)
- **RxNorm** — 71,375 concepts (2022 edition, newer 2024 edition also available)
- **CVX** — 288 vaccine codes (from CDC)
- **1,100+ HL7 code systems** — v2 tables, v3 codes, FHIR-defined systems
- **Total**: 851,200 concepts with 1,809,095 searchable designations (synonyms)

**Schema** (3 tables + FTS5):
- `concepts(id, system, code, display)` — unique on (system, code)
- `designations(id, concept_id, label, use_code)` — all synonyms/labels for a concept
- `designations_fts` — FTS5 virtual table on `designations.label`, BM25 scoring
- Triggers keep FTS in sync on insert/update/delete

**How the agent uses it**: The agent queries the SQLite database directly via bash. No special tool wrappers needed — just `sqlite3` commands.

Examples:

```bash
# Find SNOMED code for type 2 diabetes
sqlite3 terminology.sqlite "
  SELECT c.system, c.code, c.display, bm25(designations_fts) as rank
  FROM designations_fts
  JOIN designations d ON d.id = designations_fts.rowid
  JOIN concepts c ON c.id = d.concept_id
  WHERE designations_fts MATCH 'type 2 diabetes'
  AND c.system = 'http://snomed.info/sct'
  ORDER BY rank LIMIT 5"

# Find RxNorm code for metformin 500mg
sqlite3 terminology.sqlite "
  SELECT c.code, c.display FROM designations_fts
  JOIN designations d ON d.id = designations_fts.rowid
  JOIN concepts c ON c.id = d.concept_id
  WHERE designations_fts MATCH 'metformin 500'
  AND c.system = 'http://www.nlm.nih.gov/research/umls/rxnorm'
  ORDER BY bm25(designations_fts) LIMIT 5"

# Verify a code exists
sqlite3 terminology.sqlite "
  SELECT display FROM concepts
  WHERE system = 'http://loinc.org' AND code = '4548-4'"
```

The agent can also read the NDJSON source files directly if it needs richer data (e.g., concept relationships, properties) beyond what's in the SQLite tables.

**Focus terminologies**: SNOMED CT (conditions, procedures, findings), LOINC (observations, document types), RxNorm (medications), CVX (immunizations). These four cover everything we need.

**Setup**: Copy or symlink the pre-built `terminology.sqlite` (345 MB) from the Kiln project. The source NDJSON.gz files (~50MB) and load script are available if the DB needs rebuilding.

### FHIR Validation

Every generated resource gets validated before loading:

1. **Schema validation**: Does the JSON conform to the FHIR R4 resource schema? (Can use the HAPI FHIR validator library, or a JSON Schema derived from the FHIR spec.)
2. **Terminology validation**: Are the codes real? This is where the SQLite databases help again — validate that every `system`/`code` pair actually exists in the referenced terminology.
3. **Referential integrity**: Do all `reference` fields point to resources that exist in the Bundle?
4. **Clinical plausibility spot-checks**: (Optional, agent-based) Does the A1c value make sense for a diabetic patient? Is the medication dose in a reasonable range?

For the FHIR validator specifically: HAPI's validator can run as a CLI tool or be embedded in a Java process. For our Bun/TypeScript pipeline, the most practical option is probably:
- Run the HAPI validator CLI as a subprocess: `java -jar validator_cli.jar <resource.json> -version 4.0.1`
- Or use a lighter-weight approach: validate against the FHIR R4 JSON Schema (covers structure) and check codes against SQLite (covers terminology)

The second approach is faster and doesn't require Java, which might be preferable for the pipeline. Save the full HAPI validator for a final sweep.

### Generation Strategy: Templates + LLM Hybrid

**Templates for high-volume, predictable resources**:
- Vital sign Observations (BP, HR, weight, height, BMI, SpO2, temp, resp rate) — these are structurally identical every time, just different values
- Lab Observations — same structure, different LOINC codes and values
- Encounter shells — class, type, period, references
- DocumentReference stubs — type, date, status

**LLM for variable, clinical-judgment resources**:
- Conditions (need to pick the right SNOMED code, set correct clinical/verification status)
- MedicationRequests (need realistic sig text, correct RxNorm code for specific formulation, dosage details)
- AllergyIntolerance (reaction details, severity, criticality)
- CarePlan, Goal (narrative-heavy)
- Clinical document content (if we generate actual note text)

The LLM generation calls include: the resource inventory item, the few-shot example for that resource type, access to terminology lookup tools, and the patient context (so medication choices are clinically appropriate).

### Reference Wiring and ID Assignment

After generating individual resources:
1. Assign UUIDs when a resource is first created
2. Create Patient, Organization, Practitioner, and Location resources per the provider map
3. Generate encounters in chronological order within each site
4. Let clinical resources emerge from the first relevant encounter instead of pre-baking them into the scaffold
5. When a prior clinical resource changes state, reuse the same ID and overwrite the site snapshot with the updated resource
6. Wire encounter references: every encounter-local clinical resource points to its encounter
7. Wire patient references: everything points to the patient
8. Wire organization references: encounters → serviceProvider → Organization
9. Wire specimen/report chains: lab Observation → Specimen → DiagnosticReport → Observation (result)
10. Apply constraint-exercise tags: `meta.tag` for source-org (NPI) and jurisdiction (state)

### Output Format

The pipeline produces a self-contained directory tree per patient. Each site the patient visited gets its own subdirectory containing a FHIR Bundle and individual resource files. A top-level manifest ties everything together.

```
output/
  patients/
    maria-santos/
      biography.md              ← Step 1 output (agent-readable)
      encounters.md             ← Step 2 output (agent-readable)
      notes/                    ← Step 3 output (clinical notes, plain text)
        enc-000.txt
        enc-001.txt
        ...
      inventories/              ← Step 4 output (resource manifests, agent-readable)
        enc-000.md
        enc-001.md
        ...
      sites/
        midwest-family-medicine/
          bundle.json           ← FHIR Bundle (type: collection), all resources for this site
          resources/             ← Individual resource files for debugging/inspection
            Patient/patient-1.json
            Encounter/enc-001.json
            Observation/obs-001.json
            ...
          encounter-manifests/   ← Which resources each encounter wrote/updated
            enc-000.json
            enc-001.json
            ...
        pacific-health-partners/
          bundle.json
          resources/
            ...
        bay-area-cardiology/
          bundle.json
          resources/
            ...
  manifest.json                 ← Index: patients, sites, resource counts, scenario metadata
```

**manifest.json** ties together the full output — which patients exist, which sites they have data at, what use cases they exercise, resource counts per site. Downstream consumers (HAPI loader, in-memory test harness, conformance test suite, etc.) read the manifest to discover what's available.

The pipeline does NOT know about HAPI, Docker, or any specific server. It just produces valid FHIR in an organized directory structure. Loading into a server is the responsibility of a separate tool (see Plan 2).

---

## Pipeline Execution Architecture

### Two layers: Operator Agent + Step Scripts

The pipeline has two layers:

1. **Operator agent** — A human runs Claude Code with a system prompt (the "operator prompt") that understands the full pipeline. The operator agent interviews the user about what patients to generate, shows intermediate results, takes feedback, and calls step scripts in sequence. It's the conversational layer — it reasons about what to do next, handles errors, and keeps the human in the loop.

2. **Step scripts** — TypeScript files (Bun) that do the actual work at each level. Some steps are pure code (template generation, validation, assembly). Some steps shell out to Claude CLI as subagents for creative/LLM work. Each step is independently runnable, takes inputs from disk, writes outputs to disk.

This separation means:
- **Restartability**: Every step reads/writes files. If step 3 fails, rerun it — steps 1-2 outputs are still on disk.
- **Context isolation**: Each Claude CLI invocation gets a fresh context window with just the inputs it needs, not the accumulated history of the whole pipeline.
- **Observability**: The operator agent can `cat` intermediate files, show them to the user, and ask "does this biography look right before I generate encounters?"
- **Cost tracking**: Each step script can report its own cost/duration.

### The Operator Prompt

Lives at something like `synth-data/OPERATOR.md`. When the user runs Claude Code in the `synth-data/` directory, this prompt guides the conversation:

```markdown
You are the operator for the synthetic patient data pipeline. Your job is
to help the user generate realistic synthetic FHIR patient data for the
SMART Permission Tickets reference implementation.

## What you can do

- Generate new patients from scenario briefs
- Resume a partially-completed patient generation
- Show the user intermediate artifacts (biographies, encounter timelines)
- Rerun or edit specific steps
- Validate and assemble final output

## How the pipeline works

Each patient goes through these steps, each producing files on disk:

1. `steps/01-biography.ts` — Generates patient biography + provider map
2. `steps/02-encounters.ts` — Generates encounter timeline
3. `steps/03-notes.ts` — Fan-out: generates clinical notes per encounter (plain text)
4. `steps/04-inventory.ts` — Fan-out: generates resource inventories per encounter (informed by notes)
5. `steps/05-generate-fhir.ts` — Generates a small reference scaffold, then encounter FHIR resources in chronological order with prior-resource context
6. `steps/06-assemble.ts` — Wires references, validates, assembles bundles

Steps 1-2 produce markdown (for your review). Steps 3-4 produce markdown
then FHIR JSON. Step 5 is pure code.

## Your workflow

1. Ask the user: new patient or resume existing?
2. If new: ask for a scenario brief (or offer to suggest one)
3. Run step 1. Show the biography to the user. Ask if it looks good.
4. Run step 2. Show the encounter timeline. Ask if it looks good.
5. Run steps 3-5 (these are more mechanical — show progress, flag errors)
6. Show summary: resource counts per site, any validation issues
7. Ask if the user wants to generate another patient
```

The operator prompt is the "meta" layer. It doesn't generate FHIR itself — it orchestrates the step scripts and manages the conversation with the user.

### Step Scripts

All TypeScript, all run with Bun. Each script:
- Takes a patient directory as argument: `bun run steps/01-biography.ts patients/maria-santos/`
- Checks if its output already exists (skip if so, unless `--force`)
- Does its work (code, or shells out to Claude CLI for LLM work)
- Writes output to the patient directory
- Exits with status code (0 = success, 1 = failure)

```
synth-data/
  OPERATOR.md                 ← System prompt for the operator agent
  steps/
    01-biography.ts           ← Generates biography.md (includes provider map)
    02-encounters.ts          ← Generates encounters.md
    03-notes.ts               ← Fan-out: generates notes/enc-*.txt (clinical notes)
    04-inventory.ts           ← Fan-out: generates inventories/enc-*.md (informed by notes)
    05-generate-fhir.ts       ← Reference scaffold + chronological encounter generation → FHIR JSON
    06-assemble.ts            ← Wire refs, validate, bundle, manifest
  prompts/
    biography.md              ← System prompt for biography generation agent
    encounters.md             ← System prompt for encounter timeline agent
    notes.md                  ← System prompt for clinical note generation agent
    inventory.md              ← System prompt for per-encounter inventory agent
    fhir-generation.md        ← System prompt for FHIR resource generation agent
  templates/
    observation-vital.ts      ← FHIR template: vital sign observation
    observation-lab.ts        ← FHIR template: lab observation
    condition.ts              ← FHIR template: condition
    medication-request.ts     ← FHIR template: medication request
    encounter.ts              ← FHIR template: encounter
    ...
  few-shots/
    observation-bp.json       ← Sanitized real example: blood pressure
    observation-lab.json      ← Sanitized real example: lab result
    condition.json            ← Sanitized real example: condition
    medication-request.json   ← Sanitized real example: med request
    encounter.json            ← Sanitized real example: encounter
    ...
  seed-data/                  ← Symlink to .seed-data/ (real records for reference)
  terminology.sqlite          ← Symlink to Kiln terminology DB
  patients/                   ← Output directory (one subdir per patient)
    maria-santos/
      scenario.md             ← Input: the scenario brief
      biography.md            ← Step 1 output (includes provider map)
      encounters.md           ← Step 2 output
      notes/                  ← Step 3 output (clinical notes)
        enc-000.txt
        enc-001.txt
        ...
      inventories/            ← Step 4 output (resource manifests, informed by notes)
        enc-000.md
        enc-001.md
        ...
      sites/                  ← Steps 4-5 output
        midwest-family-medicine/
          bundle.json
          resources/
            ...
          encounter-manifests/
            ...
        ...
  manifest.json               ← Global index of all patients
```

### How steps shell out to Claude CLI

Steps that need LLM work (01, 02, 03, 04) use Bun's `$` shell helper to invoke Claude:

```typescript
// In steps/01-biography.ts
import { $ } from "bun";

const scenarioPath = `${patientDir}/scenario.md`;
const scenario = await Bun.file(scenarioPath).text();
const systemPrompt = await Bun.file("prompts/biography.md").text();

// Shell out to Claude CLI with the scenario as input
const result = await $`echo ${scenario} | claude \
  --system-prompt ${systemPrompt} \
  --output-format text \
  --max-tokens 4000`.text();

await Bun.write(`${patientDir}/biography.md`, result);
```

For fan-out (step 03), the script parses the encounter list, then launches multiple Claude CLI subprocesses with concurrency control:

```typescript
// In steps/03-inventory.ts
const encounters = parseEncounterList(await Bun.file(`${patientDir}/encounters.md`).text());

const results = await Promise.allSettled(
  encounters.map((enc, i) =>
    limit(async () => {  // concurrency limiter, e.g. p-limit
      const existing = Bun.file(`${patientDir}/inventories/enc-${i}.md`);
      if (await existing.exists()) return; // skip if already done

      const result = await $`echo ${JSON.stringify(enc)} | claude \
        --system-prompt prompts/inventory.md \
        --context ${patientDir}/biography.md \
        --context ${patientDir}/providers.md \
        --output-format text`.text();

      await Bun.write(`${patientDir}/inventories/enc-${i}.md`, result);
    })
  )
);
```

The exact Claude CLI invocation flags will depend on the SDK/CLI interface, but the pattern is: pipe input, point at system prompt, get text output, write to file.

### What the operator agent does vs what step scripts do

| Concern | Operator Agent | Step Scripts |
|---|---|---|
| Decide what to do next | Yes — reasons about pipeline state | No — just runs when called |
| Talk to the user | Yes — interviews, shows results, takes feedback | No — stdout/stderr only |
| Call Claude for LLM work | No — delegates to step scripts | Yes — shells out to Claude CLI |
| Read/write patient files | Yes — to show user intermediate results | Yes — primary file I/O |
| Handle errors | Yes — interprets failures, suggests fixes | No — just exits with error code |
| Track progress | Yes — checks which files exist | Yes — skips existing outputs |
| Validate output | No — calls step 05 which does validation | Yes (step 05) |

---

## Terminology Database Setup

Reuse the existing terminology database from the Kiln project. One-time setup:

1. Copy or symlink `terminology.sqlite` (345 MB) into the pipeline's working directory
2. Verify SNOMED, LOINC, RxNorm, CVX coverage is sufficient

Source files and load script live in the Kiln project at:
- `/home/jmandel/hobby/kiln/server/db/terminology.sqlite` — pre-built database
- `/home/jmandel/hobby/kiln/server/large-vocabularies/` — source NDJSON.gz files (git submodule)
- `/home/jmandel/hobby/kiln/server/scripts/load-terminology.ts` — rebuilds DB from sources

The agent queries the database directly via `sqlite3` bash commands — no special wrapper tools needed. The FTS5 index supports fast full-text search with BM25 ranking. The agent can also `zcat` the source NDJSON.gz files for richer data when needed.

---

## Phased Delivery

### Phase 1: Scaffolding + infrastructure
- Set up `synth-data/` directory structure
- Copy/symlink terminology SQLite from Kiln
- Extract and sanitize few-shot examples from seed data
- Write the operator prompt (OPERATOR.md)
- Stub out step scripts (just the file I/O and skip-if-exists logic, no LLM yet)

### Phase 2: Steps 01-02 (biography + encounters)
- Write prompts for biography and encounter generation (prompts/biography.md, prompts/encounters.md)
- Implement steps 01-biography.ts and 02-encounters.ts (shell out to Claude CLI)
- Generate 2-3 patients interactively via the operator agent, iterate on prompt quality
- Human reviews and edits the markdown outputs until they feel right

### Phase 3: Step 03 (resource inventories)
- Write the per-encounter inventory prompt (prompts/inventory.md)
- Implement step 03-inventory.ts with fan-out and concurrency control
- Generate inventories for the Phase 2 patients, validate resource counts and clinical coherence

### Phase 4: Steps 04-05 (FHIR generation + assembly)
- Build FHIR templates for vitals, labs, encounter shells
- Write the FHIR generation prompt for LLM-assisted resources (conditions, meds, allergies)
- Implement step 04-generate-fhir.ts (templates + Claude CLI for complex resources)
- Implement step 05-assemble.ts (reference wiring, validation, bundling, manifest)
- End-to-end run: scenario brief → valid FHIR bundles on disk

### Phase 5: Scale and polish
- Generate 10-20 patients across diverse demographics and disease states
- Refine prompts based on validation failures
- Tune the operator prompt based on user experience
- Optimize concurrency and cost

---

## Open Questions

1. **FHIR version**: R4 (matching seed data and most US implementations). Confirm?
2. **DocumentReference content**: Metadata stubs for Phase 2, LLM-generated clinical note text for Phase 4+?
3. **Practitioner/Organization realism**: Realistic-sounding synthetic names and NPIs, or obviously fake?
6. **Bundle type**: `collection` (just a set of resources) vs `transaction` (with request entries for server loading)? Collection is more generic; transaction is more useful for loading but couples to server expectations. Could output both.
