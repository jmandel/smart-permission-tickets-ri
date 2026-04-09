# Elena Reyes — Cross-State Rheumatology Patient (UC1)

## Character
Mid-30s Latina woman. Lived in Austin, TX through 2022, then moved to Oakland, CA. Married, two young children. Works in software. Generally healthy prior to 2023, with a sensitive reproductive history she may prefer to keep private when sharing records for other purposes.

## Clinical Scenario
Elena was diagnosed with seropositive rheumatoid arthritis in early 2023 after presenting with bilateral hand and wrist pain and morning stiffness lasting over an hour. PCP labs showed elevated RF, anti-CCP, ESR, and CRP. She was referred to rheumatology, started on methotrexate 15 mg weekly plus folic acid, with regular CBC and LFT monitoring. Partial response to methotrexate led to the addition of adalimumab (Humira) in late 2023, with good disease control by 2024 and ongoing quarterly rheumatology visits and lab monitoring.

Her Texas-era records include a separate reproductive history managed by an OB/GYN practice in Austin: first pregnancy (2019, uncomplicated vaginal delivery), spontaneous abortion at approximately 10 weeks (early 2020, managed expectantly), and a second successful pregnancy (2021, mild gestational diabetes, diet-controlled, resolved postpartum). She also saw a PCP in Austin for routine wellness and immunizations. The miscarriage in particular is sensitive data she may want excluded when sharing rheumatology records.

Her California-era care additionally includes routine PCP wellness, flu shots, a COVID booster, and one urgent-care visit for an ankle sprain in 2024.

## Sites
- **Lone Star Women's Health** — Austin, TX. OB/GYN practice. Pregnancies, miscarriage, gestational diabetes. Sensitive reproductive history.
- **Central Austin Family Medicine** — Austin, TX. PCP for routine wellness, immunizations, minor acute care through 2022.
- **Eastbay Primary Care Associates** — Oakland, CA. New PCP from late 2022. Initial RA workup and ongoing primary care.
- **Bay Area Rheumatology Associates** — Oakland, CA. Rheumatology care for seropositive RA, methotrexate + adalimumab management, quarterly follow-up.
- **Bay Area Urgent Care (Telegraph Ave)** — Oakland, CA. One-off urgent-care visit for an ankle sprain in 2024.

Five sites across two states (TX, CA). This tests Permission Ticket constraints on **jurisdiction** (TX vs CA), **scope** (RA care vs reproductive history), **period** (2023-present vs earlier Texas era), and **organization** (four distinct providers across the two states).

## Key Features for Permission Tickets Demo
- Cross-state clinical history with a clean legal and organizational boundary between TX and CA
- Sensitive reproductive data (miscarriage, gestational diabetes) that the patient may want filtered out
- Two disease tracks running on different timelines: reproductive (2019–2021) and rheumatologic (2023–present)
- Biologic DMARD therapy (methotrexate + adalimumab) with regular lab monitoring for filtering exercises
- Four distinct organizations across two states — exercises organization and jurisdiction filters simultaneously

## Constraint Exercise Goals
- Jurisdiction filtering (TX vs CA) cleanly separates reproductive from rheumatologic data
- Scope filtering (patient/Condition.rs + patient/Observation.rs + patient/MedicationRequest.rs) returns RA management without pregnancy history
- Period filtering (2023-present) excludes the entire Texas period
- Organization filtering across four distinct providers across two states
- The reproductive data exists and is valid FHIR — it just gets filtered out by the ticket constraints, demonstrating that the filtering is real
