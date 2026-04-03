import type {
  AuthSurface,
  ViewerLaunch,
  ViewerLaunchSite,
  ViewerLaunchNetwork,
  ConsentState,
  DateConstraintMode,
  LocationConstraintMode,
  ModeName,
  NetworkInfo,
  PersonInfo,
  ResourceScopeMode,
  ScopeGroup,
  ScopeOption,
  SiteOfCare,
  TicketIssuerInfo,
} from "./types";
import { computeJwkThumbprint, generateClientKeyMaterial } from "../../shared/private-key-jwt";
import { buildAuthSurface } from "./lib/surfaces";
import { NETWORK_PATIENT_ACCESS_TICKET_TYPE } from "../../shared/permission-tickets";
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
  options?: { proofJkt?: string | null },
) {
  const sites = constrainedSites(person, consent);
  const scopes = selectedSmartScopes(consent);
  const jurisdictions = consent.locationMode === "states" ? compileJurisdictions(sites) : [];
  const organizations = consent.locationMode === "organizations" ? compileOrganizations(sites) : [];

  return {
    iss: ticketIssuerBaseUrl,
    sub: `demo-client-${person.personId}`,
    aud: audienceOrigin,
    exp: Math.floor(Date.now() / 1000) + 3600,
    ticket_type: NETWORK_PATIENT_ACCESS_TICKET_TYPE,
    ...(options?.proofJkt ? { cnf: { jkt: options.proofJkt } } : {}),
    authorization: {
      subject: {
        type: "match" as const,
        traits: {
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
        scopes,
        periods: buildPeriods(consent.dateMode, consent.dateRange),
        jurisdictions: jurisdictions.length ? jurisdictions : undefined,
        organizations: organizations.length ? organizations : undefined,
      },
    },
    details: {
      sensitive: {
        mode: consent.sensitiveMode,
      },
    },
  };
}

function compileJurisdictions(selected: SiteOfCare[]) {
  return uniqueStates(selected).map((state) => ({ state }));
}

function compileOrganizations(selected: SiteOfCare[]) {
  return selected
    .map((site) =>
      site.organizationNpi
        ? {
            identifier: [{ system: "http://hl7.org/fhir/sid/us-npi", value: site.organizationNpi }],
          }
        : {
            name: site.orgName,
          },
    )
    .sort((a, b) => {
      const left = a.identifier?.[0]?.value ?? a.name ?? "";
      const right = b.identifier?.[0]?.value ?? b.name ?? "";
      return left.localeCompare(right);
    });
}

function buildPeriods(mode: DateConstraintMode, dateRange: ConsentState["dateRange"]) {
  if (mode === "all") return undefined;
  if (!dateRange.start && !dateRange.end) return undefined;
  return [
    {
      start: dateRange.start ?? undefined,
      end: dateRange.end ?? undefined,
    },
  ];
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
  origin: string,
  mode: ModeName,
  person: PersonInfo,
  network: NetworkInfo,
  ticketIssuer: TicketIssuerInfo | null,
  ticketPayload: Record<string, any> | null,
  signedTicket: string | null,
  proofJkt: string | null,
  clientBootstrap: ViewerLaunch["clientBootstrap"],
): ViewerLaunch {
  const viewerNetwork: ViewerLaunchNetwork = {
    slug: network.slug,
    name: network.name,
    authSurface: chooseNetworkAuthSurface(mode, network),
  };
  return {
    origin,
    mode,
    ticketIssuer,
    network: viewerNetwork,
    person: {
      personId: person.personId,
      displayName: person.displayName,
      summary: person.summary,
    },
    ticketPayload,
    signedTicket,
    proofJkt,
    clientBootstrap,
  };
}

export function buildViewerLaunchUrl(launch: ViewerLaunch) {
  const encoded = base64UrlEncodeJson(launch);
  return `/viewer?session=${encodeURIComponent(encoded)}`;
}

export function decodeViewerLaunch(encoded: string): ViewerLaunch {
  return JSON.parse(new TextDecoder().decode(base64UrlDecode(encoded))) as ViewerLaunch;
}

function base64UrlEncodeJson(value: unknown) {
  return base64UrlEncode(new TextEncoder().encode(JSON.stringify(value)));
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
