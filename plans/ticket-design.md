Here is a full greenfield proposal for a revised Permission Ticket design.

The design keeps JWT as the artifact container and OAuth 2.0 Token Exchange as the transport pattern, but it intentionally simplifies the shell. `aud` stays a legal JWT audience claim, so it is a string or an array of strings. Token exchange still uses `subject_token`, and a future profile could add `actor_token`, but the base design here is a single-ticket model. JWT `sub` is optional, so this proposal omits it and uses `jti` as the unique ticket identifier instead. ([RFC Editor][1])

The design also treats SMART scopes as a projection, not as the ticket’s primary rights model. SMART and US Core already push toward least-privilege, including granular category-constrained scopes such as Observation `vital-signs` and `social-history`, so the ticket’s native access model should be richer than a scope string and only later projected to SMART v2 where needed. ([FHIR Build][2])

FHIR is useful inspiration but not the wire shell. `Consent` already distinguishes grantor, grantee, actions, purposes, and periods, while `Permission` is intended for interoperable transactional access rules, especially where full Consent is not the right artifact or should not be exposed. That supports a ticket model centered on authority provenance plus rights, without serializing one giant generic policy resource as the ticket itself. ([FHIR Build][3])

## 1. Intent

Define a portable, single-ticket authorization artifact that:

* works cleanly in OAuth 2.0 / RFC 8693 token exchange,
* supports self-access, delegated access, public health, social care, payer, research, and provider consult,
* carries enough inline data to be redeemed without assuming a shared global database,
* supports fine-grained rights such as categories, codes, date ranges, source organizations, jurisdictions, and explicit operations,
* leaves room for future multi-token composition, but does not depend on it. ([RFC Editor][4])

## 2. Design goals

1. **Portable by default.**
   Necessary facts are inline. No generic dereferencing requirement.

2. **Small common shell.**
   The shell only models cross-cutting concepts.

3. **No generic `details` bag.**
   Use closed per-ticket-type `context` shapes instead.

4. **Explicit authority provenance.**
   The ticket should say why any access exists at all.

5. **Native rights model first.**
   Resource/action/category/code/filter semantics are primary.

6. **Delegation without overfitting everything to delegation.**
   Public health, research, payer, and consult remain first-class non-delegation patterns.

7. **Recipient-side narrowing remains valid.**
   The ticket is a portable upper bound, not a guarantee of full release.

## 3. Core principles

### 3.1 `aud` stays standard

The ticket uses the registered JWT `aud` claim exactly as JWT defines it: one string or an array of strings. If you want a network-wide audience, use a network identifier string such as a URI. If you want multiple enumerated recipients, use a string array. The profile, not JWT itself, defines how recipients validate a network audience. ([RFC Editor][1])

### 3.2 `subject` is simple: inline patient, plus optional recipient-local locator

There is no separate `match`/`identifier`/`bound_record` type in the wire model. The recipient gets an inline `FHIR.Patient` and uses the data present to resolve locally. If the ticket is intended for a specific known recipient, the ticket can also carry an optional `recipientRecord` using a constrained `FHIR.Reference` to a `Patient`, so it can include a literal reference, an identifier, or both. FHIR `Reference` explicitly supports `reference`, `identifier`, and `display`, and its `identifier` element is intended for cases where there is no direct way to reference the target. ([FHIR Build][5])

That directly addresses the portability problem: the inline patient is the portable part, while `recipientRecord` is an optional direct-recipient optimization.

### 3.3 Basis, context, and purpose are distinct

The clean line is:

* **`basis`** = why the grantee may receive any access at all
* **`context`** = what specific workflow/case/study/request this ticket is about
* **`purpose?`** = optional coarse declared use category

Examples:

* public health
  `basis = mandate | policy`
  `context = reportable condition + case + source report`

* research
  `basis = consent | policy`
  `context = study + optional research subject`

* delegated patient access
  `basis = delegation`
  `context = patient-access`

This line mirrors what FHIR does conceptually: `Consent` and `Permission` distinguish justification/policy from action and purpose dimensions. ([FHIR Build][6])

### 3.4 `purpose` is optional

The shell supports `purpose?: FHIR.CodeableConcept`. Profiles can bind it to HL7 PurposeOfUse when that is useful, and that value set already includes categories such as patient request, family request, power of attorney, support network, public health, healthcare research, healthcare payment, claim attachment, treatment, and coordination of care. But the core model does not depend on PurposeOfUse being present or complete for every future use case. ([HL7 Terminology][7])

### 3.5 Access is the real semantics

`access.permissions` is the normative rights model. It supports:

* resource type,
* REST interactions,
* category filters,
* code filters,
* profile filters,
* arbitrary search-parameter filters,
* date limits,
* jurisdiction limits,
* source-organization limits,
* explicit operations.

This is the right level of abstraction because US Core already recommends least privilege and specifically calls out category-limited access such as vital signs only. ([FHIR Build][2])

