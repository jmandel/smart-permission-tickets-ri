# Plan 24: Demo Crypto Bundle, Per-Site OIDF Leaves, and OIDF Re-Minting

Status: in progress

## Goal

Make the demo's cryptographic identity stable across process restarts in a simple, ergonomic way, while also fixing the separate OIDF JWT-expiry problem and aligning the OIDF topology with the real provider-side surface model:

- each clinical site is its own provider-network leaf entity
- site leaves are discoverable as OIDF members of the Provider Network
- OIDF entity configurations, subordinate statements, and trust marks stay fresh indefinitely
- demo keys can stay stable across restarts when the operator wants that behavior
- the server still works with zero config when no crypto bundle is provided

## Why This Plan Needs to Cover More Than Keys

Three distinct issues are currently tangled together:

1. **Stable keys across restarts**
   - desirable for a long-lived demo instance
2. **OIDF JWT expiry**
   - currently breaks the demo after 1 hour / 24 hours even if keys are stable
3. **Too-coarse OIDF provider topology**
   - the current OIDF model has one provider-side `fhir-server` leaf
   - but the actual product model has one site auth/FHIR surface per site

If each site is truly a member of the Provider Network, then each site needs:

- its own OIDF entity ID
- its own key material
- its own entity configuration
- its own subordinate statement from the Provider Network

So the bundle format and topology model must be site-aware, not just role-aware.

## Current Limitation

Today in `fhir-server/src/auth/frameworks/oidf/demo-topology.ts`:

- there is one `fhir-server` OIDF leaf entity for the entire provider side
- there are no per-site provider leaves
- OIDF key material is modeled around fixed roles, not site inventory

That is too coarse if we want the Provider Network membership model to match the actual site-level auth surfaces used elsewhere in the server and UI.

## Design Decisions

### 1. No Key Derivation Scheme

Do not derive all demo keys from one master JWK or seed.

Reason:

- the demo needs both EC and RSA material
- UDAP needs PEM CA material as well as client keys
- per-site OIDF keys are easier to manage as explicit stored keys than as derived artifacts
- a stored bundle of actual keys/certs is simpler than inventing deterministic derivation for mixed algorithms and X.509 assets

### 2. One Explicit Demo Crypto Bundle

Use one generated JSON document containing all stable demo crypto material:

- permission-ticket issuer private JWKs
- OIDF fixed-role private JWKs
- OIDF per-site private JWKs
- well-known demo client private JWK
- UDAP EC CA certificate/private key + client private key
- UDAP RSA CA certificate/private key + client private key

This is the single ergonomic persistence surface.

### 3. Sites Are First-Class OIDF Leaf Entities

The Provider Network topology must be revised from:

- one coarse `fhir-server` leaf

to:

- one leaf entity per site auth/FHIR surface

Recommended entity-id shape:

- `${PUBLIC_BASE_URL}/federation/leafs/provider-sites/${siteSlug}`

Each site leaf should publish:

- `oauth_authorization_server` metadata for that site's token endpoint
- `oauth_resource` metadata for that site's FHIR base
- `authority_hints = [providerNetworkEntityId]`

The Provider Network federation fetch endpoint must return subordinate statements for these site entities, so they are actually discoverable as members.

### 4. Site Inventory Comes From Site Metadata, Not Hand-Maintained Lists

The bundle generator and topology builder should key off the discovered site inventory:

- effectively the site's stable `siteSlug`
- derived from the same site metadata the server already loads and exposes

In this repo, site inventory is not an arbitrary config list today; it comes from loaded site metadata / sample-data-backed ingest. That is acceptable, as long as crypto is keyed by `siteSlug`, not by raw sample-data filenames.

### 5. Re-Mint OIDF JWTs on Fetch

Do not cache OIDF entity configurations, subordinate statements, or trust marks as immutable JWT strings.

Instead:

- keep stable entity metadata and keys in memory
- sign fresh JWTs when serving:
  - `/.well-known/openid-federation`
  - `federation_fetch_endpoint`
  - any trust mark embedded in entity configurations

Only `iat` / `exp` change. The underlying keys and entity metadata stay stable.

### 6. One Simple Loading Convention

Keep the operator surface minimal:

- if `DEMO_CRYPTO_BUNDLE_PATH` is set, load that file
- else if a conventional local file exists, load it
- else fall back to current zero-config behavior

Recommended convention path:

- `reference-implementation/fhir-server/.demo-crypto-bundle.json`

Decision:

- the conventional path is repo-root-relative under `fhir-server/`
- do not make this process-cwd-relative

### 7. Keep Current Zero-Config Behavior

If no bundle is present:

