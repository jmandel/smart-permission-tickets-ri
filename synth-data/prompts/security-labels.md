# FHIR Security Label Assignment

You are assigning FHIR security labels to patient resources. You'll receive the patient's scenario, encounter inventories, and a resource manifest listing every FHIR resource file with its type, ID, and primary code/description.

## Your job

Decide which resources need sensitivity labels and call the `add-label` tool for each one.

## Available labels

All labels use system `http://terminology.hl7.org/CodeSystem/v3-ActCode`:

| Code | Use for |
|---|---|
| **SEX** | Reproductive and sexual health: pregnancy, prenatal/postpartum care, pregnancy loss, contraception counseling, Pap smears, obstetric history, fertility treatment. Assign to the specific resources (Conditions, Observations, Encounters, DocumentReferences, DiagnosticReports) whose content is reproductive in nature. |
| **HIV** | HIV test results (positive OR negative), HIV diagnoses, antiretroviral medications, viral load measurements. A negative HIV screening is still HIV-labeled — the test itself is protected. |
| **ETH** | Substance abuse information protected under 42 CFR Part 2: alcohol/drug abuse diagnoses, AUDIT-C or DAST screening results, substance abuse treatment encounters, detox medications. |
| **MH** | Mental health: depression/anxiety screening instruments (PHQ-2, PHQ-9, GAD-7, Columbia), psychiatric diagnoses, psychotropic medications, mental health referrals, documented psychological distress or grief reactions. |
| **STD** | STI/STD testing, diagnoses, and treatment (chlamydia, gonorrhea, syphilis, herpes, HPV when tested for as STI). |
| **SDV** | Sexual assault, abuse, or domestic violence: IPV screening results, assault-related diagnoses or injuries, DV referrals. |

## Labeling principles

**Label the resource, not the encounter.** If a PHQ-2 Observation was recorded during an office visit, label the PHQ-2 Observation with MH — but do NOT label the Encounter itself unless the encounter's primary reason/type is mental health care.

**Label the Encounter when the visit reason is sensitive.** An OB/prenatal visit → label the Encounter with SEX. A substance abuse counseling session → label the Encounter with ETH. A routine PCP visit where a PHQ-2 happened → do NOT label the Encounter.

**Label DocumentReferences when the note content is sensitive.** A prenatal visit progress note → SEX. An ED note that happens to include an HIV test → label the HIV Observation, but the ED note only gets HIV if HIV results are a significant part of the note content.

**Include associated resources.** If a Condition is labeled SEX, also label DiagnosticReports, Observations, and MedicationRequests that directly support or document that condition at the same encounter. For example, if "missed abortion" is SEX, then the transvaginal ultrasound DiagnosticReport, the obstetric Observations (fetal heart rate, crown-rump length), and the encounter note documenting it should also be SEX.

**Don't over-label.** Routine vitals (BP, HR, weight, temp) taken during a prenatal visit are just vitals — they don't get SEX unless they are specifically obstetric measurements (fundal height, fetal heart rate). A basic CBC drawn during a prenatal visit is just a CBC — unless it was specifically ordered for obstetric indications (e.g., Rh typing, GDM workup).

**Scaffold resources are not labeled.** Patient, Organization, Practitioner, and Location resources never get sensitivity labels.

## Workflow

1. Read the scenario and inventories to understand the patient's clinical story
2. Read the resource manifest to see what files exist
3. For each resource that needs a label, run:
   ```bash
   bun run steps/add-label.ts <path-to-resource.json> <LABEL_CODE>
   ```
4. After labeling, produce a summary table of what you labeled and why

## Output

After running all add-label commands, write a summary to `security-labels-report.md` listing:
- Each labeled resource (path, resourceType, id, label code)
- Brief rationale for the label
- Any edge cases you considered but decided not to label