### 3.6 Regrant is separate from delegation

A guardian or POA ticket may still forbid any child grant. Conversely, a self-access ticket may permit a new ticket bound to a different client key. So:

* `basis.kind = "delegation"` means authority is derivative,
* `regrant` means child-ticket issuance is allowed.

## 4. Proposed schema

Assumption: TypeScript interfaces like `FHIR.Patient`, `FHIR.Reference`, `FHIR.Consent`, etc. already exist.

```ts
export type Uri = string;
export type Instant = string;
export type NonEmptyArray<T> = [T, ...T[]];

/* =========================================================
 * JWT envelope
 * =======================================================*/

export type JwtAudience = string | NonEmptyArray<string>;

export interface TicketEnvelope {
  iss: Uri;
  aud: JwtAudience; // RFC 7519-compliant
  exp: number;
  jti: string;
  iat?: number;
  cnf?: {
    jkt: string;
  };
  revocation?: {
    url: Uri;
    rid: string;
  };

  /**
   * Present only on child tickets.
   * A child ticket is a new ticket, not an embedded ticket.
   */
  derivedFrom?: {
    parentJti: string;
    rootJti: string;
    depth: number;
  };
}

/* =========================================================
 * Subject
 *
 * Inline patient is always present.
 * recipientRecord is optional and only useful for direct/enumerated recipients.
 * =======================================================*/

export type PatientRecordReference = FHIR.Reference & {
  type?: "Patient";
};

export interface Subject {
  patient: FHIR.Patient;

  /**
   * Optional recipient-local locator.
   * May carry .reference, .identifier, or both.
   */
  recipientRecord?: PatientRecordReference;
}

/* =========================================================
 * Grantee
 * =======================================================*/

export type Grantee =
  | FHIR.RelatedPerson
  | FHIR.Practitioner
  | FHIR.PractitionerRole
  | FHIR.Organization;

/* =========================================================
 * Basis
 *
 * Why any access may exist at all.
 * =======================================================*/

export type BasisEvidence =
  | { kind: "consent"; resource: FHIR.Consent }
  | { kind: "document"; resource: FHIR.DocumentReference }
  | { kind: "other"; resource: FHIR.Resource };

export type DelegationType =
  | "parent-guardian"
  | "adult-healthcare-proxy"
  | "power-of-attorney"
  | "patient-designated-representative"
  | "support-person"
  | "other";

export interface SelfBasis {
  kind: "self";
}

export interface DelegationBasis {
  kind: "delegation";
  delegationType: DelegationType;
  verifiedAt?: Instant;
  verifiedBy?: FHIR.Organization | FHIR.Practitioner | FHIR.PractitionerRole;
  grantor?: FHIR.Patient | FHIR.RelatedPerson | FHIR.Organization;
  governingJurisdiction?: Array<Pick<FHIR.Address, "country" | "state">>;
  evidence?: BasisEvidence[];
}

export interface ConsentBasis {
  kind: "consent";
  consent: FHIR.Consent;
  verifiedAt?: Instant;
  evidence?: BasisEvidence[];
}

export interface MandateBasis {
  kind: "mandate";
  authority?: FHIR.CodeableConcept;
  issuingAuthority?: FHIR.Organization;
  evidence?: BasisEvidence[];
}

export interface CareRelationshipBasis {
  kind: "care-relationship";
  relationship?: FHIR.CodeableConcept[];
  establishedAt?: Instant;
  evidence?: BasisEvidence[];
}

export interface ContractBasis {
  kind: "contract";
  evidence?: BasisEvidence[];
}

export interface PolicyBasis {
  kind: "policy";
  evidence?: BasisEvidence[];
}

export type Basis =
  | SelfBasis
  | DelegationBasis
  | ConsentBasis
  | MandateBasis
  | CareRelationshipBasis
  | ContractBasis
  | PolicyBasis;

/* =========================================================
 * Optional purpose
 * =======================================================*/

export type Purpose = FHIR.CodeableConcept;

/* =========================================================
 * Access
 * =======================================================*/

export type RestInteraction =
  | "read"
  | "search"
  | "history"
  | "create"
  | "update"
  | "patch"
  | "delete";

export interface SearchFilter {
  name: string;
  value: string;
}

export interface OrganizationSelector {
  identifier: NonEmptyArray<FHIR.Identifier>;
  name?: string;
}

export interface DataPermission {
  kind: "data";
  resourceType: string;
  interactions: NonEmptyArray<RestInteraction>;

  /**
   * AND across populated groups, OR within each group.
   */
  categoryAnyOf?: NonEmptyArray<FHIR.Coding>;
  codeAnyOf?: NonEmptyArray<FHIR.Coding>;
  profileAnyOf?: NonEmptyArray<Uri>;
  searchFilters?: NonEmptyArray<SearchFilter>;

  dataPeriods?: NonEmptyArray<FHIR.Period>;
  dataJurisdictions?: NonEmptyArray<Pick<FHIR.Address, "country" | "state">>;
  sourceOrganizations?: NonEmptyArray<OrganizationSelector>;
}

export type OperationTarget =
  | { kind: "system" }
  | { kind: "type"; resourceType: string }
  | { kind: "instance"; resourceType: string; id: string; baseUrl?: Uri }
  | { kind: "absolute"; absoluteUrl: Uri };

export interface OperationPermission {
  kind: "operation";
  name: string; // e.g. "$everything"
  target?: OperationTarget;
}

export type PermissionRule = DataPermission | OperationPermission;

export interface AccessGrant {
  permissions: NonEmptyArray<PermissionRule>;
}

/* =========================================================
 * Regrant
 *
 * Core spec supports only issuer-mediated child tickets.
 * =======================================================*/

export interface NoRegrant {
  mode: "none";
}

export interface IssuerMediatedRegrant {
  mode: "issuer-mediated";
  variant: "holder-rebind" | "subdelegate";
  maxDepth: number;
  attenuateOnly: true;
  allowedGranteeKinds?: Array<Grantee["resourceType"]>;
}

export type Regrant = NoRegrant | IssuerMediatedRegrant;

/* =========================================================
 * Closed workflow context union
 * =======================================================*/

export interface PatientAccessContext {
  kind: "patient-access";
}

export interface PublicHealthContext {
  kind: "public-health";
  reportableCondition: FHIR.CodeableConcept;
  investigationCase?: {
    identifier: FHIR.Identifier;
    openedAt?: Instant;
  };
  triggeringCondition?: FHIR.Condition;
  triggeringObservation?: FHIR.Observation;
  triggeringDiagnosticReport?: FHIR.DiagnosticReport;
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

/* =========================================================
 * Generic base
 * =======================================================*/

export interface TicketBase<
  TType extends string,
  TGrantee extends Grantee | undefined,
  TBasis extends Basis,
  TContext extends TicketContext
> extends TicketEnvelope {
  ticket_type: TType;
  subject: Subject;
  grantee?: TGrantee;
  basis: TBasis;
  purpose?: Purpose;
  access: AccessGrant;
  context: TContext;
  regrant?: Regrant;
}

/* =========================================================
 * Concrete ticket families
 * =======================================================*/

export interface SelfAccessTicket
  extends TicketBase<
    "patient-self-access",
    undefined,
    SelfBasis,
    PatientAccessContext
  > {
  grantee?: never;
  basis: SelfBasis;
  context: PatientAccessContext;
  regrant?: NoRegrant | IssuerMediatedRegrant;
}

export interface DelegatedPatientAccessTicket
  extends TicketBase<
    "delegated-patient-access",
    FHIR.RelatedPerson,
    DelegationBasis,
    PatientAccessContext
  > {
  grantee: FHIR.RelatedPerson;
  basis: DelegationBasis;
  context: PatientAccessContext;
  regrant?: NoRegrant | IssuerMediatedRegrant;
}

export interface PublicHealthTicket
  extends TicketBase<
    "public-health",
    FHIR.Organization,
    MandateBasis | PolicyBasis,
    PublicHealthContext
  > {
  grantee: FHIR.Organization;
  basis: MandateBasis | PolicyBasis;
  context: PublicHealthContext;
  regrant?: NoRegrant;
}

export interface SocialCareReferralTicket
  extends TicketBase<
    "social-care-referral",
    FHIR.PractitionerRole | FHIR.Organization,
    CareRelationshipBasis | ConsentBasis | PolicyBasis,
    SocialCareReferralContext
  > {
  grantee: FHIR.PractitionerRole | FHIR.Organization;
  basis: CareRelationshipBasis | ConsentBasis | PolicyBasis;
  context: SocialCareReferralContext;
  regrant?: NoRegrant | IssuerMediatedRegrant;
}

export interface PayerClaimsTicket
  extends TicketBase<
    "payer-claims",
    FHIR.Organization,
    ContractBasis | PolicyBasis,
    PayerClaimsContext
  > {
  grantee: FHIR.Organization;
  basis: ContractBasis | PolicyBasis;
  context: PayerClaimsContext;
  regrant?: NoRegrant;
}

export interface ResearchTicket
  extends TicketBase<
    "research",
    FHIR.Organization | FHIR.PractitionerRole,
    ConsentBasis | PolicyBasis,
    ResearchContext
  > {
  grantee: FHIR.Organization | FHIR.PractitionerRole;
  basis: ConsentBasis | PolicyBasis;
  context: ResearchContext;
  regrant?: NoRegrant | IssuerMediatedRegrant;
}

export interface ProviderConsultTicket
  extends TicketBase<
    "provider-consult",
    FHIR.Practitioner | FHIR.PractitionerRole,
    CareRelationshipBasis | PolicyBasis,
    ProviderConsultContext
  > {
  grantee: FHIR.Practitioner | FHIR.PractitionerRole;
  basis: CareRelationshipBasis | PolicyBasis;
  context: ProviderConsultContext;
  regrant?: NoRegrant | IssuerMediatedRegrant;
}

export type PermissionTicket =
  | SelfAccessTicket
  | DelegatedPatientAccessTicket
  | PublicHealthTicket
  | SocialCareReferralTicket
  | PayerClaimsTicket
  | ResearchTicket
  | ProviderConsultTicket;
```

