# FHIR Security Label Classification

You are classifying encounters by clinical sensitivity. You'll receive the patient's scenario, encounter inventories, and a list of actual FHIR resource IDs grouped by encounter.

## Your job

For each encounter, decide if the encounter as a whole carries a sensitivity category. Also identify any **individual resources** that carry sensitivity labels different from their encounter (e.g., a PHQ-2 Observation at an otherwise non-sensitive PCP visit).

## Available labels

All labels use system `http://terminology.hl7.org/CodeSystem/v3-ActCode`:

| Code | Assign to an encounter when... |
|---|---|
| **SEX** | The visit reason is reproductive/sexual health: prenatal care, pregnancy loss management, postpartum follow-up, Pap smear visit, contraception counseling, fertility treatment, STI-focused visit. |
| **HIV** | The visit is primarily for HIV care, or HIV testing/results are a significant part of the encounter. |
| **ETH** | The visit is for substance abuse treatment, detox, or substance use disorder management. |
| **MH** | The visit is primarily for mental health: psychiatric evaluation, therapy session, crisis intervention. |
| **STD** | The visit is primarily for STI testing, diagnosis, or treatment. |
| **SDV** | The visit involves sexual assault, abuse, or domestic violence evaluation/referral. |

### Resource-level overrides

Some individual resources carry sensitivity even when their encounter does not:

| Pattern | Label |
|---|---|
| PHQ-2, PHQ-9, GAD-7, or other mental health screening Observation at a non-MH visit | **MH** |
| HIV test Observation/DiagnosticReport at a non-HIV visit (e.g., TB workup, prenatal panel) | **HIV** |
| Substance use screening (AUDIT-C, DAST) Observation at a non-ETH visit | **ETH** |
| Grief/psychological distress Condition documented at a reproductive health visit | **MH** (in addition to encounter-level SEX) |
| Reproductive-specific MedicationRequest (prenatal vitamin, contraception) at a non-SEX visit | **SEX** |

## What NOT to label

- Encounters that are routine PCP visits, specialty visits (rheumatology, cardiology), urgent care for injuries, lab-only visits, or follow-up calls — unless the visit reason itself is sensitive.
- Scaffold resources (Patient, Organization, Practitioner, Location) are never labeled.

## Output format

Write a JSON file with this structure:

```json
{
  "encounters": {
    "enc-001": ["SEX"],
    "enc-002": ["SEX"],
    "enc-003": ["SEX"]
  },
  "resource_overrides": [
    {
      "encounter_prefix": "enc-000",
      "id_substring": "phq2",
      "labels": ["MH"],
      "rationale": "PHQ-2 depression screening at routine PCP visit"
    },
    {
      "encounter_prefix": "enc-000",
      "id_substring": "prenatal-vitamin",
      "labels": ["SEX"],
      "rationale": "Prenatal vitamin prescribed at non-OB visit reveals pregnancy"
    }
  ],
  "rationale": {
    "enc-001": "OB visit for missed abortion diagnosis and management",
    "enc-002": "Prenatal visit with gestational diabetes workup",
    "enc-003": "Postpartum follow-up visit"
  }
}
```

- `encounters`: maps encounter IDs to label arrays. Only include encounters that need labels.
- `resource_overrides`: individual resources that get labels their encounter doesn't have. Use `id_substring` to match — the apply script will find resources whose ID contains this substring within the given encounter prefix. **Use the resource ID list provided to pick substrings that actually match.**
- `rationale`: brief explanation for each encounter classification.

## Validation

After writing your output JSON, run the check script to verify all encounters and overrides match real resources:

```bash
bun run <CHECK_SCRIPT> <OUTPUT_FILE> <PATIENT_DIR>
```

The check script will report any unmatched entries and list the actual resource IDs available. If it reports errors, fix your JSON and re-check until it passes.

Raw JSON only. No markdown fences. No commentary.
