import { z } from "zod";

export const NETWORK_PATIENT_ACCESS_TICKET_TYPE =
  "https://smarthealthit.org/permission-ticket-type/network-patient-access-v1";
export const AUTHORIZED_REPRESENTATIVE_ACCESS_TICKET_TYPE =
  "https://smarthealthit.org/permission-ticket-type/authorized-representative-access-v1";
export const PUBLIC_HEALTH_INVESTIGATION_TICKET_TYPE =
  "https://smarthealthit.org/permission-ticket-type/public-health-investigation-v1";
export const SOCIAL_CARE_REFERRAL_TICKET_TYPE =
  "https://smarthealthit.org/permission-ticket-type/social-care-referral-v1";
export const PAYER_CLAIMS_ADJUDICATION_TICKET_TYPE =
  "https://smarthealthit.org/permission-ticket-type/payer-claims-adjudication-v1";
export const RESEARCH_STUDY_ACCESS_TICKET_TYPE =
  "https://smarthealthit.org/permission-ticket-type/research-study-access-v1";
export const PROVIDER_CONSULT_TICKET_TYPE =
  "https://smarthealthit.org/permission-ticket-type/provider-consult-v1";

export const PermissionTicketTypeValues = [
  NETWORK_PATIENT_ACCESS_TICKET_TYPE,
  AUTHORIZED_REPRESENTATIVE_ACCESS_TICKET_TYPE,
  PUBLIC_HEALTH_INVESTIGATION_TICKET_TYPE,
  SOCIAL_CARE_REFERRAL_TICKET_TYPE,
  PAYER_CLAIMS_ADJUDICATION_TICKET_TYPE,
  RESEARCH_STUDY_ACCESS_TICKET_TYPE,
  PROVIDER_CONSULT_TICKET_TYPE,
] as const;

export const PermissionTicketTypeSchema = z.enum(PermissionTicketTypeValues);

export const RestInteractionValues = [
  "read",
  "search",
  "history",
  "create",
  "update",
  "patch",
  "delete",
] as const;

export const RestInteractionSchema = z.enum(RestInteractionValues);
export const SensitiveDataPolicySchema = z.enum(["exclude", "include"]);
export const FrameworkTypeSchema = z.enum(["well-known", "udap"]);

const NonEmptyStringSchema = z.string().min(1);
const UriSchema = NonEmptyStringSchema;
const JwtAudienceSchema = z.union([UriSchema, z.array(UriSchema).min(1)]);

export const FHIRCodingSchema = z.object({
  system: z.string().optional(),
  code: z.string().optional(),
  display: z.string().optional(),
}).catchall(z.unknown());

export const FHIRCodeableConceptSchema = z.object({
  coding: z.array(FHIRCodingSchema).optional(),
  text: z.string().optional(),
}).catchall(z.unknown());

export const FHIRIdentifierSchema = z.object({
  system: z.string().optional(),
  value: z.string().optional(),
  type: FHIRCodeableConceptSchema.optional(),
}).catchall(z.unknown()).superRefine((identifier, ctx) => {
  if (!identifier.system && !identifier.value) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "FHIR Identifier must include at least system or value.",
      path: [],
    });
  }
});

export const FHIRHumanNameSchema = z.object({
  family: z.string().optional(),
  given: z.array(z.string()).optional(),
  prefix: z.array(z.string()).optional(),
  suffix: z.array(z.string()).optional(),
}).catchall(z.unknown());

export const FHIRPeriodSchema = z.object({
  start: z.string().optional(),
  end: z.string().optional(),
}).catchall(z.unknown());

export const FHIRReferenceSchema = z.object({
  reference: z.string().optional(),
  identifier: FHIRIdentifierSchema.optional(),
  type: z.string().optional(),
  display: z.string().optional(),
}).catchall(z.unknown());

export const FHIRAddressSchema = z.object({
  country: z.string().optional(),
  state: z.string().optional(),
}).superRefine((address, ctx) => {
  if (!address.country && !address.state) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Jurisdiction entries must include at least country or state.",
      path: [],
    });
  }
});

export const FHIRResourceSchema = z.object({
  resourceType: NonEmptyStringSchema,
}).catchall(z.unknown());

export const PatientSchema = z.object({
  resourceType: z.literal("Patient"),
  identifier: z.array(FHIRIdentifierSchema).optional(),
  name: z.array(FHIRHumanNameSchema).optional(),
  birthDate: z.string().optional(),
  gender: z.string().optional(),
}).catchall(z.unknown());