## 5. Semantics and validation rules

### 5.1 Subject

`subject.patient` is always required.

The ticket profile, not TypeScript, defines what counts as “sufficient identifying content.” In most profiles, at least one stable identifier SHOULD be present when available; otherwise enough demographics should be present for the intended matching process.

`subject.recipientRecord` is optional. It is a constrained `FHIR.Reference` to a `Patient` and can carry:

* `.reference` for relative or absolute instance location,
* `.identifier` for target-site MRN or similar,
* `.display` if needed,
* `.type = "Patient"` if populated.

FHIR explicitly allows `Reference` to contain a literal reference, a logical identifier, and display text, and says the identifier form is used when the target cannot be directly referenced. ([FHIR Build][5])

`recipientRecord` is only appropriate when `aud` identifies a known direct recipient or enumerated recipients, not a network-wide audience.

### 5.2 Basis vs context

A good test is:

* if you removed `context`, would `basis` still explain why access is legitimate?
* if you removed `basis`, would `context` merely tell you what this is about, but not justify access?

That is the intended line.

### 5.3 Access

For each `DataPermission`:

* populated filter groups are combined with AND,
* values within each `*AnyOf` field are OR,
* `searchFilters` represent additional query-style narrowing.

This is intentionally similar in spirit to current granular SMART practice, where category-constrained access is meaningful authorization shape, not merely a UI convenience. US Core explicitly recommends least privilege and gives vital-sign-only access as an example. ([FHIR Build][2])

