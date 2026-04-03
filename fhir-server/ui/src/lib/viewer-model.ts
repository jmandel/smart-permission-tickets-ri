import type { ViewerLaunch, ViewerLaunchSite } from "../types";
import { resourcePrimaryDisplay } from "../../../shared/resource-display.ts";

export type ViewerSiteRun = {
  site: ViewerLaunchSite;
  patientId: string | null;
  phase: "idle" | "loading-config" | "registering-client" | "exchanging-token" | "introspecting-token" | "loading-data" | "ready" | "error";
  smartConfig: Record<string, any> | null;
  capabilityStatement: Record<string, any> | null;
  tokenResponse: Record<string, any> | null;
  tokenClaims: Record<string, any> | null;
  introspection: Record<string, any> | null;
  proofJkt: string | null;
  error: string | null;
  queryErrors: Array<{ label: string; relativePath: string; message: string }>;
  resources: ViewerResourceItem[];
};

export type ViewerQuerySpec = {
  key: string;
  label: string;
  resourceType: string;
  relativePath: string;
  kind: "patient-read" | "patient-search" | "site-search";
};

export type ViewerResourceItem = {
  key: string;
  siteSlug: string;
  siteName: string;
  siteJurisdiction: string | null;
  resourceType: string;
  id: string;
  label: string;
  sublabel: string | null;
  timelineDate: string | null;
  encounterRef: string | null;
  fullUrl: string | null;
  resource: any;
};

export type ViewerTimelineEntry = {
  key: string;
  siteSlug: string;
  siteName: string;
  resourceType: string;
  id: string;
  title: string;
  subtitle: string | null;
  date: string;
  fullUrl: string | null;
};

export type ViewerEncounterGroup = {
  key: string;
  siteSlug: string;
  siteName: string;
  siteJurisdiction: string | null;
  encounterId: string;
  title: string;
  summary: string | null;
  status: string | null;
  startDate: string | null;
  endDate: string | null;
  fullUrl: string | null;
  encounter: ViewerResourceItem;
  resources: ViewerResourceItem[];
  notes: ViewerResourceItem[];
  resourceCounts: Record<string, number>;
};

export type ViewerEncounterLane = {
  siteSlug: string;
  siteName: string;
  siteJurisdiction: string | null;
  encounters: ViewerEncounterGroup[];
};

export type ViewerEncounterDashboard = {
  lanes: ViewerEncounterLane[];
  encounters: ViewerEncounterGroup[];
  unassignedResources: ViewerResourceItem[];
};

export type ViewerEncounterScale = {
  start: string;
  end: string;
  totalDays: number;
};

export function buildSiteQueryPlan(
  launch: ViewerLaunch,
  site: ViewerLaunchSite,
  patientId: string,
  capabilityStatement: Record<string, any> | null,
): ViewerQuerySpec[] {
  const capability = parseCapabilityStatement(capabilityStatement);
  const scopes = launch.ticketPayload?.authorization?.access?.scopes;
  if (!Array.isArray(scopes) || !scopes.length || scopes.includes("patient/*.rs")) {
    return buildCapabilityQueries(site, patientId, capability);
  }

  const queries = new Map<string, ViewerQuerySpec>();
  for (const scope of scopes) {
    const parsed = parseScope(String(scope), patientId, capability);
    if (!parsed) continue;
    queries.set(parsed.key, parsed);
  }
  addSupportingContextQueries(queries, site, capability);
  if (!queries.size) return buildCapabilityQueries(site, patientId, capability);
  return [...queries.values()];
}

export function buildTimeline(resources: ViewerResourceItem[]): ViewerTimelineEntry[] {
  return resources
    .filter((item) => item.timelineDate)
    .map((item) => ({
      key: item.key,
      siteSlug: item.siteSlug,
      siteName: item.siteName,
      resourceType: item.resourceType,
      id: item.id,
      title: item.label,
      subtitle: item.sublabel,
      date: item.timelineDate!,
      fullUrl: item.fullUrl,
    }))
    .sort((left, right) => right.date.localeCompare(left.date));
}

