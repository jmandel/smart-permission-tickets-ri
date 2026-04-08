# Plan 28: OIDF Spec Alignment and Functional Kernel

Status: complete on `main`

Implementation note:

- Phases 1 through 7 are complete on `main`
- the OIDF validator now uses a pure `trust-chain-kernel.ts`
- direct-superior `metadata`, top-down `metadata_policy`, `metadata_policy_crit`, RFC constraints, trust-mark delegation rejection, issuer-trust caching, and multi-`authority_hints` traversal are implemented
- metadata-policy operator support remains intentionally partial in this pass:
  - supported: `value`, `default`, `one_of`
  - unsupported standard operators fail closed: `add`, `subset_of`, `superset_of`, `essential`

## Why This Plan Exists

Plans 21 and 23 built a working OIDF implementation with the right overall architecture:

- client-auth `trust_chain` validation is static and offline
- issuer trust is the only discovery-oriented path
- issuer trust is gated by explicit verifier policy

That architecture is still correct. The remaining work is not a rewrite of the model; it is a spec-alignment pass on the OIDF validation core.

Current gaps relative to OpenID Federation 1.0 include:

- subordinate-statement `metadata` is ignored
- `constraints` are not enforced
- `crit` and `metadata_policy_crit` are not handled per RFC rules
- `kid` presence/selection/uniqueness rules are not enforced
- issuer-trust discovery is too narrow for a generic consumer and lacks caching
- delegated trust marks are not explicitly rejected/validated
- the generic consumer still inherits the demo-only depth limit

This plan addresses those gaps by extracting a tighter, test-first, mostly functional OIDF kernel and then re-wiring the resolver to use it.

## RFC Targets

This plan specifically aligns with:

- Section 3.2: Entity Statement validation
- Section 4.2: Constraints
- Section 5.1.4: Metadata Policy, including `metadata_policy_crit`
- Section 5.3.1: Trust Mark Delegation
- Section 6.1.4: Metadata Policy Resolution and Application
- Section 7.1: Bottom-up Trust Chain resolution
- Section 8.1: Denial-of-Service Attack Prevention
- Section 10.2: Validating a Trust Chain

## Implementation Discipline

This plan is intentionally not a substitute for the RFC text.

During implementation, each code-bearing phase MUST be executed with the cited
OIDF RFC XML sections open and re-read immediately before changing code in that
area. The implementer must not rely on memory or on this plan’s summaries alone
for:

- statement/header validation rules
- subordinate `metadata` semantics
- metadata-policy merge/application details
- `crit` and `metadata_policy_crit`
- constraints
- trust-mark delegation
- trust-chain discovery traversal rules
- `kid` selection and uniqueness requirements

Phase-by-phase RFC re-read requirement:

- Phase 2: re-read Section 3.2 and Section 10.2
- Phase 3: re-read Section 5.1.4 and Section 6.1.4
- Phase 4: re-read Section 4.2
- Phase 5: re-read Section 5.3.1
- Phase 6: re-read Section 7.1 and Section 8.1

## Design Intent

### 1. Preserve the current high-level split

This plan does **not** undo the architecture agreed earlier:

- Client Authentication with a presented `trust_chain` remains static/offline.
- Issuer Trust remains the only path that performs OIDF discovery/fetches.

### 2. Make the core validation and metadata resolution pure

Everything below should be moved into a functional kernel that:

- accepts parsed/configured inputs
- performs no fetches
- is deterministic under an explicit `nowSeconds`
- returns typed validation/resolution outputs or structured failures

The pure kernel should own:

- statement parsing and required-claim validation
- `kid` / `jwks` validation
- signature-chain validation
- `crit` handling
- `metadata` override application
- `metadata_policy_crit` collection and policy validation
- metadata-policy resolution
- constraint enforcement
- trust-mark payload validation preconditions

### 3. Keep discovery/stateful behavior outside the kernel

Resolver-layer concerns remain outside the pure kernel:

- fetching Entity Configurations
- fetching Subordinate Statements
- exploring multiple `authority_hints`
- caching discovery results / resolved issuer trust
- self-origin loopback rewriting

## Tests First

This plan begins with a test matrix. The implementation should not begin by patching the live resolver ad hoc. It should begin by locking expected RFC behavior into kernel tests.

### Phase 0 Test Suite Layout

Add or expand tests in these buckets:

