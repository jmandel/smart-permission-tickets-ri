import { SECURITY_SYSTEM, IDENTITY_TYPES } from "./model.ts";
import { sourceLookupKeyForReference } from "./ids.ts";
import { extractConfiguredCareWindow, type CareWindow } from "./care-date.ts";
import { extractConfiguredGeneratedWindow, type GeneratedWindow } from "./generated-date.ts";

export function rewriteResourceJson(resource: any, context: { siteSlug: string; localPatientSourceRef: string }, sourceLookup: Map<string, string>) {
  const cloned = structuredClone(resource);
  rewriteNode(cloned, context, sourceLookup);
  return cloned;
}

export function extractTokens(resource: any): Array<{ paramName: string; system: string | null; code: string | null; textValue: string | null }> {
  const tokens: Array<{ paramName: string; system: string | null; code: string | null; textValue: string | null }> = [];

  addCodableTokens(tokens, "category", resource.category);
  addCodableTokens(tokens, "code", resource.code);
  addCodableTokens(tokens, "type", resource.type);
  addCodableTokens(tokens, "class", resource.class);
  addStringToken(tokens, "status", resource.status);
  addCodableTokens(tokens, "clinical-status", resource.clinicalStatus);
  addCodableTokens(tokens, "verification-status", resource.verificationStatus);
  addCodableTokens(tokens, "intent", resource.intent);

  return tokens;
}

export function extractReferences(resource: any): Array<{ paramName: string; targetType: string | null; targetLogicalId: string | null; targetRef: string }> {
  const refs: Array<{ paramName: string; targetType: string | null; targetLogicalId: string | null; targetRef: string }> = [];
  const add = (paramName: string, ref: string | undefined) => {
    if (!ref) return;
    const [targetType, targetLogicalId] = ref.includes("/") ? ref.split("/", 2) : [null, null];
    refs.push({ paramName, targetType, targetLogicalId, targetRef: ref });
  };

  add("subject", resource.subject?.reference);
  add("patient", resource.patient?.reference);
  add("encounter", resource.encounter?.reference);
  add("serviceProvider", resource.serviceProvider?.reference);
  add("location", resource.location?.reference);
  for (const performer of asArray(resource.performer)) add("performer", performer.reference);
  for (const result of asArray(resource.result)) add("result", result.reference);
  for (const reasonRef of asArray(resource.reasonReference)) add("reasonReference", reasonRef.reference);
  for (const basedOn of asArray(resource.basedOn)) add("basedOn", basedOn.reference);
  for (const location of asArray(resource.location)) add("location", location.location?.reference);
  for (const participant of asArray(resource.participant)) add("participant", participant.individual?.reference);

  return refs;
}

export function extractLabels(resource: any, siteSlug: string): Array<{ kind: string; system: string; code: string }> {
  const labels: Array<{ kind: string; system: string; code: string }> = [];
  for (const tag of resource.meta?.tag ?? []) {
    if (tag.system && tag.code) labels.push({ kind: "tag", system: tag.system, code: tag.code });
  }
  for (const sec of resource.meta?.security ?? []) {
    if (sec.system && sec.code) labels.push({ kind: "security", system: sec.system, code: sec.code });
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
    return {
      careStart: null,
      careEnd: null,
      careSourceRule: null,
      careSourceKind: "identity-exempt",
    };
  }
  return direct;
}

export function extractGeneratedWindow(resource: any): GeneratedWindow {
  const direct = extractConfiguredGeneratedWindow(resource);
  if (direct.generatedStart) return direct;
  if (IDENTITY_TYPES.has(resource.resourceType)) {
    return {
      generatedStart: null,
      generatedEnd: null,
      generatedSourceRule: null,
      generatedSourceKind: "identity-exempt",
    };
  }
  return direct;
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
  const lookupKey = sourceLookupKeyForReference(context.siteSlug, context.localPatientSourceRef, resourceType, sourceLogicalId);
  return sourceLookup.get(lookupKey) ?? sourceRef;
}

function addCodableTokens(
  tokens: Array<{ paramName: string; system: string | null; code: string | null; textValue: string | null }>,
  paramName: string,
  value: any,
) {
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
        system: stringOrNull(coding.system),
        code: stringOrNull(coding.code),
        textValue: stringOrNull(value.text ?? coding.display),
      });
    }
    if (!value.coding.length && value.text) {
      tokens.push({ paramName, system: null, code: null, textValue: String(value.text) });
    }
    return;
  }
  if (typeof value === "object" && ("code" in value || "system" in value)) {
    tokens.push({
      paramName,
      system: stringOrNull(value.system),
      code: stringOrNull(value.code),
      textValue: stringOrNull(value.display ?? value.text),
    });
  }
}

function addStringToken(
  tokens: Array<{ paramName: string; system: string | null; code: string | null; textValue: string | null }>,
  paramName: string,
  value: any,
) {
  if (typeof value !== "string") return;
  tokens.push({ paramName, system: null, code: value, textValue: value });
}

function hasCategory(resource: any, system: string, code: string): boolean {
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

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function asArray<T>(value: T | T[] | null | undefined): T[] {
  if (value == null) return [];
  return Array.isArray(value) ? value : [value];
}
