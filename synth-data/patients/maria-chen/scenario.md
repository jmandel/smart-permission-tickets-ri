# Maria Chen — Social Care Referral Subject (UC4)

## Character
42-year-old Chinese American woman, single mother of two school-age children (ages 8 and 11). Works part-time as a home health aide, ~25 hours/week. Lives in a small apartment in outer SE Portland, OR. Relies on public transit. Speaks English fluently, some Cantonese at home. Generally healthy — mild asthma, no other significant medical history. Has Medicaid (Oregon Health Plan).

## Clinical Scenario
Maria comes in for a routine annual visit at her community health center. During intake, the medical assistant administers the AHC HRSN (Accountable Health Communities Health-Related Social Needs) screening tool. Maria's responses flag food insecurity ("within the past 12 months, worried food would run out before got money to buy more" — often true) and transportation barriers ("lack of reliable transportation has kept you from medical appointments" — sometimes true).

The PCP addresses her mild asthma (well controlled on PRN albuterol), does routine preventive care, and then discusses the screening results. Maria is receptive to help. The PCP creates a closed-loop referral to Rose City Community Services, a local community-based organization that provides food pantry access, SNAP application assistance, and transit vouchers.

The CBO receives the referral, a case worker contacts Maria, and over the following weeks connects her with food pantry enrollment and helps her apply for SNAP benefits. The Task is updated as milestones are reached, and eventually marked completed when services are delivered.

## Sites
- **Cascade Community Health Center** — Federally qualified health center in Portland, OR. PCP visits, SDOH screening, referral creation.
- **Rose City Community Services** — Community-based organization in Portland, OR. Receives referrals, assigns case workers, tracks service delivery via Task resources.

Two sites, one state (OR), one city. This tests Permission Ticket constraints on **scopes** — the CBO needs access only to the referral (ServiceRequest), tracking (Task), and screening results (Observation), not the patient's clinical records.

## Key Features for Permission Tickets Demo
- Very narrow resource type scope — Permission Ticket limits to ServiceRequest, Task, Observation (SDOH screening)
- Closed-loop referral pattern (ServiceRequest → Task → Task updates)
- CBO as a non-clinical data holder
- Small data footprint — tests that scope filtering visibly excludes clinical data (conditions, meds, labs)
- The PCP visit also generates typical clinical resources (vitals, conditions, meds) that should be *excluded* by the CBO's Permission Ticket

## Encounter Guidance
~4-5 encounters total:
- 1 annual wellness visit at the health center (screening, referral, clinical care)
- 1 follow-up telephone or portal message from health center checking on referral status
- 1-2 CBO encounters (intake call, service delivery confirmation)
- Maybe 1 brief health center follow-up where the closed loop is noted
