import path from "node:path";
import type { PermissionTicket as SharedPermissionTicket } from "../../../shared/permission-ticket-schema.ts";

export type Label = {
  system: string;
  code: string;
};

export type CategoryRule = {
  resourceType: string;
  system: string;
  code: string;
};

export type DateSemantics = "generated-during-period" | "care-overlap";
export type SensitiveMode = "deny" | "allow";
export type ModeName = "strict" | "registered" | "key-bound" | "open" | "anonymous";
export type ClientAuthMode = "unaffiliated" | "well-known" | "udap" | "oidf";

export type DateRange = {
  start?: string;
  end?: string;
};

export type FrameworkType = "well-known" | "udap" | "oidf";

export type UdapCertificateAuthority = {
  caId: string;
  certificatePem: string;
  privateKeyPem: string;
};

export type FrameworkClientBinding = {
  method: "framework_client";
  framework: string;
  framework_type: FrameworkType;
  entity_uri: string;
};

export type FrameworkDefinition = {
  framework: string;
  frameworkType: FrameworkType;
  supportsClientAuth: boolean;
  supportsIssuerTrust: boolean;
  cacheTtlSeconds: number;
  localAudienceMembership?: {
    entityUri: string;
  };
  wellKnown?: {
    allowlist: string[];
    jwksRelativePath: string;
  };
  udap?: {
    trustAnchors: string[];
    entityAllowlist?: string[];
    metadataSigningCertificatePem?: string;
    metadataSigningPrivateKeyPem?: string;
    metadataSigningIssuerCertificatePem?: string;
    metadataSigningIssuerPrivateKeyPem?: string;
    metadataSigningIssuerCaId?: string;
    certificateAuthorities?: UdapCertificateAuthority[];
  };
  oidf?: {
    trustAnchorEntityId: string;
    trustAnchorJwks?: JsonWebKey[];
    appNetworkEntityId: string;
    providerNetworkEntityId: string;
    demoAppEntityId: string;
    providerSiteEntityIds: Record<string, string>;
    ticketIssuerEntityId: string;
    ticketIssuerUrl: string;
    trustMarkType: string;
  };
};

export type ResolvedFrameworkEntity = {
  framework?: {
    uri: string;
    type: FrameworkType;
  };
  entityUri: string;
  displayName: string;
  publicJwks?: JsonWebKey[];
  metadata?: Record<string, any>;
};

export type TicketIssuerTrust = {
  source: "local" | "framework";
  issuerUrl: string;
  displayName: string;
  framework?: {
    uri: string;
    type: FrameworkType;
  };
};

export type ResolvedIssuerTrust = TicketIssuerTrust & {
  publicJwks: JsonWebKey[];
  metadata?: Record<string, any>;
};

export type AllowedPatientAlias = {
  patientSlug: string;
  siteSlug: string;
  sourcePatientRef: string;
  serverPatientRef: string;
};

export type AuthorizationEnvelope = {
  ticketIssuer: string;
  ticketIssuerTrust?: TicketIssuerTrust;
  grantSubject: string;
  ticketId?: string;
  ticketType: string;
  mode: ModeName;
  scope: string;
  grantedScopes: string[];
  patient?: string;
  allowedPatientAliases: AllowedPatientAlias[];
  allowedSites?: string[];
  allowedResourceTypes?: string[];
  dateRanges?: DateRange[];
  dateSemantics: DateSemantics;
  sensitive: { mode: SensitiveMode };
  requiredLabelsAll?: Label[];
  deniedLabelsAny?: Label[];
  granularCategoryRules?: CategoryRule[];
  presenterProofKey?: { jkt: string };
  presenterFrameworkClient?: FrameworkClientBinding;
};

export type PermissionTicket = SharedPermissionTicket;

export type TokenExchangeRequest = {
  grant_type: string;
  subject_token: string;
  subject_token_type?: string;
  scope?: string;
  client_id?: string;
  client_assertion_type?: string;
  client_assertion?: string;
};

export type RegisteredClient = {
  clientId: string;
  clientName: string;
  tokenEndpointAuthMethod: "none" | "private_key_jwt";
  registeredAuthSurface?: string;
  publicJwk?: JsonWebKey;
  availablePublicJwks?: JsonWebKey[];
  jwkThumbprint?: string;
  registeredScope?: string;
  dynamic: boolean;
  authMode?: ClientAuthMode;
  frameworkBinding?: FrameworkClientBinding;
};

