import { decodeJwtPayload } from "../demo";
import type { AuthSurface, ModeName, RegisteredClientInfo, TokenResponseInfo, ViewerLaunchSite } from "../types";
import { signPrivateKeyJwt } from "../../../shared/private-key-jwt";
import { buildAuthSurface } from "./surfaces";

export async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  const data = await parseResponse(response);
  if (!response.ok) throw new Error(extractErrorMessage(data, `${response.status} ${url}`));
  return data as T;
}

export async function postJson<T>(url: string, body: Record<string, any>): Promise<T> {
  return fetchJson<T>(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

export async function postFormJson<T>(url: string, form: URLSearchParams, proofJkt?: string | null): Promise<T> {
  return fetchJson<T>(url, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      ...(proofJkt ? { "x-client-jkt": proofJkt } : {}),
    },
    body: form.toString(),
  });
}

export async function registerViewerClient(
  origin: string,
  surface: AuthSurface,
  clientName: string,
  publicJwk: JsonWebKey,
): Promise<RegisteredClientInfo> {
  const registration = await postJson<Record<string, any>>(`${origin}${surface.registerPath}`, {
    client_name: clientName,
    token_endpoint_auth_method: "private_key_jwt",
    jwk: publicJwk,
  });
  return {
    clientId: String(registration.client_id),
    clientName: String(registration.client_name ?? clientName),
    tokenEndpointAuthMethod: "private_key_jwt",
    publicJwk: (registration.jwks?.keys?.[0] ?? publicJwk) as JsonWebKey,
    jwkThumbprint: String(registration.jwk_thumbprint),
  };
}

export async function fetchSmartConfig(origin: string, surface: AuthSurface) {
  return fetchJson<Record<string, any>>(`${origin}${surface.smartConfigPath}`);
}

export async function fetchCapabilityStatement(origin: string, surface: AuthSurface) {
  return fetchJson<Record<string, any>>(`${origin}${surface.fhirBasePath}/metadata`);
}

export async function exchangeSurfaceToken(
  origin: string,
  surface: AuthSurface,
  signedTicket: string,
  client: RegisteredClientInfo | null,
  privateJwk: JsonWebKey | null,
  proofJkt: string | null,
) {
  const form = new URLSearchParams({
    grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
    subject_token_type: "https://smarthealthit.org/token-type/permission-ticket",
    subject_token: signedTicket,
  });
  if (client && privateJwk) {
    form.set("client_id", client.clientId);
    form.set("client_assertion_type", "urn:ietf:params:oauth:client-assertion-type:jwt-bearer");
    form.set(
      "client_assertion",
      await signPrivateKeyJwt(
        {
          iss: client.clientId,
          sub: client.clientId,
          aud: `${origin}${surface.tokenPath}`,
          iat: Math.floor(Date.now() / 1000),
          exp: Math.floor(Date.now() / 1000) + 300,
          jti: crypto.randomUUID(),
        },
        privateJwk as any,
      ),
    );
  }
  const tokenResponse = await postFormJson<TokenResponseInfo>(`${origin}${surface.tokenPath}`, form, proofJkt);
  const tokenClaims = decodeJwtPayload(tokenResponse.access_token) as Record<string, any>;
  return { tokenResponse, tokenClaims };
}

export async function introspectSurfaceToken(
  origin: string,
  surface: AuthSurface,
  accessToken: string,
  client: RegisteredClientInfo | null,
  privateJwk: JsonWebKey | null,
  proofJkt: string | null,
) {
  const form = new URLSearchParams({ token: accessToken });
  if (client && privateJwk) {
    form.set("client_id", client.clientId);
    form.set("client_assertion_type", "urn:ietf:params:oauth:client-assertion-type:jwt-bearer");
    form.set(
      "client_assertion",
      await signPrivateKeyJwt(
        {
          iss: client.clientId,
          sub: client.clientId,
          aud: `${origin}${surface.introspectPath}`,
          iat: Math.floor(Date.now() / 1000),
          exp: Math.floor(Date.now() / 1000) + 300,
          jti: crypto.randomUUID(),
        },
        privateJwk as any,
      ),
    );
  }
  return postFormJson<Record<string, any>>(`${origin}${surface.introspectPath}`, form, proofJkt);
}

export async function fetchSurfaceFhir(
  origin: string,
  surface: AuthSurface,
  relativePath: string,
  accessToken?: string | null,
  proofJkt?: string | null,
) {
  const headers: Record<string, string> = {};
  if (accessToken) headers.authorization = `Bearer ${accessToken}`;
  if (proofJkt) headers["x-client-jkt"] = proofJkt;
  return fetchJson<any>(`${origin}${surface.fhirBasePath}/${stripLeadingSlash(relativePath)}`, { headers });
}

export async function fetchPreviewSurfaceFhir(origin: string, surface: AuthSurface, relativePath: string) {
  return fetchJson<any>(`${origin}${surface.previewFhirBasePath}/${stripLeadingSlash(relativePath)}`);
}

export async function fetchSurfaceFhirAllPages(
  origin: string,
  surface: AuthSurface,
  relativePath: string,
  accessToken?: string | null,
  proofJkt?: string | null,
) {
  const headers: Record<string, string> = {};
  if (accessToken) headers.authorization = `Bearer ${accessToken}`;
  if (proofJkt) headers["x-client-jkt"] = proofJkt;
  return fetchPaginatedFhir(`${origin}${surface.fhirBasePath}/${stripLeadingSlash(relativePath)}`, headers);
}

export async function fetchPreviewSurfaceFhirAllPages(origin: string, surface: AuthSurface, relativePath: string) {
  return fetchPaginatedFhir(`${origin}${surface.previewFhirBasePath}/${stripLeadingSlash(relativePath)}`);
}

