# SMART Permission Tickets — Change Plan

## Overview

This document captures the agreed changes to the SMART Permission Tickets specification, organized as discrete work items with rationale and replacement prose/structures.

**Implementation stance:** this is a clean break. The specification, shared schema, generator scripts, examples, reference server, UI, and tests should all move directly to the simplified model. Do **not** preserve backwards compatibility, dual parsing, legacy field aliases, bridge layers, or temporary old-to-new mappings.

---

## Change 1: Clarify Requester Semantics

### Problem

`requester` currently does double duty. In patient-directed use cases (UC1/UC2), the issuer identity-proofs the requester before minting. In B2B use cases (UC3–UC7), the issuer describes an intended organizational beneficiary without necessarily handing the ticket directly to that organization. The spec doesn't acknowledge this difference, which may confuse implementers about how much to trust the `requester` claim.

The current prose also doesn't make clear that `requester` is never cryptographically bound — `presenter_binding` binds to the *client software*, not the requester.

### Change

Replace the "Requester Semantics" section with:

> **Requester Semantics**
>
> `requester` is an issuer attestation describing the real-world party for whom the grant exists. It is not cryptographically bound to the presenting client or to any authentication event at the Data Holder.
>
> The issuer's internal verification process before attesting to `requester` varies by use case and is out of scope for this specification. For patient-directed delegation, the issuer typically identity-proofs the requester and confirms the patient's intent to delegate. For B2B use cases, the issuer has institutional knowledge of the requesting organization. In all cases, the Data Holder trusts the issuer's attestation — it does not independently verify the requester's identity, relationship, or authority.
>
> `requester` is absent for self-access. When absent, the ticket authorizes access on behalf of the patient identified in `subject.patient`; the presenting client is still authenticated by the outer `client_assertion`.
>
> The Data Holder MAY use `requester` for local policy decisions (scoping data, applying sensitivity rules, selecting access-control policies) and for audit logging. It is not part of the cryptographic validation gate, which remains: issuer trust, ticket signature, presenter binding (to the client, not the requester), and audience validation.
>
> `requester` and `presenter_binding` operate independently. The requester describes who the grant is for; the presenter binding constrains which software may redeem it. They will often identify the same organization in B2B flows, but need not align — a platform provider may present tickets on behalf of various requesting organizations.

Remove the existing "Relationship between framework_client.entity_uri and requester" subsection (its content is captured in the final paragraph above).

Remove the "Issuer vs. Recipient Responsibility" section's references to "re-verify the delegation relationship" and similar language that implies the recipient might consider doing so. Keep the table of what the issuer verifies vs. what the recipient uses, but tighten it to be consistent with the new prose.

---

## Change 2: Drop `context.kind`, Use `ticket_type` as Sole Discriminator

### Problem

`ticket_type` (a URI) and `context.kind` (a short string) are nearly 1:1 mapped and serve the same purpose: telling the Data Holder which schema and processing rules apply. UC1 and UC2 share `context.kind = "patient-access"`, but they already have distinct `ticket_type` URIs, making `kind` redundant in all cases.

### Change

**Remove `kind` from all context types.** `ticket_type` is the sole discriminator for the context schema. The Data Holder already has `ticket_type` in hand when it parses `context`, so it knows what shape to expect.

**Make `context` optional** for ticket types that define no context fields (UC1, UC2). When the ticket type's context schema is empty, `context` MAY be omitted entirely. This avoids forcing issuers to include an empty `{}`.

**Update context type definitions:**

| Ticket Type | Context Fields |
|---|---|
| `patient-self-access-v1` | *(none — `context` omitted or `{}`)* |
| `patient-delegated-access-v1` | *(none — `context` omitted or `{}`)* |
| `public-health-investigation-v1` | `reportable_condition` (required) |
| `social-care-referral-v1` | `concern` (required), `referral` (required) |
| `payer-claims-adjudication-v1` | `service` (required), `claim` (required) |
| `research-study-access-v1` | `study` (required) |
| `provider-consult-v1` | `reason` (required), `consult_request` (required) |

