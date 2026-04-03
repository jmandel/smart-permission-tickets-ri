import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";

import { ClientRegistry } from "./auth/clients.ts";
import { decodeJwtWithoutVerification, verifyPrivateKeyJwt } from "../shared/private-key-jwt.ts";
import { TicketIssuerRegistry } from "./auth/issuers.ts";
import { signJwt, verifyJwt } from "./auth/jwt.ts";
import { compileAuthorizationEnvelope, validatePermissionTicket } from "./auth/tickets.ts";
import { loadConfig, type ServerConfig } from "./config.ts";
import { buildNetworkCapabilityStatement, buildNetworkInfo, readNetworkDirectory, resolveRecordLocationsBundle, searchNetworkDirectory } from "./network-directory.ts";
import { executeRead, executeSearch, getSupportedSearchParams } from "./store/search.ts";
import { FhirStore } from "./store/store.ts";
import type { AuthorizationEnvelope, ModeName, RegisteredClient, RouteContext, TokenExchangeRequest } from "./store/model.ts";
import { SUPPORTED_RESOURCE_TYPES } from "./store/model.ts";
import { buildAuthBasePath, buildFhirBasePath, modePrefix, normalizeModeSegment } from "../shared/surfaces.ts";

export type AppContext = {
  config: ServerConfig;
  store: FhirStore;
  clients: ClientRegistry;
  issuers: TicketIssuerRegistry;
};

export function createAppContext(overrides: Partial<ServerConfig> = {}) {
  const config = { ...loadConfig(), ...overrides };
  const store = FhirStore.load();
  const clients = new ClientRegistry(config.defaultRegisteredClients, config.clientRegistrationSecret);
  const issuers = new TicketIssuerRegistry(config.permissionTicketIssuers);
  return { config, store, clients, issuers };
}

import landingHtml from "../ui/index.html";

export function startServer(context = createAppContext(), port = context.config.port) {
  const server = Bun.serve({
    port,
    development: Bun.env.NODE_ENV !== "production",
    routes: {
      "/": landingHtml,
      "/modes/:mode": landingHtml,
      "/viewer": landingHtml,
    },
    fetch: (request) => handleRequest(context, request),
  });
  return server;
}

export async function handleRequest(context: AppContext, request: Request): Promise<Response> {
  const url = new URL(request.url);
  if (url.pathname === "/demo/bootstrap") {
    return jsonResponse({
      defaultMode: context.config.strictDefaultMode,
      selectedMode: "strict",
      defaultNetwork: buildNetworkInfo(context.config),
      networks: [buildNetworkInfo(context.config)],
      persons: context.store.listDemoPersons(),
      sites: context.store.listSiteSummaries(),
      searchableResourceTypes: SUPPORTED_RESOURCE_TYPES.filter((resourceType) => getSupportedSearchParams(resourceType).length > 0),
      defaultTicketIssuer: context.issuers.describe(url.origin, context.config.defaultPermissionTicketIssuerSlug),
      ticketIssuers: context.issuers.list(url.origin),
    });
  }
  const issuerRoute = resolveIssuerRoute(url.pathname);
  if (issuerRoute) {
    try {
      switch (issuerRoute.kind) {
        case "metadata":
          return jsonResponse(buildIssuerMetadata(context, url, issuerRoute.issuerSlug));
        case "jwks":
          return jsonResponse(buildIssuerJwks(context, issuerRoute.issuerSlug));
        case "sign-ticket":
          return await handleSignTicket(context, request, url, issuerRoute.issuerSlug);
      }
    } catch (error) {
      return operationOutcome(error instanceof Error ? error.message : "Request failed", 400);
    }
  }
  const route = resolveRoute(context.config.strictDefaultMode, url.pathname);
  if (!route) return notFound();

  try {
    switch (route.kind) {
      case "landing":
        return htmlResponse("<!doctype html><html><body>Redirecting...</body></html>");
      case "smart-config":
        return jsonResponse(buildSmartConfig(context, url, route.context));
      case "register":
        return await handleRegister(context, request, url, route.context);
      case "token":
        return await handleToken(context, request, url, route.context);
      case "introspect":
        return await handleIntrospect(context, request, url, route.context);
      case "metadata":
        return fhirResponse(route.context.networkSlug ? buildNetworkCapabilityStatement(context.config, url, route.context) : buildCapabilityStatement(context, url, route.context));
      case "operation":
        return await handleOperation(context, request, url, route.context, route.operation);
      case "read":
        return await handleRead(context, request, route.context, route.resourceType, route.logicalId);
      case "search":
        return await handleSearch(context, request, url, route.context, route.resourceType);
    }
  } catch (error) {
    return operationOutcome(error instanceof Error ? error.message : "Request failed", 400);
  }
}

async function handleRegister(context: AppContext, request: Request, url: URL, contextRoute: RouteContext) {
  if (request.method !== "POST") return methodNotAllowed("POST");
  const body = await parseBody(request);
  const authBasePath = buildAuthBasePath(context.config.strictDefaultMode, contextRoute);
  const publicJwk = parseRegisteredClientJwk(body);
  const client = await context.clients.register({
    clientName: body.client_name,
    publicJwk,
    tokenEndpointAuthMethod: body.token_endpoint_auth_method,
  });
  return jsonResponse(
    {
      client_id: client.clientId,
      client_name: client.clientName,
      token_endpoint_auth_method: client.tokenEndpointAuthMethod,
      jwks: client.publicJwk ? { keys: [client.publicJwk] } : undefined,
      jwk_thumbprint: client.jwkThumbprint,
      registration_client_uri: absoluteUrl(url, `${authBasePath}/register/${client.clientId}`),
      token_endpoint: absoluteUrl(url, `${authBasePath}/token`),
    },
    201,
  );
}

