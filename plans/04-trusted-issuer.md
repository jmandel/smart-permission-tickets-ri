# Plan 4: Trusted Issuer

## Goal

Define the Trusted Issuer role for the reference implementation:

- owns issuer identity
- publishes discoverable public keys
- signs Permission Tickets as public cross-boundary artifacts
- provides a clean boundary between:
  - ticket construction
  - ticket signing
  - ticket redemption at network or site auth servers

For the current demo, this role is simulated in-process and called directly by the landing app. A fuller patient-facing consent and redirect flow is explicitly deferred.

## Current Phase Boundary

### Implement Now

Use an in-stack issuer surface that:

- lives at `/issuer/{issuerSlug}`
- publishes JWKS at `/issuer/{issuerSlug}/.well-known/jwks.json`
- signs Permission Tickets with ES256
- is invoked programmatically by the built-in demo client

### Defer

Leave these as later work:

- separate issuer-hosted UI
- redirect-based consent session flow
- patient login / identity proofing simulation
- revocation / CRL experience
- multi-party trust federation beyond local issuer registry configuration

That keeps the project focused on showing how Permission Tickets work without pretending the full issuer UX is already done.

## Why This Role Exists

Permission Tickets are not local server implementation details. They are intended to be:

- signed artifacts
- usable across system boundaries
- verifiable against issuer-published keys

So the signing role should not be:

- the browser
- the generic FHIR resource server hot path
- a local symmetric secret hidden inside the client

It should be the issuer.

## URL Shape

Recommended issuer convention:

- issuer base:
  - `/issuer/{issuerSlug}`
- issuer JWKS:
  - `/issuer/{issuerSlug}/.well-known/jwks.json`
- demo-only sign helper:
  - `/issuer/{issuerSlug}/sign-ticket`

Example:

- `http://localhost:8091/issuer/reference-demo`
- `http://localhost:8091/issuer/reference-demo/.well-known/jwks.json`
- `http://localhost:8091/issuer/reference-demo/sign-ticket`

The `iss` claim in the Permission Ticket should be the full issuer base URL.

Example:

- `iss = http://localhost:8091/issuer/reference-demo`

## Public Base URL

The issuer surface should derive its public URLs from the same explicit server-wide public origin:

- `PUBLIC_BASE_URL=https://smart-permission-tickets.example.org`

That configured origin should drive:

- issuer metadata `issuer`
- `jwks_uri`
- the demo sign helper URL
- the `iss` value stamped into signed Permission Tickets

The reference implementation should not infer issuer base URLs from `X-Forwarded-*` headers by default.

## Issuer Record Model

Each configured issuer should have at least:

- `slug`
- display name
- ES256 signing keypair
- stable `kid`

In the current reference implementation, these issuer records can be configured in local server config and loaded into an issuer registry.

## Signing Model

Permission Tickets should be signed with:

- `alg = ES256`

The signature verification path should work like other public issuer ecosystems:

- consumer reads `iss`
- consumer resolves issuer JWKS
- consumer verifies the signature with the published public key

This is intentionally similar in shape to SMART Health Cards issuer discovery, even though the Permission Ticket payload is a different artifact.

## Current Demo Signing Workflow

For the built-in demo:

1. landing page builds Permission Ticket claims JSON
2. landing page calls `/issuer/{issuerSlug}/sign-ticket`
3. issuer returns an ES256-signed JWT
4. landing page uses that signed ticket for:
   - network token exchange
   - network RLS resolution
   - site token exchange
   - viewer handoff

This is the intended demo simplification.

The demo should automatically bind to a configured issuer rather than forcing the user through a separate issuer UI.

## Demo API Surface

### 1. Issuer Metadata

The issuer base may return lightweight metadata such as:

- issuer URL
- display name
- `jwks_uri`
- sign helper endpoint for demo use
- supported algorithms

Example:

