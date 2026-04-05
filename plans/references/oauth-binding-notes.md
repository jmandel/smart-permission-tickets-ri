# OAuth Binding and Client Auth RFCs

Implementation-oriented notes from RFCs relevant to Plan 08.

**Last reviewed:** 2026-04-03

---

## RFC 7800 — Proof-of-Possession Key Semantics for JWTs

**Source:** https://www.rfc-editor.org/rfc/rfc7800

### Registered `cnf` Members (7 total in IANA registry)

| Value | Defined in | Semantics |
|-------|-----------|-----------|
| `jwk` | RFC 7800 §3.2 | Full public JWK by value |
| `jwe` | RFC 7800 §3.3 | Encrypted symmetric key (JWE compact serialization) |
| `kid` | RFC 7800 §3.4 | Key identifier; content is application-specific |
| `jku` | RFC 7800 §3.5 | URL to a JWK Set; if multiple keys, `kid` MUST also be present |
| `x5t#S256` | RFC 8705 §3.1 | SHA-256 thumbprint of DER-encoded X.509 cert, base64url |
| `osc` | RFC 9203 §3.2.1 | OSCORE input material (IoT, not relevant here) |
| `jkt` | RFC 9449 §6 | SHA-256 thumbprint of JWK, base64url (DPoP) |

### Key Design Points

- `cnf` MUST represent only a single proof-of-possession key — at most one of `jwk`, `jwe`, `jku` may be present.
- `cnf` is explicitly extensible: "Other members of the `cnf` object may be defined." New members go through the IANA registry with Specification Required policy.
- Unknown `cnf` members MUST be ignored by implementations that don't understand them.
- `jku` requires TLS and server identity validation per RFC 6125.

### Why We Chose `client_binding` Over Extending `cnf`

All `cnf` methods express **cryptographic key binding** — "the presenter must prove possession of this key." None express **entity-level identity binding** — "the presenter must be this organization."

`jku` is the closest: "find the PoP key at this URL." But it still means "one of the keys at this URL is the PoP key," not "the entity controlling this URL is the authorized redeemer." The semantic gap matters: `cnf.jku` doesn't carry framework membership, trust community context, or organizational identity — it's purely a key-resolution mechanism.

Plan 08 introduces `client_binding` as a separate top-level claim for entity-level binding, keeping `cnf` for its intended PoP semantics. Both may coexist.

---

## RFC 7523 — JWT Profile for OAuth 2.0 Client Authentication

**Source:** https://www.rfc-editor.org/rfc/rfc7523

### Client Authentication JWT Claims

| Claim | Requirement | Notes |
|-------|-------------|-------|
| `iss` | MUST | Unique identifier for the issuing entity |
| `sub` | MUST | For client auth: MUST be the `client_id` |
| `aud` | MUST | Token endpoint URL MAY be used; actual value is per agreement |
| `exp` | MUST | Limits time window |
| `nbf` | MAY | Not-before time |
| `iat` | MAY | Issued-at time |
| `jti` | MAY | Unique identifier for replay protection |

### Key Points

- For client authentication: `sub` MUST be the `client_id`. The spec says `iss` is "the entity that issued the JWT" — for self-issued client assertions, `iss` == `sub` == `client_id`.
- `aud` comparison uses Simple String Comparison (RFC 3986 §6.2.1).
- Replay protection via `jti` is OPTIONAL — "implementations may employ at their own discretion."
- `client_assertion_type` is `urn:ietf:params:oauth:client-assertion-type:jwt-bearer`.
- The JWT MUST be digitally signed.

### Relevance to Our Implementation

Our current implementation already follows this for unaffiliated clients. For `well-known:` clients, `iss`/`sub` would be `well-known:{url}`. For UDAP clients, `iss`/`sub` would be the server-assigned `client_id` (per UDAP convention).

---

## RFC 7591 — OAuth 2.0 Dynamic Client Registration

**Source:** https://www.rfc-editor.org/rfc/rfc7591

### Key Points

- `client_id` format is unconstrained — "OAuth 2.0 client identifier string," server's discretion.
- `software_statement` is an optional signed JWT containing client metadata claims. If present and trusted, its claims MUST take precedence over top-level registration parameters.
- Registration response MUST include `client_id` and all registered metadata.
- If `software_statement` was submitted, it MUST be returned unmodified in the response.

### Error Codes

| Code | When |
|------|------|
| `invalid_redirect_uri` | Bad redirect URI |
| `invalid_client_metadata` | Bad metadata field value |
| `invalid_software_statement` | Technically broken software statement |
| `unapproved_software_statement` | Valid but not trusted |

### Relevance to Our Implementation

Our unaffiliated dynamic registration already extends RFC 7591 informally (signed JWK as client_id). UDAP registration is a formal profile of RFC 7591 with `software_statement` and `x5c`.

---

## RFC 8705 — OAuth 2.0 Mutual-TLS Client Authentication and Certificate-Bound Access Tokens

**Source:** https://www.rfc-editor.org/rfc/rfc8705

### `x5t#S256` Computation

1. Take the X.509 certificate in DER encoding
2. SHA-256 hash the DER bytes
3. base64url-encode (no padding)

### Certificate-Bound Access Tokens

The authorization server embeds `cnf.x5t#S256` in the JWT access token. The resource server extracts the client cert from the TLS session, computes the same thumbprint, and verifies it matches. Mismatch → HTTP 401 `invalid_token`.

### Two Client Auth Methods

| Method | Trust Model |
|--------|-------------|
| `tls_client_auth` | PKI-based: validated cert chain + subject DN/SAN matching |
| `self_signed_tls_client_auth` | Self-signed: client registers certs via `jwks`/`jwks_uri` |

### Relevance to Our Implementation

We don't use mutual TLS, but the `x5t#S256` computation is the same one used in UDAP `x5c` certificate thumbprinting. If we ever need to bind an access token to a UDAP client's cert (rather than just validating at token exchange time), this is the mechanism.

---

## X.509 in Bun (Implementation Notes)

Bun v1.1.45+ has full `node:crypto` `X509Certificate` support:

- `new X509Certificate(Buffer.from(base64, "base64"))` — parse from `x5c` entries
- `.verify(issuerCert.publicKey)` — chain validation (walk the array, verify each pair)
- `.subjectAltName` — returns parseable string like `"URI:https://..., DNS:..."`
- `.validFromDate` / `.validToDate` — Date objects for validity checking
- `.publicKey` — KeyObject for signature verification

**Quirk:** `checkIssued()` returns the cert object (truthy) or `undefined`, not a boolean.

No extra deps needed for basic chain validation. For CRL/OCSP: `@peculiar/x509` or `pkijs`.