async function handleToken(context: AppContext, request: Request, url: URL, contextRoute: RouteContext) {
  if (request.method !== "POST") return methodNotAllowed("POST");
  const body = (await parseBody(request)) as TokenExchangeRequest & Record<string, any>;
  if (body.grant_type !== "urn:ietf:params:oauth:grant-type:token-exchange") {
    throw new Error("Unsupported grant_type");
  }
  const authBasePath = buildAuthBasePath(context.config.strictDefaultMode, contextRoute);
  const fhirBasePath = buildFhirBasePath(context.config.strictDefaultMode, contextRoute);
  const ticket = validatePermissionTicket(body.subject_token, context.issuers, url.origin, url.origin);
  const client = await authenticateClient(
    context,
    request,
    body,
    contextRoute.mode,
    absoluteUrl(url, `${authBasePath}/token`),
    ticket.cnf?.jkt,
  );
  enforceClientBinding(ticket.cnf?.jkt, client, contextRoute.mode);

  const envelope = bindEnvelopeToRoute(compileAuthorizationEnvelope(ticket, context.store, contextRoute.mode), contextRoute);
  if (contextRoute.siteSlug && !context.store.hasVisibleEncounter(envelope, contextRoute.siteSlug)) {
    throw new Error("Requested site has no visible encounters under current ticket constraints");
  }
  const now = Math.floor(Date.now() / 1000);
  const issuedScope = contextRoute.networkSlug
    ? "system/Endpoint.rs system/Organization.rs system/$resolve-record-locations"
    : envelope.scope;
  const accessTokenPayload = {
    iss: context.config.issuer,
    aud: absoluteUrl(url, fhirBasePath),
    sub: envelope.ticketSubject,
    exp: now + context.config.accessTokenTtlSeconds,
    iat: now,
    jti: randomUUID(),
    typ: "at+jwt",
    client_id: client?.clientId,
    ...envelope,
    scope: issuedScope,
  };
  const accessToken = signJwt(accessTokenPayload, context.config.accessTokenSecret);
  return jsonResponse({
    access_token: accessToken,
    token_type: "Bearer",
    issued_token_type: "urn:ietf:params:oauth:token-type:access_token",
    expires_in: context.config.accessTokenTtlSeconds,
    scope: envelope.scope,
    patient: envelope.patient,
  });
}

async function handleSignTicket(context: AppContext, request: Request, url: URL, issuerSlug: string) {
  if (request.method !== "POST") return methodNotAllowed("POST");
  const body = await parseBody(request);
  const payload = normalizeTicketPayload(body, url.origin);
  const signedTicket = context.issuers.sign(url.origin, issuerSlug, payload);
  const issuerInfo = context.issuers.describe(url.origin, issuerSlug);
  return jsonResponse(
    {
      signed_ticket: signedTicket,
      issuer: issuerInfo.issuerBaseUrl,
      jwks_uri: issuerInfo.jwksUrl,
      kid: context.issuers.get(issuerSlug)?.kid,
    },
    201,
  );
}

async function handleIntrospect(context: AppContext, request: Request, url: URL, contextRoute: RouteContext) {
  if (request.method !== "POST") return methodNotAllowed("POST");
  const body = await parseBody(request);
  const authBasePath = buildAuthBasePath(context.config.strictDefaultMode, contextRoute);
  await authenticateClient(context, request, body, contextRoute.mode, absoluteUrl(url, `${authBasePath}/introspect`));
  const token = body.token;
  if (!token) return jsonResponse({ active: false });
  try {
    const { payload } = verifyJwt<any>(token, context.config.accessTokenSecret);
    enforceAccessToken(
      context,
      payload,
      contextRoute.mode,
      request.headers.get("x-client-jkt"),
      absoluteUrl(url, buildFhirBasePath(context.config.strictDefaultMode, contextRoute)),
    );
    return jsonResponse({
      active: true,
      scope: payload.scope,
      client_id: payload.client_id,
      sub: payload.sub,
      aud: payload.aud,
      exp: payload.exp,
      iat: payload.iat,
      patient: payload.patient,
      mode: payload.mode,
      allowed_sites: payload.allowedSites,
      allowed_resource_types: payload.allowedResourceTypes,
      date_ranges: payload.dateRanges,
      date_semantics: payload.dateSemantics,
      sensitive: payload.sensitive,
    });
  } catch {
    return jsonResponse({ active: false });
  }
}

async function handleRead(context: AppContext, request: Request, contextRoute: RouteContext, resourceType: string, logicalId: string) {
  if (request.method !== "GET") return methodNotAllowed("GET");
  const envelope = authenticateAccessToken(context, request, contextRoute);
  if (contextRoute.networkSlug) {
    const resource = readNetworkDirectory(context.config, context.store, new URL(request.url), contextRoute, resourceType, logicalId);
    return resource ? fhirResponse(resource) : notFound();
  }
  const resource = executeRead(context.store.db, envelope, contextRoute.siteSlug, resourceType, logicalId);
  return resource ? fhirResponse(resource) : notFound();
}

async function handleSearch(context: AppContext, request: Request, url: URL, contextRoute: RouteContext, resourceType: string) {
  if (!["GET", "POST"].includes(request.method)) return methodNotAllowed("GET, POST");
  const envelope = authenticateAccessToken(context, request, contextRoute);
  const params = await parseSearchParams(request, url);
  if (contextRoute.networkSlug) {
    void envelope;
    return fhirResponse(searchNetworkDirectory(context.config, context.store, url, contextRoute, resourceType, params));
  }
  const basePath = buildFhirBasePath(context.config.strictDefaultMode, contextRoute);
  const bundle = executeSearch(context.store.db, envelope, contextRoute.siteSlug, resourceType, params, absoluteUrl(url, `${basePath}/${resourceType}`));
  return fhirResponse(bundle);
}

async function handleOperation(
  context: AppContext,
  request: Request,
  url: URL,
  contextRoute: RouteContext,
  operation: "resolve-record-locations",
) {
  if (request.method !== "POST") return methodNotAllowed("POST");
  if (!contextRoute.networkSlug) return notFound();
  const envelope = authenticateAccessToken(context, request, contextRoute);
  switch (operation) {
    case "resolve-record-locations":
      return fhirResponse(resolveRecordLocationsBundle(context.config, context.store, url, contextRoute, envelope));
  }
}

