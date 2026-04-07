import { decodeJwtPayload } from "../demo";
import type { AuthSurface, ModeName, RegisteredClientInfo, TokenResponseInfo, ViewerClientPlan, ViewerLaunchSite } from "../types";
import { computeJwkThumbprint, signPrivateKeyJwt } from "../../../shared/private-key-jwt";
import { buildAuthSurface } from "./surfaces";

export async function fetchJson<T>(url: string, init?: RequestInit, demoSessionId?: string | null): Promise<T> {
  const response = await fetch(url, withDemoSession(init, demoSessionId));
  const data = await parseResponse(response);
  if (!response.ok) throw new Error(extractErrorMessage(data, `${response.status} ${url}`));
  return data as T;
}

export async function postJson<T>(url: string, body: Record<string, any>, demoSessionId?: string | null): Promise<T> {
  return fetchJson<T>(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }, demoSessionId);
}

export async function postFormJson<T>(url: string, form: URLSearchParams, proofJkt?: string | null, demoSessionId?: string | null): Promise<T> {
  return fetchJson<T>(url, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      ...(proofJkt ? { "x-client-jkt": proofJkt } : {}),
    },
    body: form.toString(),
  }, demoSessionId);
}

export async function registerViewerClient(
  origin: string,
  surface: AuthSurface,
  clientName: string,
  publicJwk: JsonWebKey,
  demoSessionId?: string | null,
): Promise<RegisteredClientInfo> {
  const registration = await postJson<Record<string, any>>(`${origin}${surface.registerPath}`, {
    client_name: clientName,
    token_endpoint_auth_method: "private_key_jwt",
    jwk: publicJwk,
  }, demoSessionId);
  return {
    clientId: String(registration.client_id),
    clientName: String(registration.client_name ?? clientName),
    tokenEndpointAuthMethod: "private_key_jwt",
    authMode: "unaffiliated",
    publicJwk: (registration.jwks?.keys?.[0] ?? publicJwk) as JsonWebKey,
    jwkThumbprint: String(registration.jwk_thumbprint),
    registrationResponse: registration,
  };
}

export async function prepareViewerClient(origin: string, surface: AuthSurface, clientPlan: ViewerClientPlan | null, demoSessionId?: string | null): Promise<RegisteredClientInfo | null> {
  if (!clientPlan) return null;
  if (clientPlan.type === "unaffiliated") {
    return registerViewerClient(origin, surface, clientPlan.clientName, clientPlan.publicJwk, demoSessionId);
  }
  if (clientPlan.type === "well-known") {
    return {
      clientId: `well-known:${clientPlan.entityUri}`,
      clientName: clientPlan.clientName,
      tokenEndpointAuthMethod: "private_key_jwt",
      authMode: "well-known",
      publicJwk: clientPlan.publicJwk,
      jwkThumbprint: await computeJwkThumbprint(clientPlan.publicJwk),
      framework: clientPlan.framework,
      entityUri: clientPlan.entityUri,
    };
  }
  if (clientPlan.type === "oidf") {
    return {
      clientId: clientPlan.entityUri,
      clientName: clientPlan.clientName,
      tokenEndpointAuthMethod: "private_key_jwt",
      authMode: "oidf",
      publicJwk: clientPlan.publicJwk,
      jwkThumbprint: await computeJwkThumbprint(clientPlan.publicJwk),
      framework: clientPlan.framework,
      entityUri: clientPlan.entityUri,
    };
  }

  const discovery = await fetchJson<Record<string, any>>(`${origin}${surface.fhirBasePath}/.well-known/udap`, undefined, demoSessionId);
  const registrationEndpoint = String(discovery.registration_endpoint ?? `${origin}${surface.registerPath}`);
  const softwareStatement = await buildUdapSoftwareStatement(registrationEndpoint, clientPlan);
  const registrationRequest = {
    udap: "1",
    software_statement: softwareStatement,
  };
  const registration = await postJson<Record<string, any>>(registrationEndpoint, registrationRequest, demoSessionId);
  return {
    clientId: String(registration.client_id),
    clientName: String(registration.client_name ?? clientPlan.clientName),
    tokenEndpointAuthMethod: "private_key_jwt",
    authMode: "udap",
    framework: clientPlan.framework,
    entityUri: clientPlan.entityUri,
    registrationRequest,
    registrationResponse: registration,
    softwareStatement,
  };
}

export async function fetchSmartConfig(origin: string, surface: AuthSurface, demoSessionId?: string | null) {
  return fetchJson<Record<string, any>>(`${origin}${surface.smartConfigPath}`, undefined, demoSessionId);
}