For operations:

* `OperationPermission` explicitly authorizes an operation name and optional target.
* Read-only operations SHOULD still be bounded by the ticket’s data permissions by recipient policy.
* Write or non-read-like operations require their own explicit permission.

## 6. Regrant model

This proposal keeps regrant, but in a narrow and concrete form.

### 6.1 Regrant means new child tickets, not embedded tickets

A parent ticket can say child issuance is allowed via `regrant`. But the child is always a **new top-level ticket** with its own:

* `jti`
* `exp`
* `cnf` if bound
* `aud`
* optional `revocation`
* optional `derivedFrom`

The child is **not** embedded inside the parent.

That choice is deliberate. New tickets are cleaner because they keep ordinary JWT validation, avoid nested signature processing, allow independent expiry and revocation, and fit naturally into token exchange: the child is just another `subject_token` presented later. RFC 8693 already supports exchanging one security token for another, and it allows different token representations in the response. ([RFC Editor][4])

### 6.2 Issuer-mediated only in the base spec

The base proposal does **not** allow holder-self-minted child tickets.

Why:

* the artifact is supposed to be issuer-signed,
* self-minting would push the design toward capability chains and new trust semantics,
* issuer-mediated child issuance is much simpler and keeps the trust model stable.

So `regrant.mode = "issuer-mediated"` means:

1. the holder presents the parent ticket to the trusted issuer through some issuer-managed flow,
2. the issuer verifies the parent ticket and requested attenuation,
3. the issuer mints a child ticket.

The issuer-side protocol for requesting a child is out of scope. The artifact model is in scope.

### 6.3 Child lineage

If a ticket is derived from another ticket, it carries:

```ts
derivedFrom: {
  parentJti: string;
  rootJti: string;
  depth: number;
}
```

This is enough for audit and lineage without requiring the recipient to fetch the parent.

### 6.4 Child subset rules

If `attenuateOnly = true`, a child ticket MUST NOT broaden the parent. At minimum:

* child `exp` ≤ parent `exp`
* child `aud` = same or narrower
* child `access` = same or narrower
* child `purpose` = same or narrower if profile uses purpose narrowing
* child `grantee`:

  * same grantee for `holder-rebind`
  * same or profile-allowed new grantee for `subdelegate`
* child `derivedFrom.depth` = parent depth + 1
* child depth ≤ `regrant.maxDepth`

### 6.5 Regrant examples

Parent ticket allows rebinding:

```ts
regrant: {
  mode: "issuer-mediated",
  variant: "holder-rebind",
  maxDepth: 1,
  attenuateOnly: true
}
```

Parent ticket allows subdelegation to another grantee kind:

```ts
regrant: {
  mode: "issuer-mediated",
  variant: "subdelegate",
  maxDepth: 1,
  attenuateOnly: true,
  allowedGranteeKinds: ["RelatedPerson", "Organization"]
}
```

Child ticket lineage:

```ts
derivedFrom: {
  parentJti: "parent-123",
  rootJti: "root-001",
  depth: 1
}
```

