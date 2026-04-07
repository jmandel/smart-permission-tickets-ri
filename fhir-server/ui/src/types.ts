export type ModeName = "strict" | "registered" | "key-bound" | "open" | "anonymous";
export type DemoClientType = "unaffiliated" | "well-known" | "udap";
export type DemoClientRegistrationMode = "dynamic-jwk" | "implicit-well-known" | "udap-dcr";

export type EncounterInfo = {
  id: string;
  type: string;
  classCode: string;
  date: string;
  status: string;
  summary: string | null;
};

export type SiteOfCare = {
  siteSlug: string;
  orgName: string;
  organizationNpi: string | null;
  jurisdiction: string | null;
  patientId: string;
  resourceCounts: Record<string, number>;
  sensitiveResourceCount: number;
  startDate: string | null;
  endDate: string | null;
  encounters: EncounterInfo[];
};

export type PersonInfo = {
  personId: string;
  patientSlug: string;
  displayName: string;
  familyName: string | null;
  givenNames: string[];
  birthDate: string | null;
  gender: string | null;
  summary: string | null;
  useCases: Array<{ system: string; code: string; display: string }>;
  resourceCounts: Record<string, number>;
  sensitiveResourceCount: number;
  startDate: string | null;
  endDate: string | null;
  sites: SiteOfCare[];
};

export type DemoBootstrap = {
  defaultMode: ModeName;
  selectedMode: ModeName;
  searchableResourceTypes: string[];
  defaultTicketIssuer: TicketIssuerInfo;
  ticketIssuers: TicketIssuerInfo[];
  defaultNetwork: NetworkInfo;
  networks: NetworkInfo[];
  demoClientOptions: DemoClientOption[];
  demoWellKnownFramework?: DemoWellKnownFrameworkDocument;
  persons: PersonInfo[];
  sites: Array<{
    siteSlug: string;
    organizationName: string;
    organizationNpi: string | null;
    jurisdictions: string[];
    patientCount: number;
    resourceCount: number;
  }>;
};

export type TicketIssuerInfo = {
  slug: string;
  name: string;
  issuerBasePath: string;
  issuerBaseUrl: string;
  jwksPath: string;
  jwksUrl: string;
  signTicketPath: string;
  signTicketUrl: string;
};

export type NetworkInfo = {
  slug: string;
  name: string;
};

export type ResourceScopeMode = "all" | "selected";
export type LocationConstraintMode = "all" | "states" | "organizations";
export type DateConstraintMode = "all" | "window";
export type ScopeOptionKind = "resource" | "category";
export type TicketLifetimeKey = "1h" | "1d" | "7d" | "30d" | "1y" | "never";

export type DemoClientFrameworkInfo = {
  uri: string;
  displayName: string;
  documentPath?: string;
  documentUrl?: string;
};

export type DemoWellKnownFrameworkDocument = {
  framework: string;
  framework_type: "well-known";
  display_name: string;
  clients: Array<{
    slug: string;
    label: string;
    description: string;
    entityPath: string;
    entityUri: string;
    jwksPath: string;
    jwksUrl: string;
    framework: string;
  }>;
};

export type DemoClientOption = {
  type: DemoClientType;
  label: string;
  description: string;
  registrationMode: DemoClientRegistrationMode;
  framework?: DemoClientFrameworkInfo;
  entityUri?: string;
  jwksUrl?: string;
  clientName?: string;
  publicJwk?: JsonWebKey;
  privateJwk?: JsonWebKey;
  certificatePem?: string;
  privateKeyPem?: string;
  algorithm?: "RS256";
  scope?: string;
  contacts?: string[];
};

export type ViewerUnaffiliatedClientPlan = {
  type: "unaffiliated";
  displayLabel: string;
  registrationMode: "dynamic-jwk";
  clientName: string;
  publicJwk: JsonWebKey;
  privateJwk: JsonWebKey;
  jwkThumbprint: string;
};

export type ViewerWellKnownClientPlan = {
  type: "well-known";
  displayLabel: string;
  registrationMode: "implicit-well-known";
  entityUri: string;
  jwksUrl?: string;
  clientName: string;
  publicJwk: JsonWebKey;
  privateJwk: JsonWebKey;
  framework: DemoClientFrameworkInfo;
};

