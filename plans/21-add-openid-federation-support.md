# Plan 21: Add OpenID Federation 1.0 Support

Status: implemented on `main`

## Post-Implementation Status as of 2026-04-07

This is the canonical OIDF plan for the reference implementation.

Current `main` status:
- Prep rename is implemented on `main`.
- Phases 1 through 7 are implemented on `main`.
- The original Phase 2 / 4 / 5 / 6 trust-chain work was corrected in place after RFC review. The corrected trust-chain shape and validation rules are now folded directly into the canonical phase text below.

What is on `main` today:
- OIDF framework type, resolver dispatch, metadata policy engine, demo topology, token-endpoint client auth, issuer-trust resolution, and Phase 7 UI / Protocol Trace integration are implemented.
- The trust chain now follows the RFC-conformant shape for a depth-3 path.

## Goal

Add a thin, spec-aligned OpenID Federation 1.0 path to the reference implementation so the demo can show:

- URL-identified client authentication without prior dynamic registration
- trust-chain-based framework binding for client identity
- metadata-policy resolution of leaf client metadata
- OIDF-backed issuer trust for the Permission Ticket issuer
- a topology with one Trust Anchor, one App Network, one Provider Network, and a small set of leaf entities

This plan is a clean addition to the existing framework abstraction. It does not introduce compatibility shims, alternate legacy models, or ad hoc client-id prefixes.

## Verified OIDF References

The implementation should cite and follow the current OpenID Federation 1.0 Final text (17 February 2026) at:

- `1.2 Terminology`: Entity Identifier definition
- `3.1 Entity Statement Claims`
- `3.2 Entity Statement Validation`
- `4 Trust Chains`
- `4.3 Trust Chain Header Parameter`
- `6.1.3.1 Standard Operators`
- `6.1.4.1 Resolution`
- `6.1.4.2 Application`
- `7.1 Trust Mark Claims`
- `8.1 Fetching a Subordinate Statement`
- `9.1 Federation Entity Configuration Request`
- `9.2 Federation Entity Configuration Response`
- `10.2 Validating a Trust Chain`
- `12.1 Automatic Registration`
- `12.1.4 Automatic Registration and Client Authentication`
- `12.1.5 Possible Other Uses of Automatic Registration`

Where the exact section number is not critical in code comments or docs, prefer the section name over the number.

## Design Decisions

### 1. OIDF client_id model

Do not invent an `oidf:` prefix.

For OIDF clients, the `client_id` on the wire is the client's Entity Identifier URL itself, as received on the wire. This is required for conformance and avoids creating a second, implementation-local identifier scheme.

### 2. Resolver dispatch model

OIDF client auth must be detected from the `client_assertion` JOSE header, not from the shape of `client_id`.

Implementation rule:

- the framework registry peeks at the unverified JOSE protected header of `assertionJwt` for dispatch purposes only
- if the header contains `trust_chain`, route to the OIDF resolver first
- otherwise continue with the existing `matchesClientId(...)` dispatch used by well-known and UDAP resolvers

This requires a small interface extension, not a rewrite:

- add `matchesAssertion?(clientId: string, joseHeader: Record<string, unknown>): boolean` to `FrameworkResolver`
- call `matchesAssertion` before `matchesClientId`

### 3. Single-origin path-based topology

Entity Identifiers in OIDF are HTTPS URLs with host, optional port, and optional path, with no query or fragment. That allows a single-origin path-based demo topology.

The plan assumes entity identifiers under one public origin:

- `${PUBLIC_BASE_URL}/federation/anchor`
- `${PUBLIC_BASE_URL}/federation/networks/provider`
- `${PUBLIC_BASE_URL}/federation/networks/app`
- `${PUBLIC_BASE_URL}/federation/leafs/demo-app`
- `${PUBLIC_BASE_URL}/federation/leafs/fhir-server`
- `${PUBLIC_BASE_URL}/federation/leafs/ticket-issuer`

Each entity publishes its Entity Configuration at the corresponding path-based well-known endpoint:

- `${entity_id}/.well-known/openid-federation`

This keeps the demo spec-valid without requiring multi-host deployment.

### 4. Automatic Registration scope

This implementation uses OIDF Automatic Registration semantics for OAuth client authentication at the token endpoint.

Important nuance:

- OIDF defines Automatic Registration in the OpenID Connect context in Section 12.1
- Section 12.1.5 leaves the door open for this model to be used for OAuth 2.0 use cases beyond OpenID Connect

So in this reference implementation:

- the viewer sends a `client_assertion` signed by the leaf client key
- the `trust_chain` is carried in the JOSE header of that `client_assertion`
- the token endpoint validates the trust chain, resolves client metadata, and authenticates the client without `/register`

No separate explicit registration endpoint is part of the OIDF path.

### 5. Metadata-policy scope

