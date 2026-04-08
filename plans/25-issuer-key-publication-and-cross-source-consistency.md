# Plan 25: Issuer Key Publication and Cross-Source Consistency

Status: in progress

Post-review note: Phases 1 and 2 (spec text) are landed on `main`, Phase 3 (issuer-trust policy model + direct-JWKS runtime wiring) is landed on `main`, Phase 4 is a publication-consistency test slice rather than a token-time verifier gate, and Phase 5 (UDAP issuer resolution from `iss`) is now landed on `main`. The current demo holder runtime still uses explicit allowlisted `direct_jwks` policy by default; richer issuer policies exist in the generic verifier and in tests, but remain configured out of the runtime demo holders.

## Goal

Make the spec and the reference implementation honest about how a `PermissionTicket` issuer's signing keys can be discovered, while keeping runtime verification scoped to the selected issuer-trust policy:

- acknowledge in the spec that `${iss}/.well-known/jwks.json` is the common-denominator / fallback publication path, and that issuers participating in a trust framework (OIDF, UDAP) have a framework-native publication path that a verifier may prefer when configured to do so
- keep `PermissionTicket` serialization framework-neutral: framework participation is discovered from `iss`, not encoded into the ticket payload or JOSE header
- introduce a generic issuer-trust policy model so a data holder can explicitly choose whether to resolve issuer trust via direct JWKS, OIDF, UDAP, or a combination of them
- keep the current demo data-holder runtime configured conservatively: allowlisted issuer `iss` URLs with direct JWKS lookup derived from `iss`, while still building and testing the richer OIDF/UDAP capability
- add publication-level tests for multi-method issuers so the signing key a ticket issuer actually uses is published consistently through every enabled mechanism we expose from this repo

## Why This Plan Exists

Three things are currently misaligned:

1. **Spec text is too narrow.** Section 1.14.2 says "Public keys SHALL be exposed via a JWK Set URL". That sentence quietly excludes both OIDF entity configurations and UDAP X.509 cert binding, even though the rest of the spec already names those frameworks as first-class trust paths.

2. **Reference implementation publication and verification are misaligned.**
   - local ticket issuers publish direct JWKS at `${iss}/.well-known/jwks.json`
   - OIDF issuer trust exists as a framework resolver after Plans 21 and 23
   - UDAP issuer discovery from `iss` is not yet implemented for ticket issuers
   - the current verifier does not express an ordered issuer-trust policy; it trusts local issuers in-process and framework issuer trust via built-in behavior

