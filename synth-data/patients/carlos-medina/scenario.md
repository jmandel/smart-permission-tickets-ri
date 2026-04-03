# Scenario: Carlos Medina — Payer Claims / Prior Authorization (UC5)

## Character
51-year-old Hispanic male, high school shop teacher and baseball coach. Lives in San Antonio, TX with his wife Rosa and youngest daughter (age 16). Born in San Antonio, lifelong Texan. Insurance: employer plan through the school district (Aetna). Active lifestyle compromised by progressive joint disease.

## Clinical Scenario
Carlos was diagnosed with seropositive rheumatoid arthritis in 2021 after 6 months of progressive symmetric polyarthritis (hands, wrists, feet). His PCP noted elevated inflammatory markers and referred him to a rheumatologist. Initial workup showed positive RF (78 IU/mL), positive anti-CCP (>250 U/mL), elevated ESR (42) and CRP (2.8), and erosive changes on hand X-rays.

He was started on methotrexate 15mg weekly with folic acid. After 4 months of adequate dosing, his DAS28-CRP remained elevated at 4.2 (moderate disease activity). Methotrexate was increased to 20mg weekly. At 6 months on 20mg, he developed elevated liver enzymes (ALT 98, AST 82) — methotrexate was discontinued for hepatotoxicity.

He was switched to leflunomide 20mg daily. After 6 months on leflunomide, his DAS28-CRP was 4.8 (moderate-high), with worsening hand grip strength and new wrist erosions on follow-up imaging. Leflunomide was deemed an inadequate response.

His rheumatologist recommends initiating adalimumab (Humira biosimilar — Hadlima) as step-up biologic therapy. The prior authorization requires documentation of: RA diagnosis, failed conventional DMARDs (methotrexate — hepatotoxicity; leflunomide — inadequate response), disease activity scores, functional status, and imaging showing progression.

Aetna uses a Permission Ticket to access Carlos's rheumatology and PCP records to adjudicate the prior authorization request.

## Sites
- **Alamo Family Practice** — PCP in San Antonio, TX (2015–present). General primary care, initial joint complaint workup, referral to rheumatology, routine management.
- **South Texas Rheumatology** — Rheumatologist in San Antonio, TX (2021–present). RA diagnosis, DMARD management, disease activity monitoring, biologic prior auth documentation.

Two sites, one state (TX). Tests Permission Ticket constraints on **scopes** (payer needs Condition, Observation [disease activity scores, labs], DiagnosticReport [imaging], MedicationRequest [DMARD history], Procedure — focused on RA treatment) and **periods** (payer needs the full DMARD treatment history from 2021–present).

## Key Features for Permission Tickets Demo
- UC5 payer claims adjudication — specifically the prior authorization variant
- Subject resolution by reference (Carlos is known to the data holder)
- Requester is Organization (payer with NPI)
- Details include service (biologic therapy — SNOMED for adalimumab administration), claim identifier
- Step therapy documentation: payer needs to verify that cheaper alternatives were tried and failed before approving expensive biologic
- Disease activity scores (DAS28-CRP) are specific, quantifiable data points that the payer reviews
- Lab trends (CRP, ESR, liver enzymes) tell the story of treatment attempts and side effects
- Imaging progression (baseline vs follow-up hand X-rays) provides objective evidence
- Demonstrates a different flavor of UC5 than James Thornton: ongoing treatment authorization vs acute surgical claim

## Encounter Guidance
~8-12 encounters total:
- PCP: 3-4 visits (initial joint complaints, referral, routine care, medication monitoring)
- Rheumatologist: 5-8 visits (initial evaluation, methotrexate initiation, toxicity follow-up, leflunomide trial, disease activity assessments, imaging review, biologic discussion + prior auth)
