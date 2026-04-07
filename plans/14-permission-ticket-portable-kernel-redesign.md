# Plan 14 (Updated): Permission Ticket Portable-Kernel Redesign

## Status

Design draft for review. This plan does **not** update `input/`. Its purpose is to lock the candidate model before translating it into spec text or implementation code.

## Why this plan exists

The earlier model drifted toward portable semantics that many recipients are unlikely to implement consistently. The updated direction is a **portable kernel**: only the signed fields that a recipient plausibly needs in order to say yes or no to a request should live in the common shell. JWT remains the artifact container, RFC 8693 token exchange remains the transport pattern, JWT `aud` remains a standard audience claim, and FHIR `Reference` remains the right shape when a ticket wants to carry a literal patient record reference and/or a target-site identifier.

## Bright-line modeling rule

A fact belongs in the signed portable kernel **only if** a conforming recipient would plausibly need that fact to get to yes or no.

A fact belongs in **ticket-type `context`** if every instance of that ticket type needs it to get to yes or no, but other ticket types do not.

A fact belongs in **`supporting_artifacts`** if it is useful for audit, UI, review, or additional verification but should not be required by the base protocol to approve or deny.

That means, for example:

* a signed POA document is usually a **supporting artifact**
* a full contract document is usually a **supporting artifact**
* detailed delegation limitations should usually be reflected in `access` and `exp`, not duplicated as prose-like legal structure
* if a ticket type truly needs a specific workflow fact such as a reportable condition, study, claim, or consult request, that fact belongs in `context`
* if a recipient wants to use more detail than the kernel contains, it may, but the base protocol should not require that detail

## Core decisions

### 1. Keep JWT and token exchange

* The ticket remains a JWT redeemed as an RFC 8693 `subject_token`.
* `aud` remains a standard JWT audience claim.
* `ticket_type` remains a URI.
* `jti` is required.

### 2. Keep `subject` portable and thin

* `subject.patient` is always present.
* It may be thin.
* `subject.recipient_record` is optional and is only a direct-recipient optimization.
* `recipient_record` uses `FHIR.Reference` so it can carry a literal `.reference`, a logical `.identifier`, or both.

### 3. Distinguish requester from presenter

* `requester` is the substantive human/organization on whose behalf access exists.
* `presenter` is the software client redeeming the ticket.
* The ticket models the requester.
* Presenter identity and binding are handled separately by client authentication plus `presenter_binding`.

### 4. No `authority` claim in the kernel

The earlier model had an `authority` object answering "why does any access exist at all?" In practice, the answer is already implied by `ticket_type` + the presence/type of `requester` + `context.kind`. A data holder processing a public-health ticket with an Organization requester already knows it's a mandate; a patient-access ticket with a RelatedPerson requester already knows it's delegated. A separate `authority.kind` label adds no information the data holder doesn't already have. If an issuer wants to label the legal basis for audit, it can use `supporting_artifacts`.

### 5. Make `access` the normative authorization model

`access.permissions` is the normative model. SMART scopes serve as a coarse request-time ceiling and issued-token projection over the permission model, not the core ticket semantics.

### 6. Keep portable filtering coarse and positive

The portable kernel should include:

* one coarse `data_period`
* coarse `jurisdictions`
* positive data-holder scoping by organizational identity
* one coarse `sensitive_data` switch

The portable kernel should **not** standardize:

* negative source exclusions
* facility/service-class exclusions
* arbitrary search filters
* recipient-specific sensitive-source taxonomies

### 7. Unify presenter binding but keep the semantics independent

`presenter_binding` is one container with two independent sub-bindings:

* exact key binding (`presenter_binding.key.jkt`)
* trust-framework client identity binding (`presenter_binding.framework_client`)

Either may appear alone, or both may appear together.

**Note on `cnf`:** Standard JWT confirmation uses the `cnf` claim (RFC 7800). This plan wraps key binding inside `presenter_binding.key` instead, co-locating it with framework binding so that all presenter-binding semantics live in one container. The semantics are identical to `cnf.jkt`; only the claim path differs.

For the framework binding, this plan keeps two flavors:

* `well-known`: entity identity is a URL-form client identity
* `udap`: entity identity is a SAN URI

### 8. Use `must_understand` for extensibility

All fields defined in the base kernel are must-understand when present. If a recipient encounters a kernel field it cannot enforce, it SHALL reject the ticket.

For profile-specific extensions beyond the kernel, the ticket MAY include a `must_understand` claim listing additional claim names that the recipient MUST understand. If a recipient sees a `must_understand` entry it does not recognize, it MUST reject the ticket. This is inspired by the JWS `crit` header parameter (RFC 7515 §4.1.11) but applied to payload claims rather than header parameters.

Fields not in the base kernel and not listed in `must_understand` are safe to ignore.

## Must-understand semantics

### Base must-understand set

Every field defined in the kernel is must-understand when present. If a recipient receives a ticket containing a kernel field it cannot enforce, it SHALL reject with `invalid_grant`. The base set includes:

* JWT envelope: `iss`, `aud`, `exp`, `jti`, `ticket_type`
* `presenter_binding` (key and/or framework_client)
* `subject.patient` and optional `recipient_record`
* `requester`
* `access.permissions`
* `access.data_period`
* `access.jurisdictions`
* `access.source_organizations`
* `access.sensitive_data`
* `context`
* `revocation`