Context carries only what the Data Holder needs for its yes/no decision and data scoping. Fields previously defined as optional context fields (`investigation_case`, `triggering_resource`, `source_report`, `task`, `research_subject`, `condition`) are removed from the spec. Profiles may reintroduce them as typed top-level claims if needed (see Change 7).

**Update TypeScript:**

```typescript
export type PermissionTicket =
  | PatientAccessTicket
  | AuthorizedRepresentativeTicket
  | PublicHealthTicket
  | SocialCareReferralTicket
  | PayerClaimsTicket
  | ResearchStudyTicket
  | ProviderConsultTicket;

// Base fields shared by all ticket types
interface TicketBase {
  iss: Uri;
  aud: JwtAudience;
  exp: number;
  jti: string;
  iat?: number;
  presenter_binding?: PresenterBinding;
  revocation?: RevocationClaim;
  must_understand?: string[];
  subject: Subject;
  requester?: Requester;
  access: AccessGrant;
}

interface PatientAccessTicket extends TicketBase {
  ticket_type: "https://smarthealthit.org/permission-ticket-type/patient-self-access-v1";
  context?: Record<string, never>;  // empty or omitted
}

interface AuthorizedRepresentativeTicket extends TicketBase {
  ticket_type: "https://smarthealthit.org/permission-ticket-type/patient-delegated-access-v1";
  requester: RelatedPersonRequester;  // required for this type
  context?: Record<string, never>;
}

interface PublicHealthTicket extends TicketBase {
  ticket_type: "https://smarthealthit.org/permission-ticket-type/public-health-investigation-v1";
  context: {
    reportable_condition: FHIRCodeableConcept;
  };
}

interface SocialCareReferralTicket extends TicketBase {
  ticket_type: "https://smarthealthit.org/permission-ticket-type/social-care-referral-v1";
  context: {
    concern: FHIRCodeableConcept;
    referral: {
      resourceType: "ServiceRequest";
      identifier?: FHIRIdentifier[];
      status: string;
      intent: string;
    };
  };
}

interface PayerClaimsTicket extends TicketBase {
  ticket_type: "https://smarthealthit.org/permission-ticket-type/payer-claims-adjudication-v1";
  context: {
    service: FHIRCodeableConcept;
    claim: {
      resourceType: "Claim";
      identifier?: FHIRIdentifier[];
      status: string;
      use: string;
    };
  };
}

interface ResearchStudyTicket extends TicketBase {
  ticket_type: "https://smarthealthit.org/permission-ticket-type/research-study-access-v1";
  context: {
    study: {
      resourceType: "ResearchStudy";
      identifier?: FHIRIdentifier[];
      status: string;
      title?: string;
    };
  };
}

interface ProviderConsultTicket extends TicketBase {
  ticket_type: "https://smarthealthit.org/permission-ticket-type/provider-consult-v1";
  context: {
    reason: FHIRCodeableConcept;
    consult_request: {
      resourceType: "ServiceRequest";
      identifier?: FHIRIdentifier[];
      status: string;
      intent: string;
    };
  };
}
```

**Update all seven example payloads** to remove `"kind"` from their `context` objects.

**Update per-profile constraints table:** drop the "Context Kind" column.

**Update must-understand discussion:** `context` remains must-understand when present; its schema is determined by `ticket_type`.

---

## Change 3: Collapse Presenter Binding to a Discriminated Union

### Problem

`presenter_binding` is currently a container with two independent optional sub-objects (`key` and `framework_client`) that can appear alone or together. The "both must pass" combination mode adds complexity. In practice, key binding (`jkt`) is strictly stronger than framework binding — if you know the client's key, framework identity is redundant. No realistic use case requires both simultaneously.

### Change

Replace the container model with a discriminated union on `method`:

```json
// Key-bound
"presenter_binding": {
  "method": "jkt",
  "jkt": "0ZcOCORZNYy-DWpqq30jZyJGHTN0d2HglBV3uiguA4I"
}

// Framework-bound
"presenter_binding": {
  "method": "framework_client",
  "framework": "https://state.example.gov/trust-framework/public-health",
  "framework_type": "udap",
  "entity_uri": "https://state.example.gov/organizations/epi-unit"
}
```

