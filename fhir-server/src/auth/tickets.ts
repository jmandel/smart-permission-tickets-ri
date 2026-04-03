import type { FhirStore } from "../store/store.ts";
import {
  SUPPORTED_RESOURCE_TYPES,
  type AllowedPatientAlias,
  type AuthorizationEnvelope,
  type CategoryRule,
  type DateRange,
  type DateSemantics,
  type ModeName,
  type PermissionTicket,
  type SensitiveMode,
} from "../store/model.ts";
import { decodeEs256Jwt, verifyEs256Jwt } from "./es256-jwt.ts";
import type { TicketIssuerRegistry } from "./issuers.ts";

const RESOURCE_WILDCARD = new Set(["*", "Patient", "Encounter", "Observation", "Condition", "DiagnosticReport", "DocumentReference", "MedicationRequest", "Procedure", "Immunization", "ServiceRequest", "Organization", "Practitioner", "Location", "AllergyIntolerance"]);
const SUPPORTING_CONTEXT_TYPES = ["Organization", "Practitioner", "Location"] as const;

export function validatePermissionTicket(
  subjectToken: string,
  issuers: TicketIssuerRegistry,
  expectedAudience: string,
  requestOrigin: string,
): PermissionTicket {
  const { header, payload } = decodeEs256Jwt<PermissionTicket>(subjectToken);
  if (header.alg !== "ES256") throw new Error("Permission Ticket must be signed with ES256");
  const issuer = issuers.resolveFromIssuerUrl(payload.iss, requestOrigin);
  if (header.kid && header.kid !== issuer.kid) throw new Error("Permission Ticket kid mismatch");
  verifyEs256Jwt<PermissionTicket>(subjectToken, issuer.publicJwk);
  const now = Math.floor(Date.now() / 1000);
  if (payload.exp <= now) throw new Error("Permission Ticket expired");
  const audValues = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (!audValues.includes(expectedAudience)) throw new Error("Permission Ticket audience mismatch");
  return payload;
}

export function compileAuthorizationEnvelope(ticket: PermissionTicket, store: FhirStore, mode: ModeName): AuthorizationEnvelope {
  const resolvedAliases = resolveSubject(ticket, store);
  if (!resolvedAliases.length) throw new Error("No patient matched the ticket subject");
  const patientSlugs = [...new Set(resolvedAliases.map((alias) => alias.patientSlug))];
  if (patientSlugs.length !== 1) throw new Error("Ticket subject matched more than one patient");

  const allowedPatientAliases = store.expandAliasesForPatientSlugs(patientSlugs);
  const allowedSites = compileAllowedSites(ticket, store, allowedPatientAliases);
  const scopeResult = compileScopes(ticket.authorization.access.scopes ?? []);
  const dateRanges = compileDateRanges(ticket.authorization.access.periods ?? []);
  const dateSemantics = compileDateSemantics(ticket);
  const sensitiveMode = compileSensitiveMode(ticket);

  const filteredAliases = allowedSites === undefined
    ? allowedPatientAliases
    : allowedPatientAliases.filter((alias) => allowedSites.includes(alias.siteSlug));
  if (!filteredAliases.length) throw new Error("Ticket constraints exclude all patient aliases");

  const patient = choosePatientClaim(filteredAliases, allowedSites);
  const requiredLabelsAll = [...(scopeResult.requiredLabelsAll ?? [])];
  const deniedLabelsAny = [...(scopeResult.deniedLabelsAny ?? [])];

  return {
    ticketIssuer: ticket.iss,
    ticketSubject: ticket.sub,
    ticketId: ticket.jti,
    ticketType: ticket.ticket_type,
    mode,
    scope: scopeResult.scopeString || (ticket.authorization.access.scopes ?? []).join(" "),
    grantedScopes: scopeResult.scopeStrings,
    patient: patient?.split("/", 2).at(1),
    allowedPatientAliases: filteredAliases,
    allowedSites,
    allowedResourceTypes: scopeResult.allowedResourceTypes,
    dateRanges,
    dateSemantics,
    sensitive: { mode: sensitiveMode },
    requiredLabelsAll: requiredLabelsAll.length ? requiredLabelsAll : undefined,
    deniedLabelsAny: deniedLabelsAny.length ? deniedLabelsAny : undefined,
    granularCategoryRules: scopeResult.granularCategoryRules,
    cnf: ticket.cnf,
  };
}

function resolveSubject(ticket: PermissionTicket, store: FhirStore): AllowedPatientAlias[] {
  const subject = ticket.authorization.subject;
  switch (subject.type) {
    case "reference": {
      const reference = subject.reference ?? (subject.resourceType && subject.id ? `${subject.resourceType}/${subject.id}` : undefined);
      if (!reference) throw new Error("Reference subject missing reference");
      return store.findPatientAliasesByReference(reference);
    }
    case "identifier":
      return store.findPatientAliasesByIdentifiers(subject.identifier ?? []);
    case "match":
      return store.findPatientAliasesByTraits(subject.traits ?? {});
  }
}

