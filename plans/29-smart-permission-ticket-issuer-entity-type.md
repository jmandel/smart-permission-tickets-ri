# Plan 29: SMART Permission Ticket Issuer Entity Type

Status: complete on `main`

Note: the formal SMART spec-text target referenced in Phase 5 lives in the parent workspace repo (`../input/pagecontent/index.md`), outside this `reference-implementation` git root. This plan file tracks the reference-implementation-side implementation, tests, and README/metaplan documentation that landed on `main`.

## Why This Plan Exists

After Plan 28, the OIDF kernel and resolver are RFC-aligned, but one architectural conflation remains:

The ticket issuer's **federation key** (used to sign its entity configuration / subordinate statements) is the same key the resolver returns as the ticket issuer's **ticket-signing key** (used to verify PermissionTicket JWT signatures). The leaf entity statement's top-level `jwks` plays both roles.

Current code path:

- `demo-topology.ts:115-120` — `ticketIssuer` is created with only `federation_entity.issuer_url` metadata. It has no metadata-typed `jwks` of any kind.
- `policy.ts:30` — `applyMetadataPolicy()` returns `verifiedChain.leaf.payload.jwks?.keys` as the resolved JWKS.
- `resolver.ts:239` — `publicJwks: resolved.jwks` is bound to the issuer trust result.
- `tickets.ts:98` — PermissionTicket signature verification consumes those same keys.

Concrete consequences:

- Ticket-signing keys cannot be rotated without rotating federation keys.
- A federation-key compromise is automatically a ticket-signing-key compromise.
- Two different threat models (federation infrastructure trust vs. application-level token signing) share a single key with a single rotation cadence.
- The ticket issuer is also typed as a generic `federation_entity` with a non-standard `issuer_url` extension field — semantically muddy.

This plan separates ticket-signing keys from federation keys by introducing a **dedicated OIDF entity type** for SMART permission ticket issuers, with the ticket-signing JWKS published inline inside that entity type's metadata.

## Design Intent

### 1. Custom entity type identifier

```
smart_permission_ticket_issuer
```

The identifier is a bare snake_case string. OIDF 1.0 reserves the bare-string namespace for the IANA "OAuth Federation Entity Types" registry, so this is technically extension territory until SMART formally registers the type — but the SMART project owns its own conventions and bare strings are simpler to read in entity statements than URIs. This decision is settled; we are not bikeshedding URI namespaces.

This appears as a key inside the OIDF entity statement's `metadata` object alongside `federation_entity` (and any other types the issuer also carries):

```json
{
  "iss": "https://issuer.example/federation/leafs/ticket-issuer",
  "sub": "https://issuer.example/federation/leafs/ticket-issuer",
  "iat": 1700000000,
  "exp": 1700086400,
  "jwks": {
    "keys": [
      { "kid": "fed-2026-04", "kty": "EC", "...": "..." }
    ]
  },
  "metadata": {
    "federation_entity": {
      "organization_name": "Example Health Issuer"
    },
    "smart_permission_ticket_issuer": {
      "issuer_url": "https://issuer.example/issuer/example",
      "jwks": {
        "keys": [
          { "kid": "tickets-2026-04", "kty": "EC", "...": "..." }
        ]
      }
    }
  }
}
```

The top-level `jwks` (`fed-2026-04`) signs the entity statement. The new type's inline `jwks` (`tickets-2026-04`) signs PermissionTickets. They are completely independent and rotate independently.

### 2. Inline JWKS, not `jwks_uri`

The new type carries **inline `jwks`**, not `jwks_uri`. Two reasons:

- **Cryptographic binding to the federation chain.** Inline `jwks` is part of the signed entity statement, so the trust chain itself attests to the ticket-signing keys. A `jwks_uri` would only attest to the URL, not the content, and the current resolver does not re-verify the URL's payload against the chain.
- **Zero extra HTTP fetches at verification time.** The resolver already has the leaf entity statement in hand after walking the chain; the `jwks` is right there.

