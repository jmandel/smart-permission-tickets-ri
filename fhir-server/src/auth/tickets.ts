import type { FhirStore } from "../store/store.ts";
import {
  SUPPORTED_RESOURCE_TYPES,
  type AllowedPatientAlias,
  type AuthorizationEnvelope,
  type CategoryRule,
  type ClientBinding,
  type DateRange,
  type DateSemantics,
  type FrameworkType,
  type ModeName,
  type PermissionTicket,
  type ResolvedIssuerTrust,
  type SensitiveMode,
  type TicketIssuerTrust,
} from "../store/model.ts";
import { decodeEs256Jwt, verifyEs256Jwt } from "./es256-jwt.ts";
import type { FrameworkRegistry } from "./frameworks/registry.ts";
import type { TicketIssuerRegistry } from "./issuers.ts";
import type { TicketRevocationRegistry } from "./ticket-revocation.ts";
import { SUPPORTED_PERMISSION_TICKET_TYPES } from "../../shared/permission-tickets.ts";
import type { DemoAuditStep, DemoObserver, DemoPatientMatchDetail, DemoRelatedArtifact } from "../../shared/demo-events.ts";

const RESOURCE_WILDCARD = new Set(["*", "Patient", "Encounter", "Observation", "Condition", "DiagnosticReport", "DocumentReference", "MedicationRequest", "Procedure", "Immunization", "ServiceRequest", "Organization", "Practitioner", "Location", "AllergyIntolerance"]);
const SUPPORTING_CONTEXT_TYPES = ["Organization", "Practitioner", "Location"] as const;

export type ValidatedPermissionTicket = {
  ticket: PermissionTicket;
  issuerTrust: TicketIssuerTrust;
};

export type TokenExchangeDiagnostics = {
  steps: DemoAuditStep[];
  patientMatch?: DemoPatientMatchDetail;
  relatedArtifacts: DemoRelatedArtifact[];
};

type DemoValidationContext = {
  phase: "network-auth" | "site-auth";
  siteSlug?: string;
  siteName?: string;
};