**Replacement prose:**

> **Presenter Binding**
>
> A Permission Ticket MAY include `presenter_binding` to constrain which client may redeem it. When present, it carries a `method` discriminator selecting one binding mode:
>
> | Method | Fields | Verification |
> |---|---|---|
> | `jkt` | `jkt` (JWK Thumbprint per RFC 7638) | Data Holder computes the JWK Thumbprint of the `client_assertion` signing key and compares. Reject on mismatch. |
> | `framework_client` | `framework`, `framework_type` (`"udap"` or `"well-known"`), `entity_uri` | Data Holder verifies the presenting client's trust-framework identity matches the bound entity, using framework-specific verification (certificate SAN for UDAP, JWKS fetch and directory lookup for well-known). |
>
> When `presenter_binding` is absent, the ticket does not constrain which client may redeem it. Any authenticated client in the ticket's `aud` may present it.
>
> In all cases, the Data Holder authenticates the presenting client through its standard mechanism. Presenter binding adds a constraint on top of that authentication, not in place of it.

**Update TypeScript:**

```typescript
export type PresenterBinding = KeyBinding | FrameworkClientBinding;

export interface KeyBinding {
  method: "jkt";
  jkt: string;
}

export interface FrameworkClientBinding {
  method: "framework_client";
  framework: Uri;
  framework_type: "udap" | "well-known";
  entity_uri: Uri;
}
```

**Update the "Presenter Binding per Ticket Type" table:** keep the required/optional column, remove references to the combined mode.

**Update validation steps:** replace "If presenter_binding.key is present ... If presenter_binding.framework_client is present ... If both are present, both must pass" with "If presenter_binding is present, verify according to its method."

**Update all example payloads** to use the flat discriminated union format.

---

## Change 4: Sensitive Data — Recipient Default When Absent

### Problem

The current spec defaults to `"exclude"` when `sensitive_data` is absent. This creates a silent filtering problem for ticket types like public health where inclusion is typically desired — an issuer that forgets to set the field gets quietly filtered results. It also imposes a uniform policy on Data Holders that may have their own defaults.

### Change

Replace:

> If `sensitive_data` is absent, recipients default to `"exclude"`.

With:

> If `sensitive_data` is absent, the recipient applies its own default policy. Recipients SHOULD document their default behavior. When a ticket explicitly sets `"exclude"`, the recipient SHALL exclude locally classified sensitive data. When a ticket explicitly sets `"include"`, the recipient MAY include such data subject to local law and policy — even with `"include"`, the recipient may still withhold data that local law prohibits releasing.

Remove the sentence: "If classification is unknown and the ticket says 'exclude', recipients should default conservatively." Replace with:

> If the recipient cannot determine sensitivity classification for a resource and the ticket says `"exclude"`, the recipient SHOULD apply its local conservative-default policy for unclassified data.

---

## Change 5: Unify `jurisdictions` and `source_organizations` into `responder_filter`

### Problem

`jurisdictions` and `source_organizations` both restrict which Data Holders within the audience should return data, using different identifier types (geographic vs. organizational). They are modeled as separate fields with AND semantics across them, but in practice a ticket will typically use one or the other. Having two separate fields with cross-field AND logic adds implementation complexity.

### Change

Replace `access.jurisdictions` and `access.source_organizations` with a single `access.responder_filter` array using FHIR-native types:

```json
"responder_filter": [
  {
    "kind": "jurisdiction",
    "address": { "country": "US", "state": "CA" }
  },
  {
    "kind": "jurisdiction",
    "address": { "country": "US", "state": "NY" }
  },
  {
    "kind": "organization",
    "organization": {
      "resourceType": "Organization",
      "identifier": [
        { "system": "http://hl7.org/fhir/sid/us-npi", "value": "1234567890" }
      ],
      "name": "General Hospital"
    }
  }
]
```

**Semantics:**

