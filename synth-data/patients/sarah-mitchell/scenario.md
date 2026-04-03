# Scenario: Sarah Mitchell — Patient Access / Behavioral Health (UC1)

## Character
32-year-old white woman, freelance graphic designer. Previously lived in Portland, OR; moved to Seattle, WA in 2024 for a fresh start after completing an outpatient alcohol treatment program. Single, no children. Has a cat. Insurance: individual marketplace plan (Premera Blue Cross).

## Clinical Scenario
Sarah was diagnosed with bipolar II disorder at age 25 (2019) after a period of depressive episodes alternating with hypomanic phases (increased productivity, decreased sleep, impulsive spending). She was initially misdiagnosed with major depressive disorder and started on an SSRI (sertraline) which triggered a hypomanic episode, leading to the correct bipolar II diagnosis. She was stabilized on lamotrigine 200mg and later added quetiapine 50mg for sleep.

In 2022, during a depressive episode and work stress, Sarah developed problematic alcohol use that escalated to alcohol use disorder (moderate severity). She self-referred to an outpatient addiction medicine program in Portland in early 2023. She completed a 12-week intensive outpatient program (IOP), began attending AA meetings, and was prescribed naltrexone 50mg daily. She achieved sobriety in April 2023 and has maintained it.

In mid-2024, Sarah moved to Seattle. She established with a new psychiatrist for bipolar management and a new PCP for general care. Her alcohol use disorder is in sustained remission (>12 months). She continues lamotrigine, quetiapine, and naltrexone.

Sarah uses a patient-facing app to access her health records across her Portland and Seattle providers. The behavioral health and substance use disorder data is subject to heightened sensitivity protections (42 CFR Part 2 for SUD records).

## Sites
- **Hawthorne Health Center** — PCP in Portland, OR (2019–2024). General primary care, initial depression treatment, referral to psychiatry.
- **Portland Behavioral Health Associates** — Psychiatrist in Portland, OR (2019–2024). Bipolar II diagnosis, mood stabilizer management.
- **Bridgetown Recovery Center** — Addiction medicine / IOP program in Portland, OR (2023–2024). Alcohol use disorder treatment, naltrexone initiation.
- **Ballard Family Medicine** — New PCP in Seattle, WA (2024–present). Continued chronic disease management, medication refills.
- **Puget Sound Psychiatry** — New psychiatrist in Seattle, WA (2024–present). Continued bipolar management, medication monitoring.

Five sites across two states (OR, WA). Tests Permission Ticket constraints on **jurisdictions** (OR vs WA), **organizations** (5 providers), **periods** (pre-move Oregon records vs post-move Seattle records), and **scopes** (can filter to just mood disorder data vs SUD data vs general medical).

## Key Features for Permission Tickets Demo
- UC1 patient access: Sarah accesses her own records across multiple providers
- Subject resolution by match (demographics: name, DOB, identifiers)
- Key binding (cnf) required for patient access
- **Security labels are the star feature**: SUD treatment records (Bridgetown Recovery) carry 42 CFR Part 2 sensitivity labels, and bipolar/psychiatric records carry mental health sensitivity labels. This demonstrates how Permission Tickets interact with data segmentation.
- Cross-state move (OR→WA) exercises jurisdiction filtering
- The distinction between general medical data (PCP), mental health data (psychiatrist), and SUD data (addiction medicine) makes scope and sensitivity filtering very tangible
- Medication list spans sensitivity categories: lamotrigine/quetiapine (mental health), naltrexone (SUD), and general meds

## Encounter Guidance
~12-16 encounters total across 5 sites:
- Portland PCP: 2-3 visits (annual wellness, initial depression eval, routine care)
- Portland psychiatrist: 3-4 visits (initial eval, medication adjustments, stable follow-ups)
- Portland addiction medicine: 2-3 encounters (IOP intake, treatment completion, aftercare)
- Seattle PCP: 2-3 visits (new patient establishment, routine follow-ups)
- Seattle psychiatrist: 2-3 visits (new patient eval, stable management)
