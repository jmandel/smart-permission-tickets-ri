# Synthetic Patient Data Pipeline — Operator Guide

You are the operator for the synthetic patient data pipeline. Your job is to help the user generate realistic synthetic FHIR patient data for the SMART Permission Tickets reference implementation.

## What you can do

- Generate new patients from scenario briefs
- Resume a partially-completed patient generation
- Show the user intermediate artifacts (biographies, encounter timelines)
- Rerun or edit specific steps
- Validate and assemble final output

## How the pipeline works

Each patient goes through these steps, each producing files on disk in `patients/<patient-slug>/`:

1. `steps/01-biography.ts <patient-dir>` — Generates `biography.md` (patient character sketch + provider map)
2. `steps/02-encounters.ts <patient-dir>` — Generates `encounters.md` (full encounter timeline)
3. `steps/03-notes.ts <patient-dir>` — Fan-out: generates `notes/enc-*.txt` (plain-text clinical notes per encounter)
4. `steps/04-inventory.ts <patient-dir>` — Fan-out: generates `inventories/enc-*.md` (per-encounter resource manifests, informed by the clinical notes)
5. `steps/05-generate-fhir.ts <patient-dir>` — Reference scaffold + chronological encounter generation → FHIR JSON in `sites/*/resources/`
6. `steps/06-assemble.ts <patient-dir>` — Assembles `sites/*/bundle.json` + updates `manifest.json`

Steps 1-2 produce markdown meant for human review. Step 3 generates clinical notes (the narrative). Step 4 generates resource inventories that are consistent with those notes. Step 5 first creates a small site reference scaffold, then generates encounters in chronological order with prior site resources available as context. Step 6 is pure code.

Every step checks if its output already exists and skips if so. Pass `--force` to regenerate.

## Agent backends

The step scripts call the configured agent backend through `steps/lib.ts`. Supported backends are:

- `claude` — default backend
- `codex`
- `copilot`

### How to select a backend

For normal step-script runs, use `--agent-cli`:

```bash
bun run steps/04-inventory.ts patients/elena-reyes --agent-cli copilot
bun run steps/05-generate-fhir.ts patients/elena-reyes --agent-cli codex
```

You can also set an environment variable:

```bash
SYNTH_AGENT_CLI=copilot bun run steps/05-generate-fhir.ts patients/elena-reyes
```

Optional overrides:

- `--agent-model <model>` or `SYNTH_AGENT_MODEL=<model>`
- `--agent-model-for-step-05-generate-fhir <model>` or `SYNTH_AGENT_MODEL_FOR_STEP_05_GENERATE_FHIR=<model>`
- `--agent-reasoning-effort <level>` for Codex

Model selection precedence:

1. Step-specific override like `--agent-model-for-step-04-inventory ...`
2. Global override `--agent-model ...`
3. Centralized backend default in `steps/lib.ts`

### Important nuance for ad hoc `bun -e` tests

When using `bun -e '...'`, extra CLI args like `--agent-cli copilot` are not passed through to `process.argv` the same way they are for step scripts. For ad hoc `bun -e` experiments, prefer the environment variable form:

```bash
SYNTH_AGENT_CLI=copilot bun -e '/* test code */'
```

### Copilot model selection

Current working Copilot default on this machine: `claude-opus-4.6`

If you want a different Copilot model for a run, pass it explicitly:

```bash
bun run steps/05-generate-fhir.ts patients/elena-reyes --agent-cli copilot --agent-model claude-opus-4.6
```

If you want a different model only for one step in a run, use the step-specific flag:

```bash
bun run steps/05-generate-fhir.ts patients/elena-reyes \
  --agent-cli copilot \
  --agent-model-for-step-05-generate-fhir claude-opus-4.6
```

## Your workflow

### Prerequisites

Before running any steps, make sure infrastructure is ready:

1. **One-time setup**: `bun run setup` — downloads the FHIR validator JAR (~178 MB). Only needed once.
2. **Start the validator**: `bun run validator:start` — starts the FHIR validator as a background HTTP server on port 8090. Check with `bun run validator:status`. This is needed before step 05 (FHIR generation) so agents can spot-check resources, and before step 06 (assemble) for structural validation.
3. **Verify symlinks**: Two symlinks are needed in the `synth-data/` directory:
   - `terminology.sqlite` → the Kiln terminology database (851K concepts: SNOMED, LOINC, RxNorm, CVX). Source: `/path/to/kiln/server/db/terminology.sqlite`
   - `seed-data/` → real patient records for structural reference. Source: the `.seed-data/health-record-assistant/data/` directory.

   Create them with:
   ```bash
   ln -sf /path/to/kiln/server/db/terminology.sqlite ./terminology.sqlite
   ln -sf /path/to/.seed-data/health-record-assistant/data ./seed-data
   ```
   The setup script warns if they're missing.

When you're done for the day: `bun run validator:stop` shuts down the background validator process.

### Patient generation

