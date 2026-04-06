# Plan 14: Permission Ticket Portable-Kernel Redesign

## Status

Design draft for review. This plan does **not** update `input/` yet. Its job is to pin down the candidate new specification model before translating it into formal spec language or reference-implementation code.

## Why This Plan Exists

The earlier Permission Ticket model drifted toward portable semantics that many recipients cannot reliably enforce. In practice, recipient organizations can usually enforce a smaller kernel:

- who the patient is
- who the real-world requester is
- why any access exists at all
- what resource types / operations are allowed
- one coarse timeframe
- one coarse sensitive-data instruction
- coarse jurisdiction scoping
- positive source scoping by exact organizations

Everything beyond that should either be:

- ticket-type-specific `context`, or
- explicitly profile-specific, or
- treated as a non-portable hint rather than a universal portable semantic.

This plan defines that smaller kernel.

## Core Decisions

### 1. Keep JWT and Token Exchange

- The ticket remains a JWT redeemed as an RFC 8693 `subject_token`.
- `aud` remains a standard JWT audience claim.
- `ticket_type` remains a **URI**, not a local string enum.
- `jti` is required.

### 2. Keep Subject Portable and Thin

- `subject.patient` is always present.
- The inline patient MAY be thin and only needs enough facts for portable matching.
- `subject.recipientRecord` is optional and acts as a direct-recipient optimization when the issuer knows a recipient-local patient record reference or identifier.

### 3. Distinguish Requester from Presenter

- `requester` is the substantive human/organization on whose behalf access exists.
- `presenter` is the software client redeeming the ticket.
- The ticket models the requester, not the presenter.
- Presenter identity and binding are handled separately by client authentication plus binding claims.

### 4. Keep Authority Provenance Common but Modest

The common shell carries an `authority` object answering:

- why does any access exist at all?

It is richer than a single enum, but it should not swallow ticket-type-specific workflow semantics.

### 5. Make Access the Normative Model

`access.permissions` is the normative authorization model.

SMART scopes are:

- a request-time ceiling
- an issued-token projection
- not the core ticket semantics

### 6. Keep Filtering Portable and Positive

Portable common filtering should include:

- one coarse `dataPeriod`
- coarse jurisdiction scoping using `FHIR.Address`-shaped country/state values
- positive source organization scoping
- one coarse `sensitiveData` switch

The common shell should **not** standardize negative source exclusions.

### 7. Keep Binding Orthogonal

Client redemption binding remains orthogonal to access semantics.

This design keeps today’s two independent binding semantics:

- exact key binding (`cnf.jkt`)
- framework/entity binding (`client_binding`)

They may appear independently or together.

The shell could eventually wrap them under a single `presenter_binding` object, but the semantics remain independent:

- key binding
- framework-entity binding

not one-or-the-other.

### 8. Keep Regrant Issuer-Mediated

- regrant means issuer-mediated child-ticket issuance
- not embedded tickets
- not holder self-minting

## Portable Kernel vs Profile-Specific Space

### Tier 1: Base Portable Kernel

Recipients claiming the base profile should plausibly support:

- JWT envelope validation
- subject resolution from `subject.patient` and optional `recipientRecord`
- requester interpretation
- `authority`
- `permissions`
- one coarse `dataPeriod`
- one coarse `sensitiveData`
- coarse `jurisdictions`

### Tier 2: Portable but Conditional

Recipients may support these in the base profile, but only if they can truly enforce them:

- `source.organizations`

### Tier 3: Profile-Specific Only

These should **not** be universal common-shell semantics:

- negative source exclusions
- facility/service-class exclusions
- encounter-class restrictions
- arbitrary recipient-specific sensitive-source taxonomies
- fine-grained local security-label semantics
- arbitrary search filters if they depend on recipient-specific indexing or unsupported search behavior

## Proposed TypeScript Model

This is the current candidate shape for the redesign.