## 7. Use-case-specific examples

The example codes below use familiar HL7 and US Core code systems where helpful, but they are illustrative.

### 7.1 Self-access

```ts
const selfAccess: SelfAccessTicket = {
  iss: "https://wallet.example",
  aud: "https://network.example",
  exp: 1774630337,
  jti: "self-001",
  ticket_type: "patient-self-access",
  subject: {
    patient: {
      resourceType: "Patient",
      identifier: [
        { system: "https://national-mpi.example", value: "pt-001" }
      ],
      name: [{ family: "Smith", given: ["John"] }],
      birthDate: "1980-01-01"
    }
  },
  basis: { kind: "self" },
  purpose: {
    coding: [
      {
        system: "http://terminology.hl7.org/CodeSystem/v3-ActReason",
        code: "PATRQT",
        display: "patient requested"
      }
    ]
  },
  access: {
    permissions: [
      {
        kind: "data",
        resourceType: "Observation",
        interactions: ["read", "search"],
        categoryAnyOf: [
          {
            system: "http://terminology.hl7.org/CodeSystem/observation-category",
            code: "vital-signs"
          },
          {
            system: "http://terminology.hl7.org/CodeSystem/observation-category",
            code: "social-history"
          }
        ]
      }
    ]
  },
  context: { kind: "patient-access" },
  regrant: { mode: "none" }
};
```

This is self access with category-limited Observation rights.

### 7.2 Delegated patient access: parent or guardian, partial

```ts
const parentGuardian: DelegatedPatientAccessTicket = {
  iss: "https://issuer.example",
  aud: "https://network.example",
  exp: 1774630337,
  jti: "delegation-parent-001",
  ticket_type: "delegated-patient-access",
  subject: {
    patient: {
      resourceType: "Patient",
      identifier: [
        { system: "https://national-mpi.example", value: "child-123" }
      ],
      name: [{ family: "Smith", given: ["Emily"] }],
      birthDate: "2012-04-11"
    }
  },
  grantee: {
    resourceType: "RelatedPerson",
    identifier: [
      { system: "https://issuer.example/related", value: "rp-1" }
    ],
    name: [{ family: "Smith", given: ["Maria"] }],
    relationship: [
      {
        coding: [
          {
            system: "http://terminology.hl7.org/CodeSystem/v3-RoleCode",
            code: "MTH"
          }
        ]
      }
    ]
  },
  basis: {
    kind: "delegation",
    delegationType: "parent-guardian",
    verifiedAt: "2026-03-06T15:04:05Z",
    evidence: [
      {
        kind: "document",
        resource: {
          resourceType: "DocumentReference",
          identifier: [
            { system: "https://issuer.example/docs", value: "guardian-1" }
          ],
          description: "Guardian verification packet"
        }
      }
    ]
  },
  purpose: {
    coding: [
      {
        system: "http://terminology.hl7.org/CodeSystem/v3-ActReason",
        code: "FAMRQT"
      }
    ]
  },
  access: {
    permissions: [
      { kind: "data", resourceType: "Immunization", interactions: ["read", "search"] },
      {
        kind: "data",
        resourceType: "Observation",
        interactions: ["read", "search"],
        categoryAnyOf: [
          {
            system: "http://terminology.hl7.org/CodeSystem/observation-category",
            code: "vital-signs"
          }
        ]
      },
      { kind: "data", resourceType: "MedicationRequest", interactions: ["read", "search"] }
    ]
  },
  context: { kind: "patient-access" },
  regrant: { mode: "none" }
};
```

This is partial delegation because the access envelope is partial. No additional “partial” flag is needed.

### 7.3 Delegated patient access: adult healthcare proxy / POA

```ts
const poa: DelegatedPatientAccessTicket = {
  iss: "https://issuer.example",
  aud: "https://network.example",
  exp: 1774630337,
  jti: "delegation-poa-001",
  ticket_type: "delegated-patient-access",
  subject: {
    patient: {
      resourceType: "Patient",
      identifier: [
        { system: "https://national-mpi.example", value: "adult-555" }
      ],
      name: [{ family: "Garcia", given: ["Ruth"] }],
      birthDate: "1948-09-12"
    }
  },
  grantee: {
    resourceType: "RelatedPerson",
    identifier: [
      { system: "https://issuer.example/related", value: "rp-500" }
    ],
    name: [{ family: "Garcia", given: ["Ana"] }]
  },
  basis: {
    kind: "delegation",
    delegationType: "power-of-attorney",
    verifiedAt: "2026-03-01T12:00:00Z",
    evidence: [
      {
        kind: "document",
        resource: {
          resourceType: "DocumentReference",
          identifier: [
            { system: "https://issuer.example/docs", value: "poa-777" }
          ],
          description: "Durable healthcare POA"
        }
      }
    ]
  },
  purpose: {
    coding: [
      {
        system: "http://terminology.hl7.org/CodeSystem/v3-ActReason",
        code: "PWATRNY"
      }
    ]
  },
  access: {
    permissions: [
      { kind: "data", resourceType: "AllergyIntolerance", interactions: ["read", "search"] },
      { kind: "data", resourceType: "Condition", interactions: ["read", "search"] },
      { kind: "data", resourceType: "Encounter", interactions: ["read", "search"] },
      { kind: "data", resourceType: "MedicationRequest", interactions: ["read", "search"] },
      { kind: "data", resourceType: "Observation", interactions: ["read", "search"] },
      { kind: "data", resourceType: "Procedure", interactions: ["read", "search"] },
      { kind: "data", resourceType: "DocumentReference", interactions: ["read", "search"] }
    ]
  },
  context: { kind: "patient-access" },
  regrant: {
    mode: "issuer-mediated",
    variant: "holder-rebind",
    maxDepth: 1,
    attenuateOnly: true
  }
};
```