First pass supports only this metadata-policy operator subset:

- `value`
- `default`
- `one_of`

Everything else is rejected.

This is intentional and must be explicit:

- per `6.1.3.1 Standard Operators`, if an operator is not understood and supported, the statement using it is invalid
- therefore, chains containing `add`, `subset_of`, `superset_of`, `essential`, or custom operators will be rejected as invalid in this first pass
- the in-process demo topology must only emit the supported subset

### 6. Trust Mark scope

For this pass, trust marks are used only to endorse the Ticket Issuer within the in-process topology.

Validation scope for this pass:

- verify `typ = trust-mark+jwt`
- verify required claims including `iss`, `sub`, `iat`, `exp`, `trust_mark_type`
- verify the signature using the already validated Provider Network entity keys
- require the expected `trust_mark_type`

Out of scope for this pass:

- delegated trust marks
- trust-mark status endpoints
- claiming full generic conformance to `7.3 Validating a Trust Mark` for arbitrary external issuers

### 7. Correct trust-chain shape

The canonical trust-chain model in this plan is the corrected RFC-conformant shape.

Definition:
- trust-chain depth = number of entity levels from the leaf to the Trust Anchor, inclusive

For depth `N`:
- if `N = 1`, the chain contains only the Trust Anchor Entity Configuration
  - `chain.length = 1`
- if `N >= 2`, `chain.length = N + 1`

With `MAX_ENTITY_DEPTH = 3` in this implementation:
- maximum legal chain length is `4`
- legal lengths are:
  - `1` for the Trust-Anchor-only edge case
  - `3` for leaf directly under anchor
  - `4` for leaf under one intermediate under anchor

The demo topology exercises only the depth-3 / length-4 case.

For a depth-3 path, the emitted trust chain is:

- `ES[0]`: leaf Entity Configuration
- `ES[1]`: Subordinate Statement from the immediate superior about the leaf
- `ES[2]`: Subordinate Statement from the Trust Anchor about the intermediate
- `ES[3]`: Trust Anchor Entity Configuration

Important rules:
- intermediate Entity Configurations are fetched for discovery and `authority_hints`, but are not part of the emitted trust-chain array
- subordinate statements carry the subject entity's `jwks`
- the subordinate-statement `jwks` is a copy of the subject entity's Entity Configuration `jwks`
- this verifier requires the Trust Anchor Entity Configuration as the terminal array element
- the RFC's anchor-omitted variant is out of scope for this pass

Signature rules:
- `ES[0]` is self-signed with a key in `ES[0]["jwks"]`
- for each `j = 0..i-1`, `ES[j]` must validate with a key in `ES[j+1]["jwks"]`
- `ES[i]` must validate with a configured Trust Anchor key

Metadata-policy ordering:
- the corrected `VerifiedTrustChain.metadataPolicies` remains leaf-first
- the policy engine should consume that ordering directly without reordering

## Non-Goals

- No HTTP fetching of foreign trust anchors. All federation entities live in this server process.
- No real multi-host deployment. The topology is path-based on one public origin.
- No runtime key rotation. Keypairs are generated at server boot and are stable for the process lifetime.
- No trust anchor rotation and no multi-anchor topologies. One configured Trust Anchor for the demo process lifetime.
- No trust chains deeper than Anchor -> Network -> Leaf.
- No explicit registration endpoint for OIDF clients.
- No support for metadata-policy operators beyond `value`, `default`, and `one_of`.
- No new standalone swimlane/feed events in Protocol Trace for trust-chain or policy processing.

## Topology

```text
                      [ Trust Anchor ]
                /federation/anchor
                             |
            +----------------+----------------+
            |                                 |
     [ App Network ]                 [ Provider Network ]
/federation/networks/app       /federation/networks/provider
            |                                 |
     +------+                  +--------------+--------------+
     |                         |                             |
[ Demo App ]             [ FHIR Server ]            [ Ticket Issuer ]
/federation/leafs/       /federation/leafs/         /federation/leafs/
demo-app                 fhir-server                ticket-issuer
```

Entity roles:

- Trust Anchor: `federation_entity`
- App Network: `federation_entity`
- Provider Network: `federation_entity`
- Demo App: `oauth_client`
- FHIR Server: `oauth_authorization_server` and `oauth_resource`
- Ticket Issuer: federation leaf carrying a Provider Network-issued trust mark identifying it as a trusted Permission Ticket issuer

## Code Segregation

OIDF logic should remain isolated under a dedicated directory:

- `src/auth/frameworks/oidf/resolver.ts`
- `src/auth/frameworks/oidf/trust-chain.ts`
- `src/auth/frameworks/oidf/policy.ts`
- `src/auth/frameworks/oidf/trust-mark.ts`
- `src/auth/frameworks/oidf/demo-topology.ts`

Minimal touch points outside that directory:

