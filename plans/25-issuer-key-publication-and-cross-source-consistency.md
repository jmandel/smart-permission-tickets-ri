# Plan 25: Issuer Key Publication and Cross-Source Consistency

Status: proposed

## Goal

Make the spec and the reference implementation honest about how a `PermissionTicket` issuer's signing keys can be discovered, and harden the verifier against multi-source key disagreement:

- acknowledge in the spec that `${iss}/.well-known/jwks.json` is the common-denominator / fallback publication path, and that issuers participating in a trust framework (OIDF, UDAP) have a framework-native publication path that takes precedence
- give the reference implementation an actual UDAP-backed issuer story (today our ticket issuer can only publish via JWKS, even though our data holder already speaks UDAP)
- when more than one publication source is reachable for a given issuer, require that all sources agree on the public key for any `kid` that an actual incoming `PermissionTicket` JWT used to sign itself — fail closed on disagreement

## Why This Plan Exists

Three things are currently misaligned:

1. **Spec text is too narrow.** Section 1.14.2 says "Public keys SHALL be exposed via a JWK Set URL". That sentence quietly excludes both OIDF entity configurations and UDAP X.509 cert binding, even though the rest of the spec already names those frameworks as first-class trust paths.

2. **Reference implementation only knows two of the three paths for issuer keys.**
   - Direct JWKS at `${iss}/.well-known/jwks.json`: implemented in `auth/issuers.ts`
   - OIDF entity configuration via the leaf entity ID: implemented in `auth/frameworks/oidf/resolver.ts` after Plans 21 and 23
   - UDAP X.509 cert binding: **not implemented for issuers**. The data holder publishes its own UDAP discovery document at `${fhirBaseUrl}/.well-known/udap`, but issuers have no UDAP identity, no per-issuer cert material, and no way to sign a `PermissionTicket` with `x5c` in the header.

