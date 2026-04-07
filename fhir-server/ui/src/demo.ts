import type {
  AuthSurface,
  ClientStoryDescription,
  DemoClientFrameworkInfo,
  ViewerLaunch,
  ViewerLaunchSite,
  ViewerLaunchNetwork,
  ConsentState,
  DateConstraintMode,
  DemoClientRegistrationMode,
  DemoClientOption,
  DemoClientType,
  LocationConstraintMode,
  ModeName,
  NetworkInfo,
  PersonInfo,
  ResourceScopeMode,
  ScopeGroup,
  ScopeOption,
  SiteOfCare,
  TicketBindingDescription,
  TicketLifetimeKey,
  TicketIssuerInfo,
  ViewerClientPlan,
} from "./types";
import { computeJwkThumbprint, generateClientKeyMaterial } from "../../shared/private-key-jwt";
import { buildAuthSurface } from "./lib/surfaces";
import { PATIENT_SELF_ACCESS_TICKET_TYPE } from "../../shared/permission-tickets";
import type {
  DataPermission,
  FrameworkClientBinding,
  PermissionTicket,
  PresenterBinding,
  ResponderFilter,
} from "../../../shared/permission-ticket-schema";
const OBSERVATION_CATEGORY_SYSTEM = "http://terminology.hl7.org/CodeSystem/observation-category";
const US_CORE_OBSERVATION_CATEGORY_SYSTEM = "http://hl7.org/fhir/us/core/CodeSystem/us-core-category";
const CONDITION_CATEGORY_SYSTEM = "http://terminology.hl7.org/CodeSystem/condition-category";
const US_CORE_CONDITION_CATEGORY_SYSTEM = "http://hl7.org/fhir/us/core/CodeSystem/condition-category";

const SCOPE_OPTIONS: ScopeOption[] = [
  { scope: "patient/Patient.rs", resourceType: "Patient", label: "Patient", description: "Identity and demographic record.", group: "foundational", kind: "resource" },
  { scope: "patient/Encounter.rs", resourceType: "Encounter", label: "Encounter", description: "Visit context and care setting.", group: "foundational", kind: "resource" },
  { scope: "patient/AllergyIntolerance.rs", resourceType: "AllergyIntolerance", label: "Allergies", description: "Allergy and intolerance records.", group: "clinical", kind: "resource" },
  { scope: "patient/DiagnosticReport.rs", resourceType: "DiagnosticReport", label: "Reports", description: "Grouped lab, imaging, and report-level results.", group: "clinical", kind: "resource" },
  { scope: "patient/DocumentReference.rs", resourceType: "DocumentReference", label: "Documents", description: "Clinical notes and attached documents.", group: "clinical", kind: "resource" },
  { scope: "patient/Immunization.rs", resourceType: "Immunization", label: "Immunizations", description: "Vaccination history.", group: "clinical", kind: "resource" },
  { scope: "patient/MedicationRequest.rs", resourceType: "MedicationRequest", label: "Medication requests", description: "Prescribed and ordered medications.", group: "clinical", kind: "resource" },
  { scope: "patient/Procedure.rs", resourceType: "Procedure", label: "Procedures", description: "Completed procedures and interventions.", group: "clinical", kind: "resource" },
  { scope: "patient/ServiceRequest.rs", resourceType: "ServiceRequest", label: "Service requests", description: "Requested tests, referrals, and services.", group: "clinical", kind: "resource" },
  { scope: `patient/Observation.rs?category=${OBSERVATION_CATEGORY_SYSTEM}|laboratory`, resourceType: "Observation", label: "Laboratory", description: "Lab results and related measurements.", group: "observation", kind: "category" },
  { scope: `patient/Observation.rs?category=${OBSERVATION_CATEGORY_SYSTEM}|vital-signs`, resourceType: "Observation", label: "Vital signs", description: "Blood pressure, pulse, temperature, weight, and similar vitals.", group: "observation", kind: "category" },
  { scope: `patient/Observation.rs?category=${OBSERVATION_CATEGORY_SYSTEM}|social-history`, resourceType: "Observation", label: "Social history", description: "Smoking, alcohol, occupation, and other social history observations.", group: "observation", kind: "category" },
  { scope: `patient/Observation.rs?category=${OBSERVATION_CATEGORY_SYSTEM}|survey`, resourceType: "Observation", label: "Survey and screening", description: "Questionnaires, screenings, and scored instruments.", group: "observation", kind: "category" },
  { scope: `patient/Observation.rs?category=${US_CORE_OBSERVATION_CATEGORY_SYSTEM}|sdoh`, resourceType: "Observation", label: "Social needs", description: "Social determinants of health and related needs.", group: "observation", kind: "category" },

  { scope: `patient/Condition.rs?category=${CONDITION_CATEGORY_SYSTEM}|problem-list-item`, resourceType: "Condition", label: "Problem list", description: "Longer-lived problems on the patient problem list.", group: "condition", kind: "category" },
  { scope: `patient/Condition.rs?category=${CONDITION_CATEGORY_SYSTEM}|encounter-diagnosis`, resourceType: "Condition", label: "Encounter diagnoses", description: "Diagnoses recorded for a specific visit.", group: "condition", kind: "category" },
  { scope: `patient/Condition.rs?category=${US_CORE_CONDITION_CATEGORY_SYSTEM}|health-concern`, resourceType: "Condition", label: "Health concerns", description: "Care-management concerns and tracked issues.", group: "condition", kind: "category" },
];