- A Data Holder checks whether it matches *any* entry in `responder_filter` (OR across entries).
- For `jurisdiction` entries, the Data Holder checks whether its own jurisdiction matches the `address` (country and state/subdivision when present). A multi-site Data Holder filters to matching sites.
- For `organization` entries, the Data Holder checks whether its organizational identity matches any of the `identifier` values. `name` is informational; matching is by identifier.
- If `responder_filter` is present and no entry matches, the Data Holder returns an empty result (consistent with FHIR search returning zero results).
- If `responder_filter` is absent, all Data Holders in the audience respond.

**Update TypeScript:**

```typescript
export type ResponderFilter = JurisdictionFilter | OrganizationFilter;

export interface JurisdictionFilter {
  kind: "jurisdiction";
  address: FHIRAddress;
}

export interface OrganizationFilter {
  kind: "organization";
  organization: {
    resourceType: "Organization";
    identifier?: FHIRIdentifier[];
    name?: string;
  };
}

export interface AccessGrant {
  permissions: NonEmptyArray<PermissionRule>;
  data_period?: FHIRPeriod;
  responder_filter?: NonEmptyArray<ResponderFilter>;
  sensitive_data?: SensitiveDataPolicy;
}
```

**Update the "Constraint Algebra" section:** remove the cross-dimension AND rule for jurisdictions × source_organizations. The new rule is simpler: `responder_filter` entries are ORed; `responder_filter` as a whole is ANDed with other access dimensions (`permissions`, `data_period`, `sensitive_data`).

**Update the "Constraint Semantics" table:** replace the `jurisdictions` and `source_organizations` rows with a single `responder_filter` row.

**Update the note about `aud` vs. scoping:** replace the existing note with:

> `aud` identifies eligible token endpoints (by URL or trust framework membership). `responder_filter` narrows within that audience by jurisdiction or organizational identity — useful when the issuer knows a geographic constraint or NPI but not the Data Holder's FHIR URL. A Data Holder that is in the `aud` but does not match any `responder_filter` entry returns an empty result.

**Update all affected example payloads** (UC3, UC5 use jurisdictions/source_organizations currently).

---

## Change 6: Revocation via Bitstring Status List

### Problem

The current revocation mechanism (JSON CRL with HMAC-derived rids, monotonic counters, timestamp suffixes) is heavyweight for v1. Long-lived tickets are a must, so revocation is a must — but the mechanism should be as simple as possible.

### Change

Replace the entire "Revocation" subsection with:

