# Plan 26: Demo Crypto Lockfile Reuse and Grow-Only Updates

Status: completed

Post-implementation note: the Plan 26 lockfile model is now landed on `main`. The demo crypto bundle is ensured during `createAppContext()` after store load, auto-creates if missing, grows when new issuer/site entries are needed, preserves existing key material, and no longer fails boot when the site inventory outgrows the bundle.

## Goal

Turn the demo crypto bundle into a real key lockfile:

- if a bundle already exists, reuse it
- if it is missing entries the current server needs, grow it in place
- if it does not exist yet, create it automatically
- never blow away previously-issued key material just because the site inventory changed

This removes the "pregenerate the bundle before boot" footgun from Plan 24 while preserving the original reason the bundle exists: stable demo identities across restarts.

## Problem Statement

Plan 24 solved restart stability, but the operator workflow is still awkward:

1. The persistent bundle is optional and manual.
   - if no bundle exists, the server falls back to ephemeral keys
   - an operator has to remember to run a generator script up front if they want stable identities

2. The generator is all-or-nothing.
   - it emits a complete fresh bundle for a supplied `siteSlugs[]`
   - if the site inventory grows and an operator regenerates the file, every existing key changes with it

3. Startup currently fails on drift.
   - bundle-backed mode throws if the current site inventory contains a provider-site slug that is not already present in `oidf.providerSites`
   - that was honest under Plan 24, but it is the wrong UX for a lockfile model

The pain point is simple: operators want to pin demo keys once, then have that lockfile be reused or extended as needed.

## Desired Runtime Behavior

At normal server boot:

1. Resolve the bundle path.
   - `DEMO_CRYPTO_BUNDLE_PATH`, if set
   - otherwise the conventional `reference-implementation/fhir-server/.demo-crypto-bundle.json`

2. Discover the current site inventory from the loaded store.

3. Ensure the bundle covers:
   - current fixed roles
   - current configured ticket-issuer slugs
   - current provider-site slugs

4. If the bundle file:
   - does not exist: create it
   - exists but is missing needed entries: add only the missing entries
   - already covers everything: leave it untouched

5. Continue boot with the ensured bundle.

The result should feel like a lockfile:
- stable once created
- extended when required
- not regenerated wholesale

## Design Decisions

### 1. This is a lockfile, not a cache

The bundle is persistent desired state, not an ephemeral optimization.

That means:
- normal boots may create the file
- normal boots may extend the file
- normal boots do not randomly rotate existing keys

### 2. `loadConfig()` stays pure

The current boot order is:
- `loadConfig()`
- `FhirStore.load()`
- topology / framework construction

The site inventory is only known after the store is loaded. So this plan should **not** push bundle growth into `config.ts`.

Instead:
- `loadConfig()` continues to do pure env/config parsing
- `createAppContext()` loads the store
- then a new `ensureDemoCryptoBundle(...)` step runs with the discovered `siteSlugs`
- then the resulting bundle is attached to config before OIDF topology / framework construction

This matches the actual architecture and avoids loading the store twice.

### 3. Growth is semantic, not raw-byte preservation

We care about preserving existing key material and unknown fields, not about preserving the exact original JSON byte layout.

Guarantees:
- existing private keys are never rewritten
- existing known entries are not replaced
- unknown top-level and nested keys are carried forward
- stale provider-site entries are preserved
- if no growth is needed, the file is not rewritten at all

Non-goal:
- exact byte-for-byte preservation of the entire file after a growth write

If the file needs to grow, we can reserialize it in a stable pretty-printed form.

### 4. Growth scope comes from current config + current site inventory

Needed entries are not just `siteSlugs`.

The ensure step must cover:
- `ticketIssuers[slug]` for the current configured ticket issuers
- OIDF fixed roles:
  - `anchor`
  - `appNetwork`
  - `providerNetwork`
  - `demoApp`
- `oidf.providerSites[siteSlug]` for every discovered site
- `wellKnown.default`
- `udap.ec`
- `udap.rsa`

This keeps the lockfile aligned with the actual running server, not a hardcoded subset.

### 5. Stale entries are preserved

If the file contains:
- extra `providerSites[siteSlug]` for a site no longer present
- extra `ticketIssuers[slug]`
- unknown future sections

they stay in the file.

This is a grow-only lockfile, not a pruning tool.

### 6. Atomic writes only when needed

If the ensure step adds anything:
- write to a temp file in the same directory
- fsync
- rename into place

If nothing changed:
- do not rewrite
- preserve file mtime

### 7. The conventional default path may dirty the repo

This is intentional.

If no `DEMO_CRYPTO_BUNDLE_PATH` is provided, the server may auto-create:
- `reference-implementation/fhir-server/.demo-crypto-bundle.json`

That is acceptable because the whole point of this plan is to make the lockfile normal, not exceptional.

Tests that need isolation should continue to point `DEMO_CRYPTO_BUNDLE_PATH` at a temp file.

## Proposed API Shape