function compileAllowedSites(ticket: PermissionTicket, store: FhirStore, aliases: AllowedPatientAlias[]) {
  const aliasSites = new Set(aliases.map((alias) => alias.siteSlug));
  const constrainedSets: Array<Set<string>> = [];

  if (ticket.authorization.access.organizations?.length) {
    constrainedSets.push(new Set(store.resolveAllowedSitesByOrganizations(ticket.authorization.access.organizations)));
  }
  if (ticket.authorization.access.jurisdictions?.length) {
    constrainedSets.push(new Set(store.resolveAllowedSitesByJurisdictions(ticket.authorization.access.jurisdictions)));
  }

  if (!constrainedSets.length) return undefined;

  const intersection = [...aliasSites].filter((siteSlug) => constrainedSets.every((set) => set.has(siteSlug)));
  return intersection.sort();
}

function compileScopes(scopes: string[]) {
  const allowedResourceTypes = new Set<string>();
  const granularCategoryRules: CategoryRule[] = [];
  const requiredLabelsAll: Array<{ system: string; code: string }> = [];
  const deniedLabelsAny: Array<{ system: string; code: string }> = [];

  for (const scope of scopes) {
    const match = scope.match(/^(patient|user|system)\/([A-Za-z*]+)\.([a-z*]+)(?:\?(.*))?$/);
    if (!match) throw new Error(`Unsupported SMART scope syntax: ${scope}`);
    const [, , resourceToken, permissions, query] = match;
    if (!permissions.includes("r") && !permissions.includes("s") && permissions !== "*") {
      throw new Error(`Unsupported non-read scope: ${scope}`);
    }
    if (!RESOURCE_WILDCARD.has(resourceToken)) throw new Error(`Unsupported resource scope: ${scope}`);
    const targetTypes = resourceToken === "*" ? [...SUPPORTED_RESOURCE_TYPES] : [resourceToken];
    for (const type of targetTypes) allowedResourceTypes.add(type);

    if (!query) continue;
    const params = new URLSearchParams(query);
    const category = params.get("category");
    if (category) {
      for (const type of targetTypes) {
        const rule = compileCategoryRule(type, category);
        if (!rule) throw new Error(`Unsupported category granular scope for ${type}`);
        granularCategoryRules.push(rule);
      }
      params.delete("category");
    }
    if (params.get("sensitive") === "allow") {
      params.delete("sensitive");
    }
    if ([...params.keys()].length) throw new Error(`Unsupported granular scope query: ${scope}`);
  }

  for (const type of SUPPORTING_CONTEXT_TYPES) {
    allowedResourceTypes.add(type);
  }

  return {
    scopeStrings: scopes,
    scopeString: scopes.join(" "),
    allowedResourceTypes: [...(allowedResourceTypes.size ? allowedResourceTypes : new Set<string>(SUPPORTED_RESOURCE_TYPES))].sort(),
    granularCategoryRules: granularCategoryRules.length ? dedupeCategoryRules(granularCategoryRules) : undefined,
    requiredLabelsAll: requiredLabelsAll.length ? requiredLabelsAll : undefined,
    deniedLabelsAny: deniedLabelsAny.length ? deniedLabelsAny : undefined,
  };
}

function compileCategoryRule(resourceType: string, category: string): CategoryRule | null {
  if (category.includes("|")) {
    const [system, code] = category.split("|", 2);
    return { resourceType, system, code };
  }
  switch (resourceType) {
    case "Observation":
      return { resourceType, system: "http://terminology.hl7.org/CodeSystem/observation-category", code: category };
    case "DocumentReference":
      return { resourceType, system: "http://hl7.org/fhir/us/core/CodeSystem/us-core-documentreference-category", code: category };
    case "Condition":
      return { resourceType, system: "http://terminology.hl7.org/CodeSystem/condition-category", code: category };
    case "DiagnosticReport":
      return { resourceType, system: "http://terminology.hl7.org/CodeSystem/v2-0074", code: category };
    default:
      return null;
  }
}

function compileDateRanges(periods: Array<{ start?: string; end?: string }>): DateRange[] | undefined {
  const normalized = periods
    .map((period) => ({ start: period.start?.slice(0, 10), end: period.end?.slice(0, 10) }))
    .filter((period) => period.start || period.end);
  return normalized.length ? normalized : undefined;
}

function compileDateSemantics(ticket: PermissionTicket): DateSemantics {
  const value = ticket.details?.dateSemantics;
  return value === "care-overlap" ? "care-overlap" : "generated-during-period";
}

function compileSensitiveMode(ticket: PermissionTicket): SensitiveMode {
  const mode = ticket.details?.sensitive?.mode;
  return mode === "allow" ? "allow" : "deny";
}

function choosePatientClaim(aliases: AllowedPatientAlias[], allowedSites?: string[]) {
  const candidates = allowedSites === undefined ? aliases : aliases.filter((alias) => allowedSites.includes(alias.siteSlug));
  return [...candidates].sort((a, b) => `${a.siteSlug}/${a.serverPatientRef}`.localeCompare(`${b.siteSlug}/${b.serverPatientRef}`))[0]?.serverPatientRef;
}

function dedupeCategoryRules(rules: CategoryRule[]) {
  const seen = new Set<string>();
  return rules.filter((rule) => {
    const key = `${rule.resourceType}|${rule.system}|${rule.code}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