> **Revocation**
>
> Issuers MAY support revocation of individual tickets before expiration. Revocation uses a bitstring status list: each revocable ticket is assigned an index into a compressed bitstring published at a stable URL. A set bit means the ticket is revoked.
>
> **Ticket Claims**
>
> Tickets supporting revocation include a `revocation` claim and SHALL also include `jti`:
>
> ```json
> {
>   "iss": "https://trusted-issuer.org",
>   "aud": "https://tefca.hhs.gov",
>   "exp": 1735689600,
>   "jti": "ticket-unique-id",
>   "ticket_type": "https://smarthealthit.org/permission-ticket-type/patient-self-access-v1",
>   "revocation": {
>     "url": "https://trusted-issuer.org/.well-known/status/patient-access",
>     "index": 4722
>   },
>   "subject": { "...": "..." },
>   "access": { "...": "..." }
> }
> ```
>
> | Field | Description |
> |---|---|
> | `revocation.url` | URL of the issuer's status list for this category of tickets |
> | `revocation.index` | Zero-based bit position in the status list assigned to this ticket |
>
> Index assignment is the issuer's responsibility. Each index SHALL be assigned to at most one active ticket. Issuers SHOULD allocate indices to avoid sparse lists.
>
> **Status List Format**
>
> The status list is a JSON document served at the URL specified in the ticket:
>
> ```json
> {
>   "kid": "issuer-signing-key-id",
>   "bits": "<base64url-encoded gzip-compressed bitstring>"
> }
> ```
>
> | Field | Description |
> |---|---|
> | `kid` | Key ID used to sign tickets covered by this status list. Allows issuers to maintain separate lists per signing key. |
> | `bits` | A base64url-encoded, gzip-compressed bitstring. Bit N corresponds to `revocation.index` N. A value of 1 means revoked; 0 means valid. |
>
> To check revocation status, the Data Holder:
>
> 1. Fetches the status list from `revocation.url`
> 2. Base64url-decodes and gzip-decompresses `bits`
> 3. Reads the bit at position `revocation.index`
> 4. If the bit is 1, the ticket is revoked
>
> **Issuer Requirements**
>
> Issuers that support revocation:
>
> - SHALL publish the status list over HTTPS at the URL specified in tickets
> - SHALL serve the status list with appropriate HTTP cache headers
> - SHOULD set `Cache-Control: max-age` to no longer than 1 hour. Shorter values are appropriate when rapid revocation propagation is needed.
> - SHOULD keep each status list under 8,388,608 entries (2^23, ~1MB uncompressed). When the number of revocable tickets in a category exceeds this ceiling, issuers SHOULD partition across multiple status list URLs (e.g., by time window or subcategory).
> - SHOULD sign the status list as a JWS (compact serialization with the JSON payload above) to allow integrity verification independent of TLS. When signed, the Data Holder SHALL verify the signature using the issuer's published keys.
> - MAY use multiple status list URLs to group tickets by category, preventing correlation across ticket types
>
> **Data Holder Requirements**
>
> When `revocation` is present in a ticket, the Data Holder:
>
> - SHALL check the status list before issuing an access token
> - MAY cache the status list respecting HTTP cache headers
> - SHALL reject tickets whose bit is set with `invalid_grant` and `error_description`: "Ticket has been revoked"
> - If the status list cannot be retrieved and no valid cached copy exists, SHALL reject the request (fail-closed)
>
> **Privacy Considerations**
>
> All revocable tickets within a category share a single status list URL. A Data Holder's fetch does not reveal which specific ticket it is checking — only that it is checking some ticket in that category. Issuers SHOULD group tickets into categories that reflect natural trust boundaries (e.g., one list per ticket type, or per ticket type and time period) to balance privacy against list size.
>
> For large-scale deployments, issuers MAY split status lists by time window (e.g., one list per month of issuance) and encode this in the URL. The ticket's `revocation.url` always points to the correct list, so Data Holders need no awareness of the partitioning scheme.

**Update TypeScript:**

```typescript
export interface RevocationClaim {
  url: Uri;
  index: number;
}
```

**Update error responses table:** keep "Ticket revoked" and "Revocable ticket missing jti" rows unchanged.

---

## Change 7: Remove `supporting_artifacts` from v1

### Problem

`supporting_artifacts` is typed as `any[]`, explicitly not must-understand, and the base protocol never requires it for the recipient's yes/no decision. It adds an unstructured extension point to the core spec that invites interop problems without solving a concrete v1 need. With the context trimming in Change 2, the fields that might have migrated here (investigation case IDs, task references, research subject links, POA documents) no longer have a home in the core spec at all — which is fine, because the Data Holder doesn't need them to authorize access.

### Change

- Remove `supporting_artifacts` from the ticket structure and TypeScript interfaces.
- Remove the "Supporting Artifacts" section from the spec.
- Remove references to `supporting_artifacts` in the must-understand discussion (currently: "supporting_artifacts is explicitly NOT must-understand").
- Add a note in the extensibility/profiles section: "Profiles MAY define additional top-level claims for evidence, audit material, or supporting documents. Such claims should be listed in `must_understand` only if the recipient is required to process them. The base specification does not define a generic artifact container."

If a future profile needs to carry POA documents, consent resources, or other evidence, it can define a purpose-built claim (e.g., `delegation_evidence`) with a proper schema, listed in `must_understand` if enforcement is required. This is strictly better than an untyped array.

---

## Change Summary

