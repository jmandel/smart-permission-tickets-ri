# Plan 23: Generalize OIDF Entity Consumption

Status: in progress

## Goal

Revise the OIDF integration from a single-demo-topology resolver into a generic consumer that can trust any explicitly allowlisted OIDF leaf entity, including:

- our own in-process demo entities
- external OIDF clients presenting a valid `trust_chain`
- external OIDF-backed ticket issuers whose trust chain and trust mark can be fetched and verified

The result should "just work" for any allowlisted OIDF entity URL that is valid under the configured trust anchors, without relying on path-based assumptions that only fit our own demo topology.

## Why This Follow-On Plan Exists

Plan 21 made OIDF work end to end for the demo and corrected the trust-chain shape and static validation behavior. But the current resolver still has demo-local assumptions that limit generic consumption:

- issuer trust is pinned to one configured `ticketIssuerUrl`
- issuer trust starts from one configured `ticketIssuerEntityId`
- issuer-trust fetches are built from `PUBLIC_BASE_URL + local path`
- the resolver assumes the same in-process topology for all OIDF entities

Those assumptions are acceptable for the demo topology but prevent the server from acting as a general OIDF-aware data holder.

## Design Principles

### 1. Keep Client `trust_chain` Validation Static

For OIDF client authentication at the token endpoint:

- the client still supplies a full `trust_chain` in the JOSE header
- the server validates that chain entirely in memory
- no network calls are required on the token request path

This remains aligned with Plan 21 and the RFC's static-validation / DoS-prevention model.

### 2. Use Real OIDF Entrypoints Only

Do not add ad hoc "entrypoint hints" or implementation-local discovery objects.

The only OIDF discovery/fetch surfaces used by the resolver should be:

- the entity's real `/.well-known/openid-federation` endpoint
- the real `federation_fetch_endpoint` published in superior entity configurations

### 3. `INTERNAL_BASE_URL` Is Only a Self-Fetch Rewrite

`INTERNAL_BASE_URL` remains a narrow hosting workaround:

- if the server needs to fetch one of its own public OIDF URLs, rewrite only the origin to the internal loopback base
- if the target is external, fetch the external URL as-is

This plan must not convert the resolver into a "local-only" fetch engine.

### 4. Trust Is Explicitly Allowlisted

The server should not accept arbitrary OIDF leaves just because they can produce a valid chain.

Instead, acceptance is bounded by configuration:

- trusted OIDF leaf entity IDs are explicitly allowlisted
- trusted OIDF trust anchors are explicitly configured
- issuer trust is accepted only for allowlisted issuer entities

### 5. One Issuer URL Can Participate in Multiple Trust Contexts

This plan does not require separate ticket issuers for local vs OIDF trust.

One issuer URL may continue to support:

- direct/local issuer metadata + JWKS
- OIDF issuer trust

The data holder decides which trust path to apply. Tickets do not carry a framework selector.

## Target Configuration Model

Replace the current single-topology OIDF settings with a generic consumer model.

Current model in `src/store/model.ts`:

- one `trustAnchorEntityId`
- one `appNetworkEntityId`
- one `providerNetworkEntityId`
- one `demoAppEntityId`
- one `fhirServerEntityId`
- one `ticketIssuerEntityId`
- one `ticketIssuerUrl`
- one `trustMarkType`

Target model:

```ts
oidf?: {
  trustAnchors: Array<{
    entityId: string;
    jwks: JsonWebKey[];
  }>;
  trustedLeaves: Array<{
    entityId: string;
    usage: "client" | "issuer" | "both";
    expectedIssuerUrl?: string;
    requiredTrustMarkType?: string;
  }>;
}
```

Notes:

- `entityId` is the canonical allowlist key
- `usage = "client"` is for OIDF client-auth leaves
- `usage = "issuer"` is for OIDF-backed ticket issuers
- `expectedIssuerUrl` is required when `usage` includes `issuer`, because tickets carry `iss` as the issuer URL, not the federation entity ID
- `requiredTrustMarkType` is optional per allowlisted issuer leaf and replaces the current single global `trustMarkType`

The demo topology from Plan 21 becomes one instance of this generic configuration, not a special-case runtime model.

## Resolver Behavior After This Revision

### Client Authentication

Input:

- `client_id = <leaf entity ID URL>`
- `client_assertion` with `trust_chain` JOSE header

Behavior:

1. verify the supplied trust chain offline
2. accept only if the leaf entity ID is present in the `trustedLeaves` allowlist with `usage = client` or `both`
3. accept only if the terminal trust anchor is one of the configured `trustAnchors`
4. resolve metadata policy and verify the `client_assertion`
5. no network fetches occur on this path

### Issuer Trust

Input:

- permission ticket `iss = <issuer URL>`

Behavior:

1. find allowlisted OIDF issuer leaf entries whose `expectedIssuerUrl` matches the ticket issuer URL
2. fetch the leaf entity configuration from the leaf entity ID's own origin:
   - `${entityId}/.well-known/openid-federation`
3. discover and follow real `federation_fetch_endpoint` URLs from fetched superior entity configurations
4. assemble and verify the trust chain against the configured trust anchors
5. resolve metadata policy
6. verify any required trust mark for that issuer leaf
7. return framework-backed issuer trust

This path is expected to use network fetches. It is the correct place for discovery-oriented behavior.

## Required Behavioral Changes

### 1. Stop Building Issuer-Trust Fetch URLs from `PUBLIC_BASE_URL`