async function authenticateClient(
  context: AppContext,
  request: Request,
  body: Record<string, any>,
  mode: ModeName,
  tokenEndpointUrl: string,
  ticketJkt?: string,
): Promise<RegisteredClient | null> {
  const basic = parseBasicAuth(request.headers.get("authorization"));
  const clientId = basic?.clientId ?? body.client_id;
  const requiresBoundClient = mode === "registered" || mode === "strict" || mode === "key-bound" || Boolean(ticketJkt);
  const assertionJwt = body.client_assertion ? String(body.client_assertion) : null;

  if (!assertionJwt) {
    if (requiresBoundClient) throw new Error("Authenticated key-based client assertion required");
    return clientId ? context.clients.get(clientId) : null;
  }

  if (body.client_assertion_type && body.client_assertion_type !== "urn:ietf:params:oauth:client-assertion-type:jwt-bearer") {
    throw new Error("Unsupported client_assertion_type");
  }

  const decoded = decodeJwtWithoutVerification<any>(assertionJwt);
  const assertedClientId = String(decoded.payload.iss ?? "");
  if (!assertedClientId) throw new Error("Client assertion iss missing");
  if (clientId && clientId !== assertedClientId) throw new Error("client_id does not match client assertion issuer");
  const client = context.clients.get(assertedClientId);
  if (!client) throw new Error("Authenticated registered client required");
  await verifyClientAssertion(assertionJwt, client, tokenEndpointUrl);
  return client;
}

async function verifyClientAssertion(jwt: string, client: RegisteredClient, tokenEndpointUrl: string) {
  if (client.tokenEndpointAuthMethod !== "private_key_jwt" || !client.publicJwk) {
    throw new Error("Client does not support private_key_jwt");
  }
  const { payload } = await verifyPrivateKeyJwt<any>(jwt, client.publicJwk as JsonWebKey & { kty: "EC"; crv: "P-256"; x: string; y: string });
  const now = Math.floor(Date.now() / 1000);
  if (payload.iss !== client.clientId || payload.sub !== client.clientId) throw new Error("Invalid client assertion");
  if (payload.aud !== tokenEndpointUrl) throw new Error("Client assertion audience mismatch");
  if (typeof payload.exp !== "number" || payload.exp <= now) throw new Error("Client assertion expired");
  if (typeof payload.iat === "number" && payload.iat > now + 60) throw new Error("Client assertion issued in the future");
  return payload;
}

function enforceClientBinding(ticketJkt: string | undefined, client: RegisteredClient | null, mode: ModeName) {
  if (ticketJkt && client?.jwkThumbprint !== ticketJkt) throw new Error("Client key does not match ticket binding");
  if ((mode === "strict" || mode === "registered" || mode === "key-bound") && !client) {
    throw new Error("Authenticated registered client required");
  }
}

function authenticateAccessToken(context: AppContext, request: Request, contextRoute: RouteContext): AuthorizationEnvelope {
  if (contextRoute.mode === "anonymous" && !contextRoute.networkSlug) return buildAnonymousEnvelope(context);
  const authHeader = request.headers.get("authorization");
  if (!authHeader?.startsWith("Bearer ")) throw new Error("Missing Bearer access token");
  const token = authHeader.slice("Bearer ".length);
  const { payload } = verifyJwt<any>(token, context.config.accessTokenSecret);
  enforceAccessToken(
    context,
    payload,
    contextRoute.mode,
    request.headers.get("x-client-jkt"),
    absoluteUrl(new URL(request.url), buildFhirBasePath(context.config.strictDefaultMode, contextRoute)),
  );
  return payload as AuthorizationEnvelope;
}

function enforceAccessToken(
  context: AppContext,
  payload: any,
  mode: ModeName,
  proofJkt: string | null,
  expectedAudience?: string,
) {
  const now = Math.floor(Date.now() / 1000);
  if (payload.iss !== context.config.issuer) throw new Error("Access token issuer mismatch");
  if (payload.exp <= now) throw new Error("Access token expired");
  if (payload.mode !== mode) throw new Error("Access token mode mismatch");
  if (expectedAudience && payload.aud !== expectedAudience) throw new Error("Access token audience mismatch");
  if (payload.cnf?.jkt && proofJkt !== payload.cnf.jkt) throw new Error("Access token proof key mismatch");
}

function buildIssuerMetadata(context: AppContext, url: URL, issuerSlug: string) {
  const issuer = context.issuers.describe(url.origin, issuerSlug);
  return {
    issuer: issuer.issuerBaseUrl,
    issuer_name: issuer.name,
    jwks_uri: issuer.jwksUrl,
    sign_ticket_endpoint: issuer.signTicketUrl,
    alg_values_supported: ["ES256"],
  };
}

function buildIssuerJwks(context: AppContext, issuerSlug: string) {
  const issuer = context.issuers.get(issuerSlug);
  if (!issuer) throw new Error("Unknown issuer");
  return {
    keys: [issuer.publicJwk],
  };
}

function buildSmartConfig(context: AppContext, url: URL, contextRoute: RouteContext) {
  const authBasePath = buildAuthBasePath(context.config.strictDefaultMode, contextRoute);
  const fhirBasePath = buildFhirBasePath(context.config.strictDefaultMode, contextRoute);
  const scopesSupported = contextRoute.networkSlug
    ? ["system/Endpoint.rs", "system/Organization.rs", "system/$resolve-record-locations"]
    : [
        "patient/*.rs",
        "patient/Observation.rs?category=laboratory",
        "patient/DocumentReference.rs?category=clinical-note",
      ];
  return {
    issuer: absoluteUrl(url, fhirBasePath),
    authorization_endpoint: null,
    token_endpoint: absoluteUrl(url, `${authBasePath}/token`),
    registration_endpoint: absoluteUrl(url, `${authBasePath}/register`),
    introspection_endpoint: absoluteUrl(url, `${authBasePath}/introspect`),
    fhir_base_url: absoluteUrl(url, fhirBasePath),
    grant_types_supported: ["urn:ietf:params:oauth:grant-type:token-exchange"],
    token_endpoint_auth_methods_supported: ["none", "private_key_jwt"],
    token_endpoint_auth_signing_alg_values_supported: ["ES256"],
    capabilities: ["permission-v2", "client-public", "client-confidential-asymmetric"],
    mode: contextRoute.mode,
    scopes_supported: scopesSupported,
  };
}

function parseRegisteredClientJwk(body: Record<string, any>) {
  const direct = body.jwk;
  const fromJwks = Array.isArray(body.jwks?.keys) ? body.jwks.keys[0] : undefined;
  const candidate = direct ?? fromJwks;
  if (!candidate || typeof candidate !== "object") throw new Error("Dynamic registration requires a public JWK");
  return candidate as JsonWebKey;
}

