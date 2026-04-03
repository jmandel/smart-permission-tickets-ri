# FHIR Server Ticket Input Spec

## Goal

Define the normalized input that the reference FHIR server consumes **after** ticket validation, subject resolution, and local policy compilation.

This is **not** the signed Permission Ticket JWT payload itself.

The ticket should describe:
- which patient-local records are in scope
- which sites and resource types are in scope
- what time window applies
- whether sensitive data is included

It should not require callers to know internal security-label systems or category codes.

## Boundary To The Signed Permission Ticket

There are two layers:

1. **Signed Permission Ticket claims**
   - portable, spec-facing JWT content
   - examples in this repo use `authorization.subject`, SMART scopes, periods, jurisdictions, organizations, and ticket-type-specific `details`
   - these claims are validated and interpreted by the data holder

2. **Normalized server input**
   - a local, implementation-specific authorization envelope
   - already resolved to site-qualified patient aliases and concrete filtering dimensions
   - this is the shape documented in this file

This boundary is intentional. The signed ticket should stay portable and not leak storage-specific concepts like SQLite row filters, reminted server ids, or local security-label code lists. The server is free to compile ticket claims into whatever internal query model it needs, as long as the effective authorization semantics are faithful to the ticket.

## Core Shape

```json
{
  "allowedPatientAliases": [
    {
      "siteSlug": "bay-area-rheumatology-associates",
      "sourcePatientRef": "Patient/7c9e6679-7425-40de-944b-e07fc1f90ae7"
    }
  ],
  "allowedSites": [
    "bay-area-rheumatology-associates"
  ],
  "allowedResourceTypes": [
    "Encounter",
    "Observation",
    "DiagnosticReport",
    "Condition",
    "MedicationRequest",
    "Patient",
    "Organization",
    "Practitioner",
    "Location"
  ],
  "dateRange": {
    "start": "2023-01-01",
    "end": "2025-12-31"
  },
  "dateSemantics": "generated-during-period",
  "sensitive": {
    "mode": "deny"
  }
}
```

## Sensitive Sharing

The external contract is intentionally simple:

```json
"sensitive": {
  "mode": "deny"
}
```

or

```json
"sensitive": {
  "mode": "allow"
}
```

Semantics:
- `deny` means do not include resources carrying any sensitive labels from the implementation's enumerated sensitive-category set
- `allow` means include those resources
- unlabeled resources are treated as non-sensitive
- if `sensitive` is omitted, the default is `mode = "deny"`

The input spec does not expose category codes or label-system details. The reference implementation maps `sensitive.mode` to the concrete `meta.security` label set internally.

## Future Extension Path

The current external model is intentionally all-or-none for sensitive data. If finer-grained sensitive sharing is needed later, it should first be introduced at the signed-ticket/spec layer in an abstract form. The normalized server input can then grow to match, but the reference implementation should not expose label codes or category slugs in this input by default.

## Date Semantics

Default:

```json
"dateSemantics": "generated-during-period"
```

Meaning:
- use authored, recorded, document, or issued timing where present
- otherwise fall back to encounter timing
- apply interval overlap against the ticket's `dateRange`

This is different from a clinical episode or onset/abatement window. The implementation may also track care-overlap internally, but the default input semantics for a ticket timeframe are generated/recorded timing.

## Patient Identity

Tickets identify patient scope using site-qualified local patient references:
- `siteSlug`
- `sourcePatientRef`

This keeps the input aligned with the real authorization boundary. The server can remint global server-safe ids internally, but the ticket does not need to know those ids.
