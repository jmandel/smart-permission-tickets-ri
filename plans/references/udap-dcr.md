# UDAP Dynamic Client Registration

**Source:** https://www.udap.org/udap-dynamic-client-registration.html (Version STU 1)
**HL7 overlay:** HL7 FHIR US UDAP Security IG v1.0.0 (STU1) / v2.0.0 (STU2)
**Last reviewed:** 2026-04-03

---

## Key Takeaways

1. Registration is a POST to the server's `registration_endpoint` with body `{"software_statement": "{JWT}", "certifications": [...], "udap": "1"}`.

2. The software statement is a signed JWT with `x5c` header containing the client's X.509 cert chain (leaf first). The `x5c` values are **standard base64** (not base64url), per RFC 7515 Section 4.1.6.

3. `iss` and `sub` in the software statement are the client's SAN URI — the stable organizational identifier from the certificate's Subject Alternative Name `uniformResourceIdentifier` entry. The client has no `client_id` yet at this point.

4. `aud` is the server's registration endpoint URL.

5. `exp` max 5 minutes after `iat` (RECOMMENDED in base spec, SHALL in HL7 IG).

6. Server validates: JWT signature using leaf cert public key, X.509 chain to a trusted anchor, SAN URI matches `iss`, registration parameters are acceptable.

7. On success: server returns 201 Created with a server-assigned **opaque `client_id`**. Format is entirely at the server's discretion.

8. Re-registration: same `iss` (SAN URI) re-registering replaces the prior registration. Server SHOULD return same `client_id`; if it returns a new one, the old one is cancelled.

9. Cancellation: submit a registration with the same `iss` but an empty `grant_types` array.

10. The server MUST store the client certificate for use in subsequent client authentication.

## Software Statement JWT Claims

| Claim | Required | Constraints |
|-------|----------|-------------|
| `iss` | REQUIRED | SAN URI from client cert |
| `sub` | REQUIRED | Same as `iss` |
| `aud` | REQUIRED | Registration endpoint URL |
| `exp` | REQUIRED | Max 5 min after `iat` |
| `iat` | REQUIRED | Epoch seconds |
| `jti` | REQUIRED | Unique, not reused before exp |
| `client_name` | REQUIRED | Human-readable |
| `grant_types` | REQUIRED | `["authorization_code"]` or `["client_credentials"]`, not both (HL7 IG) |
| `response_types` | CONDITIONAL | `["code"]` if authz_code grant |
| `token_endpoint_auth_method` | REQUIRED | Fixed: `"private_key_jwt"` |
| `scope` | OPTIONAL (base) / REQUIRED (HL7 IG) | Space-delimited |
| `redirect_uris` | CONDITIONAL | Required if authz_code; HTTPS only (HL7 IG) |
| `contacts` | REQUIRED (HL7 IG) | Array, at least one `mailto:` URI |
| `logo_uri` | CONDITIONAL (HL7 IG) | Required if authz_code; HTTPS, PNG/JPG/GIF |

## JOSE Header

```
alg: "RS256" (base) / also ES256, ES384 (HL7 IG)
x5c: [leaf-cert-base64, ...intermediate-certs-base64]  (standard base64, NOT base64url)
```

Leaf cert is required. Intermediates are optional — server MAY use AIA or its own cert cache to build chains.

## Error Codes

| Code | When |
|------|------|
| `invalid_software_statement` | Signature invalid, malformed JWT, bad claims |
| `unapproved_software_statement` | Valid JWT but cert chain not trusted, community denies client |

## Registration Response (201 Created)

```json
{
  "client_id": "server-assigned-opaque-id",
  "software_statement": "{as submitted}",
  "client_name": "...",
  "grant_types": ["client_credentials"],
  "token_endpoint_auth_method": "private_key_jwt"
}
```

## Open Questions for Our Implementation

- `/.well-known/udap` discovery is required for interop with real UDAP clients, and Plan 08 now implements it alongside `.well-known/smart-configuration`.
- If multiple configured trust frameworks all use UDAP, framework selection should come from trust evaluation of the submitted chain and SAN URI, not from a local UDAP request extension.
- The cert used at re-registration may differ from the original (re-key/renewal) as long as the SAN URI matches. Our stateless client descriptor needs to handle this.
- Algorithm support: start with ES256 only (matching our existing crypto) or also RS256 (matching UDAP's SHALL)?