Plan 25's `${iss}/.well-known/jwks.json` mandate is still in force as the **direct-JWKS publication path**. The new entity type is a **federation-discovery publication path** that complements direct-JWKS — both are still required for an issuer that participates in OIDF.

### 3. Move `issuer_url` out of `federation_entity`

Currently the resolver looks up `metadata.federation_entity.issuer_url` (`resolver.ts:184`). `issuer_url` is **not** a registered `federation_entity` field — it's an undocumented project-local extension. This plan moves it into the new entity type's metadata where it semantically belongs:

- Before: `metadata.federation_entity.issuer_url`
- After: `metadata.smart_permission_ticket_issuer.issuer_url`

`federation_entity` stays on the issuer for `organization_name` only (a registered field).

### 4. Hard cutover (no compatibility shim)

This is reference-implementation code with no external consumers. The migration is a hard cutover:

- `demo-topology.ts` emits the new entity type and stops emitting `federation_entity.issuer_url`
- `resolver.ts` reads `issuer_url` and `jwks` exclusively from the new entity type
- All tests are updated in the same commits
- No backward-compat branch in resolver code

### 5. The leaf controls its own ticket-signing JWKS

The new type's `jwks` lives in the **leaf's own entity statement metadata**, signed by the leaf's federation key, validated through the chain back to the trust anchor. The federation's job is to attest that the leaf is a federation member in good standing — not to manage the leaf's key material. Federation `metadata_policy` lockdown of a leaf's JWKS would be a key-management overlord pattern that doesn't fit how OAuth federations work in practice. Each federation entity owns its own key material via its own entity statement; the chain proves membership, not key custody.

### 6. End-to-end verifier pipeline for OIDF-configured data holders

This plan must explicitly cover what happens when a data holder (relying party in OIDF terms — i.e. a FHIR server consuming a PermissionTicket) is configured with an `oidf` issuer-trust policy and a token-exchange request arrives bearing a PermissionTicket whose `iss` matches that policy.

The end-to-end pipeline:

1. **`tickets.ts` token-exchange path** receives the subject_token PermissionTicket and decodes its `iss`.
2. **`auth/issuer-trust.ts`** (Plan 25's policy engine) consults the configured `IssuerTrustPolicy[]` and selects the first policy whose predicates match the `iss`. For an OIDF-configured holder, that's an `{ type: "oidf", ... }` policy.
3. **`OidfFrameworkResolver.resolveIssuerTrust(iss)`** is invoked. It walks the federation chain from the configured trusted leaf to the configured trust anchor, verifying signatures, claims, `crit`, `metadata_policy_crit`, and constraints (all the Plan 28 kernel work).
4. **After the chain validates**, the resolver applies metadata policy via `applyMetadataPolicy(verifiedChain)` and reads `resolved.metadata.smart_permission_ticket_issuer`. From that block it extracts:
   - `issuer_url` (must match the `iss` argument, otherwise the chain proves something other than what was claimed)
   - `jwks` (the inline ticket-signing JWK Set)
5. The resolver returns a `ResolvedIssuerTrust` whose `publicJwks` is the inline JWKS — **not** the leaf entity statement's top-level `jwks`.
6. Back in `tickets.ts`, `verifyPermissionTicketSignature(subjectToken, header.kid, issuer.publicJwks)` checks the JOSE signature against those keys.
7. If verification passes, the subject token's claims are accepted and the token-exchange flow proceeds.

The key consequence: a data holder configured with an `oidf` issuer-trust policy has **never** required the issuer's federation key. It only needs whatever is published in the `smart_permission_ticket_issuer` block, validated by the chain. Plan 29 makes this explicit and removes the latent reliance on the conflated leaf entity statement `jwks`.

## Entity Type Schema (first pass)

`smart_permission_ticket_issuer` carries:

| Field | Type | Required | Semantics |
|---|---|---|---|
| `issuer_url` | string (parseable absolute URL; `https` in production, `http` permitted in test/local) | yes | The `iss` value the issuer publishes in PermissionTickets. Used by the resolver to match an `iss` claim to this entity. Parsed via `new URL()`; protocol not enforced by the parser. |
| `jwks` | JWK Set | yes | Inline JWK Set whose keys sign PermissionTickets. Verifier checks PermissionTicket signatures against these keys, not against the leaf entity statement's top-level `jwks`. Each key MUST have a non-empty `kid`; the set MUST have unique `kid` values; keys are normalized to public form on read. |

**Deliberately NOT in this plan** (deferred to follow-on plans):
- `permission_ticket_endpoint` — where to obtain tickets (revisit when an issuer endpoint discovery story is needed)
- `supported_presenter_binding_methods` — `["jkt", "framework_client", "absent"]` advertisement
- `supported_scopes` — SMART scope advertisement
- `revocation_index_publication` — where bitstrings live
- `permission_ticket_signing_alg_values_supported` — algorithm advertisement
- `jwks_uri` — explicitly excluded; inline only

The first pass intentionally has the minimum surface needed to separate ticket-signing keys from federation keys. Other fields are out of scope and will be added to the type as their use cases get fleshed out.

## Settled Decisions

These were initially Open Questions; all are now settled.

- **Entity type identifier:** `smart_permission_ticket_issuer` (bare snake_case). User has decided not to bikeshed URI namespaces. Settled.
- **`jwks` inline only, no `jwks_uri`.** Cryptographic binding to the federation chain, zero extra fetches, simpler verifier code.
- **`issuer_url` is mandatory** in this entity type. It is the discriminator that lets the resolver match an `iss` claim to a specific federation leaf. The OIDF entity ID and the issuer URL are separate identities (entity ID lives under `/federation/leafs/...`; issuer URL lives under `/issuer/<slug>`).
- **`federation_entity` on the ticket issuer keeps only `organization_name`.** Everything else moves to `smart_permission_ticket_issuer`.
- **No federation lockdown via `metadata_policy` on the new type's JWKS.** The leaf controls its own key material. The chain proves membership, not custody.
- **Hard cutover.** No backward-compat shim, no `federation_entity.issuer_url` fallback.
- **Client-auth path ignores the new type.** Client auth continues to read `oauth_client` metadata only.
- **`allowed_entity_types` constraint:** the kernel does NOT special-case the new type. A trust anchor that uses `constraints.allowed_entity_types` must include `smart_permission_ticket_issuer` in its allowlist if it wants its issuers to validate. The default demo trust anchor does not currently use `allowed_entity_types`, so no demo change is needed for this constraint to work — we will add this only if a test specifically exercises the allowlist path.
- **Demo key material (per Codex's pushback):** the existing `ticketIssuers[slug]` lockfile entries are already the **ticket-signing keys** (Plan 25 direct-JWKS publication keys). They keep that role and are also used as the inline `jwks` content of the new entity type in the demo. **A new key role is added for the OIDF leaf entity statement signing key** (the federation key) — currently the `ticket-issuer` role in `keyMaterialByRole` plays this part, which means it must be a key distinct from `ticketIssuers[slug]`. The demo crypto bundle must grow the federation key as a new lockfile entry (or a new field on the existing per-issuer entry) so that the federation key and ticket-signing key are stably separable across runs. This is the inverted form of my original proposal — Codex correctly pointed out that the existing key role is named after its purpose (ticket signing) and should not be repurposed.

## Phases

### Phase 1: Demo crypto bundle — federation-key sibling map

Work:

- Add a new sibling map `oidfTicketIssuerFederation` to `DemoCryptoBundleDocument` (private form) and the public surface of the bundle, in `fhir-server/src/demo-crypto-bundle.ts`. **Sibling map, not nested under `ticketIssuers[slug]`** — Codex flagged that nesting would entangle the existing parser/grow/countManagedEntries logic; sibling map keeps Plan 26's grow-only invariants clean.
- Update `materializeJwkEntryRecord` / parser / write paths so the new map is read, written, and grown.
- Update `generateDemoCryptoBundle()` so first-run generation produces a federation key for each known issuer slug. Plan 26 grow-only semantics: if the entry is present, leave it alone; if missing, generate. Stale slugs retained.
- Update `countManagedEntries` (or equivalent) so the new map participates in the bundle-size accounting.
- Tests: bundle round-trip preserves the new map; grow-only behavior verified for both maps independently; first-run generation creates federation keys without disturbing existing ticket-signing keys.

Goal: the lockfile has a stable, persistent place for the OIDF leaf entity statement signing key, separate from the ticket-signing key it already stores.

### Phase 2: Demo topology emits the new entity type

Work:

- `demo-topology.ts`: change the `ticketIssuer` `createEntity` call so its `metadata` object has:
  - `federation_entity: { organization_name: ticketIssuerName }` (and nothing else)
  - `smart_permission_ticket_issuer: { issuer_url: ticketIssuerUrl, jwks: { keys: [<public form of ticketIssuers[slug]>] } }`
- Drop the `federation_entity.issuer_url` extension field from the ticket issuer.
- `keyMaterialByRole["ticket-issuer"]` in `demo-topology.ts` is wired to `oidfTicketIssuerFederation[slug]` (the federation key from Phase 1), NOT to `ticketIssuers[slug]`. The inline `jwks` content in the new entity type's metadata is wired separately to `ticketIssuers[slug]` (the ticket-signing key, the same one Plan 25 publishes at `${iss}/.well-known/jwks.json`). Net effect: the leaf entity statement's top-level `jwks` is the federation key, the inline metadata `jwks` is the ticket-signing key, and they are different keys.
- Update `oidf-topology.test.ts` to expect the new metadata shape.

Goal: the demo emits an entity statement where federation signing and ticket signing are structurally and persistently separable across runs.

### Phase 3: Resolver reads ticket-signing keys from the new type

Work:

- Define a typed accessor `extractTicketIssuerMetadata(resolvedMetadata)` that:
  - Looks up `resolvedMetadata.smart_permission_ticket_issuer`. If absent, throw with grep-friendly identifier `oidf_ticket_issuer_metadata_missing`.
  - Reads `issuer_url` (string, required). If missing or non-string, throw `oidf_ticket_issuer_url_missing`. **Parse it via `new URL(issuer_url)`** and reject anything that does not parse as an absolute URL — throw `oidf_ticket_issuer_url_invalid`. The protocol is NOT enforced (test/local environments use `http`; production deployments should use `https`, but the parser does not require it). The schema field-table description below documents the production expectation as `https URL`.
  - Reads `jwks` (object with `keys` array). If absent, throw `oidf_ticket_issuer_jwks_missing`.
  - **Validates the inline JWKS the same way the kernel validates entity-statement JWKS** (`trust-chain-kernel.ts:254`): non-empty `keys` array, every key has a non-empty string `kid`, no duplicate `kid` values across the set, every key normalizes to a public-only form via `normalizePublicJwk()`. Inline-JWKS validation is not currently performed by the kernel for metadata jwks — `extractTicketIssuerMetadata` is the first place this rule lives for the new entity type, and ticket signature verification at `tickets.ts:497` relies on `kid` for key selection so missing/blank `kid` MUST be a fail-closed condition.
  - Returns `{ issuer_url, publicJwks }` where `publicJwks` is the normalized public-only key set.
- `resolver.ts` in `resolveIssuerTrustAgainstFramework`:
  - After `applyMetadataPolicy(verifiedChain)`, call `extractTicketIssuerMetadata(resolved.metadata)`.
  - Use the returned `issuer_url` for the matched-issuer check (must equal the `iss` argument; throw `oidf_ticket_issuer_url_mismatch` otherwise).
  - Use the returned `publicJwks` as the `publicJwks` field on the returned `ResolvedIssuerTrust`.
- Remove the read of `resolved.metadata.federation_entity?.issuer_url`.
- Remove the implicit reliance on `verifiedChain.leaf.payload.jwks?.keys` for the ticket-signing role. The leaf entity statement's `jwks` continues to be the federation key set, used only by the kernel for chain validation.
- `policy.ts`: the `ResolvedOidfClientMetadata.jwks` field is still the right artifact for the **client-auth** flow (where the leaf jwks is the client's signing key). Rename / document that it is client-auth-only and is NOT consulted by the issuer-trust path anymore.

Goal: ticket-signing JWKS comes from the new entity type's inline `jwks` (validated against the same rules as kernel JWKS), not from the federation entity statement's top-level `jwks`.

### Phase 4: Tests

Work:

- Update existing OIDF issuer-trust tests to expect the new metadata shape.
- Add focused tests:
  - **T1**: ticket issuer entity statement carries the new entity type with inline `jwks` → resolver returns those keys as `publicJwks`.
  - **T2**: ticket-signing key is independent from federation key. **Integration test** that drives a full token-exchange request through the `tickets.ts` token-exchange handler against an OIDF-configured holder runtime. A PermissionTicket signed with the inline-metadata key (the new entity type's `jwks`) successfully exchanges; a PermissionTicket signed with the entity statement's top-level federation key is rejected. This must exercise the full pipeline `auth/issuer-trust.ts` → `OidfFrameworkResolver.resolveIssuerTrust` → `extractTicketIssuerMetadata` → `verifyPermissionTicketSignature`, not a direct unit-level call to the verifier.
  - **T3**: ticket issuer entity statement is missing the new entity type → `resolveIssuerTrust` throws `oidf_ticket_issuer_metadata_missing`.
  - **T4**: ticket issuer carries the new type but `jwks` is empty or absent → throws `oidf_ticket_issuer_jwks_missing`.
  - **T5**: ticket issuer carries the new type but `jwks` has duplicate `kid` values → throws clearly (same kernel validation rule as entity-statement JWKS).
  - **T5b**: ticket issuer carries the new type but a key in `jwks` has a missing or blank `kid` → throws clearly. Phase 3 requires kid presence; this test makes the requirement load-bearing.
  - **T6**: ticket issuer carries the new type but `issuer_url` mismatches the `iss` argument → throws `oidf_ticket_issuer_url_mismatch`.
  - **T7**: client auth path ignores the new type even if a client leaf carries it.
- **Cross-source consistency suite (Codex-flagged, mandatory):** update `fhir-server/test/issuer-key-cross-source.test.ts` (which Plan 25 introduced as the publication-level invariant suite) to encode the Plan 29 contract:
  - **T8**: direct-JWKS publication (`${iss}/.well-known/jwks.json`) and the new entity type's inline `metadata.smart_permission_ticket_issuer.jwks` MUST be **canonically equal** as public-key sets, comparing via the existing `canonicalizePublicJwk()` helper (or equivalent) rather than via JSON byte equality. Same ticket-signing key, two publication paths — equal under canonical key normalization.
  - **T9**: the ticket issuer's leaf entity statement top-level `jwks` (the federation key) MUST be canonically **non-equal** to the inline `metadata.smart_permission_ticket_issuer.jwks` (the ticket-signing key). Different keys, different thumbprints. This is the assertion that proves separation actually exists.
  - These two assertions form the publication contract Plan 29 establishes. Without them, Plan 29 has no enforcement against accidental re-conflation.
- Targeted suites: `oidf-issuer-trust.test.ts`, `oidf-external-consumption.test.ts`, `oidf-topology.test.ts`, `issuer-key-cross-source.test.ts`, and any token-exchange / ticket-verification end-to-end test that exercises the OIDF issuer-trust pipeline.

Goal: independent rotation is provable, the cross-source equality/inequality invariants are tested, missing-type and malformed-jwks are fail-closed.

### Phase 5: Spec text + README + metaplan + push

Work:

- Add a §1.14.4 (or appropriate slot) to `input/pagecontent/index.md` defining `smart_permission_ticket_issuer` as a SMART-defined OIDF entity type, with the field table from this plan. Document the `issuer_url` (parseable absolute URL, https in production) and `jwks` (inline JWK Set with non-empty unique kids) fields.
- Update the §1.14 OIDF discovery section to explain that issuers participating in OIDF SHALL publish the new type in their leaf entity statement.
- Update `fhir-server/README.md` "Issuer Key Publication" section: document the new entity type, document how it differs from `federation_entity.organization_name` (display only) and from the leaf entity statement top-level `jwks` (federation chain signing only), and explicitly call out the separation of ticket-signing keys from federation keys this plan establishes.
- Confirm grep-friendly diagnostic identifiers from Phase 3 (`oidf_ticket_issuer_metadata_missing`, `oidf_ticket_issuer_url_missing`, `oidf_ticket_issuer_url_invalid`, `oidf_ticket_issuer_jwks_missing`, `oidf_ticket_issuer_url_mismatch`) are emitted with stable wording.
- `plans/00-metaplan.md`: add Plan 29 entry, mark complete on `main`, add to dependency graph after Plan 28.
- Final full `bun test` + `bunx tsc --noEmit` green gates from `fhir-server/`.
- Push `reference-implementation/main` to origin.

Goal: lands cleanly with full documentation. Spec text intentionally lands AFTER the code and tests prove the contract — Plan 28 had a back-and-forth where spec text written ahead of code needed corrective edits, and Plan 29's design is concrete enough that documenting after the implementation lands is cleaner.

## Acceptance Criteria

- The custom OIDF entity type `smart_permission_ticket_issuer` is defined in the spec text and the README.
- The ticket issuer's leaf entity statement carries the new type with inline `jwks` and `issuer_url`.
- `resolver.ts` returns the inline-metadata `jwks` as `publicJwks`, not the leaf entity statement top-level `jwks`.
- The inline JWKS in the new type is validated by `extractTicketIssuerMetadata()` against the same rules the kernel applies to entity-statement JWKS (non-empty, unique `kid`, normalized to public form).
- A test demonstrates that a PermissionTicket signed with a key independent of the federation key verifies successfully.
- The cross-source consistency suite encodes the publication contract: direct-JWKS == inline metadata JWKS, and both differ from the federation entity statement top-level JWKS.
- Missing, malformed, or `issuer_url`-mismatched instances of the new type produce grep-friendly diagnostic errors (`oidf_ticket_issuer_metadata_missing`, `oidf_ticket_issuer_url_missing`, `oidf_ticket_issuer_jwks_missing`, `oidf_ticket_issuer_url_mismatch`).
- `federation_entity.issuer_url` is no longer used anywhere in the codebase or tests.
- The OIDF demo holder runtime, when configured with an `oidf` issuer-trust policy, successfully verifies a PermissionTicket end-to-end through the new pipeline (this is what Phase 4 T1+T2 prove against an integration-level test, not just a unit-level resolver test).
- Full `bun test` and `bunx tsc --noEmit` pass.
- `reference-implementation/main` is pushed.

## Non-Goals

- `jwks_uri` support inside the new type (inline only — see OQ2)
- Defining `permission_ticket_endpoint`, `supported_*` advertisement fields, or any other entity-type fields beyond `issuer_url` and `jwks`
- Changing the direct-JWKS Plan 25 publication path
- Changing how `oauth_client` metadata is consumed in the client-auth flow
- IANA registration of the new entity type identifier (informal first; registration is a separate process)
- Backward compatibility with the old `federation_entity.issuer_url` shape

## Estimated Scope

Small to medium:

- ~250-400 lines across `demo-crypto-bundle.ts` (sibling map + grow logic), `demo-topology.ts` (entity type emission + key wiring), `resolver.ts` + new `extractTicketIssuerMetadata`, `policy.ts` (rename / document the client-auth-only artifact), the test files (oidf-issuer-trust, oidf-external-consumption, oidf-topology, issuer-key-cross-source, plus any token-exchange end-to-end test), the spec text, and the README.
- Most of the code work is split across the demo crypto bundle Phase 1 and the new resolver accessor in Phase 3. The demo topology change and spec text are mechanical.
