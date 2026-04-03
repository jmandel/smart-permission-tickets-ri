import {
  IDENTITY_TYPES,
  SECURITY_SYSTEM,
  type SearchDate,
  type SearchRef,
  type SearchString,
  type SearchToken,
} from "./model.ts";
import { sourceLookupKeyForReference } from "./ids.ts";
import { extractConfiguredCareWindow, type CareWindow } from "./care-date.ts";
import { extractConfiguredGeneratedWindow, type GeneratedWindow } from "./generated-date.ts";
import { asArray, normalizeDate, normalizeInstant, normalizeText } from "./path-utils.ts";

export function rewriteResourceJson(resource: any, context: { siteSlug: string; localPatientSourceRef: string }, sourceLookup: Map<string, string>) {
  const cloned = structuredClone(resource);
  rewriteNode(cloned, context, sourceLookup);
  return cloned;
}

export function extractTokens(resource: any): SearchToken[] {
  const tokens: SearchToken[] = [];
  addCodableTokens(tokens, "category", resource.category);
  addCodableTokens(tokens, "code", resource.code);
  addCodableTokens(tokens, "type", resource.type);
  addCodableTokens(tokens, "class", resource.class);
  addStringToken(tokens, "status", resource.status);
  addCodableTokens(tokens, "clinical-status", resource.clinicalStatus);
  addCodableTokens(tokens, "verification-status", resource.verificationStatus);
  addCodableTokens(tokens, "intent", resource.intent);
  addIdentifierTokens(tokens, resource.identifier);
  return tokens;
}

export function extractStrings(resource: any): SearchString[] {
  const strings: SearchString[] = [];
  if (resource.resourceType === "Patient") {
    for (const name of resource.name ?? []) {
      if (name.family) addString(strings, "family", String(name.family));
      for (const given of name.given ?? []) addString(strings, "given", String(given));
      for (const part of [name.text, name.family, ...(name.given ?? [])]) {
        if (part) addString(strings, "name", String(part));
      }
    }
    if (resource.gender) addString(strings, "gender", String(resource.gender));
    if (resource.birthDate) addString(strings, "birthdate", String(resource.birthDate));
  }
  if (resource.resourceType === "Organization" && resource.name) {
    addString(strings, "name", String(resource.name));
  }
  return dedupeStrings(strings);
}

export function extractReferences(resource: any): SearchRef[] {
  const refs: SearchRef[] = [];
  const add = (paramName: string, ref: string | undefined) => {
    if (!ref) return;
    const [targetType, targetLogicalId] = ref.includes("/") ? ref.split("/", 2) : [null, null];
    refs.push({ paramName, targetType, targetLogicalId, targetRef: ref });
  };
  add("subject", resource.subject?.reference);
  add("patient", resource.patient?.reference);
  add("encounter", resource.encounter?.reference);
  add("serviceProvider", resource.serviceProvider?.reference);
  for (const performer of asArray(resource.performer)) add("performer", performer.reference);
  for (const result of asArray(resource.result)) add("result", result.reference);
  for (const reasonRef of asArray(resource.reasonReference)) add("reasonReference", reasonRef.reference);
  for (const basedOn of asArray(resource.basedOn)) add("basedOn", basedOn.reference);
  for (const location of asArray(resource.location)) add("location", location.location?.reference ?? location.reference);
  for (const participant of asArray(resource.participant)) add("participant", participant.individual?.reference);
  return refs;
}