export const RelatedPersonSchema = z.object({
  resourceType: z.literal("RelatedPerson"),
  relationship: z.array(FHIRCodeableConceptSchema).optional(),
  name: z.array(FHIRHumanNameSchema).optional(),
  identifier: z.array(FHIRIdentifierSchema).optional(),
}).catchall(z.unknown());

export const PractitionerSchema = z.object({
  resourceType: z.literal("Practitioner"),
  name: z.array(FHIRHumanNameSchema).optional(),
  identifier: z.array(FHIRIdentifierSchema).optional(),
}).catchall(z.unknown());

export const PractitionerRoleSchema = z.object({
  resourceType: z.literal("PractitionerRole"),
  code: z.array(FHIRCodeableConceptSchema).optional(),
  identifier: z.array(FHIRIdentifierSchema).optional(),
}).catchall(z.unknown());

export const OrganizationSchema = z.object({
  resourceType: z.literal("Organization"),
  name: z.string().optional(),
  identifier: z.array(FHIRIdentifierSchema).optional(),
}).catchall(z.unknown());

export const RequesterSchema = z.discriminatedUnion("resourceType", [
  RelatedPersonSchema,
  PractitionerSchema,
  PractitionerRoleSchema,
  OrganizationSchema,
]);

export const SubjectSchema = z.object({
  patient: PatientSchema,
  recipient_record: FHIRReferenceSchema.extend({
    type: z.literal("Patient").optional(),
  }).optional(),
});

export const PresenterBindingSchema = z.object({
  key: z.object({
    jkt: NonEmptyStringSchema,
  }).optional(),
  framework_client: z.object({
    framework: UriSchema,
    framework_type: FrameworkTypeSchema,
    entity_uri: UriSchema,
  }).optional(),
}).superRefine((binding, ctx) => {
  if (!binding.key && !binding.framework_client) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "presenter_binding must include key and/or framework_client.",
      path: [],
    });
  }
});

export const RevocationSchema = z.object({
  url: UriSchema,
  rid: NonEmptyStringSchema,
});

export const DataPermissionSchema = z.object({
  kind: z.literal("data"),
  resource_type: NonEmptyStringSchema,
  interactions: z.array(RestInteractionSchema).min(1),
  category_any_of: z.array(FHIRCodingSchema).min(1).optional(),
  code_any_of: z.array(FHIRCodingSchema).min(1).optional(),
});

export const OperationPermissionSchema = z.object({
  kind: z.literal("operation"),
  name: NonEmptyStringSchema,
  target: FHIRReferenceSchema.optional(),
});

export const PermissionRuleSchema = z.discriminatedUnion("kind", [
  DataPermissionSchema,
  OperationPermissionSchema,
]);

export const AccessGrantSchema = z.object({
  permissions: z.array(PermissionRuleSchema).min(1),
  data_period: FHIRPeriodSchema.optional(),
  jurisdictions: z.array(FHIRAddressSchema).min(1).optional(),
  source_organizations: z.array(FHIRIdentifierSchema).min(1).optional(),
  sensitive_data: SensitiveDataPolicySchema.optional(),
});

const ConditionSchema = FHIRResourceSchema.extend({
  resourceType: z.literal("Condition"),
});

const ObservationSchema = FHIRResourceSchema.extend({
  resourceType: z.literal("Observation"),
});

const DiagnosticReportSchema = FHIRResourceSchema.extend({
  resourceType: z.literal("DiagnosticReport"),
});

const DocumentReferenceSchema = FHIRResourceSchema.extend({
  resourceType: z.literal("DocumentReference"),
});

const ServiceRequestSchema = FHIRResourceSchema.extend({
  resourceType: z.literal("ServiceRequest"),
});

const TaskSchema = FHIRResourceSchema.extend({
  resourceType: z.literal("Task"),
});

const ClaimSchema = FHIRResourceSchema.extend({
  resourceType: z.literal("Claim"),
});

const ResearchStudySchema = FHIRResourceSchema.extend({
  resourceType: z.literal("ResearchStudy"),
});

const ResearchSubjectSchema = FHIRResourceSchema.extend({
  resourceType: z.literal("ResearchSubject"),
});

export const PatientAccessContextSchema = z.object({
  kind: z.literal("patient-access"),
});