### `must_understand` for extensions

Profile-specific claims not in the base set are safe to ignore unless the issuer lists them in `must_understand`. A recipient that sees a `must_understand` entry it does not recognize SHALL reject the ticket.

`supporting_artifacts` is explicitly NOT must-understand. A base-conformant recipient can ignore it entirely unless a narrower profile adds it to `must_understand` (which would be unusual).

### Unknown fields

Fields not in the base kernel, not in `must_understand`, and not recognized by the recipient are safe to ignore. This is standard JWT behavior.

## Issuer vs. recipient responsibility

The issuer does all real-world verification. The ticket carries only what the recipient needs for matching, filtering, and local policy selection.

### What the issuer verifies before minting

* Patient identity (via digital ID, in-person verification, portal authentication, etc.)
* Requester identity and relationship to patient (for delegation: POA, guardianship, parental authority; for B2B: organizational identity)
* Legal/regulatory basis for access (consent obtained, mandate exists, contract in force, care relationship established)
* Scope appropriateness (the requested access is within the delegation scope, study protocol, mandate authority, etc.)
* Any jurisdiction-specific requirements

### What the recipient uses from the ticket

* **For matching**: `subject.patient` → resolve to a local patient record
* **For cryptographic validation**: signature, `iss` (issuer trust), `exp`, `aud`, `presenter_binding`
* **For access filtering**: `access.permissions`, `data_period`, `jurisdictions`, `source_organizations`, `sensitive_data`
* **For local policy selection**: `requester` (type, identity, relationship), `ticket_type`, `context` — the recipient may apply different local policies based on these (e.g., broader release for a public health investigation than for a payer claim)
* **For audit**: all of the above

### What the recipient does NOT do

* Re-verify the delegation relationship, consent, mandate, or contract
* Independently authenticate the requester's identity (the presenter is authenticated; the requester is an issuer attestation)
* Require supporting artifacts to say yes or no (unless a profile says otherwise)

The recipient trusts the issuer for all real-world verification. The issuer's reputation and trust-framework membership back that trust.

## Updated TypeScript model