const SCOPE_GROUPS: Array<Pick<ScopeGroup, "id" | "label" | "description">> = [
  {
    id: "foundational",
    label: "Foundational record scopes",
    description: "Direct SMART scopes that establish the patient record and visit context.",
  },
  {
    id: "clinical",
    label: "Clinical resource scopes",
    description: "Direct US Core resource scopes that map 1:1 to resource types in the shared chart.",
  },
  {
    id: "observation",
    label: "Observation categories",
    description: "These are the granular Observation categories from US Core.",
  },
  {
    id: "condition",
    label: "Condition categories",
    description: "These are the granular Condition categories from US Core.",
  },
];

const TEN_YEARS_SECONDS = 60 * 60 * 24 * 365 * 10;

const TICKET_LIFETIME_OPTIONS: Array<{ key: TicketLifetimeKey; label: string; seconds: number }> = [
  { key: "1h", label: "1 hour", seconds: 60 * 60 },
  { key: "1d", label: "1 day", seconds: 60 * 60 * 24 },
  { key: "7d", label: "7 days", seconds: 60 * 60 * 24 * 7 },
  { key: "30d", label: "30 days", seconds: 60 * 60 * 24 * 30 },
  { key: "1y", label: "1 year", seconds: 60 * 60 * 24 * 365 },
  { key: "never", label: "10 years (demo stand-in for never)", seconds: TEN_YEARS_SECONDS },
];

export function ticketLifetimeOptions() {
  return TICKET_LIFETIME_OPTIONS;
}

export function ticketLifetimeSeconds(lifetime: TicketLifetimeKey) {
  const option = TICKET_LIFETIME_OPTIONS.find((entry) => entry.key === lifetime);
  return option ? option.seconds : TICKET_LIFETIME_OPTIONS[0].seconds;
}

export function ticketLifetimeLabel(lifetime: TicketLifetimeKey) {
  return TICKET_LIFETIME_OPTIONS.find((option) => option.key === lifetime)?.label ?? TICKET_LIFETIME_OPTIONS[0].label;
}

export type ConsentValidationIssue = {
  section: "resources" | "sites" | "time";
  message: string;
};

function displayYear(date: string | null | undefined) {
  return date?.slice(0, 4) ?? null;
}