- `src/auth/frameworks/oidf/trust-chain-kernel.test.ts`
- `src/auth/frameworks/oidf/policy.test.ts`
- `src/auth/frameworks/oidf/trust-mark.test.ts`
- `test/oidf-issuer-trust.test.ts`
- `test/oidf-external-consumption.test.ts`

If helpful, split the current `trust-chain.test.ts` into:

- statement/parsing tests
- chain-validation tests
- metadata/policy/constraints tests

### Kernel Test Matrix

#### A. Entity Statement Structure and Header Tests

1. Accepts a valid RFC-shaped depth-3 chain.
2. Rejects missing `iss`, `sub`, `iat`, `exp`, or `jwks` where required.
3. Rejects missing JWS header `kid`.
4. Rejects empty-string JWS header `kid`.
5. Rejects statement when `kid` does not match any key in issuer `jwks`.
6. Rejects duplicate `kid` values inside a statement’s `jwks`.
7. Rejects unsupported `alg`.
8. Rejects wrong `typ`.

#### B. `crit` Claim Tests

1. Accepts absent `crit`.
2. Rejects `crit` values that reference unknown claims.
3. Rejects `crit` if it names a claim defined by the spec.
4. Accepts a known extension claim only if the implementation explicitly supports it.

First-pass expectation:
- the kernel supports no custom critical claims, so any present `crit` should fail closed unless future work adds explicit support.

#### C. Signature-Chain and Linkage Tests

1. Rejects wrong `iss/sub` linkage between adjacent statements.
2. Rejects signature mismatch when header `kid` points at the wrong key.
3. Rejects wrong terminal anchor.
4. Rejects anchor signature that does not validate against configured trust-anchor keys.

#### D. Subordinate `metadata` Application Tests

These are currently missing and must be added before code changes.

1. A subordinate statement can override a metadata field already present in the leaf EC.
2. Subordinate `metadata` only affects Entity Types present in the leaf EC.
3. Multiple subordinate `metadata` layers apply top-down, with the more immediate subordinate overriding more superior values where RFC says so.
4. If both `metadata` and `metadata_policy` exist in the same subordinate statement, `metadata` is applied before `metadata_policy`.

#### E. `metadata_policy` and `metadata_policy_crit` Tests

1. Existing standard operators (`value`, `default`, `one_of`) still resolve correctly.
2. Unknown operator not listed in any `metadata_policy_crit` is ignored, not failed.
3. Unknown operator listed in `metadata_policy_crit` invalidates the chain.
4. Known operator listed in `metadata_policy_crit` still works.
5. The kernel gathers critical policy operators from all subordinate statements before policy resolution.
6. Policy validation still fails on illegal operator combinations per the RFC’s policy rules.

#### F. Constraint Tests

1. `max_path_length` accepts a compliant chain.
2. `max_path_length` rejects a chain with too many intermediates.
3. `naming_constraints.permitted` accepts matching leaf entity identifiers.
4. `naming_constraints.permitted` rejects non-matching leaf entity identifiers.
5. `naming_constraints.excluded` rejects excluded leaf entity identifiers even when also permitted.
6. `allowed_entity_types` strips disallowed metadata types from the subject before policy application.
7. `allowed_entity_types = []` leaves only `federation_entity`.
8. Any failed constraint invalidates the chain.

#### G. Trust Mark Tests

1. Current non-delegated trust mark still validates.
2. Trust mark with `delegation` claim is rejected explicitly with a clear “delegated trust marks not supported” error, unless/until delegation is fully implemented.

#### H. Resolver/Discovery Tests

1. Issuer-trust resolution caches successful OIDF results according to framework TTL.
2. Repeated token exchanges for the same OIDF issuer do not refetch while the cache is fresh.
3. Multiple `authority_hints` are explored until a valid path to a configured trust anchor is found.
4. A bad first hint does not mask a valid later hint.
5. The resolver still limits explored hints and/or overall traversal depth to prevent DoS.

## What Must Be Fixed

### 1. `trust-chain.ts` must become a real RFC validator

Current gaps:

- no `constraints` enforcement
- no `crit` handling
- no `kid` header enforcement
- no `jwks` uniqueness enforcement
- hardcoded depth 3

Target:

- replace the current ad hoc validator with a kernel-oriented validator that:
  - validates required claims and headers per Section 3.2
  - validates signature selection by `kid`, not “try every key”
  - enforces trust-chain rules from Section 10.2
  - enforces constraints from Section 4.2
  - accepts max depth as configuration, not a demo constant

### 2. `policy.ts` must handle both subordinate `metadata` and `metadata_policy`

Current gap:

