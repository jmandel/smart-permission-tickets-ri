# Plan 12: Permission Ticket Spec and Implementation Alignment

## Goal

Close the main gaps between:

- the current Permission Ticket specification in [PermissionTicket.fsh](../../input/fsh/PermissionTicket.fsh) and [index.md](../../input/pagecontent/index.md)
- the current reference server behavior in `reference-implementation/fhir-server`
- the current demo UX assumptions

This plan covers the ten issues identified in review and sorts them into:

- immediate implementation fixes
- immediate spec clarifications
- larger follow-on implementation work
- items that are low value or intentionally deferred

## Summary Decisions

### Keep In Spec and Implement

1. `exp` remains required
2. `aud` keeps both URL and trust-framework modes
3. ticket revocation remains normative and should be implemented
4. `cnf.jkt` mismatch should return `invalid_grant`
7. period and sensitivity semantics should be formalized as common Permission Ticket semantics, not wire fields
8. SMART config should advertise `client_credentials` when the server supports it

### Keep In Spec, But Relax Wording

5. do not standardize an exact `aud` error-description string

### Low-Risk Code Cleanup

6. compare `client_binding.binding_type` at enforcement time as defense-in-depth
9. remove dead `proof_jkt`

### Intentionally Deferred

10. only one ticket type is implemented today; the other six remain deferred by scope

## Why This Plan Exists

The server has advanced quickly:

- Plan 8 added trust frameworks, `client_binding`, UDAP, and framework-backed issuer trust
- Plan 9 added demo PKI revocation publication
- Plan 10 added demo client-type UX
- Plan 11 added replay protection and UDAP registration state

That progress exposed a smaller but important class of issues:

- some are true server bugs
- some are spec/server mismatches
- some are really ticket-type-specific schema gaps
- some are low-value exact-wording issues that should not drive implementation

This plan is intended to resolve those in a deliberate order instead of as scattered one-off fixes.

## Scope

### Implement

- enforce required `exp`
- align ticket-binding failures to `invalid_grant`
- advertise supported grant types accurately in SMART config
- remove dead request fields
- harden `client_binding` comparison
- define common period and sensitivity semantics in the spec narrative
- implement framework-aware `aud` validation
- implement ticket revocation checking for revocable and long-lived tickets

### Defer

- implementing the six additional ticket types
- standardizing exact `error_description` wording
- production-grade revocation infrastructure beyond the reference server

## Recommended Order

### Phase 1: Small Code Fixes With Clear Semantics

Address the issues that are unambiguous bugs or cleanup:

- `cnf.jkt` mismatch returns `invalid_grant`
- SMART config advertises `client_credentials` when supported
- remove dead `proof_jkt`
- add `binding_type` comparison in enforcement logic

These are low-risk, high-clarity changes and should land first.

### Phase 2: `exp` Alignment and Demo Semantics

Align the core ticket expiration contract:

- require `exp` in code
- remove true no-`exp` ticket issuance in the demo
- preserve the demo's “never” feeling using a long-lived expiration, e.g. 10 years
- make the UI label honest, e.g. “10 years (demo stand-in for never)”

This preserves the existing demo affordance without weakening the wire contract.

### Phase 3: Common Period and Sensitivity Semantics

Define the currently implicit common semantics for:

- how `authorization.access.periods` is interpreted
- how sensitive data is handled

These are currently real authorization inputs in the server, so they should not remain undefined in the common narrative semantics of the claims model.

### Phase 4: Framework Audience Validation

Replace the current incorrect origin-based audience check with proper recipient matching, then add framework-identifier support.

The server should accept:

- enumerated recipient URLs that match known server audience URLs
- framework identifiers, when the current Data Holder can prove local membership in that framework

The current `audValues.includes(url.origin)` behavior is wrong:

- the spec defines recipient URLs or framework identifiers, not bare request origins
- the server should compare against its explicit token/FHIR audience URLs, not whichever origin happened to receive the request

This is needed for the intended cross-holder network story, even though the current demo network route is still one server/origin.

### Phase 5: Ticket Revocation

Implement ticket revocation checking as distinct work from UDAP/X.509 CRL checking.

This should cover:

- `revocation.url`
- `revocation.rid`
- required `jti` when `revocation` is present
- cache-aware CRL fetch
- fail-closed behavior when revocation status cannot be determined

Long-lived tickets should drive this work:

- for tickets longer than one day, revocation support should be strongly expected

### Phase 6: Spec Cleanup and Conformance Notes

After the server changes land:

- update narrative examples
- relax exact prescribed error-description wording
- document current scope boundaries clearly

## Detailed Work Items

### Item 1: `exp` Is Required In Spec But Optional In Code