function normalizeTicketPayload(body: Record<string, any>, audienceOrigin: string) {
  const payload = (body.ticket ?? body.ticket_payload ?? body) as Record<string, any>;
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("Ticket payload must be an object");
  }
  return {
    ...payload,
    aud: payload.aud ?? audienceOrigin,
    iss: payload.iss,
    ticket_type: payload.ticket_type ?? "urn:smart-permission-tickets:demo-client",
    sub: payload.sub ?? "demo-client-ticket",
  };
}

function buildCapabilityStatement(context: AppContext, url: URL, contextRoute: RouteContext) {
  const basePath = buildFhirBasePath(context.config.strictDefaultMode, contextRoute);
  const authBasePath = buildAuthBasePath(context.config.strictDefaultMode, contextRoute);
  return {
    resourceType: "CapabilityStatement",
    status: "active",
    kind: "instance",
    date: new Date().toISOString(),
    format: ["json"],
    fhirVersion: "4.0.1",
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
        resource: SUPPORTED_RESOURCE_TYPES.map((type) => ({
          type,
          interaction: [{ code: "read" }, { code: "search-type" }],
          searchParam: getSupportedSearchParams(type).map((name) => ({ name, type: searchParamType(name) })),
        })),
      },
    ],
    implementation: {
      description: `Permission-aware Bun FHIR server (${contextRoute.mode})`,
      url: absoluteUrl(url, basePath),
    },
  };
}

function bindEnvelopeToRoute(envelope: AuthorizationEnvelope, contextRoute: RouteContext): AuthorizationEnvelope {
  if (!contextRoute.siteSlug) return envelope;
  const allowedPatientAliases = envelope.allowedPatientAliases.filter((alias) => alias.siteSlug === contextRoute.siteSlug);
  if (!allowedPatientAliases.length) throw new Error("Ticket constraints exclude the requested site");
  return {
    ...envelope,
    allowedPatientAliases,
    allowedSites: [contextRoute.siteSlug],
    patient: chooseRoutePatientClaim(allowedPatientAliases),
  };
}

function chooseRoutePatientClaim(aliases: AuthorizationEnvelope["allowedPatientAliases"]) {
  return [...aliases]
    .sort((a, b) => `${a.siteSlug}/${a.serverPatientRef}`.localeCompare(`${b.siteSlug}/${b.serverPatientRef}`))[0]
    ?.serverPatientRef.split("/", 2)
    .at(1);
}

function searchParamType(name: string) {
  const refParams = new Set(["patient", "encounter", "location"]);
  if (name === "_id") return "token";
  if (["family", "given", "name", "gender"].includes(name)) return "string";
  if (refParams.has(name)) return "reference";
  if (["birthdate", "date", "period", "authoredon", "_lastUpdated"].includes(name)) return "date";
  return "token";
}

export function resolveRoute(defaultMode: ModeName, pathname: string):
  | { kind: "landing"; context: RouteContext }
  | { kind: "smart-config"; context: RouteContext }
  | { kind: "register"; context: RouteContext }
  | { kind: "token"; context: RouteContext }
  | { kind: "introspect"; context: RouteContext }
  | { kind: "metadata"; context: RouteContext }
  | { kind: "operation"; context: RouteContext; operation: "resolve-record-locations" }
  | { kind: "read"; context: RouteContext; resourceType: string; logicalId: string }
  | { kind: "search"; context: RouteContext; resourceType: string }
  | null {
  const segments = pathname.split("/").filter(Boolean);
  let index = 0;
  let mode: ModeName = defaultMode;
  if (segments.length === 0) return { kind: "landing", context: { mode } };
  if (segments[0] === "modes") {
    const requested = normalizeModeSegment(segments[1]);
    if (!requested) return null;
    mode = requested;
    index = 2;
    if (segments.length === 2) return { kind: "landing", context: { mode } };
  }

  if (segments[index] === ".well-known" && segments[index + 1] === "smart-configuration" && segments.length === index + 2) {
    return { kind: "smart-config", context: { mode } };
  }
  if (segments[index] === "register" && segments.length === index + 1) return { kind: "register", context: { mode } };
  if (segments[index] === "token" && segments.length === index + 1) return { kind: "token", context: { mode } };
  if (segments[index] === "introspect" && segments.length === index + 1) return { kind: "introspect", context: { mode } };

  let siteSlug: string | undefined;
  let networkSlug: string | undefined;
  if (segments[index] === "sites") {
    siteSlug = segments[index + 1];
    const next = segments[index + 2];
    if (!siteSlug) return null;
    if (next === "register" && segments.length === index + 3) return { kind: "register", context: { mode, siteSlug } };
    if (next === "token" && segments.length === index + 3) return { kind: "token", context: { mode, siteSlug } };
    if (next === "introspect" && segments.length === index + 3) return { kind: "introspect", context: { mode, siteSlug } };
    if (next !== "fhir") return null;
    index += 3;
  } else if (segments[index] === "networks") {
    networkSlug = segments[index + 1];
    const next = segments[index + 2];
    if (!networkSlug) return null;
    if (next === "register" && segments.length === index + 3) return { kind: "register", context: { mode, networkSlug } };
    if (next === "token" && segments.length === index + 3) return { kind: "token", context: { mode, networkSlug } };
    if (next === "introspect" && segments.length === index + 3) return { kind: "introspect", context: { mode, networkSlug } };
    if (next !== "fhir") return null;
    index += 3;
  } else if (segments[index] === "fhir") {
    index += 1;
  } else {
    return null;
  }

  const context: RouteContext = { mode, siteSlug, networkSlug };
  if (segments[index] === ".well-known" && segments[index + 1] === "smart-configuration" && segments.length === index + 2) {
    return { kind: "smart-config", context };
  }
  if (segments[index] === "metadata" && segments.length === index + 1) return { kind: "metadata", context };
  if (segments[index] === "$resolve-record-locations" && segments.length === index + 1) {
    return { kind: "operation", context, operation: "resolve-record-locations" };
  }
  const resourceType = segments[index];
  if (!resourceType) return null;
  if (segments.length === index + 1) return { kind: "search", context, resourceType };
  if (segments[index + 1] === "_search" && segments.length === index + 2) return { kind: "search", context, resourceType };
  if (segments[index + 1] && segments.length === index + 2) {
    return { kind: "read", context, resourceType, logicalId: segments[index + 1] };
  }
  return null;
}

