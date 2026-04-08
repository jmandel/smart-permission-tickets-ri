# Plan 27: Legacy Cleanup After Plans 23-26

Status: complete

Post-implementation status as of 2026-04-08:

- removed the dead `local` issuer-trust classification from the live model
- removed the old local-only issuer-trust helpers and provenance branch
- removed the standalone UDAP demo registration helper script and its package/README references
- removed the unused `loadDemoCryptoBundle(...)` export
- preserved intentional operator-facing overrides and the generic framework policy model

## Why This Plan Exists

Plans 23 through 26 materially changed the verifier and bootstrap model:

- issuer trust is now policy-driven
- the default demo runtime uses allowlisted direct JWKS, not a special local-issuer trust path
- the demo crypto bundle is now a lockfile that boot auto-creates and grows
- lockfile-backed material is now the normal source of truth for asymmetric demo keys and HS256 shared secrets

Those refactors left behind a small but real set of stale helpers, pre-policy classifications, and fallback/bootstrap paths. This plan removes the parts that are now genuinely dead or misleading, while preserving the fallbacks that are still intentional.

## Audit Findings

### 1. Dead `local` issuer-trust classification

Current state:

- [model.ts](/home/jmandel/work/smart-permission-tickets/reference-implementation/fhir-server/src/store/model.ts) still defines `TicketIssuerTrust.source = "direct" | "framework" | "local"`
- [issuer-trust.ts](/home/jmandel/work/smart-permission-tickets/reference-implementation/fhir-server/src/auth/issuer-trust.ts) only returns `direct` or `framework`
- [issuers.ts](/home/jmandel/work/smart-permission-tickets/reference-implementation/fhir-server/src/auth/issuers.ts) still contains:
  - `resolveTrustedIssuer(...)` returning `source: "local"`
  - `resolveFromIssuerUrl(...)`
- [tickets.ts](/home/jmandel/work/smart-permission-tickets/reference-implementation/fhir-server/src/auth/tickets.ts) still has a provenance branch for `issuer.source === "local"`

Assessment:

- `local` is a pre-Plan-25 leftover
- current runtime policy evaluation does not produce it
- the distinction between `local` and `direct` is no longer meaningful in the live verifier model

### 2. Unused bundle loader export

Current state:

- [demo-crypto-bundle.ts](/home/jmandel/work/smart-permission-tickets/reference-implementation/fhir-server/src/demo-crypto-bundle.ts) exports `loadDemoCryptoBundle(...)`
- repository search shows no current caller

Assessment:

- this is dead code unless we deliberately restore a read-only pre-bootstrap bundle loading path

### 3. Standalone demo helper bypasses lockfile bootstrap

Current state:

- [demo-udap-registration.ts](/home/jmandel/work/smart-permission-tickets/reference-implementation/fhir-server/src/demo-udap-registration.ts) calls `loadConfig()` directly
- it then calls `buildDemoUdapClients(origin, config.demoCryptoBundle)` even though `config.demoCryptoBundle` is never populated there

Assessment:

- the standalone helper still falls back to baked-in demo UDAP key material
- that diverges from the current lockfile-based boot model
- repository references show it is only surfaced as:
  - a README example
  - a `package.json` convenience script
- there is no evidence of runtime or test usage
- that makes it a strong removal candidate rather than something we should preserve and re-align

### 4. Fallback constants that now need an explicit keep/remove decision

Current state:

- [config.ts](/home/jmandel/work/smart-permission-tickets/reference-implementation/fhir-server/src/config.ts) still seeds:
  - `accessTokenSecret`
  - `clientRegistrationSecret`
  - default `reference-demo` issuer key material
- [auth/demo-frameworks.ts](/home/jmandel/work/smart-permission-tickets/reference-implementation/fhir-server/src/auth/demo-frameworks.ts) still contains no-bundle fallback material for:
  - well-known demo client keys
  - UDAP demo clients and CA material

Assessment:

- not all of these are dead
- some are still used intentionally by tests, direct helper calls, or pre-bootstrap config assembly
- this plan should only remove the ones that become unnecessary after cleanup, not blindly strip all fallbacks

## Non-Goals

- changing the current issuer-trust policy model introduced in Plan 25
- removing explicit env-var overrides that are still intentionally operator-facing
- removing generic framework capability just because the default demo runtime config does not enable every path
- changing ticket format or trust semantics

## Design Decisions

### 1. Keep the live verifier model simple

Post-cleanup, issuer trust should expose only the two runtime-relevant source classes:

- `direct`
- `framework`

