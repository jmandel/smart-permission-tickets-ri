# Scenario: Harold Washington — Authorized Representative / Elderly (UC2)

## Character
79-year-old African American retired postal worker. Widowed in 2024 when his wife Dorothy passed from pancreatic cancer. Previously lived independently in Jacksonville, FL. Now lives with his adult daughter Margaret Washington-Clarke (age 52) in Decatur, GA (metro Atlanta), who holds his healthcare power of attorney.

## Clinical Scenario
Harold was diagnosed with early-stage Alzheimer's disease in 2022 by his neurologist in Jacksonville. He was managing reasonably well with his wife's support — on donepezil, with PCP visits for hypertension, hyperlipidemia, and type 2 diabetes (well controlled). After Dorothy's death in mid-2024, Harold's cognitive decline accelerated. He had a fall at home, forgot medications, and got lost driving to the grocery store. Margaret moved him to Georgia in late 2024.

In Georgia, Harold established with a new PCP and a geriatric neurologist at Emory. His MMSE dropped from 22/30 (mild) to 17/30 (moderate) over 6 months. He was switched from donepezil to a donepezil-memantine combination. His diabetes and hypertension management continued with his new PCP. He had one ED visit for a mechanical fall (no fracture, CT head negative).

Margaret, as his authorized representative, uses a patient-facing app to access Harold's records across both the Florida and Georgia systems.

## Sites
- **Riverside Internal Medicine** — PCP in Jacksonville, FL (2015–2024). Managed hypertension, diabetes, hyperlipidemia, annual wellness.
- **First Coast Neurology Associates** — Neurologist in Jacksonville, FL (2022–2024). Alzheimer's diagnosis, initial donepezil management, cognitive assessments.
- **DeKalb Primary Care** — New PCP in Decatur, GA (2024–present). Continued chronic disease management post-move.
- **Emory Cognitive Neurology Center** — Geriatric neurologist in Atlanta, GA (2025–present). Alzheimer's progression monitoring, medication changes.

Four sites across two states (FL, GA). Tests Permission Ticket constraints on **jurisdictions** (FL vs GA), **organizations** (4 providers), **periods** (pre-move Florida records vs post-move Georgia records), and **scopes** (can filter to just cognitive assessments or just diabetes management).

## Key Features for Permission Tickets Demo
- UC2 authorized representative: daughter Margaret accesses records on father's behalf
- Subject resolution by identifier (MPI ID — Harold is registered across systems)
- Requester is RelatedPerson (daughter, relationship code "DAU")
- Details include basis (court-appointed/patient-designated), verifiedAt timestamp
- Cross-state data (FL → GA move) exercises jurisdiction filtering
- Mix of cognitive decline data (sensitive) and routine chronic disease data
- Good contrast: broad scopes for daughter's full access vs narrow scopes if a payer or researcher were asking

## Encounter Guidance
~12-16 encounters total across 4 sites:
- Florida PCP: 3-4 visits (annual wellness, chronic disease management)
- Florida neurologist: 3-4 visits (diagnosis workup, initial treatment, monitoring)
- Georgia PCP: 2-3 visits (establishment, chronic disease followup)
- Georgia neurologist: 2-3 visits (new evaluation, medication adjustment)
- 1 ED visit in Georgia (fall)
