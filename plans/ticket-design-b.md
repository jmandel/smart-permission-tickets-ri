Below is a full replacement proposal for a simplified Permission Ticket shell.

It assumes the ticket is a JWT artifact redeemed through OAuth 2.0 Token Exchange as a `subject_token`, but it keeps the shell focused on portable authority and access semantics rather than on transport details. RFC 8693 is still the right transport envelope, and JWT still gives the right registered claims for issuer, audience, expiry, and ticket ID. ([RFC Editor][1])

## 1. Intent

Define a single-ticket artifact that can represent self-access, delegated access, public health, social care, payer, research, and provider consult without making the common shell itself into a complicated ontology. The ticket should be portable across recipients, explicit enough for token-exchange validation, able to express fine-grained data rights and operations, and able to restrict which client may redeem it either by key or by trust-framework identity. ([RFC Editor][1])

## 2. Goals

The design goals are:

* keep the common shell small,
* keep all necessary patient and evidence facts inline,
* make `aud` standard JWT,
* make access the primary semantic model,
* keep delegation as one kind of authority rather than the organizing concept for everything,
* support a simple sensitive-data switch,
* support either key binding or trust-framework client-identity binding,
* if regrant exists, make it issuer-mediated child tickets only.

Those are design choices, not requirements inherited from a standard.

## 3. Design principles

### 3.1 Keep `aud` standard

The ticket uses the JWT `aud` claim exactly as JWT defines it: a single string or an array of strings. JWT leaves the interpretation of audience values application-specific, and related JWT profiles also treat audience identifiers as capable of identifying a single entity, a group of entities, or a common policy context. That makes it reasonable for a profile to use a network URI as a valid audience identifier, as long as the recipient knows how to validate membership in that network. ([RFC Editor][2])

### 3.2 Keep `subject` simple

`subject` always contains an inline `FHIR.Patient`. It may also include an optional recipient-local `FHIR.Reference` to the patient record at the intended recipient. FHIR `Reference` already supports a literal reference, an identifier, or both, and when both are present the literal reference is preferred. That makes `Reference` the right shape for “full URL and/or target-site MRN” without inventing a new mini-type. ([FHIR Build][3])

### 3.3 Separate requester from presenter

The ticket distinguishes the **requester** from the **presenter**. The requester is the substantive party for whom the grant exists, such as a parent, proxy, health department, research organization, or consulting clinician. The presenter is the software client redeeming the ticket at the token endpoint. OAuth token exchange already distinguishes the software client authenticating to the token endpoint from the token being exchanged, so this split fits the transport model naturally. ([RFC Editor][1])

### 3.4 Keep authority minimal

The shell has a small `authority` object whose job is only to answer: “Why does any access exist at all?” Examples are `self`, `delegation`, `consent`, `mandate`, `relationship`, `contract`, and `policy`. Anything more specific than that belongs in the per-ticket-type `context`, not in the common shell. This is consistent with the way FHIR Consent and Permission separate policy/justification from the actual access-control rules. ([FHIR][4])

### 3.5 Let access carry the real semantics

The ticket’s primary authorization model is structured access, not a scope string. RAR already shows the value of structured objects with datatypes, actions, locations, identifiers, and product semantics across fields, and US Core’s SMART guidance explicitly recommends least privilege, including category-limited access such as “only vital-sign observations.” ([RFC Editor][5])

### 3.6 Sensitive-data handling should be coarse in the shell

The shell should not attempt to fully model the recipient’s sensitivity taxonomy. Instead it carries a coarse flag indicating whether the ticket permits sharing of recipient-classified sensitive data. The recipient determines what counts as sensitive using its own policy and security labels. In FHIR, security labels are specifically consumed by the access-control decision engine, and HL7 confidentiality labels such as `R` (Restricted) and `V` (Very Restricted) denote heightened protection; those protections may still be preempted by law, such as public health reporting. ([FHIR Build][6])

### 3.7 Support two presenter-binding families

The ticket can restrict redemption either to a client key or to a trust-framework client identity.

For key binding, the semantics are those of JWK-thumbprint confirmation: the ticket carries a `jkt`, and the redeemer must authenticate with the corresponding key. The `jkt` value is the base64url-encoded JWK SHA-256 thumbprint. ([RFC Editor][7])

