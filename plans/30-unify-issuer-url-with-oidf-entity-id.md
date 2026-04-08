# Plan 30: Unify Issuer URL with OIDF Entity Identifier

Status: complete on `main`

## Why This Plan Exists

After Plans 28 and 29, the OIDF kernel is RFC-aligned and ticket-signing keys are correctly separated from federation-signing keys. One architectural seam remains: the PermissionTicket's `iss` claim and the issuing leaf's OIDF entity identifier are still **different URLs**.

In the current reference implementation:

- PermissionTicket `iss`: `${publicBaseUrl}/issuer/${slug}` (for example, `https://issuer.example/issuer/example`)
- OIDF leaf entity ID: `${publicBaseUrl}/federation/leafs/ticket-issuer` (for example, `https://issuer.example/federation/leafs/ticket-issuer`)

These share a host but not a path. The current OIDF issuer-trust resolver bridges them via framework configuration: the holder preconfigures a specific issuer leaf with both `entityId` and `expectedIssuerUrl`, then resolves trust starting from that configured leaf.

That defeats a core value of federation-based issuer trust. A Data Holder that already trusts a federation anchor should be able to accept PermissionTickets from an issuer leaf it has never seen before, as long as:

- the PermissionTicket `iss` resolves to a valid OIDF leaf entity configuration
- the federation chain terminates at a configured trust anchor
- federation constraints, metadata policy, and trust-mark checks all pass
- any holder-local issuer-trust predicates still pass

Plan 30 removes the `iss -> entityId` bridge by making the issuer URL itself be the OIDF leaf entity identifier.

This plan does **not** broaden scope into unrelated client-auth changes. OIDF client authentication still uses holder-side leaf allowlisting. The change is specific to **issuer trust discovery** for PermissionTickets.

## Design Intent

### 1. The PermissionTicket `iss` is the OIDF issuer leaf entity identifier

Under Plan 30:

```text
PermissionTicket.iss === OIDF leaf entity statement.sub === OIDF leaf entity statement.iss
```

All three are the same absolute URL string.

The Data Holder discovers issuer trust by fetching:

```text
GET ${iss}/.well-known/openid-federation
```

OIDF allows this. Entity identifiers are URLs; they do not need to live under a special `/federation/...` path. The only requirement is that `${entity_id}/.well-known/openid-federation` publishes the entity configuration for that `entity_id`.

This change applies only to the **ticket-issuer** leaf. Other demo federation entities keep their current entity IDs.

### 2. `smart_permission_ticket_issuer.issuer_url` is removed as redundant

Plan 29 introduced `smart_permission_ticket_issuer.issuer_url` to bridge from a PermissionTicket `iss` to a distinct OIDF leaf entity identifier. Once those URLs are unified, the field no longer carries independent information.

The `smart_permission_ticket_issuer` metadata type remains. Its job is still load-bearing: it publishes the **ticket-signing JWKS** separately from the leaf entity statement's top-level `jwks`, which remains the **federation-signing JWKS**.

After Plan 30, the metadata block shrinks to:

```json
"metadata": {
  "smart_permission_ticket_issuer": {
    "jwks": { "keys": [...] }
  }
}
```

`extractTicketIssuerMetadata()` returns `{ publicJwks }` only. The diagnostics tied to the removed field disappear:

- `oidf_ticket_issuer_url_missing`
- `oidf_ticket_issuer_url_invalid`
- `oidf_ticket_issuer_url_mismatch`

The structural binding check becomes:

```text
verifiedChain.leaf.entityId === permissionTicket.iss
```

and failures use `oidf_ticket_issuer_entity_id_mismatch`.

### 3. Separate issuer-trust discovery from client leaf allowlisting

The current implementation conflates two concerns inside `FrameworkDefinition.oidf.trustedLeaves`:

- client-auth leaf allowlisting
- issuer-trust leaf lookup via `expectedIssuerUrl`

Plan 30 separates those concerns instead of deleting them both.