3. **No publication-level guardrail for multi-method issuers.** A misconfigured deployment can publish two different public keys under the same `kid` via two different mechanisms (e.g., one in the issuer's static JWKS, one in its OIDF entity configuration) and we have no test that catches the mismatch at publication time.

4. **Verifier policy is currently implicit instead of explicit.** The demo data holder effectively treats issuer trust as a built-in behavior instead of a configured policy. We need a small explicit policy model so:
   - the generic verifier can support direct JWKS, OIDF, and UDAP issuer resolution
   - the current demo runtime can intentionally stay on direct JWKS only
   - tests can exercise the richer behaviors without enabling them in the default demo holder policy

## Design Decisions (Defaults)

These are the working defaults for this plan. Items still **OPEN** are marked explicitly and live in the *Open Questions* section near the bottom.

### 1. JWKS Is the Common-Denominator Fallback

`${iss}/.well-known/jwks.json` is the publication path every issuer SHOULD support, regardless of any framework participation. It is the path used when:

- the issuer is configured for direct trust only
- the data holder has no framework binding for this issuer
- the verifier is explicitly configured to use direct JWKS as the chosen primary path for this issuer

Issuers that participate in a framework MAY continue to publish JWKS in addition to the framework-native source. When they do, shared `kid` values should remain aligned across those publication surfaces.

### 2. OIDF Issuers Publish via Entity Configuration

This is unchanged from Plans 21/23. The OIDF resolver fetches the leaf entity configuration from `${entityId}/.well-known/openid-federation`, walks the trust chain to a configured anchor, applies metadata policy, and uses the resolved JWKS to verify the `PermissionTicket` JWT.

### 3. Tickets Stay Framework-Neutral

`PermissionTicket` serialization does not vary by trust framework. An issuer's participation in OIDF or UDAP must be discovered verifier-side from `iss` and configured trust sources, not encoded into the ticket payload or JOSE header.

Consequences:

- no framework-specific claims are added to the ticket payload
- no framework-specific JOSE headers such as `x5c` are added just because the issuer participates in a trust framework
- verifier-side trust resolution remains keyed by `iss`

### 4. UDAP Issuer Trust Must Be Rooted In `iss`

If a ticket issuer participates in UDAP, the data holder discovers and evaluates that participation from:

- `GET {iss}/.well-known/udap`
- verifier-side trust policy and trust anchors

This plan does **not** invent a new ticket-level UDAP binding, and it does not alter the `PermissionTicket` payload or JOSE header.

### 5. Issuer Trust Uses An Ordered Declarative Policy List

The verifier does not hardcode a permanent issuer-trust precedence table. Instead, it evaluates an ordered list of issuer-trust policies.

Illustrative shape:

```ts
type IssuerTrustPolicy =
  | {
      type: "direct_jwks";
      trustedIssuers: string[];
    }
  | {
      type: "oidf";
      require?: IssuerTrustPredicate;
    }
  | {
      type: "udap";
      require?: IssuerTrustPredicate;
    };

type IssuerTrustPredicate =
  | { kind: "all"; rules: IssuerTrustPredicate[] }
  | { kind: "any"; rules: IssuerTrustPredicate[] }
  | { kind: "issuer_url_in"; values: string[] }
  | { kind: "oidf_chain_anchored_in"; entityIds: string[] }
  | { kind: "oidf_has_trust_mark"; trustMarkTypes: string[] }
  | { kind: "udap_chains_to"; trustAnchors: string[] };
```

Examples:

```ts
[
  { type: "direct_jwks", trustedIssuers: ["https://issuer-a.example.org/issuer/demo"] },
  {
    type: "oidf",
    require: {
      kind: "all",
      rules: [
        { kind: "oidf_chain_anchored_in", entityIds: ["https://anchor.example.org"] },
        { kind: "oidf_has_trust_mark", trustMarkTypes: ["https://example.org/trust-marks/permission-ticket-issuer"] },
      ],
    },
  },
  {
    type: "udap",
    require: { kind: "udap_chains_to", trustAnchors: ["https://example.org/trust-communities/provider-network"] },
  },
]
```

The first matching policy that successfully resolves issuer trust becomes the primary path. That selected path establishes trust for the incoming ticket.

### 6. Demo Runtime Policy Stays Simple For Now

The current demo data holders are configured with a narrow issuer-trust policy:

```ts
[
  {
    type: "direct_jwks",
    trustedIssuers: [
      "https://.../issuer/reference-demo",
    ],
  },
]
```

For those allowlisted issuer URLs, the verifier derives the common-denominator key publication path from `iss`:

- `${iss}/.well-known/jwks.json`

OIDF and UDAP issuer-resolution capability may still exist in the generic verifier and in tests, but they are not enabled in the current demo holder runtime policy by default.

There is also no special in-process verifier shortcut for those runtime holders. Even for local demo issuers, the direct-JWKS runtime path is modeled as issuer-URL allowlist plus `${iss}/.well-known/jwks.json` resolution.

### 7. Multi-Method Issuer Publication Consistency Is Tested, Not Enforced On The Hot Path

When an issuer is intentionally published through more than one mechanism (for example, direct JWKS plus OIDF), the same signing key material should appear under any shared `kid` values across those publication surfaces.

The reference implementation enforces that invariant with publication-level tests for multi-method issuers. It does **not** require token-endpoint verification to consult every other configured source after the selected primary policy path succeeds.

The check remains **scoped to the kid the JWT actually uses**, not to the entire key set. Two sources may legitimately publish disjoint kid spaces (e.g., a JWKS with kids `K1`/`K2` and an OIDF chain whose leaf publishes only `K3`); only kids that overlap matter.

This remains **opt-in by publication/testing scope**: it matters only for issuers we intentionally expose through more than one source. It is not a mandatory token-time resolution rule for every issuer.

### 8. Cross-Check Direction: Shared `kid` ⇒ Same Public Key

The publication-level check enforces that two sources cannot publish different public keys under the same `kid`. It does **not** enforce the reverse — two sources may publish the same public key under different kids (e.g., RFC 7638 thumbprint vs. framework-assigned label). That reverse direction is theoretical, noisy, and not a security failure.

### 9. Spec Scope

- rewrite the `Keys → Issuer` bullet under §1.14.2 to enumerate the three publication paths
- add a new short subsection "Issuer Key Publication" alongside §1.14.2 that explains:
  - the three publication paths
  - JWKS as the common-denominator fallback
  - that the data holder SHOULD use the most-specific framework path it has configured
  - that implementations exposing the same issuer through multiple sources SHOULD keep shared `kid` values aligned across those publication surfaces

This consistency language is an interoperability/deployment-quality recommendation. In the reference implementation it is covered by publication-level tests for multi-method issuers, not by token-time verifier behavior.

### 10. OIDF Stays as Is for Discovery

Plan 23 already gives us a generic, allowlist-based OIDF resolver. This plan does not change OIDF discovery. The OIDF-related work here is verifier-side policy wiring plus publication-level consistency tests for issuers that we expose through both OIDF and direct JWKS.

We are NOT adding a `direct_jwks_uri` field inside OIDF entity configuration metadata. OIDF already publishes keys; we don't need to teach it to advertise a parallel JWKS URL.

### 11. UDAP Discovery Starts At `/.well-known/udap`

UDAP issuer resolution, when enabled by policy, starts from:

- `GET {iss}/.well-known/udap`

The verifier then applies its configured UDAP policy predicates and trust-anchor rules. This is verifier-side discovery only; it does not alter ticket serialization.

## Target Spec Text (Draft)

In `input/pagecontent/index.md` §1.14.2, replace the current `Keys` block with:

> *   **Keys:**
>     *   **Issuer:** Signs the `PermissionTicket`. Public keys are discovered via the trust framework the issuer participates in:
>         *   **Direct trust (framework-agnostic):** publish via a JWK Set URL rooted at an issuer URL the Data Holder has been pre-configured to trust, e.g. `${iss}/.well-known/jwks.json`. This is the common-denominator fallback.
>         *   **OpenID Federation:** publish keys inside an entity configuration at `${entityId}/.well-known/openid-federation`; verification keys are taken from the resolved trust chain after metadata policy is applied.
>         *   **UDAP:** discover issuer trust from `${iss}/.well-known/udap` using a configured UDAP trust community and verifier-side policy. This specification does not require UDAP participation to alter the `PermissionTicket` payload or JOSE header.
>     *   **Client:** Signs the `ClientAssertion`. Public keys SHALL be registered with the Data Holder or exposed via JWKS.

And add a new subsection §1.14.3 "Issuer Key Publication" (renumber the existing "Error Responses" accordingly) with prose explaining:

- publication path selection from an implementation-defined ordered verifier-side trust policy
- direct JWKS as the common-denominator fallback
- OIDF and UDAP as framework-native discovery paths when the verifier is configured to use them
- that implementations exposing the same issuer through multiple publication paths SHOULD keep shared `kid` values aligned across those surfaces

## Target Reference Implementation Behaviour

### Verification Flow (Per Incoming PermissionTicket)

1. Decode the JWT header. Note `kid`.
2. Evaluate the ordered issuer-trust policy list for the issuer URL (`iss`).
3. Pick a **primary** trust path based on the first policy that both matches and resolves trust:
   - `direct_jwks`: require `iss` to be allowlisted and fetch `${iss}/.well-known/jwks.json`
   - `oidf`: resolve issuer trust through OIDF and apply the configured predicates (allowlist, trust anchor, trust mark, etc.)
   - `udap`: fetch `${iss}/.well-known/udap`, validate against the configured UDAP trust community, and apply the configured predicates
4. Verify the JWT signature against the primary path's resolved key for the JWT's `kid`. Reject if not found.
5. Continue with the rest of `PermissionTicket` validation (audience, expiry, presenter binding, etc.).

In the current demo holder runtime, step 2 evaluates a one-entry policy list:

- `direct_jwks` for allowlisted issuer `iss` URLs only

### Issuer Registry Changes

None in the first implementation slice. Local ticket issuance remains framework-neutral: issuers continue to sign `PermissionTicket` JWTs the same way regardless of framework participation, and verifier-side trust resolution is driven by `iss`.

### Verifier-Side Issuer Trust Policy Config

The verifier-side config model should make the ordered policy list explicit, while still reusing existing OIDF allowlist data where appropriate.

```ts
issuerTrust?: {
  policies: IssuerTrustPolicy[];
}
```

Concrete first-pass expectations:

- `direct_jwks` policies are keyed by allowlisted issuer `iss` URLs
- `oidf` policies may reference the existing `oidf.trustedLeaves` and trust-anchor config
- `udap` policies reference UDAP trust-community / trust-anchor config

This belongs in verifier-side config, not in `auth/issuers.ts`.

## Execution Phases

### Phase 1: Spec Text Update

- rewrite the §1.14.2 `Keys → Issuer` bullet
- add a §1.14.3 "Issuer Key Publication" subsection
- renumber subsequent sections in `index.md`
- this phase is independent of implementation and can land first

Files:
- `input/pagecontent/index.md`

### Phase 2: Corrective Spec Follow-Up

- update the already-landed Phase 1 spec text to remove the earlier ticket-level UDAP wording
- make the new issuer-key publication prose explicitly describe verifier-side discovery from `iss` and ordered policy evaluation
- no TypeScript changes in this corrective phase

Files:
- `input/pagecontent/index.md`

### Phase 3: Issuer Trust Policy Model + Direct-JWKS Runtime Wiring

- add the verifier-side ordered issuer-trust policy model in `store/model.ts`
- wire the current demo data-holder runtime to a single `direct_jwks` policy using allowlisted issuer `iss` URLs
- derive the direct JWKS endpoint from `iss` instead of configuring arbitrary JWKS URLs
- remove the current framework-first plus local-in-process fallback from ticket verification in favor of explicit policy evaluation
- use actual `${iss}/.well-known/jwks.json` resolution for the demo holder runtime, including self-origin loopback rewrite only when the issuer origin is this server's own public origin
- update tests to confirm the current demo holder runtime continues to use only direct JWKS for issuer trust by default

Files:
- `fhir-server/src/store/model.ts`
- `fhir-server/src/config.ts`
- `fhir-server/src/auth/tickets.ts`
- `fhir-server/src/auth/issuers.ts`
- tests covering default runtime policy

### Phase 4: Multi-Method Issuer Publication Consistency Tests

This phase adds guardrails for issuers we publish through more than one mechanism, without turning that guardrail into a token-time verifier requirement.

- add tests that fetch/resolve the same issuer through direct JWKS and OIDF and assert that the actual signing `kid` maps to the same public key through both paths
- add a negative fixture that proves the publication-consistency helper detects disagreement on a shared `kid`
- add a regression test that the runtime verifier continues to trust the selected primary source only and does not reject a ticket merely because a secondary configured source would disagree
- current demo data-holder runtime remains direct-JWKS-only by default

Files:
- `fhir-server/test/issuer-key-cross-source.test.ts`
- small cleanup in runtime verifier code to remove any hot-path cross-source enforcement

### Phase 5: UDAP Issuer Resolution From `iss`

- add verifier-side UDAP issuer discovery starting from `${iss}/.well-known/udap`
- express admission rules through the ordered policy model rather than ticket content
- add tests that exercise UDAP issuer capability under explicit policy without enabling it in the default demo holder runtime
- if any required UDAP issuer-side metadata turns out to be incompatible with a pure ticket issuer, stop and spin that part into a follow-on plan rather than changing ticket serialization

Files:
- `fhir-server/src/store/model.ts`
- `fhir-server/src/auth/frameworks/udap.ts`
- `fhir-server/src/auth/tickets.ts`
- `fhir-server/test/udap-issuer-trust.test.ts`
- `fhir-server/README.md`
- `plans/25-issuer-key-publication-and-cross-source-consistency.md`

### Phase 6: README and Plan Status

- README section "Issuer Key Publication" that mirrors the spec subsection but with reference-implementation specifics:
  - precedence rule
  - direct-JWKS default runtime policy
  - publication-consistency test semantics for multi-method issuers
  - how to configure each path
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
- `fhir-server/src/auth/frameworks/udap.ts`
- `fhir-server/src/store/model.ts`
- `fhir-server/test/issuer-key-cross-source.test.ts` (new)
- `fhir-server/test/udap-issuer-trust.test.ts` (new)
- `fhir-server/README.md`
- `plans/00-metaplan.md`

## Non-Goals

- No ticket-level UDAP signaling such as `x5c` added solely because the issuer participates in UDAP
- No advertising of direct JWKS URLs inside OIDF entity configurations
- No token-time verifier requirement to consult every available source after the selected issuer-trust policy path succeeds
- No new persistence mechanism beyond the demo crypto bundle introduced in Plan 24
- No support for issuer key rotation choreography — that is a separate concern; this plan only ensures that whatever is published is consistent at any given moment
- No automatic discovery of unconfigured framework participation — the data holder still only consults sources that have been explicitly allowlisted for the issuer
- No special in-process issuer-verification shortcut for the current demo holder runtime; default runtime behaviour should match its configured direct-JWKS policy

## Resolved Decisions (Formerly Open Questions)

### Former OQ-1 — UDAP issuer discovery shape

Resolved: verifier-side discovery starts from `GET {iss}/.well-known/udap`, and `PermissionTicket` serialization remains framework-neutral.

### Former OQ-3 — Cross-source consistency handling

Resolved: keep the runtime verifier scoped to the selected primary issuer-trust path. Multi-method consistency is enforced with publication-level tests, not token-time secondary-source fetching.

### Former OQ-8 — Primary-path failure handling

Resolved: strict mode by default. If the chosen primary path fails, verification fails closed rather than silently falling through to lower-precedence sources.

## Open Questions

These are explicit decision points where the plan currently uses a default and the user (or reviewer) may want to override before implementation starts. Each open question lists the default and the alternatives.

### OQ-4 — Cross-check semantics

**Default:** shared `kid` ⇒ same public key. Different kids never conflict; same key under different kids never conflicts.

**Alternatives:**
- (a) shared key ⇒ same `kid` (catches reverse-direction relabeling — noisy and theoretical)
- (b) both directions

### OQ-5 — Spec normative weight

**Default:** the spec rewrite enumerates the three publication paths, JWKS is the common-denominator fallback, and implementations that publish the same issuer through multiple mechanisms are encouraged to keep shared `kid` values aligned. The reference implementation covers that with tests rather than a token-time hard check.

**Alternatives:**
- (a) make multi-source consistency a SHALL in the spec
- (b) drop multi-source language from the spec entirely; document only in the README

### OQ-6 — OIDF advertising of direct JWKS URLs

**Default:** OIDF entity configurations are not extended to advertise a `direct_jwks_uri`. OIDF publishes keys natively; cross-check uses the data holder's separately-configured allowlist for direct JWKS.

**Alternative:** add a `direct_jwks_uri` field to the OIDF metadata so a data holder can discover the parallel JWKS URL from the OIDF chain — easier for operators but couples two trust frameworks at the metadata level.

### OQ-7 — Policy ordering

**Default:** verifier-side issuer trust uses an explicit ordered policy list. The current demo holder runtime starts with a single `direct_jwks` policy; richer orders such as `oidf -> udap -> direct_jwks` are expressible when desired.

**Alternative:** fixed built-in precedence unrelated to configured policy order.

## Codex Review Notes

I applied a few plan edits directly while reviewing because they tighten the design without changing the overall shape:

- changed primary-path failure from fallback-by-default to strict failure-by-default
- clarified that verifier-side issuer trust-source config belongs in the config model, not in `auth/issuers.ts`
- aligned the plan with the rule that `PermissionTicket` serialization is framework-neutral and that any future UDAP issuer support must be discovered from `iss`
- added an ordered declarative issuer-trust policy model so richer OIDF/UDAP behavior can exist in the generic verifier while the current demo holder runtime remains direct-JWKS-only by policy
- narrowed multi-method consistency from a token-time verifier gate to a publication-level test/admin invariant

### Overall

The plan direction is good and worth doing. The spec problem is real, the reference implementation already has enough OIDF/JWKS surface to land the first hardening phase, and publication-level multi-method issuer consistency checks are a good guardrail without complicating the runtime verifier.

### Former OQ-1 — UDAP issuer discovery

This is now resolved in the plan body:

- discovery starts from `{iss}/.well-known/udap`
- the ticket stays framework-neutral
- verifier-side policy decides whether UDAP resolution is enabled and what trust anchors/community rules apply

### OQ-3 — Cross-source consistency handling

I no longer think this belongs on the token path by default.

Reason:
- the selected issuer-trust policy path is sufficient to establish trust for the incoming ticket
- forcing every secondary source to be live and mutually consistent on every request couples availability and security more tightly than needed
- the real invariant we care about is that issuers we publish through multiple mechanisms do not drift apart, and that is better caught in tests/admin checks than per-request runtime logic

So the plan now reflects a simpler stance:
- runtime verifier trusts the selected primary source
- multi-method publication consistency is covered by tests for issuers we publish from this repo

### OQ-7 and OQ-8 — Policy ordering and primary failure fallback

I agree with using an explicit ordered policy list rather than hardcoding one permanent precedence table. Under any such ordering, I recommend rejecting the fallback default in OQ-8.

Reason:
- precedence only means something if failure of a higher-precedence configured source is significant
- if OIDF is configured for the issuer and OIDF fails, silently falling through to JWKS weakens the intended trust semantics and can hide real misconfiguration or attack conditions
- the same problem applies to UDAP -> JWKS fallback

My recommendation, now reflected in the edited default:
- use an explicit ordered policy list
- make **primary failure terminal by default** in the reference implementation
- if you want an operator escape hatch later, make that an explicit opt-in config, not the default

### Phase ordering

I agree with the current ordering after the corrective spec follow-up: direct-JWKS runtime policy first, then JWKS + OIDF publication-consistency tests, then UDAP issuer support.

Reason:
- the corrective spec commit has to repair the earlier ticket-level UDAP wording first
- direct-JWKS runtime policy needs to be explicit before we add richer capability that remains disabled by default
- JWKS + OIDF already exist
- that lands the first publication-level disagreement tripwire immediately
- it proves the multi-method issuer invariant before UDAP is added as a third source

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
- so publication-level tests can compare OIDF-published keys with direct JWKS without widening the production trust result

There is no major OIDF blocker.

### Demo runtime vs generic verifier behavior

The key runtime distinction is now explicit:

- the generic verifier can support direct JWKS, OIDF, and UDAP issuer resolution under ordered policy
- the current demo holder runtime stays configured to direct JWKS only
- richer OIDF/UDAP issuer behaviors are built and tested under explicit policy, not turned on by default in the runtime demo holders

Plan is implementation-ready. Phases 1 through 5 are now landed, and Phase 6 (README / final plan status) is the next discrete implementation commit.

## Acceptance Criteria

- Spec §1.14.2 acknowledges three publication paths and the new §1.14.3 explains publication and selection
- The reference implementation can verify a `PermissionTicket` issued by:
  - a JWKS-only issuer
  - an OIDF-backed issuer when OIDF issuer policy is enabled
  - a UDAP-backed issuer when UDAP issuer policy is enabled
- The default demo holder runtime verifies allowlisted issuer `iss` URLs by deriving `${iss}/.well-known/jwks.json` and does not enable OIDF/UDAP issuer resolution by default
- Tests cover multi-method issuer publication consistency, including the disagreement-on-shared-kid failure case
- Runtime verification follows the selected issuer-trust policy path and does not require secondary-source agreement after the primary path succeeds
- README documents the publication, precedence, and consistency model
- `plans/00-metaplan.md` marks Plan 25 complete on `main`