export function defaultConsentState(person: PersonInfo): ConsentState {
  const selectedSiteSlugs = Object.fromEntries(person.sites.map((site) => [site.siteSlug, false]));
  const selectedStateCodes = Object.fromEntries(
    uniqueStates(person.sites).map((state) => [state, false]),
  );
  const scopeSelections = Object.fromEntries(
    scopeOptionsForPerson(person).flatMap((group) => group.options.map((option) => [option.scope, true])),
  );
  return {
    resourceScopeMode: "all",
    scopeSelections,
    locationMode: "all",
    selectedSiteSlugs,
    selectedStateCodes,
    dateMode: "all",
    dateRange: { start: person.startDate, end: person.endDate },
    sensitiveMode: "deny",
    ticketLifetime: "1h",
  };
}

export function constrainedSites(person: PersonInfo, consent: ConsentState) {
  if (consent.locationMode === "all") return person.sites;
  if (consent.locationMode === "states") {
    return person.sites.filter((site) => site.jurisdiction && consent.selectedStateCodes[site.jurisdiction]);
  }
  return person.sites.filter((site) => consent.selectedSiteSlugs[site.siteSlug]);
}

export function selectedResourceTypes(consent: ConsentState) {
  if (consent.resourceScopeMode === "all") return ["*"];
  return [...new Set(selectedSmartScopes(consent).map(resourceTypeFromScope))].sort((left, right) => left.localeCompare(right));
}

export function previewableResourceTypes(
  person: PersonInfo,
  consent: ConsentState,
  searchableResourceTypes: string[],
) {
  const enabled =
    consent.resourceScopeMode === "all"
      ? new Set(searchableResourceTypes)
      : new Set(selectedResourceTypes(consent));
  return searchableResourceTypes.filter(
    (resourceType) => enabled.has(resourceType) && (person.resourceCounts[resourceType] ?? 0) > 0,
  );
}

export function chooseSiteAuthSurface(mode: ModeName, site: SiteOfCare): AuthSurface {
  return buildAuthSurface(mode, { siteSlug: site.siteSlug });
}

export function chooseNetworkAuthSurface(mode: ModeName, network: NetworkInfo): AuthSurface {
  return buildAuthSurface(mode, { networkSlug: network.slug });
}

export function selectedSmartScopes(consent: ConsentState) {
  if (consent.resourceScopeMode === "all") return ["patient/*.rs"];
  return Object.entries(consent.scopeSelections)
    .filter(([, enabled]) => enabled)
    .map(([scope]) => scope)
    .sort((left, right) => left.localeCompare(right));
}

export function buildTicketPayload(
  ticketIssuerBaseUrl: string,
  audienceOrigin: string,
  person: PersonInfo,
  consent: ConsentState,
  options?: { proofJkt?: string | null; frameworkClientBinding?: FrameworkClientBinding | null },
): PermissionTicket {
  const sites = constrainedSites(person, consent);
  const responderFilter = buildResponderFilter(consent.locationMode, sites);
  const lifetimeSeconds = ticketLifetimeSeconds(consent.ticketLifetime);
  const presenterBinding = buildPresenterBinding(options?.proofJkt, options?.frameworkClientBinding);

  return {
    iss: ticketIssuerBaseUrl,
    aud: audienceOrigin,
    exp: Math.floor(Date.now() / 1000) + lifetimeSeconds,
    jti: crypto.randomUUID(),
    ticket_type: PATIENT_SELF_ACCESS_TICKET_TYPE,
    ...(presenterBinding ? { presenter_binding: presenterBinding } : {}),
    subject: {
      patient: {
        resourceType: "Patient" as const,
        name: [
          {
            family: person.familyName ?? undefined,
            given: person.givenNames,
          },
        ],
        birthDate: person.birthDate ?? undefined,
      },
    },
    access: {
      permissions: permissionsFromSelectedScopes(consent),
      data_period: buildDataPeriod(consent.dateMode, consent.dateRange),
      responder_filter: responderFilter.length ? responderFilter : undefined,
      sensitive_data: consent.sensitiveMode === "allow" ? "include" : "exclude",
    },
  };
}