```ts
export type Uri = string;
export type Instant = string; // ISO 8601 timestamp per FHIR
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
   * Unified presenter binding container.
   * key and framework_client are independent; either may appear alone,
   * or both may appear together.
   *
   * Note: this replaces the standard JWT cnf claim (RFC 7800) so that
   * all presenter-binding semantics live in one container. The key.jkt
   * semantics are identical to cnf.jkt.
   */
  presenter_binding?: {
    key?: {
      jkt: string;
    };
    framework_client?: {
      framework: Uri;
      framework_type: "well-known" | "udap";
      entity_uri: Uri;
    };
  };

  revocation?: {
    url: Uri;
    rid: string;
  };

  /**
   * Profile-specific claim names that the recipient MUST understand.
   * Inspired by JWS crit (RFC 7515 §4.1.11), applied to payload claims.
   */
  must_understand?: string[];

  subject: Subject;

  /**
   * The real-world party for whom the grant exists.
   * Issuer-attested; the recipient trusts this without independent verification.
   * Distinct from the presenting software client.
   */
  requester?: Requester;

  /**
   * Normative authorization model.
   */
  access: AccessGrant;

  /**
   * Ticket-type-specific mandatory workflow semantics.
   */
  context: TicketContext;

  /**
   * Optional evidence and review material.
   * Not required by the base protocol to say yes/no.
   * Not must-understand unless a profile adds it to must_understand.
   */
  supporting_artifacts?: FHIR.Resource[];
}

export interface Subject {
  /**
   * Always present and may be thin.
   * Carries only the matching facts needed for portability.
   */
  patient: FHIR.Patient;

  /**
   * Optional recipient-local patient locator.
   * Uses FHIR.Reference so it can carry .reference, .identifier, or both.
   */
  recipient_record?: FHIR.Reference & { type?: "Patient" };
}

export type Requester =
  | FHIR.RelatedPerson
  | FHIR.Practitioner
  | FHIR.PractitionerRole
  | FHIR.Organization;

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
  resource_type: string;
  interactions: NonEmptyArray<RestInteraction>;

  /**
   * Optional portable narrowing dimensions.
   * AND across populated groups, OR within each group.
   */
  category_any_of?: NonEmptyArray<FHIR.Coding>;
  code_any_of?: NonEmptyArray<FHIR.Coding>;
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
  data_period?: FHIR.Period;

  /**
   * Coarse geographic restriction on which data holders or
   * data holder sites should be included. Country/state only.
   */
  jurisdictions?: NonEmptyArray<Pick<FHIR.Address, "country" | "state">>;

  /**
   * Positive data-holder scoping by organizational identity.
   * When present, only data from data holders (or sites within
   * a multi-site holder) matching one of these identifiers
   * should be included. When absent, any data holder in the
   * audience may return data.
   */
  source_organizations?: NonEmptyArray<FHIR.Identifier>;

  /**
   * Recipient-interpreted using local sensitivity labels/policy.
   * If absent, recipients default to exclude.
   */
  sensitive_data?: SensitiveDataPolicy;
}

export interface PatientAccessContext {
  kind: "patient-access";
}

export interface PublicHealthContext {
  kind: "public-health";
  reportable_condition: FHIR.CodeableConcept;
  investigation_case?: FHIR.Identifier;
  triggering_resource?: FHIR.Condition | FHIR.Observation | FHIR.DiagnosticReport;
  source_report?: FHIR.DocumentReference;
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
  research_subject?: FHIR.ResearchSubject;
  condition?: FHIR.CodeableConcept;
}

export interface ProviderConsultContext {
  kind: "provider-consult";
  reason: FHIR.CodeableConcept;
  consult_request: FHIR.ServiceRequest;
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

* `iss`, `aud`, `exp`, `jti`, and `ticket_type` are mandatory.
* `aud` is a standard JWT audience claim: one string or an array of strings.
* `ticket_type` is a URI and selects ticket-type-specific processing rules.
* `jti` is the stable handle for revocation, lineage, and audit correlation.

### Subject

* `subject.patient` is always required.
* It may be thin.
* `recipient_record` is optional and is only a direct-recipient optimization.
* Because it is a `FHIR.Reference`, it may carry `.reference`, `.identifier`, or both.

### Requester

* Absent for self-access. For self-access, the patient's identity is already in `subject.patient`; a separate `requester` would be redundant.
* Present for proxy, organizational, clinician, or other non-self use cases.
* `requester` is an **issuer-attested claim** about who the grant is for. The recipient trusts the issuer's attestation; it does not independently verify the requester's identity against the client authentication event.
* The recipient **may use `requester` for local policy decisions** — scoping data, applying sensitivity rules, choosing which local access-control policies apply, audit logging, etc.
* The **security gate** for ticket redemption remains: issuer trust, ticket signature, presenter binding, and audience validation. `requester` is not part of that gate.
* The level of real-world verification the issuer performed before attesting to the requester varies by use case. For delegation, the issuer typically identity-proofed the requester and confirmed the patient's intent to delegate. For B2B use cases (public health, payer, consult), the issuer has institutional knowledge of the requesting organization rather than individual identity proofing.
* Distinct from the presenting software client. The presenter authenticates via `client_assertion` and optional `presenter_binding`. The `requester` describes who the issuer says the grant is for; the presenter is the software actually redeeming it.

#### Delegation and RelatedPerson.relationship

For delegated access, the `requester` is a `RelatedPerson`. FHIR's `RelatedPerson.relationship` field (0..* CodeableConcept, Preferred binding) can express both the personal relationship **and** the legal authority type using stacked codings from v3-RoleCode:

* Familial: `DAU` (daughter), `MTH` (mother), `SPS` (spouse), etc.
* Legal authority: `GUARD` (guardian), `HPOWATT` (healthcare power of attorney), `DPOWATT` (durable POA), `POWATT` (power of attorney), `SPOWATT` (special POA)

R5 explicitly added the legal authority codes to the RelatedPerson relationship value set. A single `requester` can carry both:

```json
"requester": {
  "resourceType": "RelatedPerson",
  "relationship": [
    { "coding": [{ "system": "http://terminology.hl7.org/CodeSystem/v3-RoleCode", "code": "DAU" }] },
    { "coding": [{ "system": "http://terminology.hl7.org/CodeSystem/v3-RoleCode", "code": "HPOWATT" }] }
  ],
  "name": [{ "family": "Reyes", "given": ["Elena"] }]
}
```

This tells the recipient: "the requester is the patient's daughter and holds healthcare power of attorney." The recipient can use this for local policy decisions (e.g., applying different rules for a guardian vs. a POA holder). The actual POA document, if needed for audit or review, belongs in `supporting_artifacts`.

### Supporting artifacts

`supporting_artifacts` is the explicit optional/supporting-artifact space.

Use it for:

* signed POA or guardianship documents
* consent documents or richer Consent resources
* contracts
* institutional policy documents
* verifier attestations
* detailed delegation metadata that is useful for audit or UI but not required by the base protocol

Generic external documents should usually be represented as `DocumentReference` resources with attachments, URLs, identifiers, or hashes rather than inventing a parallel non-FHIR artifact syntax. Supporting artifacts are optional and not required by the base protocol for the recipient's yes/no decision.

### Access

`access.permissions` is the normative authorization model.

Rules:

* `permissions` are additive
* within one `DataPermission`, populated filter groups are ANDed
* values within one `*_any_of` group are ORed
* `data_period`, `jurisdictions`, `source_organizations`, and `sensitive_data` apply to the whole access grant
* `resource_type` may be `"*"` for broad access (e.g., a research study with full-record consent)

### Timeframe and data period matching

* `data_period` is one coarse timeframe for the ticket.
* If multiple disjoint windows are needed, mint separate tickets.
* Matching semantics: the recipient filters to resources whose clinically relevant date falls within the period. Relevant dates are `authored`, `recorded`, `issued`, or `effective[x]` where present, falling back to encounter timing when no resource-level date is available. Identity-type resources (Patient, Practitioner, Organization, Location) are exempt from date filtering.

### Sensitive data

* `exclude` means the recipient should exclude locally classified sensitive data
* `include` means the ticket permits such data, subject to local law and recipient policy — even with `resource_type: "*"` and `sensitive_data: "include"`, the recipient may still withhold data that local law prohibits releasing (e.g., 42 CFR Part 2 substance abuse records without proper consent)
* if `sensitive_data` is absent, recipients default to `exclude`
* if classification is unknown and the ticket says `exclude`, recipients should default conservatively

### Jurisdictions

* `jurisdictions` restricts which data holders or data holder sites respond to the ticket
* modeled with country/state-style values only
* matching: a data holder checks whether its own jurisdiction matches one of the listed values; a multi-site data holder filters to sites in matching jurisdictions
* this is a one-hop restriction about the responding node, not a provenance chain; the spec does not address re-disclosed data from other jurisdictions

### Source organizations (data-holder scoping)

* `source_organizations` restricts which data holders (or sites within a multi-site holder) should return data
* matching: a data holder checks whether its organizational identity (typically NPI) matches one of the listed identifiers
* when absent, any data holder in the ticket's `aud` may return data
* when present, only matching data holders or sites should return data
* this is positive scoping only; negative exclusions are out of scope

Note: `aud` and `source_organizations` both restrict which data holders honor the ticket, but at different levels. `aud` identifies eligible token endpoints (by URL or trust framework membership). `source_organizations` narrows within that audience by organizational identity — useful when the issuer knows an NPI but not the data holder's FHIR URL.

### Presenter binding

`presenter_binding` keeps two independent semantics in one container:

* `key.jkt` means exact key binding
* `framework_client` means trust-framework identity binding

If both are present, both must pass.

This plan uses `presenter_binding.key.jkt` rather than the standard RFC 7800 `cnf.jkt` claim. The semantics are identical; the structural change co-locates both binding mechanisms in a single container for consistency. The spec should acknowledge this departure.

#### Binding modes

**Key-bound**: The issuer knows the client's key at mint time and binds the ticket to it via `presenter_binding.key.jkt`. Verification: the data holder computes the JWK thumbprint (RFC 7638) of the key used to sign the `client_assertion` and compares it to `presenter_binding.key.jkt`. If they don't match, reject.

**Framework-bound**: The issuer knows the client's trust-framework identity but not necessarily its current key. The ticket binds to a framework entity via `presenter_binding.framework_client`. Verification depends on `framework_type`:

* `udap`: the data holder verifies that the presenting client's certificate SAN URI matches `entity_uri` and that the certificate chains to a trust anchor recognized for the named `framework`.
* `well-known`: the data holder verifies that the presenting client's registered entity URL matches `entity_uri` within the named `framework`.

**Unaffiliated**: Neither `key` nor `framework_client` is present. The ticket does not constrain which client may present it. The data holder still authenticates the client using whatever mechanism it supports (e.g., SMART Backend Services `client_assertion` JWT, UDAP client credentials) and validates `aud`. This mode is appropriate for B2B flows where the issuer does not know which specific client will present the ticket.

In all three modes, the data holder authenticates the presenting client through its standard client authentication mechanism. The binding claims add additional constraints on top of that baseline authentication, not in place of it.

#### Relationship between `framework_client.entity_uri` and `requester`

The `requester` and `presenter_binding.framework_client.entity_uri` will often identify the same organization — the requesting organization is also the one operating the client software. But they do not need to align. Multiple requesters may share a client; an organization may operate a client on behalf of several requesters; or a platform provider may present tickets on behalf of various requesting organizations. The `requester` describes who the grant is for; the `framework_client` constrains which software may redeem it.

### `must_understand`

`must_understand` lists **top-level claim names** that the recipient MUST understand beyond the base kernel. Each entry is a string matching a top-level claim in the ticket payload. If a recipient encounters a `must_understand` entry it does not recognize, it MUST reject the ticket with `invalid_grant`.

This enables profile-specific extensions without requiring changes to the base spec. A profile defines a new top-level claim with clear semantics, and instructs issuers to list it in `must_understand` when recipients must enforce it.

Example: a profile adds encounter-class filtering via a new top-level claim:

```json
{
  "iss": "https://issuer.example.org",
  "aud": "https://network.example.org/token",
  "exp": 1775328000,
  "jti": "ext-example-1",
  "ticket_type": "https://example.org/ticket-types/encounter-filtered-v1",
  "must_understand": ["encounter_class_filter"],
  "encounter_class_filter": {
    "include": [
      {
        "system": "http://terminology.hl7.org/CodeSystem/v3-ActCode",
        "code": "AMB"
      }
    ]
  },
  "subject": { "..." : "..." },
  "access": { "..." : "..." },
  "context": { "kind": "patient-access" }
}
```

A recipient that understands `encounter_class_filter` enforces it. A recipient that does not recognize the name rejects the ticket because it appears in `must_understand`. If the issuer omitted `encounter_class_filter` from `must_understand`, recipients that don't recognize it would simply ignore it.

Extensions should be modeled as new top-level claims rather than injecting fields into existing kernel structures. This keeps extensions visible and prevents profiles from silently altering the semantics of base claims.

### Revocation

Revocation semantics are unchanged from the current specification. In brief:

* `revocation.url` points to an issuer-published Credential Revocation List (CRL).
* `revocation.rid` is an opaque revocation identifier for this ticket.
* The CRL is a JSON file with a `rids` array of revoked identifiers, a `kid` matching the signing key, a `method` field (`"rid"`), and a monotonic `ctr` for change detection.
* A `rid` entry may include a `.timestamp` suffix to revoke only tickets issued before that time.
* If `revocation` is present in the ticket, `jti` SHALL also be present.
* Recipients SHALL check the CRL before issuing a token. If CRL status cannot be determined (retrieval failure, no valid cache), recipients SHALL reject the request (fail-closed).
* Issuers SHOULD generate `rid` using a one-way transformation (e.g., `base64url(hmac-sha-256(issuer_secret || kid, ticket_jti)[0:8])`) to prevent correlation.

See the spec for the full CRL format, caching rules, and privacy considerations.

## How to model delegation detail

This is the bright line for delegation, and it generalizes to the other use cases.

### Put in the kernel

Only the facts needed for yes/no:

* `requester` (as `RelatedPerson` with stacked `relationship` codings for both personal relationship and legal authority type)
* the effective `access`
* ticket `exp`

### Put in `supporting_artifacts`

Everything else unless the ticket type profile says it is required:

* signed POA or guardianship documents
* contract PDFs
* richer Consent artifacts
* verification timestamps and verifier identity
* grantor identity beyond what is already implied by `subject.patient`
* legal limitations that are already represented by `access` and `exp`
* narrative explanations

### Put in `context`

Only ticket-type-specific facts that a conforming recipient for that ticket type must understand to say yes:

* public health: `reportable_condition`
* research: `study`
* payer: `claim` and `service`
* consult: `consult_request` and `reason`
* social care referral: `referral` and `concern`

## Use-case minimums

The JSON examples below are **minimum enforceable examples**. They intentionally omit `supporting_artifacts` unless needed for illustration. That omission is the point: a recipient should be able to honor the minimum example using only the signed ticket plus ordinary local matching, provenance attribution, and sensitivity-policy machinery.

### UC1: network-mediated patient access

Kernel minimum:

* `subject.patient`
* no `requester` (the patient is already identified by `subject.patient`)
* `access`
* `context.kind = "patient-access"`
* optional `presenter_binding`

Optional supporting material:

* richer identity proof
* issuer-side UI evidence

Minimum enforceable example:

```json
{
  "iss": "https://issuer.example.org",
  "aud": "https://network.example.org/token",
  "exp": 1775328000,
  "jti": "uc1-4b33cc1d-0f6b-44bf-bd33-80f6d7140f3e",
  "ticket_type": "https://smarthealthit.org/permission-ticket-type/network-patient-access-v1",
  "presenter_binding": {
    "key": {
      "jkt": "xYz123abcExampleThumbprint"
    }
  },
  "subject": {
    "patient": {
      "resourceType": "Patient",
      "identifier": [
        {
          "system": "http://hospital.example.org/mrn",
          "value": "A12345"
        }
      ],
      "birthDate": "1989-09-14",
      "name": [
        {
          "family": "Reyes",
          "given": ["Elena"]
        }
      ]
    }
  },
  "access": {
    "permissions": [
      {
        "kind": "data",
        "resource_type": "AllergyIntolerance",
        "interactions": ["read", "search"]
      },
      {
        "kind": "data",
        "resource_type": "Condition",
        "interactions": ["read", "search"]
      },
      {
        "kind": "data",
        "resource_type": "Observation",
        "interactions": ["read", "search"]
      },
      {
        "kind": "data",
        "resource_type": "MedicationRequest",
        "interactions": ["read", "search"]
      }
    ],
    "data_period": {
      "start": "2021-01-01",
      "end": "2026-01-01"
    }
  },
  "context": {
    "kind": "patient-access"
  }
}
```

### UC2: authorized representative

Kernel minimum:

* `subject.patient`
* `requester` (RelatedPerson with relationship codings expressing both personal relationship and legal authority type)
* `access`
* `context.kind = "patient-access"` (same as UC1; delegation is expressed by the presence and type of `requester`)

Optional supporting material:

* POA documents, guardianship orders (as `supporting_artifacts`)
* verification details, grantor identity

Minimum enforceable example:

```json
{
  "iss": "https://issuer.example.org",
  "aud": "https://network.example.org/token",
  "exp": 1775328000,
  "jti": "uc2-8c6f4ec2-4fb6-4c42-9530-6bbd11c77e49",
  "ticket_type": "https://smarthealthit.org/permission-ticket-type/authorized-representative-access-v1",
  "presenter_binding": {
    "key": {
      "jkt": "repKeyThumbprintExample123"
    }
  },
  "subject": {
    "patient": {
      "resourceType": "Patient",
      "identifier": [
        {
          "system": "http://hospital.example.org/mrn",
          "value": "P99887"
        }
      ],
      "birthDate": "2016-04-12",
      "name": [
        {
          "family": "Reyes",
          "given": ["Luis"]
        }
      ]
    }
  },
  "requester": {
    "resourceType": "RelatedPerson",
    "relationship": [
      {
        "coding": [
          {
            "system": "http://terminology.hl7.org/CodeSystem/v3-RoleCode",
            "code": "MTH",
            "display": "mother"
          }
        ]
      }
    ],
    "name": [
      {
        "family": "Reyes",
        "given": ["Elena"]
      }
    ]
  },
  "access": {
    "permissions": [
      {
        "kind": "data",
        "resource_type": "Condition",
        "interactions": ["read", "search"]
      },
      {
        "kind": "data",
        "resource_type": "Immunization",
        "interactions": ["read", "search"]
      },
      {
        "kind": "data",
        "resource_type": "MedicationRequest",
        "interactions": ["read", "search"]
      }
    ]
  },
  "context": {
    "kind": "patient-access"
  }
}
```

In this example, the mother relationship is sufficient for a parent accessing a minor's records. For a healthcare power of attorney scenario, the requester would include stacked relationship codings:

```json
"requester": {
  "resourceType": "RelatedPerson",
  "relationship": [
    { "coding": [{ "system": "http://terminology.hl7.org/CodeSystem/v3-RoleCode", "code": "DAU", "display": "daughter" }] },
    { "coding": [{ "system": "http://terminology.hl7.org/CodeSystem/v3-RoleCode", "code": "HPOWATT", "display": "healthcare power of attorney" }] }
  ],
  "name": [{ "family": "Reyes", "given": ["Elena"] }]
}
```

### UC3: public health investigation

Kernel minimum:

* `subject.patient`
* organizational `requester`
* `access`
* `context.kind = "public-health"`
* `context.reportable_condition`

Optional supporting material:

* case identifier, triggering resource, source report
* supporting policy/mandate documents

Minimum enforceable example:

```json
{
  "iss": "https://issuer.state.example.gov",
  "aud": "https://network.example.org/token",
  "exp": 1775328000,
  "jti": "uc3-16ff62cf-2d2d-4b30-8c86-6a13d7ab7d16",
  "ticket_type": "https://smarthealthit.org/permission-ticket-type/public-health-investigation-v1",
  "presenter_binding": {
    "framework_client": {
      "framework": "https://state.example.gov/trust-framework/public-health",
      "framework_type": "udap",
      "entity_uri": "https://state.example.gov/organizations/epi-unit"
    }
  },
  "subject": {
    "patient": {
      "resourceType": "Patient",
      "identifier": [
        {
          "system": "http://hospital.example.org/mrn",
          "value": "M445566"
        }
      ],
      "birthDate": "1978-02-21",
      "name": [
        {
          "family": "Carter",
          "given": ["Monica"]
        }
      ]
    }
  },
  "requester": {
    "resourceType": "Organization",
    "identifier": [
      {
        "system": "urn:ietf:rfc:3986",
        "value": "https://state.example.gov/organizations/epi-unit"
      }
    ],
    "name": "State Epidemiology Unit"
  },
  "access": {
    "permissions": [
      {
        "kind": "data",
        "resource_type": "Condition",
        "interactions": ["read", "search"]
      },
      {
        "kind": "data",
        "resource_type": "Observation",
        "interactions": ["read", "search"]
      },
      {
        "kind": "data",
        "resource_type": "DiagnosticReport",
        "interactions": ["read", "search"]
      }
    ],
    "data_period": {
      "start": "2025-12-01",
      "end": "2026-06-01"
    },
    "jurisdictions": [
      {
        "country": "US",
        "state": "TX"
      }
    ],
    "sensitive_data": "include"
  },
  "context": {
    "kind": "public-health",
    "reportable_condition": {
      "coding": [
        {
          "system": "http://snomed.info/sct",
          "code": "840539006",
          "display": "Disease caused by severe acute respiratory syndrome coronavirus 2 (disorder)"
        }
      ]
    }
  }
}
```

### UC4: social care referral

Kernel minimum:

* `subject.patient`
* `requester`
* `access`
* `context.kind = "social-care-referral"`
* `context.concern`
* `context.referral`

Optional supporting material:

* `Task`, richer referral payload, extra policy/consent evidence

Minimum enforceable example:

```json
{
  "iss": "https://issuer.example.org",
  "aud": "https://network.example.org/token",
  "exp": 1775328000,
  "jti": "uc4-0d0f7272-2d85-49ef-8c39-d4a8e8d8a7f2",
  "ticket_type": "https://smarthealthit.org/permission-ticket-type/social-care-referral-v1",
  "presenter_binding": {
    "framework_client": {
      "framework": "https://smarthealthit.org/trust-frameworks/reference-demo-well-known",
      "framework_type": "well-known",
      "entity_uri": "https://aco.example.org/entities/social-care-hub"
    }
  },
  "subject": {
    "patient": {
      "resourceType": "Patient",
      "identifier": [
        {
          "system": "http://hospital.example.org/mrn",
          "value": "S778899"
        }
      ],
      "birthDate": "1963-11-03",
      "name": [
        {
          "family": "Nguyen",
          "given": ["Linh"]
        }
      ]
    }
  },
  "requester": {
    "resourceType": "Organization",
    "identifier": [
      {
        "system": "urn:ietf:rfc:3986",
        "value": "https://aco.example.org/entities/social-care-hub"
      }
    ],
    "name": "Community Social Care Hub"
  },
  "access": {
    "permissions": [
      {
        "kind": "data",
        "resource_type": "ServiceRequest",
        "interactions": ["read", "search"]
      },
      {
        "kind": "data",
        "resource_type": "Condition",
        "interactions": ["read", "search"]
      },
      {
        "kind": "data",
        "resource_type": "Observation",
        "interactions": ["read", "search"]
      }
    ],
    "sensitive_data": "exclude"
  },
  "context": {
    "kind": "social-care-referral",
    "concern": {
      "coding": [
        {
          "system": "http://snomed.info/sct",
          "code": "733423003",
          "display": "Food insecurity"
        }
      ]
    },
    "referral": {
      "resourceType": "ServiceRequest",
      "identifier": [
        {
          "system": "http://issuer.example.org/referrals",
          "value": "REF-1001"
        }
      ],
      "status": "active",
      "intent": "order"
    }
  }
}
```

### UC5: payer claims adjudication

Kernel minimum:

* `subject.patient`
* organizational `requester`
* `access`
* `context.kind = "payer-claims"`
* `context.claim`
* `context.service`

Optional supporting material:

* supporting contract artifacts, utilization-management notes

Minimum enforceable example:

```json
{
  "iss": "https://issuer.example.org",
  "aud": "https://network.example.org/token",
  "exp": 1775328000,
  "jti": "uc5-9096d8d2-3627-45ee-8ea2-5e5a0ab51b7b",
  "ticket_type": "https://smarthealthit.org/permission-ticket-type/payer-claims-adjudication-v1",
  "presenter_binding": {
    "framework_client": {
      "framework": "https://payer.example.org/trust-framework",
      "framework_type": "udap",
      "entity_uri": "https://payer.example.org/entities/claims-ops"
    }
  },
  "subject": {
    "patient": {
      "resourceType": "Patient",
      "identifier": [
        {
          "system": "http://hospital.example.org/mrn",
          "value": "C112233"
        }
      ],
      "birthDate": "1954-07-19",
      "name": [
        {
          "family": "Johnson",
          "given": ["Amelia"]
        }
      ]
    }
  },
  "requester": {
    "resourceType": "Organization",
    "identifier": [
      {
        "system": "urn:ietf:rfc:3986",
        "value": "https://payer.example.org/entities/claims-ops"
      }
    ],
    "name": "Acme Health Plan Claims Operations"
  },
  "access": {
    "permissions": [
      {
        "kind": "data",
        "resource_type": "Claim",
        "interactions": ["read", "search"]
      },
      {
        "kind": "data",
        "resource_type": "ExplanationOfBenefit",
        "interactions": ["read", "search"]
      },
      {
        "kind": "data",
        "resource_type": "DocumentReference",
        "interactions": ["read", "search"]
      }
    ],
    "data_period": {
      "start": "2025-01-01",
      "end": "2025-12-31"
    },
    "source_organizations": [
      {
        "system": "http://hl7.org/fhir/sid/us-npi",
        "value": "1234567893"
      }
    ],
    "sensitive_data": "exclude"
  },
  "context": {
    "kind": "payer-claims",
    "service": {
      "coding": [
        {
          "system": "http://www.ama-assn.org/go/cpt",
          "code": "99214",
          "display": "Office or other outpatient visit"
        }
      ]
    },
    "claim": {
      "resourceType": "Claim",
      "identifier": [
        {
          "system": "http://payer.example.org/claims",
          "value": "CLM-884422"
        }
      ],
      "status": "active",
      "use": "claim"
    }
  }
}
```

### UC6: research study

Kernel minimum:

* `subject.patient`
* research `requester`
* `access`
* `context.kind = "research"`
* `context.study`

Optional supporting material:

* `ResearchSubject`, condition focus, supporting consent documents

#### Minimum enforceable example (targeted access)

```json
{
  "iss": "https://issuer.example.org",
  "aud": "https://network.example.org/token",
  "exp": 1775328000,
  "jti": "uc6-b5774e14-a020-46f2-94d3-2bb95b7ac4af",
  "ticket_type": "https://smarthealthit.org/permission-ticket-type/research-study-access-v1",
  "presenter_binding": {
    "framework_client": {
      "framework": "https://research.example.org/trust-framework",
      "framework_type": "udap",
      "entity_uri": "https://research.example.org/entities/study-team-204"
    }
  },
  "subject": {
    "patient": {
      "resourceType": "Patient",
      "identifier": [
        {
          "system": "http://hospital.example.org/mrn",
          "value": "R445500"
        }
      ],
      "birthDate": "1970-05-30",
      "name": [
        {
          "family": "Lopez",
          "given": ["Marina"]
        }
      ]
    }
  },
  "requester": {
    "resourceType": "Organization",
    "identifier": [
      {
        "system": "urn:ietf:rfc:3986",
        "value": "https://research.example.org/entities/study-team-204"
      }
    ],
    "name": "Study Team 204"
  },
  "access": {
    "permissions": [
      {
        "kind": "data",
        "resource_type": "Condition",
        "interactions": ["read", "search"]
      },
      {
        "kind": "data",
        "resource_type": "Observation",
        "interactions": ["read", "search"]
      }
    ],
    "data_period": {
      "start": "2024-01-01",
      "end": "2026-12-31"
    },
    "sensitive_data": "exclude"
  },
  "context": {
    "kind": "research",
    "study": {
      "resourceType": "ResearchStudy",
      "identifier": [
        {
          "system": "http://research.example.org/studies",
          "value": "STUDY-204"
        }
      ],
      "status": "active",
      "title": "Diabetes Outcomes Registry"
    }
  }
}
```

#### Variant: full-record consent for rare disease research

When a patient has consented to share their full record (e.g., for a rare disease community registry), `resource_type: "*"` grants broad access:

```json
{
  "iss": "https://issuer.example.org",
  "aud": "https://network.example.org/token",
  "exp": 1775328000,
  "jti": "uc6-rare-c3a91f7e-8812-4a5b-b9e0-df5c2e01a447",
  "ticket_type": "https://smarthealthit.org/permission-ticket-type/research-study-access-v1",
  "presenter_binding": {
    "framework_client": {
      "framework": "https://raredisease.example.org/trust-framework",
      "framework_type": "udap",
      "entity_uri": "https://raredisease.example.org/entities/registry-team"
    }
  },
  "subject": {
    "patient": {
      "resourceType": "Patient",
      "identifier": [
        {
          "system": "http://hospital.example.org/mrn",
          "value": "R990011"
        }
      ],
      "birthDate": "1985-11-22",
      "name": [
        {
          "family": "Park",
          "given": ["Jin"]
        }
      ]
    }
  },
  "requester": {
    "resourceType": "Organization",
    "identifier": [
      {
        "system": "urn:ietf:rfc:3986",
        "value": "https://raredisease.example.org/entities/registry-team"
      }
    ],
    "name": "Rare Disease Community Registry"
  },
  "access": {
    "permissions": [
      {
        "kind": "data",
        "resource_type": "*",
        "interactions": ["read", "search"]
      }
    ],
    "sensitive_data": "include"
  },
  "context": {
    "kind": "research",
    "study": {
      "resourceType": "ResearchStudy",
      "identifier": [
        {
          "system": "http://raredisease.example.org/studies",
          "value": "REGISTRY-EHLERS-DANLOS"
        }
      ],
      "status": "active",
      "title": "Ehlers-Danlos Syndrome Community Registry"
    }
  }
}
```

### UC7: provider-to-provider consult

Kernel minimum:

* `subject.patient`
* clinician/role `requester`
* `access`
* `context.kind = "provider-consult"`
* `context.reason`
* `context.consult_request`

Optional supporting material:

* richer clinician identity, local policy artifacts, positive source narrowing

Minimum enforceable example:

```json
{
  "iss": "https://issuer.example.org",
  "aud": "https://network.example.org/token",
  "exp": 1775328000,
  "jti": "uc7-d6927f7f-74c8-4b1b-a7a5-7f4e6d99390a",
  "ticket_type": "https://smarthealthit.org/permission-ticket-type/provider-consult-v1",
  "presenter_binding": {
    "framework_client": {
      "framework": "https://smarthealthit.org/trust-frameworks/reference-demo-well-known",
      "framework_type": "well-known",
      "entity_uri": "https://hospital.example.org/entities/cardiology-group"
    }
  },
  "subject": {
    "patient": {
      "resourceType": "Patient",
      "identifier": [
        {
          "system": "http://hospital.example.org/mrn",
          "value": "K667788"
        }
      ],
      "birthDate": "1981-03-08",
      "name": [
        {
          "family": "Thomas",
          "given": ["Jared"]
        }
      ]
    }
  },
  "requester": {
    "resourceType": "PractitionerRole",
    "code": [
      {
        "coding": [
          {
            "system": "http://snomed.info/sct",
            "code": "17561000",
            "display": "Cardiologist"
          }
        ]
      }
    ]
  },
  "access": {
    "permissions": [
      {
        "kind": "data",
        "resource_type": "Condition",
        "interactions": ["read", "search"]
      },
      {
        "kind": "data",
        "resource_type": "Observation",
        "interactions": ["read", "search"]
      },
      {
        "kind": "data",
        "resource_type": "DiagnosticReport",
        "interactions": ["read", "search"]
      }
    ],
    "sensitive_data": "exclude"
  },
  "context": {
    "kind": "provider-consult",
    "reason": {
      "coding": [
        {
          "system": "http://snomed.info/sct",
          "code": "53741008",
          "display": "Coronary arteriosclerosis"
        }
      ]
    },
    "consult_request": {
      "resourceType": "ServiceRequest",
      "identifier": [
        {
          "system": "http://issuer.example.org/consults",
          "value": "CONSULT-7788"
        }
      ],
      "status": "active",
      "intent": "order"
    }
  }
}
```

## What is explicitly out of core

These are intentionally **not** common portable semantics:

* negative source exclusions
* facility/service-class exclusions
* arbitrary local sensitive-source taxonomies
* detailed security-label semantics
* detailed legal instrument semantics
* arbitrary search filters
* detailed encounter-class restrictions

If a deployment truly needs them, they should be:

* moved into a specialized ticket-type profile with appropriate `must_understand` entries,
* or carried as non-kernel `supporting_artifacts`,
* or handled purely as recipient-local policy.

## Resolved design questions

* **`source_organizations`**: base kernel. If present, enforce it.
* **`authority`**: removed entirely. The legal/policy basis is already implied by `ticket_type` + `requester` type + `context.kind`. If needed for audit, use `supporting_artifacts`.
* **`DelegatedAccessContext`**: removed. Delegation is expressed by the presence and type of `requester` within the `patient-access` context. No separate context kind needed.

## Follow-on work

1. Rewrite the spec draft around this portable kernel.
2. Update examples to reflect: small common shell, required `context`, optional `supporting_artifacts`.
3. Reconcile use-case profiles against the new kernel/context boundary.
4. Update validation logic: kernel validation, ticket-type context validation, presenter-binding validation, `must_understand` processing.
5. Explicitly mark old semantics as: removed from core, moved to `context`, moved to `supporting_artifacts`, or deferred to specialized profiles.
6. Define the SMART scope projection rule (how `permissions` map to SMART v2 scopes).

The key change in this update is the modeling rule: **make the signed portable kernel only as rich as recipients plausibly need to say yes; put everything else in clearly separate optional/supporting artifact space; use `must_understand` for must-understand extensibility.**