Current code in `src/auth/frameworks/oidf/resolver.ts` builds:

- `config.publicBaseUrl + oidfEntityConfigurationPath(entityId)`
- `config.publicBaseUrl + federationFetchEndpointPath(parentEntityId)`

That must be replaced by:

- entity-configuration fetches derived from the actual entity ID URL
- subordinate-statement fetches derived from the fetched superior EC's actual `metadata.federation_entity.federation_fetch_endpoint`

### 2. Separate Demo Topology Helpers from Generic Resolver Logic

`demo-topology.ts` should remain the in-process publisher for our demo entities, but the generic resolver should not import path-construction helpers from it as a dependency for external federation consumption.

Target split:

- `demo-topology.ts`: builds and publishes our demo federation documents
- `resolver.ts`: consumes arbitrary allowlisted OIDF entities using standard URLs

### 3. Generalize Issuer Matching

Current behavior:

- only one configured `ticketIssuerUrl` can resolve through OIDF

Target behavior:

- any allowlisted issuer leaf whose `expectedIssuerUrl` matches the ticket `iss` may resolve through OIDF
- if multiple entries match, fail closed unless configuration explicitly disambiguates

### 4. Keep Framework-First Resolution, but Make It Generic

The precedence in `src/auth/tickets.ts` can stay:

- try framework-backed issuer trust first
- fall back to the local issuer registry if no framework match succeeds

But the framework resolver must no longer mean "the one demo OIDF issuer."

## Execution Phases

### Phase 1: Configuration Model Rewrite

- replace the current `oidf` configuration block in `src/store/model.ts`
- update framework bootstrap/configuration code to use:
  - `trustAnchors`
  - `trustedLeaves`
- encode the existing demo topology as allowlist entries under the new model

Status:

- implemented on `main`

### Phase 2: Generic OIDF URL / Fetch Utilities

- add generic helpers for:
  - entity configuration URL from an entity ID
  - self-origin loopback rewrite using `INTERNAL_BASE_URL`
  - safe fetch with useful diagnostics
- remove resolver dependence on `demo-topology.ts` path builders for external consumption

Status:

- implemented on `main`

### Phase 3: Generic Issuer-Trust Discovery

- rewrite OIDF issuer trust resolution to:
  - match by allowlisted issuer leaves
  - fetch the leaf EC from the real entity ID
  - follow real `federation_fetch_endpoint` values
  - build a trust chain without assuming one in-process path layout

### Phase 4: Trust-Anchor and Allowlist Enforcement

- enforce that:
  - the leaf entity is allowlisted for the requested usage
  - the terminal trust anchor is one of the configured anchors
  - required trust-mark types are satisfied for issuer leaves
- reject valid-but-unallowlisted leaves

### Phase 5: Demo Topology Compatibility Pass

- keep the Plan 21 demo topology working under the new generic resolver
- ensure our own entity IDs and fetch endpoints still resolve correctly
- verify that self-origin fetches use `INTERNAL_BASE_URL` only when the target origin equals `PUBLIC_BASE_URL`

### Phase 6: External-Looking Topology Tests

- add tests for at least one non-demo-origin OIDF issuer leaf
- add tests for at least one non-demo-origin OIDF client leaf
- make the tests prove:
  - client auth stays offline for supplied `trust_chain`
  - issuer trust fetches external URLs as-is
  - self-origin URLs still loop back internally

### Phase 7: Docs and Diagnostics

- update README and OIDF plan/docs to explain:
  - static client-auth validation vs discovery-driven issuer trust
  - how allowlisting works
  - how to configure self-origin loopback safely
- improve diagnostics so rejections clearly distinguish:
  - unallowlisted leaf
  - unknown trust anchor
  - discovery/fetch failure
  - trust-mark failure

## File Impact

Expected primary files:

- `fhir-server/src/store/model.ts`
- `fhir-server/src/auth/frameworks/oidf/resolver.ts`
- `fhir-server/src/auth/frameworks/oidf/demo-topology.ts`
- `fhir-server/src/auth/frameworks/registry.ts`
- `fhir-server/src/auth/tickets.ts`
- `fhir-server/test/oidf-issuer-trust.test.ts`
- `fhir-server/test/oidf-auth.test.ts`
- new focused tests for external-origin OIDF entities
- `fhir-server/README.md`

## Non-Goals

- No change to the RFC-correct static trust-chain validation model from Plan 21
- No network fetching during token-endpoint client-auth validation when `trust_chain` is supplied
- No ad hoc trust-entrypoint hints in issuer metadata
- No automatic trust of arbitrary OIDF leaves not present in configuration
- No attempt to make UDAP issuer trust equivalent to OIDF issuer trust in this pass

## Acceptance Criteria

- The server can trust multiple explicitly allowlisted OIDF client entity IDs without hardcoding them into demo-topology-specific resolver logic.
- The server can trust multiple explicitly allowlisted OIDF issuer leaves whose `expectedIssuerUrl` matches incoming ticket `iss` values.
- OIDF issuer-trust fetches use real entity IDs and real `federation_fetch_endpoint` values, not `PUBLIC_BASE_URL + local path`.
- `INTERNAL_BASE_URL` is used only for self-origin loopback rewrites and does not interfere with external OIDF fetches.
- The existing in-process demo federation still works unchanged under the new generic resolver.
- At least one external-origin OIDF issuer test and one external-origin OIDF client test pass.
