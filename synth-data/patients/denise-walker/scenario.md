# Denise Walker — Complex Chronic Disease Management Subject (UC1)

## Character
58-year-old Black woman, recently widowed, formerly worked as a school district transportation dispatcher. Lived in Phoenix, AZ through early 2024, then moved to Albuquerque, NM to live closer to her adult daughter and help with grandchildren. Medicare Advantage. High health literacy but sometimes struggles with transportation, medication affordability, and keeping multiple specialist appointments aligned.

## Clinical Scenario
Denise has longstanding type 2 diabetes mellitus, hypertension, hyperlipidemia, and diabetic peripheral neuropathy. Over the past several years she also developed heart failure with reduced ejection fraction and paroxysmal atrial fibrillation, plus chronic kidney disease with albuminuria. Her glucose control worsened during the stress of caring for her husband before his death, then she relocated out of state and had a brief gap in medication access.

In Arizona she had primary care and cardiology follow-up that established the chronic disease baseline: diabetes requiring intensification, CKD emerging, atrial fibrillation managed with anticoagulation, and HFrEF treated medically. After moving to New Mexico she had an acute decompensated heart-failure hospitalization, then longitudinal follow-up with a heart-failure clinic, nephrology, and retina specialists for diabetic retinopathy with macular edema.

## Sites
- **Desert Family Medicine** — Phoenix, AZ. Primary care, diabetes/hypertension management, preventive care, early CKD recognition.
- **Valley Heart Institute** — Phoenix, AZ. Cardiology follow-up for HFrEF and atrial fibrillation, echo review, medication optimization.
- **University of New Mexico Hospital and Heart Failure Clinic** — Albuquerque, NM. HF hospitalization plus follow-up clinic management.
- **Rio Grande Nephrology Associates** — Albuquerque, NM. CKD stage 3b with albuminuria, BP/renal monitoring, medication safety.
- **Sandia Retina Specialists** — Albuquerque, NM. Diabetic retinopathy and macular edema evaluation, retinal imaging, intravitreal treatment.

## Why This Patient Matters For The Demo
Denise is a strong patient-access example because the clinically relevant data spans multiple years, two states, five organizations, and many FHIR resource types: Conditions, MedicationRequests, Observations, DiagnosticReports, Procedures, Immunizations, and DocumentReferences. A Permission Ticket can meaningfully narrow:

- **Jurisdiction**: Arizona baseline care vs New Mexico specialty and hospital care
- **Period**: pre-move baseline vs recent worsening/monitoring
- **Organization**: PCP vs cardiology vs nephrology vs retina vs hospital
- **Scopes**: e.g. just renal/cardiac monitoring resources vs the full chart

## Clinical Threads To Exercise
- Persistent conditions: type 2 diabetes, hypertension, HFrEF, atrial fibrillation, CKD stage 3b, diabetic peripheral neuropathy, diabetic retinopathy
- Long-term meds that should persist across encounters: insulin glargine, empagliflozin, carvedilol, sacubitril/valsartan, furosemide, apixaban, atorvastatin
- Resources that should update rather than duplicate: CKD staging, HF status, atrial fibrillation management, glycemic control trends
- New acute event in the middle of the timeline: heart-failure exacerbation hospitalization after move
- Specialty-only findings/procedures: retina imaging and intravitreal injection