#### Assessment

Real gap.

- Spec requires `exp`
- server model makes it optional
- ticket validation only checks it when present

#### Decision

Keep `exp` required in the spec and implement that rule in code.

Do not make the common Permission Ticket model allow no-`exp` tickets just to preserve the demo.

#### Changes

- update [model.ts](../fhir-server/src/store/model.ts) so `PermissionTicket.exp` is required
- update [tickets.ts](../fhir-server/src/auth/tickets.ts) to reject missing `exp`
- update demo ticket creation in [demo.ts](../fhir-server/ui/src/demo.ts) so “never” becomes a long-lived `exp`
- update UI copy and tests accordingly

#### Demo Policy

Keep a demo-friendly long-lived option, but map it to something like:

- `exp = now + 10 years`

and label it clearly as a demo stand-in for indefinite validity.

### Item 2: `aud` Trust-Framework Identifier Mode

#### Assessment

Real implementation gap.

- spec describes URL and framework-audience modes
- current server only matches request origin URL, which is not the right recipient comparison

#### Decision

Keep both modes in the spec and implement framework-aware audience validation in the reference server.

#### Changes

- extend the trust-framework abstraction to answer:
  - “does this server belong to framework X?”
- add local server-membership configuration to framework definitions
- update [tickets.ts](../fhir-server/src/auth/tickets.ts) to accept:
  - recipient URL match against known server URLs
  - framework membership match
- update docs to distinguish:
  - current same-server network demo
  - intended cross-holder network semantics

#### Likely Config Shape

Add something like:

```json
{
  "framework": "https://example.org/frameworks/tefca",
  "frameworkType": "udap",
  "localAudienceMembership": {
    "entityUri": "https://holder.example.org"
  }
}
```

The exact shape can be refined during implementation.

### Item 3: Ticket Revocation Checking

#### Assessment

Real implementation gap.

- revocation exists in the spec and model
- the validator ignores it entirely

#### Decision

Implement it.

Also clarify spec guidance for long-lived tickets:

- issuers **SHOULD** include `revocation` for tickets longer than one day
- servers **MAY** reject long-lived tickets that omit revocation support by local policy

#### Changes

- add a ticket-revocation fetch/cache/parse helper under `src/auth/`
- update [tickets.ts](../fhir-server/src/auth/tickets.ts) to:
  - require `jti` when `revocation` is present
  - fetch the CRL
  - check `rid`
  - support timestamp suffix semantics
  - fail closed if revocation status cannot be determined
- add tests for:
  - revoked ticket
  - valid revocable ticket
  - missing `jti`
  - CRL unavailable

#### Relationship To Plan 9

This is separate from UDAP certificate CRLs.

- Plan 9 covers X.509 certificate revocation
- this work covers Permission Ticket revocation lists

If desired, this can later become its own numbered follow-on plan.

### Item 4: `cnf.jkt` Failure Error Code

#### Assessment

Real implementation bug.

- current heuristic maps key-binding mismatch to `invalid_client`
- the spec’s framing as `invalid_grant` is better

#### Decision

Fix the code.

#### Changes

- update token error mapping in [app.ts](../fhir-server/src/app.ts)
- ensure any ticket constraint failure yields `invalid_grant`, including:
  - `cnf.jkt` mismatch
  - `client_binding` mismatch
  - audience mismatch
  - revocation failure

### Item 5: Exact `aud` Error Description Wording

#### Assessment

Low-value mismatch.

- spec currently prescribes exact text
- implementation uses different but acceptable wording

#### Decision

Do not force exact wording in code.

Relax the spec wording instead.

#### Changes

- update [index.md](../../input/pagecontent/index.md) so `error_description` values are examples, not exact required strings

### Item 6: `client_binding.binding_type` Not Compared At Enforcement

#### Assessment

Low-risk cleanup only.

- parse-time validation already constrains it to `framework-entity`
- runtime objects are built internally

#### Decision

Add the comparison in code as defense-in-depth, but do not treat it as a substantive protocol gap.

#### Changes

- update [app.ts](../fhir-server/src/app.ts) `enforceClientRequirements(...)` to also compare `binding_type`

### Item 7: Period and Sensitivity Semantics Lack Common Spec Definition

#### Assessment

Real common-semantics spec gap.

- these semantics affect authorization behavior
- they are documented only as local input semantics today
- they belong in the common narrative semantics of the claims model, not as ad hoc per-ticket wire fields

#### Decision

Formalize them as common Permission Ticket semantics.

Do not add them to the common Permission Ticket model.

#### Changes