For trust-framework identity binding, the ticket carries a framework descriptor and a framework-specific client identity. This proposal defines two framework flavors:

* **well-known**: client identity is a URL,
* **udap**: client identity is a SAN URI.

OpenID Federation uses URL-form Entity Identifiers and publishes configuration via `/.well-known/openid-federation`. UDAP, by contrast, uses URI identity bound to certificate SANs and validates that Subject DN and/or SAN values match the `client_id` according to the trust community’s certificate profile; UDAP certifications also explicitly bind the client’s unique identifying URI to `SAN:uniformResourceIdentifier`. ([OpenID Foundation][8])

### 3.8 Regrant, if supported, should be new child tickets

If the ticket permits regrant, that means the issuer may mint a new, narrower child ticket. It does **not** mean embedding a child ticket inside the parent, and it does **not** mean allowing the holder to self-mint. Token exchange already supports obtaining a new token from an existing one, and issued tokens need not be conventional access tokens. New top-level child tickets keep JWT validation, revocation, expiry, and audit lineage much simpler than embedded tickets. ([RFC Editor][1])

## 4. Proposed schema

Assumption: TypeScript interfaces such as `FHIR.Patient`, `FHIR.Reference`, `FHIR.Consent`, `FHIR.DocumentReference`, and the relevant datatypes already exist.