export type AuthenticatedClientIdentity = {
  clientId: string;
  clientName: string;
  tokenEndpointAuthMethod: RegisteredClient["tokenEndpointAuthMethod"];
  registeredAuthSurface?: string;
  dynamic: boolean;
  authMode: ClientAuthMode;
  registeredScope?: string;
  frameworkBinding?: FrameworkClientBinding;
  resolvedEntity?: ResolvedFrameworkEntity;
  availablePublicJwks: JsonWebKey[];
  publicJwk?: JsonWebKey;
  jwkThumbprint?: string;
  certificateThumbprint?: string;
};

export type RouteContext = {
  mode: ModeName;
  siteSlug?: string;
  networkSlug?: string;
};

export type ScopeClass = "patient" | "site";

export type ResourceDescriptor = {
  filePath: string;
  patientSlug: string;
  siteSlug: string;
  resourceType: string;
  sourceLogicalId: string;
  sourceRef: string;
  localPatientSourceRef: string;
  scopeClass: ScopeClass;
  sourceJson: any;
  serverKey: string;
  serverLogicalId: string;
  serverRef: string;
};

export type SearchToken = {
  paramName: string;
  system: string | null;
  code: string | null;
  textValue: string | null;
};

export type SearchString = {
  paramName: string;
  value: string;
  normValue: string;
};

export type SearchRef = {
  paramName: string;
  targetType: string | null;
  targetLogicalId: string | null;
  targetRef: string;
};

export type SearchDate = {
  paramName: string;
  start: string;
  end: string;
};

export type PatientAlias = AllowedPatientAlias;

export type LoadResult = {
  patientAliases: PatientAlias[];
  sourceCollisionCount: number;
  serverCollisionCount: number;
  resourceCount: number;
};

export type WindowSourceKind = "direct" | "encounter-fallback" | "identity-exempt" | "missing";

export type ResourceRow = {
  resource_pk: number;
  representative_patient_slug: string;
  site_slug: string;
  resource_type: string;
  source_logical_id: string;
  server_logical_id: string;
  server_ref: string;
  raw_json: string;
  care_start: string | null;
  care_end: string | null;
  care_source_rule: string | null;
  care_source_kind: WindowSourceKind;
  generated_start: string | null;
  generated_end: string | null;
  generated_source_rule: string | null;
  generated_source_kind: WindowSourceKind;
  last_updated: string | null;
};

export const DATA_ROOT = path.resolve(import.meta.dir, "..", "..", "..", "synth-data", "patients");
export const SECURITY_SYSTEM = "urn:example:permissiontickets-demo:security";
export const CROSS_SITE_PATIENT_IDENTIFIER_SYSTEM = "urn:smart-permission-tickets:person-id";
export const V3_ACTCODE_SYSTEM = "http://terminology.hl7.org/CodeSystem/v3-ActCode";
export const SENSITIVE_LABELS: Label[] = [
  { system: V3_ACTCODE_SYSTEM, code: "SEX" },
  { system: V3_ACTCODE_SYSTEM, code: "ETH" },
  { system: V3_ACTCODE_SYSTEM, code: "MH" },
  { system: V3_ACTCODE_SYSTEM, code: "HIV" },
  { system: V3_ACTCODE_SYSTEM, code: "STD" },
  { system: V3_ACTCODE_SYSTEM, code: "SDV" },
];
export const SITE_SCOPED_TYPES = new Set(["Organization", "Location", "Practitioner", "PractitionerRole"]);
export const IDENTITY_TYPES = new Set(["Patient", "Organization", "Practitioner", "Location", "PractitionerRole"]);
export const SUPPORTED_RESOURCE_TYPES = [
  "Patient",
  "Encounter",
  "Observation",
  "Condition",
  "DiagnosticReport",
  "DocumentReference",
  "MedicationRequest",
  "Procedure",
  "Immunization",
  "ServiceRequest",
  "Organization",
  "Practitioner",
  "Location",
  "AllergyIntolerance",
] as const;