export function extractLabels(resource: any, siteSlug: string): Array<{ kind: string; system: string; code: string }> {
  const labels: Array<{ kind: string; system: string; code: string }> = [];
  for (const security of resource.meta?.security ?? []) {
    if (security.system && security.code) labels.push({ kind: "security", system: security.system, code: security.code });
  }
  if (hasCategory(resource, "http://hl7.org/fhir/us/core/CodeSystem/us-core-documentreference-category", "clinical-note")) {
    labels.push({ kind: "security", system: SECURITY_SYSTEM, code: "clinical-note" });
  }
  if (siteSlug.includes("womens-health")) labels.push({ kind: "security", system: SECURITY_SYSTEM, code: "reproductive-health" });
  if (siteSlug.includes("tb-clinic")) labels.push({ kind: "security", system: SECURITY_SYSTEM, code: "infectious-disease" });
  if (siteSlug.includes("retina-specialists")) labels.push({ kind: "security", system: SECURITY_SYSTEM, code: "vision" });
  if (siteSlug.includes("nephrology")) labels.push({ kind: "security", system: SECURITY_SYSTEM, code: "renal" });
  if (siteSlug.includes("heart")) labels.push({ kind: "security", system: SECURITY_SYSTEM, code: "cardiology" });
  return dedupeLabels(labels);
}

export function extractCareWindow(resource: any): CareWindow {
  const direct = extractConfiguredCareWindow(resource);
  if (direct.careStart) return direct;
  if (IDENTITY_TYPES.has(resource.resourceType)) {
    return { careStart: null, careEnd: null, careSourceRule: null, careSourceKind: "identity-exempt" };
  }
  return direct;
}

export function extractGeneratedWindow(resource: any): GeneratedWindow {
  const direct = extractConfiguredGeneratedWindow(resource);
  if (direct.generatedStart) return direct;
  if (IDENTITY_TYPES.has(resource.resourceType)) {
    return { generatedStart: null, generatedEnd: null, generatedSourceRule: null, generatedSourceKind: "identity-exempt" };
  }
  return direct;
}

export function extractSearchDates(resource: any): SearchDate[] {
  const dates: SearchDate[] = [];
  const addInstant = (paramName: string, value: unknown) => {
    const date = normalizeInstant(value) ?? normalizeDate(value);
    if (date) dates.push({ paramName, start: date, end: date });
  };
  const addPeriod = (paramName: string, startValue: unknown, endValue: unknown) => {
    const start = normalizeDate(startValue) ?? normalizeInstant(startValue);
    const end = normalizeDate(endValue) ?? normalizeInstant(endValue) ?? start;
    if (start) dates.push({ paramName, start, end: end ?? start });
  };

  if (resource.meta?.lastUpdated) addInstant("_lastUpdated", resource.meta.lastUpdated);

  switch (resource.resourceType) {
    case "Patient":
      if (resource.birthDate) addInstant("birthdate", resource.birthDate);
      break;
    case "Observation":
      addPeriod("date", resource.effectivePeriod?.start, resource.effectivePeriod?.end);
      if (resource.effectiveDateTime) addInstant("date", resource.effectiveDateTime);
      if (resource.issued) addInstant("date", resource.issued);
      break;
    case "DiagnosticReport":
      addPeriod("date", resource.effectivePeriod?.start, resource.effectivePeriod?.end);
      if (resource.effectiveDateTime) addInstant("date", resource.effectiveDateTime);
      if (resource.issued) addInstant("date", resource.issued);
      break;
    case "DocumentReference":
      if (resource.date) addInstant("date", resource.date);
      addPeriod("period", resource.context?.period?.start, resource.context?.period?.end);
      break;
    case "Encounter":
      addPeriod("date", resource.period?.start, resource.period?.end);
      break;
    case "MedicationRequest":
      if (resource.authoredOn) addInstant("authoredon", resource.authoredOn);
      break;
    case "Condition":
      if (resource.recordedDate) addInstant("recorded-date", resource.recordedDate);
      break;
    case "Procedure":
      addPeriod("date", resource.performedPeriod?.start, resource.performedPeriod?.end);
      if (resource.performedDateTime) addInstant("date", resource.performedDateTime);
      break;
    case "Immunization":
      if (resource.occurrenceDateTime) addInstant("date", resource.occurrenceDateTime);
      break;
    case "ServiceRequest":
      if (resource.authoredOn) addInstant("authoredon", resource.authoredOn);
      if (resource.occurrenceDateTime) addInstant("date", resource.occurrenceDateTime);
      break;
  }
  return dedupeDates(dates);
}