function buildResponderFilter(locationMode: LocationConstraintMode, selected: SiteOfCare[]): ResponderFilter[] {
  if (locationMode === "states") {
    return uniqueStates(selected).map((state) => ({
      kind: "jurisdiction" as const,
      address: { state },
    }));
  }
  if (locationMode !== "organizations") return [];
  return selected
    .map((site) => ({
      kind: "organization" as const,
      organization: {
        resourceType: "Organization" as const,
        ...(site.organizationNpi
          ? {
              identifier: [{
                system: "http://hl7.org/fhir/sid/us-npi",
                value: site.organizationNpi,
              }],
            }
          : {}),
        name: site.orgName,
      },
    }))
    .sort((a, b) => a.organization.name.localeCompare(b.organization.name));
}

function buildDataPeriod(mode: DateConstraintMode, dateRange: ConsentState["dateRange"]) {
  if (mode === "all") return undefined;
  if (!dateRange.start && !dateRange.end) return undefined;
  return {
    start: dateRange.start ?? undefined,
    end: dateRange.end ?? undefined,
  };
}

function permissionsFromSelectedScopes(consent: ConsentState): DataPermission[] {
  return selectedSmartScopes(consent).map(projectSmartScopeToPermission);
}

function projectSmartScopeToPermission(scope: string): DataPermission {
  const [baseScope, query] = scope.split("?", 2);
  const resourceType = resourceTypeFromScope(scope);
  const permission: DataPermission = {
    kind: "data",
    resource_type: resourceType,
    interactions: ["read", "search"],
  };
  if (!query) return permission;
  const params = new URLSearchParams(query);
  const category = params.get("category");
  if (!category) return permission;
  const [system, code] = category.split("|", 2);
  permission.category_any_of = [{
    ...(system ? { system } : {}),
    ...(code ? { code } : {}),
  }];
  return permission;
}

function buildPresenterBinding(
  proofJkt: string | null | undefined,
  frameworkClientBinding: FrameworkClientBinding | null | undefined,
) {
  if (proofJkt) return { method: "jkt" as const, jkt: proofJkt };
  if (frameworkClientBinding) return frameworkClientBinding;
  return undefined;
}

export function isConsentValid(person: PersonInfo, consent: ConsentState) {
  return validateConsent(person, consent).length === 0;
}

export function validateConsent(person: PersonInfo, consent: ConsentState): ConsentValidationIssue[] {
  const issues: ConsentValidationIssue[] = [];

  if (consent.resourceScopeMode === "selected" && selectedSmartScopes(consent).length === 0) {
    issues.push({ section: "resources", message: "Select at least one SMART scope." });
  }

  if (consent.locationMode === "states") {
    const hasState = Object.values(consent.selectedStateCodes).some(Boolean);
    if (!hasState) {
      issues.push({ section: "sites", message: "Select at least one state." });
    } else if (constrainedSites(person, consent).length === 0) {
      issues.push({ section: "sites", message: "No sites match the selected states." });
    }
  }

  if (consent.locationMode === "organizations") {
    const hasSite = Object.values(consent.selectedSiteSlugs).some(Boolean);
    if (!hasSite) {
      issues.push({ section: "sites", message: "Select at least one organization." });
    } else if (constrainedSites(person, consent).length === 0) {
      issues.push({ section: "sites", message: "No sites match the selected organizations." });
    }
  }

  if (consent.dateMode === "window" && !consent.dateRange.start && !consent.dateRange.end) {
    issues.push({ section: "time", message: "Select a generated start year, end year, or both." });
  }

  return issues;
}