3. **No defense against multi-source disagreement.** A misconfigured deployment can publish two different public keys under the same `kid` via two different mechanisms (e.g., one in the issuer's static JWKS, one in its OIDF entity configuration) and the data holder will silently accept whichever path it consults first. There is no tripwire.

## Design Decisions (Defaults)

These are the working defaults for this plan. Items still **OPEN** are marked explicitly and live in the *Open Questions* section near the bottom.

### 1. JWKS Is the Common-Denominator Fallback

`${iss}/.well-known/jwks.json` is the publication path every issuer SHOULD support, regardless of any framework participation. It is the path used when:

- the issuer is configured for direct trust only
- the data holder has no framework binding for this issuer
- the verifier is explicitly configured to use direct JWKS as the chosen primary path for this issuer

Issuers that participate in a framework MAY continue to publish JWKS in addition to the framework-native source. When they do, the cross-source consistency check (decision 5 below) applies.

### 2. OIDF Issuers Publish via Entity Configuration

This is unchanged from Plans 21/23. The OIDF resolver fetches the leaf entity configuration from `${entityId}/.well-known/openid-federation`, walks the trust chain to a configured anchor, applies metadata policy, and uses the resolved JWKS to verify the `PermissionTicket` JWT.

### 3. UDAP Issuers Sign with `x5c`, Not via `.well-known/udap`

A UDAP-bound issuer does **not** publish a `.well-known/udap` discovery document. The FAST IG `.well-known/udap` document has REQUIRED fields (`token_endpoint`, `registration_endpoint`, `udap_profiles_supported`, `grant_types_supported`, etc.) that don't apply to a pure ticket issuer; filling them with stubs would be non-conformant, and inventing a parallel `.well-known/udap-issuer` path would invent a new convention nobody else honours.

Instead:

- the issuer signs each `PermissionTicket` JWT with a UDAP-issued X.509 certificate
- the JWT's JOSE header carries the certificate chain in `x5c`
- the verifier validates the chain to a configured UDAP community trust anchor on each verification
- the verification public key is extracted from the leaf certificate in `x5c`

This matches how UDAP client authentication already works at the data holder's token endpoint (the same `x5c` JWT pattern), so the verifier can reuse cert-chain validation code.

The issuer URL itself is still discoverable via direct JWKS at `${iss}/.well-known/jwks.json` for the common-denominator fallback case.

### 4. Per-Issuer UDAP Cert Material

For an issuer to sign with a UDAP cert it needs cert material. The default loading model:

- if the demo crypto bundle (Plan 24) contains `ticketIssuers[<slug>].udap` material, use it
- otherwise, if a UDAP framework with CA material is configured for the issuer, mint a leaf certificate at boot using an extracted generic UDAP leaf-cert helper derived from the current metadata-signing pathway, keyed by issuer slug instead of `fhirBaseUrl`
- otherwise, the issuer is not UDAP-capable; it remains JWKS-only and OIDF-only

The bundle schema gains an optional `udap` block per ticket issuer:

```json
{
  "ticketIssuers": {
    "reference-demo": {
      "privateJwk": { "...": "..." },
      "udap": {
        "framework": "https://smarthealthit.org/trust-frameworks/reference-demo-udap",
        "certificateChainPem": "-----BEGIN CERTIFICATE-----...",
        "privateKeyPem": "-----BEGIN PRIVATE KEY-----..."
      }
    }
  }
}
```

The bundle generator (`scripts/generate-demo-crypto-bundle.ts`) gains a flag or per-issuer toggle to mint a leaf cert under the configured UDAP framework CA.

### 5. Cross-Source Consistency Check

When verifying an incoming `PermissionTicket` JWT, the data holder picks one primary trust path based on framework configuration precedence (OIDF first if configured, then UDAP via `x5c` if present, then direct JWKS). That primary path establishes trust.

If the data holder also has other configured sources for the same issuer, it eagerly consults each configured secondary source and looks up the JWT's actual `kid` in that source's published JWKS. For every secondary source where the `kid` is present, the public key MUST equal the primary source's public key for the same `kid`. If any disagreement is found, verification fails closed with a clear diagnostic. If a configured secondary source cannot be reached or cannot complete its verification work, verification also fails closed by default.

The check is **scoped to the kid the JWT actually uses**, not to the entire key set. Two sources may legitimately publish disjoint kid spaces (e.g., a JWKS with kids `K1`/`K2` and an OIDF chain whose leaf publishes only `K3`); only kids that overlap matter.

The check is also **opt-in by configuration**: it fires only when the data holder has explicitly registered more than one source for an issuer in its allowlist. The plan does not impose mandatory multi-source resolution for issuers that have only one configured source.

### 6. Cross-Check Direction: Shared `kid` ⇒ Same Public Key

The check enforces that two sources cannot publish different public keys under the same `kid`. It does **not** enforce the reverse — two sources may publish the same public key under different kids (e.g., RFC 7638 thumbprint vs. framework-assigned label). That reverse direction is theoretical, noisy, and not a security failure.

### 7. Spec Scope

- rewrite the `Keys → Issuer` bullet under §1.14.2 to enumerate the three publication paths
- add a new short subsection "Issuer Key Publication" alongside §1.14.2 that explains:
  - the three publication paths
  - JWKS as the common-denominator fallback
  - that the data holder SHOULD use the most-specific framework path it has configured
  - that when multiple sources are configured for the same issuer, the data holder is RECOMMENDED (not SHALL) to verify that they do not disagree on shared kids

The cross-source consistency requirement is RECOMMENDED in the spec but enforced as a hard check in the reference implementation (the spec doesn't want to over-specify implementation behaviour for non-reference deployments).

### 8. OIDF Stays as Is for Discovery

Plan 23 already gives us a generic, allowlist-based OIDF resolver. This plan does not change OIDF discovery. The only OIDF-related work is wiring its resolved JWKS into the cross-source check so it can be compared against any same-issuer JWKS or `x5c`-derived key.

We are NOT adding a `direct_jwks_uri` field inside OIDF entity configuration metadata. OIDF already publishes keys; we don't need to teach it to advertise a parallel JWKS URL.

### 9. Algorithm Support for UDAP-Bound Issuer Certs

UDAP-bound issuer cert minting supports both ES256 and RS256 from the start.

- ES256 is the default for UDAP-bound issuers, aligning with the spec's §1.14.2 recommendation that ES256 is the recommended signing algorithm
- RS256 remains supported as an explicit opt-in when the issuer's bundle entry requests it
- the extracted generic UDAP leaf-cert helper must therefore support both EC and RSA leaf-cert minting

## Target Spec Text (Draft)

In `input/pagecontent/index.md` §1.14.2, replace the current `Keys` block with:

> *   **Keys:**
>     *   **Issuer:** Signs the `PermissionTicket`. Public keys are discovered via the trust framework the issuer participates in:
>         *   **Direct trust (framework-agnostic):** publish via a JWK Set URL the Data Holder has been pre-configured to trust, e.g. `${issuerBaseUrl}/.well-known/jwks.json`. This is the common-denominator fallback.
>         *   **OpenID Federation:** publish keys inside an entity configuration at `${entityId}/.well-known/openid-federation`; verification keys are taken from the resolved trust chain after metadata policy is applied.
>         *   **UDAP:** sign each `PermissionTicket` with a UDAP-issued X.509 certificate and carry the certificate chain in the JWT `x5c` header; the Data Holder validates the chain to a configured community trust anchor.
>     *   **Client:** Signs the `ClientAssertion`. Public keys SHALL be registered with the Data Holder or exposed via JWKS.

And add a new subsection §1.14.3 "Issuer Key Publication" (renumber the existing "Error Responses" accordingly) with the prose explaining publication path selection, fallback behaviour, and the RECOMMENDED multi-source consistency check.

## Target Reference Implementation Behaviour

### Verification Flow (Per Incoming PermissionTicket)

1. Decode the JWT header. Note `kid` and the presence/absence of `x5c`.
2. Resolve the issuer URL (`iss`) against the configured framework allowlists in this order: OIDF, UDAP, direct JWKS.
3. Pick a **primary** trust path:
   - if an OIDF allowlist entry matches `iss`, use OIDF; resolve trust chain; extract JWKS for the leaf
   - else if `x5c` is present and a UDAP framework anchor is configured for this issuer, use UDAP; validate cert chain; extract leaf cert public key
   - else use direct JWKS; fetch `${iss}/.well-known/jwks.json`
4. Verify the JWT signature against the primary path's resolved key for the JWT's `kid`. Reject if not found.
5. **Cross-source check.** For every other source that is also explicitly configured for this issuer, attempt to resolve key material for the same `kid`. For every source that has the `kid`, assert public key equality with the primary path. Reject on any disagreement. Reject by default if a configured secondary source is unreachable or cannot complete verification.
6. Continue with the rest of `PermissionTicket` validation (audience, expiry, presenter binding, etc.).

### Issuer Registry Changes

`auth/issuers.ts` gains optional `udap` binding per issuer:

```ts
type TicketIssuerEntry = {
  slug: string;
  url: string;
  privateJwk: JsonWebKey;
  udap?: {
    framework: string;
    certificateChainPem: string[];
    privateKeyPem: string;
  };
};
```

When `udap` is present, the issuer signs `PermissionTicket` JWTs with `signRs256JwtWithPem` (or ES variant) and sets `x5c` in the header.

### Multi-Source Allowlist (Verifier-Side Config)

The OIDF allowlist from Plan 23 already exposes `trustedLeaves[].expectedIssuerUrl`. Add parallel allowlists for direct JWKS issuers and UDAP-bound issuers in the verifier-side config model, all keyed by `iss` URL so the verifier can index them in one pass:

```ts
issuerTrust?: {
  jwks: Array<{ iss: string; jwksUri: string }>;
  udap: Array<{ iss: string; framework: string; trustAnchorPem: string }>;
  // OIDF entries continue to live under the existing oidf.trustedLeaves
}
```

(Concrete shape is a Phase-1 design call by Codex; the principle is "all three sources reachable through one indexed lookup" and it belongs in verifier-side config, not in `auth/issuers.ts`.)

## Execution Phases

### Phase 1: Spec Text Update

- rewrite the §1.14.2 `Keys → Issuer` bullet
- add a §1.14.3 "Issuer Key Publication" subsection
- renumber subsequent sections in `index.md`
- this phase is independent of implementation and can land first

Files:
- `input/pagecontent/index.md`

### Phase 2: Cross-Source Consistency Check (JWKS + OIDF Only)

This is the highest-value implementation phase because it works with the two key publication mechanisms we *already* have. UDAP issuer support comes later.

- introduce a `resolveIssuerJwks(iss, kid)` helper that consults every configured source for the issuer and returns a `Map<sourceLabel, publicJwk | undefined>` for the requested `kid`
- in ticket verification, after primary verification succeeds, call the helper and assert all returned keys for the chosen `kid` are equal
- on disagreement, fail with a clear error: `OIDF issuer key for kid <kid> disagrees with direct JWKS for issuer <iss>`
- add tests:
  - JWKS-only issuer verifies cleanly
  - OIDF-only issuer verifies cleanly (already covered by Plan 23, but assert the new code path doesn't break it)
  - JWKS + OIDF agree → pass
  - JWKS + OIDF disagree on the JWT's kid → reject with specific error
  - JWKS + OIDF disagree on a different kid the JWT does NOT use → pass (kid scoping)

Files:
- `fhir-server/src/auth/tickets.ts`
- `fhir-server/src/auth/issuers.ts`
- `fhir-server/src/auth/frameworks/oidf/resolver.ts` (small surface to expose resolved JWKS for cross-check)
- new test file `fhir-server/test/issuer-key-cross-source.test.ts`

### Phase 3: Per-Issuer UDAP Cert Material in the Bundle

- extend the demo crypto bundle schema with optional `ticketIssuers[<slug>].udap`
- extract a generic UDAP leaf-cert generation helper from the current metadata-signing pathway, then update `scripts/generate-demo-crypto-bundle.ts` to mint a leaf cert per issuer under the existing demo UDAP CA when generating
- update bundle loader/validator
- no signing behaviour changes yet — this phase only loads cert material into memory

Files:
- `fhir-server/src/demo-crypto-bundle.ts`
- `scripts/generate-demo-crypto-bundle.ts`
- bundle test extensions

### Phase 4: Issuer Signs With `x5c` When UDAP-Bound

- when a `TicketIssuerEntry` has `udap` material, the issuer signing path includes the cert chain in the JWT `x5c` header
- the extracted generic UDAP leaf-cert helper supports both EC and RSA leaf certs; ES256 is the default for UDAP-bound issuers and RS256 is an explicit opt-in via bundle/config
- existing JWKS-based signing remains the path when `udap` is absent
- regenerate any test fixtures that hardcode JWT shape

Files:
- `fhir-server/src/auth/issuers.ts`
- `fhir-server/src/auth/x509-jwt.ts`
- ticket-signing tests

### Phase 5: UDAP Issuer-Trust Resolver

- add `auth/frameworks/udap.ts` `resolveIssuerTrust(iss, jwtHeader)` that:
  - extracts `x5c` from the supplied JOSE header
  - validates the cert chain to a configured UDAP community trust anchor for the matching framework
  - extracts the leaf cert public key as a JWK
  - returns issuer trust with that JWK
- wire it into the verification precedence chain
- failure modes have explicit diagnostics ("UDAP cert chain for issuer X did not validate against any configured anchor", "issuer X is UDAP-bound in config but JWT header has no x5c", etc.)

Files:
- `fhir-server/src/auth/frameworks/udap.ts`
- `fhir-server/src/auth/tickets.ts`
- new tests in `fhir-server/test/udap-issuer-trust.test.ts`

### Phase 6: Cross-Source Check Includes UDAP

- extend the Phase 2 cross-source helper to include UDAP-derived public keys
- tests for the full matrix:
  - JWKS + UDAP agree → pass
  - JWKS + UDAP disagree on JWT's kid → reject
  - OIDF + UDAP agree → pass
  - OIDF + UDAP disagree → reject
  - all three configured + agree → pass
  - all three configured + one disagrees → reject and the diagnostic identifies which source disagrees

Files:
- `fhir-server/src/auth/tickets.ts`
- extended `fhir-server/test/issuer-key-cross-source.test.ts`

### Phase 7: README and Plan Status

- README section "Issuer Key Publication" that mirrors the spec subsection but with reference-implementation specifics:
  - precedence rule
  - cross-source check semantics
  - how to configure each path
  - how to opt out of cross-source checking (if we expose a flag)
- update `plans/00-metaplan.md` and mark Plan 25 complete on `main`

Files:
- `fhir-server/README.md`
- `plans/00-metaplan.md`
- `plans/25-issuer-key-publication-and-cross-source-consistency.md`

## File Impact

Expected primary files (consolidated from phases above):

- `input/pagecontent/index.md` (spec)
- `fhir-server/src/auth/issuers.ts`
- `fhir-server/src/auth/tickets.ts`
- `fhir-server/src/auth/frameworks/oidf/resolver.ts`
- `fhir-server/src/auth/frameworks/udap.ts`
- `fhir-server/src/auth/x509-jwt.ts`
- `fhir-server/src/demo-crypto-bundle.ts`
- `scripts/generate-demo-crypto-bundle.ts`
- `fhir-server/test/issuer-key-cross-source.test.ts` (new)
- `fhir-server/test/udap-issuer-trust.test.ts` (new)
- `fhir-server/README.md`
- `plans/00-metaplan.md`

## Non-Goals

- No literal `.well-known/udap` publication for ticket issuers (use JWT `x5c` header instead)
- No advertising of direct JWKS URLs inside OIDF entity configurations
- No mandatory cross-source check at the spec level — only RECOMMENDED in the spec, enforced in the reference implementation
- No new persistence mechanism beyond the demo crypto bundle introduced in Plan 24
- No support for issuer key rotation choreography — that is a separate concern; this plan only ensures that whatever is published is consistent at any given moment
- No automatic discovery of unconfigured framework participation — the data holder still only consults sources that have been explicitly allowlisted for the issuer

## Resolved Decisions (Formerly Open Questions)

### Former OQ-3 — Cross-source check eagerness

Resolved: eager across explicitly configured sources. If an issuer has multiple configured trust sources, the verifier consults all of them for the JWT's actual `kid` and requires agreement.

### Former OQ-8 — Primary-path failure handling

Resolved: strict mode by default. If the chosen primary path fails, verification fails closed rather than silently falling through to lower-precedence sources.

## Open Questions

These are explicit decision points where the plan currently uses a default and the user (or reviewer) may want to override before implementation starts. Each open question lists the default and the alternatives.

### OQ-1 — UDAP issuer publication shape

**Default:** the issuer signs each `PermissionTicket` JWT with a UDAP-issued X.509 cert and carries `x5c` in the JOSE header. No `.well-known/udap` document is published for the issuer.

**Alternatives:**
- (a) publish a literal `.well-known/udap` document with stub values for inapplicable required fields (token endpoint, registration endpoint, etc.) — non-conformant
- (b) publish a stripped-down variant at a new path like `${iss}/.well-known/udap-issuer-metadata` carrying only `signed_metadata` for key/cert binding — invents a new convention

### OQ-2 — UDAP cert source for issuers

**Default:** loaded from `bundle.ticketIssuers[<slug>].udap` if present, otherwise minted at boot from the configured UDAP framework CA using an extracted generic leaf-cert helper, keyed by issuer slug.

**Alternatives:**
- (a) bundle-only — fail loudly if missing
- (b) boot-mint-only — never read from bundle

### OQ-4 — Cross-check semantics

**Default:** shared `kid` ⇒ same public key. Different kids never conflict; same key under different kids never conflicts.

**Alternatives:**
- (a) shared key ⇒ same `kid` (catches reverse-direction relabeling — noisy and theoretical)
- (b) both directions

### OQ-5 — Spec normative weight

**Default:** the spec rewrite enumerates the three publication paths, JWKS is the common-denominator fallback, multi-source consistency is RECOMMENDED. The hard cross-source check is enforced only in the reference implementation, documented in the README.

**Alternatives:**
- (a) make multi-source consistency a SHALL in the spec
- (b) drop multi-source language from the spec entirely; document only in the README

### OQ-6 — OIDF advertising of direct JWKS URLs

**Default:** OIDF entity configurations are not extended to advertise a `direct_jwks_uri`. OIDF publishes keys natively; cross-check uses the data holder's separately-configured allowlist for direct JWKS.

**Alternative:** add a `direct_jwks_uri` field to the OIDF metadata so a data holder can discover the parallel JWKS URL from the OIDF chain — easier for operators but couples two trust frameworks at the metadata level.

### OQ-7 — Precedence order

**Default:** OIDF → UDAP (via `x5c`) → direct JWKS.

**Alternative:** any deployment-configurable precedence (introduces config surface area).

## Codex Review Notes

I applied a few plan edits directly while reviewing because they tighten the design without changing the overall shape:

- changed the cross-source check default from opportunistic to eager across explicitly configured sources
- changed primary-path failure from fallback-by-default to strict failure-by-default
- clarified that verifier-side issuer trust-source config belongs in the config model, not in `auth/issuers.ts`
- clarified that UDAP issuer cert minting needs an extracted generic leaf-cert helper; `buildSignedUdapMetadata` is not itself the reusable abstraction

### Overall

The plan direction is good and worth doing. The spec problem is real, the reference implementation already has enough OIDF/JWKS surface to land the first hardening phase, and the multi-source disagreement check is a real security improvement.

### OQ-1 — UDAP issuer publication shape

I agree with the default.

Reason:
- the current UDAP discovery implementation in `fhir-server/src/app.ts` and `fhir-server/src/auth/udap-server-metadata.ts` is clearly authorization-server / registration-surface metadata, not a generic issuer-key publication document
- a pure ticket issuer does not have meaningful `token_endpoint`, `registration_endpoint`, `grant_types_supported`, etc.
- publishing a literal `.well-known/udap` document for a pure ticket issuer would be misleading at best and non-conformant at worst

So for issuer-side UDAP binding, `x5c` on the JWT is the right default.

### OQ-2 — UDAP cert source for issuers

The default is acceptable, but the implementation note matters:

- bundle-backed material is the stable path and should be preferred when present
- boot-mint fallback is acceptable for zero-config demo behavior
- the minting implementation must come from an extracted generic helper, not direct reuse of `buildSignedUdapMetadata`

I would keep the default, but the plan now needs to assume that extraction step explicitly.

### OQ-3 — Cross-source check eagerness

I did **not** agree with the earlier draft default. I recommended changing the implementation default from **opportunistic** to **eager across all explicitly configured sources for that issuer**.

Reason:
- opportunistic checking is easy to bypass operationally: if one secondary source is down or skipped, the disagreement tripwire silently disappears
- the plan already says sources are explicitly allowlisted; this is not internet-wide speculative fetching
- the main value of the feature is exactly that explicitly configured parallel sources are expected to agree

So my recommendation is now reflected in the edited default:
- if multiple sources are configured for the issuer, consult all of them for the JWT's actual `kid`
- if a configured secondary source is unreachable, treat that as a verification failure by default in the reference implementation

That dovetails with OQ-8 below.

### OQ-7 and OQ-8 — Precedence and primary failure fallback

I agree with the **precedence order** `OIDF -> UDAP(x5c) -> direct JWKS`, but I recommend rejecting the current fallback default in OQ-8.

Reason:
- precedence only means something if failure of a higher-precedence configured source is significant
- if OIDF is configured for the issuer and OIDF fails, silently falling through to JWKS weakens the intended trust semantics and can hide real misconfiguration or attack conditions
- the same problem applies to UDAP -> JWKS fallback

My recommendation, now reflected in the edited default:
- keep `OIDF -> UDAP -> JWKS` as the selection order
- make **primary failure terminal by default** in the reference implementation
- if you want an operator escape hatch later, make that an explicit opt-in config, not the default

### Phase ordering

I agree with the current ordering: Phase 2 before UDAP work is the right call.

Reason:
- JWKS + OIDF already exist
- that lands the first real disagreement tripwire immediately
- it forces the cross-source helper abstraction to exist before UDAP is added as a third source

So I would keep the current phase order.

### Multi-Source Allowlist home

I do **not** think `auth/issuers.ts` is the right home.

Reason:
- `auth/issuers.ts` is the local issuer implementation/registry, not the verifier-side trust-source configuration surface
- the new setting is about how the data holder evaluates external or framework-backed issuers
- conceptually it belongs next to other verifier-side trust config in `store/model.ts`, then consumed by the framework/verification layer

My recommendation:
- introduce a verifier-side config surface in `store/model.ts` for issuer trust sources
- keep local issuer mechanics in `auth/issuers.ts`

### OIDF resolver exposure

The good news is that Phase 2 is not blocked here.

Current state:
- `OidfFrameworkResolver.resolveIssuerTrust()` already returns `ResolvedIssuerTrust`
- that object already includes `publicJwks`
- so the cross-source helper can already consume OIDF-resolved keys without widening the core trust result much further

Likely Phase-2 need:
- expose a small source label / helper path so the disagreement diagnostic can say exactly which source produced which key

But there is no major OIDF blocker.

### UDAP cert minting is under-specified today

This is the biggest implementation gap in the current plan text.

The current helper `buildSignedUdapMetadata` is **not** a drop-in issuer-cert solution:
- it is oriented around UDAP discovery metadata signing, not generic issuer cert material
- it is keyed by `fhirBaseUrl`
- its internal generation path is RSA-oriented today

So the plan should assume:
- extract a generic leaf-cert material helper first
- parameterize it by issuer URL / subject URI
- then reuse that lower-level helper for both metadata-signing and issuer-signing cases

Related design decision you should settle before implementation:
- how the bundle/config surface expresses the RS256 opt-in for issuers that do not want the ES256 default

The current codebase can verify both ES256 and RS256 X.509 JWTs in `auth/x509-jwt.ts`, but the minting side is not symmetric yet.

Plan is implementation-ready; Phase 1 (spec text only) is the next discrete commit.

## Acceptance Criteria

- Spec §1.14.2 acknowledges three publication paths and the new §1.14.3 explains publication and selection
- The reference implementation can verify a `PermissionTicket` issued by:
  - a JWKS-only issuer
  - an OIDF-only issuer
  - a UDAP-only issuer (signs with `x5c`)
- The verifier rejects a `PermissionTicket` whose JWT `kid` resolves to different public keys via two configured sources
- The verifier accepts a `PermissionTicket` whose two configured sources publish disjoint kid spaces (no overlap on the JWT's actual `kid`)
- The demo crypto bundle can carry per-issuer UDAP cert material; the generator script can produce it; bundle-backed startup can load it
- Tests cover all path-pair combinations and the disagreement-on-shared-kid failure case
- README documents the publication, precedence, and consistency model
- `plans/00-metaplan.md` marks Plan 25 complete on `main`
