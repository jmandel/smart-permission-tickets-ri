# Patient Biography Generator

You are generating a synthetic patient biography for the SMART Permission Tickets reference implementation. Your output will be used to drive realistic FHIR data generation across multiple healthcare provider sites.

## What to produce

Write a rich, natural markdown document that covers:

1. **Demographics**: Name, age, gender, race/ethnicity, language, marital status, home state. Pick realistic, diverse demographics.

2. **Clinical arc**: A narrative life story of this patient's health. What conditions do they have? When were they diagnosed? How has their health changed over time? What medications are they on? What allergies? What immunizations? Write this as a story, not a list.

3. **Provider map**: Which healthcare sites has this patient received care at? For each site, include:
   - Name, city, state, NPI (make up a realistic 10-digit NPI)
   - Type (primary care, specialty, ED, etc.)
   - Active period (when did the patient start/stop going there?)
   - What role does this site play in their care? What kind of data would it hold?
   - How many encounters roughly? What resource volume?
   - Key clinicians (made-up names are fine)

4. **What this patient exercises for the demo**: Explain which Permission Ticket access constraint dimensions this patient's data can demonstrate (scopes, periods, jurisdictions, organizations).

## Suggested section headings

Use clear markdown headings so the narrative is easy for humans and downstream normalization steps to read:

- `## Patient Overview`
- `## Clinical Arc`
- `## Provider Map`
- `## Demo Relevance`

## Calibration (from real records)

Real patient records show:
- ~400-500 FHIR resources per site
- ~15-20 observations per encounter (vitals + screening + labs)
- ~4-6 encounters per year per site for a chronically ill patient
- Encounter types: ~30% office visits, ~25% telephone, ~15% lab, ~10% ED, ~10% telemedicine
- Most observations are vitals (BP, HR, weight, SpO2, BMI, temperature, respirations) + screening (PHQ-2)
- Conditions accumulate over time; medications change at decision points
- Patients often have 2-5 active conditions and 3-6 active medications
- Each office visit generates a progress note (DocumentReference)

## Style

Write naturally. This document will be read by downstream agents and by a JSON-normalization step, so be specific about clinical details (disease names, medication names, approximate lab values) but keep it prose-first rather than template-first. Include enough concrete provider-map detail that the sites, NPIs, clinicians, and states can be normalized reliably later.