- add common narrative under [index.md](../../input/pagecontent/index.md)
- ensure generated examples for the network-patient-access ticket type do not place these semantics on the wire
- update [ticket-input-spec.md](./ticket-input-spec.md) to point back to the formal common semantics once defined

#### Proposed Semantics

- `authorization.access.periods`, unless a profile states otherwise, use generated/recorded timing semantics
- Permission Ticket processing defines common `deny` and `allow` sensitive-data handling semantics

These should be described in the common narrative and not represented as per-ticket `details` members.

### Item 8: SMART Config `grant_types_supported` Omits `client_credentials`

#### Assessment

Real implementation mismatch.

- root SMART config advertises only token exchange
- the server does support `client_credentials` for UDAP-authenticated B2B flows

#### Decision

Advertise `client_credentials` when supported.

#### Changes

- update [app.ts](../fhir-server/src/app.ts) SMART config builder
- include `client_credentials` in `grant_types_supported` when the server has client-auth paths that support it
- add or update tests and smoke assertions

### Item 9: `proof_jkt` Field Is Dead

#### Assessment

Dead code / misleading surface.

#### Decision

Remove it unless a concrete feature is planned immediately.

#### Changes

- remove `proof_jkt` from [model.ts](../fhir-server/src/store/model.ts)
- search for any remaining docs/tests mentioning it and clean them up

### Item 10: Only One Of Seven Ticket Types Implemented

#### Assessment

Not a bug.

This is an intentional reference-implementation scope limit.

#### Decision

Do not treat this as a near-term implementation gap.

Instead:

- document explicitly that `network-patient-access-v1` is the only ticket type currently implemented end to end
- leave the others deferred

## Phase Checklist

### Phase 1: Quick Code Alignment

- [x] Fix `cnf.jkt` mismatch to return `invalid_grant`
- [x] Add `binding_type` comparison in runtime client-binding enforcement
- [x] Remove dead `proof_jkt`
- [x] Advertise `client_credentials` in SMART config when supported
- [x] Update tests for the above

### Phase 2: `exp` Enforcement and Demo Lifetime Semantics

- [x] Make `PermissionTicket.exp` required in the server model
- [x] Reject missing `exp` during ticket validation
- [x] Replace true “never” demo tickets with long-lived `exp`
- [x] Update demo UI copy and tests

### Phase 3: Common Period and Sensitivity Semantics

- [x] Formalize common period semantics for `authorization.access.periods`
- [x] Formalize common sensitive-data handling semantics
- [x] Ensure examples and generated snippets do not put these semantics on the wire
- [x] Update [ticket-input-spec.md](./ticket-input-spec.md) references

### Phase 4: Framework Audience Validation

- [x] Add local framework-membership config for server audiences
- [x] Extend framework abstraction to answer audience-membership questions
- [x] Update ticket validation for framework-audience mode
- [x] Add tests for:
  - URL `aud`
  - framework `aud`
  - mismatch cases

### Phase 5: Ticket Revocation

- [x] Add ticket-revocation fetch/cache helper
- [x] Enforce `jti` when `revocation` is present
- [x] Check revocation CRLs
- [x] Fail closed on indeterminate revocation status
- [x] Add tests for revoked / not revoked / unavailable CRL

### Phase 6: Spec Cleanup and Conformance Notes

- [x] Relax exact prescribed `error_description` wording
- [x] Clarify long-lived ticket guidance around revocation
- [x] Clarify current reference-implementation scope for ticket types

## Testing Strategy

### Unit and Integration

- `tickets.ts` validation tests for:
  - missing `exp`
  - framework `aud`
  - revocation outcomes
  - `cnf.jkt` error mapping
- SMART config tests for grant type advertisement
- UI/demo tests for long-lived demo expiration behavior

### Smoke and End-to-End

- root SMART config should reflect the real grant surface
- token exchange should return `invalid_grant` for all ticket-binding failures
- long-lived revocable ticket should be accepted or rejected correctly based on revocation list state

## Items Not Worth Prioritizing

### Exact `error_description` String Matching

Not worth driving code changes.

Use examples in the spec, not exact string requirements.

### Treating `binding_type` Runtime Comparison As A Major Gap

Worth adding, but not worth significant design time.

### Expanding To All Seven Ticket Types Right Now

Out of scope for this phase.

The right next move is to make the one implemented ticket type internally coherent and spec-aligned.

## Relationship To Existing Plans

- Plan 8 established the trust-framework abstraction
- Plan 9 covers UDAP certificate CRLs, not Permission Ticket revocation
- Plan 10 improved demo client UX and will need a small lifetime-label adjustment
- Plan 11 hardened UDAP registration/auth state but does not address ticket expiration, audience, or ticket revocation

This plan should be treated as the next alignment pass after Plans 8–11.
