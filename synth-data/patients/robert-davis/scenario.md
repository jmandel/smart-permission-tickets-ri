# Robert Davis — Public Health Investigation Subject (UC3)

## Character
65-year-old Black man, retired CTA bus driver, lives alone in a small apartment on Chicago's South Side. Vietnam-era veteran. Former smoker (quit 10 years ago). Mild COPD, controlled hypertension, type 2 diabetes managed with metformin. Generally healthy and independent but doesn't always keep up with preventive care.

## Clinical Scenario
Robert presents to the University of Illinois Hospital ED with persistent cough, night sweats, and 15-pound unintentional weight loss over 2 months. Chest X-ray shows right upper lobe cavitary lesion. Sputum AFB smear positive. Admitted for isolation and workup. Active pulmonary TB confirmed by culture.

Public health is notified. Contact investigation initiated. Robert is started on RIPE therapy (rifampin, isoniazid, pyrazinamide, ethambutol). After clinical improvement he's discharged to outpatient directly observed therapy (DOT) at the affiliated TB clinic.

## Sites
- **University of Illinois Hospital** — ED visit, inpatient admission, initial workup and treatment. All in Chicago, IL.
- **UI Health Ambulatory TB Clinic** — Outpatient DOT visits, follow-up sputum cultures, medication management. Same health system, same city.

Two sites, one health system, one state (IL). This tests Permission Ticket constraints on **period** (only the investigation window) and **scopes** (public health may only need specific resource types like Condition, DiagnosticReport, Observation for lab results).

## Key Features for Permission Tickets Demo
- Dense clinical data concentrated in a short timeframe (~3-4 months)
- Reportable condition triggering public health access
- Mix of inpatient and outpatient at same system
- Rich lab data (AFB smears, cultures, susceptibilities, CBC, CMP, HIV screen, hepatitis panel)
- Medication management with RIPE therapy
- Period-based filtering is the natural constraint — public health needs the TB episode, not his chronic disease history

## Encounter Guidance
~8 encounters total:
- 1 ED visit (presentation, initial workup)
- 1 inpatient stay (isolation, RIPE initiation, discharge)
- ~6 outpatient DOT/follow-up visits at TB clinic (monthly DOT checks, repeat sputum cultures, med monitoring labs)