### New helper

```ts
ensureDemoCryptoBundle(options: {
  bundlePath: string;
  siteSlugs: string[];
  issuerSlugs: string[];
}): DemoCryptoBundle
```

Behavior:

1. Determine whether the file exists.
2. If it does not:
   - generate a complete fresh bundle document
   - write it atomically
   - parse/materialize and return it
3. If it does:
   - parse the raw JSON tolerantly into a mutable document shape
   - add only missing entries
   - if additions were made, write the merged document atomically
   - run the existing strict materialization/validation on the final document
   - return the parsed bundle

### Tolerant read vs strict parse

Keep the current strict parser:
- `parseDemoCryptoBundle(raw, sourceLabel)`

Add a separate tolerant reader/merger for ensure mode:
- accepts partial documents
- preserves unknown fields
- fills missing known sections

Then finish by passing the final JSON through the strict parser.

That keeps schema validation honest while still allowing grow-only repair of partial files.

## Boot Integration

### Current

- `loadConfig()` may read a bundle if one already exists
- `createAppContext()` loads the store
- `buildOidfTopologyForPublicBaseUrl()` asserts the bundle already covers every site

### Revised

- `loadConfig()` only resolves bundle path / env intent
- `createAppContext()` loads the store and computes `siteSlugs`
- `createAppContext()` calls `ensureDemoCryptoBundle(...)`
- the returned bundle is attached to `config.demoCryptoBundle`
- topology/framework/issuer construction uses that ensured bundle
- `assertDemoCryptoBundleCoversSites()` is removed

This is the most important structural correction to the old draft.

## Generator Script Role

Keep `scripts/generate-demo-crypto-bundle.ts`, but demote it to:
- inspection
- CI materialization
- manual fresh regeneration when explicitly desired

It is no longer a prerequisite for normal server boot.

README should say:
- ordinary operators do not need to run it
- boot will create or extend the lockfile automatically

## Logging

Keep logging minimal and concrete.

Examples:

```text
demo crypto bundle: created /.../.demo-crypto-bundle.json with 17 entries
demo crypto bundle: added provider-site key for bay-area-rheumatology-associates
demo crypto bundle: added ticket-issuer key for reference-demo
```

The point is auditability, not verbose migration logs.

## File Impact

- `fhir-server/src/demo-crypto-bundle.ts`
  - add `ensureDemoCryptoBundle(...)`
  - add tolerant read/merge helpers
  - keep `parseDemoCryptoBundle(...)` as final strict validator
- `fhir-server/src/config.ts`
  - stop loading/materializing the bundle directly
  - keep only path resolution / config intent
- `fhir-server/src/app.ts`
  - call `ensureDemoCryptoBundle(...)` from `createAppContext()` after store load
  - remove `assertDemoCryptoBundleCoversSites(...)`
- `fhir-server/test/demo-crypto-bundle.test.ts`
  - update for create/reuse/grow behavior
- `fhir-server/README.md`
  - rewrite the bundle section around lockfile semantics

## Execution

Two phases.

### Phase 1: Lockfile Core

- add bundle-path resolution helpers if needed
- implement `ensureDemoCryptoBundle(...)`
- move bundle ensuring into `createAppContext()` after store load
- remove drift-fail startup assertion
- add/adjust tests for create, reuse, and grow semantics

Files:
- `fhir-server/src/demo-crypto-bundle.ts`
- `fhir-server/src/config.ts`
- `fhir-server/src/app.ts`
- `fhir-server/test/demo-crypto-bundle.test.ts`

### Phase 2: Docs

- update README to describe lockfile behavior
- explicitly note that normal boot may create the conventional bundle path
- note that the generator script is optional/manual

Files:
- `fhir-server/README.md`
- `plans/00-metaplan.md`
- `plans/26-auto-grow-demo-crypto-bundle.md`

## Tests To Add

- boot with no bundle file at the resolved path
  - file is created
  - second boot reuses it unchanged
- boot with an existing bundle missing one provider-site entry
  - only that entry is added
  - existing keys are preserved
- boot with an existing bundle missing a fixed role
  - missing role is added
  - existing roles are preserved
- boot with stale provider-site entries for removed sites
  - stale entries remain
  - no rewrite occurs if nothing current is missing
- boot with a complete bundle
  - no write
  - mtime unchanged
- non-default issuer slug entries are preserved and only added when needed

## Non-Goals

- no schema version bump
- no pruning of stale entries
- no key rotation
- no TTL / JWT expiry changes
- no migration logic across multiple historical bundle versions
- no exact raw-byte preservation after a growth write

## Acceptance Criteria

- starting the server with no bundle file creates one automatically and the server boots normally
- restarting with the same site inventory reuses the same lockfile without rewriting it
- adding a new site and restarting extends the file with one new provider-site entry while preserving existing key material
- startup no longer fails just because the site inventory outgrew the bundle
- normal operators do not need to pregenerate the bundle
- `bun test` stays green
