# UDAP JWT Client Authentication

**Source:** https://www.udap.org/udap-jwt-client-auth.html (Draft 2022-06-21 with errata)
**HL7 overlay:** HL7 FHIR US UDAP Security IG
**Last reviewed:** 2026-04-03

---

## Key Takeaways

1. After registration, the client authenticates at the token endpoint with `private_key_jwt`. The authentication token (AnT) is submitted as `client_assertion` with `client_assertion_type=urn:ietf:params:oauth:client-assertion-type:jwt-bearer`.

2. **Critical identity shift:** At registration, `iss`/`sub` = SAN URI. At the token endpoint, `iss`/`sub` = the server-assigned `client_id`. Same cert, different identity claims.

3. The `x5c` header MUST be re-sent at the token endpoint in every authentication token JWT. The server re-validates the chain on every request.

4. Max JWT lifetime: 5 minutes (RECOMMENDED in base spec, SHALL in HL7 IG).

5. The `udap` parameter (`"1"`) MUST be included in token endpoint requests.

6. No HTTP Basic auth or client_secret — `private_key_jwt` is the only auth method.

## Authentication Token JWT Claims

| Claim | Required | Value |
|-------|----------|-------|
| `iss` | REQUIRED | The server-assigned `client_id` |
| `sub` | REQUIRED | Same as `iss` (`client_id`) |
| `aud` | REQUIRED | Token endpoint URL |
| `exp` | REQUIRED | Max 5 min after `iat` |
| `iat` | REQUIRED | Epoch seconds |
| `jti` | REQUIRED | Unique nonce |
| `extensions` | CONDITIONAL | Required for B2B `client_credentials` flow |

## JOSE Header

Same as registration: `alg` + `x5c` with the client's cert chain.

## The `hl7-b2b` Extension

Required in `extensions` for B2B `client_credentials` flow. Omit for `authorization_code` flow.

| Field | Required | Notes |
|-------|----------|-------|
| `version` | REQUIRED | Fixed `"1"` |
| `organization_id` | REQUIRED | URI uniquely identifying the org |
| `purpose_of_use` | REQUIRED | Array of coded strings, e.g. `urn:oid:2.16.840.1.113883.5.8#TREAT` |
| `subject_name` | CONDITIONAL | Human-readable name; required if known |
| `subject_id` | CONDITIONAL | NPI preferred for US Realm |
| `subject_role` | CONDITIONAL | NUCC taxonomy encouraged |
| `organization_name` | OPTIONAL | Human-readable org name |
| `consent_policy` | OPTIONAL | Array of policy URIs |
| `consent_reference` | CONDITIONAL | Array of FHIR resource URLs; omit if no consent_policy |

## Token Endpoint Request

```
POST /token HTTP/1.1
Content-type: application/x-www-form-urlencoded

grant_type=client_credentials
&client_assertion_type=urn:ietf:params:oauth:client-assertion-type:jwt-bearer
&client_assertion=eyJh...
&scope=system/Patient.rs
&udap=1
```

## Error Codes at Token Endpoint

| Code | When |
|------|------|
| `invalid_client` | Trust validation failure (chain untrusted, cert revoked) |
| `invalid_request` | Signature invalid, malformed JWT |

## Open Questions for Our Implementation

- The `hl7-b2b` extension maps conceptually to our `authorization.requester` in Permission Tickets. Should we bridge these, or treat them as parallel authorization contexts?
- Do we re-validate the full X.509 chain on every token request (per spec), or cache the chain validation result from registration with a TTL?
- When a UDAP client presents a Permission Ticket, the ticket's `client_binding.entity_uri` should match the SAN URI from the cert, not the server-assigned `client_id`. Plan 08 should treat this as a fixed rule, not an open question.
