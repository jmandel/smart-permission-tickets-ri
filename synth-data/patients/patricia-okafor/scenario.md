# Scenario: Patricia Okafor — Research Study Consent (UC6)

## Character
62-year-old Nigerian-American woman, retired high school biology teacher. Lives in Houston, TX with her husband Emeka. Non-smoker, but 15-year history of secondhand smoke exposure (husband smoked until 2015). Active church member, walks 2 miles daily. Insurance: Medicare (age 62 with disability determination due to cancer diagnosis).

## Clinical Scenario
Patricia was diagnosed with stage IIIA non-small cell lung cancer (adenocarcinoma) in October 2024 after presenting with persistent cough and unintentional weight loss. Her PCP ordered a chest CT showing a 4.2 cm right upper lobe mass with ipsilateral mediastinal lymphadenopathy. She was referred to MD Anderson Cancer Center for staging workup: PET/CT, brain MRI, and endobronchial ultrasound-guided biopsy (EBUS) confirming adenocarcinoma with PD-L1 TPS 60% and no actionable driver mutations (EGFR wild-type, ALK/ROS1 negative).

She was enrolled in a Phase III clinical trial (NCT05820295 — a real-ish trial ID) comparing pembrolizumab + carboplatin/pemetrexed vs standard chemo alone for first-line treatment of stage III NSCLC. She signed informed consent in December 2024 and began treatment in January 2025. She has completed 4 cycles of chemo-immunotherapy with partial response on interim imaging. She continues maintenance pembrolizumab with regular monitoring.

The research institute (MD Anderson) uses a Permission Ticket to access Patricia's historical medical records from her community PCP and pulmonologist, covering the 3 years prior to enrollment through the present, to correlate treatment response with prior health status.

## Sites
- **Westheimer Family Medicine** — PCP in Houston, TX (2018–present). Annual wellness visits, initial workup of cough/weight loss, chronic disease management (hypertension, pre-diabetes).
- **Houston Pulmonary Associates** — Pulmonologist in Houston, TX (2024). Initial chest CT referral, pulmonary function testing, referred to MD Anderson.
- **MD Anderson Cancer Center** — Oncology in Houston, TX (2024–present). Staging, biopsy, clinical trial enrollment, chemo-immunotherapy, monitoring.

Three sites, one state (TX). Tests Permission Ticket constraints on **periods** (research needs 2022–present, not her full medical history) and **scopes** (research needs Condition, Observation, DiagnosticReport, MedicationRequest, Procedure — broad but defined by study protocol).

## Key Features for Permission Tickets Demo
- UC6 research study consent: research institute accesses historical records with patient consent
- Subject resolution by identifier (MRN at community sites)
- Requester is Organization (research institute)
- Details include condition (lung cancer — SNOMED), study (NCT05820295)
- Long historical window (3 years pre-enrollment + ongoing)
- Rich oncology data: staging imaging, pathology, molecular testing, treatment response
- Prior health data at PCP: captures the diagnostic journey from symptom to referral to diagnosis
- Demonstrates how research access differs from clinical access — broader time scope but protocol-defined resource types

## Encounter Guidance
~10-14 encounters total:
- PCP: 3-4 visits (annual wellness 2022, 2023, 2024; the index visit with cough/weight loss in 2024)
- Pulmonologist: 2-3 visits (initial consult, PFTs, referral to oncology)
- MD Anderson: 5-7 encounters (staging workup, biopsy, consent/enrollment, chemo cycles, interim imaging, follow-up)
