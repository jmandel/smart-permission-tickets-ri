# Scenario: Elena Reyes

Mid-30s Latina woman. Lived in Austin, TX through 2022, then moved to Oakland, CA.

**Texas chapter**: Reproductive history managed by an OB/GYN practice in Austin. First pregnancy (2019) was uncomplicated — vaginal delivery, healthy baby. In early 2020 she had a spontaneous abortion (miscarriage) at ~10 weeks — managed expectantly, emotionally difficult but no surgical intervention needed. Second successful pregnancy (2021) had mild gestational diabetes (diet-controlled, resolved postpartum), vaginal delivery. Also saw a PCP in Austin for routine care — annual wellness exams, immunizations, a couple of URIs. The miscarriage is particularly sensitive data that she may prefer to keep private when sharing records for other purposes.

**California chapter**: Established with a new PCP in Oakland in late 2022. In early 2023, started having bilateral hand and wrist pain, morning stiffness lasting over an hour. PCP ordered initial labs (RF, anti-CCP, ESR, CRP — all elevated). Referred to rheumatology. Diagnosed with rheumatoid arthritis, seropositive. Started methotrexate 15mg weekly + folic acid. Required regular monitoring (CBC, LFTs every 8-12 weeks). Partial response to methotrexate — added adalimumab (Humira) in late 2023. Good response by 2024. Ongoing monitoring, quarterly rheumatology visits, regular labs.

Also in CA: annual wellness with PCP, flu shots, COVID booster. One urgent care visit for a bad ankle sprain in 2024.

**Why this patient matters for the demo**: Elena has sensitive reproductive health data in Texas that she may not want shared via a permission ticket — the spec's jurisdiction and scope filtering lets her share her California rheumatology data without exposing her Texas OB history. This is a concrete, relatable example of why granular access constraints matter.

**Constraint exercise goals**:
- Jurisdiction filtering (TX vs CA) cleanly separates reproductive from rheumatologic data
- Scope filtering (patient/Condition.rs + patient/Observation.rs + patient/MedicationRequest.rs) returns RA management without pregnancy history
- Period filtering (2023-present) excludes the entire Texas period
- Organization filtering (4 distinct providers across 2 states)
- The reproductive data exists and is valid FHIR — it just gets *filtered out* by the ticket constraints, demonstrating that the filtering is real