```ts
export type Uri = string;
export type Instant = string;
export type NonEmptyArray<T> = [T, ...T[]];

export type JwtAudience = string | NonEmptyArray<string>;

/* =========================================================
 * Envelope
 * =======================================================*/

export interface TicketEnvelope {
  iss: Uri;
  aud: JwtAudience;
  exp: number;
  jti: string;
  iat?: number;
  revocation?: {
    url: Uri;
    rid: string;
  };

  /**
   * Present only on child tickets.
   */
  derivedFrom?: {
    parentJti: string;
    rootJti: string;
    depth: number;
  };
}

/* =========================================================
 * Subject
 * =======================================================*/

export type PatientRecordReference = FHIR.Reference & {
  type?: "Patient";
};

export interface Subject {
  patient: FHIR.Patient;

  /**
   * Optional recipient-local locator.
   * May include .reference, .identifier, or both.
   */
  recipientRecord?: PatientRecordReference;
}

/* =========================================================
 * Requester
 * =======================================================*/

export type Requester =
  | FHIR.RelatedPerson
  | FHIR.Practitioner
  | FHIR.PractitionerRole
  | FHIR.Organization;

/* =========================================================
 * Authority
 * =======================================================*/

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
  code?: FHIR.CodeableConcept;
  evidence?: FHIR.Resource[];
}

/* =========================================================
 * Presenter binding
 * =======================================================*/

export interface KeyPresenterBinding {
  kind: "client-key";
  /**
   * Same semantics as cnf.jkt: base64url JWK SHA-256 thumbprint
   */
  jkt: string;
}

export interface WellKnownFramework {
  kind: "well-known";
  uri: Uri;
}

export interface UdapFramework {
  kind: "udap";
  uri: Uri;
}

export interface WellKnownFrameworkPresenterBinding {
  kind: "framework-client";
  framework: WellKnownFramework;
  /**
   * URL-form client identity within the framework.
   */
  clientUrl: Uri;
}

export interface UdapFrameworkPresenterBinding {
  kind: "framework-client";
  framework: UdapFramework;
  /**
   * URI-form client identity bound to SAN:uniformResourceIdentifier.
   */
  clientSanUri: Uri;
}

export type PresenterBinding =
  | KeyPresenterBinding
  | WellKnownFrameworkPresenterBinding
  | UdapFrameworkPresenterBinding;

/* =========================================================
 * Access
 * =======================================================*/

export type SensitiveDataPolicy = "exclude" | "include";

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

export interface OperationPermission {
  kind: "operation";
  name: string;                 // e.g. "$everything"
  resourceType?: string;        // omitted => system-level operation
  target?: FHIR.Reference;      // optional instance target
}

export type PermissionRule = DataPermission | OperationPermission;

export interface AccessGrant {
  /**
   * Coarse instruction on sensitive data.
   * The recipient decides what counts as sensitive.
   */
  sensitiveData: SensitiveDataPolicy;

  permissions: NonEmptyArray<PermissionRule>;
}

/* =========================================================
 * Regrant
 * =======================================================*/

export interface Regrant {
  /**
   * Child tickets only; never embedded tickets.
   * Children MUST be narrower than parents.
   */
  maxDepth: number;
  allowSubdelegation?: boolean;
}

/* =========================================================
 * Closed context union
 * =======================================================*/

export interface SelfAccessContext {
  kind: "self-access";
}

export interface DelegatedAccessContext {
  kind: "delegated-access";
  delegationType?: FHIR.CodeableConcept;   // guardian, POA, proxy, support person
  relationship?: FHIR.CodeableConcept[];
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
  | SelfAccessContext
  | DelegatedAccessContext
  | PublicHealthContext
  | SocialCareReferralContext
  | PayerClaimsContext
  | ResearchContext
  | ProviderConsultContext;

/* =========================================================
 * Base ticket
 * =======================================================*/

export interface PermissionTicketBase<
  TType extends string,
  TRequester extends Requester | undefined,
  TAuthority extends Authority,
  TContext extends TicketContext
> extends TicketEnvelope {
  ticket_type: TType;
  subject: Subject;
  requester?: TRequester;
  authority: TAuthority;
  presenterBinding?: PresenterBinding;
  access: AccessGrant;
  regrant?: Regrant;
  context: TContext;
}

/* =========================================================
 * Concrete ticket families
 * =======================================================*/

export interface SelfAccessTicket
  extends PermissionTicketBase<
    "patient-self-access",
    undefined,
    Authority & { kind: "self" },
    SelfAccessContext
  > {
  requester?: never;
}

export interface DelegatedPatientAccessTicket
  extends PermissionTicketBase<
    "delegated-patient-access",
    FHIR.RelatedPerson,
    Authority & { kind: "delegation" },
    DelegatedAccessContext
  > {
  requester: FHIR.RelatedPerson;
}

export interface PublicHealthTicket
  extends PermissionTicketBase<
    "public-health",
    FHIR.Organization,
    Authority & { kind: "mandate" | "policy" },
    PublicHealthContext
  > {
  requester: FHIR.Organization;
}

export interface SocialCareReferralTicket
  extends PermissionTicketBase<
    "social-care-referral",
    FHIR.PractitionerRole | FHIR.Organization,
    Authority & { kind: "relationship" | "consent" | "policy" },
    SocialCareReferralContext
  > {
  requester: FHIR.PractitionerRole | FHIR.Organization;
}

export interface PayerClaimsTicket
  extends PermissionTicketBase<
    "payer-claims",
    FHIR.Organization,
    Authority & { kind: "contract" | "policy" },
    PayerClaimsContext
  > {
  requester: FHIR.Organization;
}

export interface ResearchTicket
  extends PermissionTicketBase<
    "research",
    FHIR.Organization | FHIR.PractitionerRole,
    Authority & { kind: "consent" | "policy" },
    ResearchContext
  > {
  requester: FHIR.Organization | FHIR.PractitionerRole;
}

export interface ProviderConsultTicket
  extends PermissionTicketBase<
    "provider-consult",
    FHIR.Practitioner | FHIR.PractitionerRole,
    Authority & { kind: "relationship" | "policy" },
    ProviderConsultContext
  > {
  requester: FHIR.Practitioner | FHIR.PractitionerRole;
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

This schema deliberately keeps only one shared authority object, one shared access object, one optional presenter-binding object, one optional regrant object, and a closed `context` union. It reuses standard JWT `aud`, standard FHIR `Reference`, and the standard `jkt` thumbprint semantics rather than inventing bespoke substitutes. ([RFC Editor][2])

## 5. Processing rules

### 5.1 Envelope

`iss`, `aud`, `exp`, and `jti` are mandatory. `aud` is validated as JWT audience. A recipient MUST reject the ticket if it does not identify itself with a value in `aud`. Using a network URI as `aud` is allowed by this profile only when the recipient can prove membership in the named network or framework. `jti` is mandatory in this profile even though JWT makes it optional, because it is the stable handle for replay control, lineage, and revocation. ([RFC Editor][2])

### 5.2 Subject

`subject.patient` is always required. Profiles define what counts as sufficient identifying content; for portability, a stable identifier SHOULD be present when available, but a recipient may also match from other inline demographics if the profile permits. `subject.recipientRecord`, when present, is an optimization for direct or enumerated recipients and may carry a literal reference, a logical identifier, or both. When both are present, the literal reference is preferred. ([FHIR Build][3])

### 5.3 Requester

`requester` is absent for self-access. Otherwise it is the real-world party for whom the grant exists. This is distinct from the software client that presents the ticket at the token endpoint. SMART asymmetric client authentication still happens normally via `client_assertion`, where `iss` and `sub` are the client’s `client_id` and `aud` is the token URL. ([FHIR Build][9])

### 5.4 Authority

`authority.kind` is the coarse reason the ticket exists:

* `self`
* `delegation`
* `consent`
* `mandate`
* `policy`
* `relationship`
* `contract`

More specific semantics belong in `context`. `authority.evidence` can inline supporting `Consent`, `DocumentReference`, or other resources when useful. This keeps the shell small while still aligning with FHIR’s separation of policy basis and access rules. ([FHIR][4])

### 5.5 Access

`access.permissions` is the normative authorization surface. It supports resource type, REST interactions, category filters, code filters, profile filters, arbitrary search filters, date bounds, jurisdictions, source organizations, and explicit operations. Category filtering is especially important because US Core already recommends category-level least-privilege scopes such as Observation `vital-signs` or `social-history`; this design keeps that shape as structured access rather than reducing it to strings. ([FHIR Build][10])

Filter combination rules are:

* AND across populated filter groups,
* OR within each `*AnyOf` array.

### 5.6 Sensitive data

`access.sensitiveData` is required and has only two values:

* `exclude`
  The recipient MUST exclude data it classifies as sensitive or specially protected under its local law/policy/labeling regime. If the recipient cannot segment such data reliably, it SHOULD reject the ticket rather than silently over-share.

* `include`
  The ticket permits sharing of sensitive data, but only if the requester is otherwise entitled and local law/policy allows it. This does not override recipient-side protections.

FHIR security labels are designed to feed the access-control decision engine, and HL7 confidentiality labels such as `R` and `V` represent higher protection levels; those protections may still be preempted by law in some settings, such as public health reporting. ([FHIR Build][6])

### 5.7 Presenter binding

If `presenterBinding` is absent, the ticket is not bound to one particular presenter identity beyond ordinary client authentication and `aud`.

If `presenterBinding.kind = "client-key"`, the redeemer MUST authenticate with the bound key. The binding value is a JWK SHA-256 thumbprint and has the same semantics as `cnf.jkt`. ([RFC Editor][7])

If `presenterBinding.kind = "framework-client"` and `framework.kind = "well-known"`, the redeemer is identified by a URL-form client identity. This profile assumes a federation model in which the client URL is validated inside the framework rooted at `framework.uri`; OpenID Federation’s Entity Identifier and `/.well-known/openid-federation` discovery model are the motivating pattern here. This proposal intentionally binds to the URL-form framework identity, not to an arbitrary local alias. ([OpenID Foundation][8])

If `presenterBinding.kind = "framework-client"` and `framework.kind = "udap"`, the redeemer is identified by a SAN URI under the named UDAP framework. UDAP defines client URI identity bound to `SAN:uniformResourceIdentifier` and requires the authorization server to validate that the certificate Subject DN and/or SAN values match the values associated with the `client_id` under the trust community’s certificate profile. ([UDAP][11])

### 5.8 Regrant

If `regrant` is absent, no child ticket issuance is allowed.

If `regrant` is present:

* the only supported model is **issuer-mediated child tickets**,
* the child is a new top-level ticket, never an embedded ticket,
* the child carries `derivedFrom`,
* the child MUST be narrower than or equal to the parent,
* `derivedFrom.depth` MUST be within `regrant.maxDepth`,
* if `allowSubdelegation` is false or absent, a child may rebind the presenter but not change the requester,
* if `allowSubdelegation` is true, a child may change the requester only if the ticket type profile allows that requester class.

This design keeps lineage, revocation, and token-exchange behavior straightforward. RFC 8693 is already designed around exchanging one token for another, and the issued token need not be a conventional OAuth access token. ([RFC Editor][1])

## 6. Use-case examples

### 6.1 Patient self-access

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

  authority: { kind: "self" },

  presenterBinding: {
    kind: "client-key",
    jkt: "JuI6ibZHcMPQICaIZ55PbXpnsudQmKt00D0BiEXNrMc"
  },

  access: {
    sensitiveData: "include",
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

  context: { kind: "self-access" }
};
```