export function buildEncounterDashboard(resources: ViewerResourceItem[]): ViewerEncounterDashboard {
  const encounterGroups = new Map<string, ViewerEncounterGroup>();
  const unassignedResources: ViewerResourceItem[] = [];

  for (const item of resources) {
    if (item.resourceType !== "Encounter") continue;
    const startDate = encounterStartDate(item.resource) ?? item.timelineDate;
    const endDate = encounterEndDate(item.resource) ?? startDate;
    const encounterId = `Encounter/${item.id}`;
      encounterGroups.set(encounterBucketKey(item.siteSlug, encounterId), {
        key: item.key,
        siteSlug: item.siteSlug,
        siteName: item.siteName,
        siteJurisdiction: item.siteJurisdiction,
        encounterId,
        title: item.label,
      summary: encounterSummary(item.resource),
      status: item.resource?.status ?? null,
      startDate,
      endDate,
      fullUrl: item.fullUrl,
      encounter: item,
      resources: [],
      notes: [],
      resourceCounts: {},
    });
  }

  for (const item of resources) {
    if (item.resourceType === "Encounter") continue;
    if (!item.encounterRef) {
      unassignedResources.push(item);
      continue;
    }
    const bucket = encounterGroups.get(encounterBucketKey(item.siteSlug, item.encounterRef));
    if (!bucket) {
      unassignedResources.push(item);
      continue;
    }
    bucket.resources.push(item);
    bucket.resourceCounts[item.resourceType] = (bucket.resourceCounts[item.resourceType] ?? 0) + 1;
    if (item.resourceType === "DocumentReference") bucket.notes.push(item);
  }

  const encounters = [...encounterGroups.values()]
    .map((bucket) => ({
      ...bucket,
      resources: bucket.resources.sort(compareResourceItems),
      notes: bucket.notes.sort(compareResourceItems),
    }))
    .sort(compareEncounterGroups);

  const lanesMap = new Map<string, ViewerEncounterLane>();
  for (const encounter of encounters) {
    const lane = lanesMap.get(encounter.siteSlug) ?? {
      siteSlug: encounter.siteSlug,
      siteName: encounter.siteName,
      siteJurisdiction: encounter.siteJurisdiction,
      encounters: [],
    };
    lane.encounters.push(encounter);
    lanesMap.set(encounter.siteSlug, lane);
  }

  const lanes = [...lanesMap.values()]
    .map((lane) => ({
      ...lane,
      encounters: lane.encounters.sort(compareEncounterGroups),
    }))
    .sort((left, right) => left.siteName.localeCompare(right.siteName));

  return {
    lanes,
    encounters,
    unassignedResources: unassignedResources.sort(compareResourceItems),
  };
}

export function buildEncounterScale(encounters: ViewerEncounterGroup[]): ViewerEncounterScale | null {
  if (!encounters.length) return null;
  const starts = encounters.map((encounter) => encounter.startDate ?? encounter.endDate).filter((value): value is string => Boolean(value));
  const ends = encounters.map((encounter) => encounter.endDate ?? encounter.startDate).filter((value): value is string => Boolean(value));
  if (!starts.length || !ends.length) return null;
  const start = starts.sort((left, right) => left.localeCompare(right))[0]!;
  const end = ends.sort((left, right) => right.localeCompare(left))[0]!;
  return {
    start: start.slice(0, 10),
    end: end.slice(0, 10),
    totalDays: Math.max(diffDaysUtc(start, end) + 1, 1),
  };
}