```ts
export type Uri = string;
export type Instant = string;
export type NonEmptyArray<T> = [T, ...T[]];
export type JwtAudience = string | NonEmptyArray<string>;

export interface PermissionTicket {
  iss: Uri;
  aud: JwtAudience;
  exp: number;
  jti: string;
  ticket_type: Uri;
  iat?: number;

  /**
   * Orthogonal redemption binding mechanisms.
   * Either may appear alone, or both may appear together.
   */
  cnf?: {
    jkt: string;
  };

  client_binding?: {
    binding_type: "framework-entity";
    framework: Uri;
    framework_type: "well-known" | "udap";
    entity_uri: Uri;
  };

  revocation?: {
    url: Uri;
    rid: string;
  };

  derivedFrom?: {
    parentJti: string;
    rootJti: string;
    depth: number;
  };

  subject: Subject;

  /**
   * The real-world party for whom the grant exists.
   * Distinct from the software presenter/client.
   */
  requester?: Requester;

  authority: Authority;

  access: AccessGrant;

  context: TicketContext;

  regrant?: Regrant;
}

export interface Subject {
  /**
   * Always present and may be thin.
   * Carries only the matching facts needed for portability.
   */
  patient: FHIR.Patient;

  /**
   * Optional recipient-local patient locator.
   * Useful when the issuer knows a target-local reference or identifier.
   */
  recipientRecord?: FHIR.Reference & { type?: "Patient" };
}

export type Requester =
  | FHIR.RelatedPerson
  | FHIR.Practitioner
  | FHIR.PractitionerRole
  | FHIR.Organization;

export type AuthorityKind =
  | "self"
  | "delegation"
  | "consent"
  | "mandate"
  | "policy"
  | "relationship"
  | "contract";

export interface Authority {
  kind: AuthorityKind;

  /**
   * Coarse refinement when needed, but not the full workflow context.
   */
  code?: FHIR.CodeableConcept;

  /**
   * Common provenance fields worth keeping across many ticket families.
   */
  verifiedAt?: Instant;
  verifiedBy?: FHIR.Organization | FHIR.Practitioner | FHIR.PractitionerRole;
  grantor?: FHIR.Patient | FHIR.RelatedPerson | FHIR.Organization;
  issuingAuthority?: FHIR.Organization;
  evidence?: FHIR.Resource[];
}

export type SensitiveDataPolicy = "exclude" | "include";

export type RestInteraction =
  | "read"
  | "search"
  | "history"
  | "create"
  | "update"
  | "patch"
  | "delete";

export interface DataPermission {
  kind: "data";
  resourceType: string;
  interactions: NonEmptyArray<RestInteraction>;

  /**
   * Optional portable narrowing dimensions.
   * AND across populated groups, OR within each group.
   */
  categoryAnyOf?: NonEmptyArray<FHIR.Coding>;
  codeAnyOf?: NonEmptyArray<FHIR.Coding>;
}

export interface OperationPermission {
  kind: "operation";
  name: string;
  target?: FHIR.Reference;
}

export type PermissionRule = DataPermission | OperationPermission;

export interface AccessGrant {
  permissions: NonEmptyArray<PermissionRule>;

  /**
   * One coarse timeframe only.
   * If disjoint windows are required, mint separate tickets.
   */
  dataPeriod?: FHIR.Period;

  /**
   * Coarse jurisdiction scoping.
   * Uses Address-shaped values for country/state-style matching.
   */
  jurisdictions?: NonEmptyArray<Pick<FHIR.Address, "country" | "state">>;

  /**
   * Positive source scoping only.
   * Omitted = any source.
   * Present = returned data must be attributable to one of the listed sources.
   */
  source?: {
    organizations?: NonEmptyArray<FHIR.Identifier>;

    /**
     * Candidate profile-level extension point, not guaranteed base semantics.
     */
    organizationTypesAnyOf?: NonEmptyArray<FHIR.CodeableConcept>;
  };

  /**
   * Recipient interprets this using local sensitivity labels and policy.
   */
  sensitiveData?: SensitiveDataPolicy;
}

export interface Regrant {
  maxDepth: number;
  allowSubdelegation?: boolean;
}

export interface PatientAccessContext {
  kind: "patient-access";
}

export interface PublicHealthContext {
  kind: "public-health";
  reportableCondition: FHIR.CodeableConcept;
  investigationCase?: FHIR.Identifier;
  triggeringResource?: FHIR.Condition | FHIR.Observation | FHIR.DiagnosticReport;
  sourceReport?: FHIR.DocumentReference;
}

export interface SocialCareReferralContext {
  kind: "social-care-referral";
  concern: FHIR.CodeableConcept;
  referral: FHIR.ServiceRequest;
  task?: FHIR.Task;
}

export interface PayerClaimsContext {
  kind: "payer-claims";
  service: FHIR.CodeableConcept;
  claim: FHIR.Claim;
}

export interface ResearchContext {
  kind: "research";
  study: FHIR.ResearchStudy;
  researchSubject?: FHIR.ResearchSubject;
  condition?: FHIR.CodeableConcept;
}

export interface ProviderConsultContext {
  kind: "provider-consult";
  reason: FHIR.CodeableConcept;
  consultRequest: FHIR.ServiceRequest;
}

export type TicketContext =
  | PatientAccessContext
  | PublicHealthContext
  | SocialCareReferralContext
  | PayerClaimsContext
  | ResearchContext
  | ProviderConsultContext;
```