export const PublicHealthContextSchema = z.object({
  kind: z.literal("public-health"),
  reportable_condition: FHIRCodeableConceptSchema,
  investigation_case: FHIRIdentifierSchema.optional(),
  triggering_resource: z.union([
    ConditionSchema,
    ObservationSchema,
    DiagnosticReportSchema,
  ]).optional(),
  source_report: DocumentReferenceSchema.optional(),
});

export const SocialCareReferralContextSchema = z.object({
  kind: z.literal("social-care-referral"),
  concern: FHIRCodeableConceptSchema,
  referral: ServiceRequestSchema,
  task: TaskSchema.optional(),
});

export const PayerClaimsContextSchema = z.object({
  kind: z.literal("payer-claims"),
  service: FHIRCodeableConceptSchema,
  claim: ClaimSchema,
});

export const ResearchContextSchema = z.object({
  kind: z.literal("research"),
  study: ResearchStudySchema,
  research_subject: ResearchSubjectSchema.optional(),
  condition: FHIRCodeableConceptSchema.optional(),
});

export const ProviderConsultContextSchema = z.object({
  kind: z.literal("provider-consult"),
  reason: FHIRCodeableConceptSchema,
  consult_request: ServiceRequestSchema,
});

export const TicketContextSchema = z.discriminatedUnion("kind", [
  PatientAccessContextSchema,
  PublicHealthContextSchema,
  SocialCareReferralContextSchema,
  PayerClaimsContextSchema,
  ResearchContextSchema,
  ProviderConsultContextSchema,
]);

const BaseKernelTopLevelClaimNames = new Set([
  "iss",
  "aud",
  "exp",
  "iat",
  "jti",
  "ticket_type",
  "presenter_binding",
  "revocation",
  "must_understand",
  "subject",
  "requester",
  "access",
  "context",
]);

const MustUnderstandClaimNameSchema = z.string().regex(/^[a-z][a-z0-9_]*$/);

export const PermissionTicketSchema = z.object({
  iss: UriSchema,
  aud: JwtAudienceSchema,
  exp: z.number().int(),
  iat: z.number().int().optional(),
  jti: NonEmptyStringSchema,
  ticket_type: PermissionTicketTypeSchema,
  presenter_binding: PresenterBindingSchema.optional(),
  revocation: RevocationSchema.optional(),
  must_understand: z.array(MustUnderstandClaimNameSchema).min(1).optional(),
  subject: SubjectSchema,
  requester: RequesterSchema.optional(),
  access: AccessGrantSchema,
  context: TicketContextSchema,
  supporting_artifacts: z.array(FHIRResourceSchema).optional(),
}).catchall(z.unknown()).superRefine((ticket, ctx) => {
  const ticketTypeRequirements: Record<PermissionTicketType, {
    contextKind: TicketContext["kind"];
    requesterType?: Requester["resourceType"];
    presenterBindingRequired?: boolean;
    requesterForbidden?: boolean;
  }> = {
    [NETWORK_PATIENT_ACCESS_TICKET_TYPE]: {
      contextKind: "patient-access",
      presenterBindingRequired: true,
      requesterForbidden: true,
    },
    [AUTHORIZED_REPRESENTATIVE_ACCESS_TICKET_TYPE]: {
      contextKind: "patient-access",
      requesterType: "RelatedPerson",
      presenterBindingRequired: true,
    },
    [PUBLIC_HEALTH_INVESTIGATION_TICKET_TYPE]: {
      contextKind: "public-health",
      requesterType: "Organization",
    },
    [SOCIAL_CARE_REFERRAL_TICKET_TYPE]: {
      contextKind: "social-care-referral",
      requesterType: "Organization",
    },
    [PAYER_CLAIMS_ADJUDICATION_TICKET_TYPE]: {
      contextKind: "payer-claims",
      requesterType: "Organization",
    },
    [RESEARCH_STUDY_ACCESS_TICKET_TYPE]: {
      contextKind: "research",
      requesterType: "Organization",
      presenterBindingRequired: true,
    },
    [PROVIDER_CONSULT_TICKET_TYPE]: {
      contextKind: "provider-consult",
      requesterType: "PractitionerRole",
    },
  };

  const requirement = ticketTypeRequirements[ticket.ticket_type];

  if (ticket.context.kind !== requirement.contextKind) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `ticket_type ${ticket.ticket_type} requires context.kind=${requirement.contextKind}.`,
      path: ["context", "kind"],
    });
  }

  if (requirement.presenterBindingRequired && !ticket.presenter_binding) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `ticket_type ${ticket.ticket_type} requires presenter_binding.`,
      path: ["presenter_binding"],
    });
  }

  if (requirement.requesterForbidden && ticket.requester) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `ticket_type ${ticket.ticket_type} must not include requester.`,
      path: ["requester"],
    });
  }

  if (requirement.requesterType) {
    if (!ticket.requester) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `ticket_type ${ticket.ticket_type} requires requester.`,
        path: ["requester"],
      });
    } else if (ticket.requester.resourceType !== requirement.requesterType) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `ticket_type ${ticket.ticket_type} requires requester.resourceType=${requirement.requesterType}.`,
        path: ["requester", "resourceType"],
      });
    }
  }

  if (ticket.must_understand) {
    const duplicates = new Set<string>();
    for (const claimName of ticket.must_understand) {
      if (duplicates.has(claimName)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `must_understand contains duplicate entry ${claimName}.`,
          path: ["must_understand"],
        });
      }
      duplicates.add(claimName);

      if (BaseKernelTopLevelClaimNames.has(claimName)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `${claimName} is a base claim and must not be listed in must_understand.`,
          path: ["must_understand"],
        });
      }

      if (!(claimName in ticket)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `must_understand entry ${claimName} does not match a top-level ticket claim.`,
          path: ["must_understand"],
        });
      }
    }
  }
});