export async function validatePermissionTicket(
  subjectToken: string,
  issuers: TicketIssuerRegistry,
  frameworks: FrameworkRegistry,
  ticketRevocations: TicketRevocationRegistry,
  expectedAudiences: string[],
  requestOrigin: string,
  diagnostics?: TokenExchangeDiagnostics,
): Promise<ValidatedPermissionTicket> {
  if (!subjectToken) throw new Error("No permission ticket provided");
  addRelatedArtifact(diagnostics, {
    label: "Permission Ticket JWT",
    kind: "jwt",
    content: subjectToken,
    copyText: subjectToken,
  });
  const { header, payload } = decodeEs256Jwt<PermissionTicket>(subjectToken);
  if (header.alg !== "ES256") {
    addAuditStep(diagnostics, { check: "Signature", passed: false, reason: "Permission Ticket must be signed with ES256" });
    throw new Error("Permission Ticket must be signed with ES256");
  }
  let issuer: ResolvedIssuerTrust;
  try {
    issuer = await resolveTrustedIssuer(payload.iss, issuers, frameworks, requestOrigin);
  } catch (error) {
    addAuditStep(diagnostics, {
      check: "Issuer Trust",
      passed: false,
      reason: error instanceof Error ? error.message : "Unknown Permission Ticket issuer",
    });
    throw error;
  }
  try {
    verifyPermissionTicketSignature(subjectToken, header.kid, issuer.publicJwks);
  } catch (error) {
    addRelatedArtifact(diagnostics, {
      label: "Issuer public JWKS",
      kind: "json",
      content: issuer.publicJwks,
    });
    addAuditStep(diagnostics, {
      check: "Signature",
      passed: false,
      reason: error instanceof Error ? error.message : "Permission Ticket signature verification failed",
    });
    throw error;
  }
  addRelatedArtifact(diagnostics, {
    label: "Issuer public JWKS",
    kind: "json",
    content: issuer.publicJwks,
  });
  addAuditStep(diagnostics, {
    check: "Signature",
    passed: true,
    evidence: `alg=${header.alg}${header.kid ? `, kid=${header.kid}` : ""}`,
    why: "Issuer signature verified",
  });
  const now = Math.floor(Date.now() / 1000);
  if (typeof payload.exp !== "number") {
    addAuditStep(diagnostics, { check: "Expiration", passed: false, reason: "Permission Ticket missing exp" });
    throw new Error("Permission Ticket missing exp");
  }
  if (payload.exp <= now) {
    addAuditStep(diagnostics, { check: "Expiration", passed: false, reason: "Permission Ticket expired" });
    throw new Error("Permission Ticket expired");
  }
  addAuditStep(diagnostics, {
    check: "Expiration",
    passed: true,
    evidence: `${payload.exp - now}s remaining`,
    why: "Ticket is within its validity window",
  });
  const audValues = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (!permissionTicketAudienceMatches(audValues, expectedAudiences, frameworks)) {
    addRelatedArtifact(diagnostics, { label: "Expected audiences", kind: "json", content: expectedAudiences });
    addAuditStep(diagnostics, {
      check: "Audience",
      passed: false,
      reason: "Permission Ticket audience mismatch",
    });
    throw new Error("Permission Ticket audience mismatch");
  }
  addRelatedArtifact(diagnostics, { label: "Expected audiences", kind: "json", content: expectedAudiences });
  addAuditStep(diagnostics, {
    check: "Audience",
    passed: true,
    evidence: audValues.join(", "),
    why: "Ticket audience matches this server surface",
  });
  if (!payload.ticket_type) {
    addAuditStep(diagnostics, { check: "Type", passed: false, reason: "Permission Ticket missing ticket_type" });
    throw new Error("Permission Ticket missing ticket_type");
  }
  if (!SUPPORTED_PERMISSION_TICKET_TYPES.includes(payload.ticket_type as (typeof SUPPORTED_PERMISSION_TICKET_TYPES)[number])) {
    addAuditStep(diagnostics, { check: "Type", passed: false, reason: "Unsupported ticket type" });
    throw new Error("Unsupported ticket type");
  }
  addAuditStep(diagnostics, {
    check: "Type",
    passed: true,
    evidence: payload.ticket_type,
    why: "Ticket type is supported",
  });
  addAuditStep(diagnostics, {
    check: "Issuer Trust",
    passed: true,
    evidence: issuer.displayName ?? issuer.issuerUrl,
    why: `Issuer is trusted via ${issuer.source}`,
  });
  validateSubjectConsistency(payload.authorization.subject);
  validateSupportedAccessConstraints(payload.authorization.access);
  validateClientBinding(payload.client_binding);
  try {
    await ticketRevocations.assertActive(payload);
  } catch (error) {
    addAuditStep(diagnostics, {
      check: "Revocation",
      passed: false,
      reason: error instanceof Error ? error.message : "Revocation status indeterminate",
    });
    throw error;
  }
  addAuditStep(diagnostics, {
    check: "Revocation",
    passed: true,
    evidence: payload.revocation?.url ? `Checked ${payload.revocation.url}` : "No revocation URI present",
    why: payload.revocation?.url ? "Ticket is not listed as revoked" : "No ticket revocation check required",
  });
  return {
    ticket: payload,
    issuerTrust: {
      source: issuer.source,
      issuerUrl: issuer.issuerUrl,
      displayName: issuer.displayName,
      framework: issuer.framework,
    },
  };
}

function permissionTicketAudienceMatches(
  audValues: string[],
  expectedAudiences: string[],
  frameworks: FrameworkRegistry,
) {
  return audValues.some((audience) => expectedAudiences.includes(audience) || frameworks.hasLocalAudienceMembership(audience));
}

export function compileAuthorizationEnvelope(
  validatedTicket: ValidatedPermissionTicket,
  store: FhirStore,
  mode: ModeName,
  diagnostics?: TokenExchangeDiagnostics,
  demoContext: DemoValidationContext = { phase: "network-auth" },
): AuthorizationEnvelope {
  const { ticket, issuerTrust } = validatedTicket;
  const resolvedAliases = resolveSubject(ticket, store);
  if (!resolvedAliases.length) {
    addAuditStep(diagnostics, { check: "Patient Match", passed: false, reason: "No patient matched the ticket subject" });
    throw new Error("No patient matched the ticket subject");
  }
  const patientSlugs = [...new Set(resolvedAliases.map((alias) => alias.patientSlug))];
  if (patientSlugs.length !== 1) {
    addAuditStep(diagnostics, { check: "Patient Match", passed: false, reason: "Ticket subject matched more than one patient" });
    throw new Error("Ticket subject matched more than one patient");
  }

  const allowedPatientAliases = store.expandAliasesForPatientSlugs(patientSlugs);
  const allowedSites = compileAllowedSites(ticket, store, allowedPatientAliases);
  const scopeResult = compileScopes(ticket.authorization.access.scopes ?? []);
  const dateRanges = compileDateRanges(ticket.authorization.access.periods ?? []);
  const dateSemantics = compileDateSemantics(ticket);
  const sensitiveMode = compileSensitiveMode(ticket);

  const filteredAliases = allowedSites === undefined
    ? allowedPatientAliases
    : allowedPatientAliases.filter((alias) => allowedSites.includes(alias.siteSlug));
  if (!filteredAliases.length) {
    addAuditStep(diagnostics, { check: "Patient Match", passed: false, reason: "Ticket constraints exclude all patient aliases" });
    throw new Error("Ticket constraints exclude all patient aliases");
  }

  const patient = choosePatientClaim(filteredAliases, allowedSites);
  const requiredLabelsAll = [...(scopeResult.requiredLabelsAll ?? [])];
  const deniedLabelsAny = [...(scopeResult.deniedLabelsAny ?? [])];

  const envelope: AuthorizationEnvelope = {
    ticketIssuer: ticket.iss,
    ticketIssuerTrust: issuerTrust,
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
    clientBinding: ticket.client_binding,
  };
  recordPatientMatch(diagnostics, demoContext, resolvedAliases, filteredAliases, store, envelope);
  return envelope;
}