export async function resolveRecordLocations(
  origin: string,
  mode: ModeName,
  networkSurface: AuthSurface,
  accessToken: string,
  proofJkt?: string | null,
): Promise<{ bundle: any; sites: ViewerLaunchSite[] }> {
  const bundle = await postJsonWithBearer<any>(
    `${origin}${networkSurface.fhirBasePath}/$resolve-record-locations`,
    { resourceType: "Parameters" },
    accessToken,
    proofJkt,
  );
  const organizations = new Map<string, any>();
  for (const entry of bundle?.entry ?? []) {
    if (entry?.resource?.resourceType !== "Organization") continue;
    organizations.set(String(entry.resource.id ?? ""), entry.resource);
  }

  const sites = (bundle?.entry ?? [])
    .filter((entry: any) => entry?.resource?.resourceType === "Endpoint")
    .map((entry: any) => {
      const endpoint = entry.resource;
      const siteSlug = (endpoint.identifier ?? []).find((identifier: any) => identifier.system === "urn:smart-permission-tickets:site-slug")?.value;
      const organizationRef = endpoint.managingOrganization?.reference ?? "";
      const organizationId = organizationRef.split("/").at(-1) ?? undefined;
      const organization = organizationId ? organizations.get(organizationId) : null;
      const siteName = organization?.name ?? endpoint.managingOrganization?.display ?? siteSlug ?? "Unknown site";
      const jurisdiction = organization?.address?.[0]?.state ?? null;
      const patientId = endpoint.extension?.find?.(
        (extension: any) => extension?.url === "https://smarthealthit.org/fhir/StructureDefinition/smart-permission-tickets-site-patient",
      )?.valueReference?.reference?.split?.("/")?.at?.(1) ?? null;
      if (!siteSlug) return null;
      return {
        siteSlug,
        orgName: siteName,
        jurisdiction,
        patientId,
        endpointId: typeof endpoint.id === "string" ? endpoint.id : undefined,
        organizationId,
        authSurface: buildAuthSurface(mode, { siteSlug }),
      };
    })
    .filter((site: ViewerLaunchSite | null): site is ViewerLaunchSite => Boolean(site));

  return { bundle, sites };
}

export async function postJsonWithBearer<T>(url: string, body: Record<string, any>, accessToken: string, proofJkt?: string | null): Promise<T> {
  return fetchJson<T>(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${accessToken}`,
      ...(proofJkt ? { "x-client-jkt": proofJkt } : {}),
    },
    body: JSON.stringify(body),
  });
}

export async function exchangeSiteToken(origin: string, site: ViewerLaunchSite, signedTicket: string, client: RegisteredClientInfo | null, privateJwk: JsonWebKey | null, proofJkt: string | null) {
  return exchangeSurfaceToken(origin, site.authSurface, signedTicket, client, privateJwk, proofJkt);
}

export async function introspectSiteToken(origin: string, site: ViewerLaunchSite, accessToken: string, client: RegisteredClientInfo | null, privateJwk: JsonWebKey | null, proofJkt: string | null) {
  return introspectSurfaceToken(origin, site.authSurface, accessToken, client, privateJwk, proofJkt);
}

export async function fetchSiteFhir(origin: string, site: ViewerLaunchSite, relativePath: string, accessToken?: string | null, proofJkt?: string | null) {
  return fetchSurfaceFhir(origin, site.authSurface, relativePath, accessToken, proofJkt);
}

export async function fetchPreviewSiteFhir(origin: string, site: ViewerLaunchSite, relativePath: string) {
  return fetchPreviewSurfaceFhir(origin, site.authSurface, relativePath);
}

export async function fetchSiteFhirAllPages(origin: string, site: ViewerLaunchSite, relativePath: string, accessToken?: string | null, proofJkt?: string | null) {
  return fetchSurfaceFhirAllPages(origin, site.authSurface, relativePath, accessToken, proofJkt);
}

export async function fetchPreviewSiteFhirAllPages(origin: string, site: ViewerLaunchSite, relativePath: string) {
  return fetchPreviewSurfaceFhirAllPages(origin, site.authSurface, relativePath);
}

async function parseResponse(response: Response) {
  const contentType = response.headers.get("content-type") ?? "";
  if (contentType.includes("application/json") || contentType.includes("application/fhir+json")) {
    return response.json();
  }
  return response.text();
}

function extractErrorMessage(data: unknown, fallback: string) {
  if (!data) return fallback;
  if (typeof data === "string") return data;
  const diagnostics = (data as any)?.issue?.[0]?.diagnostics;
  return typeof diagnostics === "string" ? diagnostics : fallback;
}

function stripLeadingSlash(value: string) {
  return value.replace(/^\/+/, "");
}

async function fetchPaginatedFhir(url: string, headers?: HeadersInit) {
  const first = await fetchJson<any>(url, headers ? { headers } : undefined);
  if (first?.resourceType !== "Bundle") return first;

  const mergedEntries = [...(first.entry ?? [])];
  let next = bundleNextLink(first);

  while (next) {
    const page = await fetchJson<any>(next, headers ? { headers } : undefined);
    mergedEntries.push(...(page?.entry ?? []));
    next = bundleNextLink(page);
  }

  return {
    ...first,
    entry: mergedEntries,
    total: Number(first.total ?? mergedEntries.length),
  };
}

function bundleNextLink(bundle: any) {
  const next = (bundle?.link ?? []).find((entry: any) => entry?.relation === "next")?.url;
  return typeof next === "string" && next ? next : null;
}