There is no separate `local` trust source anymore.

### 2. Prefer one bootstrap path

Where practical, demo helper scripts should use the same lockfile-backed bootstrap path as the server instead of silently falling back to baked-in constants.

### 3. Preserve intentional operator overrides

Explicit env vars such as:

- `ACCESS_TOKEN_SECRET`
- `CLIENT_REGISTRATION_SECRET`
- `DEMO_CRYPTO_BUNDLE_PATH`

remain supported. This plan removes stale internal fallback layers, not explicit public config.

## Phases

### Phase 1: Remove Dead Local Issuer-Trust Path

Goals:

- remove `local` from `TicketIssuerTrust.source`
- delete or collapse the dead local-only issuer-trust helpers
- remove the unreachable provenance branch keyed on `issuer.source === "local"`

Files:

- [model.ts](/home/jmandel/work/smart-permission-tickets/reference-implementation/fhir-server/src/store/model.ts)
- [issuers.ts](/home/jmandel/work/smart-permission-tickets/reference-implementation/fhir-server/src/auth/issuers.ts)
- [tickets.ts](/home/jmandel/work/smart-permission-tickets/reference-implementation/fhir-server/src/auth/tickets.ts)
- any tests still referencing `local`

Expected outcome:

- only `direct` and `framework` remain
- default demo issuer trust still reports `direct`
- no user-facing or introspection payload ever emits `source: "local"`

### Phase 2: Remove Unneeded Standalone Demo Helper Paths

Goals:

- remove [demo-udap-registration.ts](/home/jmandel/work/smart-permission-tickets/reference-implementation/fhir-server/src/demo-udap-registration.ts) if it is still only a README/package convenience path
- remove its `package.json` script entry
- replace the README example with either:
  - curl-based manual steps, or
  - a note pointing readers to the existing tested/demo UI flows

Files:

- [demo-udap-registration.ts](/home/jmandel/work/smart-permission-tickets/reference-implementation/fhir-server/src/demo-udap-registration.ts)
- [package.json](/home/jmandel/work/smart-permission-tickets/reference-implementation/fhir-server/package.json)
- README examples if behavior or operator expectations need clarification

Expected outcome:

- no auxiliary CLI path silently bypasses the lockfile model
- the repo no longer carries a second bootstrap path just for a manual UDAP registration demo

### Phase 3: Remove Truly Unused Bundle/Bootstrap Exports

Goals:

- remove `loadDemoCryptoBundle(...)` if it is still unused after Phase 2
- remove any helper that only existed to support the old local-issuer trust classification
- re-check whether any no-bundle demo helper fallback remains unused after Phase 2 and trim only the dead ones

Files:

- [demo-crypto-bundle.ts](/home/jmandel/work/smart-permission-tickets/reference-implementation/fhir-server/src/demo-crypto-bundle.ts)
- [issuers.ts](/home/jmandel/work/smart-permission-tickets/reference-implementation/fhir-server/src/auth/issuers.ts)
- any now-obsolete exports that only existed for the deleted helper
- related tests

Expected outcome:

- no exported helper remains without a real caller
- no dead compatibility layer remains for pre-Plan-25 / pre-Plan-26 behavior

### Phase 4: Documentation and Terminology Cleanup

Goals:

- update README / comments / plan notes so terminology matches the post-cleanup model
- explicitly document which fallbacks remain intentional:
  - env-var overrides
  - generic framework capability behind policy
- remove any wording that still implies a separate `local` issuer-trust path

Files:

- [README.md](/home/jmandel/work/smart-permission-tickets/reference-implementation/fhir-server/README.md)
- [00-metaplan.md](/home/jmandel/work/smart-permission-tickets/reference-implementation/plans/00-metaplan.md)
- inline comments where helpful

## Acceptance Criteria

- `TicketIssuerTrust.source` has no `local` variant anywhere in the implementation
- no runtime path emits `source: "local"` in introspection or diagnostics
- [demo-udap-registration.ts](/home/jmandel/work/smart-permission-tickets/reference-implementation/fhir-server/src/demo-udap-registration.ts) is either removed or replaced by a path that does not bypass the lockfile model
- unused exports/helpers identified in this plan are removed
- explicit operator-facing overrides remain intact
- `bun test` passes after each code-bearing phase

## Estimated Scope

Small to medium cleanup:

- roughly 150-300 lines touched
- mostly type, helper, script, and docs cleanup
- low algorithmic risk, but moderate grep-and-test discipline required to avoid removing intentionally retained fallbacks