export function summarizeConsent(person: PersonInfo, consent: ConsentState) {
  const constrainedSiteCount = constrainedSites(person, consent).length;
  const stateCount = uniqueStates(constrainedSites(person, consent)).length;
  const scopeCount = selectedSmartScopes(consent).length;
  const siteSummary =
    consent.locationMode === "all"
      ? "All sites"
      : consent.locationMode === "states"
        ? `${stateCount} state${stateCount === 1 ? "" : "s"}`
        : `${constrainedSiteCount} organization${constrainedSiteCount === 1 ? "" : "s"}`;
  const resources = consent.resourceScopeMode === "all" ? "All supported" : `${scopeCount} SMART scope${scopeCount === 1 ? "" : "s"}`;
  const dates =
    consent.dateMode === "all"
      ? "All dates"
      : displayYear(consent.dateRange.start) && displayYear(consent.dateRange.end)
        ? `${displayYear(consent.dateRange.start)}–${displayYear(consent.dateRange.end)}`
        : displayYear(consent.dateRange.start)
          ? `From ${displayYear(consent.dateRange.start)}`
          : displayYear(consent.dateRange.end)
            ? `Through ${displayYear(consent.dateRange.end)}`
            : "Custom range";
  return {
    sites: siteSummary,
    resources,
    dates,
    sensitive: consent.sensitiveMode === "allow" ? "Included" : "Excluded",
    lifetime: ticketLifetimeLabel(consent.ticketLifetime),
  };
}

export function scopeOptionsForPerson(person: PersonInfo): ScopeGroup[] {
  const visibleOptions = SCOPE_OPTIONS.filter((option) => (person.resourceCounts[option.resourceType] ?? 0) > 0);
  const groups = new Map<string, ScopeOption[]>();
  for (const option of visibleOptions) {
    const existing = groups.get(option.group) ?? [];
    existing.push(option);
    groups.set(option.group, existing);
  }
  return SCOPE_GROUPS
    .map((group) => ({
      ...group,
      options: groups.get(group.id) ?? [],
    }))
    .filter((group) => group.options.length > 0);
}

function uniqueStates(sites: SiteOfCare[]) {
  return [...new Set(sites.map((site) => site.jurisdiction).filter((state): state is string => Boolean(state)))].sort();
}

function resourceTypeFromScope(scope: string) {
  const match = scope.match(/^[^/]+\/([A-Za-z*]+)\./);
  return match?.[1] ?? "*";
}

export async function createViewerClientBootstrap(person: PersonInfo) {
  const keyMaterial = await generateClientKeyMaterial();
  return {
    clientName: `Viewer client for ${person.displayName}`,
    publicJwk: keyMaterial.publicJwk,
    privateJwk: keyMaterial.privateJwk,
    jwkThumbprint: keyMaterial.thumbprint,
  };
}

export async function buildViewerClientPlan(person: PersonInfo, option: DemoClientOption): Promise<ViewerClientPlan> {
  switch (option.type) {
    case "unaffiliated": {
      const bootstrap = await createViewerClientBootstrap(person);
      return {
        type: "unaffiliated",
        displayLabel: option.label,
        registrationMode: "dynamic-jwk",
        clientName: bootstrap.clientName,
        publicJwk: bootstrap.publicJwk,
        privateJwk: bootstrap.privateJwk,
        jwkThumbprint: bootstrap.jwkThumbprint,
      };
    }
    case "well-known":
      if (!option.entityUri || !option.clientName || !option.publicJwk || !option.privateJwk || !option.framework) {
        throw new Error("Well-known demo client option is incomplete");
      }
      return {
        type: "well-known",
        displayLabel: option.label,
        registrationMode: "implicit-well-known",
        entityUri: option.entityUri,
        jwksUrl: option.jwksUrl,
        clientName: option.clientName,
        publicJwk: option.publicJwk,
        privateJwk: option.privateJwk,
        framework: option.framework,
      };
    case "udap":
      if (!option.entityUri || !option.clientName || !option.framework || !option.certificatePem || !option.privateKeyPem || !option.scope) {
        throw new Error("UDAP demo client option is incomplete");
      }
      return {
        type: "udap",
        displayLabel: option.label,
        registrationMode: "udap-dcr",
        entityUri: option.entityUri,
        clientName: option.clientName,
        framework: option.framework,
        algorithm: "RS256",
        certificatePem: option.certificatePem,
        privateKeyPem: option.privateKeyPem,
        scope: option.scope,
        contacts: option.contacts ?? [],
      };
    case "oidf":
      if (!option.entityUri || !option.clientName || !option.publicJwk || !option.privateJwk || !option.framework) {
        throw new Error("OIDF demo client option is incomplete");
      }
      return {
        type: "oidf",
        displayLabel: option.label,
        registrationMode: "oidf-automatic",
        entityUri: option.entityUri,
        clientName: option.clientName,
        publicJwk: option.publicJwk,
        privateJwk: option.privateJwk,
        framework: option.framework,
      };
  }
}

