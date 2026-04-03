import { createHash } from "node:crypto";

import type { ResourceDescriptor, ScopeClass } from "./model.ts";
import { SITE_SCOPED_TYPES } from "./model.ts";
import { normalizeText } from "./path-utils.ts";

export function scopeClassForResourceType(resourceType: string): ScopeClass {
  return SITE_SCOPED_TYPES.has(resourceType) ? "site" : "patient";
}

export function buildServerIdentity(descriptor: Omit<ResourceDescriptor, "serverKey" | "serverLogicalId" | "serverRef">) {
  const serverKey =
    descriptor.scopeClass === "site"
      ? `site|${descriptor.siteSlug}|${descriptor.resourceType}|${siteScopedSemanticKey(descriptor)}`
      : `patient|${descriptor.siteSlug}|${descriptor.localPatientSourceRef}|${descriptor.resourceType}|${descriptor.sourceLogicalId}`;
  const serverLogicalId = `r-${createHash("sha256").update(serverKey).digest("hex").slice(0, 32)}`;
  return {
    serverKey,
    serverLogicalId,
    serverRef: `${descriptor.resourceType}/${serverLogicalId}`,
  };
}

export function sourceLookupKeyForDescriptor(descriptor: Pick<ResourceDescriptor, "scopeClass" | "siteSlug" | "localPatientSourceRef" | "resourceType" | "sourceLogicalId">) {
  return descriptor.scopeClass === "site"
    ? `site|${descriptor.siteSlug}|${descriptor.resourceType}|${descriptor.sourceLogicalId}`
    : `patient|${descriptor.siteSlug}|${descriptor.localPatientSourceRef}|${descriptor.resourceType}|${descriptor.sourceLogicalId}`;
}

export function sourceLookupKeyForReference(siteSlug: string, localPatientSourceRef: string, resourceType: string, sourceLogicalId: string) {
  return scopeClassForResourceType(resourceType) === "site"
    ? `site|${siteSlug}|${resourceType}|${sourceLogicalId}`
    : `patient|${siteSlug}|${localPatientSourceRef}|${resourceType}|${sourceLogicalId}`;
}

function siteScopedSemanticKey(descriptor: Pick<ResourceDescriptor, "resourceType" | "siteSlug" | "sourceLogicalId" | "sourceJson">): string {
  const resource = descriptor.sourceJson;
  switch (descriptor.resourceType) {
    case "Organization":
      return findNpi(resource, true) ?? normalizeText(resource.name) ?? descriptor.sourceLogicalId;
    case "Practitioner":
    case "PractitionerRole":
      return findNpi(resource, false) ?? normalizeHumanName(resource.name) ?? descriptor.sourceLogicalId;
    case "Location":
      return `${normalizeText(resource.name) ?? descriptor.sourceLogicalId}|${normalizeAddress(resource.address)}`;
    default:
      return descriptor.sourceLogicalId;
  }
}

function findNpi(resource: any, _allowMetaTagFallback: boolean): string | null {
  for (const identifier of resource.identifier ?? []) {
    const system = normalizeText(identifier.system);
    const value = normalizeText(identifier.value);
    if (!value) continue;
    if (system?.includes("npi")) return value;
    for (const coding of identifier.type?.coding ?? []) {
      if (coding.code === "NPI") return value;
    }
  }
  return null;
}

function normalizeHumanName(value: any): string | null {
  if (!Array.isArray(value) || !value.length) return null;
  const first = value[0];
  const given = Array.isArray(first.given) ? first.given.map(normalizeText).filter(Boolean).join(" ") : "";
  const family = normalizeText(first.family) ?? "";
  const text = [given, family].filter(Boolean).join(" ").trim();
  return text || normalizeText(first.text);
}

function normalizeAddress(value: any): string {
  if (!value || typeof value !== "object") return "";
  const entries = Array.isArray(value) ? value : [value];
  const first = entries[0];
  const line = Array.isArray(first?.line) ? first.line.map(normalizeText).filter(Boolean).join(" ") : "";
  return [line, normalizeText(first?.city), normalizeText(first?.state), normalizeText(first?.postalCode)].filter(Boolean).join("|");
}
