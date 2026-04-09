# Plan 32: OIDF Browser-Instance Clients, `kid` Hygiene, and OAuth Key Separation

Status: complete on `main`

## Why This Plan Exists

The current OIDF demo client path proves the overall flow, but it has two architectural flaws:

1. ES256 `private_key_jwt` client assertions are emitted without a JOSE `kid`.
2. The OIDF client-auth path uses the leaf entity statement's top-level `jwks` as the OAuth client-auth verification surface.

A related implementation inconsistency sits underneath the first issue: the shared JWK helpers often compute thumbprints separately from the published JWKs, so some demo-published JWKS surfaces still omit `kid` entirely unless the caller remembers to reattach it manually.

The second issue is the important one. In OpenID Federation, the top-level `jwks` in an Entity Statement are **Federation Entity Keys**. They are distinct from the protocol keys used by a client as an OAuth client, which belong in the metadata of the relevant entity type.

The local RFC copy is explicit:

- Entity Statement `jwks` are Federation Entity signing keys, and those keys "SHOULD NOT be used in other protocols": [openid-federation-1.0-rfc.xml](/home/jmandel/work/smart-permission-tickets/reference-implementation/plans/references/openid-federation-1.0-rfc.xml#L563)
- protocol keys belong in entity metadata via `jwks`, `jwks_uri`, or `signed_jwks_uri`, not in the top-level Entity Statement `jwks`: [openid-federation-1.0-rfc.xml](/home/jmandel/work/smart-permission-tickets/reference-implementation/plans/references/openid-federation-1.0-rfc.xml#L1849)
- `oauth_client` is the relevant entity type for OAuth client metadata: [openid-federation-1.0-rfc.xml](/home/jmandel/work/smart-permission-tickets/reference-implementation/plans/references/openid-federation-1.0-rfc.xml#L1814)

Today the reference implementation collapses these roles:

- the OIDF demo app leaf has one keypair used to sign its Entity Configuration
- that same keypair is handed to the browser via `/demo/bootstrap`
- the browser uses it for token-endpoint `private_key_jwt`
- the resolver verifies the `client_assertion` against `resolved.leafEntityJwks`

Relevant code paths:

- shared ES256 signer emits no `kid` unless the caller passes one: [private-key-jwt.ts](/home/jmandel/work/smart-permission-tickets/reference-implementation/fhir-server/shared/private-key-jwt.ts#L56)
- viewer builds OIDF `client_assertion` from the bootstrap-provided private JWK: [viewer-client.ts](/home/jmandel/work/smart-permission-tickets/reference-implementation/fhir-server/ui/src/lib/viewer-client.ts#L405)
- bootstrap currently sends the OIDF demo app private JWK to the browser: [app.ts](/home/jmandel/work/smart-permission-tickets/reference-implementation/fhir-server/src/app.ts#L317)
- OIDF client auth verifies against `resolved.leafEntityJwks`: [resolver.ts](/home/jmandel/work/smart-permission-tickets/reference-implementation/fhir-server/src/auth/frameworks/oidf/resolver.ts#L106), [policy.ts](/home/jmandel/work/smart-permission-tickets/reference-implementation/fhir-server/src/auth/frameworks/oidf/policy.ts#L18)

Plan 32 fixes all of this by moving to a cleaner demo model:

- the browser generates its own ephemeral OIDF client instance
- the browser signs its own leaf Entity Configuration
- the browser uses a distinct OAuth client key published in `metadata.oauth_client.jwks`
- the server signs a subordinate statement about that browser instance using a stable "worldwide app" federation entity
- the browser presents the full `trust_chain` directly in the `client_assertion`
- the holder accepts any `oauth_client` leaf that chains to a trusted OIDF anchor

This removes the need to send any OIDF client private key from the backend to the browser.

## Design Intent

### 1. Split the stable software entity from the browser instance leaf

The OIDF demo client becomes a two-level model:

- a stable server-hosted federation entity representing the software family, referred to in this plan as the **worldwide app entity**
- an ephemeral browser-generated leaf entity representing the current browser instance

The stable entity is long-lived and server-controlled. It is the issuer of subordinate statements about browser instances.

The browser instance is short-lived and browser-controlled. It signs its own Entity Configuration and acts as the actual OAuth client at the token endpoint.

For demo clarity, browser-instance entity IDs should be URL subpaths of the stable parent entity. A concrete recommended shape is:

- worldwide app entity:
  - `${publicBaseUrl}/demo/clients/oidf/worldwide-app`
- browser-instance leaf:
  - `${publicBaseUrl}/demo/clients/oidf/worldwide-app/instances/${instanceId}`

This means the current demo topology changes from:

```text
anchor -> app-network -> demo-app (leaf)
```

to:

```text
anchor -> app-network -> worldwide-app (intermediate) -> browser-instance (leaf)
```

The browser instance is the `client_id` on the wire.

### 2. Browser instances use two keypairs

Each browser instance generates two independent ES256 keypairs:

- **federation keypair**
  - signs the browser instance Entity Configuration
  - is published in the top-level Entity Statement `jwks`
- **OAuth client keypair**
  - signs `private_key_jwt` client assertions
  - is published in `metadata.oauth_client.jwks`

This keeps the model aligned with the OIDF distinction between:

- Federation Entity Keys
- protocol keys used by the OAuth client

The browser instance's federation key and OAuth key are intentionally different.

### 3. The browser signs its own Entity Configuration; the server signs the subordinate statement

The browser instance flow should be:

1. Browser generates federation and OAuth keypairs locally.
2. Browser constructs and signs its own leaf Entity Configuration JWT.
3. Browser posts that signed Entity Configuration to a new internal demo federation API on the server.
4. The server validates the presented leaf Entity Configuration.
5. The server issues a subordinate statement about the browser leaf, signed by the stable worldwide app entity.
6. The browser assembles the full `trust_chain`:
   - browser leaf Entity Configuration
   - subordinate statement issued by the worldwide app entity
   - existing ancestor statements from the worldwide app entity to the trust anchor
7. The browser signs its OAuth `client_assertion` with the OAuth client key and includes the full `trust_chain` in the JOSE header.

No browser-instance private key is ever sent from the server to the browser.

### 4. The browser leaf does not need to publish `/.well-known/openid-federation`

For this demo, the browser leaf does **not** need to host its own discoverable Entity Configuration endpoint.

This is an intentional interoperability tradeoff, but it remains valid OIDF behavior for our use case:

- the `trust_chain` header parameter is allowed to directly carry the leaf Entity Configuration: [openid-federation-1.0-rfc.xml](/home/jmandel/work/smart-permission-tickets/reference-implementation/plans/references/openid-federation-1.0-rfc.xml#L1327)
- doing so explicitly saves the receiver from fetching `/.well-known/openid-federation`: [openid-federation-1.0-rfc.xml](/home/jmandel/work/smart-permission-tickets/reference-implementation/plans/references/openid-federation-1.0-rfc.xml#L7615)
- leaf entities only **SHOULD** publish Entity Configuration at their configuration endpoint, not **MUST**: [openid-federation-1.0-rfc.xml](/home/jmandel/work/smart-permission-tickets/reference-implementation/plans/references/openid-federation-1.0-rfc.xml#L5833)

This plan intentionally violates that `SHOULD` for browser-instance leaves to keep the demo pure and simple.

However, two constraints should hold:

- the browser leaf entity ID still uses a normal absolute URL under the server origin
- the browser leaf should omit `federation_entity` metadata, so we do not conflict with the stronger publication language around that entity type: [openid-federation-1.0-rfc.xml](/home/jmandel/work/smart-permission-tickets/reference-implementation/plans/references/openid-federation-1.0-rfc.xml#L5849)

### 5. First-pass OAuth client key support is `metadata.oauth_client.jwks` only

The OIDF RFC allows three representations for protocol keys in metadata:

- `jwks`
- `jwks_uri`
- `signed_jwks_uri`

Relevant text: [openid-federation-1.0-rfc.xml](/home/jmandel/work/smart-permission-tickets/reference-implementation/plans/references/openid-federation-1.0-rfc.xml#L1849), [openid-federation-1.0-rfc.xml](/home/jmandel/work/smart-permission-tickets/reference-implementation/plans/references/openid-federation-1.0-rfc.xml#L1971), [openid-federation-1.0-rfc.xml](/home/jmandel/work/smart-permission-tickets/reference-implementation/plans/references/openid-federation-1.0-rfc.xml#L2003)

For this plan, first-pass support should be:

- support `metadata.oauth_client.jwks`
- reject absence of OAuth client keys clearly
- do not implement `oauth_client.jwks_uri` or `oauth_client.signed_jwks_uri` yet

This is sufficient for the browser-instance flow and keeps the scope focused. As with earlier first-pass OIDF work, unsupported standard features should fail clearly rather than silently degrade.

### 6. OIDF client admission becomes anchor-based, not leaf-allowlist-based

The current OIDF client-auth model uses both:

- trust-chain validation to configured anchors
- a local `trustedLeaves` allowlist

Code and config:

- model shape: [model.ts](/home/jmandel/work/smart-permission-tickets/reference-implementation/fhir-server/src/store/model.ts#L108)
- resolver check: [resolver.ts](/home/jmandel/work/smart-permission-tickets/reference-implementation/fhir-server/src/auth/frameworks/oidf/resolver.ts#L103)
- default config: [demo-frameworks.ts](/home/jmandel/work/smart-permission-tickets/reference-implementation/fhir-server/src/auth/demo-frameworks.ts#L374)

Plan 32 removes the leaf allowlist for OIDF client auth.

The new client-auth admission rule is:

- the `trust_chain` validates to a configured trust anchor
- the leaf entity ID matches `client_id`
- resolved leaf metadata contains `oauth_client`
- the `client_assertion` verifies against the resolved OAuth client keys from `metadata.oauth_client.jwks`

This means the holder will accept any valid federated `oauth_client` leaf under the trusted anchor. For demo purity and simplicity, that is the desired behavior.

### 7. The stable worldwide app entity still matters

Even though runtime admission no longer names allowed superiors or trusted leaves, the stable worldwide app entity remains important:

- it signs subordinate statements about browser instances
- it is the lineage root for browser leaves
- it can set or constrain browser-leaf metadata via direct `metadata` and `metadata_policy`

This gives the demo a stronger federation story without complicating runtime admission.

The parent-issued subordinate statement should be used to demonstrate metadata policy on browser leaves. For example:

- set or lock `token_endpoint_auth_method = private_key_jwt`
- constrain `grant_types` to `["client_credentials"]`
- optionally set `client_name` to a stable product name

The browser leaf itself should carry only the fields that are inherently per-instance, especially the OAuth JWK Set.

## Settled Decisions

- **This plan fixes two separate bugs together.**
  - missing `kid` on ES256 `private_key_jwt`
  - misuse of OIDF federation keys as OAuth client-auth keys
- **Published demo JWK Sets use thumbprint `kid` values throughout.**
  - for every generated EC P-256 JWK that we publish from the demo, `kid` should equal the JWK thumbprint
  - JWT headers should use the same thumbprint `kid`
- **The browser generates its own keys.** No OIDF client private JWK is sent to the browser from `/demo/bootstrap`.
- **Browser leaves use two keypairs.** One federation keypair and one OAuth client keypair.
- **The server hosts the stable worldwide app entity.** It issues subordinate statements for browser-instance leaves.
- **Browser leaves are not independently hosted.** Their Entity Configuration is carried in the presented `trust_chain`.
- **`metadata.oauth_client.jwks` is the first-pass OAuth key representation.** `jwks_uri` and `signed_jwks_uri` are deferred and fail clearly if they are the only key source.
- **OIDF client admission becomes anchor-based.** `trustedLeaves` is removed for OIDF client auth.
- **No new trust mark is introduced for client admission.** In this demo, chaining to the trusted anchor plus resolved `oauth_client` metadata is sufficient.
- **Ticket issuer trust remains separate.** Plan 29 / 30 ticket-signing key separation stays in place and is not regressed by this plan.

## Key RFC References

The following local RFC sections are the normative backbone for this plan:

- Entity Statement and Federation Entity Keys:
  - Entity Statements require header `kid`: [openid-federation-1.0-rfc.xml](/home/jmandel/work/smart-permission-tickets/reference-implementation/plans/references/openid-federation-1.0-rfc.xml#L480)
  - top-level Entity Statement `jwks` are Federation Entity Keys and "SHOULD NOT" be used in other protocols: [openid-federation-1.0-rfc.xml](/home/jmandel/work/smart-permission-tickets/reference-implementation/plans/references/openid-federation-1.0-rfc.xml#L555)
- Entity types and metadata placement:
  - entity type identifiers: [openid-federation-1.0-rfc.xml](/home/jmandel/work/smart-permission-tickets/reference-implementation/plans/references/openid-federation-1.0-rfc.xml#L1416)
  - `oauth_client` entity type: [openid-federation-1.0-rfc.xml](/home/jmandel/work/smart-permission-tickets/reference-implementation/plans/references/openid-federation-1.0-rfc.xml#L1814)
  - common JWK metadata parameters and separation from federation keys: [openid-federation-1.0-rfc.xml](/home/jmandel/work/smart-permission-tickets/reference-implementation/plans/references/openid-federation-1.0-rfc.xml#L1849)
- Trust-chain carriage and direct entity-configuration passing:
  - trust-chain header parameter: [openid-federation-1.0-rfc.xml](/home/jmandel/work/smart-permission-tickets/reference-implementation/plans/references/openid-federation-1.0-rfc.xml#L1327)
  - direct passing of leaf Entity Configuration to avoid fetch: [openid-federation-1.0-rfc.xml](/home/jmandel/work/smart-permission-tickets/reference-implementation/plans/references/openid-federation-1.0-rfc.xml#L7615)
- Publication model:
  - obtaining Entity Configuration, including leaf `SHOULD` publication: [openid-federation-1.0-rfc.xml](/home/jmandel/work/smart-permission-tickets/reference-implementation/plans/references/openid-federation-1.0-rfc.xml#L5833)

## Phases

### Phase 1: ES256 `private_key_jwt` `kid` hygiene

Work:

- `fhir-server/shared/private-key-jwt.ts`
  - make `signPrivateKeyJwt()` emit a JOSE `kid` by default for ES256 JWK-based assertions
  - if an explicit `kid` is supplied in `extraHeader`, preserve it
  - otherwise compute a thumbprint-based `kid` from the signing key material
  - update shared client-key generation so generated public/private JWKs carry the same thumbprint `kid` by default
- `fhir-server/src/auth/frameworks/oidf/resolver.ts`
  - update `verifyAssertionAgainstJwks()` to prefer header-`kid` matching when present
  - preserve fallback trial verification if `kid` is absent for compatibility
- `fhir-server/src/auth/frameworks/well-known.ts`
  - same `kid`-aware selection behavior
- `fhir-server/src/app.ts`
  - same `kid`-aware behavior for dynamically registered unaffiliated clients
- `fhir-server/ui/src/lib/viewer-client.ts`
  - no caller-side special case should be needed once the shared signer emits `kid`, except to preserve `trust_chain`

Goal:

- all ES256 `private_key_jwt` client assertions emitted by the demo include `kid`
- all demo-published EC JWK Sets carry thumbprint `kid` values by default
- server-side verification uses `kid` when available
- missing `kid` continues to work where we intentionally support backwards compatibility

### Phase 2: OIDF OAuth client key extraction from metadata

Work:

- add a new helper under `src/auth/frameworks/oidf/`, for example:
  - `oauth-client-keys.ts`
  - or a more general `protocol-keys.ts`
- implement a resolver helper that:
  - reads `resolvedMetadata.oauth_client`
  - validates `oauth_client.jwks.keys`
  - requires non-empty keys array
  - requires non-empty unique `kid` for each key
  - normalizes each key to public-only form
  - returns resolved OAuth client public JWKs
- keep error messages grep-friendly, for example:
  - `oidf_oauth_client_metadata_missing`
  - `oidf_oauth_client_jwks_missing`
  - `oidf_oauth_client_jwks_kid_missing`
  - `oidf_oauth_client_jwks_duplicate_kid`
  - `oidf_oauth_client_jwks_invalid_key`
  - `oidf_oauth_client_jwks_uri_unsupported`
  - `oidf_oauth_client_signed_jwks_uri_unsupported`
- `src/auth/frameworks/oidf/policy.ts`
  - stop returning `leafEntityJwks` as the client-auth verification surface
  - either remove that field or rename it to reflect its actual meaning as Federation Entity Keys
- `src/auth/frameworks/oidf/resolver.ts`
  - client auth must verify against resolved OAuth client keys from metadata, not leaf top-level federation keys
  - `ResolvedFrameworkEntity.publicJwks` for OIDF client auth should represent the resolved OAuth client keys, not federation keys

Goal:

- OIDF client auth uses `metadata.oauth_client.jwks`
- leaf top-level Entity Statement `jwks` are no longer treated as OAuth client-auth keys

### Phase 3: Demo topology refactor — stable worldwide app entity plus browser-instance leaves

Work:

- `src/auth/frameworks/oidf/demo-topology.ts`
  - refactor the current `demo-app` from leaf into a stable parent entity under the app network
  - this parent entity remains server-controlled and published
  - it becomes the issuer of subordinate statements for browser-instance leaves
  - it should have the metadata needed for its federation role and any policy baseline it imposes on children
- define a browser-instance entity ID pattern, for example:
  - stable parent: `${publicBaseUrl}/demo/clients/oidf/worldwide-app`
  - browser leaf: `${publicBaseUrl}/demo/clients/oidf/worldwide-app/instances/${instanceId}`
  - browser leaves should be structural URL subpaths of the stable parent for demo readability, even though trust is established by signed subordinate statements rather than URL prefix semantics
- keep ancestor chain material for the stable parent reusable:
  - parent self-signed Entity Configuration remains published/available
  - parent-to-anchor path remains static and cacheable

Goal:

- there is a server-hosted OIDF entity representing the software family
- actual browser instances become dynamic subordinate leaves

### Phase 4: Internal federation API for browser-instance subordinate statements

Work:

- `src/app.ts`
  - add a new internal demo endpoint for browser-instance leaf submission, for example:
    - `POST /demo/oidf/browser-client-instance`
  - the request should contain a signed browser leaf Entity Configuration JWT
- validation rules for the submitted leaf Entity Configuration:
  - `typ = entity-statement+jwt`
  - header includes `kid`
  - `iss === sub === submitted entity ID`
  - top-level `jwks.keys` present and valid for the federation signing key
  - `metadata.oauth_client` present
  - `metadata.oauth_client.jwks.keys` present and valid for OAuth client auth
  - `authority_hints` either absent or equal to the stable parent entity ID, depending on the chosen strictness
  - no `federation_entity` metadata on the browser leaf
  - reject `jwks_uri` / `signed_jwks_uri` in the browser leaf for now if we are not implementing them
- response shape:
  - the issued subordinate statement JWT
  - optionally the fully assembled trust chain array for convenience
  - the stable parent entity ID and entity configuration URL if useful for inspection
- no persistence is required in first pass
- no hosted browser-leaf `/.well-known/openid-federation` route is required in first pass

Goal:

- the browser can obtain a valid subordinate statement without receiving any server-side private key

### Phase 5: Browser OIDF client flow in the UI

Work:

- `fhir-server/src/app.ts`
  - `/demo/bootstrap` must stop sending `privateJwk` for the OIDF client option
  - instead send only:
    - stable parent entity information
    - trust chain ancestor material if needed
    - the browser-instance issuance endpoint path
- `fhir-server/ui/src/types.ts`
  - update the OIDF client plan shape to remove backend-provided private keys
  - add any fields needed for browser-instance minting
- `fhir-server/ui/src/demo.ts`
  - update client-story copy to reflect browser-generated OIDF instance keys if the UI surfaces that story
- `fhir-server/ui/src/lib/viewer-client.ts`
  - generate two keypairs in browser for OIDF client path
  - construct and sign the browser leaf Entity Configuration locally
  - call the new internal federation API
  - assemble the final `trust_chain`
  - sign the token-endpoint `client_assertion` with the browser OAuth client key
  - include `trust_chain` in the JOSE header and `kid` in the assertion header
- `fhir-server/ui/src/viewer-client.test.ts`
  - extend current tests to verify the new browser-instance flow

Goal:

- the browser owns the OIDF demo client's private keys
- the backend no longer exports an OIDF client private JWK to the browser

### Phase 6: OIDF client admission simplification

Work:

- `src/store/model.ts`
  - remove `trustedLeaves` from `FrameworkDefinition.oidf` for OIDF client auth
  - keep `trustAnchors`, `maxTrustChainDepth`, `maxAuthorityHints`
  - keep `requiredIssuerTrustMarkType` for issuer trust, which is unrelated
- `src/auth/frameworks/oidf/resolver.ts`
  - remove `isAllowlistedClientLeaf()` from OIDF client-auth flow
  - accept a client if:
    - chain validates to a configured anchor
    - leaf entity ID matches `client_id`
    - resolved metadata contains `oauth_client`
    - `client_assertion` verifies against resolved OAuth client keys
- `src/auth/demo-frameworks.ts`
  - drop demo OIDF `trustedLeaves` configuration

Goal:

- OIDF client admission becomes anchor-based and metadata-based, not leaf-allowlist-based

### Phase 7: Documentation and diagnostics

Work:

- `fhir-server/README.md`
  - document the new browser-instance OIDF client model
  - document that OIDF OAuth client keys come from `metadata.oauth_client.jwks`
  - document that top-level Entity Statement `jwks` are federation keys, not OAuth client keys
  - document first-pass support for `oauth_client.jwks` only
- `fhir-server/README.md` or inline docs near the browser issuance endpoint
  - explain the intentional leaf-publication `SHOULD` violation for browser-instance demo leaves
- error messages:
  - make all new OIDF OAuth-key diagnostics grep-friendly
  - keep the distinction between federation-key and OAuth-key failures obvious
- `plans/00-metaplan.md`
  - add Plan 32 after implementation

Goal:

- the corrected OIDF key model is explicit and not buried in code

## Testing Strategy

This plan should prefer functional tests where the full trust and token flow is exercised, with small unit tests only where they provide good isolation for low-level key handling.

### Unit Tests

1. `shared/private-key-jwt.ts`
- `signPrivateKeyJwt()` emits `kid` by default for ES256 keys
- explicit caller-supplied `kid` still wins
- `verifyPrivateKeyJwt()` remains compatible with assertions that omit `kid`

2. OIDF OAuth-key extraction helper
- resolves valid `oauth_client.jwks`
- rejects missing metadata
- rejects empty keys
- rejects missing `kid`
- rejects duplicate `kid`
- rejects invalid public keys
- rejects `jwks_uri` / `signed_jwks_uri` as unsupported in first pass

3. OIDF key-selection helper
- when assertion header `kid` is present and matches, only that candidate is used
- when header `kid` is absent, fallback multi-key verification still works
- when header `kid` is present but unknown, fail clearly

### Functional / Integration Tests

1. End-to-end browser-instance OIDF token exchange
- browser-generated leaf Entity Configuration + parent-issued subordinate statement + ancestor chain authenticates successfully at the token endpoint
- token exchange succeeds without any backend-provided OIDF client private key

2. No bootstrap private-key leak
- `/demo/bootstrap` no longer returns `privateJwk` for the OIDF client option
- unaffiliated and well-known behavior remains unchanged unless intentionally revised

3. Federation-key misuse is actually fixed
- if the browser signs the `client_assertion` with the leaf federation key instead of the `oauth_client` key, OIDF client auth fails
- if the browser signs with the `oauth_client` key published in metadata, OIDF client auth succeeds

4. `kid` behavior
- OIDF client assertions now include `kid`
- well-known and unaffiliated ES256 client assertions now include `kid`
- verification still works when testing a legacy assertion without `kid`

5. Admission model simplification
- a valid anchored `oauth_client` leaf is accepted without `trustedLeaves`
- a chain that validates but whose leaf lacks `oauth_client` metadata is rejected clearly
- a chain that validates but whose `oauth_client.jwks` are malformed is rejected clearly

6. Browser-instance submission validation
- malformed leaf Entity Configuration rejected
- `iss/sub` mismatch rejected
- missing federation `jwks` rejected
- missing `oauth_client.jwks` rejected
- browser leaf including `federation_entity` metadata rejected if that is part of the chosen constraints

7. Existing OIDF issuer-trust behavior remains intact
- ticket issuer trust still resolves against `smart_permission_ticket_issuer.jwks`
- no regression where issuer trust accidentally starts using leaf top-level federation keys again

### Specific Test Files To Update or Add

Expected touch points:

- `fhir-server/ui/src/viewer-client.test.ts`
- `fhir-server/test/oidf-auth.test.ts`
- `fhir-server/test/oidf-external-consumption.test.ts`
- `fhir-server/test/modes.test.ts`
- `fhir-server/test/framework-auth.test.ts`
- `fhir-server/src/auth/frameworks/oidf/trust-chain.test.ts` only if helper behavior needs direct unit coverage
- a new focused test file for the browser-instance issuance endpoint if that keeps the behavior clearer than burying it inside broader token tests

## File Touch Points

Primary implementation files expected to change:

- `reference-implementation/fhir-server/shared/private-key-jwt.ts`
- `reference-implementation/fhir-server/src/auth/frameworks/oidf/resolver.ts`
- `reference-implementation/fhir-server/src/auth/frameworks/oidf/policy.ts`
- `reference-implementation/fhir-server/src/auth/frameworks/oidf/demo-topology.ts`
- `reference-implementation/fhir-server/src/auth/demo-frameworks.ts`
- `reference-implementation/fhir-server/src/store/model.ts`
- `reference-implementation/fhir-server/src/app.ts`
- `reference-implementation/fhir-server/ui/src/types.ts`
- `reference-implementation/fhir-server/ui/src/demo.ts`
- `reference-implementation/fhir-server/ui/src/lib/viewer-client.ts`

Likely new files:

- `reference-implementation/fhir-server/src/auth/frameworks/oidf/oauth-client-keys.ts`
- possibly one new test file for browser-instance subordinate statement issuance

## Acceptance Criteria

Plan 32 is complete when all of the following are true:

1. No OIDF client private JWK is delivered to the browser from `/demo/bootstrap`.
2. OIDF browser-instance clients generate their own federation and OAuth keypairs in-browser.
3. The browser signs its own leaf Entity Configuration and receives a subordinate statement from a server-side worldwide app entity.
4. The token endpoint accepts the browser instance via a supplied `trust_chain` without requiring hosted browser-leaf discovery.
5. OIDF client auth verifies against resolved `metadata.oauth_client.jwks`, not leaf top-level federation `jwks`.
6. A `client_assertion` signed with the wrong key role fails.
7. ES256 `private_key_jwt` assertions now include `kid`, and verifiers use it when present.
8. `trustedLeaves` is no longer part of OIDF client admission.
9. Existing OIDF issuer trust and ticket-signing key separation remain green.
10. `bun test` and `bunx tsc --noEmit` pass in `reference-implementation/fhir-server`.

## Out of Scope

- supporting `oauth_client.jwks_uri`
- supporting `oauth_client.signed_jwks_uri`
- re-hosting or persisting browser-instance Entity Configurations
- introducing a new client trust mark
- changing the ticket-issuer trust model established by Plans 29 and 30
- changing UDAP or well-known framework semantics beyond shared `kid` hygiene for ES256 JWK-based assertions
