# Plan 15a: Future RAR Alignment

Deferred follow-up to Plan 15. Not blocking current work.

## Idea

Rename permission rule `kind` → `type` to align with OAuth Rich Authorization Requests (RFC 9396). Each permission rule would then be a valid RAR authorization detail object, enabling:

- `access.permissions` as `authorization_details` in token exchange requests
- Native RAR processing at data holders that support RFC 9396
- Issued access tokens carrying `authorization_details` per the standard

## Mapping

- `kind: "data"` → `type: "https://smarthealthit.org/authorization-detail/fhir-data"` (or shorter)
- `kind: "operation"` → `type: "https://smarthealthit.org/authorization-detail/fhir-operation"`

## When

After Plan 15 migration is complete and tests are green. This is a rename across plan, spec, schema, examples, and implementation.
