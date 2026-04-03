import { createHash } from "node:crypto";

import type { ResourceDescriptor, ScopeClass } from "./model.ts";
import { SITE_SCOPED_TYPES } from "./model.ts";

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

function siteScopedSemanticKey(descriptor: Pick<ResourceDescriptor, "siteSlug" | "resourceType" | "sourceLogicalId" | "sourceJson">): string {
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
      if (coding.code === "NPI" && value) return value;
    }
  }
  return null;
}

function normalizeHumanName(value: any): string | null {
  if (!Array.isArray(value) || !value.length) return null;
  const name = value[0];
  const given = Array.isArray(name.given) ? name.given.map(normalizeText).filter(Boolean).join(" ") : "";
  const family = normalizeText(name.family) ?? "";
  const text = [given, family].filter(Boolean).join(" ").trim();
  return text || normalizeText(name.text);
}

function normalizeAddress(value: any): string {
  if (!value || typeof value !== "object") return "";
  const line = Array.isArray(value.line) ? value.line.map(normalizeText).filter(Boolean).join(" ") : "";
  return [line, normalizeText(value.city), normalizeText(value.state), normalizeText(value.postalCode)].filter(Boolean).join("|");
}

function normalizeText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase().replace(/\s+/g, " ");
  return normalized || null;
}