export async function fetchSmartConfigFromFhirBase(fhirBaseUrl: string, demoSessionId?: string | null) {
  return fetchJson<Record<string, any>>(`${trimTrailingSlash(fhirBaseUrl)}/.well-known/smart-configuration`, undefined, demoSessionId);
}

export async function fetchCapabilityStatement(origin: string, surface: AuthSurface, demoSessionId?: string | null) {
  return fetchJson<Record<string, any>>(`${origin}${surface.fhirBasePath}/metadata`, undefined, demoSessionId);
}

export async function fetchCapabilityStatementFromFhirBase(fhirBaseUrl: string, demoSessionId?: string | null) {
  return fetchJson<Record<string, any>>(`${trimTrailingSlash(fhirBaseUrl)}/metadata`, undefined, demoSessionId);
}

export async function exchangeSurfaceToken(
  origin: string,
  surface: AuthSurface,
  signedTicket: string,
  client: RegisteredClientInfo | null,
  clientPlan: ViewerClientPlan | null,
  proofJkt: string | null,
  demoSessionId?: string | null,
) {
  const form = new URLSearchParams({
    grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
    subject_token_type: "https://smarthealthit.org/token-type/permission-ticket",
    subject_token: signedTicket,
  });
  await appendClientAuth(form, `${origin}${surface.tokenPath}`, client, clientPlan);
  const tokenResponse = await postFormJson<TokenResponseInfo>(`${origin}${surface.tokenPath}`, form, proofJkt, demoSessionId);
  const tokenClaims = decodeJwtPayload(tokenResponse.access_token) as Record<string, any>;
  return { tokenResponse, tokenClaims };
}

export async function exchangeTokenAtEndpoint(
  tokenEndpoint: string,
  signedTicket: string,
  client: RegisteredClientInfo | null,
  clientPlan: ViewerClientPlan | null,
  proofJkt: string | null,
  demoSessionId?: string | null,
) {
  const form = new URLSearchParams({
    grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
    subject_token_type: "https://smarthealthit.org/token-type/permission-ticket",
    subject_token: signedTicket,
  });
  await appendClientAuth(form, tokenEndpoint, client, clientPlan);
  const tokenResponse = await postFormJson<TokenResponseInfo>(tokenEndpoint, form, proofJkt, demoSessionId);
  const tokenClaims = decodeJwtPayload(tokenResponse.access_token) as Record<string, any>;
  return { tokenResponse, tokenClaims };
}

export async function introspectSurfaceToken(
  origin: string,
  surface: AuthSurface,
  accessToken: string,
  client: RegisteredClientInfo | null,
  clientPlan: ViewerClientPlan | null,
  proofJkt: string | null,
  demoSessionId?: string | null,
) {
  const form = new URLSearchParams({ token: accessToken });
  await appendClientAuth(form, `${origin}${surface.introspectPath}`, client, clientPlan);
  return postFormJson<Record<string, any>>(`${origin}${surface.introspectPath}`, form, proofJkt, demoSessionId);
}

export async function introspectTokenAtEndpoint(
  introspectionEndpoint: string,
  accessToken: string,
  client: RegisteredClientInfo | null,
  clientPlan: ViewerClientPlan | null,
  proofJkt: string | null,
  demoSessionId?: string | null,
) {
  const form = new URLSearchParams({ token: accessToken });
  await appendClientAuth(form, introspectionEndpoint, client, clientPlan);
  return postFormJson<Record<string, any>>(introspectionEndpoint, form, proofJkt, demoSessionId);
}

export async function fetchSurfaceFhir(
  origin: string,
  surface: AuthSurface,
  relativePath: string,
  accessToken?: string | null,
  proofJkt?: string | null,
  demoSessionId?: string | null,
) {
  const headers: Record<string, string> = {};
  if (accessToken) headers.authorization = `Bearer ${accessToken}`;
  if (proofJkt) headers["x-client-jkt"] = proofJkt;
  return fetchJson<any>(`${origin}${surface.fhirBasePath}/${stripLeadingSlash(relativePath)}`, { headers }, demoSessionId);
}

export async function fetchFhirFromBase(
  fhirBaseUrl: string,
  relativePath: string,
  accessToken?: string | null,
  proofJkt?: string | null,
  demoSessionId?: string | null,
) {
  const headers: Record<string, string> = {};
  if (accessToken) headers.authorization = `Bearer ${accessToken}`;
  if (proofJkt) headers["x-client-jkt"] = proofJkt;
  return fetchJson<any>(`${trimTrailingSlash(fhirBaseUrl)}/${stripLeadingSlash(relativePath)}`, { headers }, demoSessionId);
}