function resolveIssuerRoute(pathname: string):
  | { kind: "metadata"; issuerSlug: string }
  | { kind: "jwks"; issuerSlug: string }
  | { kind: "sign-ticket"; issuerSlug: string }
  | null {
  const segments = pathname.split("/").filter(Boolean);
  if (segments[0] !== "issuer") return null;
  const issuerSlug = segments[1];
  if (!issuerSlug) return null;
  if (segments.length === 2) return { kind: "metadata", issuerSlug };
  if (segments[2] === ".well-known" && segments[3] === "jwks.json" && segments.length === 4) {
    return { kind: "jwks", issuerSlug };
  }
  if (segments[2] === "sign-ticket" && segments.length === 3) {
    return { kind: "sign-ticket", issuerSlug };
  }
  return null;
}

async function parseBody(request: Request) {
  const contentType = request.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) return (await request.json()) as Record<string, any>;
  if (contentType.includes("application/x-www-form-urlencoded") || contentType.includes("multipart/form-data")) {
    const form = await request.formData();
    return Object.fromEntries(form.entries()) as Record<string, any>;
  }
  const text = await request.text();
  if (!text) return {};
  try {
    return JSON.parse(text) as Record<string, any>;
  } catch {
    return Object.fromEntries(new URLSearchParams(text).entries());
  }
}

async function parseSearchParams(request: Request, url: URL) {
  const params = new URLSearchParams(url.search);
  if (request.method === "POST") {
    const body = await parseBody(request);
    for (const [key, value] of Object.entries(body)) {
      if (typeof value === "string") params.append(key, value);
    }
  }
  return params;
}

function parseBasicAuth(header: string | null) {
  if (!header?.startsWith("Basic ")) return null;
  const decoded = Buffer.from(header.slice("Basic ".length), "base64").toString("utf8");
  const [clientId, clientSecret] = decoded.split(":", 2);
  if (!clientId) return null;
  return { clientId, clientSecret: clientSecret ?? "" };
}

function signlessDecode(jwt: string) {
  const [, encodedPayload] = jwt.split(".");
  if (!encodedPayload) throw new Error("Malformed JWT");
  return JSON.parse(Buffer.from(encodedPayload, "base64url").toString("utf8"));
}

function buildAnonymousEnvelope(context: AppContext): AuthorizationEnvelope {
  return {
    ticketIssuer: "local-anonymous-mode",
    ticketSubject: "anonymous-read-only",
    ticketType: "urn:smart-permission-tickets:anonymous-mode",
    mode: "anonymous",
    scope: "system/*.rs",
    grantedScopes: ["system/*.rs"],
    patient: undefined,
    allowedPatientAliases: context.store.loadResult.patientAliases,
    allowedSites: undefined,
    allowedResourceTypes: [...SUPPORTED_RESOURCE_TYPES],
    dateRanges: undefined,
    dateSemantics: "generated-during-period",
    sensitive: { mode: "allow" },
  };
}

function absoluteUrl(url: URL, path: string) {
  return `${url.origin}${path}`;
}

const PATIENT_SCENARIOS: Record<string, { summary: string; constraints: string }> = {
  "elena-reyes": {
    summary: "Mid-30s woman with rheumatoid arthritis (CA) and sensitive reproductive history including pregnancy loss (TX).",
    constraints: "Exercises: jurisdiction (TX vs CA), sensitive-data filtering (SEX labels on OB encounters), period windowing, organization filtering across 4 providers.",
  },
  "robert-davis": {
    summary: "65-year-old man with active pulmonary TB, managed through ED admission, inpatient isolation, and outpatient DOT.",
    constraints: "Exercises: period filtering (TB episode only vs chronic disease baseline), resource-type scoping (labs + conditions for public health), HIV test sensitivity labels.",
  },
  "maria-chen": {
    summary: "42-year-old woman with food insecurity and transportation barriers identified via SDOH screening, with closed-loop CBO referral.",
    constraints: "Exercises: narrow resource-type scopes (CBO sees only ServiceRequest + Observation, not clinical data), cross-organization referral tracking.",
  },
  "denise-walker": {
    summary: "58-year-old woman with diabetes, heart failure, CKD, and atrial fibrillation across 5 providers in AZ and NM.",
    constraints: "Exercises: jurisdiction (AZ vs NM), organization (PCP vs cardiology vs nephrology vs retina), period (pre-move baseline vs post-move), many resource types.",
  },
};