This is broader delegated access, but still modeled the same way. The only meaningful difference is the access envelope and evidence.

### 7.4 Delegated patient access: support person

```ts
const supportPerson: DelegatedPatientAccessTicket = {
  iss: "https://issuer.example",
  aud: "https://network.example",
  exp: 1774630337,
  jti: "delegation-support-001",
  ticket_type: "delegated-patient-access",
  subject: {
    patient: {
      resourceType: "Patient",
      identifier: [
        { system: "https://national-mpi.example", value: "pt-900" }
      ],
      name: [{ family: "Wong", given: ["Lina"] }]
    }
  },
  grantee: {
    resourceType: "RelatedPerson",
    name: [{ family: "Wong", given: ["David"] }]
  },
  basis: {
    kind: "delegation",
    delegationType: "support-person",
    verifiedAt: "2026-03-10T09:00:00Z"
  },
  purpose: {
    coding: [
      {
        system: "http://terminology.hl7.org/CodeSystem/v3-ActReason",
        code: "SUPNWK"
      }
    ]
  },
  access: {
    permissions: [
      {
        kind: "data",
        resourceType: "Appointment",
        interactions: ["read", "search"]
      },
      {
        kind: "data",
        resourceType: "CarePlan",
        interactions: ["read", "search"]
      }
    ]
  },
  context: { kind: "patient-access" },
  regrant: { mode: "none" }
};
```

This is a narrow non-POA delegation with a different purpose code and much narrower rights.

### 7.5 Public health

This is where an optional recipient-local patient binding is most useful.

```ts
const publicHealth: PublicHealthTicket = {
  iss: "https://hospital-a.example",
  aud: "https://hospital-a.example",
  exp: 1774630337,
  jti: "ph-001",
  ticket_type: "public-health",
  subject: {
    patient: {
      resourceType: "Patient",
      identifier: [
        { system: "https://hospital-a.example/mrn", value: "MRN-123" }
      ],
      name: [{ family: "Jones", given: ["Chris"] }],
      birthDate: "1990-02-10"
    },
    recipientRecord: {
      type: "Patient",
      reference: "Patient/123",
      identifier: {
        system: "https://hospital-a.example/mrn",
        value: "MRN-123"
      }
    }
  },
  grantee: {
    resourceType: "Organization",
    identifier: [
      { system: "urn:ietf:rfc:3986", value: "https://doh.state.gov" }
    ],
    name: "State Department of Health"
  },
  basis: {
    kind: "mandate",
    authority: {
      text: "Reportable condition investigation authority"
    }
  },
  purpose: {
    coding: [
      {
        system: "http://terminology.hl7.org/CodeSystem/v3-ActReason",
        code: "PUBHLTH"
      }
    ]
  },
  access: {
    permissions: [
      { kind: "data", resourceType: "Condition", interactions: ["read", "search"] },
      { kind: "data", resourceType: "Observation", interactions: ["read", "search"] },
      { kind: "data", resourceType: "DiagnosticReport", interactions: ["read", "search"] },
      {
        kind: "operation",
        name: "$everything",
        target: { kind: "instance", resourceType: "Patient", id: "123" }
      }
    ]
  },
  context: {
    kind: "public-health",
    reportableCondition: {
      coding: [
        {
          system: "http://snomed.info/sct",
          code: "56717001",
          display: "Tuberculosis"
        }
      ]
    },
    investigationCase: {
      identifier: {
        system: "https://doh.state.gov/cases",
        value: "CASE-2026-999"
      }
    },
    triggeringDiagnosticReport: {
      resourceType: "DiagnosticReport",
      conclusion: "Positive tuberculosis test"
    },
    sourceReport: {
      resourceType: "DocumentReference",
      identifier: [
        { system: "https://hospital-a.example/ecr", value: "ECR-2026-1023" }
      ],
      description: "eCR submission packet"
    }
  },
  regrant: { mode: "none" }
};
```

This is the “authorization-code-like artifact” case: the ticket is bound to a particular patient record at a known recipient, and the workflow facts live entirely in `context`.