export async function fetchPreviewSurfaceFhir(origin: string, surface: AuthSurface, relativePath: string, demoSessionId?: string | null) {
  return fetchJson<any>(`${origin}${surface.previewFhirBasePath}/${stripLeadingSlash(relativePath)}`, undefined, demoSessionId);
}

export async function fetchSurfaceFhirAllPages(
  origin: string,
  surface: AuthSurface,
  relativePath: string,
  accessToken?: string | null,
  proofJkt?: string | null,
  demoSessionId?: string | null,
) {
  const headers: Record<string, string> = {};
  if (accessToken) headers.authorization = `Bearer ${accessToken}`;
  if (proofJkt) headers["x-client-jkt"] = proofJkt;
  return fetchPaginatedFhir(`${origin}${surface.fhirBasePath}/${stripLeadingSlash(relativePath)}`, headers, demoSessionId);
}

export async function fetchFhirAllPagesFromBase(
  fhirBaseUrl: string,
  relativePath: string,
  accessToken?: string | null,
  proofJkt?: string | null,
  demoSessionId?: string | null,
) {
  const headers: Record<string, string> = {};
  if (accessToken) headers.authorization = `Bearer ${accessToken}`;
  if (proofJkt) headers["x-client-jkt"] = proofJkt;
  return fetchPaginatedFhir(`${trimTrailingSlash(fhirBaseUrl)}/${stripLeadingSlash(relativePath)}`, headers, demoSessionId);
}

export async function fetchPreviewSurfaceFhirAllPages(origin: string, surface: AuthSurface, relativePath: string, demoSessionId?: string | null) {
  return fetchPaginatedFhir(`${origin}${surface.previewFhirBasePath}/${stripLeadingSlash(relativePath)}`, undefined, demoSessionId);
}

export async function resolveRecordLocations(
  origin: string,
  mode: ModeName,
  networkSurface: AuthSurface,
  accessToken: string,
  proofJkt?: string | null,
  demoSessionId?: string | null,
): Promise<{ bundle: any; sites: ViewerLaunchSite[] }> {
  const bundle = await postJsonWithBearer<any>(
    `${origin}${networkSurface.fhirBasePath}/$resolve-record-locations`,
    { resourceType: "Parameters" },
    accessToken,
    proofJkt,
    demoSessionId,
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
      const fhirBaseUrl = typeof endpoint.address === "string" ? endpoint.address : null;
      if (!siteSlug) return null;
      return {
        siteSlug,
        orgName: siteName,
        jurisdiction,
        fhirBaseUrl: fhirBaseUrl ?? undefined,
        endpointId: typeof endpoint.id === "string" ? endpoint.id : undefined,
        organizationId,
        authSurface: buildAuthSurface(mode, { siteSlug }),
      };
    })
    .filter((site: ViewerLaunchSite | null): site is ViewerLaunchSite => Boolean(site));

  return { bundle, sites };
}