function recordPatientMatch(
  diagnostics: TokenExchangeDiagnostics | undefined,
  demoContext: DemoValidationContext,
  resolvedAliases: AllowedPatientAlias[],
  filteredAliases: AllowedPatientAlias[],
  store: FhirStore,
  envelope: AuthorizationEnvelope,
) {
  const patientName = filteredAliases[0]?.patientSlug ?? resolvedAliases[0]?.patientSlug ?? "Matched patient";
  const visibleSites = new Set(
    filteredAliases
      .map((alias) => alias.siteSlug)
      .filter((siteSlug) => store.hasVisibleEncounter(envelope, siteSlug)),
  );
  if (!diagnostics) return;
  diagnostics.patientMatch = {
    patientName,
    siteCount: demoContext.siteSlug ? 1 : visibleSites.size,
    ...(demoContext.siteSlug ? { siteSlug: demoContext.siteSlug, siteName: demoContext.siteName } : {}),
  };
}

function addAuditStep(diagnostics: TokenExchangeDiagnostics | undefined, step: DemoAuditStep) {
  diagnostics?.steps.push(step);
}

function addRelatedArtifact(diagnostics: TokenExchangeDiagnostics | undefined, artifact: DemoRelatedArtifact) {
  if (!diagnostics) return;
  const duplicate = diagnostics.relatedArtifacts.some((existing) => existing.label === artifact.label && existing.kind === artifact.kind);
  if (!duplicate) diagnostics.relatedArtifacts.push(artifact);
}

async function resolveTrustedIssuer(
  issuerUrl: string,
  issuers: TicketIssuerRegistry,
  frameworks: FrameworkRegistry,
  requestOrigin: string,
): Promise<ResolvedIssuerTrust> {
  const localIssuer = issuers.resolveTrustedIssuer(issuerUrl, requestOrigin);
  if (localIssuer) return localIssuer;
  const frameworkIssuer = await frameworks.resolveIssuerTrust(issuerUrl);
  if (frameworkIssuer) return frameworkIssuer;
  throw new Error("Unknown Permission Ticket issuer");
}

function verifyPermissionTicketSignature(token: string, expectedKid: string | undefined, publicJwks: JsonWebKey[]) {
  const candidateKeys = expectedKid
    ? publicJwks.filter((key) => (key as JsonWebKey & { kid?: string }).kid === expectedKid)
    : publicJwks;
  if (!candidateKeys.length) {
    if (expectedKid) throw new Error("Permission Ticket kid mismatch");
    throw new Error("Permission Ticket issuer did not provide any signing keys");
  }

  let lastError: Error | null = null;
  for (const key of candidateKeys) {
    try {
      verifyEs256Jwt<PermissionTicket>(token, key);
      return;
    } catch (error) {
      lastError = error instanceof Error ? error : new Error("Permission Ticket signature verification failed");
    }
  }
  throw lastError ?? new Error("Permission Ticket signature verification failed");
}

function validateClientBinding(binding: ClientBinding | undefined) {
  if (!binding) return;
  if (binding.binding_type !== "framework-entity") throw new Error("Unsupported client binding type");
  if (!isFrameworkType(binding.framework_type)) throw new Error("Unsupported client binding framework_type");
  validateUrlField(binding.framework, "Permission Ticket client_binding framework must be an absolute URL");
  validateUrlField(binding.entity_uri, "Permission Ticket client_binding entity_uri must be an absolute URL");
}

function isFrameworkType(value: string): value is FrameworkType {
  return value === "well-known" || value === "udap";
}

function validateUrlField(value: string, message: string) {
  if (typeof value !== "string" || !value) throw new Error(message);
  const parsed = new URL(value);
  if (!["http:", "https:"].includes(parsed.protocol)) throw new Error(message);
}