This is the simplest case: no separate requester, self authority, key-bound redemption, and category-limited read rights.

### 6.2 Delegated patient access: parent or guardian, partial

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

  requester: {
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

  authority: {
    kind: "delegation",
    evidence: [
      {
        resourceType: "DocumentReference",
        identifier: [
          { system: "https://issuer.example/docs", value: "guardian-1" }
        ],
        description: "Guardian verification packet"
      }
    ]
  },

  presenterBinding: {
    kind: "framework-client",
    framework: {
      kind: "well-known",
      uri: "https://trust-anchor.example"
    },
    clientUrl: "https://proxy-app.example"
  },

  access: {
    sensitiveData: "exclude",
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

  context: {
    kind: "delegated-access",
    delegationType: { text: "parent or guardian" },
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
  }
};
```

This is a partial delegation because the access envelope is partial. The shell does not need a separate `partial` flag.

### 6.3 Delegated patient access: adult healthcare proxy / POA, broader

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

  requester: {
    resourceType: "RelatedPerson",
    identifier: [
      { system: "https://issuer.example/related", value: "rp-500" }
    ],
    name: [{ family: "Garcia", given: ["Ana"] }]
  },

  authority: {
    kind: "delegation",
    evidence: [
      {
        resourceType: "DocumentReference",
        identifier: [
          { system: "https://issuer.example/docs", value: "poa-777" }
        ],
        description: "Durable healthcare POA"
      }
    ]
  },

  presenterBinding: {
    kind: "client-key",
    jkt: "0ZcOCORZNYy-DWpqq30jZyJGHTN0d2HglBV3uiguA4I"
  },

  access: {
    sensitiveData: "include",
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

  regrant: {
    maxDepth: 1
  },

  context: {
    kind: "delegated-access",
    delegationType: { text: "power of attorney" }
  }
};
```

This example permits broader access and allows one issuer-mediated regrant, for example to rebind the same proxy to a different client key.

### 6.4 Delegated patient access: support person, narrow

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

  requester: {
    resourceType: "RelatedPerson",
    name: [{ family: "Wong", given: ["David"] }]
  },

  authority: {
    kind: "delegation"
  },

  access: {
    sensitiveData: "exclude",
    permissions: [
      { kind: "data", resourceType: "Appointment", interactions: ["read", "search"] },
      { kind: "data", resourceType: "CarePlan", interactions: ["read", "search"] }
    ]
  },

  context: {
    kind: "delegated-access",
    delegationType: { text: "support person" }
  }
};
```

This is intentionally narrow. The distinction between support-person delegation and POA is mostly in `context` and `authority.evidence`, not in the shell.

### 6.5 Public health

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

  requester: {
    resourceType: "Organization",
    identifier: [
      { system: "urn:ietf:rfc:3986", value: "https://doh.state.gov" }
    ],
    name: "State Department of Health"
  },

  authority: {
    kind: "mandate",
    code: { text: "reportable condition investigation authority" }
  },

  presenterBinding: {
    kind: "framework-client",
    framework: {
      kind: "udap",
      uri: "https://udap-trust.example"
    },
    clientSanUri: "https://doh.state.gov/apps/case-investigator"
  },

  access: {
    sensitiveData: "include",
    permissions: [
      { kind: "data", resourceType: "Condition", interactions: ["read", "search"] },
      { kind: "data", resourceType: "Observation", interactions: ["read", "search"] },
      { kind: "data", resourceType: "DiagnosticReport", interactions: ["read", "search"] },
      {
        kind: "operation",
        name: "$everything",
        resourceType: "Patient",
        target: { type: "Patient", reference: "Patient/123" }
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
      system: "https://doh.state.gov/cases",
      value: "CASE-2026-999"
    },
    sourceReport: {
      resourceType: "DocumentReference",
      identifier: [
        { system: "https://hospital-a.example/ecr", value: "ECR-2026-1023" }
      ],
      description: "eCR submission packet"
    }
  }
};
```

