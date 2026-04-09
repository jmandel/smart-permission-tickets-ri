import { createHash } from "crypto";

export function buildBundle(resources: any[]): any {
  return {
    resourceType: "Bundle",
    type: "collection",
    timestamp: new Date().toISOString(),
    entry: resources.map(resource => ({
      fullUrl: bundleEntryFullUrlForResource(resource),
      resource,
    })),
  };
}

export function bundleEntryFullUrlForResource(resource: any): string {
  const resourceId = typeof resource?.id === "string" ? resource.id : "";
  return `urn:uuid:${bundleEntryUuidForResourceId(resourceId)}`;
}

export function bundleEntryUuidForResourceId(resourceId: string): string {
  if (isUuid(resourceId)) {
    return resourceId.toLowerCase();
  }

  // Deterministically map non-UUID resource ids into UUID-shaped Bundle.fullUrl values.
  const digest = createHash("sha1")
    .update(`smart-permission-ticket-demo-bundle-fullurl\0${resourceId}`)
    .digest();
  const bytes = Uint8Array.from(digest.subarray(0, 16));
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, byte => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

export function isUuid(value: string): boolean {
  return /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(value);
}

export function normalizeBundleEntryFullUrls(bundle: any): { changedEntries: number } {
  const entries = Array.isArray(bundle?.entry) ? bundle.entry : [];
  let changedEntries = 0;

  for (const entry of entries) {
    const expected = bundleEntryFullUrlForResource(entry?.resource);
    if (entry?.fullUrl !== expected) {
      entry.fullUrl = expected;
      changedEntries++;
    }
  }

  return { changedEntries };
}
