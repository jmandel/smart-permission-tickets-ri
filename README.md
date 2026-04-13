# SMART Permission Tickets — Reference Implementation

Reference implementation for the [SMART Permission Tickets](https://build.fhir.org/ig/nicholasjhatch/smart-permission-tickets/) specification, demonstrating portable authorization grants for cross-organizational FHIR data access.

## What's here

```
reference-implementation/
├── synth-data/        # Synthetic patient data pipeline
│   ├── patients/      # 13 synthetic patients (scenarios, biographies, encounters)
│   ├── steps/         # 7-step generation pipeline (biography → FHIR bundles)
│   ├── prompts/       # System prompts for each pipeline step
│   └── scripts/       # Setup, terminology build, infrastructure
├── fhir-server/       # FHIR R4 server with Permission Ticket token exchange
│   ├── src/           # Server (Bun + SQLite, read-only FHIR API)
│   └── ui/            # Viewer UI (React, timeline, permission workbench)
└── plans/             # Architecture and design documents
```

## Synthetic patients

13 patients across 40 provider sites with ~3,900 FHIR resources, covering all 7 Permission Ticket use cases:

| Patient | Use Case | Scenario | Sites |
|---------|----------|----------|-------|
| Elena Reyes | UC1 Patient Access | Reproductive health + rheumatology, TX→CA | 5 |
| Denise Walker | UC1 Patient Access | Complex chronic disease (DM, HF, CKD), AZ→NM | 5 |
| Sarah Mitchell | UC1 Patient Access | Bipolar II + alcohol use disorder, OR→WA (security labels) | 5 |
| Harold Washington | UC2 Authorized Rep | Alzheimer's, daughter as DPOA, FL→GA | 5 |
| Aisha Patel | UC2 Authorized Rep | Pediatric asthma + food allergies, mother as rep | 3 |
| Robert Davis | UC3 Public Health | Tuberculosis investigation | 2 |
| Marcus Johnson | UC3 Public Health | Measles outbreak, campus exposure | 1 |
| Maria Chen | UC4 Social Care | Food insecurity, CBO referral | 2 |
| James Thornton | UC5 Payer Claims | Emergency appendectomy + SSI readmission | 2 |
| Carlos Medina | UC5 Payer Claims | RA prior auth for biologic, step therapy failure | 2 |
| Patricia Okafor | UC6 Research Study | Lung cancer immunotherapy clinical trial | 3 |
| Kevin Park | UC7 Provider Consult | Atrial fibrillation, EP consult | 2 |
| Lisa Nakamura | UC7 Provider Consult | Recurrent pregnancy loss, APS workup, multi-specialist | 3 |

Each patient exercises specific Permission Ticket constraint dimensions:

- **Scopes** — filtering by FHIR resource type (e.g., only Immunization + AllergyIntolerance)
- **Periods** — filtering by date range (e.g., last 2 years only)
- **Jurisdictions** — filtering by US state (e.g., only California data)
- **Organizations** — filtering by provider (e.g., only the rheumatologist's records)
- **Security labels** — sensitive data segmentation (mental health, SUD/42 CFR Part 2, reproductive health)

## Quick start

### Prerequisites

- [Bun](https://bun.sh/) (v1.1+)
- Java 11+ (for the FHIR validator)
- An AI agent CLI: `claude`, `copilot`, or `codex` (for generating new patients)

### 1. Initialize the spec submodule and shared dependency

```bash
git submodule update --init --recursive
bun install                  # installs the shared zod dependency used by the imported spec schema
```

The reference implementation imports the canonical Permission Ticket Zod schema from `vendor/smart-permission-tickets-spec/` through the local wrapper at `shared/permission-ticket-schema.ts`.
Run `bun run check:permission-ticket-schema` from `reference-implementation/` to verify that the canonical schema is still sourced only through that shim.

### 2. Build the terminology database

```bash
cd synth-data
bun install
bun run terminology:build    # Downloads SNOMED, LOINC, RxNorm, CVX from public sources (~50MB download, builds ~405MB SQLite DB)
```

### 3. Set up the FHIR validator

```bash
bun run setup                # Downloads validator.jar (~178MB)
bun run validator:start      # Starts on port 8090
```

### 4. Generate FHIR resources for existing patients

The committed patient data includes scenarios, biographies, and encounter timelines. To generate the FHIR resources (steps 3–7):

```bash
# Generate all steps for a single patient
bun run steps/03-notes.ts patients/maria-chen --agent-cli copilot
bun run steps/04-inventory.ts patients/maria-chen --agent-cli copilot
bun run steps/05-generate-fhir.ts patients/maria-chen --agent-cli copilot
bun run steps/06-security-labels.ts patients/maria-chen --agent-cli copilot
bun run steps/07-assemble.ts patients/maria-chen
```

Each step is idempotent — it skips encounters that already have output. Pass `--force` to regenerate.

Patient folders can also include `ticket-scenarios.json`, a machine-readable set of spec-shaped Permission Ticket fragments. The enrichment step injects those fragments onto every generated `Patient` alias so `/demo/bootstrap` can prefill requester, context, access defaults, and per-use-case case details in the demo UI.

### 5. Start the FHIR server

```bash
cd fhir-server
bun install
bun run start                # Starts on port 8091
```

Open http://localhost:8091/ for the landing page, or http://localhost:8091/viewer?session for the interactive viewer.

## Synthetic data pipeline

The pipeline generates realistic FHIR R4 patient data through 7 steps of fractal expansion:

```
scenario.md                     (2-3 sentence brief)
ticket-scenarios.json           (spec-shaped demo ticket fragments per patient)
  → biography.md                (rich patient narrative)
  → provider-map.json           (structured site registry)
  → encounters.md               (visit-by-visit timeline)
  → encounters.json             (machine-readable encounters)
  → notes/enc-*.txt             (clinical notes per encounter)
  → inventories/enc-*.md + .json (FHIR resource manifests)
  → sites/*/resources/*.json    (validated FHIR R4 JSON)
  → sites/*/bundle.json         (assembled bundles)
```

Steps 1–4 produce human-readable markdown. Step 5 generates FHIR JSON with terminology lookups (SNOMED, LOINC, RxNorm, CVX) and structural validation. Step 6 applies security labels. Step 7 assembles bundles and validates all references and codes.

### Agent backends

The pipeline shells out to an AI agent CLI for steps 1–6. Supported backends:

```bash
--agent-cli copilot    # GitHub Copilot CLI (default model: claude-opus-4.6)
--agent-cli claude     # Claude Code CLI
--agent-cli codex      # OpenAI Codex CLI
```

### Creating a new patient

```bash
# 1. Write a scenario brief
cat > patients/new-patient/scenario.md << 'EOF'
# Scenario: New Patient
45-year-old with type 2 diabetes, moved from Texas to California...
EOF

# 2. Run the pipeline
bun run steps/01-biography.ts patients/new-patient --agent-cli copilot
bun run steps/02-encounters.ts patients/new-patient --agent-cli copilot
bun run steps/03-notes.ts patients/new-patient --agent-cli copilot
bun run steps/04-inventory.ts patients/new-patient --agent-cli copilot
bun run steps/05-generate-fhir.ts patients/new-patient --agent-cli copilot
bun run steps/06-security-labels.ts patients/new-patient --agent-cli copilot
bun run steps/07-assemble.ts patients/new-patient
```

See [OPERATOR.md](synth-data/OPERATOR.md) for detailed pipeline documentation.

## FHIR server

A Bun + SQLite read-only FHIR server that:

- Hosts synthetic patient data from `synth-data/patients/`
- Supports SMART/OAuth flows with Permission Ticket token exchange
- Implements site-partitioned access and `meta.security` label filtering
- Provides US Core-aligned search parameters
- Includes an interactive viewer UI with timeline visualization and permission workbench

See [fhir-server/README.md](fhir-server/README.md) for details.

## OpenID Federation (OIDF)

The reference server includes OpenID Federation 1.0 client-auth and issuer-trust flows. Current metadata-policy support is intentionally limited to these RFC operators:

- `value`
- `default`
- `one_of`

The remaining standard RFC operators are not implemented in this first pass:

- `add`
- `subset_of`
- `superset_of`
- `essential`

If one of those standard operators appears in `metadata_policy`, validation fails closed with an explicit `OIDF metadata_policy unsupported_standard_operator` error. Additional non-standard operators are ignored unless they are named in `metadata_policy_crit`; if an unsupported operator is marked critical there, validation fails closed with an explicit `OIDF metadata_policy_crit unsupported_operator` error.

Trust-mark delegation is also intentionally out of scope for this pass. Any trust mark carrying a `delegation` claim is rejected explicitly rather than being processed implicitly.

## Terminology database

The terminology database is built locally from public sources — no external dependencies or licensed data downloads required:

| Source | Content | Concepts |
|--------|---------|----------|
| [SNOMED CT](https://github.com/jmandel/fhir-concept-publication-demo) | Conditions, procedures, findings | ~514K |
| [LOINC](https://github.com/jmandel/fhir-concept-publication-demo) | Observations, lab codes | ~241K |
| [RxNorm](https://github.com/jmandel/fhir-concept-publication-demo) | Medications | ~221K |
| [HL7 FHIR R4](https://hl7.org/fhir/R4/valuesets.json) | FHIR-defined code systems | ~3K |
| [HL7 UTG](https://build.fhir.org/ig/HL7/UTG/) | Unified Terminology Governance | ~15K |
| [CDC CVX](https://www2a.cdc.gov/vaccines/iis/iisstandards/) | Vaccine codes | ~288 |

Build with `bun run terminology:build` in the `synth-data/` directory. Downloads are cached in `.terminology-cache/`.

## License

See [LICENSE](LICENSE) if present, or contact the maintainers.