## Semantics

### Envelope

- `iss`, `aud`, `exp`, and `jti` are mandatory.
- `ticket_type` is a URI and selects ticket-type-specific processing rules.
- `aud` may be one URI/string or an array of recipient identifiers.
- `jti` is the stable handle for revocation, lineage, and audit correlation.

### Subject

- `subject.patient` is always required.
- The inline patient may be thin.
- `recipientRecord` is optional and is preferred only as a direct-recipient optimization.

### Requester

- Absent for self-access.
- Present for proxy, organizational, clinician, or other non-self use cases.
- Represents the real-world party for whom the grant exists.
- Distinct from the presenting software client.

### Authority

`authority.kind` is the coarse answer to “why does any access exist at all?”

Allowed kinds:

- `self`
- `delegation`
- `consent`
- `mandate`
- `policy`
- `relationship`
- `contract`

The common provenance fields (`verifiedAt`, `verifiedBy`, `grantor`, `issuingAuthority`, `evidence`) are intended for audit and broad policy reasoning. Ticket-type-specific workflow semantics belong in `context`.

### Access

`access.permissions` is the normative authorization model.

Rules:

- `permissions` are additive.
- within one `DataPermission`, populated filter groups are ANDed
- values within one `*AnyOf` group are ORed
- `dataPeriod` applies to the whole access grant, not to one permission only
- `jurisdictions` applies to the whole access grant, not to one permission only
- `sensitiveData` is coarse and recipient-interpreted
- `source` is positive-only scoping

### Timeframe

- `dataPeriod` is one coarse timeframe for the ticket.
- If multiple disjoint windows are needed, mint multiple tickets.

### Sensitive Data

- `exclude` means the recipient should exclude locally classified sensitive data
- `include` means the ticket permits it, subject to local law/policy
- if classification is unknown and the ticket says `exclude`, recipients should default conservatively

### Jurisdictions

- `jurisdictions` provides coarse geographic filtering
- it is modeled using `FHIR.Address`-shaped values, typically only `country` and `state`
- recipients should treat it as a coarse portable restriction, not a full geospatial model
- this is the preferred common-shell mechanism for state-based access restrictions

### Source Scoping

- `source.organizations` is the strongest portable provenance filter in the common shell
- `organizationTypesAnyOf` is a candidate profile-level dimension, not a guaranteed base semantic

### Presenter Binding

Redemption binding remains orthogonal to access semantics:

- `cnf.jkt` means exact-key binding
- `client_binding` means framework/entity binding
- if both are present, both must pass

### Regrant

- only issuer-mediated child tickets
- no embedded tickets
- no holder self-minting
- child tickets must be narrower than or equal to parent tickets

## Use-Case Walkthroughs

These examples are intentionally schematic. Their job is to validate the model, not to serve as final spec examples.

### UC1: Network-Mediated Patient Access

- `subject.patient`: thin demographics and/or identifier
- `requester`: absent
- `authority.kind`: `self`
- `access.permissions`: data permissions for specific resource types
- `access.dataPeriod`: optional
- `access.sensitiveData`: likely `exclude` by default
- `context.kind`: `patient-access`
- binding: typically `cnf.jkt`

### UC2: Authorized Representative

- `subject.patient`: thin patient identity
- `requester`: `RelatedPerson`
- `authority.kind`: `delegation`
- `authority.verifiedAt`, `authority.verifiedBy`, `authority.grantor`
- `access.permissions`: broader patient-facing data access
- `access.sensitiveData`: usually `exclude` unless explicitly allowed by issuer policy
- `context.kind`: `patient-access`
- binding: typically `cnf.jkt`