1. **Check state**: Look at `patients/` to see what exists. Check for partially-completed patients (has biography but no encounters, etc.).
2. **New patient or resume?**: Ask the user. If new, ask for a scenario brief — or offer to suggest one based on the use cases the reference implementation needs to demonstrate.
3. **Run step 1**: `bun run steps/01-biography.ts patients/<slug>/`. Read the generated `biography.md` and show it to the user. Ask if they want to adjust anything. If so, they can edit the file directly and you proceed.
4. **Run step 2**: `bun run steps/02-encounters.ts patients/<slug>/`. Read and show `encounters.md`. This is the last creative checkpoint — after this, the pipeline is more mechanical.
5. **Run step 3**: `bun run steps/03-notes.ts patients/<slug>/`. Generates clinical notes per encounter. You can spot-check a few notes to make sure they match the encounter timeline.
6. **Run steps 4-6**: Run in sequence. Step 4 generates resource inventories (informed by the notes). Step 5 generates FHIR JSON (make sure the validator is running). Step 6 assembles bundles and runs terminology + reference validation.
7. **Show summary**: Read `manifest.json` and `patients/<slug>/validation-report.json`, report resource counts per site, any validation issues.
8. **Iterate or continue**: Ask if the user wants to generate another patient, adjust an existing one, or is done.

## Scenario briefs for the reference implementation

The reference implementation needs patients that exercise these Permission Ticket access constraint dimensions:

- **Scopes**: Patient has data across many FHIR resource types — a ticket limiting to specific types (e.g., only Immunization + AllergyIntolerance) visibly reduces what's returned
- **Periods**: Patient has data spanning multiple years — a ticket limiting to a date range visibly excludes older/newer data
- **Jurisdictions**: Patient received care in multiple US states — a ticket limiting to one state visibly excludes data from other states
- **Organizations**: Patient visited multiple providers — a ticket limiting to one org visibly excludes data from others

Good scenario briefs for the first few patients:

1. **Chronic disease management patient** (UC1 — patient access): Middle-aged adult with diabetes + hypertension, moved between states, sees PCP + specialist. Rich data across resource types and time.
2. **Public health investigation subject** (UC3): Patient with a reportable condition (e.g., TB exposure), records at a single hospital. Tests reference-based subject resolution.
3. **Social care referral subject** (UC4): Patient with food insecurity referral, limited records. Tests narrow scopes (just ServiceRequest + Task).

## Key resources

- `seed-data/` — Real patient records from two sites (symlink). Use for understanding FHIR resource shapes.
- `terminology.sqlite` — Terminology database (symlink to Kiln). Query with `sqlite3` for SNOMED, LOINC, RxNorm, CVX codes.
- `few-shots/` — Sanitized real FHIR resource examples for reference.
- `prompts/` — System prompts used by the step scripts when they shell out to the configured agent CLI.
- `validator.jar` — FHIR validator JAR (downloaded via `bun run setup`). Run as HTTP server with `bun run validator:start`.
- `../plans/03-synthetic-data.md` — The full architectural plan (in the repo root `plans/` directory).

## Terminology lookups

When you or the step scripts need to look up medical codes, query the SQLite database directly:

```bash
# Search SNOMED for a condition
sqlite3 terminology.sqlite "SELECT c.code, c.display FROM designations_fts JOIN designations d ON d.id = designations_fts.rowid JOIN concepts c ON c.id = d.concept_id WHERE designations_fts MATCH 'type 2 diabetes' AND c.system = 'http://snomed.info/sct' ORDER BY bm25(designations_fts) LIMIT 5"

# Search LOINC for an observation
sqlite3 terminology.sqlite "SELECT c.code, c.display FROM designations_fts JOIN designations d ON d.id = designations_fts.rowid JOIN concepts c ON c.id = d.concept_id WHERE designations_fts MATCH 'hemoglobin a1c' AND c.system = 'http://loinc.org' ORDER BY bm25(designations_fts) LIMIT 5"

# Search RxNorm for a medication
sqlite3 terminology.sqlite "SELECT c.code, c.display FROM designations_fts JOIN designations d ON d.id = designations_fts.rowid JOIN concepts c ON c.id = d.concept_id WHERE designations_fts MATCH 'metformin 500' AND c.system = 'http://www.nlm.nih.gov/research/umls/rxnorm' ORDER BY bm25(designations_fts) LIMIT 5"
```

## FHIR Validator

The FHIR validator runs as an HTTP server for fast per-resource validation. Setup and usage:

```bash
# One-time: download the validator JAR (~170 MB)
bun run setup

# Start the validator server (stays running in background, port 8090)
bun run validator:start

# Check if running
bun run validator:status

# Validate a single resource
curl -s -X POST http://localhost:8090/validateResource \
  -H "Content-Type: application/fhir+json" \
  -d @resource.json | jq '.issue[] | select(.severity == "error")'

# Stop the server when done
bun run validator:stop
```

Step 06 (assemble) automatically runs terminology validation against `terminology.sqlite`. The FHIR validator server is optional but useful for structural validation during development — step 05 agents can use it to spot-check generated resources if it's running.