```json
{
  "issuer": "http://localhost:8091/issuer/reference-demo",
  "issuer_name": "Reference Demo Issuer",
  "jwks_uri": "http://localhost:8091/issuer/reference-demo/.well-known/jwks.json",
  "sign_ticket_endpoint": "http://localhost:8091/issuer/reference-demo/sign-ticket",
  "alg_values_supported": ["ES256"]
}
```

### 2. JWKS

`GET /issuer/{issuerSlug}/.well-known/jwks.json`

Example:

```json
{
  "keys": [
    {
      "kty": "EC",
      "crv": "P-256",
      "kid": "demo-key-thumbprint",
      "use": "sig",
      "alg": "ES256",
      "x": "...",
      "y": "..."
    }
  ]
}
```

### 3. Demo Sign Helper

`POST /issuer/{issuerSlug}/sign-ticket`

This is a demo helper, not the normative Permission Ticket protocol.

It should:

- accept a JSON Permission Ticket payload
- normalize required claims like `iss`, `iat`, and `jti`
- preserve an explicit NumericDate `exp` when provided
- omit `exp` entirely when the caller intentionally requests a non-expiring ticket
- return a signed JWT plus issuer metadata

Example response:

```json
{
  "signed_ticket": "eyJ...",
  "issuer": "http://localhost:8091/issuer/reference-demo",
  "jwks_uri": "http://localhost:8091/issuer/reference-demo/.well-known/jwks.json",
  "kid": "demo-key-thumbprint"
}
```

## Permission Ticket Claims Owned By The Issuer

The issuer is responsible for signing the final claims set, including:

- `iss`
- `sub`
- `aud`
- `exp`
- `iat`
- `jti`
- `ticket_type`
- `authorization`
- `details`
- `cnf` when sender-constrained

The built-in demo client may propose most of those claims, but the issuer is the component that finalizes and signs them.

## Validation Expectations Downstream

Network and site auth servers should validate at least:

- `iss`
- `aud`
- `exp`
- `ticket_type`
- signature against issuer JWKS
- `cnf.jkt` binding when required

The downstream servers should not need any local symmetric ticket secret.

## Demo Default Behavior

For now, the built-in demo client should:

- automatically use the default configured issuer
- call the issuer sign helper directly
- avoid exposing a separate issuer journey to the user

This keeps the main demo flow focused on:

- patient selection
- ticket constraints
- ticket signing
- token exchange
- filtered FHIR access

## Future Consent Flow

Later, the issuer role can grow into a more realistic consent/session flow:

1. client redirects patient to issuer
2. issuer presents patient-facing approval UI
3. issuer performs identity confirmation / session handling
4. issuer signs the Permission Ticket
5. issuer redirects back to the client with the signed artifact or a reference to it

That flow is explicitly out of scope for the current implementation slice.

## Revocation And Status

Not required in the current phase, but the issuer role is the natural home for:

- ticket status APIs
- revocation lists
- future revocation endpoints

Those should remain TODOs until the core signing and redemption story is stable.

## Initial Implementation Slice

Phase 1 of the Trusted Issuer plan is complete when the stack has:

- a configured issuer registry
- one default issuer such as `reference-demo`
- ES256 signing
- JWKS publishing
- server-side ticket signing helper for the demo app
- downstream token validation using issuer identity and public keys

It is not necessary in phase 1 to build:

- a separate issuer web app
- redirect-based consent
- revocation UX

## Code Boundary

Suggested implementation seams:

- `auth/issuers/`
  - issuer registry
  - key loading
  - metadata
  - JWKS rendering
  - signing helpers
- `ui/lib/ticket-client.ts`
  - calls the issuer sign helper
- `auth/tickets/`
  - validates signed tickets downstream

The key architectural point is:

- ticket construction may happen in the demo client
- ticket signing happens at the issuer
- ticket validation happens at network/site auth servers

Those should remain separate concerns in code even when they run in one local process.
