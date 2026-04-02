# Security Labels Report

## Encounter Classifications

| Encounter | Labels | Rationale |
|---|---|---|
| enc-001 | SEX | OB visit for missed abortion (early pregnancy loss) diagnosis and expectant management counseling |
| enc-002 | SEX | Prenatal visit at 28 weeks with gestational diabetes diagnosis via glucose tolerance testing |
| enc-003 | SEX | Six-week postpartum follow-up visit with metabolic screening confirming GDM resolution |

## Resource Overrides

| Pattern | Labels | Rationale |
|---|---|---|
| enc-000/*phq2* | MH | PHQ-2 depression screening at routine PCP wellness visit |
| enc-000/*prenatal-vitamin* | SEX | Prenatal vitamin prescribed at non-OB PCP visit reveals pregnancy |
| enc-001/*cond-grief* | MH | Grief/psychological distress condition documented at reproductive health visit |
| enc-003/*phq2* | MH | PHQ-2 depression screening at postpartum (SEX) visit, not an MH encounter |
| enc-004/*phq2* | MH | PHQ-2 depression screening at routine new-patient PCP visit |
| enc-005/*phq2* | MH | PHQ-2 depression screening at rheumatology workup PCP visit |

## Summary

- **MH**: 5 resources
- **SEX**: 52 resources
- **Total labels applied this run**: 57
