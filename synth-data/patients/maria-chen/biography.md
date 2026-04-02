# Maria Chen — Synthetic Patient Biography

## Patient Overview

**Name:** Maria Yee-Ling Chen
**Age:** 42 (DOB: 1983-09-14)
**Gender:** Female
**Race/Ethnicity:** Chinese American (Asian — Chinese)
**Preferred Language:** English (fluent); speaks Cantonese at home with her children and mother
**Marital Status:** Single (never married)
**Home Address:** Outer SE Portland, Oregon (ZIP 97266)
**Insurance:** Medicaid — Oregon Health Plan (OHP Plus)
**Employment:** Part-time home health aide, ~25 hours/week, employed by Comfort Keepers Home Care
**Household:** Single mother of two children — Ethan (age 11) and Lily (age 8). Lives in a two-bedroom apartment. Relies on TriMet public transit; does not own a car.

---

## Clinical Arc

Maria has been generally healthy throughout her adult life. She was diagnosed with mild intermittent asthma in her mid-twenties, around 2008, after a string of upper respiratory infections one winter led to persistent wheezing that her then-PCP worked up with spirometry. The asthma has remained well controlled — she uses a PRN albuterol inhaler (albuterol sulfate 90 mcg/actuation HFA, 2 puffs as needed) and rarely needs it more than once or twice a month, mostly in cold weather or around dust exposure during her home health aide work. She has never required an oral corticosteroid burst or emergency department visit for asthma. Her most recent asthma assessment scores it as well-controlled (ACT score 22).

She has no other significant chronic conditions. Her BMI has been in the overweight range (27–28) for the past several years but is stable. Her blood pressure runs normal (typically 118–122/74–78). She is up to date on routine preventive care: Pap smear (2024, normal), mammogram (not yet due per USPSTF guidelines at age 42, though her PCP has discussed timing), and standard adult immunizations including annual influenza, a Tdap booster in 2021, and a completed COVID-19 primary series plus one bivalent booster.

Maria's medication list is short: just the PRN albuterol inhaler. She takes no daily medications. She has a documented allergy to sulfonamide antibiotics (rash, documented in 2012 when she was prescribed Bactrim for a UTI). No other known drug, food, or environmental allergies beyond the mild seasonal component of her asthma.

Her immunization history includes: influenza vaccine annually (most recent October 2025), Tdap (2021), Hepatitis B series (completed in childhood), MMR (childhood), Varicella (childhood), COVID-19 primary series (Pfizer, 2021) plus bivalent booster (2023).

### The Annual Visit and SDOH Screening (March 2026)

In March 2026, Maria comes in for her annual wellness visit at Cascade Community Health Center, the FQHC where she has been a patient since 2019. During intake, the medical assistant administers the AHC HRSN (Accountable Health Communities Health-Related Social Needs) screening questionnaire as part of the clinic's standard workflow for all adult patients.

Maria's responses flag two domains:

- **Food insecurity:** To the question "Within the past 12 months, you worried that your food would run out before you got money to buy more," Maria answers "Often true." To "Within the past 12 months, the food you bought just didn't last and you didn't have money to get more," she answers "Sometimes true."
- **Transportation barriers:** To "In the past 12 months, has lack of reliable transportation kept you from medical appointments, meetings, work, or from getting things needed for daily living?" Maria answers "Yes" and indicates it has affected medical appointments specifically.

The screening also covers housing instability, utility needs, and interpersonal safety — Maria screens negative on all of these. She reports her housing is stable (she has been in the same apartment for three years) and feels safe at home.

Her PCP, Dr. Angela Morales, conducts the annual wellness exam. Vitals are unremarkable: BP 120/76, HR 72, weight 154 lbs (BMI 27.2), SpO2 98%, temperature 98.4°F, respirations 16. Dr. Morales reviews Maria's asthma — well controlled, no changes needed. She reviews preventive care (flu shot is current, due for next one in fall 2026). A PHQ-2 depression screen is administered and scores 1 (negative, below the threshold of 3). Routine labs are ordered: CBC, CMP, lipid panel, and HbA1c (given BMI and family history of diabetes in her mother). Lab results, returned two days later, are all within normal limits: fasting glucose 94, HbA1c 5.4%, total cholesterol 198, LDL 118, HDL 52, triglycerides 140, CBC unremarkable.

Dr. Morales then discusses the SDOH screening results with Maria. Maria explains that money gets tight toward the end of the month — her part-time wages cover rent and utilities but food is a stretch, especially feeding two growing kids. She has not applied for SNAP because she wasn't sure she qualified and the application process felt overwhelming. She also mentions missing a dental appointment for Lily last month because the bus route change made it a two-hour trip each way.