export function clientBindingForPlan(clientPlan: ViewerClientPlan | null): FrameworkClientBinding | null {
  if (!clientPlan) return null;
  if (clientPlan.type === "well-known") {
    return {
      method: "framework_client",
      framework: clientPlan.framework.uri,
      framework_type: "well-known",
      entity_uri: clientPlan.entityUri,
    };
  }
  if (clientPlan.type === "udap") {
    return {
      method: "framework_client",
      framework: clientPlan.framework.uri,
      framework_type: "udap",
      entity_uri: clientPlan.entityUri,
    };
  }
  if (clientPlan.type === "oidf") {
    return {
      method: "framework_client",
      framework: clientPlan.framework.uri,
      framework_type: "oidf",
      entity_uri: clientPlan.entityUri,
    };
  }
  return null;
}

export function proofJktForPlan(mode: ModeName, clientPlan: ViewerClientPlan | null) {
  return (mode === "strict" || mode === "key-bound") && clientPlan?.type === "unaffiliated"
    ? clientPlan.jwkThumbprint
    : null;
}

export function describeTicketBinding(
  mode: ModeName,
  clientType: DemoClientType | null,
  proofJkt: string | null,
  frameworkClientBinding: Record<string, any> | null,
): TicketBindingDescription {
  const usesProofKeyBinding = Boolean(proofJkt);
  const usesFrameworkBinding = Boolean(frameworkClientBinding);
  const shape = usesProofKeyBinding
    ? "presenter_binding.method=jkt"
    : usesFrameworkBinding
      ? "presenter_binding.method=framework_client"
      : "none";
  const label = shape === "none" ? "No presenter binding in ticket" : shape;
  const rationale = clientType === "unaffiliated"
    ? (usesProofKeyBinding
        ? "This app is outside any trust framework, so the ticket binds directly to the generated JWK thumbprint."
        : "This demo path leaves the ticket unbound to a specific client.")
    : clientType === "well-known"
      ? "This app is recognized as a framework-listed entity, so the ticket binds with presenter_binding.method=framework_client instead of a single JWK."
      : clientType === "udap"
        ? "This app proves its framework/entity identity through UDAP registration and certificate-based client authentication."
        : clientType === "oidf"
          ? "This app is identified by its entity URL and proves framework membership by presenting a trust chain in the client assertion header."
        : "This ticket does not include a presenter binding.";
  return {
    shape,
    label,
    rationale,
    usesProofKeyBinding,
    usesFrameworkBinding,
    proofJkt,
    frameworkClientBinding,
  };
}

export function describeClientOption(mode: ModeName, option: DemoClientOption): ClientStoryDescription {
  return buildClientStoryDescription(
    mode,
    option.type,
    option.label,
    option.registrationMode,
    option.framework,
    option.entityUri,
    option.jwksUrl,
    null,
  );
}

