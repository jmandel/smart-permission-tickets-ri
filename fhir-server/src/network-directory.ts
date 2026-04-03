import type { ServerConfig } from "./config.ts";
import type { AuthorizationEnvelope, RouteContext } from "./store/model.ts";
import type { FhirStore, SiteSummary } from "./store/store.ts";
import { buildAuthBasePath, buildFhirBasePath } from "../shared/surfaces.ts";

const SITE_SLUG_SYSTEM = "urn:smart-permission-tickets:site-slug";
const NPI_SYSTEM = "http://hl7.org/fhir/sid/us-npi";
const ENDPOINT_CONNECTION_SYSTEM = "http://terminology.hl7.org/CodeSystem/endpoint-connection-type";

type NetworkDirectoryResource = {
  resourceType: "Endpoint" | "Organization";
  id: string;
  siteSlug: string;
  resource: any;
};

export function buildNetworkInfo(config: ServerConfig) {
  return {
    slug: config.defaultNetworkSlug,
    name: config.defaultNetworkName,
  };
}

export function buildNetworkCapabilityStatement(config: ServerConfig, url: URL, context: RouteContext) {
  const basePath = buildFhirBasePath(config.strictDefaultMode, context);
  const authBasePath = buildAuthBasePath(config.strictDefaultMode, context);
  return {
    resourceType: "CapabilityStatement",
    status: "active",
    kind: "instance",
    date: new Date().toISOString(),
    format: ["json"],
    fhirVersion: "4.0.1",
    implementation: {
      description: `${config.defaultNetworkName} directory and record-location service`,
      url: absoluteUrl(url, basePath),
    },
    rest: [
      {
        mode: "server",
        security: {
          extension: [
            {
              url: "http://fhir-registry.smarthealthit.org/StructureDefinition/oauth-uris",
              extension: [
                { url: "token", valueUri: absoluteUrl(url, `${authBasePath}/token`) },
                { url: "register", valueUri: absoluteUrl(url, `${authBasePath}/register`) },
              ],
            },
          ],
        },
        resource: [
          {
            type: "Endpoint",
            interaction: [{ code: "read" }, { code: "search-type" }],
            searchParam: [{ name: "_id", type: "token" }, { name: "identifier", type: "token" }, { name: "name", type: "string" }, { name: "organization", type: "reference" }],
          },
          {
            type: "Organization",
            interaction: [{ code: "read" }, { code: "search-type" }],
            searchParam: [{ name: "_id", type: "token" }, { name: "identifier", type: "token" }, { name: "name", type: "string" }],
          },
        ],
        operation: [
          {
            name: "resolve-record-locations",
            definition: "urn:smart-permission-tickets:OperationDefinition/resolve-record-locations",
          },
        ],
      },
    ],
  };
}

export function searchNetworkDirectory(
  config: ServerConfig,
  store: FhirStore,
  url: URL,
  context: RouteContext,
  resourceType: string,
  searchParams: URLSearchParams,
) {
  const resources = directoryResources(config, url, context, store.listSiteSummaries()).filter((resource) => resource.resourceType === resourceType);
  const filtered = resources.filter((resource) => matchesSearch(resource, searchParams));
  return buildBundle(
    filtered,
    absoluteUrl(url, `${buildFhirBasePath(config.strictDefaultMode, context)}/${resourceType}`),
    searchParams,
  );
}

export function readNetworkDirectory(
  config: ServerConfig,
  store: FhirStore,
  url: URL,
  context: RouteContext,
  resourceType: string,
  logicalId: string,
) {
  return directoryResources(config, url, context, store.listSiteSummaries()).find(
    (resource) => resource.resourceType === resourceType && resource.id === logicalId,
  )?.resource ?? null;
}

export function resolveRecordLocationsBundle(
  config: ServerConfig,
  store: FhirStore,
  url: URL,
  context: RouteContext,
  envelope: AuthorizationEnvelope,
) {
  const wantedSites = visibleSiteSlugs(store, envelope);
  const directory = directoryResources(config, url, context, store.listSiteSummaries()).filter((resource) => wantedSites.includes(resource.siteSlug));
  const endpoints = directory.filter((resource) => resource.resourceType === "Endpoint");
  const organizations = new Map(
    directory
      .filter((resource) => resource.resourceType === "Organization")
      .map((resource) => [resource.siteSlug, resource]),
  );

  return {
    resourceType: "Bundle",
    type: "collection",
    total: endpoints.length,
    entry: endpoints.flatMap((endpoint) => {
      const organization = organizations.get(endpoint.siteSlug);
      const entries: Array<Record<string, any>> = [
        {
          fullUrl: absoluteUrl(url, `${buildFhirBasePath(config.strictDefaultMode, context)}/Endpoint/${endpoint.id}`),
          resource: endpoint.resource,
        },
      ];
      if (organization) {
        entries.push({
          fullUrl: absoluteUrl(url, `${buildFhirBasePath(config.strictDefaultMode, context)}/Organization/${organization.id}`),
          resource: organization.resource,
          search: { mode: "include" },
        });
      }
      return entries;
    }),
  };
}

function visibleSiteSlugs(store: FhirStore, envelope: AuthorizationEnvelope) {
  const candidateSites = [...new Set(envelope.allowedPatientAliases.map((alias) => alias.siteSlug))]
    .filter((siteSlug) => (envelope.allowedSites ? envelope.allowedSites.includes(siteSlug) : true))
    .sort();
  return candidateSites.filter((siteSlug) => {
    const bound = bindEnvelopeToSite(envelope, siteSlug);
    return bound ? store.hasVisibleEncounter(bound, siteSlug) : false;
  });
}