### UC3: Public Health Investigation

- `subject.patient`: thin patient identity
- `requester`: `Organization`
- `authority.kind`: `mandate` or `policy`
- `authority.issuingAuthority` / `evidence` as needed
- `access.permissions`: broad data access
- `access.dataPeriod`: likely present
- `access.jurisdictions`: may be present for state or territorial restriction
- `access.sensitiveData`: may be `include` depending on law/policy
- `access.source.organizations`: optional positive narrowing when appropriate
- `context.kind`: `public-health`

### UC4: Social Care Referral

- `subject.patient`: thin patient identity, optional `recipientRecord`
- `requester`: `PractitionerRole` or `Organization`
- `authority.kind`: `relationship`, `consent`, or `policy`
- `access.permissions`: targeted `ServiceRequest` / `Task` / supporting data
- `access.jurisdictions`: may be present when the authorization is jurisdiction-limited
- `access.source.organizations`: optional positive scoping
- `access.sensitiveData`: often `exclude`
- `context.kind`: `social-care-referral`

### UC5: Payer Claims Adjudication

- `subject.patient`: thin patient identity, optional `recipientRecord`
- `requester`: `Organization`
- `authority.kind`: `contract` or `policy`
- `access.permissions`: targeted documents / procedures / claim-supporting data
- `access.dataPeriod`: often present
- `access.jurisdictions`: may be present for payer-region or regulatory bounds
- `access.source.organizations`: often present
- `access.sensitiveData`: usually `exclude` unless policy requires inclusion
- `context.kind`: `payer-claims`

### UC6: Research Study

- `subject.patient`: thin identity, perhaps MRN or study-local identity
- `requester`: `Organization` or `PractitionerRole`
- `authority.kind`: `consent` or `policy`
- `authority.evidence`: may include Consent or related resource
- `access.permissions`: broad or targeted data access depending on study
- `access.dataPeriod`: often present
- `access.jurisdictions`: optional when the study or governing policy is jurisdiction-bound
- `access.sensitiveData`: usually `exclude` unless explicit policy/consent supports inclusion
- `context.kind`: `research`

### UC7: Provider-to-Provider Consult

- `subject.patient`: thin identity, optional `recipientRecord`
- `requester`: `Practitioner` or `PractitionerRole`
- `authority.kind`: `relationship` or `policy`
- `access.permissions`: broad consult-supporting data or targeted slices
- `access.jurisdictions`: optional
- `access.source.organizations`: optional positive scoping
- `access.sensitiveData`: usually `exclude`
- `context.kind`: `provider-consult`

## What Is Explicitly Out of Core

These are intentionally **not** common portable semantics:

- negative source exclusions
- facility/service-class exclusion logic
- arbitrary recipient-specific sensitivity sub-taxonomies
- local encounter-class semantics
- arbitrary search filters that recipients may not uniformly support

If needed, they should be handled as:

- ticket-type-specific `context`, or
- specialized profile extensions with explicit support/fail behavior

## Open Design Questions

1. **Requester vs grantee**
   - keep `requester`
   - or rename to `grantee`
   - recommendation: use `requester` if we are explicit that presenter is separate

2. **Organization type filtering**
   - include as `source.organizationTypesAnyOf`
   - or exclude from base semantics entirely
   - recommendation: keep as profile-level candidate, not core

3. **Search filters**
   - include in base `DataPermission`
   - or exclude from the portable kernel
   - recommendation: exclude from base unless we define a very narrow, enforceable subset

4. **Authority richness**
   - how many provenance fields stay common
   - recommendation: keep `verifiedAt`, `verifiedBy`, `grantor`, `issuingAuthority`, `evidence`

## Follow-On Work

Once the model above is accepted at a design level:

1. Rewrite the ticket-design draft around this kernel.
2. Update `input/` spec sources and generated examples.
3. Reconcile use-case ticket type definitions against the new shell.
4. Plan the reference-implementation updates:
   - new ticket validation model
   - new access compilation model
   - new filtering semantics for time/source/sensitive data
5. Identify which old semantics are:
   - removed
   - profile-specific
   - mapped into `context`