function buildLandingPage(context: AppContext, url: URL, contextRoute: RouteContext) {
  const selectedMode = contextRoute.mode;
  const defaultMode = context.config.strictDefaultMode;
  const prefix = modePrefix(defaultMode, selectedMode);
  const selectedFhirBase = absoluteUrl(url, `${prefix}/fhir`);
  const modeLocked = url.pathname !== "/";
  const sites = context.store.listSiteSummaries();
  const patients = context.store.listPatientSummaries();
  const modeCards: Array<{ mode: ModeName; title: string; summary: string; auth: string; fhir: string }> = [
    {
      mode: "strict",
      title: "Strict",
      summary: "Default SMART/OAuth surface with registered-client token exchange.",
      auth: "Registered client required at /token.",
      fhir: "FHIR requests require a Bearer access token.",
    },
    {
      mode: "registered",
      title: "Registered",
      summary: "Looser than strict, but still limited to known registered clients.",
      auth: "Registered client required at /modes/registered/token.",
      fhir: "FHIR requests require a Bearer access token.",
    },
    {
      mode: "key-bound",
      title: "Key-Bound",
      summary: "Sender-constrained token exchange and token use when tickets carry cnf.jkt.",
      auth: "Proof key must match the ticket binding.",
      fhir: "FHIR requests require a Bearer access token and matching proof header.",
    },
    {
      mode: "open",
      title: "Open",
      summary: "Open token exchange for local development without client registration.",
      auth: "No client auth required at /modes/open/token.",
      fhir: "FHIR requests still require a Bearer access token.",
    },
    {
      mode: "anonymous",
      title: "Preview",
      summary: "Read-only local browsing surface for the loaded corpus.",
      auth: "No token exchange required.",
      fhir: "FHIR reads and searches are allowed without an access token.",
    },
  ];

  const entrypoints = [
    { label: "SMART Config", href: `${prefix}/.well-known/smart-configuration`, note: "OAuth/SMART metadata for the selected mode." },
    { label: "Dynamic Registration", href: `${prefix}/register`, note: "Client registration endpoint." },
    { label: "Token Exchange", href: `${prefix}/token`, note: "Permission Ticket to access-token exchange." },
    { label: "Introspection", href: `${prefix}/introspect`, note: "Stateless access-token introspection." },
    { label: "FHIR Metadata", href: `${prefix}/fhir/metadata`, note: "CapabilityStatement for the selected mode." },
  ];
  const selectedModeCard = modeCards.find((card) => card.mode === selectedMode)!;
  const selectedModeHref = modeHref(defaultMode, selectedMode);
  const queryExamples = [
    {
      title: "CapabilityStatement",
      note: "Server capability surface for this mode.",
      openHref: `${prefix}/fhir/metadata`,
      curl: `curl ${shellQuote(`${selectedFhirBase}/metadata`)}`,
    },
    {
      title: "Site Metadata",
      note: "Partitioned capability view for one site.",
      openHref: `/sites/${sites[0]?.siteSlug ?? "example-site"}/fhir/metadata`,
      curl: `curl ${shellQuote(absoluteUrl(url, `${prefix}/sites/${sites[0]?.siteSlug ?? "example-site"}/fhir/metadata`))}`,
    },
    {
      title: selectedMode === "anonymous" ? "Preview Patient Search" : "Patient Search",
      note: selectedMode === "anonymous" ? "Preview search over loaded patients." : "Token-backed search over Patient resources.",
      openHref: `${prefix}/fhir/Patient?_count=10`,
      curl:
        selectedMode === "anonymous"
          ? `curl ${shellQuote(absoluteUrl(url, `${prefix}/fhir/Patient?_count=10`))}`
          : `curl -H 'authorization: Bearer $ACCESS_TOKEN' ${shellQuote(absoluteUrl(url, `${prefix}/fhir/Patient?_count=10`))}`,
    },
    {
      title: selectedMode === "anonymous" ? "Preview Lab Search" : "Token-Based Lab Search",
      note: selectedMode === "anonymous" ? "Observation search without token enforcement." : "Observation query constrained by an issued access token.",
      openHref: `${prefix}/fhir/Observation?patient={patient-id}&category=laboratory&_count=20`,
      curl:
        selectedMode === "anonymous"
          ? `curl ${shellQuote(absoluteUrl(url, `${prefix}/fhir/Observation?patient={patient-id}&category=laboratory&_count=20`))}`
          : `curl -H 'authorization: Bearer $ACCESS_TOKEN' ${shellQuote(absoluteUrl(url, `${prefix}/fhir/Observation?patient={patient-id}&category=laboratory&_count=20`))}`,
    },
  ];

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Reference FHIR Server</title>
    <style>
      :root {
        --bg: #f8f9fa;
        --panel: #ffffff;
        --ink: #202124;
        --muted: #5f6368;
        --line: #dadce0;
        --line-strong: #c4c7c5;
        --accent: #1a73e8;
        --accent-soft: #e8f0fe;
        --warn: #b3261e;
        --warn-soft: #fce8e6;
        --shadow: 0 1px 2px rgba(60, 64, 67, 0.16), 0 1px 3px 1px rgba(60, 64, 67, 0.08);
      }
      * { box-sizing: border-box; }
      body {
        margin: 0;
        font-family: "Google Sans Text", "Segoe UI", "Helvetica Neue", Arial, sans-serif;
        color: var(--ink);
        background: var(--bg);
      }
      a { color: var(--accent); text-decoration: none; }
      a:hover { text-decoration: underline; }
      code, pre {
        font-family: "SFMono-Regular", "Menlo", "Monaco", "Consolas", monospace;
        font-size: 0.95em;
      }
      .shell {
        width: min(1280px, calc(100vw - 32px));
        margin: 24px auto 40px;
      }
      .hero, .panel {
        background: var(--panel);
        border: 1px solid var(--line);
        border-radius: 8px;
        box-shadow: var(--shadow);
      }
      .hero {
        padding: 28px 30px 22px;
      }
      h1, h2, h3 { margin: 0; font-weight: 600; }
      h1 { font-size: clamp(2rem, 4vw, 2.6rem); letter-spacing: -0.02em; }
      h2 { font-size: 1.35rem; margin-bottom: 14px; }
      p { line-height: 1.55; }
      .lede { max-width: 72ch; color: var(--muted); margin: 10px 0 0; }
      .pill-row {
        display: flex;
        flex-wrap: wrap;
        gap: 10px;
        margin-top: 18px;
      }
      .pill {
        border: 1px solid var(--line);
        border-radius: 999px;
        padding: 6px 10px;
        background: #fff;
        font-size: 0.9rem;
      }
      .pill strong { color: var(--ink); }
      .grid {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(260px, 1fr));
        gap: 16px;
      }
      .section {
        margin-top: 20px;
        padding: 22px 24px;
      }
      .card {
        border: 1px solid var(--line);
        border-radius: 8px;
        padding: 16px;
        background: #fff;
      }
      .card h3 { font-size: 1.05rem; }
      .card p { margin: 8px 0 0; color: var(--muted); font-size: 0.98rem; }
      .route {
        display: block;
        margin-top: 10px;
        padding: 9px 11px;
        background: #fff;
        border: 1px solid var(--line);
        border-radius: 6px;
        overflow-wrap: anywhere;
      }
      .warning {
        margin-top: 16px;
        padding: 14px 16px;
        border-radius: 8px;
        border: 1px solid #f6c7c0;
        background: var(--warn-soft);
        color: var(--warn);
      }
      .mode-grid {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
        gap: 12px;
      }
      .mode-card {
        display: block;
        border: 1px solid var(--line);
        border-radius: 8px;
        padding: 16px;
        background: #fff;
        color: var(--ink);
        transition: border-color 120ms ease, box-shadow 120ms ease, background 120ms ease;
      }
      .mode-card:hover {
        text-decoration: none;
        border-color: #a8c7fa;
        background: #f8fbff;
        box-shadow: 0 1px 2px rgba(26, 115, 232, 0.12);
      }
      .mode-card h3 { margin-bottom: 8px; }
      .mode-card p { margin: 6px 0 0; color: var(--muted); }
      .mode-card-path {
        margin-top: 12px;
        padding-top: 10px;
        border-top: 1px solid var(--line);
        color: var(--accent);
        font-family: "SFMono-Regular", "Menlo", "Monaco", "Consolas", monospace;
        font-size: 0.92rem;
      }
      .locked-mode {
        display: flex;
        justify-content: space-between;
        gap: 20px;
        align-items: flex-start;
        border: 1px solid #c2e7ff;
        border-radius: 8px;
        background: #f8fbff;
        padding: 16px 18px;
      }
      .locked-mode p { margin: 8px 0 0; color: var(--muted); max-width: 72ch; }
      .locked-meta {
        display: flex;
        flex-direction: column;
        align-items: flex-end;
        gap: 10px;
        min-width: 180px;
      }
      .button-row {
        display: flex;
        flex-wrap: wrap;
        gap: 10px;
      }
      .button,
      .copy-button {
        appearance: none;
        border: 1px solid var(--line-strong);
        background: #fff;
        color: var(--ink);
        border-radius: 999px;
        padding: 8px 12px;
        font: inherit;
        cursor: pointer;
      }
      .button.primary,
      .copy-button.primary {
        background: var(--accent);
        color: #fff;
        border-color: var(--accent);
      }
      .button:hover,
      .copy-button:hover {
        text-decoration: none;
        border-color: var(--accent);
      }
      table {
        width: 100%;
        border-collapse: collapse;
      }
      th, td {
        padding: 12px 10px;
        border-top: 1px solid var(--line);
        vertical-align: top;
        text-align: left;
      }
      thead th {
        color: var(--muted);
        font-weight: 600;
        background: #f8f9fa;
        border-top: none;
      }
      tbody tr:first-child td { border-top: 1px solid var(--line); }
      .badges {
        display: flex;
        flex-wrap: wrap;
        gap: 8px;
      }
      .badge {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        border-radius: 999px;
        border: 1px solid var(--line);
        background: #fff;
        padding: 4px 10px;
        font-size: 0.9rem;
      }
      .links {
        display: flex;
        flex-wrap: wrap;
        gap: 8px;
      }
      .links a {
        padding: 6px 10px;
        border: 1px solid var(--line);
        border-radius: 999px;
        background: #fff;
      }
      .query-card {
        display: flex;
        flex-direction: column;
        gap: 12px;
      }
      .endpoint-line {
        margin: 0;
        padding: 10px 12px;
        border-radius: 6px;
        background: #f8f9fa;
        border: 1px solid var(--line);
        overflow-wrap: anywhere;
      }
      .subtle { color: var(--muted); }
      @media (max-width: 700px) {
        .shell { width: min(100vw - 18px, 1180px); margin-top: 12px; }
        .hero, .section { padding-left: 18px; padding-right: 18px; }
        th:nth-child(4), td:nth-child(4) { display: none; }
        .locked-mode {
          flex-direction: column;
        }
        .locked-meta {
          align-items: flex-start;
          min-width: 0;
        }
      }
    </style>
  </head>
  <body>
    <main class="shell">
      <section class="hero">
        <h1>SMART Permission Tickets &mdash; Reference FHIR Server</h1>
        <p class="lede">
          This server hosts synthetic patient data for the
          <a href="https://build.fhir.org/ig/jmandel/smart-permission-tickets-wip/">SMART Permission Tickets IG</a>.
          It demonstrates how a Data Holder enforces ticket-based access constraints: scope filtering,
          date-range windowing, site partitioning, jurisdiction filtering, and sensitive-data exclusion
          &mdash; all resolved into a request-scoped visible set before any query executes.
        </p>
        <div class="pill-row">
          <span class="pill"><strong>Origin</strong> ${escapeHtml(url.origin)}</span>
          <span class="pill"><strong>Resources loaded</strong> ${context.store.loadResult.resourceCount}</span>
          <span class="pill"><strong>Patients</strong> ${patients.length}</span>
          <span class="pill"><strong>Sites</strong> ${sites.length}</span>
        </div>
        ${selectedMode === "anonymous" ? `<div class="warning">
          <strong>Preview mode</strong> at <code>/modes/anonymous</code> allows read-only FHIR access without a token for local development.
          It is intentionally separate from <code>open</code>, which only relaxes token exchange.
        </div>` : ""}
      </section>

      <section class="panel section">
        <h2>Server Entry Points</h2>
        ${modeLocked
          ? `<div class="locked-mode">
              <div>
                <h3>${escapeHtml(selectedModeCard.title)}</h3>
                <p>${escapeHtml(selectedModeCard.summary)}</p>
                <p><strong>Token exchange:</strong> ${escapeHtml(selectedModeCard.auth)}</p>
                <p><strong>FHIR:</strong> ${escapeHtml(selectedModeCard.fhir)}</p>
              </div>
              <div class="locked-meta">
                <code>${escapeHtml(selectedModeHref)}</code>
                <a class="button" href="/">Choose another mode</a>
              </div>
            </div>`
          : `<div class="mode-grid">
              ${modeCards.map((card) => `<a class="mode-card" href="${escapeHtml(modeHref(defaultMode, card.mode))}">
                <h3>${escapeHtml(card.title)}</h3>
                <p>${escapeHtml(card.summary)}</p>
                <p><strong>Token exchange:</strong> ${escapeHtml(card.auth)}</p>
                <p><strong>FHIR:</strong> ${escapeHtml(card.fhir)}</p>
                <div class="mode-card-path">${escapeHtml(modeHref(defaultMode, card.mode))}</div>
              </a>`).join("")}
            </div>`}
      </section>

      <section class="panel section">
        <h2>Selected Mode Entrypoints</h2>
        <div class="grid">
          ${entrypoints.map((entry) => `<article class="card">
            <h3>${escapeHtml(entry.label)}</h3>
            <p>${escapeHtml(entry.note)}</p>
            <a class="route" href="${escapeHtml(entry.href)}">${escapeHtml(absoluteUrl(url, entry.href))}</a>
          </article>`).join("")}
        </div>
      </section>

      <section class="panel section">
        <h2>Site Bases</h2>
        <table>
          <thead>
            <tr>
              <th>Site</th>
              <th>Patients</th>
              <th>Resources</th>
              <th>Links</th>
            </tr>
          </thead>
          <tbody>
            ${sites.map((site) => {
              const selectedSiteBase = `${prefix}/sites/${site.siteSlug}/fhir`;
              const unsafeSiteBase = `/modes/anonymous/sites/${site.siteSlug}/fhir`;
              const jurisdictions = site.jurisdictions.length ? ` · ${site.jurisdictions.join(", ")}` : "";
              return `<tr>
                <td>
                  <strong>${escapeHtml(site.organizationName)}</strong><br>
                  <span class="subtle"><code>${escapeHtml(site.siteSlug)}</code>${escapeHtml(jurisdictions)}</span>
                </td>
                <td>${site.patientCount}</td>
                <td>${site.resourceCount}</td>
                <td>
                  <div class="links">
                    <a href="${escapeHtml(selectedSiteBase + "/metadata")}">metadata</a>
                    ${selectedMode === "anonymous"
                      ? `<a href="${escapeHtml(unsafeSiteBase + "/Patient?_count=10")}">patients</a>`
                      : `<a href="${escapeHtml(unsafeSiteBase + "/metadata")}">preview metadata</a>
                         <a href="${escapeHtml(unsafeSiteBase + "/Patient?_count=10")}">preview patients</a>`}
                  </div>
                </td>
              </tr>`;
            }).join("")}
          </tbody>
        </table>
      </section>

      <section class="panel section">
        <h2>Synthetic Patients</h2>
        <p class="subtle" style="margin-top:0;margin-bottom:14px">Each patient exercises different Permission Ticket constraint dimensions. The scenarios are designed so that ticket-based filtering produces visibly different result sets.</p>
        <div class="grid">
          ${patients.map((patient) => {
            const scenario = PATIENT_SCENARIOS[patient.patientSlug];
            return `<article class="card">
            <h3>${escapeHtml(patient.displayName)}</h3>
            ${scenario ? `<p>${escapeHtml(scenario.summary)}</p>
            <p class="subtle">${escapeHtml(scenario.constraints)}</p>` : ""}
            <p><strong>Birth date:</strong> ${escapeHtml(patient.birthDate ?? "unknown")}</p>
            <div class="badges">
              ${patient.aliases.map((alias) => `<span class="badge">${escapeHtml(alias.siteSlug)}</span>`).join("")}
            </div>
            <div class="links" style="margin-top:8px">
              ${patient.aliases.map((alias) => {
                const patientId = escapeHtml(logicalIdFromReference(alias.serverPatientRef));
                return `<a href="/modes/anonymous/sites/${escapeHtml(alias.siteSlug)}/fhir/Patient/${patientId}">${escapeHtml(alias.siteSlug)}</a>`;
              }).join("")}
            </div>
          </article>`}).join("")}
        </div>
      </section>

      <section class="panel section">
        <h2>Data Contract</h2>
        <p class="subtle" style="margin-top:0">The server derives site, organization, and jurisdiction metadata from ingest context and site-level resources. The only FHIR-facing labels it relies on directly are <code>meta.security</code> entries stamped by the synth-data pipeline.</p>
        <table>
          <thead><tr><th>Tag/Label</th><th>System</th><th>Purpose</th></tr></thead>
          <tbody>
            <tr>
              <td><strong>Jurisdiction state</strong></td>
              <td><code>derived at ingest</code></td>
              <td>US state code (e.g., <code>TX</code>, <code>CA</code>, <code>IL</code>) resolved from the site's Organization/Location metadata. Enables jurisdiction-based ticket filtering without requiring repeated tags on every resource.</td>
            </tr>
            <tr>
              <td><strong>Source org NPI</strong></td>
              <td><code>derived at ingest</code></td>
              <td>NPI of the originating organization, resolved from the site Organization resource. Enables organization-based ticket filtering without FHIR-level tag clutter.</td>
            </tr>
            <tr>
              <td><strong>Sensitivity labels</strong></td>
              <td><code>meta.security</code><br><span class="subtle">http://terminology.hl7.org/CodeSystem/v3-ActCode</span></td>
              <td>Clinical sensitivity categories such as <code>SEX</code>, <code>MH</code>, <code>HIV</code>, <code>ETH</code>, <code>STD</code>, and <code>SDV</code>. When a ticket carries <code>sensitive.mode=deny</code>, resources with these labels are excluded from the visible set.</td>
            </tr>
          </tbody>
        </table>
      </section>

      <section class="panel section">
        <h2>Quick Query Shapes</h2>
        <div class="grid">
          ${queryExamples.map((example) => `<article class="card query-card">
            <div>
              <h3>${escapeHtml(example.title)}</h3>
              <p>${escapeHtml(example.note)}</p>
            </div>
            <p class="endpoint-line"><code>${escapeHtml(absoluteUrl(url, example.openHref))}</code></p>
            <div class="button-row">
              <button class="copy-button primary" type="button" data-copy="${escapeHtml(example.curl)}" onclick="copyCurl(this)">Copy curl</button>
              <a class="button" href="${escapeHtml(example.openHref)}">Open</a>
            </div>
          </article>`).join("")}
        </div>
      </section>
    </main>
    <script>
      async function copyCurl(button) {
        const text = button.dataset.copy || "";
        const original = button.textContent;
        try {
          await navigator.clipboard.writeText(text);
          button.textContent = "Copied";
          setTimeout(() => {
            button.textContent = original;
          }, 1200);
        } catch (error) {
          button.textContent = "Copy failed";
          setTimeout(() => {
            button.textContent = original;
          }, 1200);
        }
      }
    </script>
  </body>
</html>`;
}

function escapeHtml(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function logicalIdFromReference(reference: string) {
  return reference.split("/").at(-1) ?? reference;
}

function modeHref(defaultMode: ModeName, mode: ModeName) {
  return mode === defaultMode ? "/" : `/modes/${mode}`;
}

function shellQuote(value: string) {
  return `'${value.replaceAll("'", `'\"'\"'`)}'`;
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function htmlResponse(body: string, status = 200) {
  return new Response(body, {
    status,
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}

function fhirResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { "content-type": "application/fhir+json" },
  });
}

function operationOutcome(message: string, status = 400) {
  return fhirResponse(
    {
      resourceType: "OperationOutcome",
      issue: [
        {
          severity: status >= 500 ? "error" : "fatal",
          code: "processing",
          diagnostics: message,
        },
      ],
    },
    status,
  );
}

function notFound() {
  return operationOutcome("Resource not found", 404);
}

function methodNotAllowed(allow: string) {
  return new Response(null, { status: 405, headers: { allow } });
}
