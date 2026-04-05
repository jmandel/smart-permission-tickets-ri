# Reference Notes

Implementation-oriented summaries of external specs relevant to [Plan 08](../08-trust-frameworks-client-binding.md).

These are curated notes, not full spec mirrors. Each file captures the details that matter for this repo's trust-framework and client-binding work.

## Index

| File | Topic | Source Specs |
|------|-------|-------------|
| [udap-dcr.md](udap-dcr.md) | UDAP Dynamic Client Registration | UDAP.org DCR, HL7 FHIR US UDAP Security IG |
| [udap-jwt-client-auth.md](udap-jwt-client-auth.md) | UDAP JWT client authentication at the token endpoint | UDAP.org JWT Client Auth, HL7 IG B2B profile |
| [fast-security-ig.md](fast-security-ig.md) | HL7 FAST Security IG layers on top of base UDAP | HL7 FHIR US UDAP Security IG STU1/STU2 |
| [oauth-binding-notes.md](oauth-binding-notes.md) | RFC 7800 `cnf` methods, RFC 7523 client auth, RFC 7591 DCR, RFC 8705 mTLS | RFCs 7800, 7523, 7591, 8705 |

## Full Source Specs (`sources/`)

Local copies for offline reference. Not curated — these are verbatim downloads.

### UDAP.org Base Specs
- `sources/udap-dynamic-client-registration.html`
- `sources/udap-jwt-client-auth.html`
- `sources/udap-server-metadata.html`

### HL7 FHIR US UDAP Security IG
- `sources/hl7-udap-stu1-{index,registration,b2b,discovery,consumer}.html`
- `sources/hl7-udap-stu2-{index,registration,b2b,discovery,general,consumer}.html`

### RFCs (plain text)
- `sources/rfc7800.txt` — Proof-of-Possession Key Semantics for JWTs
- `sources/rfc7523.txt` — JWT Profile for OAuth 2.0 Client Authentication
- `sources/rfc7591.txt` — OAuth 2.0 Dynamic Client Registration Protocol
- `sources/rfc8705.txt` — OAuth 2.0 Mutual-TLS Client Auth and Certificate-Bound Access Tokens
