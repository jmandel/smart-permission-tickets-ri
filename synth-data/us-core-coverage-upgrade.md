# US Core Coverage Upgrade Plan

Audit of pipeline prompt coverage against US Core STU 6.1 profiles, with recommendations for what to add.

## Current Coverage (13 resource types)

These are fully supported — prompts guide generation, agents produce them, step 06 validates them:

| Resource Type | Code System | Notes |
|---|---|---|
| Patient | — | US Core race/ethnicity/birthsex extensions, address, telecom |
| Practitioner | — | NPI, name, qualification |
| Organization | — | NPI, name, address, type |
| Location | v3-RoleCode | Type, address, managing org |
| Encounter | SNOMED (type), v3-ActCode (class) | AMB/EMER/IMP/VR, period, participants, service provider |
| Observation | LOINC | Vitals (BP component pattern), labs, screening (PHQ-2) |
| DiagnosticReport | LOINC (code), v2-0074 (category) | report-with-results, summary-only, ordered-not-resulted |
| Condition | SNOMED | Clinical/verification status, onset/abatement, problem-list-item |
| MedicationRequest | RxNorm | Dose, sig, status, intent, reason reference |
| Immunization | CVX | Vaccine code, route, performer roles |
| AllergyIntolerance | RxNorm/SNOMED | Substance, reaction, severity, criticality |
| DocumentReference | LOINC (type) | Clinical notes as base64 text/plain, US Core category |
| ServiceRequest | SNOMED | Referrals, SDOH category, reasonReference to screening |

## Gap Analysis

### HIGH priority — Procedure

**The gap:** Elena has obstetric procedures (vaginal deliveries, transvaginal ultrasound), Robert has TB-related procedures (sputum collection, chest X-ray), but none are modeled as Procedure resources. Real EHR exports always include them.

**US Core requires:** status, code (SNOMED/CPT), subject, performed[x]. Must-support: category, bodySite, reasonReference, performer.

**Demo value:** A Permission Ticket scoped to exclude `Procedure` would hide delivery history, imaging orders, and injection administration — meaningful privacy boundaries.

**What to do:**
- Add `### Procedures` to `prompts/inventory.md` — procedure name, date, body site, reason, action semantics
- Add `procedures` array to `prompts/inventory-json.md` — name, date, body_site, reason, action
- Add Procedure coding guidance to `prompts/fhir-generation.md` — SNOMED for code, status lifecycle, performer/bodySite
- No code changes needed

### MEDIUM priority — CarePlan

**The gap:** Elena has documented care plans in notes (RA management: methotrexate escalation → adalimumab → potential taper; GDM: dietary plan + glucose monitoring) but no CarePlan resources.

**US Core requires:** status, intent, category, subject. Must-support: activity array with detail.code and goal references.

**Demo value:** A ticket for `CarePlan + Observation` without `MedicationRequest` lets someone see the management strategy and lab trends without seeing specific medications — a realistic care coordination permission.

**What to do:**
- Add `### CarePlan` to inventory prompts — status, intent, activity descriptions, linked conditions
- Add coding guidance to fhir-generation prompt — US Core category codes, activity.detail.code (SNOMED)
- Medium effort — the nested activity array structure needs clear examples

### MEDIUM priority — CareTeam

**The gap:** Elena's rheumatology team (Dr. Tran + Priya Kapoor RN) and OB team (Dr. Villanueva + Amara Johnson CNM + RD Castillo) exist in the narrative but not as CareTeam resources.

**US Core requires:** status, subject, member array with role/period. Must-support: member.role (SNOMED or practice setting codes).

**Demo value:** Shows which providers are part of the patient's active care team. A Permission Ticket could filter by care team membership.

**What to do:**
- Could be generated in scaffold pass (like Patient/Org/Practitioner) rather than per-encounter
- Add to scaffold prompt with member roles and periods
- Low effort — simple structure

### LOW priority — Goal

**The gap:** Elena has implicit goals in notes (DAS28-CRP < 3.2, A1c normalization postpartum) but no Goal resources.

**US Core requires:** lifecycleStatus, description, subject. Must-support: target (e.g., target A1c < 6.5%), addresses (Condition reference).

**Demo value:** Minimal for Permission Tickets — goals are rarely filtered independently.

**What to do:** Add to inventory/generation prompts if implementing CarePlan (goals are typically CarePlan.activity.detail.goal references).

### LOW priority — Coverage

**The gap:** Elena's biography mentions "Blue Shield of California PPO" and "previously United Healthcare" but no Coverage resources.

**US Core does not mandate Coverage**, but it's a common resource in real exports.

**Demo value:** Minimal for Permission Tickets unless demonstrating insurance-based access restrictions.

**What to do:** Could add to scaffold generation with payor Organization reference, plan name, coverage period.

### LOW priority — PractitionerRole

**The gap:** Pipeline generates Practitioner but not PractitionerRole. US Core profiles both. PractitionerRole links a Practitioner to an Organization with a role/specialty.

**Demo value:** Minimal — our Encounter.participant already captures the practitioner-encounter relationship.

**What to do:** Could add to scaffold pass alongside Practitioner.

### NOT NEEDED for current use cases

| Resource Type | Why skip |
|---|---|
| Medication | MedicationRequest.medicationCodeableConcept is sufficient (inline coding) |
| MedicationDispense | Pharmacy workflow — not relevant to our scenarios |
| RelatedPerson | Only needed for multi-generational or caregiver scenarios |
| Specimen | Lab specimen chain-of-custody — too specialized |
| QuestionnaireResponse | Observation-based screening is simpler and sufficient |
| Device / ImplantableDevice | Only for DME or implant tracking scenarios |
| Media | Photos, waveforms — not relevant |
| Provenance | Audit trail — could add later for compliance demo |
| ImagingStudy | DiagnosticReport with summary-only is sufficient for imaging |

## Recommended Implementation Order

1. **Procedure** — high value, prompt-only changes, fills the biggest gap
2. **CareTeam** — low effort, adds realism, scaffold-level addition
3. **CarePlan** — medium effort, meaningful for chronic disease scenarios
4. **Goal** — low effort if CarePlan is already done
5. **Coverage** — low effort, adds insurance dimension
6. **PractitionerRole** — low effort, scaffold-level addition

Items 1-2 could be done in an afternoon. Items 3-6 are stretch goals.
