# Plan 15: Spec / Reference-Implementation Schema Unification and Migration

Status: complete

## Goal

Migrate the reference implementation from the old Permission Ticket model to the new portable-kernel model, while eliminating duplicated schema definitions between:

- the main spec in `input/`
- spec-generation scripts in `scripts/`
- the reference implementation in `reference-implementation/fhir-server/`

The end state should have one canonical executable ticket schema, shared by both the spec toolchain and the reference implementation.

## Core Decision

Use **Zod** as the canonical Permission Ticket schema source.

From that canonical schema, generate or derive:

- runtime validation/parsing for the reference implementation
- TypeScript types for the server, UI, and scripts
- JSON Schema for spec publication and example validation
- the TypeScript interface section embedded in the main spec

The spec prose, FSH logical model, and examples remain important, but the executable wire model should come from one shared source rather than being maintained independently in multiple places.

## Why This Plan Exists

The current spec has moved to the new portable-kernel model, but the reference implementation still assumes the old ticket shape:

- `sub`
- `cnf`
- `client_binding`
- `authorization.subject`
- `authorization.access.scopes`
- `details`

The spec now defines:

- `presenter_binding`
- `subject.patient`
- `subject.recipient_record`
- `requester`
- `access.permissions`
- `access.data_period`
- `access.jurisdictions`
- `access.source_organizations`
- `access.sensitive_data`
- `context`
- `supporting_artifacts`
- `must_understand`

This is now a structural mismatch, not a cosmetic one. The implementation, tests, demo UI, and visualizer all need coordinated migration.

## Design Principles

1. One canonical schema.
   The ticket wire model should live in one shared Zod module.

2. Parse early, compile once.
   The server should parse the incoming ticket with the shared schema, then compile it into a local authorization envelope.

3. Preserve the current enforcement pipeline where it still makes sense.
   Existing site filtering, revocation checking, and token issuance can be retained where they still fit the new model.

4. Clean break.
   Do not build backward compatibility, shims, or dual-model support. The server, UI, tests, and examples should emit and consume only the new shape.

5. Keep the spec artifacts generated from the same source as the implementation.
   The TypeScript interface block and JSON Schema examples in the main spec should come from the shared schema package, not a parallel handwritten model.

## Proposed Shared Schema Layout

Create a new shared module, likely at:

- `shared/permission-ticket-schema.ts`

This module should export:

- `PermissionTicketSchema`
- sub-schemas for:
  - `PresenterBindingSchema`
  - `SubjectSchema`
  - `RequesterSchema`
  - `AccessGrantSchema`
  - `DataPermissionSchema`
  - `OperationPermissionSchema`
  - `TicketContextSchema`
  - `RevocationSchema`
- `type PermissionTicket = z.infer<typeof PermissionTicketSchema>`

Optional helper exports:

- `type PresenterBinding`
- `type AccessGrant`
- `type TicketContext`
- `isPermissionTicket`
- `parsePermissionTicket`

### JSON Schema Derivation

Add a small generator that emits JSON Schema from the Zod schema for documentation and example checking.

Likely output targets:

- `input/includes/generated/spec-schema/permission-ticket.schema.json`
- optional per-subschema outputs if helpful

### TypeScript Spec Embedding

Replace the current duplicated `scripts/types.ts` ownership model with one of:

- `scripts/types.ts` re-exporting from `shared/permission-ticket-schema.ts`, or
- eliminating `scripts/types.ts` entirely and having the spec-generation scripts import the shared schema/types directly

The TypeScript block embedded in `input/pagecontent/index.md` should be generated from the canonical shared source, not maintained separately.

## Migration Scope

This plan covers:

- canonical shared schema creation
- spec toolchain migration
- reference server migration
- demo UI migration
- test migration
- visualizer/artifact updates
- completion criteria and progress tracking

This plan does not require:

- full multi-ticket inheritance / attenuation
- broader server support for all seven ticket types beyond what the reference implementation intentionally implements

## Phase 1: Canonical Shared Schema

### Deliverables

