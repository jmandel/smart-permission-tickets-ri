import { z } from "zod";

import {
  AccessGrantSchema,
  OrganizationSchema,
  PATIENT_DELEGATED_ACCESS_TICKET_TYPE,
  PATIENT_SELF_ACCESS_TICKET_TYPE,
  PAYER_CLAIMS_ADJUDICATION_TICKET_TYPE,
  PayerClaimsContextSchema,
  PROVIDER_CONSULT_TICKET_TYPE,
  PUBLIC_HEALTH_INVESTIGATION_TICKET_TYPE,
  PublicHealthContextSchema,
  RelatedPersonSchema,
  RESEARCH_STUDY_ACCESS_TICKET_TYPE,
  ResearchContextSchema,
  SOCIAL_CARE_REFERRAL_TICKET_TYPE,
  SocialCareReferralContextSchema,
  ProviderConsultContextSchema,
} from "./permission-ticket-schema.ts";

export const DEMO_TICKET_SCENARIOS_EXTENSION_URL =
  "https://smarthealthit.org/fhir/StructureDefinition/smart-permission-tickets-demo-scenarios";

const EmptyContextSchema = z.object({}).strict();
const TicketLifetimeKeySchema = z.enum(["1h", "1d", "7d", "30d", "1y", "never"]);

const PractitionerRoleScenarioRequesterSchema = z.object({
  resourceType: z.literal("PractitionerRole"),
  code: z.array(z.any()).optional(),
  identifier: z.array(z.any()).optional(),
}).catchall(z.unknown());

const PatientSelfScenarioTicketSchema = z.object({
  ticket_type: z.literal(PATIENT_SELF_ACCESS_TICKET_TYPE),
  access: AccessGrantSchema,
  context: EmptyContextSchema.optional(),
}).strict();

const PatientDelegatedScenarioTicketSchema = z.object({
  ticket_type: z.literal(PATIENT_DELEGATED_ACCESS_TICKET_TYPE),
  requester: RelatedPersonSchema,
  access: AccessGrantSchema,
  context: EmptyContextSchema.optional(),
}).strict();

const PublicHealthScenarioTicketSchema = z.object({
  ticket_type: z.literal(PUBLIC_HEALTH_INVESTIGATION_TICKET_TYPE),
  requester: OrganizationSchema,
  context: PublicHealthContextSchema,
  access: AccessGrantSchema,
}).strict();

const SocialCareScenarioTicketSchema = z.object({
  ticket_type: z.literal(SOCIAL_CARE_REFERRAL_TICKET_TYPE),
  requester: OrganizationSchema,
  context: SocialCareReferralContextSchema,
  access: AccessGrantSchema,
}).strict();

const PayerClaimsScenarioTicketSchema = z.object({
  ticket_type: z.literal(PAYER_CLAIMS_ADJUDICATION_TICKET_TYPE),
  requester: OrganizationSchema,
  context: PayerClaimsContextSchema,
  access: AccessGrantSchema,
}).strict();

const ResearchScenarioTicketSchema = z.object({
  ticket_type: z.literal(RESEARCH_STUDY_ACCESS_TICKET_TYPE),
  requester: OrganizationSchema,
  context: ResearchContextSchema,
  access: AccessGrantSchema,
}).strict();

const ProviderConsultScenarioTicketSchema = z.object({
  ticket_type: z.literal(PROVIDER_CONSULT_TICKET_TYPE),
  requester: PractitionerRoleScenarioRequesterSchema,
  context: ProviderConsultContextSchema,
  access: AccessGrantSchema,
}).strict();

export const DemoTicketScenarioTicketSchema = z.discriminatedUnion("ticket_type", [
  PatientSelfScenarioTicketSchema,
  PatientDelegatedScenarioTicketSchema,
  PublicHealthScenarioTicketSchema,
  SocialCareScenarioTicketSchema,
  PayerClaimsScenarioTicketSchema,
  ResearchScenarioTicketSchema,
  ProviderConsultScenarioTicketSchema,
]);

export const DemoTicketScenarioSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  summary: z.string().min(1),
  defaults: z.object({
    ticket_lifetime: TicketLifetimeKeySchema.optional(),
  }).strict().optional(),
  ticket: DemoTicketScenarioTicketSchema,
}).strict();

export const DemoTicketScenarioBundleSchema = z.object({
  scenarios: z.array(DemoTicketScenarioSchema).min(1),
}).strict();

export type TicketLifetimeKey = z.infer<typeof TicketLifetimeKeySchema>;
export type DemoTicketScenarioTicket = z.infer<typeof DemoTicketScenarioTicketSchema>;
export type DemoTicketScenario = z.infer<typeof DemoTicketScenarioSchema>;
export type DemoTicketScenarioBundle = z.infer<typeof DemoTicketScenarioBundleSchema>;

export function parseDemoTicketScenarioBundle(input: unknown): DemoTicketScenarioBundle {
  return DemoTicketScenarioBundleSchema.parse(input);
}

export function safeParseDemoTicketScenarioBundle(input: unknown) {
  return DemoTicketScenarioBundleSchema.safeParse(input);
}