export async function postJsonWithBearer<T>(url: string, body: Record<string, any>, accessToken: string, proofJkt?: string | null, demoSessionId?: string | null): Promise<T> {
  return fetchJson<T>(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${accessToken}`,
      ...(proofJkt ? { "x-client-jkt": proofJkt } : {}),
    },
    body: JSON.stringify(body),
  }, demoSessionId);
}

export async function exchangeSiteToken(origin: string, site: ViewerLaunchSite, signedTicket: string, client: RegisteredClientInfo | null, privateJwk: JsonWebKey | null, proofJkt: string | null) {
  throw new Error("exchangeSiteToken is deprecated; use exchangeTokenAtEndpoint with a client plan");
}

export async function introspectSiteToken(origin: string, site: ViewerLaunchSite, accessToken: string, client: RegisteredClientInfo | null, privateJwk: JsonWebKey | null, proofJkt: string | null) {
  throw new Error("introspectSiteToken is deprecated; use introspectTokenAtEndpoint with a client plan");
}

export async function fetchSiteFhir(origin: string, site: ViewerLaunchSite, relativePath: string, accessToken?: string | null, proofJkt?: string | null, demoSessionId?: string | null) {
  return fetchSurfaceFhir(origin, site.authSurface, relativePath, accessToken, proofJkt, demoSessionId);
}

export async function fetchPreviewSiteFhir(origin: string, site: ViewerLaunchSite, relativePath: string, demoSessionId?: string | null) {
  return fetchPreviewSurfaceFhir(origin, site.authSurface, relativePath, demoSessionId);
}

export async function fetchSiteFhirAllPages(origin: string, site: ViewerLaunchSite, relativePath: string, accessToken?: string | null, proofJkt?: string | null, demoSessionId?: string | null) {
  return fetchSurfaceFhirAllPages(origin, site.authSurface, relativePath, accessToken, proofJkt, demoSessionId);
}

export async function fetchPreviewSiteFhirAllPages(origin: string, site: ViewerLaunchSite, relativePath: string, demoSessionId?: string | null) {
  return fetchPreviewSurfaceFhirAllPages(origin, site.authSurface, relativePath, demoSessionId);
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

function withDemoSession(init: RequestInit | undefined, demoSessionId?: string | null) {
  if (!demoSessionId) return init;
  const headers = new Headers(init?.headers);
  headers.set("x-demo-session", demoSessionId);
  return {
    ...init,
    headers,
  } satisfies RequestInit;
}

function stripLeadingSlash(value: string) {
  return value.replace(/^\/+/, "");
}

function trimTrailingSlash(value: string) {
  return value.replace(/\/+$/, "");
}

async function fetchPaginatedFhir(url: string, headers?: HeadersInit, demoSessionId?: string | null) {
  const first = await fetchJson<any>(url, headers ? { headers } : undefined, demoSessionId);
  if (first?.resourceType !== "Bundle") return first;

  const mergedEntries = [...(first.entry ?? [])];
  let next = bundleNextLink(first);

  while (next) {
    const page = await fetchJson<any>(next, headers ? { headers } : undefined, demoSessionId);
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

async function appendClientAuth(
  form: URLSearchParams,
  audience: string,
  client: RegisteredClientInfo | null,
  clientPlan: ViewerClientPlan | null,
) {
  if (!client || !clientPlan) return;
  form.set("client_id", client.clientId);
  form.set("client_assertion_type", "urn:ietf:params:oauth:client-assertion-type:jwt-bearer");
  form.set("client_assertion", await buildClientAssertion(client, clientPlan, audience));
  if (clientPlan.type === "udap") form.set("udap", "1");
}

export async function buildClientAssertion(client: RegisteredClientInfo, clientPlan: ViewerClientPlan, audience: string) {
  const payload = {
    iss: client.clientId,
    sub: client.clientId,
    aud: audience,
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + 300,
    jti: crypto.randomUUID(),
  };
  if (clientPlan.type === "udap") {
    return signRs256JwtWithPem(payload, clientPlan.privateKeyPem, {
      x5c: [pemToDerBase64(clientPlan.certificatePem)],
    });
  }
  if (clientPlan.type === "oidf") {
    return signPrivateKeyJwt(payload, clientPlan.privateJwk, {
      trust_chain: clientPlan.trustChain,
    });
  }
  return signPrivateKeyJwt(payload, clientPlan.privateJwk);
}

async function buildUdapSoftwareStatement(registrationEndpoint: string, clientPlan: Extract<ViewerClientPlan, { type: "udap" }>) {
  const payload = {
    iss: clientPlan.entityUri,
    sub: clientPlan.entityUri,
    aud: registrationEndpoint,
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + 300,
    jti: crypto.randomUUID(),
    client_name: clientPlan.clientName,
    grant_types: ["client_credentials"],
    token_endpoint_auth_method: "private_key_jwt",
    scope: clientPlan.scope,
    contacts: clientPlan.contacts,
  };
  return signRs256JwtWithPem(payload, clientPlan.privateKeyPem, {
    x5c: [pemToDerBase64(clientPlan.certificatePem)],
  });
}

function pemToDerBase64(pem: string) {
  return pem
    .replace(/-----BEGIN [^-]+-----/g, "")
    .replace(/-----END [^-]+-----/g, "")
    .replace(/\s+/g, "");
}

async function signRs256JwtWithPem(payload: Record<string, any>, privateKeyPem: string, extraHeader: Record<string, any> = {}) {
  const header = base64UrlEncodeJson({ alg: "RS256", typ: "JWT", ...extraHeader });
  const body = base64UrlEncodeJson(payload);
  const signingInput = `${header}.${body}`;
  const key = await crypto.subtle.importKey(
    "pkcs8",
    pemToDerBytes(privateKeyPem),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(signingInput));
  return `${signingInput}.${base64UrlEncode(new Uint8Array(signature))}`;
}

function pemToDerBytes(pem: string) {
  const binary = atob(pemToDerBase64(pem));
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

function base64UrlEncodeJson(value: unknown) {
  return base64UrlEncode(new TextEncoder().encode(JSON.stringify(value)));
}

function base64UrlEncode(bytes: Uint8Array) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}
