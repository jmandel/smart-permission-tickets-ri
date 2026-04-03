export type ModeName = "strict" | "registered" | "key-bound" | "open" | "anonymous";

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
  authSurface: AuthSurface;
};

export type ViewerLaunchNetwork = NetworkInfo & {
  authSurface: AuthSurface;
};

export type ViewerLaunch = {
  origin: string;
  mode: ModeName;
  ticketIssuer: TicketIssuerInfo | null;
  network: ViewerLaunchNetwork;
  person: {
    personId: string;
    displayName: string;
    summary: string | null;
  };
  ticketPayload: Record<string, any> | null;
  signedTicket: string | null;
  proofJkt: string | null;
  clientBootstrap: {
    clientName: string;
    publicJwk: JsonWebKey;
    privateJwk: JsonWebKey;
    jwkThumbprint: string;
  } | null;
};

export type RegisteredClientInfo = {
  clientId: string;
  clientName: string;
  tokenEndpointAuthMethod: "private_key_jwt";
  publicJwk: JsonWebKey;
  jwkThumbprint: string;
};

export type TokenResponseInfo = {
  access_token: string;
  token_type: string;
  issued_token_type: string;
  expires_in: number;
  scope: string;
  patient?: string;
};