export function describeClientPlan(
  mode: ModeName,
  clientPlan: ViewerClientPlan,
  effectiveClientId?: string | null,
): ClientStoryDescription {
  return buildClientStoryDescription(
    mode,
    clientPlan.type,
    clientPlan.displayLabel,
    clientPlan.registrationMode,
    "framework" in clientPlan ? clientPlan.framework : undefined,
    "entityUri" in clientPlan ? clientPlan.entityUri : undefined,
    "jwksUrl" in clientPlan ? clientPlan.jwksUrl : undefined,
    effectiveClientId ?? null,
  );
}

export async function jwkThumbprint(jwk: JsonWebKey) {
  return computeJwkThumbprint(jwk);
}

export function decodeJwtPayload(token: string) {
  const [, payload] = token.split(".");
  if (!payload) throw new Error("Malformed JWT");
  return JSON.parse(new TextDecoder().decode(base64UrlDecode(payload)));
}

export function buildTokenExchangeCurl(
  origin: string,
  surface: AuthSurface,
  signedTicket: string,
  client?: { clientId: string } | null,
  proofJkt?: string | null,
) {
  const parts = [
    "curl",
    "-X", "POST",
    shellQuote(`${origin}${surface.tokenPath}`),
    "-H", shellQuote("content-type: application/x-www-form-urlencoded"),
  ];
  const params = new URLSearchParams({
    grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
    subject_token_type: "https://smarthealthit.org/token-type/permission-ticket",
    subject_token: signedTicket,
  });
  if (client) {
    params.set("client_id", client.clientId);
    params.set("client_assertion_type", "urn:ietf:params:oauth:client-assertion-type:jwt-bearer");
    params.set("client_assertion", "<private-key-jwt>");
  }
  parts.push("--data", shellQuote(params.toString()));
  return parts.join(" ");
}

export function buildSearchCurl(origin: string, surface: AuthSurface, resourceType: string, proofJkt?: string | null) {
  throw new Error("buildSearchCurl requires an access token; use buildAuthorizedSearchCurl or buildFetchCurl");
}

export function buildAuthorizedSearchCurl(
  origin: string,
  surface: AuthSurface,
  resourceType: string,
  accessToken: string,
  proofJkt?: string | null,
) {
  return buildFetchCurl(`${origin}${surface.fhirBasePath}/${resourceType}`, accessToken, proofJkt);
}

export function buildFetchCurl(targetUrl: string, accessToken?: string | null, proofJkt?: string | null) {
  const parts = ["curl"];
  if (accessToken) parts.push("-H", shellQuote(`authorization: Bearer ${accessToken}`));
  if (proofJkt) parts.push("-H", shellQuote(`x-client-jkt: ${proofJkt}`));
  parts.push(shellQuote(targetUrl));
  return parts.join(" ");
}

export function buildViewerLaunch(
  sessionId: string,
  origin: string,
  mode: ModeName,
  person: PersonInfo,
  network: NetworkInfo,
  ticketIssuer: TicketIssuerInfo | null,
  ticketPayload: ViewerLaunch["ticketPayload"],
  signedTicket: string | null,
  proofJkt: string | null,
  clientPlan: ViewerLaunch["clientPlan"],
  demoSummary: ViewerLaunch["demoSummary"],
): ViewerLaunch {
  const viewerNetwork: ViewerLaunchNetwork = {
    slug: network.slug,
    name: network.name,
    authSurface: chooseNetworkAuthSurface(mode, network),
  };
  return {
    sessionId,
    origin,
    mode,
    ticketIssuer,
    network: viewerNetwork,
    person: {
      personId: person.personId,
    },
    ticketPayload,
    signedTicket,
    proofJkt,
    clientPlan,
    demoSummary,
  };
}

export function buildViewerLaunchUrl(launch: ViewerLaunch) {
  const encoded = storeViewerLaunch(launch) ?? base64UrlEncodeJson(launch);
  return `/viewer?session=${encodeURIComponent(encoded)}`;
}

