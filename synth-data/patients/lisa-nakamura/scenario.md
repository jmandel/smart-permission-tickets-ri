# Scenario: Lisa Nakamura — Provider Consult / Multi-Specialist (UC7)

## Character
36-year-old Japanese-American woman, architectural project manager. Lives in Denver, CO with her husband Ryan Cooper (age 38, high school English teacher). They have been trying to conceive for 2 years. Insurance: employer plan (UnitedHealthcare). Lisa is otherwise healthy — exercises regularly (yoga, hiking), non-smoker, occasional social drinker (stopped when trying to conceive).

## Clinical Scenario
Lisa has experienced three early pregnancy losses over 18 months:
- **Loss 1** (June 2024): Spontaneous abortion at 6 weeks, managed expectantly. Her OB/GYN attributed it to the statistical norm (15-20% of recognized pregnancies end in miscarriage) and recommended trying again.
- **Loss 2** (November 2024): Spontaneous abortion at 7 weeks. Her OB/GYN initiated a basic recurrent pregnancy loss (RPL) workup: karyotyping of both partners (normal), TSH (normal), HbA1c (normal), and basic coagulation panel (normal).
- **Loss 3** (March 2025): Spontaneous abortion at 8 weeks, following a pregnancy that initially showed a heartbeat on 6-week ultrasound but had absent cardiac activity on 8-week follow-up. Products of conception sent for genetic testing — normal female karyotype (46,XX), ruling out embryonic chromosomal abnormality.

After the third loss, her OB/GYN suspects antiphospholipid syndrome (APS) based on the pattern of recurrent early losses with a chromosomally normal conceptus. She orders anticardiolipin antibodies, lupus anticoagulant, and anti-beta-2 glycoprotein I antibodies. Anticardiolipin IgG is elevated (48 GPL, positive >40) and lupus anticoagulant is weakly positive. These need to be confirmed on repeat testing 12 weeks apart per revised Sapporo criteria.

Her OB/GYN refers Lisa to:
1. **Maternal-fetal medicine (MFM)** for high-risk pregnancy planning and management
2. **Hematology** for APS evaluation and anticoagulation planning for future pregnancies

Both specialists need access to Lisa's complete OB/GYN records — the pregnancy loss history, prior workup results, and APS lab results — to provide consultation.

## Sites
- **Rocky Mountain Women's Health** — OB/GYN in Denver, CO (2022–present). Routine GYN care, pregnancy management, RPL workup, APS screening.
- **Colorado Maternal-Fetal Medicine** — MFM specialist in Denver, CO (2025–present). High-risk pregnancy consultation, APS management planning.
- **UC Health Hematology** — Hematologist in Aurora, CO (2025–present). APS diagnostic confirmation, anticoagulation strategy.

Three sites, one state (CO). Tests Permission Ticket constraints on **scopes** (specialists need OB/GYN-specific data: Condition, Observation [labs, ultrasound findings], DiagnosticReport, Procedure [prior pregnancy management]) and **organizations** (OB/GYN → MFM + hematology referral chain).

## Key Features for Permission Tickets Demo
- UC7 provider-to-provider consult — demonstrates multi-specialist referral chain
- Subject resolution by reference (Lisa is known to the OB/GYN)
- Requester is Practitioner (MFM specialist or hematologist, each with NPI)
- Details include reason (recurrent pregnancy loss — SNOMED), request (ServiceRequest reference)
- TWO separate consult tickets: one for MFM, one for hematology — shows the same use case type used for different specialists
- Reproductive health data has inherent sensitivity — demonstrates security label considerations
- The diagnostic journey (3 losses → workup → suspected APS → multi-specialty evaluation) is compelling and realistic
- Lab values evolve over time: the confirmatory APS testing requires 12-week repeat, creating a temporal arc

## Encounter Guidance
~10-14 encounters total:
- OB/GYN: 6-8 visits (annual GYN, initial pregnancy confirmation ×3, loss management ×3, RPL workup, APS screening, specialist referrals)
- MFM: 2-3 visits (initial consult, pregnancy planning discussion, follow-up)
- Hematology: 2-3 visits (initial consult, confirmatory APS testing at 12 weeks, anticoagulation planning)