- [ ] Add `shared/permission-ticket-schema.ts`
- [ ] Define the full portable-kernel Zod schema
- [ ] Export inferred TypeScript types from that same module
- [ ] Add JSON Schema generation for the canonical schema
- [ ] Decide whether `scripts/types.ts` becomes a re-export shim or is removed

### Required Semantics to Encode

- [ ] `iss`, `aud`, `exp`, `jti`, `ticket_type`
- [ ] optional `iat`
- [ ] optional `presenter_binding` with independent `key` and `framework_client`
- [ ] optional `revocation`
- [ ] optional `must_understand`
- [ ] required `subject.patient`
- [ ] optional `subject.recipient_record`
- [ ] optional `requester`
- [ ] required `access`
- [ ] required `context`
- [ ] optional `supporting_artifacts`

### Important Cross-Field Invariants

- [ ] `jti` required
- [ ] `presenter_binding`, if present, must contain at least one sub-binding
- [ ] `DataPermission` requires `resource_type` and non-empty `interactions`
- [ ] `OperationPermission` requires `name`
- [ ] `context.kind` must be one of the supported context families
- [ ] `revocation` shape validated
- [ ] `must_understand` is an array of top-level claim names

### Notes

- Use Zod refinements / superRefine for invariants that plain TypeScript types cannot express.
- Keep FHIR resource-typed fields broad where needed, but prefer at least `resourceType`-shaped objects rather than `any`.

## Phase 2: Spec Toolchain Unification

### Deliverables

- [ ] Make spec-generation scripts import the canonical shared schema/types
- [ ] Generate JSON Schema from Zod into `input/includes/generated/...`
- [ ] Generate the TypeScript interface section in the main spec from the shared source
- [ ] Update example generators to validate against the Zod schema before signing
- [ ] Remove or reduce schema duplication in `scripts/`

### Files Likely Touched

- `scripts/generate_examples.ts`
- `scripts/sync_spec_snippets.ts`
- `scripts/types.ts`
- `scripts/use_case_catalog.ts`
- `input/pagecontent/index.md`
- `input/fsh/PermissionTicket.fsh`

### Completion Checklist

- [ ] `bun scripts/sync_spec_snippets.ts` passes
- [ ] `bun scripts/generate_examples.ts` passes
- [ ] generated examples reflect the new portable-kernel shape
- [ ] no stale old-model snippet directories remain

### Notes

- FSH remains a formal logical model, but it may still be unable to capture all discriminated-union semantics. That is acceptable as long as the executable source of truth is the shared Zod schema and the prose is clear about it.

## Phase 3: Server Runtime Cutover

### Goal

Teach the reference server to accept only the new ticket wire format, validate it with the shared schema, and compile it into the internal authorization envelope model.

### Deliverables

- [ ] Replace the old runtime `PermissionTicket` model in `src/store/model.ts`
- [ ] Parse incoming tickets with the shared Zod schema
- [ ] Remove old-shape field reads from `tickets.ts`
- [ ] Compile the new ticket shape into the existing `AuthorizationEnvelope`
- [ ] Decide what replaces `ticketSubject` now that ticket `sub` is gone

### Required Runtime Mappings

#### Presenter Binding

- [ ] `presenter_binding.key.jkt` -> existing proof-key binding enforcement
- [ ] `presenter_binding.framework_client` -> existing framework client binding enforcement
- [ ] when both exist, both must pass

#### Subject

- [ ] `subject.patient` -> demographic matching path
- [ ] `subject.recipient_record.reference` -> direct local reference hint
- [ ] `subject.recipient_record.identifier` -> direct identifier hint
- [ ] remove legacy `type = match | identifier | reference` dispatch

#### Access

- [ ] `access.permissions` -> compile allowed resource types and operation semantics
- [ ] decide how to project `access.permissions` into SMART scopes for token issuance
- [ ] `access.data_period` -> existing date-range filtering pipeline
- [ ] `access.jurisdictions` -> existing allowed-site filtering pipeline
- [ ] `access.source_organizations` -> existing organization-based site filtering
- [ ] `access.sensitive_data` -> existing deny/allow label behavior, renamed to include/exclude

#### Other