- `src/auth/frameworks/types.ts`
  - add `matchesAssertion?`
- `src/auth/frameworks/registry.ts`
  - peek JOSE header and dispatch assertion-based resolvers first
- `src/app.ts`
  - route OIDF entity configuration and subordinate-statement fetch endpoints
- `src/store/model.ts`
  - add `"oidf"` to `FrameworkType` and `ClientAuthMode`
- `shared/permission-ticket-schema.ts`
  - add `"oidf"` to `FrameworkTypeSchema`
- viewer / workbench / protocol trace
  - Phase 7 only, after backend crypto and trust paths are green

## Execution Phases

### Prep Commit: Provider Network Rename

Status on `main`: implemented

- rename "Reference Network" to "Provider Network"
- land this as a separate prep commit before Phase 1
- keep this commit explicitly out of Plan 21 implementation scope
- require `bun test` green before proceeding
- make the commit message explicitly say it is a prep rename and not part of Plan 21

### Phase 1: Core Types and Resolver Dispatch

Status on `main`: implemented

- add `"oidf"` to:
  - `FrameworkTypeSchema`
  - server `FrameworkType`
  - server `ClientAuthMode`
  - any UI/demo types that enumerate framework auth modes
- extend `FrameworkResolver` with:
  - `matchesAssertion?(clientId, joseHeader)`
- update `FrameworkRegistry.authenticateClientAssertion(...)` to:
  - parse the unverified JOSE protected header once
  - ask resolvers with `matchesAssertion` first
  - fall back to existing `matchesClientId` dispatch second
- do not change the existing well-known or UDAP matching behavior beyond this new pre-dispatch hook

### Phase 2: Trust Chain Engine

Status on `main`: implemented, with the corrected chain-shape model folded in

- implement `verifyTrustChain(chain, expectedAnchor, trustedAnchorJwks, supplementalEntityConfigurations?)`
- validate each Entity Statement as a signed JWT with:
  - `typ = entity-statement+jwt`
  - acceptable `alg`
  - required claims from `3.1`
- enforce trust-chain cryptographic linkage per `10.2 Validating a Trust Chain`
- enforce expiration / issuance-time checks on each statement
- enforce maximum depth of 3
- reject if `chain.length > 4`
- allow `chain.length == 1` and `chain.length == 3` as legal edge cases, even though the demo topology does not emit them
- require the terminal Trust Anchor Entity Configuration
- use fetched intermediate Entity Configurations only as supplemental material for `authority_hints`, not as members of the trust-chain array

Deliverables:

- parsed trust-chain model
- chain-verification helpers
- unit tests for signature chaining, expiration failure, wrong anchor, wrong `iss/sub` linkage, missing/incorrect `authority_hints`, and malformed headers

### Phase 3: Metadata Policy Engine

Status on `main`: implemented

- implement `applyMetadataPolicy(leafMetadata, policyLayers)` for the supported operator subset:
  - `value`
  - `default`
  - `one_of`
- implement top-down resolution and application consistent with:
  - `6.1.4.1 Resolution`
  - `6.1.4.2 Application`
- reject any statement containing unsupported standard operators or custom operators before policy application
- treat incompatible policy outcomes as chain-validation failure
- resolved metadata missing required fields, specifically the leaf client `jwks`, also invalidates the chain

First-pass target:

- resolve only the metadata fields actually consumed by the runtime, especially:
  - `client_name`
  - `jwks`
  - issuer-facing metadata needed for issuer trust

### Phase 4: Demo Topology and Federation Endpoints

Status on `main`: implemented, with the corrected chain-shape model folded in

- generate process-lifetime keypairs and Entity Configurations for:
  - Trust Anchor
  - App Network
  - Provider Network
  - Demo App
  - FHIR Server
  - Ticket Issuer
- serve Entity Configurations at each:
  - `${entity_id}/.well-known/openid-federation`
- serve subordinate statements from each network's:
  - `${network_entity_id}/federation_fetch_endpoint`
- ensure the App Network emits metadata policy for the Demo App using only supported operators
- mint a non-delegated Trust Mark for the Ticket Issuer, signed by the Provider Network, and embed it in the issuer's Entity Configuration `trust_marks`
- use one stable trust mark type value for the demo:
  - `${PUBLIC_BASE_URL}/federation/trust-marks/permission-ticket-issuer`
- emit the depth-3 trust chain in the corrected 4-statement form

The topology is entirely in-process. No external federation discovery is performed.

### Phase 5: Token Endpoint Integration for OIDF Client Auth

Status on `main`: implemented, with the corrected chain-shape model folded in