export type ViewerUdapClientPlan = {
  type: "udap";
  displayLabel: string;
  registrationMode: "udap-dcr";
  entityUri: string;
  clientName: string;
  framework: DemoClientFrameworkInfo;
  algorithm: "RS256";
  certificatePem: string;
  privateKeyPem: string;
  scope: string;
  contacts: string[];
};

export type ViewerClientPlan = ViewerUnaffiliatedClientPlan | ViewerWellKnownClientPlan | ViewerUdapClientPlan;

export type TicketBindingDescription = {
  shape:
    | "none"
    | "presenter_binding.method=jkt"
    | "presenter_binding.method=framework_client";
  label: string;
  rationale: string;
  usesProofKeyBinding: boolean;
  usesFrameworkBinding: boolean;
  proofJkt: string | null;
  frameworkClientBinding: Record<string, any> | null;
};

export type ClientStoryDescription = {
  clientType: DemoClientType;
  label: string;
  registrationLabel: string;
  authenticationLabel: string;
  effectiveClientId: string;
  whatThisDemonstrates: string;
  frameworkDisplayName?: string;
  frameworkUri?: string;
  entityUri?: string;
  jwksUrl?: string;
  ticketBinding: TicketBindingDescription;
};

export type ScopeOption = {
  scope: string;
  resourceType: string;
  label: string;
  description?: string;
  group: string;
  kind: ScopeOptionKind;
};

export type ScopeGroup = {
  id: string;
  label: string;
  description: string;
  options: ScopeOption[];
};

export type ConsentState = {
  resourceScopeMode: ResourceScopeMode;
  scopeSelections: Record<string, boolean>;
  locationMode: LocationConstraintMode;
  selectedSiteSlugs: Record<string, boolean>;
  selectedStateCodes: Record<string, boolean>;
  dateMode: DateConstraintMode;
  dateRange: { start: string | null; end: string | null };
  sensitiveMode: "allow" | "deny";
  ticketLifetime: TicketLifetimeKey;
};

export type AuthSurface = {
  kind: "global" | "site" | "network";
  siteSlug?: string;
  networkSlug?: string;
  smartConfigPath: string;
  registerPath: string;
  tokenPath: string;
  introspectPath: string;
  fhirBasePath: string;
  previewFhirBasePath: string;
};

export type ViewerLaunchSite = {
  siteSlug: string;
  orgName: string;
  jurisdiction: string | null;
  patientId?: string | null;
  endpointId?: string;
  organizationId?: string;
  fhirBaseUrl?: string;
  authSurface: AuthSurface;
};

export type ViewerLaunchNetwork = NetworkInfo & {
  authSurface: AuthSurface;
};

export type ViewerLaunch = {
  sessionId: string;
  origin: string;
  mode: ModeName;
  ticketIssuer: TicketIssuerInfo | null;
  network: ViewerLaunchNetwork;
  person: {
    personId: string;
  };
  ticketPayload: PermissionTicket | null;
  signedTicket: string | null;
  proofJkt: string | null;
  clientPlan: ViewerClientPlan | null;
  demoSummary: {
    dateSummary: string;
    sensitiveSummary: string;
    expirySummary: string;
    bindingSummary: string;
    clientLabel?: string | null;
  };
};

export type RegisteredClientInfo = {
  clientId: string;
  clientName: string;
  tokenEndpointAuthMethod: "private_key_jwt";
  authMode: DemoClientType;
  publicJwk?: JsonWebKey;
  jwkThumbprint?: string;
  framework?: DemoClientFrameworkInfo;
  entityUri?: string;
  registrationRequest?: Record<string, any>;
  registrationResponse?: Record<string, any>;
  softwareStatement?: string;
};

export type TokenResponseInfo = {
  access_token: string;
  token_type: string;
  issued_token_type: string;
  expires_in: number;
  scope: string;
  patient?: string;
};
import type { PermissionTicket } from "../../../shared/permission-ticket-schema.ts";