- [ ] `requester` available to downstream policy/audit surfaces
- [ ] `context` available to downstream policy/audit surfaces
- [ ] `must_understand` enforced
- [ ] `revocation` checked before token issuance
- [ ] remove old `details`-based date/sensitivity hooks

### Files Likely Touched

- `reference-implementation/fhir-server/src/store/model.ts`
- `reference-implementation/fhir-server/src/auth/tickets.ts`
- `reference-implementation/fhir-server/src/auth/issuers.ts`
- `reference-implementation/fhir-server/src/app.ts`
- `reference-implementation/fhir-server/shared/permission-tickets.ts`

### Key Decision to Resolve During Implementation

The old runtime uses `ticket.sub` as a local “grant subject” marker. The new model removes `sub`.

Possible resolution:

- remove `ticketSubject` entirely from the authorization envelope, or
- replace it with a locally derived string such as:
  - `ticketId`
  - `subject.patient.identifier[0]`
  - a server-side synthetic label

The preferred outcome is to remove any dependency on `sub` unless a clear new purpose emerges.

## Phase 4: Token Issuance and SMART Projection

### Goal

Move from scope-first ticket semantics to permission-first ticket semantics, while preserving OAuth token exchange and SMART-facing interoperability.

### Deliverables

- [ ] compile `access.permissions` to the issued SMART scope set
- [ ] preserve existing intersection behavior with requested scopes and client registration
- [ ] ensure the issued access token carries enough normalized constraints for resource-time enforcement
- [ ] update token issuance / introspection payloads if needed

### Required Semantics

- [ ] `DataPermission` resource/interactions -> SMART CRUDS scope projection
- [ ] `OperationPermission` handled explicitly or rejected if unsupported
- [ ] if no valid projected scopes remain, return `invalid_scope`
- [ ] non-scope constraints continue through to resource server enforcement

### Files Likely Touched

- `reference-implementation/fhir-server/src/auth/tickets.ts`
- `reference-implementation/fhir-server/src/app.ts`
- token/introspection helper types in `src/store/model.ts`

## Phase 5: Demo UI Ticket Construction

### Goal

Make the workbench and viewer produce, inspect, and explain the new ticket shape.

### Deliverables

- [ ] replace old ticket construction in `ui/src/demo.ts`
- [ ] emit `presenter_binding` instead of `cnf` / `client_binding`
- [ ] emit `subject.patient`
- [ ] emit `access.permissions`
- [ ] emit `access.data_period`, `jurisdictions`, `source_organizations`, `sensitive_data`
- [ ] emit required `context`
- [ ] remove legacy `authorization` / `details` shell from the UI

### Likely Design Choice

The UI still presents the user with SMART-scope-oriented choices. That is fine as long as:

- the UI compiles those choices into `access.permissions`
- any displayed “scopes” are treated as a projection / derived summary, not the canonical ticket payload

### Files Likely Touched

- `reference-implementation/fhir-server/ui/src/demo.ts`
- `reference-implementation/fhir-server/ui/src/types.ts`
- `reference-implementation/fhir-server/ui/src/lib/viewer-model.ts`
- `reference-implementation/fhir-server/ui/src/lib/artifact-viewer.ts`
- `reference-implementation/fhir-server/ui/src/components/PermissionWorkbench.tsx`
- `reference-implementation/fhir-server/ui/src/components/Viewer.tsx`
- `reference-implementation/fhir-server/ui/src/components/DemoVisualizer.tsx`

## Phase 6: Visualizer and Artifact Migration

### Goal

Ensure the visualizer and artifact views tell the correct story for the new model.

### Deliverables

- [ ] ticket-created event summarizes `subject.patient`, `access.permissions`, `data_period`, and `presenter_binding`
- [ ] visualizer scope/resource pills derive from `access.permissions`, not raw legacy `scopes`
- [ ] artifact viewer presents the new shell correctly
- [ ] request/response artifacts reflect the migrated wire shape

### Notes

- This is also where old UI language like `cnf.jkt`, `client_binding`, and `authorization.access.scopes` needs to be replaced.

## Phase 7: Test Migration

### Goal

Update the test suite so it builds and validates the new ticket model everywhere.

### Deliverables