- OIDF keys remain ephemeral
- existing hardcoded constants for well-known and UDAP continue to work
- site OIDF leaves are still generated, just with ephemeral keys
- the server still re-mints OIDF JWTs on fetch, so the one-hour expiry problem is fixed even in zero-config mode

## Target Topology Shape

```text
                      [ Trust Anchor ]
                             |
            +----------------+----------------+
            |                                 |
     [ App Network ]                 [ Provider Network ]
            |                                 |
      [ Demo App ]       +--------------------+---------------------+
                         |                    |                     |
                [ Site Leaf A ]       [ Site Leaf B ]      [ Ticket Issuer ]
```

Notes:

- `Demo App` remains a leaf under `App Network`
- `Ticket Issuer` remains a leaf under `Provider Network`
- each site auth/FHIR surface becomes its own leaf under `Provider Network`
- the current coarse `fhir-server` leaf is removed or replaced by these site leaves

Open modeling question for later implementation:

- whether the network-level RLS/token surface should remain represented only by the Provider Network itself or gain its own additional leaf entity

This plan does not require resolving that before the site-leaf work starts.

## Target Bundle Shape

```json
{
  "version": 1,
  "ticketIssuers": {
    "reference-demo": {
      "privateJwk": { "...": "..." }
    }
  },
  "oidf": {
    "anchor": { "privateJwk": { "...": "..." } },
    "appNetwork": { "privateJwk": { "...": "..." } },
    "providerNetwork": { "privateJwk": { "...": "..." } },
    "demoApp": { "privateJwk": { "...": "..." } },
    "providerSites": {
      "bay-area-rheumatology-associates": { "privateJwk": { "...": "..." } },
      "eastbay-primary-care-associates": { "privateJwk": { "...": "..." } }
    }
  },
  "wellKnown": {
    "default": {
      "privateJwk": { "...": "..." }
    }
  },
  "udap": {
    "ec": {
      "caCertificatePem": "-----BEGIN CERTIFICATE-----...",
      "caPrivateKeyPem": "-----BEGIN PRIVATE KEY-----...",
      "clientPrivateJwk": { "...": "..." }
    },
    "rsa": {
      "caCertificatePem": "-----BEGIN CERTIFICATE-----...",
      "caPrivateKeyPem": "-----BEGIN PRIVATE KEY-----...",
      "clientPrivateJwk": { "...": "..." }
    }
  }
}
```

Notes:

- store private material only; public JWKs can be derived
- the bundle loader computes public `x`/`y` for EC keys and public `n`/`e` for RSA keys from the stored private material at load time
- `providerSites` is keyed by `siteSlug`
- a bundle intended for a given demo dataset must cover every discovered site slug

## Config Surface

### New

- `DEMO_CRYPTO_BUNDLE_PATH`
  - path to the JSON bundle file

### Conventional Fallback

- `reference-implementation/fhir-server/.demo-crypto-bundle.json`
  - if present, load it automatically when `DEMO_CRYPTO_BUNDLE_PATH` is unset

### Existing Inputs Kept

None.

This is a greenfield cut. The demo crypto bundle is the only persistent stable-key surface introduced by this plan.

### Precedence

1. `DEMO_CRYPTO_BUNDLE_PATH`
2. conventional bundle file path if it exists
3. zero-config ephemeral behavior when no bundle is present

No inline JSON env var for the whole bundle in the first pass. File-based is simpler and more readable.

## Generator Script

Add one script:

`scripts/generate-demo-crypto-bundle.ts`

Behavior:

- discovers the current site inventory
- generates a complete version-1 bundle including one OIDF provider-site key per discovered `siteSlug`
- prints JSON to stdout
- does not silently write anywhere by default
- uses in-process library calls only; it does not start the HTTP server or require any network access

Typical usage:

```bash
bun run scripts/generate-demo-crypto-bundle.ts > reference-implementation/fhir-server/.demo-crypto-bundle.json
```

Recommended discovery source:

- the same normalized site inventory the server uses at runtime, e.g. via `FhirStore.load().listSiteSummaries()`

That keeps bundle generation aligned with what the server will actually serve.

## Failure Behavior

When a bundle is present:

- if the discovered site inventory contains a `siteSlug` not present in `bundle.oidf.providerSites`, startup should fail loudly
- do not silently mix stable keys for some sites with ephemeral keys for newly discovered sites

When no bundle is present:

- the server may continue using ephemeral site OIDF keys

This keeps "stable mode" honest and predictable.

### 8. UDAP Stability Scope

Decision:

- first pass stabilizes UDAP CA material and UDAP client private keys
- first pass does not promise byte-stable regenerated UDAP leaf certificates
- stable key identity is sufficient for the initial bundle-backed demo use case

## Execution Phases

