# Scenario: James Thornton — Payer Claims Adjudication (UC5)

## Character
47-year-old white male, construction foreman. Lives in Omaha, NE with his wife and two teenage sons. Employer-sponsored insurance through Blue Cross Blue Shield of Nebraska. Generally healthy, non-smoker, occasional weekend beer. No significant past medical history beyond a childhood tonsillectomy and a rotator cuff strain 5 years ago (managed conservatively).

## Clinical Scenario
In January 2026, James develops acute right lower quadrant abdominal pain at a job site. He presents to the ED at Nebraska Medicine where imaging reveals perforated appendicitis with a small abscess. He undergoes emergent laparoscopic appendectomy with drain placement. Pathology confirms acute gangrenous appendicitis with perforation. He is discharged on hospital day 3 with oral antibiotics (amoxicillin-clavulanate) and a follow-up appointment.

Ten days post-discharge, James presents to his surgeon's clinic with increasing redness, warmth, and purulent drainage from a port site. He is diagnosed with a surgical site infection (SSI). Due to fever (101.8°F) and concern for deeper infection, he is readmitted for IV antibiotics (piperacillin-tazobactam), wound culture, and CT abdomen to rule out intra-abdominal abscess. CT shows a small residual collection that resolves with antibiotics. He is discharged after 4 days on oral ciprofloxacin + metronidazole.

His payer, BCBS of Nebraska, issues a Permission Ticket to access the surgical documentation, operative report, pathology report, and readmission records for claims adjudication review.

## Sites
- **Nebraska Medicine — Emergency Department & Surgical Services** — Academic medical center in Omaha, NE. ED presentation, appendectomy, initial hospitalization, readmission for SSI.
- **Heartland Surgical Associates** — Surgeon's outpatient office in Omaha, NE. Post-op follow-up where SSI was detected, and final post-readmission follow-up.

Two sites, one state (NE). Focused time window (January–February 2026). Tests Permission Ticket constraints on **scopes** (payer needs DocumentReference, Procedure, DiagnosticReport, Condition — not the full chart) and **periods** (just the surgical episode).

## Key Features for Permission Tickets Demo
- UC5 payer claims adjudication: BCBS needs clinical documentation for claim review
- Subject resolution by reference (James is already known to the data holder)
- Requester is Organization (payer with NPI)
- Details include service (appendectomy — SNOMED), claim identifier
- Narrow time window: just the January–February 2026 surgical episode
- Surgical documentation: operative report, pathology report, discharge summary, readmission records
- Complication (SSI + readmission) makes the claim review more interesting — payer needs to verify medical necessity of readmission
- Relatively small data footprint — focused clinical episode, not years of chronic disease

## Encounter Guidance
~5-7 encounters total:
- ED visit + emergency appendectomy (combined or separate encounters)
- Inpatient stay (3 days)
- Surgeon follow-up (post-op day 10, SSI detected)
- Readmission for SSI (4 days IV antibiotics)
- Final surgeon follow-up (post-readmission, wound healed)