Maria is receptive to help. Dr. Morales creates a referral to **Rose City Community Services**, a community-based organization the clinic partners with for social care navigation. The referral is structured as a closed-loop social care referral: a FHIR ServiceRequest is created referencing the SDOH screening Observations, and a corresponding Task resource is created to track the referral lifecycle.

### CBO Engagement (March–April 2026)

Rose City Community Services receives the electronic referral. A case worker, Janet Flores, contacts Maria by phone within three business days. During the intake call (late March 2026), Janet reviews Maria's needs, confirms the food insecurity and transportation concerns, and outlines the services available: food pantry enrollment at their SE Portland distribution site (weekly pickup), hands-on SNAP application assistance, and TriMet transit vouchers for medical appointments.

Over the next two to three weeks, Janet works with Maria on the following:

- **Food pantry enrollment:** Maria is enrolled and begins weekly food pickups at the Rose City pantry site starting in early April 2026.
- **SNAP application:** Janet helps Maria complete and submit her SNAP application online. Maria is approved in mid-April with a monthly benefit of $430 for a household of three.
- **Transit vouchers:** Maria receives a set of TriMet HOP card vouchers for medical appointments.

Janet updates the Task resource at each milestone: accepted → in-progress → completed. The Task is marked completed in late April 2026 once SNAP benefits are confirmed and food pantry enrollment is active.

### Follow-Up at Cascade Community Health Center (April 2026)

About a week after the referral was made, a care coordinator at Cascade Community Health Center, Priya Nair (RN), calls Maria by telephone to check on the referral status. Maria confirms Janet from Rose City has already contacted her and they are working on the SNAP application. This is documented as a telephone encounter.

In late April or early May 2026, Maria has a brief follow-up visit (or secure portal message exchange) at Cascade where the closed loop is confirmed: SNAP approved, food pantry active, transit vouchers received. Dr. Morales documents the social care outcomes in a brief progress note.

---

## Provider Map

### Site 1: Cascade Community Health Center

- **Full Name:** Cascade Community Health Center
- **Type:** Federally Qualified Health Center (FQHC) — Primary Care
- **Address:** 8205 SE Foster Road, Portland, OR 97206
- **NPI:** 1346782901
- **Active Period:** January 2019 – present (ongoing)
- **Role in Care:** Maria's primary care medical home. Provides annual wellness visits, acute care, preventive services, asthma management, SDOH screening, lab ordering, immunizations, and social care referral creation. This is the originating site for the closed-loop referral.
- **Key Clinicians:**
  - **Dr. Angela Morales, MD** — Primary care physician, family medicine. Maria's PCP since 2019.
  - **Priya Nair, RN** — Care coordinator who handles referral follow-up and telephone outreach.
  - **David Kim, MA** — Medical assistant who administers intake screenings (vitals, PHQ-2, AHC HRSN).
- **Encounter Volume:** Approximately 4–5 encounters per year since 2019 (annual wellness visit, occasional sick visits for URI or asthma flare, telephone follow-ups). Total estimated encounters: ~28–30 over the 2019–2026 period.
- **Encounter Types for Demo Period (2025–2026):** 1 annual wellness visit (in-person, March 2026), 1 telephone encounter (care coordination follow-up, April 2026), 1 brief follow-up visit or portal message (late April 2026). Prior years include ~3–4 encounters/year (mix of office visits, telephone, and lab-only encounters).
- **Resource Volume:** ~400–500 FHIR resources total across the relationship. For the demo-relevant period (the 2026 annual visit and follow-ups), key resources include:
  - **Encounter** (×3 in demo window)
  - **Observation — Vitals** (BP, HR, weight, BMI, SpO2, temperature, respirations — ~7 per office visit)
  - **Observation — Screening** (PHQ-2 score, AHC HRSN responses — ~8–10 screening observations from the annual visit)
  - **Observation — Labs** (CBC, CMP, lipid panel, HbA1c — ~15–20 lab result observations)
  - **Condition** (mild intermittent asthma, overweight — 2 active conditions)
  - **MedicationRequest** (albuterol PRN — 1 active medication)
  - **AllergyIntolerance** (sulfonamide allergy — 1 entry)
  - **Immunization** (influenza 2025, historical records)
  - **ServiceRequest** (the SDOH referral to Rose City Community Services)
  - **Task** (referral tracking task, created at Cascade, updated by both sites)
  - **DocumentReference** (progress notes for each office visit)
  - **DiagnosticReport** (lab report bundles)
  - **Patient** (demographics)
  - **Procedure** (screening administration)

### Site 2: Rose City Community Services