| # | Change | Fields Removed | Fields Added/Modified | Net Effect |
|---|---|---|---|---|
| 1 | Requester semantics prose | *(none)* | *(prose only)* | Clarifies trust model, no wire format change |
| 2 | Drop `context.kind`, trim context fields | `context.kind` from all tickets; 6 optional context fields | `context` becomes optional for empty-context types | −7 fields, cleaner discriminated union |
| 3 | Collapse presenter binding | `presenter_binding.key`, `presenter_binding.framework_client` (nested) | `presenter_binding.method` + flat fields | Simpler validation, no combined mode |
| 4 | Sensitive data default | *(none)* | *(semantic change only)* | Absent = recipient's own policy, not "exclude" |
| 5 | Unify responder scoping | `access.jurisdictions`, `access.source_organizations` | `access.responder_filter` | −2 fields, +1 field; simpler OR semantics |
| 6 | Bitstring revocation | `revocation.rid`, old CRL format | `revocation.index`, bitstring status list | Simpler mechanism; includes cache TTL (SHOULD ≤1h) and list size (SHOULD ≤2^23) guidance |
| 7 | Remove `supporting_artifacts` | `supporting_artifacts` | *(none)* | −1 untyped field; profiles can define typed alternatives |

---

## Reference Implementation Impact and Migration Plan

This plan applies first to the specification sources, shared schema, generator scripts, and generated examples. After those are updated, the reference implementation must cut over fully to the new shape. This is a clean break, not a compatibility bridge.

### Guiding Rule

- Update the **canonical shared Zod schema** in `reference-implementation/shared/permission-ticket-schema.ts` first.
- Re-export from `scripts/types.ts` continues to work, but the shared schema remains the single source of truth.
- Regenerate spec JSON Schema, snippets, and signed examples from the new schema.
- Then update the reference implementation to emit and consume **only** the new ticket shape.

### Phase 1: Specification and Shared Schema

Files that must change:

- `reference-implementation/shared/permission-ticket-schema.ts`
- `scripts/types.ts`
- `input/pagecontent/index.md`
- `input/fsh/PermissionTicket.fsh`
- `scripts/sync_spec_snippets.ts`
- `scripts/generate_examples.ts`
- `input/includes/generated/**`
- `input/examples/**`

Required schema changes by change item:

#### Change 1: Requester semantics

- Prose-only in the spec, but examples must reflect the clarified semantics:
  - self-access tickets omit `requester`
  - delegated/B2B tickets include `requester` as issuer attestation only
- The shared schema can keep the same `Requester` resource union unless we choose to narrow it further later.

#### Change 2: `ticket_type` as sole context discriminator

- Remove `context.kind` from the shared schema.
- Replace the current discriminated union on `context.kind` with a `ticket_type`-keyed refinement.
- Allow `context` to be omitted for:
  - `patient-self-access-v1`
  - `patient-delegated-access-v1`
- Remove optional context fields that are no longer part of the core model:
  - `investigation_case`
  - `triggering_resource`
  - `source_report`
  - `task`
  - `research_subject`
  - `condition`
- Update all examples and prose snippets to omit `context.kind`.

#### Change 3: presenter binding union

- Replace the current container shape:
  - `presenter_binding.key`
  - `presenter_binding.framework_client`
- With a discriminated union:
  - `{ method: "jkt", jkt }`
  - `{ method: "framework_client", framework, framework_type, entity_uri }`
- Remove the “both must pass” mode from the schema and examples.
- Update generated JSON Schema and example tickets accordingly.

#### Change 4: `sensitive_data` absent semantics

- Keep `access.sensitive_data?: "exclude" | "include"` in the schema.
- Remove schema/prose language that implies an absent value is normalized to `"exclude"` in the wire format.
- Spec prose should instead say the recipient applies local default behavior when absent.

#### Change 5: `responder_filter`

- Remove:
  - `access.jurisdictions`
  - `access.source_organizations`
- Add:
  - `access.responder_filter: NonEmptyArray<ResponderFilter>`
- The shared schema should define:
  - `JurisdictionFilter { kind: "jurisdiction"; address }`
  - `OrganizationFilter { kind: "organization"; organization }`
- Matching semantics are OR across entries.
- All examples and snippets using state/org constraints must be rewritten.