### 7.6 Social care referral

```ts
const socialCare: SocialCareReferralTicket = {
  iss: "https://referring-ehr.example",
  aud: "https://referring-ehr.example",
  exp: 1774630337,
  jti: "sc-001",
  ticket_type: "social-care-referral",
  subject: {
    patient: {
      resourceType: "Patient",
      identifier: [
        { system: "https://referring-ehr.example/mrn", value: "MRN-222" }
      ]
    },
    recipientRecord: {
      type: "Patient",
      reference: "Patient/222"
    }
  },
  grantee: {
    resourceType: "PractitionerRole",
    practitioner: {
      resourceType: "Practitioner",
      name: [{ family: "Volunteer", given: ["Alice"] }]
    },
    organization: {
      resourceType: "Organization",
      name: "Downtown Food Bank"
    }
  },
  basis: {
    kind: "care-relationship",
    relationship: [{ text: "referral recipient" }]
  },
  access: {
    permissions: [
      {
        kind: "data",
        resourceType: "ServiceRequest",
        interactions: ["read", "search", "update", "patch"]
      },
      {
        kind: "data",
        resourceType: "Task",
        interactions: ["read", "search", "update", "patch"]
      }
    ]
  },
  context: {
    kind: "social-care-referral",
    concern: {
      coding: [
        {
          system: "http://snomed.info/sct",
          code: "733423003",
          display: "Food insecurity"
        }
      ]
    },
    referral: {
      resourceType: "ServiceRequest",
      identifier: [
        { system: "https://referring-ehr.example/referrals", value: "REF-555" }
      ],
      status: "active",
      intent: "order"
    }
  },
  regrant: { mode: "none" }
};
```

This example shows why explicit write interactions belong in the access model.

### 7.7 Payer claims

```ts
const payerClaims: PayerClaimsTicket = {
  iss: "https://provider.example",
  aud: "https://provider.example",
  exp: 1774630337,
  jti: "payer-001",
  ticket_type: "payer-claims",
  subject: {
    patient: {
      resourceType: "Patient",
      identifier: [
        { system: "https://provider.example/mrn", value: "MRN-456" }
      ]
    },
    recipientRecord: {
      type: "Patient",
      reference: "Patient/456"
    }
  },
  grantee: {
    resourceType: "Organization",
    identifier: [
      { system: "http://hl7.org/fhir/sid/us-npi", value: "9876543210" }
    ],
    name: "Blue Payer Inc"
  },
  basis: {
    kind: "contract"
  },
  purpose: {
    coding: [
      {
        system: "http://terminology.hl7.org/CodeSystem/v3-ActReason",
        code: "CLMATTCH"
      }
    ]
  },
  access: {
    permissions: [
      { kind: "data", resourceType: "Procedure", interactions: ["read", "search"] },
      {
        kind: "data",
        resourceType: "DocumentReference",
        interactions: ["read", "search"],
        categoryAnyOf: [
          {
            system: "http://hl7.org/fhir/us/core/CodeSystem/us-core-documentreference-category",
            code: "clinical-note"
          }
        ]
      }
    ]
  },
  context: {
    kind: "payer-claims",
    service: {
      coding: [
        {
          system: "http://snomed.info/sct",
          code: "80146002",
          display: "Appendectomy"
        }
      ]
    },
    claim: {
      resourceType: "Claim",
      identifier: [
        { system: "https://payer.example/claims", value: "CLAIM-2026-XYZ" }
      ],
      status: "active"
    }
  },
  regrant: { mode: "none" }
};
```

### 7.8 Research

```ts
const research: ResearchTicket = {
  iss: "https://consent-platform.example",
  aud: "https://hospital.example",
  exp: 1774630337,
  jti: "research-001",
  ticket_type: "research",
  subject: {
    patient: {
      resourceType: "Patient",
      identifier: [
        { system: "https://hospital.example/mrn", value: "MRN-123" }
      ],
      name: [{ family: "Lee", given: ["Pat"] }]
    }
  },
  grantee: {
    resourceType: "Organization",
    identifier: [
      { system: "https://research.example/orgs", value: "org-77" }
    ],
    name: "Oncology Research Institute"
  },
  basis: {
    kind: "consent",
    consent: {
      resourceType: "Consent",
      identifier: [
        { system: "https://consent.example", value: "CONSENT-777" }
      ],
      status: "active"
    }
  },
  purpose: {
    coding: [
      {
        system: "http://terminology.hl7.org/CodeSystem/v3-ActReason",
        code: "HRESCH"
      }
    ]
  },
  access: {
    permissions: [
      { kind: "data", resourceType: "Condition", interactions: ["read", "search"] },
      {
        kind: "data",
        resourceType: "Observation",
        interactions: ["read", "search"],
        categoryAnyOf: [
          {
            system: "http://terminology.hl7.org/CodeSystem/observation-category",
            code: "laboratory"
          }
        ]
      },
      { kind: "data", resourceType: "DocumentReference", interactions: ["read", "search"] }
    ]
  },
  context: {
    kind: "research",
    study: {
      resourceType: "ResearchStudy",
      identifier: [
        { system: "https://clinicaltrials.gov", value: "NCT-12345" }
      ],
      title: "Lung cancer immunotherapy trial"
    },
    researchSubject: {
      resourceType: "ResearchSubject",
      identifier: [
        { system: "https://research.example/subjects", value: "SUBJ-9981" }
      ],
      status: "on-study"
    },
    condition: {
      coding: [
        {
          system: "http://snomed.info/sct",
          code: "363358000",
          display: "Malignant tumor of lung"
        }
      ]
    }
  },
  regrant: { mode: "none" }
};
```

