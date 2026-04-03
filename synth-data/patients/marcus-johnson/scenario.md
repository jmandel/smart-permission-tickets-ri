# Scenario: Marcus Johnson — Public Health Investigation / Measles (UC3)

## Character
21-year-old African American male, junior at University of Wisconsin-Madison studying computer science. Lives in a dorm on campus. Generally healthy, no chronic conditions. Immunization history: received MMR at 12 months but did NOT receive the recommended second dose at 4-6 years (parents were vaccine-hesitant during that period, though they later resumed standard vaccinations). Insurance: parent's employer plan (Anthem).

## Clinical Scenario
In March 2026, Marcus returns from a spring break trip to the Philippines (visiting a friend's family in Manila) where a measles outbreak is ongoing. Five days after returning to campus, he develops high fever (104°F), cough, coryza, and conjunctivitis. He presents to UW Student Health Services thinking he has a bad flu. The clinician notes Koplik spots on the buccal mucosa and a maculopapular rash beginning on the face and spreading to the trunk.

Measles is suspected immediately. Marcus is isolated, and the case is reported to the Wisconsin Department of Health Services (DHS) and Public Health Madison & Dane County. Measles IgM serology and measles RNA PCR are sent — both return positive. He is confirmed as a measles case.

The public health investigation reveals that Marcus attended 3 days of classes (large lecture halls, 200+ students), ate in the dining hall, and used the campus gym during his infectious period (4 days before rash onset through 4 days after). This triggers a massive contact tracing effort and campus-wide exposure notification.

The Wisconsin DHS uses a Permission Ticket to access Marcus's clinical records from the university health center for the public health investigation.

## Sites
- **UW Health University Student Health Services** — Student health clinic in Madison, WI (2023–present). Routine visits, STI screening, the index measles visit, and follow-up.
- **Public Health Madison & Dane County / Wisconsin DHS** — Public health agency. Not a clinical site but the investigation authority that receives the case report.

One clinical site (plus the PH agency context). Tests Permission Ticket constraints on **scopes** (PH needs Condition, DiagnosticReport, Observation, Immunization, Encounter — not unrelated student health visits) and **periods** (just the exposure investigation window).

## Key Features for Permission Tickets Demo
- UC3 public health investigation: health department accesses clinical records for measles case investigation
- Subject resolution by reference (Marcus is known to UW Health)
- Requester is Organization (Wisconsin DHS, type=govt)
- Details include condition (measles — SNOMED 14189004), case identifier
- Different from Robert Davis (TB): measles is acute/explosive vs TB's slow burn
- Immunization gap is clinically relevant — demonstrates why PH needs immunization records
- Campus exposure creates urgency and scale for investigation
- Compact clinical episode (1-2 weeks) but broad public health implications
- Small data footprint: a few encounters at student health, but the clinical data is critical

## Encounter Guidance
~4-6 encounters at the student health center:
- Routine visits: 1-2 prior visits (e.g., sports physical, flu visit) for baseline
- Index visit: acute measles presentation with isolation
- Follow-up visit: post-recovery clearance, repeat labs
- Possibly a telehealth check during isolation
