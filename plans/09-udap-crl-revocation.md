# Plan 9: UDAP CRL and Revocation Support

## Goal

Extend the reference implementation's UDAP PKI so that:

- demo certificates advertise valid CRL Distribution Points
- the server can publish CRLs for its demo UDAP trust anchors
- UDAP certificate-path validation can check revocation status using CRLs

This plan exists for two reasons:

- interoperability: external validators such as Inferno expect standard X.509 revocation support
- correctness: UDAP revocation checking is part of the security model, not just a demo embellishment

## Why This Is Separate From Plan 8

[Plan 8](./08-trust-frameworks-client-binding.md) established the trust-framework abstraction, UDAP registration, UDAP token authentication, and signed metadata.

This plan addresses a narrower but deeper PKI problem:

- Plan 8 proved certificate trust and identity binding
- Plan 9 adds revocation metadata, revocation publication, and revocation enforcement

Keeping revocation as a separate plan makes the work easier to stage:

- Phase 1 can focus on interoperable demo PKI and CRL hosting
- Phase 2 can focus on runtime revocation enforcement and failure policy

## Scope

### Implement

- CRL Distribution Points on demo UDAP certificates
- server-hosted CRL endpoints for demo UDAP trust anchors
- CRL-aware validation for UDAP certificate chains
- tests covering both non-revoked and revoked certificates

### Defer

- OCSP
- external CA / enterprise PKI management
- generalized revocation support for non-UDAP trust frameworks
- delta CRLs
- admin UI for revoking certificates

## Recommended Approach

Do not treat the current bundled demo leaf certificates as permanent.

For demo roots, keep stable trust-anchor material in source control. For runtime leaf certificates:

- generate metadata signing leaves at runtime, because they depend on the current FHIR base URL and should embed runtime-correct CRL DPs
- strongly consider generating demo client leaves from the demo CA at runtime as well, so their CRL DPs always match the running server origin

This avoids the current mismatch where static PEM fixtures are easy to bundle but cannot reliably advertise runtime-correct revocation URLs.

## Phase 1: Demo PKI and Published CRLs

### Objective

Make the demo UDAP PKI look like a real revocation-capable PKI to external verifiers.

This phase is about publication, not local enforcement.

### Outcomes

- default demo UDAP roots publish CRLs
- default demo metadata certificates include CRL DPs
- default demo client certificates include CRL DPs
- `signed_metadata` chains to a demo trust anchor whose CRL is reachable

### Design

Use CRLs per demo CA.

Each demo UDAP trust anchor should have:

- root certificate
- root private key
- CRL number state
- CRL publication path
- optional certificate serial registry for demo-issued leaves

Recommended endpoint shape:

- `/.well-known/udap/crls/<framework-slug>/<ca-slug>.crl`

The exact path is local to the reference implementation. The important requirement is that issued demo certificates embed these URLs as CRL Distribution Points.

### Implementation Checklist

- [x] Add CRL-related configuration to the UDAP framework model in [model.ts](../fhir-server/src/store/model.ts)
  - suggested fields:
    - `crlDistributionBaseUrl?`
    - `crlIssuerCertificatePem?`
    - `crlIssuerPrivateKeyPem?`
    - `crlPem?` or generated CRL state

- [x] Add a small CRL utility module under `src/auth/`
  - responsibilities:
    - generate empty CRLs for demo roots
    - generate updated CRLs when a serial is revoked
    - expose PEM and DER encodings if needed

- [x] Update [udap-server-metadata.ts](../fhir-server/src/auth/udap-server-metadata.ts)
  - add `crlDistributionPoints` to generated metadata leaf certificates
  - ensure the generated metadata leaf points at the running server's CRL endpoint

- [x] Update [demo-frameworks.ts](../fhir-server/src/auth/demo-frameworks.ts)
  - define demo CRL publication settings for:
    - demo EC root
    - demo RSA root
  - choose whether demo client leaves remain static or become runtime-generated

- [ ] If demo client leaves remain bundled in phase 1:
  - regenerate the bundled PEMs with CRL Distribution Points
  - ensure the chosen URLs are stable enough for the demo context

- [ ] If demo client leaves move to runtime generation in phase 1:
  - add a small helper that mints demo client cert/key pairs from the configured demo CA
  - update the built-in demo registration helper to use those runtime-generated materials

- [x] Add server routes for CRL publication in [app.ts](../fhir-server/src/app.ts)
  - serve CRL bytes with correct content type
  - support the default global surface first
  - keep the route simple and deterministic

- [ ] Update discovery/demo docs in [README.md](../fhir-server/README.md)
  - note that demo UDAP trust anchors now publish CRLs
  - document the CRL endpoint shape

### Phase 1 Testing