function rewriteNode(node: any, context: { siteSlug: string; localPatientSourceRef: string }, sourceLookup: Map<string, string>) {
  if (Array.isArray(node)) {
    for (const item of node) rewriteNode(item, context, sourceLookup);
    return;
  }
  if (!node || typeof node !== "object") return;
  for (const [key, value] of Object.entries(node)) {
    if (key === "reference" && typeof value === "string") {
      node[key] = rewriteReference(value, context, sourceLookup);
      continue;
    }
    rewriteNode(value, context, sourceLookup);
  }
}

function rewriteReference(sourceRef: string, context: { siteSlug: string; localPatientSourceRef: string }, sourceLookup: Map<string, string>) {
  const [resourceType, sourceLogicalId] = sourceRef.split("/", 2);
  if (!resourceType || !sourceLogicalId) return sourceRef;
  const key = sourceLookupKeyForReference(context.siteSlug, context.localPatientSourceRef, resourceType, sourceLogicalId);
  return sourceLookup.get(key) ?? sourceRef;
}

function addIdentifierTokens(tokens: SearchToken[], identifiers: any[] | undefined) {
  for (const identifier of identifiers ?? []) {
    tokens.push({
      paramName: "identifier",
      system: typeof identifier.system === "string" ? identifier.system : null,
      code: typeof identifier.value === "string" ? identifier.value : null,
      textValue: typeof identifier.value === "string" ? identifier.value : null,
    });
  }
}

function addCodableTokens(tokens: SearchToken[], paramName: string, value: any) {
  if (!value) return;
  if (Array.isArray(value)) {
    for (const item of value) addCodableTokens(tokens, paramName, item);
    return;
  }
  if (typeof value === "string") {
    addStringToken(tokens, paramName, value);
    return;
  }
  if (typeof value === "object" && Array.isArray(value.coding)) {
    for (const coding of value.coding) {
      tokens.push({
        paramName,
        system: typeof coding.system === "string" ? coding.system : null,
        code: typeof coding.code === "string" ? coding.code : null,
        textValue: typeof value.text === "string" ? value.text : typeof coding.display === "string" ? coding.display : null,
      });
    }
    if (!value.coding.length && typeof value.text === "string") {
      tokens.push({ paramName, system: null, code: null, textValue: value.text });
    }
    return;
  }
  if (typeof value === "object" && ("code" in value || "system" in value)) {
    tokens.push({
      paramName,
      system: typeof value.system === "string" ? value.system : null,
      code: typeof value.code === "string" ? value.code : null,
      textValue: typeof value.display === "string" ? value.display : typeof value.text === "string" ? value.text : null,
    });
  }
}

function addStringToken(tokens: SearchToken[], paramName: string, value: any) {
  if (typeof value !== "string") return;
  tokens.push({ paramName, system: null, code: value, textValue: value });
}

function addString(strings: SearchString[], paramName: string, value: string) {
  const norm = normalizeText(value);
  if (!norm) return;
  strings.push({ paramName, value, normValue: norm });
}

function hasCategory(resource: any, system: string, code: string) {
  for (const concept of resource.category ?? []) {
    for (const coding of concept.coding ?? []) {
      if (coding.system === system && coding.code === code) return true;
    }
  }
  return false;
}

function dedupeLabels(labels: Array<{ kind: string; system: string; code: string }>) {
  const seen = new Set<string>();
  return labels.filter((label) => {
    const key = `${label.kind}|${label.system}|${label.code}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function dedupeStrings(strings: SearchString[]) {
  const seen = new Set<string>();
  return strings.filter((entry) => {
    const key = `${entry.paramName}|${entry.normValue}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function dedupeDates(dates: SearchDate[]) {
  const seen = new Set<string>();
  return dates.filter((entry) => {
    const key = `${entry.paramName}|${entry.start}|${entry.end}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
