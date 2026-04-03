# Security Labels Report

## Encounter Classifications

| Encounter | Labels | Rationale |
|---|---|---|
| enc-000 | SEX | Well-woman GYN exam with Pap smear, HPV co-test, and contraception management |
| enc-001 | SEX | Preconception counseling visit with OCP discontinuation and prenatal vitamin initiation |
| enc-002 | SEX | First pregnancy confirmation with serial beta-hCG monitoring |
| enc-003 | SEX | First pregnancy loss — spontaneous abortion at 6 weeks, expectant management |
| enc-004 | SEX | Second pregnancy confirmation and subsequent missed abortion with RPL diagnosis |
| enc-005 | SEX | Recurrent pregnancy loss workup — karyotyping, coagulation, and metabolic panel |
| enc-006 | SEX | Third pregnancy confirmation with early ultrasound and progesterone supplementation |
| enc-007 | SEX | Third pregnancy loss — missed abortion at 8 weeks, D&C with POC genetic testing |
| enc-008 | SEX | APS antibody panel results review with specialist referrals for recurrent pregnancy loss |
| enc-009 | SEX | Telephone follow-up coordinating MFM and hematology referrals for RPL/APS |
| enc-010 | SEX | MFM consultation for high-risk pregnancy planning with suspected APS |
| enc-011 | SEX | Telephone follow-up after MFM consultation — enoxaparin education and coordination |
| enc-012 | SEX | Initial hematology consultation for APS evaluation in context of recurrent pregnancy loss |
| enc-013 | SEX | Lab visit for confirmatory APS antibody testing and thrombophilia panel |
| enc-014 | SEX | Hematology follow-up confirming APS diagnosis and anticoagulation planning for future pregnancy |

## Resource Overrides

| Pattern | Labels | Rationale |
|---|---|---|
| enc-000/*phq2* | MH | PHQ-2 depression screening at well-woman GYN visit |
| enc-001/*phq2* | MH | PHQ-2 depression screening at preconception counseling visit |
| enc-004/*phq2* | MH | PHQ-2 depression screening at pregnancy/loss management visit |
| enc-006/*phq2* | MH | Positive PHQ-2 depression screening at prenatal visit |
| enc-006/*anxiety* | MH | Pregnancy-related anxiety condition at reproductive health visit |
| enc-008/*phq2* | MH | Positive PHQ-2 screening and depression condition at APS results visit |

## Summary

- **MH**: 7 resources
- **SEX**: 254 resources
- **Total labels applied this run**: 261