export function addDaysUtc(start: string, days: number) {
  const date = new Date(`${start.slice(0, 10)}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

export function diffDaysUtc(start: string, end: string) {
  const startTime = Date.parse(`${start.slice(0, 10)}T00:00:00Z`);
  const endTime = Date.parse(`${end.slice(0, 10)}T00:00:00Z`);
  return Math.round((endTime - startTime) / 86400000);
}

export function encounterIntersects(encounter: ViewerEncounterGroup, rangeStart: string, rangeEnd: string) {
  const encounterStart = (encounter.startDate ?? encounter.endDate ?? "").slice(0, 10);
  const encounterEnd = (encounter.endDate ?? encounter.startDate ?? encounterStart).slice(0, 10);
  if (!encounterStart) return false;
  if (rangeStart && encounterEnd < rangeStart) return false;
  if (rangeEnd && encounterStart > rangeEnd) return false;
  return true;
}

export function groupResourcesByType(resources: ViewerResourceItem[]) {
  const groups = new Map<string, ViewerResourceItem[]>();
  for (const item of resources) {
    const existing = groups.get(item.resourceType) ?? [];
    existing.push(item);
    groups.set(item.resourceType, existing);
  }
  return [...groups.entries()]
    .map(([resourceType, items]) => ({
      resourceType,
      count: items.length,
      items: items.sort((left, right) => {
        const leftDate = left.timelineDate ?? "";
        const rightDate = right.timelineDate ?? "";
        if (leftDate !== rightDate) return rightDate.localeCompare(leftDate);
        return left.label.localeCompare(right.label);
      }),
    }))
    .sort((left, right) => left.resourceType.localeCompare(right.resourceType));
}

export function summarizeSiteResources(site: ViewerLaunchSite, payload: any, fullUrl: string | null): ViewerResourceItem[] {
  if (!payload) return [];
  if (payload.resourceType === "Bundle") {
    return (payload.entry ?? []).flatMap((entry: any) =>
      entry?.resource ? [summarizeResource(site, entry.resource, entry.fullUrl ?? null)] : [],
    );
  }
  return [summarizeResource(site, payload, fullUrl)];
}

function summarizeResource(site: ViewerLaunchSite, resource: any, fullUrl: string | null): ViewerResourceItem {
  return {
    key: `${site.siteSlug}:${resource.resourceType}/${resource.id}`,
    siteSlug: site.siteSlug,
    siteName: site.orgName,
    siteJurisdiction: site.jurisdiction ?? null,
    resourceType: String(resource.resourceType ?? "Resource"),
    id: String(resource.id ?? ""),
    label: resourceLabel(resource),
    sublabel: resourceSublabel(resource),
    timelineDate: resourceTimelineDate(resource),
    encounterRef: resourceEncounterRef(resource),
    fullUrl,
    resource,
  };
}

function buildCapabilityQueries(site: ViewerLaunchSite, patientId: string, capability: Map<string, Set<string>>): ViewerQuerySpec[] {
  return [...capability.entries()]
    .flatMap(([resourceType, searchParams]) => {
      if (resourceType === "Patient") return [defaultQueryForResourceType(resourceType, patientId)];
      if (searchParams.has("patient")) return [defaultQueryForResourceType(resourceType, patientId)];
      if (["Organization", "Practitioner", "Location"].includes(resourceType)) {
        return [
          {
            key: `${resourceType}:site`,
            label: resourceType,
            resourceType,
            relativePath: `${resourceType}?_count=100`,
            kind: "site-search" as const,
          },
        ];
      }
      return [];
    })
    .sort((left, right) => left.label.localeCompare(right.label));
}

function addSupportingContextQueries(
  queries: Map<string, ViewerQuerySpec>,
  site: ViewerLaunchSite,
  capability: Map<string, Set<string>>,
) {
  for (const resourceType of ["Organization", "Practitioner", "Location"]) {
    if (!capability.has(resourceType)) continue;
    const query = {
      key: `${resourceType}:site`,
      label: resourceType,
      resourceType,
      relativePath: `${resourceType}?_count=100`,
      kind: "site-search" as const,
    };
    queries.set(query.key, query);
  }
}

function defaultQueryForResourceType(resourceType: string, patientId: string): ViewerQuerySpec {
  if (resourceType === "Patient") {
    return {
      key: `Patient/${patientId}`,
      label: "Patient",
      resourceType,
      relativePath: `Patient/${encodeURIComponent(patientId)}`,
      kind: "patient-read",
    };
  }
  return {
    key: `${resourceType}:all`,
    label: resourceType,
    resourceType,
    relativePath: `${resourceType}?patient=${encodeURIComponent(patientId)}&_count=100`,
    kind: "patient-search",
  };
}

function parseScope(scope: string, patientId: string, capability: Map<string, Set<string>>): ViewerQuerySpec | null {
  const match = scope.match(/^[^/]+\/([A-Za-z*]+)\.rs(?:\?(.*))?$/);
  if (!match?.[1] || match[1] === "*") return null;
  const resourceType = match[1];
  const rawQuery = match[2];
  const searchParams = capability.get(resourceType);

  if (resourceType === "Patient") {
    return {
      key: `Patient/${patientId}`,
      label: "Patient",
      resourceType,
      relativePath: `Patient/${encodeURIComponent(patientId)}`,
      kind: "patient-read",
    };
  }

  if (!searchParams) return null;

  if (resourceType === "Organization" || resourceType === "Practitioner" || resourceType === "Location") {
    const relativePath = rawQuery ? `${resourceType}?${rawQuery}&_count=100` : `${resourceType}?_count=100`;
    return {
      key: `${resourceType}:${rawQuery ?? "all"}`,
      label: resourceType,
      resourceType,
      relativePath,
      kind: "site-search",
    };
  }

  if (!searchParams.has("patient")) return null;

  const separator = rawQuery ? `&${rawQuery}` : "";
  return {
    key: `${resourceType}:${rawQuery ?? "all"}`,
    label: humanScopeLabel(resourceType, rawQuery),
    resourceType,
    relativePath: `${resourceType}?patient=${encodeURIComponent(patientId)}${separator ? `${separator}` : ""}&_count=100`,
    kind: "patient-search",
  };
}

function humanScopeLabel(resourceType: string, rawQuery?: string) {
  if (!rawQuery) return resourceType;
  const params = new URLSearchParams(rawQuery);
  const category = params.get("category");
  if (!category) return resourceType;
  const [, code] = category.split("|");
  const label = code?.replace(/-/g, " ") ?? category;
  return `${resourceType} · ${label}`;
}

export function resourceTimelineDate(resource: any): string | null {
  const direct =
    resource.period?.start ??
    resource.effectiveDateTime ??
    resource.issued ??
    resource.authoredOn ??
    resource.date ??
    resource.recordedDate ??
    resource.onsetDateTime ??
    resource.occurrenceDateTime ??
    resource.performedDateTime ??
    resource.meta?.lastUpdated ??
    null;
  if (typeof direct === "string") return direct;
  if (typeof resource.performedPeriod?.start === "string") return resource.performedPeriod.start;
  if (typeof resource.context?.period?.start === "string") return resource.context.period.start;
  if (typeof resource.effectivePeriod?.start === "string") return resource.effectivePeriod.start;
  return null;
}

function resourceLabel(resource: any) {
  return resourcePrimaryDisplay(resource, `${resource.resourceType}/${resource.id}`);
}

function resourceSublabel(resource: any) {
  switch (resource.resourceType) {
    case "Patient":
      return [resource.birthDate, resource.gender].filter(Boolean).join(" · ") || null;
    case "Encounter":
      return [resource.period?.start?.slice(0, 10), resource.status].filter(Boolean).join(" · ") || null;
    case "Observation":
      return [resource.effectiveDateTime?.slice(0, 10), observationValue(resource), resource.status].filter(Boolean).join(" · ") || null;
    case "DiagnosticReport":
      return [resource.effectiveDateTime?.slice(0, 10) ?? resource.issued?.slice(0, 10), resource.status].filter(Boolean).join(" · ") || null;
    case "Condition":
      return [resource.clinicalStatus?.coding?.[0]?.code, resource.recordedDate?.slice(0, 10)].filter(Boolean).join(" · ") || null;
    case "MedicationRequest":
      return [resource.authoredOn?.slice(0, 10), resource.status, resource.intent].filter(Boolean).join(" · ") || null;
    case "DocumentReference":
      return [resource.date?.slice(0, 10), resource.status].filter(Boolean).join(" · ") || null;
    case "Procedure":
      return [resource.performedDateTime?.slice(0, 10), resource.status].filter(Boolean).join(" · ") || null;
    case "ServiceRequest":
      return [resource.authoredOn?.slice(0, 10), resource.status, resource.intent].filter(Boolean).join(" · ") || null;
    default:
      return null;
  }
}

function observationValue(resource: any) {
  if (resource.valueQuantity) {
    return `${resource.valueQuantity.value ?? ""} ${resource.valueQuantity.unit ?? ""}`.trim();
  }
  if (resource.valueCodeableConcept?.text) return resource.valueCodeableConcept.text;
  if (resource.valueString) return resource.valueString;
  return null;
}

function resourceEncounterRef(resource: any): string | null {
  const direct = normalizeReference(resource?.encounter?.reference, "Encounter");
  if (direct) return direct;
  if (Array.isArray(resource?.context?.encounter)) {
    for (const entry of resource.context.encounter) {
      const normalized = normalizeReference(entry?.reference, "Encounter");
      if (normalized) return normalized;
    }
  }
  return null;
}

function normalizeReference(reference: unknown, resourceType: string): string | null {
  if (typeof reference !== "string" || !reference) return null;
  const marker = `${resourceType}/`;
  const index = reference.lastIndexOf(marker);
  if (index < 0) return null;
  const id = reference.slice(index + marker.length).split(/[?#/]/, 1)[0];
  if (!id) return null;
  return `${resourceType}/${id}`;
}

function encounterBucketKey(siteSlug: string, encounterRef: string) {
  return `${siteSlug}:${encounterRef}`;
}

function encounterStartDate(resource: any): string | null {
  const value = resource?.period?.start ?? resourceTimelineDate(resource);
  return typeof value === "string" ? value : null;
}

function encounterEndDate(resource: any): string | null {
  const value = resource?.period?.end ?? encounterStartDate(resource);
  return typeof value === "string" ? value : null;
}

function encounterSummary(resource: any): string | null {
  const reason = resource?.reasonCode?.[0]?.text ?? resource?.reasonCode?.[0]?.coding?.[0]?.display ?? null;
  const type = resource?.type?.[0]?.text ?? resource?.type?.[0]?.coding?.[0]?.display ?? null;
  const extension = resource?.extension?.find?.((ext: any) => ext?.url?.includes("encounter-summary"));
  const summary = extension?.valueMarkdown ?? null;
  return summary ?? reason ?? type;
}

function compareEncounterGroups(left: ViewerEncounterGroup, right: ViewerEncounterGroup) {
  const leftDate = left.startDate ?? "";
  const rightDate = right.startDate ?? "";
  if (leftDate !== rightDate) return rightDate.localeCompare(leftDate);
  return left.title.localeCompare(right.title);
}

function compareResourceItems(left: ViewerResourceItem, right: ViewerResourceItem) {
  const leftDate = left.timelineDate ?? "";
  const rightDate = right.timelineDate ?? "";
  if (leftDate !== rightDate) return rightDate.localeCompare(leftDate);
  if (left.resourceType !== right.resourceType) return left.resourceType.localeCompare(right.resourceType);
  return left.label.localeCompare(right.label);
}

function parseCapabilityStatement(capabilityStatement: Record<string, any> | null) {
  const map = new Map<string, Set<string>>();
  for (const resource of capabilityStatement?.rest?.[0]?.resource ?? []) {
    const type = resource?.type;
    if (!type) continue;
    const searchParams = new Set<string>((resource.searchParam ?? []).map((param: any) => String(param.name)));
    map.set(String(type), searchParams);
  }
  return map;
}