#### 3.1. Keep trust anchors where they already belong

`FrameworkDefinition.oidf.trustAnchors: { entityId, jwks }[]` remains the configured trust bootstrap for OIDF.

This is already the correct shape in Plan 28 / Plan 29:

- the holder needs anchor entity IDs
- the holder needs the anchor public keys locally to terminate trust-chain verification

Plan 30 does **not** move trust anchors into `IssuerTrustPolicy`. The issuer-trust policy remains a policy selector plus optional predicates, while framework topology remains on the framework definition.

#### 3.2. Keep `trustedLeaves` for client auth only

OIDF client auth still requires local allowlisting of client leaves. That behavior is explicitly preserved.

After Plan 30:

- `FrameworkDefinition.oidf.trustedLeaves` remains, but only for client-auth admission
- issuer trust no longer consults `trustedLeaves`
- `expectedIssuerUrl` is removed from the type system
- any issuer-specific entries currently present in `trustedLeaves` are removed from demo/default config and test fixtures

This keeps the current client-auth behavior intact while removing the per-issuer bridge for PermissionTicket verification.

#### 3.3. Move issuer trust-mark requirement to framework-level OIDF config

Today issuer trust gets its expected trust-mark type from the issuer entry in `trustedLeaves`. Once issuer resolution no longer depends on `trustedLeaves`, the required trust-mark type needs a new home.

Plan 30 adds a framework-level OIDF setting for issuer-trust verification:

```text
FrameworkDefinition.oidf.requiredIssuerTrustMarkType
```

or an equivalently named framework-level field with the same meaning.

This field is:

- used only for issuer trust
- not used for client auth
- configured once per framework, not once per issuer

The demo/default OIDF framework uses the existing demo permission-ticket-issuer trust-mark type.

#### 3.4. Holder-local issuer policy still exists

This plan removes the per-issuer `iss -> entityId` map. It does **not** say the holder must accept every issuer in a trusted federation.

Holder-local control still exists through the existing issuer-trust policy predicates, for example:

- `issuer_url_in`
- `oidf_chain_anchored_in`
- `oidf_has_trust_mark`

The net result is:

- federation membership and federation-side constraints determine whether an issuer is structurally valid
- holder-local policy can still narrow what it accepts
- no per-issuer OIDF leaf mapping is required

### 4. Discovery becomes anchor-driven for issuer trust

For issuer trust, `OidfFrameworkResolver.resolveIssuerTrust(iss)` must:

1. fetch `${iss}/.well-known/openid-federation`
2. treat `iss` itself as the candidate leaf entity ID
3. attempt trust-chain discovery and verification against the configured trust anchors
4. apply metadata policy
5. extract `smart_permission_ticket_issuer.jwks`
6. enforce `verifiedChain.leaf.entityId === iss`
7. verify the required issuer trust mark using the new framework-level trust-mark type setting

Two implementation details matter here:

- The current fetch helper is general enough, but the current resolver still starts from a configured `trustedLeaf.entityId`. That call path must change.
- The current fetch path uses `firstTrustedAnchor()` for discovery and only later verifies against all anchors. Under anchor-driven discovery, fetch and verification must both support **all** configured anchors consistently.

### 5. The parent spec text already assumes unified discovery

The parent repo's spec text in `input/pagecontent/index.md` already says OpenID Federation discovery starts from `${iss}/.well-known/openid-federation`.

Plan 30 therefore does **not** need a historical "revert 907ae89" framing. The spec is already back on the natural unified model. The documentation work in this plan is simply:

- remove the now-redundant `issuer_url` field from §1.14.4
- keep the `${iss}/.well-known/openid-federation` discovery model
- align the example payload and surrounding prose with the final implementation

### 6. End-to-end verifier pipeline under Plan 30

When a Data Holder receives a token-exchange request bearing a PermissionTicket with:

```text
iss = https://issuer.example/issuer/example
```

the verifier path becomes:

1. `tickets.ts` decodes the PermissionTicket and extracts `iss`.
2. `auth/issuer-trust.ts` selects an `oidf` issuer-trust policy exactly as it does today.
3. The framework resolver fetches `${iss}/.well-known/openid-federation` directly.
4. The resolver discovers a valid trust chain from that leaf to one of the configured trust anchors.
5. The resolver applies metadata policy and extracts `metadata.smart_permission_ticket_issuer.jwks`.
6. The resolver enforces `verifiedChain.leaf.entityId === iss`.
7. The resolver verifies the issuer trust mark using the framework-level required trust-mark type.
8. `ResolvedIssuerTrust.publicJwks` becomes the inline ticket-signing JWKS.
9. `verifyPermissionTicketSignature(subjectToken, header.kid, issuer.publicJwks)` verifies the PermissionTicket.

Net effect:

- no `iss -> entityId` map
- no extra JWKS fetch inside the OIDF path
- no change to the separate direct-JWKS publication path

## Settled Decisions

- **Unify `iss` and the OIDF issuer leaf `entity_id`.** The issuer leaf entity configuration is discovered at `${iss}/.well-known/openid-federation`.
- **Drop `smart_permission_ticket_issuer.issuer_url`.** The leaf entity ID is the discriminator after unification.
- **Keep `smart_permission_ticket_issuer.jwks`.** Plan 29's federation-signing-key vs ticket-signing-key split remains load-bearing.
- **Keep `FrameworkDefinition.oidf.trustAnchors` as `{ entityId, jwks }[]`.** Trust anchors stay on framework topology, not issuer-trust policy.
- **Keep `trustedLeaves` for client auth only.** Remove issuer-side `expectedIssuerUrl` lookup rather than deleting client allowlisting.
- **Move issuer trust-mark expectation to framework-level OIDF config.** Do not hide it inside issuer leaf entries.
- **No backward-compat shim.** The old split URL model and the old metadata shape are removed together.
- **Code-first phase order.** Docs/spec land after implementation proves the model.

## Phases

### Phase 1: Reference implementation topology — unify the ticket-issuer leaf entity ID with the issuer URL

Work:

- `demo-topology.ts`: change the ticket-issuer `createEntity(...)` call so `ticketIssuerEntityId === ticketIssuerUrl === ${publicBaseUrl}/issuer/${ticketIssuerSlug}`.
- Update the provider-network subordinate statement keyed by the ticket issuer so it references the unified child entity ID.
- Update the provider-network-issued trust mark so its `sub` is the unified ticket-issuer entity ID.
- Remove the old `/federation/leafs/ticket-issuer` publication path from fixtures and expectations.
- Do **not** add a ticket-issuer-specific routing hack unless testing proves it is needed. The existing generic OIDF route resolution should publish `${iss}/.well-known/openid-federation` automatically once the ticket-issuer entity ID changes.

Goal: the ticket-issuer leaf entity configuration is served from `${iss}/.well-known/openid-federation`, while all other demo OIDF entities keep their existing IDs.

### Phase 2: Metadata simplification — remove `issuer_url` from `smart_permission_ticket_issuer`

Work:

- `demo-topology.ts`: remove `issuer_url` from `metadata.smart_permission_ticket_issuer`.
- Remove the provider-network metadata policy that locked down `issuer_url`; the field no longer exists.
- `smart-permission-ticket-issuer.ts`:
  - drop `issuer_url` parsing
  - drop `oidf_ticket_issuer_url_missing`
  - drop `oidf_ticket_issuer_url_invalid`
  - continue validating `jwks.keys` exactly as Plan 29 requires
  - return `{ publicJwks }` only
- `resolver.ts`:
  - replace the `issuer_url` mismatch check with `verifiedChain.leaf.entityId === issuerUrl`
  - throw `oidf_ticket_issuer_entity_id_mismatch` on failure
  - drop `oidf_ticket_issuer_url_mismatch`