### Phase 1: Per-Site OIDF Topology Rewrite

Scope:

- replace the single provider-side `fhir-server` OIDF leaf with one leaf per site
- define stable site-leaf entity IDs from `siteSlug`
- publish entity configurations for each site leaf
- publish subordinate statements from Provider Network to each site leaf
- make these site leaves discoverable through the Provider Network's federation fetch endpoint

Files:

- `fhir-server/src/auth/frameworks/oidf/demo-topology.ts`
- `fhir-server/src/app.ts`
- tests covering topology shape and discovery

This is the foundational topology correction.

Status:

- implemented on `main`

### Phase 2: OIDF Re-Minting Fix

Scope:

- stop serving frozen OIDF JWT strings from topology-build time
- keep entity metadata and keys, but sign fresh JWTs per request

Status:

- implemented on `main`

Files:

- `fhir-server/src/auth/frameworks/oidf/demo-topology.ts`
- `fhir-server/src/app.ts`
- `fhir-server/test/oidf-topology.test.ts`

This phase is valuable on its own and fixes the long-running-demo expiry bug even without any stable-key bundle.

### Phase 3: Bundle Schema and Loader

Scope:

- add the bundle schema
- load bundle data from `DEMO_CRYPTO_BUNDLE_PATH` or the conventional file
- expose it through `ServerConfig`
- validate that provider-site keys cover the discovered site inventory when bundle-backed mode is active

Files:

- `fhir-server/src/config.ts`
- new small schema/helper module if needed

Status:

- implemented on `main`

### Phase 4: Bundle Generator Script

Scope:

- add `scripts/generate-demo-crypto-bundle.ts`
- generate all required EC, RSA, and PEM materials in one document
- include one provider-site key per discovered `siteSlug`

Status:

- implemented on `main`

### Phase 5: Wire Bundle Into Existing Surfaces

Scope:

- ticket issuers read from `bundle.ticketIssuers`
- OIDF fixed-role entities read from `bundle.oidf`
- OIDF provider-site leaves read from `bundle.oidf.providerSites`
- well-known demo client reads from `bundle.wellKnown`
- UDAP demo framework reads from `bundle.udap`

Files:

- `fhir-server/src/app.ts`
- `fhir-server/src/auth/frameworks/oidf/demo-topology.ts`
- `fhir-server/src/auth/demo-frameworks.ts`
- ticket-issuer loading path in `fhir-server/src/config.ts`

Greenfield rule:

- remove the standalone `DEFAULT_PERMISSION_TICKET_ISSUER_PRIVATE_JWK_JSON` config path instead of keeping it as a fallback
- after this plan lands, stable persistent ticket-issuer keys come only from the bundle

Status:

- implemented on `main`

### Phase 6: Tests and Docs

Tests:

- Provider Network federation fetch exposes subordinate statements for all discovered site leaves
- site leaf entity configurations resolve and advertise the correct site token/FHIR endpoints
- OIDF topology remains valid after statement TTL would have expired
- two `createAppContext()` calls with the same bundle produce the same public keys for:
  - fixed OIDF roles
  - provider-site leaves
  - well-known client
  - UDAP EC/RSA materials
- bundle-backed startup fails when the site inventory contains a site with no bundle key

Docs:

- README section:
  - what the bundle is
  - how to generate it
  - where to place it
  - that provider sites are first-class OIDF leaves
  - what is stabilized
  - what is not stabilized

## Non-Goals

- no deterministic derivation from a master seed or JWKS
- no runtime key rotation
- no multi-key JWKS rotation story
- no certificate-byte stability guarantee for regenerated UDAP leaf certs unless we explicitly choose to add that later
- no new persistence layer beyond one JSON file
- no attempt in this plan to redesign the full network-level OIDF modeling beyond making site leaves discoverable members of the Provider Network

## Open Design Question

Should the network-level token/RLS surface also get its own provider-side leaf entity, or is representing it through the Provider Network entity sufficient?

Recommendation: defer unless a concrete protocol need appears. This plan only requires site leaves.

## Acceptance Criteria

- the Provider Network publishes discoverable subordinate statements for every site leaf derived from the current site inventory
- each site auth/FHIR surface is represented by its own OIDF leaf entity
- a server with no bundle still works and no longer serves expired OIDF entity statements after one hour
- a server with a bundle keeps OIDF fixed-role entities, provider-site leaves, well-known, ticket-issuer, and UDAP key identities stable across restarts
- OIDF JWT artifacts are re-minted on fetch using the loaded or in-memory keys
- one generator script can produce all required demo crypto material in a single JSON bundle, including one OIDF key per discovered site
- bundle-backed mode fails loudly if discovered sites and bundled site keys fall out of sync