- it clones leaf metadata and applies only policy layers
- subordinate `metadata` is ignored entirely
- unknown policy operators are always rejected, which is stricter than the RFC and wrong once `metadata_policy_crit` exists

Target:

- resolve metadata in this order:
  1. start from leaf EC metadata
  2. apply subordinate `metadata` top-down
  3. collect critical policy operators from all layers
  4. validate/merge/apply metadata policy top-down
  5. enforce allowed entity types at the right point in the flow

### 3. `resolver.ts` must become a better generic consumer without changing the client-auth model

Client auth:

- stays offline/static when `trust_chain` is supplied

Issuer trust:

- add TTL cache for resolved issuer-trust material
- stop assuming a single `authority_hints[0]` path
- explore multiple hints with explicit bounds
- make the chain-depth budget configurable per framework

### 4. `trust-mark.ts` must fail clearly on unsupported delegation

Target:

- if a trust mark contains `delegation`, reject explicitly unless and until full delegation support is implemented
- do not leave the failure mode to mismatched signature expectations

## Phases

### Phase 1: Introduce the Functional Kernel Test Harness

Work:

- add the kernel-oriented test files and fixtures described above
- keep them red initially where they capture known current gaps
- do not change live resolver behavior yet except as needed to expose kernel inputs cleanly

Goal:

- establish the RFC target behavior before refactoring code

### Phase 2: Extract Pure Entity Statement and Trust-Chain Validation

Work:

- introduce a pure OIDF kernel module, for example:
  - `trust-chain-kernel.ts`
- move parsing, header/claim validation, `kid` selection, and signature-chain checks there
- make max depth a parameter, not a hardcoded constant

Goal:

- all statement-structure, `kid`, `crit`, and signature-chain tests pass

### Phase 3: Implement Metadata Resolution Correctly

Work:

- add subordinate `metadata` application
- collect and process `metadata_policy_crit`
- change unsupported operator handling to RFC semantics
- keep existing standard operators working

Goal:

- metadata and metadata-policy tests pass, including top-down ordering and subordinate overrides

### Phase 4: Implement Constraints Enforcement in the Kernel

Work:

- add `max_path_length`
- add `naming_constraints`
- add `allowed_entity_types`
- apply constraints at the RFC-specified stage of trust-chain resolution

Goal:

- constraint tests pass
- invalid constrained chains fail closed

### Phase 5: Tighten Trust Mark Handling

Work:

- detect `delegation`
- reject explicitly with a clear unsupported error unless full delegation support is implemented now
- optionally add the minimal structural checks needed to distinguish delegated from non-delegated marks cleanly

Goal:

- trust mark failures become clear and intentional

### Phase 6: Upgrade Issuer-Trust Discovery and Caching

Work:

- add in-memory TTL cache for resolved OIDF issuer trust
- iterate through multiple `authority_hints`
- add explicit bounds:
  - max hints inspected
  - max discovery depth
  - cache TTL based on configured framework TTL and/or statement expiry

Goal:

- issuer-trust resolution becomes safer and more RFC-faithful for generic-consumer use

### Phase 7: Docs and Diagnostics

Work:

- update Plan 21 and/or README wording where needed
- clarify the remaining intentional limitation:
  - delegated trust marks unsupported, if that remains true
- improve error messages so failures identify:
  - `crit`
  - `metadata_policy_crit`
  - specific constraint failure
  - `kid` mismatch/duplication

## Non-Goals

- changing the agreed static/offline client-auth model
- changing the default demo holder runtime away from `direct_jwks`
- implementing full delegated trust-mark support unless explicitly expanded during execution
- broadening supported algorithms beyond the project’s current accepted set unless separately approved

## Acceptance Criteria

- all kernel tests described above exist and pass
- subordinate `metadata` and `metadata_policy` are both implemented per RFC order
- `constraints` are enforced and failing constraints invalidate the chain
- `crit` and `metadata_policy_crit` behave per RFC
- `kid` presence, matching, and JWKS uniqueness are enforced
- issuer-trust discovery caches successful results and can traverse more than one `authority_hints` entry within explicit limits
- client-auth `trust_chain` validation remains offline and performs no discovery fetches

## Estimated Scope

Medium to large:

- roughly 400-800 lines across the OIDF core, resolver, tests, and docs
- mostly concentrated in:
  - `trust-chain.ts` or a new `trust-chain-kernel.ts`
  - `policy.ts`
  - `resolver.ts`
  - `trust-mark.ts`
  - OIDF-focused test files
