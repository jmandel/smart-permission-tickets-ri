# Scenario: Aisha Patel — Authorized Representative / Pediatric (UC2)

## Character
6-year-old Indian-American girl. Lives with her mother Priya Patel (age 34, software engineer) and father Raj Patel (age 36, pharmacist) in Raleigh, NC. Attends first grade. Generally active and happy but has significant allergic disease burden.

## Clinical Scenario
Aisha was diagnosed with asthma at age 3 after recurrent wheezing with viral URIs. She progressed to severe persistent asthma by age 5, requiring daily fluticasone/salmeterol plus montelukast, with PRN albuterol. She has confirmed IgE-mediated food allergies to peanuts (anaphylaxis at age 2 — epinephrine auto-injector prescribed) and tree nuts (positive skin prick and specific IgE testing). She also has moderate atopic dermatitis managed with topical steroids and moisturizers, and allergic rhinitis.

Her care involves a pediatrician for routine well-child visits and acute illness, a pediatric allergist/immunologist for allergy management and immunotherapy evaluation, and she has had two ED visits at a children's hospital — one for an anaphylactic reaction at age 2 (accidental peanut exposure at a family gathering) and one for a severe asthma exacerbation at age 5 requiring systemic steroids.

Priya Patel, as Aisha's mother, is the authorized representative who uses a patient-facing app to manage Aisha's health records.

## Sites
- **Triangle Pediatrics** — Pediatrician in Raleigh, NC (2020–present). Well-child visits, immunizations, acute visits, asthma management.
- **UNC Pediatric Allergy & Immunology** — Allergist in Chapel Hill, NC (2022–present). Food allergy testing, asthma specialist management, immunotherapy evaluation.
- **WakeMed Children's Emergency Department** — ED in Raleigh, NC. Two visits: anaphylaxis (2022) and severe asthma exacerbation (2025).

Three sites, one state (NC). Tests Permission Ticket constraints primarily on **scopes** (e.g., can filter to just immunization records, or just allergy-related data) and **organizations** (3 different health systems).

## Key Features for Permission Tickets Demo
- UC2 authorized representative: mother Priya accesses pediatric records on behalf of minor child
- Subject resolution by identifier (MRN — Aisha is known at multiple NC facilities)
- Requester is RelatedPerson (mother, relationship code "MTH")
- Details include basis (parental authority), verifiedAt timestamp
- Pediatric-specific data: growth charts, developmental milestones, immunization series, well-child visits
- Allergy data is particularly rich — IgE levels, skin prick test results, food challenge results, epinephrine prescriptions
- Emergency encounters demonstrate high-acuity data that crosses organizational boundaries
- Immunization records are a key use case for UC1 too — scope filtering can isolate just vaccines

## Encounter Guidance
~10-14 encounters total across 3 sites:
- Pediatrician: 5-6 visits (well-child checks at ages 3, 4, 5, 6; acute visits for URI/wheezing)
- Allergist: 3-4 visits (initial evaluation, allergy testing, follow-up management, immunotherapy discussion)
- ED: 2 visits (anaphylaxis at age 2, asthma exacerbation at age 5)