- add `OidfFrameworkResolver` to the framework registry
- implement `matchesAssertion` by detecting the `trust_chain` JOSE header parameter
- require OIDF `client_id` to equal the leaf client Entity Identifier URL
- validate in this exact order:
  - parse and structurally validate each Entity Statement in the chain (`typ`, required claims, acceptable `alg`)
  - verify the cryptographic trust chain up to the configured Trust Anchor
  - apply metadata policy top-down to produce resolved client metadata
  - extract the leaf client `jwks` from the resolved metadata
  - verify the `client_assertion` signature using the extracted `jwks`
  - verify the `client_assertion` claims (`iss`, `sub`, `aud`, `exp`, `jti`), including `aud == tokenEndpointUrl`
- return `AuthenticatedClientIdentity` with:
  - `authMode: "oidf"`
  - resolved `clientName`
  - resolved framework/entity metadata
- if any step fails, reject with a clear diagnostic and do not continue to later steps

Important:

- this is automatic-registration-style auth, not dynamic registration
- the `trust_chain` header is the OIDF signal
- do not invent any new `client_id` prefix or registration artifact

### Phase 6: OIDF Issuer Trust Integration

Status on `main`: implemented, with the corrected chain-shape model folded in

- implement `resolveIssuerTrust` for OIDF-backed issuers
- for the Ticket Issuer entity:
  - fetch its Entity Configuration over loopback HTTP from the in-process topology endpoints, not by calling an internal helper directly
  - validate its trust chain up to the Trust Anchor
  - locate the required trust mark in `trust_marks`
  - verify the Trust Mark signature against the Provider Network entity keys
  - require the expected `trust_mark_type`
- return `ResolvedIssuerTrust` with:
  - source = framework
  - framework type = `oidf`
  - issuer metadata
  - verified trust-mark payload as displayable metadata/artifact

Loopback-only fetch rule:

- issuer-trust resolution should exercise the same `/.well-known/openid-federation` and `federation_fetch_endpoint` HTTP paths the demo exposes
- these fetches are loopback-only within this server/process topology
- no external federation HTTP fetches are performed

### Phase 7: UI and Protocol Trace Integration

Status on `main`: implemented

Implemented deliverables:

- add an `OIDF Client` card to the Permission Workbench
- when selected, the viewer obtains the demo app trust chain from the local topology and injects it into the `client_assertion` JOSE header
- update viewer/demo copy to explain:
  - client_id is the entity URL
  - no registration occurs
  - trust is established through the supplied trust chain
- update Protocol Trace using nested audit steps and artifacts inside the token/client-setup interactions:
  - trust chain validated
  - metadata policy applied
  - resolved metadata summary
- update the Artifact Viewer to decode and display:
  - the trust chain
  - the resolved metadata
  - the Ticket Issuer trust mark

Do not add new standalone swimlane/feed events for these steps.

## Testing Strategy

### Unit Tests

`trust-chain.test.ts`

- valid 3-deep chain succeeds
- tampering with the leaf statement breaks signature chaining
- expired intermediate invalidates the whole chain
- wrong anchor invalidates the chain
- wrong `iss/sub` linkage invalidates the chain
- missing or incorrect `authority_hints` invalidates the chain
- malformed `trust_chain` header payload is rejected

`policy.test.ts`

- `value` forces the resolved value
- `default` fills only when leaf metadata omits the field
- `one_of` narrows to an allowed value
- conflicting `one_of` policies fail resolution
- any unsupported operator causes chain invalidation per `6.1.3.1`

### Integration Tests

`oidf-auth.test.ts`

- unknown URL `client_id` authenticates successfully when a valid `trust_chain` header is supplied
- the resolved `client_name` comes from policy resolution, not just the leaf metadata
- OIDF dispatch wins based on `trust_chain` header even though the `client_id` is also a URL
- a URL `client_id` without `trust_chain` continues to follow the non-OIDF path

`oidf-issuer-trust.test.ts`

- Ticket Issuer trust resolves through the OIDF topology
- missing or wrong trust mark rejects issuer trust
- malformed or invalid trust mark rejects issuer trust

### UI / End-to-End Tests

- workbench can select OIDF client path
- generated client assertion contains `trust_chain` in the JOSE header
- Protocol Trace shows OIDF validation detail as nested steps/artifacts, not new feed steps

## Acceptance Criteria

- OIDF clients use their Entity Identifier URL directly as `client_id`
- OIDF dispatch occurs from the `trust_chain` JOSE header, not a client-id prefix
- the server validates a depth-3 in-process trust chain using the corrected 4-statement RFC shape
- the server applies metadata policy using the supported subset and rejects unsupported operators
- the token endpoint authenticates an OIDF client without `/register`
- the Ticket Issuer can be trusted through OIDF issuer-trust resolution and a verified trust mark
- the viewer can exercise the OIDF client path on `main`
- Protocol Trace exposes trust-chain and metadata-resolution details as nested artifacts/steps within existing interactions
- no backward-compatibility adapters or dual-model client-ID schemes are introduced