function bindEnvelopeToSite(envelope: AuthorizationEnvelope, siteSlug: string): AuthorizationEnvelope | null {
  const allowedPatientAliases = envelope.allowedPatientAliases.filter((alias) => alias.siteSlug === siteSlug);
  if (!allowedPatientAliases.length) return null;
  return {
    ...envelope,
    allowedPatientAliases,
    allowedSites: [siteSlug],
  };
}

function directoryResources(config: ServerConfig, url: URL, context: RouteContext, sites: SiteSummary[]): NetworkDirectoryResource[] {
  return sites.flatMap((site) => {
    const organizationId = organizationIdFor(site.siteSlug);
    const endpointId = endpointIdFor(site.siteSlug);
    const siteContext: RouteContext = { mode: context.mode, siteSlug: site.siteSlug };
    const fhirBaseUrl = absoluteUrl(url, buildFhirBasePath(config.strictDefaultMode, siteContext));
    const organization = {
      resourceType: "Organization",
      id: organizationId,
      active: true,
      name: site.organizationName,
      identifier: [
        { system: SITE_SLUG_SYSTEM, value: site.siteSlug },
        ...(site.organizationNpi ? [{ system: NPI_SYSTEM, value: site.organizationNpi }] : []),
      ],
      ...(site.jurisdictions[0]
        ? { address: [{ state: site.jurisdictions[0] }] }
        : {}),
    };
    const endpoint = {
      resourceType: "Endpoint",
      id: endpointId,
      status: "active",
      name: `${site.organizationName} FHIR endpoint`,
      identifier: [{ system: SITE_SLUG_SYSTEM, value: site.siteSlug }],
      connectionType: {
        system: ENDPOINT_CONNECTION_SYSTEM,
        code: "hl7-fhir-rest",
        display: "HL7 FHIR",
      },
      managingOrganization: {
        reference: `Organization/${organizationId}`,
        display: site.organizationName,
      },
      address: fhirBaseUrl,
      payloadType: [{ text: "FHIR R4" }],
    };
    return [
      { resourceType: "Organization" as const, id: organizationId, siteSlug: site.siteSlug, resource: organization },
      { resourceType: "Endpoint" as const, id: endpointId, siteSlug: site.siteSlug, resource: endpoint },
    ];
  });
}

function matchesSearch(resource: NetworkDirectoryResource, searchParams: URLSearchParams) {
  for (const [key, value] of searchParams.entries()) {
    if (key === "_count" || key === "_offset" || key === "_summary") continue;
    if (key === "_id" && resource.id !== value) return false;
    if (key === "name") {
      const haystack = `${resource.resource.name ?? ""}`.trim().toLowerCase();
      if (!haystack.includes(value.trim().toLowerCase())) return false;
      continue;
    }
    if (key === "identifier") {
      const [system, code] = value.includes("|") ? value.split("|", 2) : [null, value];
      const found = (resource.resource.identifier ?? []).some(
        (identifier: any) =>
          (!system || identifier.system === system) &&
          identifier.value === code,
      );
      if (!found) return false;
      continue;
    }
    if (key === "organization" && resource.resourceType === "Endpoint") {
      const organizationRef = resource.resource.managingOrganization?.reference ?? "";
      if (organizationRef !== value && organizationRef !== `Organization/${value}`) return false;
      continue;
    }
  }
  return true;
}

function buildBundle(resources: NetworkDirectoryResource[], baseUrl: string, searchParams: URLSearchParams) {
  const summaryMode = searchParams.get("_summary");
  const total = resources.length;
  if (summaryMode === "count") {
    return {
      resourceType: "Bundle",
      type: "searchset",
      total,
      entry: [],
    };
  }

  let limit = Number(searchParams.get("_count") ?? 50);
  if (!Number.isFinite(limit) || limit < 0) limit = 50;
  limit = Math.min(limit, 200);
  let offset = Number(searchParams.get("_offset") ?? 0);
  if (!Number.isFinite(offset) || offset < 0) offset = 0;
  offset = Math.floor(offset);
  const page = resources.slice(offset, offset + limit);

  const selfParams = new URLSearchParams(searchParams);
  if (limit !== 50 || selfParams.has("_count")) selfParams.set("_count", String(limit));
  if (offset > 0 || selfParams.has("_offset")) selfParams.set("_offset", String(offset));
  else selfParams.delete("_offset");

  const links: Array<{ relation: string; url: string }> = [{ relation: "self", url: buildSearchUrl(baseUrl, selfParams) }];
  if (offset + page.length < total) {
    const nextParams = new URLSearchParams(selfParams);
    nextParams.set("_offset", String(offset + page.length));
    links.push({ relation: "next", url: buildSearchUrl(baseUrl, nextParams) });
  }

  return {
    resourceType: "Bundle",
    type: "searchset",
    total,
    link: links,
    entry: page.map((resource) => ({
      fullUrl: `${baseUrl}/${resource.id}`,
      resource: resource.resource,
    })),
  };
}

function buildSearchUrl(baseUrl: string, params: URLSearchParams) {
  const query = params.toString();
  return query ? `${baseUrl}?${query}` : baseUrl;
}

function organizationIdFor(siteSlug: string) {
  return `org-${siteSlug}`;
}

function endpointIdFor(siteSlug: string) {
  return `endpoint-${siteSlug}`;
}

function absoluteUrl(url: URL, path: string) {
  return `${url.origin}${path}`;
}