This keeps the patient as the record subject, while study-side identity lives in `context`.

### 7.9 Provider consult

```ts
const consult: ProviderConsultTicket = {
  iss: "https://referring-ehr.example",
  aud: "https://referring-ehr.example",
  exp: 1774630337,
  jti: "consult-001",
  ticket_type: "provider-consult",
  subject: {
    patient: {
      resourceType: "Patient",
      identifier: [
        { system: "https://referring-ehr.example/mrn", value: "MRN-999" }
      ]
    },
    recipientRecord: {
      type: "Patient",
      reference: "Patient/999"
    }
  },
  grantee: {
    resourceType: "Practitioner",
    identifier: [
      { system: "http://hl7.org/fhir/sid/us-npi", value: "1112223333" }
    ],
    name: [{ family: "Heart", given: ["A."] }]
  },
  basis: {
    kind: "care-relationship",
    relationship: [{ text: "specialist consult" }]
  },
  purpose: {
    coding: [
      {
        system: "http://terminology.hl7.org/CodeSystem/v3-ActReason",
        code: "COC"
      }
    ]
  },
  access: {
    permissions: [
      { kind: "data", resourceType: "Condition", interactions: ["read", "search"] },
      { kind: "data", resourceType: "MedicationRequest", interactions: ["read", "search"] },
      { kind: "data", resourceType: "Procedure", interactions: ["read", "search"] },
      { kind: "data", resourceType: "DiagnosticReport", interactions: ["read", "search"] }
    ]
  },
  context: {
    kind: "provider-consult",
    reason: {
      coding: [
        {
          system: "http://snomed.info/sct",
          code: "49436004",
          display: "Atrial fibrillation"
        }
      ]
    },
    consultRequest: {
      resourceType: "ServiceRequest",
      identifier: [
        { system: "https://referring-ehr.example/requests", value: "ref-req-111" }
      ],
      status: "active",
      intent: "order"
    }
  },
  regrant: { mode: "none" }
};
```

## 10. Why this shape is cleaner

This version removes the confusing parts you objected to:

* no object-shaped `aud`,
* no separate `resolveBy`,
* no fake selector properties inside `Patient`,
* no generic `details` bag,
* no `artifacts[]` abstraction,
* no over-modeled contract subfields in the common shell,
* no operation subtyping that tries to encode read-derived semantics in TypeScript.

What remains is a small shell with a clear split:

* `subject`: who the record is about
* `grantee`: who the grant is for
* `basis`: why the grant exists
* `purpose?`: optional coarse use category
* `access`: what is allowed
* `context`: what this ticket is about
* `regrant`: whether issuer-mediated child tickets are allowed

That is enough to model self access, full and partial delegation, public health, social care, payer, research, and provider consult without turning the shell into a grand ontology.

The most important future-proofing choices are:

* use `FHIR.Reference` for recipient-local record binding, because it already supports both direct references and logical identifiers, including the case where no direct server dereference exists, and
* make regrant child-ticket based, not embedded-ticket based, because child tickets fit ordinary JWT validation and ordinary token exchange. ([FHIR Build][5])

The next natural step would be to turn this into either:

* normative validation invariants,
* JSON Schema,
* or a FHIR logical model / StructureDefinition for the ticket payload.

[1]: https://www.rfc-editor.org/rfc/rfc7519.html "https://www.rfc-editor.org/rfc/rfc7519.html"
[2]: https://build.fhir.org/ig/HL7/US-Core//scopes.html "https://build.fhir.org/ig/HL7/US-Core//scopes.html"
[3]: https://build.fhir.org/consent.html "https://build.fhir.org/consent.html"
[4]: https://www.rfc-editor.org/rfc/rfc8693.html "https://www.rfc-editor.org/rfc/rfc8693.html"
[5]: https://build.fhir.org/references.html "https://build.fhir.org/references.html"
[6]: https://build.fhir.org/consent-definitions.html "https://build.fhir.org/consent-definitions.html"
[7]: https://terminology.hl7.org/7.0.0/ValueSet-v3-PurposeOfUse.html "https://terminology.hl7.org/7.0.0/ValueSet-v3-PurposeOfUse.html"