This is the clearest example of recipient-local record binding plus framework-based presenter identity. `sensitiveData: "include"` does not override law; it simply says the ticket does not itself prohibit sensitive return when the mandate and local policy allow it.

### 6.6 Social care referral

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

  requester: {
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

  authority: {
    kind: "relationship"
  },

  access: {
    sensitiveData: "exclude",
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
  }
};
```

This example shows why explicit write interactions belong in `access`.

### 6.7 Payer claims adjudication

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

  requester: {
    resourceType: "Organization",
    identifier: [
      { system: "http://hl7.org/fhir/sid/us-npi", value: "9876543210" }
    ],
    name: "Blue Payer Inc"
  },

  authority: {
    kind: "contract"
  },

  access: {
    sensitiveData: "exclude",
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
  }
};
```

### 6.8 Research

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

  requester: {
    resourceType: "Organization",
    identifier: [
      { system: "https://research.example/orgs", value: "org-77" }
    ],
    name: "Oncology Research Institute"
  },

  authority: {
    kind: "consent",
    evidence: [
      {
        resourceType: "Consent",
        identifier: [
          { system: "https://consent.example", value: "CONSENT-777" }
        ],
        status: "active"
      }
    ]
  },

  access: {
    sensitiveData: "exclude",
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
  }
};
```

This keeps the patient as the record subject and study-side identity in `context`, which is cleaner than trying to make `ResearchSubject` the common-shell subject.

### 6.9 Provider consult

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

  requester: {
    resourceType: "Practitioner",
    identifier: [
      { system: "http://hl7.org/fhir/sid/us-npi", value: "1112223333" }
    ],
    name: [{ family: "Heart", given: ["A."] }]
  },

  authority: {
    kind: "relationship"
  },

  access: {
    sensitiveData: "include",
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
  }
};
```

