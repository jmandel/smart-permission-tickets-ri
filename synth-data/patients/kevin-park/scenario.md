# Scenario: Kevin Park — Provider-to-Provider Consult (UC7)

## Character
57-year-old Korean-American man, owner of a small dry cleaning business. Lives in Minneapolis, MN with his wife Soon-Yi. Generally healthy, moderate alcohol use (2-3 glasses of wine per week with dinner). Active — plays golf in summer, walks regularly. Insurance: employer group plan through a local business association.

## Clinical Scenario
Kevin has been seeing his PCP for routine care — well-controlled mild hypertension (lisinopril 10mg) and borderline cholesterol (managed with diet and exercise, no statin). In November 2025, he develops intermittent palpitations and mild exertional dyspnea while golfing. He dismisses it initially but mentions it at a routine follow-up in January 2026. His PCP discovers an irregularly irregular pulse at 94 bpm. A 12-lead ECG confirms atrial fibrillation.

His PCP starts workup: TTE (echocardiogram) shows mild left atrial dilation (4.3 cm), preserved LVEF (58%), no valvular disease. TSH is normal. CBC and metabolic panel are normal. CHA₂DS₂-VASc score is 1 (hypertension). His PCP initiates rate control (metoprolol succinate 50mg daily) and anticoagulation (apixaban 5mg BID), then refers Kevin to an electrophysiologist at the University of Minnesota for evaluation of catheter ablation.

The EP specialist at U of M issues a Permission Ticket to access Kevin's records from his PCP, including the ECG, echocardiogram, labs, and medication history relevant to the consult.

## Sites
- **Minnehaha Internal Medicine** — PCP in Minneapolis, MN (2018–present). Routine chronic disease management, AFib discovery, initial workup, rate control + anticoagulation initiation.
- **University of Minnesota Cardiac Electrophysiology** — EP specialist in Minneapolis, MN (2026). Consultation for catheter ablation evaluation, Holter monitor, shared decision-making.

Two sites, one state (MN). Tests Permission Ticket constraints on **scopes** (specialist needs cardiac-relevant data: ECG, echo, labs, medications — not unrelated history) and **organizations** (community PCP → academic specialist).

## Key Features for Permission Tickets Demo
- UC7 provider-to-provider consult: EP specialist requests records from referring PCP
- Subject resolution by reference (Kevin is known to the PCP)
- Requester is Practitioner (electrophysiologist with NPI)
- Details include reason (atrial fibrillation — SNOMED 49436004), request (ServiceRequest reference)
- Focused clinical question: "Is this patient a candidate for catheter ablation?"
- Consult requires specific data: ECG interpretation, echocardiogram report, medication list, relevant labs
- Not all of Kevin's records are relevant — dermatology visits, colonoscopy, etc. should be excludable by scope
- Demonstrates the common referral workflow: PCP workup → specialist consult with data sharing

## Encounter Guidance
~8-10 encounters total:
- PCP: 5-7 visits (annual wellness 2023, 2024; routine HTN follow-up 2025; AFib discovery visit Jan 2026; follow-up with ECG/labs; echo ordering visit; referral)
- EP specialist: 2-3 visits (initial consult, Holter monitor review, ablation discussion/planning)