export function narrowAuthorizationEnvelopeScopes(envelope: AuthorizationEnvelope, requestedScope: string | undefined): AuthorizationEnvelope {
  const requestedScopes = normalizeRequestedScopes(requestedScope);
  if (!requestedScopes.length) return envelope;

  for (const requested of requestedScopes) {
    if (!envelope.grantedScopes.some((granted) => scopeSubsumes(granted, requested))) {
      throw new Error(`Requested scope is not permitted by the ticket: ${requested}`);
    }
  }

  const narrowed = compileScopes(requestedScopes);
  return {
    ...envelope,
    scope: narrowed.scopeString,
    grantedScopes: narrowed.scopeStrings,
    allowedResourceTypes: narrowed.allowedResourceTypes,
    granularCategoryRules: narrowed.granularCategoryRules,
    requiredLabelsAll: narrowed.requiredLabelsAll,
    deniedLabelsAny: narrowed.deniedLabelsAny,
  };
}

export function compileClientCredentialsScopeRequest(
  requestedScope: string | undefined,
  registeredScope: string | undefined = undefined,
) {
  const requestedScopes = normalizeRequestedScopes(requestedScope);
  const registeredScopes = normalizeRequestedScopes(registeredScope);
  const effectiveScopes = requestedScopes.length ? requestedScopes : registeredScopes;
  if (!effectiveScopes.length) throw new Error("client_credentials requests must include at least one system scope");

  for (const scope of effectiveScopes) {
    const parsed = parseSmartScope(scope);
    if (parsed.principal !== "system") {
      throw new Error(`client_credentials requests only support system scopes: ${scope}`);
    }
  }

  if (requestedScopes.length && registeredScopes.length) {
    for (const scope of requestedScopes) {
      if (!registeredScopes.some((registered) => scopeSubsumes(registered, scope))) {
        throw new Error(`client_credentials scope is not permitted by the registered client scope: ${scope}`);
      }
    }
  }

  return compileScopes(effectiveScopes);
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

function validateSubjectConsistency(subject: PermissionTicket["authorization"]["subject"]) {
  switch (subject.type) {
    case "match":
      if (subject.id || subject.reference || subject.identifier?.length || subject.resourceType) {
        throw new Error("Subject type inconsistent with populated fields");
      }
      if (!subject.traits) throw new Error("Match subject missing traits");
      return;
    case "identifier":
      if (subject.id || subject.reference || subject.resourceType || subject.traits) {
        throw new Error("Subject type inconsistent with populated fields");
      }
      if (!subject.identifier?.length) throw new Error("Identifier subject missing identifier");
      return;
    case "reference":
      if (subject.identifier?.length || subject.traits) {
        throw new Error("Subject type inconsistent with populated fields");
      }
      if (subject.reference) return;
      if (subject.resourceType && subject.id) return;
      throw new Error("Reference subject missing reference");
  }
}

function validateSupportedAccessConstraints(access: PermissionTicket["authorization"]["access"]) {
  const supportedKeys = new Set(["scopes", "periods", "jurisdictions", "organizations"]);
  for (const key of Object.keys(access)) {
    if (!supportedKeys.has(key)) throw new Error(`Unsupported access constraint: ${key}`);
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
    const parsed = parseSmartScope(scope);
    const { resourceToken, permissions, query } = parsed;
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

type ParsedSmartScope = {
  raw: string;
  principal: "patient" | "user" | "system";
  resourceToken: string;
  permissions: string;
  query: string | undefined;
};

function parseSmartScope(scope: string): ParsedSmartScope {
  const match = scope.match(/^(patient|user|system)\/([A-Za-z*]+)\.([a-z*]+)(?:\?(.*))?$/);
  if (!match) throw new Error(`Unsupported SMART scope syntax: ${scope}`);
  const [, principal, resourceToken, permissions, query] = match;
  return {
    raw: scope,
    principal: principal as ParsedSmartScope["principal"],
    resourceToken,
    permissions,
    query: query || undefined,
  };
}

function normalizeRequestedScopes(scope: string | undefined) {
  if (!scope) return [];
  return [...new Set(scope.split(/\s+/).map((entry) => entry.trim()).filter(Boolean))];
}

function scopeSubsumes(grantedScope: string, requestedScope: string) {
  const granted = parseSmartScope(grantedScope);
  const requested = parseSmartScope(requestedScope);

  if (granted.principal !== requested.principal) return false;
  if (granted.permissions !== "*" && ![...requested.permissions].every((permission) => granted.permissions.includes(permission))) {
    return false;
  }
  if (granted.resourceToken !== "*" && granted.resourceToken !== requested.resourceToken) return false;
  if (!granted.query) return true;
  if (!requested.query) return false;
  return granted.query === requested.query;
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