- [ ] replace legacy ticket helper builders with shared-schema-aware builders
- [ ] update token-exchange tests
- [ ] update framework auth tests
- [ ] update UDAP ticket-binding tests
- [ ] update visualizer/demo tests
- [ ] update smoke test fixtures

### Files Likely Touched

- `reference-implementation/fhir-server/test/modes.test.ts`
- `reference-implementation/fhir-server/test/framework-auth.test.ts`
- `reference-implementation/fhir-server/test/udap-token-auth.test.ts`
- `reference-implementation/fhir-server/test/issuer-trust.test.ts`
- `reference-implementation/fhir-server/test/demo-events.test.ts`
- `reference-implementation/fhir-server/ui/src/demo.test.ts`
- `reference-implementation/fhir-server/ui/src/demo-visualizer.test.ts`
- `reference-implementation/fhir-server/src/smoke-test.ts`

### Checklist

- [ ] no test helper emits old `authorization` / `details` tickets
- [ ] no test helper emits old `cnf` / `client_binding`
- [ ] all tests pass under the shared schema

## Phase 8: Documentation and Cleanup

### Deliverables

- [ ] update README and implementation docs to describe the new ticket wire model
- [ ] remove dead old ticket-shape code
- [ ] remove old terminology from UI text and comments

## Recommended Implementation Order

1. Shared Zod schema
2. Spec scripts consume shared schema
3. Runtime cutover
4. Token issuance / SMART projection
5. UI ticket builder migration
6. Visualizer / artifact updates
7. Test migration
8. Cleanup and docs

This order keeps the canonical model in place first, then moves the server, then the demo/UI, then the tests.

## Suggested Completion Gates

### Gate A: Shared Schema in Place

- [ ] canonical Zod schema exists
- [ ] spec scripts consume it
- [ ] examples validate before signing

### Gate B: Server Accepts New Tickets

- [ ] `/sign-ticket` can mint the new shape
- [ ] `/token` can validate and redeem the new shape
- [ ] existing resource filtering still works

### Gate C: UI Emits and Displays New Tickets

- [ ] workbench builds the new ticket shape
- [ ] viewer still succeeds end to end
- [ ] visualizer tells the correct story

### Gate D: Tests Green

- [ ] full `bun test` passes in `reference-implementation/fhir-server`
- [ ] smoke test passes
- [ ] script generation passes

## Risks

### Risk 1: Scope-to-permission migration gets muddled

If the implementation keeps treating scopes as canonical while also claiming `access.permissions` is canonical, the resulting model will be internally inconsistent.

Mitigation:

- make one server-side projection function the single path from `access.permissions` -> SMART scopes

### Risk 2: Cutover touches many surfaces at once

A clean break removes hidden complexity, but it means server, UI, tests, and examples can fail together until the migration is complete.

Mitigation:

- migrate in clear phases
- run the full suite after each major slice
- keep the shared schema as the only source of truth throughout

### Risk 3: Zod/JSON-Schema generation loses some semantics

Complex discriminated unions and FHIR-shaped resource fields may not map perfectly to clean JSON Schema.

Mitigation:

- use Zod as the executable truth
- treat generated JSON Schema as documentation / validation aid, not a stronger authority than Zod itself

### Risk 4: UI still presents legacy conceptual language

The demo may continue saying “cnf.jkt” or “ticket scopes” after the wire model changes.

Mitigation:

- do an explicit terminology cleanup pass in UI copy and artifact summaries

## Explicit Non-Goals for This Plan

- making the reference implementation production-grade
- implementing child tickets / attenuation / inheritance
- implementing all seven ticket types end to end in server enforcement
- redesigning the overall user experience beyond what is needed to reflect the new ticket model accurately

## Progress Tracker

### Phase 1: Shared Canonical Schema
- [x] complete

### Phase 2: Spec Toolchain Unification
- [x] complete

### Phase 3: Server Runtime Migration
- [x] complete

### Phase 4: Token / SMART Projection Migration
- [x] complete

### Phase 5: UI Ticket Builder Migration
- [x] complete

### Phase 6: Visualizer / Artifact Migration
- [x] complete

### Phase 7: Test Migration
- [x] complete

### Phase 8: Cleanup / Docs
- [x] complete