- [ ] Unit tests for CRL generation and encoding
- [x] Route tests for CRL endpoint reachability and content type
- [x] Discovery tests proving the `signed_metadata` leaf includes a CRL DP
- [ ] Demo-root tests proving the CRL endpoint returns a CRL signed by the expected root
- [ ] End-to-end check that external-style validation can fetch the CRL for `signed_metadata`

### Phase 1 Exit Criteria

- the default demo `signed_metadata` certificate advertises a reachable CRL DP
- the CRL is signed by the same demo trust anchor used for discovery trust
- demo client certificates used in UDAP examples also advertise CRL DPs
- documentation explains how the demo PKI publishes revocation state

## Phase 2: Runtime CRL Enforcement

### Objective

Make the server's own UDAP certificate validation revocation-aware and fail correctly when certificates are revoked or revocation status cannot be determined.

### Outcomes

- UDAP DCR validates revocation status of client chains
- UDAP token authentication validates revocation status of client chains
- framework-specific revocation failures return clear OAuth / DCR errors
- CRLs are cached with explicit TTL and fetch policy

### Design

Revocation checking should run as part of UDAP chain validation in [udap.ts](../fhir-server/src/auth/frameworks/udap.ts).

Expected behavior:

- for each non-root certificate in the chain:
  - read CRL Distribution Points
  - fetch the CRL
  - verify the CRL signature against the issuing CA
  - check whether the certificate serial is revoked

Recommended initial policy:

- if a certificate requires revocation checking and no valid CRL can be obtained, fail closed
- cache CRLs per URL with TTL
- start with one CRL per issuing CA

### Implementation Checklist

- [ ] Add CRL parsing / verification helper under `src/auth/`
  - parse CRL DP URLs from certificates
  - fetch CRLs
  - validate CRL issuer signature
  - compare revoked serials against certificate serials

- [ ] Add a CRL cache layer
  - key by CRL URL
  - TTL by HTTP cache headers when available
  - fallback default TTL for demo use

- [ ] Integrate CRL checking into UDAP certificate path validation in [udap.ts](../fhir-server/src/auth/frameworks/udap.ts)
  - registration-time software statement validation
  - token-time client assertion validation

- [ ] Add clear error mapping
  - revoked cert -> `unapproved_software_statement` or `invalid_client`
  - CRL unavailable / invalid -> fail-closed error with explicit description

- [ ] Add demo revocation controls for tests
  - static revoked fixture
  - or in-memory revocation list mutation for harness tests

- [ ] Consider whether signed metadata generation should also model revocation status for metadata leaves
  - publication is phase 1
  - active validation by external tools is already covered
  - local server-side validation of its own metadata is not required

### Phase 2 Testing

- [ ] Unit tests for:
  - CRL DP extraction
  - CRL signature verification
  - serial-number revocation matching
  - cache behavior

- [ ] Registration tests:
  - trusted non-revoked client succeeds
  - revoked client cert fails with `unapproved_software_statement`
  - invalid CRL signature fails closed
  - missing CRL fetch fails closed

- [ ] Token-auth tests:
  - registered client with revoked cert fails `invalid_client`
  - registered client with good cert still succeeds

- [ ] Demo-surface tests:
  - default discovery still works
  - CRL endpoints remain coherent across default surfaces

### Phase 2 Exit Criteria

- UDAP registration and token auth both consult CRLs
- revoked client certificates are rejected
- CRL fetch/signature failures fail closed
- tests cover both demo EC and demo RSA roots

## Likely File Targets

Phase 1:

- [app.ts](../fhir-server/src/app.ts)
- [demo-frameworks.ts](../fhir-server/src/auth/demo-frameworks.ts)
- [udap-server-metadata.ts](../fhir-server/src/auth/udap-server-metadata.ts)
- new CRL helper under `src/auth/`
- [README.md](../fhir-server/README.md)

Phase 2:

- [udap.ts](../fhir-server/src/auth/frameworks/udap.ts)
- new CRL cache / fetch / verify helper under `src/auth/`
- UDAP registration and token-auth tests under `test/`

## Risks and Tradeoffs

- Static bundled leaf certificates are convenient but awkward for runtime-correct CRL DPs.
- Runtime-generated leaves are slightly more complex but are a better fit for a server whose origin is not fixed.
- Full CRL validation in-process may require either:
  - careful use of Node/Bun crypto primitives, or
  - pragmatic use of OpenSSL for parts of the verification path

The plan should prefer correctness and testability over minimizing code size.

## Open Questions

These are not blockers for Phase 1:

- Do we want PEM CRLs, DER CRLs, or both?
- Should demo client certificates become fully runtime-generated rather than bundled?
- Do we want an internal test-only endpoint or helper to revoke demo serials dynamically?

## Recommendation

Do this in two steps:

- **Phase 1**: make the demo PKI publish revocation metadata correctly so external validators can trust the chain
- **Phase 2**: make the server consume that revocation metadata during UDAP validation

That sequence gets the immediate interoperability win without mixing publication and enforcement into one risky change.