export function decodeViewerLaunch(encoded: string): ViewerLaunch {
  if (encoded.startsWith("storage:")) {
    if (typeof window === "undefined") throw new Error("Stored viewer launch unavailable in this environment");
    const raw = window.localStorage.getItem(encoded.slice("storage:".length));
    if (!raw) throw new Error("Stored viewer launch is missing or expired");
    return JSON.parse(raw) as ViewerLaunch;
  }
  return JSON.parse(new TextDecoder().decode(base64UrlDecode(encoded))) as ViewerLaunch;
}

function buildClientStoryDescription(
  mode: ModeName,
  clientType: DemoClientType,
  label: string,
  registrationMode: DemoClientRegistrationMode,
  framework: DemoClientFrameworkInfo | undefined,
  entityUri: string | undefined,
  jwksUrl: string | undefined,
  effectiveClientId: string | null,
): ClientStoryDescription {
  const frameworkPresenterBinding = clientType === "unaffiliated"
    ? null
    : {
        framework: framework?.uri ?? "",
        framework_type: clientType === "well-known" ? "well-known" : clientType === "oidf" ? "oidf" : "udap",
        entity_uri: entityUri ?? "",
      };
  const proofJkt = clientType === "unaffiliated" && (mode === "strict" || mode === "key-bound") ? "<jkt>" : null;
  const ticketBinding = describeTicketBinding(mode, clientType, proofJkt, frameworkPresenterBinding);
  const registrationLabel = registrationMode === "dynamic-jwk"
    ? "Dynamic registration"
    : registrationMode === "implicit-well-known"
      ? "No registration"
      : registrationMode === "oidf-automatic"
        ? "Automatic registration"
        : "UDAP DCR";
  const authenticationLabel = clientType === "unaffiliated"
    ? "private_key_jwt using a one-off JWK"
    : clientType === "well-known"
      ? "private_key_jwt using the entity's current JWKS key"
      : clientType === "oidf"
        ? "private_key_jwt using the entity's federation-resolved JWKS and a trust_chain JOSE header"
      : "UDAP client assertion with x5c certificate chain; entity URI comes from the certificate SAN";
  const expectedClientId = effectiveClientId
    ?? (clientType === "well-known"
      ? `well-known:${entityUri ?? "<entity-uri>"}`
      : clientType === "oidf"
        ? entityUri ?? "<entity-uri>"
      : clientType === "udap"
        ? "Issued at runtime by UDAP dynamic registration"
        : "Issued at runtime by dynamic registration");
  const whatThisDemonstrates = clientType === "unaffiliated"
    ? "A one-off app outside any trust framework can register a key just before token exchange and bind the ticket directly to that key."
    : clientType === "well-known"
      ? "A framework-affiliated client can skip registration entirely and be recognized from a stable entity URI plus current JWKS resolution."
      : clientType === "oidf"
        ? "A framework-affiliated client can authenticate without prior registration by presenting its entity URL plus a trust chain that resolves its metadata and keys."
      : "A trust-framework-backed client can register just in time through UDAP, using an entity URI taken from the certificate Subject Alternative Name (SAN) and published as an inspectable page on this demo server.";
  return {
    clientType,
    label,
    registrationLabel,
    authenticationLabel,
    effectiveClientId: expectedClientId,
    whatThisDemonstrates,
    frameworkDisplayName: framework?.displayName,
    frameworkUri: framework?.uri,
    entityUri,
    jwksUrl,
    ticketBinding,
  };
}

function base64UrlEncodeJson(value: unknown) {
  return base64UrlEncode(new TextEncoder().encode(JSON.stringify(value)));
}

function storeViewerLaunch(launch: ViewerLaunch) {
  if (typeof window === "undefined" || !("localStorage" in window)) return null;
  const key = `viewer-launch:${crypto.randomUUID()}`;
  window.localStorage.setItem(key, JSON.stringify(launch));
  return `storage:${key}`;
}

function base64UrlEncode(bytes: Uint8Array) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function base64UrlDecode(value: string) {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  const binary = atob(padded);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

function shellQuote(value: string) {
  return `'${value.replace(/'/g, `'\"'\"'`)}'`;
}