Goal: the metadata type carries only `jwks`, and the structural binding is the leaf-entity-id-equals-iss invariant.

### Phase 3: Framework config and resolver discovery — issuer trust becomes anchor-driven

Work:

- `model.ts`:
  - keep `FrameworkDefinition.oidf.trustAnchors` unchanged
  - keep `FrameworkDefinition.oidf.trustedLeaves`, but remove `expectedIssuerUrl`
  - add a framework-level field for issuer-trust verification, such as `requiredIssuerTrustMarkType`
- `resolver.ts`:
  - `resolveIssuerTrust(issuerUrl)` fetches `${issuerUrl}/.well-known/openid-federation` directly
  - issuer trust no longer calls `findTrustedIssuerLeaves(...)`
  - issuer trust no longer depends on any preconfigured issuer leaf entry
  - trust-chain discovery and verification must try all configured trust anchors consistently rather than fetching only against the first configured anchor
  - `buildIssuerTrustCacheKey(...)` must stop depending on `trustedLeaf`; cache key should be based on framework + issuer URL (or an equally precise anchor-independent key)
  - issuer trust-mark verification uses the new framework-level `requiredIssuerTrustMarkType`
- `app.ts` and `demo-frameworks.ts`:
  - remove the ticket-issuer entry from `trustedLeaves`
  - keep the demo-app client leaf allowlisting entry
  - publish the framework-level issuer trust-mark type
- `auth/issuer-trust.ts`:
  - no structural policy-shape rewrite is expected here
  - existing `type: "oidf"` policy selection and optional predicates remain in place
- `config.ts`:
  - no default-policy change is required unless explicitly chosen
  - the default issuer-trust policy may remain direct-JWKS-only; OIDF issuer trust remains opt-in through configured policies

Goal: issuer trust is discovered from `iss` and anchored in `trustAnchors`, while client-auth allowlisting remains intact and separate.

### Phase 4: Tests

Work:

- Update the existing OIDF suites to the unified ticket-issuer URL model:
  - `oidf-topology.test.ts`
  - `oidf-issuer-trust.test.ts`
  - `oidf-external-consumption.test.ts`
  - `issuer-key-cross-source.test.ts`
- Update any remaining tests and fixtures that currently assume:
  - `/federation/leafs/ticket-issuer/.well-known/openid-federation`
  - `smart_permission_ticket_issuer.issuer_url`
  - `trustedLeaves[*].expectedIssuerUrl`
- Preserve the Plan 29 cross-source consistency contract:
  - **T8**: direct JWKS at `${iss}/.well-known/jwks.json` is canonically equal to `metadata.smart_permission_ticket_issuer.jwks`
  - **T9**: leaf entity statement top-level `jwks` is canonically non-equal to `metadata.smart_permission_ticket_issuer.jwks`
- Add or update the following tests:
  - **T10**: a holder configured for OIDF issuer trust with only trust anchors and the framework-level issuer trust-mark type successfully verifies a PermissionTicket from a valid issuer leaf it has not pre-enumerated
  - **T11**: issuer trust rejects a PermissionTicket whose leaf does not chain to any configured trust anchor
  - **T12**: issuer trust rejects a fetched leaf whose entity statement `iss`/`sub` does not equal the requested PermissionTicket `iss` (`oidf_ticket_issuer_entity_id_mismatch`)
  - **T13**: the Plan 29 end-to-end token-exchange integration test still passes under the unified model
  - **T14**: route coexistence regression: `${iss}/.well-known/jwks.json` and `${iss}/.well-known/openid-federation` are both served without ambiguity
  - **T15**: OIDF client-auth leaf allowlisting still works and still rejects a valid trust chain whose leaf is not allowlisted for client usage
  - **T16**: multi-anchor issuer-trust regression: discovery can succeed through a later configured trust anchor rather than assuming the first one is correct
- Keep the self-origin loopback fetch test, updated to the new `${iss}`-rooted discovery path
- Drop tests that assert the removed `issuer_url` diagnostics

