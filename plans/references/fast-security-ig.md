# HL7 FAST Security IG (UDAP Security for FHIR)

**Source:** https://hl7.org/fhir/us/udap-security/
**Versions:** STU1 (v1.0.0, 2022-09-27, superseded), STU2 (v2.0.0, 2025-12-09, current)
**Ballot:** v3.0.0-ballot moving from US to UV (international) realm, renamed `FASTSecurity`
**Based on:** FHIR R4 (4.0.1)
**Last reviewed:** 2026-04-03

---

## What the HL7 IG Adds Over Base UDAP

The IG profiles the base UDAP.org specifications and adds FHIR/healthcare-specific requirements:

1. **`hl7-b2b` authorization extension** — formally defined structure for B2B context (organization, purpose of use, subject identity, consent). Entirely defined by this IG.
2. **FHIR-specific discovery** — `{baseURL}/.well-known/udap` where `{baseURL}` is the FHIR server base URL.
3. **SMART scope conventions** — guidance to use `system/*` for client_credentials, `user/*` or `patient/*` for authorization_code.
4. **Trust community checklist** — healthcare-specific governance items.
5. **Certification framework template** (STU2) — formal template with extension key examples.
6. **PKCE requirement** (STU2) — SHALL use PKCE with S256 for all authorization_code flows.
7. **SMART App Launch coexistence guidance** (STU2) — Section 7.5.

## Key Conformance Requirements (SHALL)

- Server metadata at `{baseURL}/.well-known/udap`, unauthenticated
- `signed_metadata` element in server metadata (called `signed_endpoints` in base spec)
- `signed_metadata` `iss` SHALL match SAN URI AND equal `{baseURL}`
- `signed_metadata` `exp` no more than 1 year after `iat`
- Dynamic registration at `registration_endpoint`
- Software statement `exp` no more than 5 min after `iat`
- `token_endpoint_auth_method` = `"private_key_jwt"`
- Auth token max lifetime 5 minutes
- Access token max lifetime 60 minutes
- `udap` = `"1"` in token requests
- Support RS256; SHOULD support ES256
- PKCE with S256 (STU2)
- `state` parameter in authorization requests (STU2)
- `scopes_supported` in metadata (STU2)
- Server support `?community=` parameter (STU2)
- Servers supporting B2B SHALL support the `hl7-b2b` extension object

## Key STU1 → STU2 Changes

| Area | STU1 | STU2 |
|------|------|------|
| PKCE | Not mentioned | SHALL use S256 |
| `community` param | Server MAY support | Server SHALL support |
| `scopes_supported` | Optional | Required |
| `subject_id` NPI | SHALL be NPI (US) | Trust communities SHALL constrain; NPI "encouraged" |
| Scope negotiation | Minimal | Detailed section with wildcard rules |
| SMART coexistence | Brief note | Full section |
| Token use constraint | Not specified | Client SHALL use token consistent with asserted context |
| Unknown community response | 404 | 204 No Content |
| Registration modification | Not scoped | SHALL NOT overwrite registration from different community |

## Trust Community Architecture

A trust community is defined by:
- A root CA (or set of anchor certificates)
- A community URI (for `?community=` parameter)
- Community policies (allowed claims, purpose of use, consent, legal agreements, cert policies)

Server selects its certificate per community. Without `?community=`, server uses default cert.

## Server Metadata Fields (`.well-known/udap`)

| Field | Required | Notes |
|-------|----------|-------|
| `udap_versions_supported` | REQUIRED | `["1"]` |
| `udap_profiles_supported` | REQUIRED | `["udap_dcr", "udap_authn", ...]` |
| `udap_authorization_extensions_supported` | REQUIRED | e.g. `["hl7-b2b"]` |
| `udap_authorization_extensions_required` | CONDITIONAL | Present if supported is non-empty |
| `udap_certifications_supported` | REQUIRED | Array of certification URIs |
| `udap_certifications_required` | CONDITIONAL | Present if supported is non-empty |
| `grant_types_supported` | REQUIRED | e.g. `["client_credentials"]` |
| `scopes_supported` | REQUIRED (STU2) | |
| `token_endpoint` | REQUIRED | |
| `registration_endpoint` | REQUIRED | |
| `signed_metadata` | REQUIRED | Signed JWT |
| `token_endpoint_auth_methods_supported` | REQUIRED | `["private_key_jwt"]` |
| `token_endpoint_auth_signing_alg_values_supported` | REQUIRED | e.g. `["RS256", "ES256"]` |
| `registration_endpoint_jwt_signing_alg_values_supported` | REQUIRED (STU2) | |

## Open Questions for Our Implementation

- Do we expose `/.well-known/udap` alongside `.well-known/smart-configuration`, or only the latter? Real UDAP clients need the former.
- The IG is moving to UV (international) realm in v3. Should we target STU2 conventions or the v3 ballot direction?
- The `signed_metadata` JWT requires a server certificate with a SAN URI matching the FHIR base URL. Our reference server doesn't have a real certificate. Options: self-signed cert for demo, or defer signed_metadata to a later phase.
- STU2 says registration modification SHALL NOT overwrite registrations from a different trust community. Our stateless client descriptor needs to carry the community/framework identity.