## 7. Why this shell is smaller

The shell now has only these shared concepts:

* envelope
* subject
* requester
* authority
* presenterBinding
* access
* regrant
* context

That is intentionally much smaller than a model with purpose hierarchies, delegation subtypes in the shell, detailed contract submodels, focus/artifact bags, or multiple subject-resolution ontologies. The proposal still borrows heavily from FHIR and OAuth ideas where they are clearly useful — JWT audiences and IDs, FHIR Reference semantics, security labels, structured authorization, and token exchange — but it avoids turning the shell into a complicated theory of every healthcare access scenario. ([RFC Editor][2])

The practical editorial rule behind this proposal is simple: if a field is not needed by generic validators, generic access evaluators, or generic regrant logic, it belongs in `context`, not in the common shell.

If you want, I can turn this next into normative SHALL/SHOULD language and a validation section with explicit invariants.

[1]: https://www.rfc-editor.org/rfc/rfc8693.html?utm_source=chatgpt.com "RFC 8693: OAuth 2.0 Token Exchange"
[2]: https://www.rfc-editor.org/rfc/rfc7519.html "RFC 7519: JSON Web Token (JWT)"
[3]: https://build.fhir.org/references.html?utm_source=chatgpt.com "References - FHIR v6.0.0-ballot4"
[4]: https://fhir.hl7.org/fhir/permission.html "Permission - FHIR v5.0.0"
[5]: https://www.rfc-editor.org/rfc/rfc9396.pdf "RFC 9396: OAuth 2.0 Rich Authorization Requests"
[6]: https://build.fhir.org/security-labels.html "Security-labels - FHIR v6.0.0-ballot4"
[7]: https://www.rfc-editor.org/rfc/rfc9449.html?utm_source=chatgpt.com "OAuth 2.0 Demonstrating Proof of Possession (DPoP)"
[8]: https://openid.net/specs/openid-federation-1_0.html "OpenID Federation 1.0"
[9]: https://build.fhir.org/ig/HL7/smart-app-launch/client-confidential-asymmetric.html "Client Authentication: Asymmetric (public key) - SMART App Launch v2.2.0"
[10]: https://build.fhir.org/ig/HL7/US-Core//scopes.html?utm_source=chatgpt.com "SMART on FHIR Obligations and Capabilities - US Core ..."
[11]: https://www.udap.org/udap-certifications-and-endorsements.html "UDAP Certifications and Endorsements for Client Applications"