export const ClientAssertionSchema = z.object({
  iss: NonEmptyStringSchema,
  sub: NonEmptyStringSchema,
  aud: NonEmptyStringSchema,
  jti: NonEmptyStringSchema,
  iat: z.number().int().optional(),
  exp: z.number().int().optional(),
});

export const TokenExchangeRequestSchema = z.object({
  grant_type: z.literal("urn:ietf:params:oauth:grant-type:token-exchange"),
  subject_token: NonEmptyStringSchema,
  subject_token_type: z.literal("https://smarthealthit.org/token-type/permission-ticket"),
  scope: z.string().optional(),
  client_assertion_type: z.literal("urn:ietf:params:oauth:client-assertion-type:jwt-bearer"),
  client_assertion: NonEmptyStringSchema,
});

export type PermissionTicket = z.infer<typeof PermissionTicketSchema>;
export type PermissionTicketType = z.infer<typeof PermissionTicketTypeSchema>;
export type FHIRCoding = z.infer<typeof FHIRCodingSchema>;
export type FHIRCodeableConcept = z.infer<typeof FHIRCodeableConceptSchema>;
export type FHIRIdentifier = z.infer<typeof FHIRIdentifierSchema>;
export type FHIRHumanName = z.infer<typeof FHIRHumanNameSchema>;
export type FHIRPeriod = z.infer<typeof FHIRPeriodSchema>;
export type FHIRReference = z.infer<typeof FHIRReferenceSchema>;
export type FHIRAddress = z.infer<typeof FHIRAddressSchema>;
export type FHIRResource = z.infer<typeof FHIRResourceSchema>;
export type PresenterBinding = z.infer<typeof PresenterBindingSchema>;
export type Subject = z.infer<typeof SubjectSchema>;
export type Requester = z.infer<typeof RequesterSchema>;
export type SensitiveDataPolicy = z.infer<typeof SensitiveDataPolicySchema>;
export type RestInteraction = z.infer<typeof RestInteractionSchema>;
export type DataPermission = z.infer<typeof DataPermissionSchema>;
export type OperationPermission = z.infer<typeof OperationPermissionSchema>;
export type PermissionRule = z.infer<typeof PermissionRuleSchema>;
export type AccessGrant = z.infer<typeof AccessGrantSchema>;
export type TicketContext = z.infer<typeof TicketContextSchema>;
export type ClientAssertion = z.infer<typeof ClientAssertionSchema>;
export type TokenExchangeRequest = z.infer<typeof TokenExchangeRequestSchema>;

export const permissionTicketJsonSchema = z.toJSONSchema(PermissionTicketSchema);
export const clientAssertionJsonSchema = z.toJSONSchema(ClientAssertionSchema);
export const tokenExchangeRequestJsonSchema = z.toJSONSchema(TokenExchangeRequestSchema);

export function parsePermissionTicket(input: unknown): PermissionTicket {
  return PermissionTicketSchema.parse(input);
}

export function isPermissionTicket(input: unknown): input is PermissionTicket {
  return PermissionTicketSchema.safeParse(input).success;
}
