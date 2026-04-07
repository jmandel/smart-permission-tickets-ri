# Plan 22: Correct OIDF Trust Chain Shape and Validation

Status: completed

## Prep

The current nested repo working tree contains partial post-Phase-6 work that overlaps directly with the OIDF files this correction must touch:
- Phase 7 UI / artifact wording work
- paused issuer-split exploration
- local plan / reference files

Prep action:
- create a short-lived side branch from the current dirty tree
  - suggested name: `wip/phase-7-issuer-split-parked`
- make a single WIP commit capturing:
  - all currently modified tracked files
  - untracked `plans/21-add-openid-federation-support.md`
  - untracked `plans/22-oidf-trust-chain-shape-correction.md`
  - untracked `plans/references/openid-federation-1.0-rfc.xml`
  - any other untracked artifacts in the nested repo that belong to the current parked work
- return `main` to the last clean OIDF Phase 6 commit:
  - `79e365f`
- land the chain-shape correction there as one atomic commit
- after the correction lands, salvageable pieces from the parked branch can be cherry-picked or rebased onto the corrected base in a follow-up session

Prep validation:
- `bun test` is NOT expected to pass at the parked WIP point
- the prep step exists only to preserve state cleanly before the atomic trust-chain correction begins

## Bug Summary

The current OIDF implementation is self-consistent but non-conformant in two linked ways:

1. It builds and validates a 5-JWT chain shape for a 3-deep path:
   - leaf Entity Configuration
   - subordinate statement about leaf
   - intermediate Entity Configuration
   - subordinate statement about intermediate
   - Trust Anchor Entity Configuration

   That is not the Trust Chain shape described by the final OpenID Federation 1.0 RFC. The RFC trust-chain array contains the leaf Entity Configuration, subordinate statements walking upward, and the Trust Anchor Entity Configuration. Intermediate Entity Configurations are fetched during chain construction but are not members of the Trust Chain array.