#### Change 6: bitstring revocation

- Replace `revocation.rid` with `revocation.index: number`.
- Update generated examples and revocation prose/snippets to the status-list format.
- Shared schema should validate integer, non-negative `index`.

#### Change 7: remove `supporting_artifacts`

- Remove `supporting_artifacts` from:
  - shared schema
  - FSH
  - prose
  - generated JSON Schema
  - examples

### Phase 2: Generator and Example Integrity

After the schema and prose are updated:

- Run `bun scripts/sync_spec_snippets.ts`
- Run `bun scripts/generate_examples.ts`
- Ensure example generation uses `PermissionTicketSchema.parse(...)` against the new shape
- Review all seven use case tickets to confirm:
  - no `context.kind`
  - no `supporting_artifacts`
  - `presenter_binding` uses the new union shape
  - constrained examples use `responder_filter`
  - revocable examples use `revocation.index`

Completion checks:

- `input/includes/generated/json-schema/permission-ticket.schema.json` reflects the new wire model
- `input/includes/generated/signed-tickets/*.html` and `input/examples/signed-tickets/*.html` render the simplified payloads
- no stale generated snippets remain that show removed fields

### Phase 3: Reference Server Runtime Cutover

Files that must change:

- `reference-implementation/fhir-server/src/auth/tickets.ts`
- `reference-implementation/fhir-server/src/auth/ticket-revocation.ts`
- `reference-implementation/fhir-server/src/store/model.ts`
- `reference-implementation/fhir-server/src/app.ts`
- `reference-implementation/fhir-server/src/smoke-test.ts`
- `reference-implementation/fhir-server/src/network-directory.ts`

Required runtime changes by change item:

#### Change 2: context handling

- Remove all runtime dependence on `context.kind`.
- Validation should use `ticket_type` to determine which context fields are required.
- Runtime helpers that summarize or log `context.kind` must switch to `ticket_type` or ticket-type labels.
- Any helper that currently injects `context: { kind: "patient-access" }` for patient-access tickets must stop doing so.

#### Change 3: presenter binding handling

- Replace checks like:
  - `ticket.presenter_binding?.key?.jkt`
  - `ticket.presenter_binding?.framework_client`
- With:
  - `ticket.presenter_binding?.method === "jkt"`
  - `ticket.presenter_binding?.method === "framework_client"`
- Update all validation, summaries, smart-configuration capability strings, and demo event messages to the new model.
- Remove any code path or UI wording that suggests a combined key+framework mode still exists.

#### Change 4: local default for absent `sensitive_data`

- Update `compileSensitiveMode()` in `src/auth/tickets.ts` so absent `access.sensitive_data` is treated as the reference server’s local default, not as a wire-level default.
- For the reference implementation, keep the actual enforcement default conservative unless we explicitly choose otherwise, but describe it as local server behavior.
- Update any summaries that currently say “Sensitive excluded” just because the claim is absent.

#### Change 5: responder filtering

- Replace site filtering logic based on separate:
  - `ticket.access.source_organizations`
  - `ticket.access.jurisdictions`
- With a single `ticket.access.responder_filter` evaluation path.
- Update `compileAllowedSites()` in `src/auth/tickets.ts` to OR across responder-filter entries.
- Update store helpers or add a new helper so organization and jurisdiction matching can be evaluated through one normalized list.
- Update the data-contract/demo docs and comments to describe `responder_filter`, not separate fields.

#### Change 6: revocation registry

- Replace the current JSON CRL / `rid` logic in `src/auth/ticket-revocation.ts` with status-list lookup by `revocation.index`.
- Support:
  - fetch
  - caching
  - base64url decode
  - gzip decompress
  - bit lookup
- If we choose to support JWS-signed status lists in the reference implementation, specify and implement that explicitly; otherwise the plan should say TLS-only integrity is acceptable for the reference demo.
- Update the issuer/demo surfaces that publish revocation material so they emit the new status-list format.

### Phase 4: Viewer, Workbench, and Demo Builders

Files that must change:

- `reference-implementation/fhir-server/ui/src/demo.ts`
- `reference-implementation/fhir-server/ui/src/types.ts`
- `reference-implementation/fhir-server/ui/src/demo.test.ts`
- `reference-implementation/fhir-server/ui/src/components/PermissionWorkbench.tsx`
- `reference-implementation/fhir-server/ui/src/components/Viewer.tsx`
- `reference-implementation/fhir-server/ui/src/components/DataContract.tsx`

Required UI/demo changes:

- Ticket construction in `ui/src/demo.ts` must emit the new shape only:
  - no `context.kind`
  - `presenter_binding.method`
  - `access.responder_filter`
  - optional omission of `sensitive_data`
- The current site-selection logic in the workbench should map to:
  - jurisdiction filters when constraining by state
  - organization filters when constraining by site/org
- Ticket binding descriptions must change from:
  - `presenter_binding.key`
  - `presenter_binding.framework_client`
  - combined mode
  to the new single-method vocabulary.
- Any data-contract documentation or UI help text that explains `jurisdictions`, `source_organizations`, combined presenter binding, or default-sensitive exclusion must be updated.

### Phase 5: Tests

Files that will require broad updates:

- `reference-implementation/fhir-server/test/modes.test.ts`
- `reference-implementation/fhir-server/test/framework-auth.test.ts`
- `reference-implementation/fhir-server/test/udap-token-auth.test.ts`
- `reference-implementation/fhir-server/test/issuer-trust.test.ts`
- `reference-implementation/fhir-server/test/demo-events.test.ts`
- `reference-implementation/fhir-server/ui/src/demo.test.ts`
- `reference-implementation/fhir-server/ui/src/protocol-trace.test.ts`
- `reference-implementation/fhir-server/src/auth/ticket-revocation.test.ts`
- `reference-implementation/fhir-server/src/smoke-test.ts`

New or updated test coverage required:

- `context` omitted for UC1/UC2 is accepted and works end to end
- wrong/missing required context fields are rejected based on `ticket_type`
- `presenter_binding.method="jkt"` works for strict/key-bound flows
- `presenter_binding.method="framework_client"` works for UDAP and well-known flows
- old nested presenter-binding shapes are rejected
- `responder_filter` organization and jurisdiction entries are ORed correctly
- absent `sensitive_data` uses the recipient’s local default behavior
- status-list revocation rejects set bits and fail-closes on unavailable lists
- generated example tickets all parse successfully through the shared schema

### Phase 6: Documentation and Metadata Surfaces

Files that must change:

- `reference-implementation/fhir-server/README.md`
- `reference-implementation/fhir-server/src/app.ts` smart-configuration output
- any demo landing pages or inline docs that describe ticket fields

Required updates:

- rename advertised supported binding types to match the new `presenter_binding.method` model
- update sample tickets and curl examples
- update revocation docs from CRL/rid to status-list/index
- remove references to `supporting_artifacts` and `context.kind`

## Review Notes Before Implementation

These are the main decisions that need to be treated as intentional when we implement:

- **No compatibility layer.** The shared schema, generators, examples, server, UI, and tests should all switch together.
- **Change 3 is intentionally invasive.** The current reference implementation still advertises and summarizes combined presenter-binding modes; that entire shape must disappear.
- **Change 4 needs one explicit reference-server policy choice.** The spec delegates the absent-value behavior to the recipient. The reference implementation should document its local default and test it.
- **Change 6 is the heaviest runtime change.** It is not just a schema update; it replaces the current revocation mechanism and issuer demo surfaces.

## Ready-for-Implementation Checklist

- [x] Shared Zod schema updated to the new model
- [x] FSH and spec prose updated
- [x] Spec snippets, JSON Schema, and signed examples regenerated
- [x] Demo/workbench ticket builder emits only the new shape
- [x] Reference server validates and enforces only the new shape
- [x] Revocation registry switched to status-list semantics
- [x] All tests rewritten to the new model
- [x] Full `bun test` passes in `reference-implementation/fhir-server`
- [x] Example generators pass