Goal: the unified model is proven end-to-end, the old per-issuer bridge is gone, and the client-auth path remains intact.

### Phase 5: Docs, spec text, metaplan, and push

Work:

- Parent repo `input/pagecontent/index.md`:
  - keep the existing `${iss}/.well-known/openid-federation` discovery wording at the §1.14 prose level
  - update §1.14.4 to remove `issuer_url`
  - update the surrounding prose so the structural binding is expressed directly as leaf entity ID == PermissionTicket `iss`
  - update the example payload so the inline `smart_permission_ticket_issuer` block contains only `jwks`
- `fhir-server/README.md`:
  - describe the unified issuer URL model
  - describe `smart_permission_ticket_issuer` as a `jwks`-only metadata type
  - document that OIDF issuer trust no longer needs a per-issuer leaf map
  - explicitly note that client-auth leaf allowlisting still exists
- `plans/00-metaplan.md`:
  - add Plan 30
  - mark complete on `main`
  - place after Plan 29
- Final verification from `fhir-server/`:
  - full `bun test`
  - `bunx tsc --noEmit`
- Push `reference-implementation/main`
- Push the parent repo `main`

Goal: code, docs, and spec text all agree on the unified discovery model.

## Acceptance Criteria

- The ticket-issuer leaf entity configuration is discoverable at `${iss}/.well-known/openid-federation`.
- The ticket-issuer leaf entity ID is the same URL as the PermissionTicket `iss`.
- `smart_permission_ticket_issuer` metadata contains only `jwks`; `issuer_url` is removed from code, fixtures, tests, and spec text.
- The resolver enforces `verifiedChain.leaf.entityId === permissionTicket.iss` and throws `oidf_ticket_issuer_entity_id_mismatch` on failure.
- OIDF issuer trust no longer requires `expectedIssuerUrl` or any preconfigured issuer leaf entry.
- `FrameworkDefinition.oidf.trustAnchors` remains the trust bootstrap shape and still carries local anchor JWKS.
- `trustedLeaves` remains available for client-auth allowlisting, and the client-auth tests still pass under that model.
- A framework-level issuer trust-mark requirement replaces `trustedLeaf.requiredTrustMarkType`.
- A test demonstrates that an OIDF-configured holder can verify a PermissionTicket from a valid issuer leaf it had not pre-enumerated.
- A multi-anchor test demonstrates that issuer-trust discovery is not limited to the first configured trust anchor.
- Plan 29's T8/T9 cross-source contracts still hold.
- `${iss}/.well-known/openid-federation` remains the documented OpenID Federation discovery anchor in the parent spec text.
- Full `bun test` and `bunx tsc --noEmit` pass.
- Both repos are pushed.

## Non-Goals

- Changing how `oauth_client` metadata is consumed in OIDF client authentication
- Removing OIDF client-auth leaf allowlisting
- Moving OIDF trust-anchor configuration onto issuer-trust policy objects
- Runtime resolution of trust-anchor JWKS instead of local configuration
- Restructuring federation entities other than the ticket-issuer leaf
- Removing the `smart_permission_ticket_issuer` metadata type
- Removing the direct-JWKS publication path at `${iss}/.well-known/jwks.json`
- Backward compatibility with the Plan 29 metadata shape or the old split URL model
- IANA registration of the `smart_permission_ticket_issuer` metadata type identifier

## Estimated Scope

Medium:

- ~450-700 lines across `demo-topology.ts`, `resolver.ts`, `smart-permission-ticket-issuer.ts`, `model.ts`, `demo-frameworks.ts`, `app.ts` expectations, the OIDF test suites, the parent spec text, and the README.
- The highest-risk production changes are:
  - anchor-driven issuer discovery across multiple trust anchors
  - separating issuer-trust config from client-auth allowlisting without breaking either path
  - updating the test fixtures cleanly from the old split URL model to the unified model