2. It omits `jwks` from Subordinate Statements.
   The RFC requires `jwks` in both Entity Configurations and Subordinate Statements, except for the explicit-registration response special case. Since signature validation is defined as “ES[j] is signed by a key in ES[j+1][\"jwks\"]”, a Subordinate Statement must carry the subject’s Federation Entity keys.

These two mistakes reinforce each other:
- the current builder emits the wrong chain shape
- the current verifier expects that wrong shape
- the loopback fetcher assembles the wrong shape
- the unit fixtures and topology tests all bake in the same wrong assumptions

## Normative RFC Basis

Source of truth:
- `reference-implementation/plans/references/openid-federation-1.0-rfc.xml`

Key passages:

- Common claim requirements: `jwks` is required in both Entity Configurations and Subordinate Statements
  - [openid-federation-1.0-rfc.xml](/home/jmandel/work/smart-permission-tickets/reference-implementation/plans/references/openid-federation-1.0-rfc.xml#L519)
  - Specifically [openid-federation-1.0-rfc.xml](/home/jmandel/work/smart-permission-tickets/reference-implementation/plans/references/openid-federation-1.0-rfc.xml#L550):
    - `REQUIRED. A JSON Web Key Set (JWKS)... in all other cases, it is REQUIRED.`

- Trust Chain structure
  - [openid-federation-1.0-rfc.xml](/home/jmandel/work/smart-permission-tickets/reference-implementation/plans/references/openid-federation-1.0-rfc.xml#L1108)
  - Specifically [openid-federation-1.0-rfc.xml](/home/jmandel/work/smart-permission-tickets/reference-implementation/plans/references/openid-federation-1.0-rfc.xml#L1130):
    - `A Trust Chain begins with an Entity Configuration ...`
    - `The Trust Chain has zero or more Subordinate Statements ...`
    - `The Trust Chain logically always ends with the Entity Configuration of the Trust Anchor, even though it MAY be omitted from the JSON array representing the Trust Chain in some cases.`

- Simple 3-deep example
  - [openid-federation-1.0-rfc.xml](/home/jmandel/work/smart-permission-tickets/reference-implementation/plans/references/openid-federation-1.0-rfc.xml#L1149)
  - The RFC’s numbered list is 4 items, not 5:
    - leaf EC
    - subordinate about leaf
    - subordinate about intermediate
    - Trust Anchor EC

- Validation algorithm
  - [openid-federation-1.0-rfc.xml](/home/jmandel/work/smart-permission-tickets/reference-implementation/plans/references/openid-federation-1.0-rfc.xml#L6159)
  - Specifically [openid-federation-1.0-rfc.xml](/home/jmandel/work/smart-permission-tickets/reference-implementation/plans/references/openid-federation-1.0-rfc.xml#L6200):
    - `For each j = 0,...,i-1, verify that ES[j]["iss"] == ES[j+1]["sub"].`
    - `For each j = 0,...,i-1, verify that the signature of ES[j] validates with a public key in ES[j+1]["jwks"].`

- Trust-chain example recap explicitly says intermediate ECs are fetched but not included
  - [openid-federation-1.0-rfc.xml](/home/jmandel/work/smart-permission-tickets/reference-implementation/plans/references/openid-federation-1.0-rfc.xml#L11090)
  - The example labels intermediate Entity Configurations as:
    - `not included in the Trust Chain`

## Correct Target Trust-Chain Layout

## Depth and Length Math

Definition:
- trust-chain depth = number of entity levels from the leaf to the Trust Anchor, inclusive

For depth `N`:
- if `N = 1`, the chain contains only the Trust Anchor Entity Configuration
  - `chain.length = 1`
- if `N >= 2`, the chain contains:
  - 1 leaf Entity Configuration
  - `N - 2` Subordinate Statements
  - 1 Trust Anchor Subordinate Statement
  - 1 Trust Anchor Entity Configuration
  - therefore `chain.length = N + 1`

With the current implementation limit `MAX_ENTITY_DEPTH = 3`:
- maximum legal chain length is `4`
- legal lengths are:
  - `1` for the Trust-Anchor-only edge case
  - `3` for leaf directly under anchor
  - `4` for leaf under one intermediate under anchor

The demo topology exercises only the depth-3 / length-4 case.

For a depth-3 path:
- `ES[0]`: leaf Entity Configuration
  - `iss == sub == <leaf entity id>`
  - includes leaf `jwks`
  - includes leaf `metadata`
  - includes leaf `authority_hints`
- `ES[1]`: Subordinate Statement from immediate superior about leaf
  - `iss == <intermediate entity id>`
  - `sub == <leaf entity id>`
  - includes the leaf entity's `jwks`
  - includes any `metadata_policy` the intermediate applies to the leaf
- `ES[2]`: Subordinate Statement from Trust Anchor about the intermediate
  - `iss == <trust anchor entity id>`
  - `sub == <intermediate entity id>`
  - includes the intermediate entity's `jwks`
  - includes any `metadata_policy` the Trust Anchor applies to the intermediate
- `ES[3]`: Trust Anchor Entity Configuration
  - `iss == sub == <trust anchor entity id>`
  - includes Trust Anchor `jwks`
  - includes Trust Anchor `metadata`

General shape:
- first element: subject Entity Configuration
- zero or more Subordinate Statements walking upward
- last element: Trust Anchor Entity Configuration

Intermediate Entity Configurations:
- fetched during Trust Chain collection as needed
- used to discover `authority_hints` and fetch endpoints
- not included in the Trust Chain array itself

Required `jwks` placement:
- leaf EC: required
- each Subordinate Statement: required, containing the subject entity’s federation keys
- Trust Anchor EC: required

Subordinate Statement `jwks` provenance:
- the `jwks` in a Subordinate Statement is a copy of the subject entity’s Entity Configuration `jwks`
- the parent is attesting to the subject’s federation signing keys
- the topology generator must copy the subject entity’s configured federation keys into the Subordinate Statement
- the generator must not mint substitute keys and must not omit the copy

Signature rules:
- `ES[0]` self-signed with a key in `ES[0]["jwks"]`
- for each `j = 0..i-1`, `ES[j]` must be signed by a key in `ES[j+1]["jwks"]`
- `ES[i]` must be signed by a configured Trust Anchor key
- the Trust Anchor public keys are still configured out of band and used to verify:
  - `ES[i]` directly
  - `ES[i-1]` because `ES[i-1]["iss"] == ES[i]["sub"] == <trust anchor entity id>`

Implication:
- the subject JWK set for an intermediate entity appears in the Subordinate Statement about that intermediate
- the verifier does not need the intermediate Entity Configuration inside the chain to verify signatures

## Corrected Verification Algorithm

`verifyTrustChain(chain, expectedAnchor, now)` must:

1. Parse each `ES[j]` and validate:
   - `typ = entity-statement+jwt`
   - accepted `alg`
   - required claims present
   - `iat` in the past
   - `exp` in the future

2. Enforce structure:
   - `ES[0]` must be an Entity Configuration (`iss == sub`)
   - `ES[1..i-1]` must be Subordinate Statements (`iss != sub`)
   - `ES[i]` must be the Trust Anchor Entity Configuration (`iss == sub == expectedAnchor`)
   - reject if `chain.length > 4`, matching `MAX_ENTITY_DEPTH = 3`
   - allow `chain.length == 1` and `chain.length == 3` as legal edge cases, even though the demo topology does not emit them

3. Verify signatures:
   - `ES[0]` with a key in `ES[0]["jwks"]`
   - for each `j = 0..i-1`, `ES[j]` with a key in `ES[j+1]["jwks"]`
   - `ES[i]` with a configured Trust Anchor key

4. Enforce chaining:
   - for each `j = 0..i-1`, `ES[j]["iss"] == ES[j+1]["sub"]`

5. Build resolved chain metadata:
   - leaf statement
   - anchor statement
   - ordered subordinate statements
   - metadata policy layers
   - preserve `metadataPolicies` in the current leaf-first ordering
   - this keeps `policy.ts` consumption simple and avoids any new reordering behavior

6. Do not require intermediate Entity Configurations to appear in the array.

Special terminal handling:
- this verifier REQUIRES the Trust Anchor Entity Configuration as the terminal element
- chains that omit the Trust Anchor EC are rejected in this pass
- the RFC's `MAY be omitted` variant is deferred to a future design discussion if we ever need to consume externally generated anchor-omitted chains

## File-by-File Changes

### `src/auth/frameworks/oidf/demo-topology.ts`

Required changes:
- `buildOidfTrustChain(...)`
  - stop appending intermediate Entity Configurations to the array
  - emit:
    - leaf EC
    - each fetched subordinate statement upward
    - Trust Anchor EC as final element
- `signSubordinateStatement(...)`
  - include the subject entity’s `jwks`
- topology data structures may continue to store intermediate Entity Configurations for fetch/discovery, but the emitted trust chain must exclude them

### `src/auth/frameworks/oidf/trust-chain.ts`

Required changes:
- replace odd-length / alternating EC + Sub assumption
- remove `entityConfigurations.length === subordinateStatements.length + 1` logic
- validate against:
  - first EC
  - zero or more subordinate statements
  - terminal Trust Anchor EC
- rename or reshape `VerifiedTrustChain` fields so they no longer imply every superior EC is present in the chain
- preserve:
  - `leaf`
  - `anchor`
  - `metadataPolicies`
  - `depth`
- likely remove:
  - `entityConfigurations`
- likely redefine:
  - `subordinateStatements`
  - `statements`

### `src/auth/frameworks/oidf/resolver.ts`

Required changes:
- `fetchTrustChain(...)`
  - still fetch intermediate Entity Configurations to read `authority_hints`
  - do not append them to the returned chain array
  - append only subordinate statements while walking up
  - append the Trust Anchor EC at the end
- issuer-trust verification:
  - stop reading provider-network keys from `verifiedChain.entityConfigurations`
  - obtain the provider-network `jwks` from the validated chain representation:
    - specifically from the Subordinate Statement about the ticket issuer, whose `jwks` now contains the ticket issuer's keys
    - and from the Trust Anchor's Subordinate Statement about the provider network, whose `jwks` now contains the provider-network keys
  - preserve enough validated subject-key information in `VerifiedTrustChain` that trust-mark verification can identify the provider-network key set without refetching an intermediate EC

### `src/auth/frameworks/oidf/policy.ts`

Required changes:
- minimal, but likely must stop depending on any obsolete `VerifiedTrustChain` fields
- `leaf.payload.jwks` and `metadataPolicies` logic can remain if the new `VerifiedTrustChain` preserves them
- the corrected chain still yields `metadataPolicies` in leaf-first order, so `policy.ts` should not need any new ordering transform beyond any type-shape cleanup already implied by `VerifiedTrustChain`

### `src/auth/frameworks/oidf/trust-chain.test.ts`

Required changes:
- rebuild fixtures to the 4-statement shape
- include `jwks` in subordinate statements
- add direct regression assertions for:
  - intermediate ECs absent from the chain array
  - subordinate statements carrying subject `jwks`
  - signature verification using `ES[j+1]["jwks"]`

### `src/auth/frameworks/oidf/policy.test.ts`

Required changes:
- update fixtures to the corrected chain shape
- include `jwks` in subordinate statements

### `test/oidf-topology.test.ts`

Required changes:
- bootstrap OIDF client option trust chain length changes from 5 to 4
- add assertion that the chain omits intermediate Entity Configurations

### `test/oidf-auth.test.ts`

Required changes:
- any expectations about chain depth / artifact shape may need updates
- keep existing client-auth semantics

### `test/oidf-issuer-trust.test.ts`

Required changes:
- refresh helper logic that mutates entity configurations if it assumes the old chain layout
- verify issuer-trust artifacts still work with the corrected chain representation

### Other possible touchpoints

- `src/app.ts`
  - only if diagnostic artifact labels or emitted chain details depend on old `VerifiedTrustChain` shape
- `plans/21-add-openid-federation-support.md`
  - update status note to acknowledge the original Phase 2/4 implementation used a non-conformant chain shape and was superseded by Plan 22

## Impact on Earlier Plan 21 Work

Salvageable:
- JOSE-header dispatch via `trust_chain`
- OIDF client_id model
- metadata-policy operator engine and tests in principle
- trust-mark verification logic in principle
- loopback self-fetch strategy
- token-endpoint and issuer-trust integration architecture

Needs correction:
- trust-chain builder
- trust-chain validator
- trust-chain fetcher
- all OIDF fixtures using the old 5-statement shape
- any code reaching into `verifiedChain.entityConfigurations`

Assessment:
- Phase 2, 4, 5, and 6 are not throwaway, but the chain representation cuts across all of them
- expect targeted rewrites in the OIDF core files and all OIDF fixtures, not a total restart

## Acceptance Criteria

- `buildOidfTrustChain(...)` emits a spec-conformant array for a 3-deep path:
  - leaf EC
  - subordinate about leaf
  - subordinate about intermediate
  - Trust Anchor EC
- the emitted depth-3 chain length is `4`, matching the RFC Section 4 example and this plan’s depth math
- every Subordinate Statement in demo topology includes `jwks`
- `verifyTrustChain(...)` validates signatures exactly as:
  - self on `ES[0]`
  - `ES[j]` by key in `ES[j+1]["jwks"]`
  - Trust Anchor EC by configured Trust Anchor key
- the emitted chain shape matches the exact normative example in RFC Section 4 for a depth-3 path, verified by direct comparison against the cited RFC XML lines in this plan
- metadata-policy and issuer-trust tests pass using the corrected shape
- the OIDF client assertion path continues to work end to end

## Delivery Shape

This correction should land as one atomic commit.

Reason:
- the old builder, verifier, fetcher, and fixtures are mutually dependent
- partial rollout would leave the repo in a self-contradictory state
- the unit and integration tests should go green only when the entire corrected path is in place