- **Full Name:** Rose City Community Services
- **Type:** Community-Based Organization (CBO) — Social Care Navigation
- **Address:** 6530 SE 82nd Avenue, Portland, OR 97266
- **NPI:** 1578234610
- **Active Period:** March 2026 – April 2026 (engagement tied to the referral lifecycle; could reopen if new needs arise)
- **Role in Care:** Receives closed-loop social care referrals from partner clinics. Provides food pantry access, SNAP application assistance, and transit vouchers. This site does NOT provide clinical care. Its data footprint is limited to referral-related resources: the ServiceRequest it receives, the Task it updates, and the SDOH screening Observations it needs to understand the referral context.
- **Key Personnel:**
  - **Janet Flores** — Community health worker / case worker. Primary contact for Maria's referral.
  - **Robert Tran** — Program coordinator, oversees referral intake and CBO-side Task management.
- **Encounter Volume:** 2–3 encounters total: 1 intake phone call, 1–2 service delivery / follow-up contacts.
- **Encounter Types:** Telephone intake, in-person or telephone service delivery confirmation.
- **Resource Volume:** Very small — ~10–15 FHIR resources:
  - **Task** (the referral tracking task — this is the primary resource the CBO interacts with; they update status from accepted → in-progress → completed, and add output references as milestones are met)
  - **ServiceRequest** (read access to the originating referral)
  - **Observation** (read access to the SDOH screening observations referenced by the ServiceRequest — the AHC HRSN food insecurity and transportation responses only)
  - **Encounter** (2–3 CBO encounters documenting case worker contacts)
  - **Patient** (basic demographics for care coordination)
  - The CBO does **not** hold or need access to: Conditions, MedicationRequests, AllergyIntolerances, lab Observations, Immunizations, DiagnosticReports, DocumentReferences (progress notes), or any other clinical data from Cascade.

---

## Demo Relevance

Maria Chen's scenario is purpose-built to demonstrate **Use Case 4: Social Care Referral** in the SMART Permission Tickets reference implementation. It exercises the following access constraint dimensions:

### 1. Scopes (Resource Type Filtering) — PRIMARY DIMENSION

This is the headline constraint this patient tests. The closed-loop referral pattern creates a clear, narrow set of resources that the CBO needs:

- **CBO Permission Ticket grants access to:** `ServiceRequest`, `Task`, `Observation` (SDOH screening only), `Patient` (demographics), `Encounter` (CBO encounters).
- **CBO Permission Ticket EXCLUDES:** `Condition`, `MedicationRequest`, `AllergyIntolerance`, `Immunization`, `DiagnosticReport`, `DocumentReference`, `Procedure`, and clinical `Observation` resources (vitals, labs, PHQ-2).

This is a powerful demo because Cascade's data for Maria includes a rich set of clinical resources (asthma condition, albuterol prescription, sulfonamide allergy, lab results, vitals, progress notes) that are clearly *present* in the system but must be *invisible* to the CBO's scoped access. The contrast between what exists and what the CBO can see makes the scope filtering tangible and visible.

The Permission Ticket can further constrain Observation access by category (SDOH vs. vital-signs vs. laboratory) to ensure the CBO sees only the AHC HRSN screening responses and not Maria's blood pressure, weight, or lab values.

### 2. Organizations (Cross-Organization Access)

Two organizations are involved — Cascade Community Health Center (the referring FQHC) and Rose City Community Services (the receiving CBO). The Permission Ticket mediates what the CBO can access from the health center's data. This tests:

- A clinical organization sharing a constrained data slice with a non-clinical organization
- Task resources being collaboratively updated by both organizations
- The CBO accessing ServiceRequest and Observation resources it did not create

### 3. Periods (Temporal Constraints)

The referral engagement has a well-defined time window: March 2026 through April 2026. A Permission Ticket could include a temporal constraint limiting CBO access to resources from this period only, preventing access to Maria's historical clinical data from prior years (2019–2025) even if scope filters were somehow broadened.

### 4. Jurisdictions

Both sites are in Portland, Oregon — a single-state, single-city scenario. This keeps jurisdictional complexity minimal for UC4, which is primarily a scopes-focused use case. However, it does confirm that same-jurisdiction access works correctly and that the Permission Ticket infrastructure handles the common case of intra-state referrals.

### What Makes This Patient Distinctive for the Demo

- **Small, focused data footprint at the CBO** (~10–15 resources) against a **moderate clinical footprint at the health center** (~400–500 resources) — makes scope filtering highly visible.
- **Non-clinical data holder** (CBO) accessing clinical-origin data — tests that Permission Tickets work for organizations outside the traditional clinical trust framework.
- **Closed-loop referral lifecycle** (ServiceRequest → Task → Task updates → completion) — demonstrates that Permission Tickets can support collaborative workflows, not just read-only access.
- **SDOH screening as the shared data type** — Observation resources that are clinically generated but socially relevant, testing category-level filtering within a resource type.
- **Realistic social determinants** (food insecurity, transportation barriers) grounded in standard screening tools (AHC HRSN) — ensures the generated FHIR data uses proper SDOH value sets and codes.
