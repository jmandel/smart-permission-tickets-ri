import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";

import { ClientRegistry } from "./auth/clients.ts";
import { toAuthenticatedClientIdentity } from "./auth/client-identity.ts";
import {
  buildDemoUdapClients,
  buildDemoWellKnownClients,
  buildDemoWellKnownFrameworkDocument,
  DEFAULT_DEMO_UDAP_FRAMEWORK_URI,
  DEFAULT_DEMO_WELL_KNOWN_FRAMEWORK_PATH,
  DEFAULT_DEMO_WELL_KNOWN_FRAMEWORK_URI,
  resolveDemoWellKnownClientKeys,
} from "./auth/demo-frameworks.ts";
import { FrameworkRegistry } from "./auth/frameworks/registry.ts";
import { ClientRegistrationError } from "./auth/frameworks/types.ts";
import {
  buildOidfDemoTopology,
  buildOidfTrustChain,
  findOidfEntityIdByConfigurationPath,
  findOidfIssuerEntityIdByFetchPath,
  mintOidfEntityConfiguration,
  mintOidfSubordinateStatement,
  type OidfDemoTopology,
} from "./auth/frameworks/oidf/demo-topology.ts";
import { oidfEntityConfigurationPath } from "./auth/frameworks/oidf/urls.ts";
import { decodeJwtWithoutVerification, verifyPrivateKeyJwt } from "../shared/private-key-jwt.ts";
import { TicketIssuerRegistry } from "./auth/issuers.ts";
import { signJwt, verifyJwt } from "./auth/jwt.ts";
import { TicketRevocationRegistry } from "./auth/ticket-revocation.ts";
import {
  compileAuthorizationEnvelope,
  compileClientCredentialsScopeRequest,
  narrowAuthorizationEnvelopeScopes,
  type TokenExchangeDiagnostics,
  validatePermissionTicket,
} from "./auth/tickets.ts";
import { DemoEventBus } from "./demo/event-bus.ts";
import { DemoSessionLinks } from "./demo/session-links.ts";
import { findUdapFrameworkByCrlPath, generateCertificateRevocationList } from "./auth/udap-crl.ts";
import { buildSignedUdapMetadata } from "./auth/udap-server-metadata.ts";
import { loadConfig, type ServerConfig } from "./config.ts";
import { assertDemoCryptoBundleCoversSites } from "./demo-crypto-bundle.ts";
import { buildNetworkCapabilityStatement, buildNetworkInfo, readNetworkDirectory, resolveRecordLocationsBundle, searchNetworkDirectory } from "./network-directory.ts";
import { executeRead, executeSearch, getSupportedSearchParams } from "./store/search.ts";
import { FhirStore } from "./store/store.ts";
import type { AuthenticatedClientIdentity, AuthorizationEnvelope, FrameworkClientBinding, ModeName, RegisteredClient, RouteContext, TokenExchangeRequest } from "./store/model.ts";
import { SUPPORTED_RESOURCE_TYPES } from "./store/model.ts";
import { buildAuthBasePath, buildFhirBasePath, modePrefix, normalizeModeSegment } from "../shared/surfaces.ts";
import {
  PATIENT_SELF_ACCESS_TICKET_TYPE,
  PERMISSION_TICKET_SUBJECT_TOKEN_TYPE,
  SMART_PERMISSION_TICKET_CONFIG_EXTENSION_URL,
  SUPPORTED_PERMISSION_TICKET_TYPES,
} from "../shared/permission-tickets.ts";
import { isDemoEventDraft, type DemoEvent, type DemoEventArtifacts, type DemoEventDraft, type DemoObserver } from "../shared/demo-events.ts";
import {
  PermissionTicketSchema,
  type PermissionTicket,
} from "../../shared/permission-ticket-schema.ts";

export type AppContext = {
  config: ServerConfig;
  store: FhirStore;
  clients: ClientRegistry;
  frameworks: FrameworkRegistry;
  oidfTopology: OidfDemoTopology;
  issuers: TicketIssuerRegistry;
  ticketRevocations: TicketRevocationRegistry;
  demoEvents: DemoEventBus;
  demoSessionLinks: DemoSessionLinks;
};

export function createAppContext(overrides: Partial<ServerConfig> = {}) {
  const config = { ...loadConfig(), ...overrides };
  const store = FhirStore.load();
  const clients = new ClientRegistry(config.defaultRegisteredClients, config.clientRegistrationSecret);
  const issuers = new TicketIssuerRegistry(config.permissionTicketIssuers);
  const oidfTopology = buildOidfTopologyForPublicBaseUrl(config, store, issuers);
  const frameworks = buildFrameworkRegistry(config, clients, oidfTopology);
  const ticketRevocations = new TicketRevocationRegistry();
  const demoEvents = new DemoEventBus();
  const demoSessionLinks = new DemoSessionLinks();
  return { config, store, clients, frameworks, oidfTopology, issuers, ticketRevocations, demoEvents, demoSessionLinks };
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
      "/trace": landingHtml,
    },
    fetch: (request, server) => handleRequest(context, request, server),
  });
  return server;
}

function buildOidfTopologyForPublicBaseUrl(
  config: ServerConfig,
  store: FhirStore,
  issuers: TicketIssuerRegistry,
  existingTopology?: OidfDemoTopology,
) {
  const defaultIssuer = issuers.get(config.defaultPermissionTicketIssuerSlug);
  const sites = store.listSiteSummaries();
  assertDemoCryptoBundleCoversSites(config.demoCryptoBundle, sites.map((site) => site.siteSlug));
  const bundle = config.demoCryptoBundle;
  const ticketIssuerKeys = bundle?.ticketIssuers[config.defaultPermissionTicketIssuerSlug] ?? defaultIssuer ?? undefined;
  return buildOidfDemoTopology(
    config.publicBaseUrl,
    config.strictDefaultMode,
    sites,
    config.defaultPermissionTicketIssuerSlug,
    config.defaultPermissionTicketIssuerName,
    {
      anchor: bundle?.oidf.anchor ?? (existingTopology ? extractOidfKeyMaterial(existingTopology, "anchor") : undefined),
      "app-network": bundle?.oidf.appNetwork ?? (existingTopology ? extractOidfKeyMaterial(existingTopology, "app-network") : undefined),
      "provider-network": bundle?.oidf.providerNetwork ?? (existingTopology ? extractOidfKeyMaterial(existingTopology, "provider-network") : undefined),
      "demo-app": bundle?.oidf.demoApp ?? (existingTopology ? extractOidfKeyMaterial(existingTopology, "demo-app") : undefined),
      "ticket-issuer": ticketIssuerKeys
        ? {
            publicJwk: ticketIssuerKeys.publicJwk,
            privateJwk: ticketIssuerKeys.privateJwk,
          }
        : existingTopology
          ? extractOidfKeyMaterial(existingTopology, "ticket-issuer")
          : undefined,
    },
    Object.fromEntries(
      sites.map((site) => [
        site.siteSlug,
        bundle?.oidf.providerSites[site.siteSlug] ?? (existingTopology ? extractProviderSiteKeyMaterial(existingTopology, site.siteSlug) : undefined),
      ]),
    ),
  );
}

function buildFrameworkRegistry(
  config: ServerConfig,
  clients: ClientRegistry,
  oidfTopology: OidfDemoTopology,
) {
  config.frameworks = config.frameworks.map((framework) => framework.frameworkType === "oidf"
    ? {
        ...framework,
        oidf: framework.oidf
          ? {
              trustAnchors: [
                {
                  entityId: oidfTopology.trustAnchorEntityId,
                  jwks: [oidfTopology.entities.anchor.publicJwk],
                },
              ],
              trustedLeaves: [
                {
                  entityId: oidfTopology.demoAppEntityId,
                  usage: "client",
                },
                {
                  entityId: oidfTopology.ticketIssuerEntityId,
                  usage: "issuer",
                  expectedIssuerUrl: oidfTopology.ticketIssuerUrl,
                  requiredTrustMarkType: oidfTopology.trustMarkType,
                },
              ],
            }
          : undefined,
      }
    : framework);
  return new FrameworkRegistry(config.frameworks, clients, config);
}

function extractOidfKeyMaterial(topology: OidfDemoTopology, role: keyof OidfDemoTopology["entities"]) {
  const entity = topology.entities[role];
  return {
    publicJwk: entity.publicJwk,
    privateJwk: entity.privateJwk,
  };
}

function extractProviderSiteKeyMaterial(topology: OidfDemoTopology, siteSlug: string) {
  const entity = topology.providerSiteEntities[siteSlug];
  if (!entity) return undefined;
  return {
    publicJwk: entity.publicJwk,
    privateJwk: entity.privateJwk,
  };
}

function syncOidfTopologyWithConfig(context: AppContext) {
  const currentOrigin = new URL(context.oidfTopology.trustAnchorEntityId).origin;
  if (currentOrigin === context.config.publicBaseUrl) return;
  context.oidfTopology = buildOidfTopologyForPublicBaseUrl(context.config, context.store, context.issuers, context.oidfTopology);
  context.frameworks = buildFrameworkRegistry(context.config, context.clients, context.oidfTopology);
}

export async function handleRequest(context: AppContext, request: Request, server?: Bun.Server<any>): Promise<Response> {
  syncOidfTopologyWithConfig(context);
  const url = configuredPublicUrl(context.config, request);
  if (url.pathname === "/demo/sessions") {
    return handleDemoSessionsRequest(context, request);
  }
  const demoEventsRoute = resolveDemoEventsRoute(url.pathname);
  if (demoEventsRoute) {
    return handleDemoEventsRequest(context, request, demoEventsRoute.sessionId, server);
  }
  const oidfRoute = resolveOidfRoute(context.oidfTopology, url.pathname);
  if (oidfRoute) {
    return handleOidfRequest(context.oidfTopology, request, url, oidfRoute);
  }
  if (url.pathname === "/.well-known/jwks.json") {
    return jsonResponse(buildDemoWellKnownJwks(context));
  }
  if (url.pathname.startsWith("/demo/clients/udap/")) {
    return handleDemoUdapRequest(context, url);
  }
  const demoWellKnownRoute = resolveDemoWellKnownRoute(url.pathname);
  if (demoWellKnownRoute) {
    return handleDemoWellKnownRequest(context, url, demoWellKnownRoute.clientSlug);
  }
  if (url.pathname === DEFAULT_DEMO_WELL_KNOWN_FRAMEWORK_PATH) {
    return jsonResponse(buildDemoWellKnownFrameworkDocument(url.origin));
  }
  const udapCrlRoute = resolveUdapCrlRoute(url.pathname);
  if (udapCrlRoute) {
    return handleUdapCrlRequest(context, udapCrlRoute.frameworkSlug, udapCrlRoute.caSlug);
  }
  if (url.pathname === "/demo/bootstrap") {
    const wellKnownFrameworkDocument = buildDemoWellKnownFrameworkDocument(url.origin);
    const wellKnownClient = wellKnownFrameworkDocument.clients[0];
    const wellKnownKeys = resolveDemoWellKnownClientKeys(context.config.demoCryptoBundle);
    const oidfClient = context.oidfTopology.entities["demo-app"];
    const udapClient = buildDemoUdapClients(url.origin, context.config.demoCryptoBundle).find((client) => client.algorithm === "RS256")
      ?? buildDemoUdapClients(url.origin, context.config.demoCryptoBundle)[0];
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
      demoClientOptions: [
        {
          type: "unaffiliated",
          label: "Unaffiliated registered client",
          description: "Generates a one-off JWK pair and dynamically registers it just before token exchange.",
          registrationMode: "dynamic-jwk",
        },
        {
          type: "well-known",
          label: "Well-known client",
          description: "Uses an implicit well-known client id and resolves keys from the entity JWKS without a registration call.",
          registrationMode: "implicit-well-known",
          framework: {
            uri: DEFAULT_DEMO_WELL_KNOWN_FRAMEWORK_URI,
            displayName: wellKnownFrameworkDocument.display_name,
            documentPath: DEFAULT_DEMO_WELL_KNOWN_FRAMEWORK_PATH,
            documentUrl: absoluteUrl(url, DEFAULT_DEMO_WELL_KNOWN_FRAMEWORK_PATH),
          },
          entityUri: wellKnownClient.entityUri,
          jwksUrl: wellKnownClient.jwksUrl,
          clientName: wellKnownClient.label,
          publicJwk: wellKnownKeys.publicJwk,
          privateJwk: wellKnownKeys.privateJwk,
        },
        {
          type: "oidf",
          label: "OIDF client",
          description: "Uses the Entity Identifier URL as client_id and authenticates with a trust_chain JOSE header. No registration call occurs. Client trust and ticket-issuer trust are evaluated separately.",
          registrationMode: "oidf-automatic",
          framework: {
            uri: context.oidfTopology.frameworkUri,
            displayName: "Demo OpenID Federation",
          },
          entityUri: context.oidfTopology.demoAppEntityId,
          entityConfigurationUrl: absoluteUrl(url, oidfEntityConfigurationPath(context.oidfTopology.demoAppEntityId)),
          clientName: String(oidfClient.metadata.oauth_client?.client_name ?? oidfClient.name),
          publicJwk: oidfClient.publicJwk,
          privateJwk: oidfClient.privateJwk,
          trustChain: buildOidfTrustChain(context.oidfTopology, context.oidfTopology.demoAppEntityId),
        },
        {
          type: "udap",
          label: "UDAP client",
          description: "Performs just-in-time UDAP registration with a certificate chain. The entity URI comes from the certificate SAN and resolves to a demo page on this server.",
          registrationMode: "udap-dcr",
          framework: {
            uri: DEFAULT_DEMO_UDAP_FRAMEWORK_URI,
            displayName: "Reference Demo UDAP Community",
            documentPath: "/.well-known/udap",
            documentUrl: absoluteUrl(url, "/.well-known/udap"),
          },
          entityUri: udapClient.entityUri,
          clientName: udapClient.clientName,
          scope: udapClient.scope,
          contacts: udapClient.contacts,
          algorithm: "RS256",
          certificatePem: udapClient.certificatePem,
          privateKeyPem: udapClient.privateKeyPem,
        },
      ],
      demoWellKnownFramework: wellKnownFrameworkDocument,
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
        return jsonResponse(buildSmartConfig(context, url, route.context), 200, { "cache-control": "public, max-age=300" });
      case "udap-config":
        return handleUdapConfig(context, request, url, route.context);
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
  const observer = demoObserverForRequest(context, request, body);
  const explicitSessionId = extractDemoSessionId(request);
  const authBasePath = buildAuthBasePath(context.config.strictDefaultMode, contextRoute);
  const authSurface = absoluteUrl(url, authBasePath);
  const registrationEndpoint = absoluteUrl(url, `${authBasePath}/register`);
  const tokenEndpoint = absoluteUrl(url, `${authBasePath}/token`);
  const requestArtifact = demoRequestArtifact(
    registrationEndpoint,
    "POST",
    { "content-type": request.headers.get("content-type") ?? "application/json" },
    body,
  );
  try {
    const frameworkRegistration = await context.frameworks.registerClient(body, registrationEndpoint, authSurface);
    if (frameworkRegistration) {
      if (explicitSessionId && frameworkRegistration.client?.clientId) {
        context.demoSessionLinks.bindClient(explicitSessionId, frameworkRegistration.client.clientId);
      }
      emitDemoEvent(observer, {
        source: "server",
        type: "registration-request",
        label: frameworkRegistration.audit?.authMode === "udap" ? "UDAP registration" : "Client registration",
        detail: {
          authMode: frameworkRegistration.audit?.authMode ?? frameworkRegistration.client?.authMode ?? "unaffiliated",
          endpoint: registrationEndpoint,
          outcome: frameworkRegistration.audit?.outcome ?? "registered",
          ...(contextRoute.siteSlug
            ? {
                siteSlug: contextRoute.siteSlug,
                siteName: siteNameForSlug(context, contextRoute.siteSlug) ?? contextRoute.siteSlug,
              }
            : {}),
          clientId: frameworkRegistration.client?.clientId,
          registrationMode: frameworkRegistration.client?.authMode === "udap" ? "udap-dcr" : "dynamic-jwk",
          frameworkUri: frameworkRegistration.audit?.frameworkUri ?? frameworkRegistration.client?.frameworkBinding?.framework,
          entityUri: frameworkRegistration.audit?.entityUri ?? frameworkRegistration.client?.frameworkBinding?.entity_uri,
          algorithm: frameworkRegistration.audit?.algorithm ?? "none",
          steps: frameworkRegistration.audit?.steps ?? [],
        },
        artifacts: {
          request: requestArtifact,
          response: demoResponseArtifact(
            frameworkRegistration.statusCode ?? 201,
            { "content-type": "application/json" },
            frameworkRegistration.response,
          ),
        },
      });
      return jsonResponse(frameworkRegistration.response, frameworkRegistration.statusCode ?? 201);
    }
  } catch (error) {
    if (error instanceof ClientRegistrationError) {
      emitDemoEvent(observer, {
        source: "server",
        type: "registration-request",
        label: error.audit?.authMode === "udap" ? "UDAP registration" : "Client registration",
        detail: {
          authMode: error.audit?.authMode ?? (("udap" in body || "software_statement" in body) ? "udap" : "unaffiliated"),
          endpoint: registrationEndpoint,
          outcome: "rejected",
          ...(contextRoute.siteSlug
            ? {
                siteSlug: contextRoute.siteSlug,
                siteName: siteNameForSlug(context, contextRoute.siteSlug) ?? contextRoute.siteSlug,
              }
            : {}),
          frameworkUri: error.audit?.frameworkUri,
          entityUri: error.audit?.entityUri,
          algorithm: error.audit?.algorithm ?? "unknown",
          steps: error.audit?.steps ?? [],
          error: error.description,
        },
        artifacts: {
          request: requestArtifact,
          response: demoResponseArtifact(
            error.status,
            { "content-type": "application/json" },
            { error: error.errorCode, error_description: error.description },
          ),
        },
      });
      return registrationErrorResponse(error);
    }
    throw error;
  }
  const publicJwk = parseRegisteredClientJwk(body);
  const client = await context.clients.register({
    clientName: body.client_name,
    publicJwk,
    authSurfaceUrl: authSurface,
    tokenEndpointAuthMethod: body.token_endpoint_auth_method,
  });
  if (explicitSessionId) {
    context.demoSessionLinks.bindClient(explicitSessionId, client.clientId);
  }
  const responseBody = {
    client_id: client.clientId,
    client_name: client.clientName,
    token_endpoint_auth_method: client.tokenEndpointAuthMethod,
    jwks: registeredClientJwks(client),
    jwk_thumbprint: client.jwkThumbprint,
    registration_client_uri: absoluteUrl(url, `${authBasePath}/register/${client.clientId}`),
    token_endpoint: tokenEndpoint,
  };
  emitDemoEvent(observer, {
    source: "server",
    type: "registration-request",
    label: "Client registration",
    detail: {
      authMode: client.authMode ?? "unaffiliated",
      endpoint: registrationEndpoint,
      outcome: "registered",
      ...(contextRoute.siteSlug
        ? {
            siteSlug: contextRoute.siteSlug,
            siteName: siteNameForSlug(context, contextRoute.siteSlug) ?? contextRoute.siteSlug,
          }
        : {}),
      clientId: client.clientId,
      registrationMode: "dynamic-jwk",
      algorithm: "none",
      steps: [{
        check: "Client JWK",
        passed: true,
        evidence: client.jwkThumbprint,
        why: "Dynamic client registration accepted the posted public JWK",
      }],
    },
    artifacts: {
      request: requestArtifact,
      response: demoResponseArtifact(201, { "content-type": "application/json" }, responseBody),
    },
  });
  return jsonResponse(responseBody, 201);
}

async function handleToken(context: AppContext, request: Request, url: URL, contextRoute: RouteContext) {
  if (request.method !== "POST") return methodNotAllowed("POST");
  let body: (TokenExchangeRequest & Record<string, any>) | null = null;
  let observer: DemoObserver | null = null;
  let authenticatedClientAuthMode: AuthenticatedClientIdentity["authMode"] | undefined;
  let authenticatedClientId: string | undefined;
  const authBasePath = buildAuthBasePath(context.config.strictDefaultMode, contextRoute);
  const tokenEndpointUrl = absoluteUrl(url, `${authBasePath}/token`);
  const authSurfaceUrl = absoluteUrl(url, authBasePath);
  const tokenDiagnostics: TokenExchangeDiagnostics = { steps: [], relatedArtifacts: [] };
  try {
    body = (await parseBody(request)) as TokenExchangeRequest & Record<string, any>;
    observer = demoObserverForRequest(context, request, body);
    if (!body.grant_type) {
      throw new OAuthTokenError("invalid_request", "Missing grant_type");
    }
    const tokenRequestArtifact = demoRequestArtifact(
      tokenEndpointUrl,
      "POST",
      { "content-type": request.headers.get("content-type") ?? "application/x-www-form-urlencoded" },
      body,
    );

    if (body.grant_type === "client_credentials") {
      let client: AuthenticatedClientIdentity | null;
      try {
        client = await authenticateClient(
          context,
          request,
          body,
          contextRoute.mode,
          tokenEndpointUrl,
          authSurfaceUrl,
          tokenDiagnostics,
        );
        authenticatedClientAuthMode = client?.authMode;
        authenticatedClientId = client?.clientId;
      } catch (error) {
        throw new OAuthTokenError("invalid_client", error instanceof Error ? error.message : "Client authentication failed", 401);
      }
      if (!client || client.authMode !== "udap" || !client.frameworkBinding) {
        throw new OAuthTokenError("invalid_client", "UDAP-authenticated client required for client_credentials", 401);
      }

      let envelope: AuthorizationEnvelope;
      try {
        envelope = buildClientCredentialsEnvelope(context, client, contextRoute, body.scope);
      } catch (error) {
        const message = error instanceof Error ? error.message : "Invalid client_credentials request";
        const oauthError = message.includes("scope") ? "invalid_scope" : "invalid_request";
        throw new OAuthTokenError(oauthError, message);
      }
      return issueAccessTokenResponse(context, url, contextRoute, envelope, client, observer, tokenRequestArtifact, {
        grantType: body.grant_type,
        diagnostics: tokenDiagnostics,
      });
    }

    if (body.grant_type !== "urn:ietf:params:oauth:grant-type:token-exchange") {
      throw new OAuthTokenError("unsupported_grant_type", "Unsupported grant_type");
    }
    if (!body.subject_token_type) {
      throw new OAuthTokenError("invalid_request", "Missing subject_token_type");
    }
    if (body.subject_token_type !== PERMISSION_TICKET_SUBJECT_TOKEN_TYPE) {
      throw new OAuthTokenError("invalid_request", "Unsupported subject_token_type");
    }
    if (!body.subject_token) {
      throw new OAuthTokenError("invalid_request", "No permission ticket provided");
    }

    let ticket;
    const demoValidationContext = contextRoute.siteSlug
      ? {
          phase: "site-auth" as const,
          siteSlug: contextRoute.siteSlug,
          siteName: siteNameForSlug(context, contextRoute.siteSlug),
        }
      : {
          phase: "network-auth" as const,
        };
    try {
      ticket = await validatePermissionTicket(
        body.subject_token,
        context.issuers,
        context.frameworks,
        context.ticketRevocations,
        buildKnownTicketAudienceUrls(url, context.config, contextRoute),
        url.origin,
        tokenDiagnostics,
      );
    } catch (error) {
      throw new OAuthTokenError("invalid_grant", error instanceof Error ? error.message : "Invalid permission ticket");
    }
    let client: AuthenticatedClientIdentity | null;
    try {
      client = await authenticateClient(
        context,
        request,
        body,
        contextRoute.mode,
        tokenEndpointUrl,
        authSurfaceUrl,
        tokenDiagnostics,
      );
      authenticatedClientAuthMode = client?.authMode;
      authenticatedClientId = client?.clientId;
    } catch (error) {
      throw new OAuthTokenError("invalid_client", error instanceof Error ? error.message : "Client authentication failed", 401);
    }
    try {
      const proofKeyJkt = ticket.ticket.presenter_binding?.method === "jkt" ? ticket.ticket.presenter_binding.jkt : undefined;
      const frameworkClientBinding = ticket.ticket.presenter_binding?.method === "framework_client"
        ? {
            method: "framework_client" as const,
            framework: ticket.ticket.presenter_binding.framework,
            framework_type: ticket.ticket.presenter_binding.framework_type,
            entity_uri: ticket.ticket.presenter_binding.entity_uri,
          }
        : undefined;
      enforceClientRequirements(proofKeyJkt, frameworkClientBinding, client, contextRoute.mode);
      tokenDiagnostics.steps.push({
        check: "Client Binding",
        passed: true,
        evidence: frameworkClientBinding && client?.frameworkBinding
          ? client.frameworkBinding.entity_uri
          : client?.jwkThumbprint ?? "anonymous",
        why: frameworkClientBinding
          ? "Authenticated client matches the ticket presenter binding"
          : proofKeyJkt
            ? "Authenticated client proof key matches the ticket presenter binding"
            : "No presenter binding was required for this request mode",
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Client binding failed";
      tokenDiagnostics.steps.push({
        check: "Client Binding",
        passed: false,
        reason: message,
      });
      const oauthError = message.startsWith("Ticket ") ? "invalid_grant" : "invalid_client";
      const status = oauthError === "invalid_client" ? 401 : 400;
      throw new OAuthTokenError(oauthError, message, status);
    }

    let envelope;
    try {
      envelope = bindEnvelopeToRoute(
        compileAuthorizationEnvelope(ticket, context.store, contextRoute.mode, tokenDiagnostics, demoValidationContext),
        contextRoute,
      );
      if (contextRoute.siteSlug && !context.store.hasVisibleEncounter(envelope, contextRoute.siteSlug)) {
        throw new Error("Requested site has no visible encounters under current ticket constraints");
      }
      if (contextRoute.networkSlug) {
        const networkScope = narrowScopeString(
          "system/Endpoint.rs system/Organization.rs system/$resolve-record-locations",
          body.scope,
        );
        envelope = { ...envelope, scope: networkScope, grantedScopes: networkScope.split(/\s+/).filter(Boolean) };
      } else {
        envelope = narrowAuthorizationEnvelopeScopes(envelope, body.scope);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "Invalid token request";
      const oauthError = message.includes("Requested scope") ? "invalid_scope" : "invalid_grant";
      throw new OAuthTokenError(oauthError, message);
    }

    return issueAccessTokenResponse(context, url, contextRoute, envelope, client, observer, tokenRequestArtifact, {
      grantType: body.grant_type,
      diagnostics: tokenDiagnostics,
    });
  } catch (error) {
    const oauthError = asOAuthTokenError(error);
    if (observer && body) {
      emitDemoEvent(observer, buildTokenExchangeDemoEvent({
        context,
        url,
        contextRoute,
        observer,
        requestArtifact: demoRequestArtifact(
          tokenEndpointUrl,
          "POST",
          { "content-type": request.headers.get("content-type") ?? "application/x-www-form-urlencoded" },
          body,
        ),
        responseArtifact: demoResponseArtifact(
          oauthError.status,
          {
            "content-type": "application/json",
            "cache-control": "no-store",
            pragma: "no-cache",
          },
          {
            error: oauthError.errorCode,
            error_description: oauthError.description,
          },
        ),
        grantType: body.grant_type ?? "unknown",
        diagnostics: tokenDiagnostics,
        outcome: "rejected",
        clientAuthMode: authenticatedClientAuthMode,
        clientId: authenticatedClientId,
        error: oauthError.description,
      }));
    }
    return tokenErrorResponse(oauthError);
  }
}

async function handleSignTicket(context: AppContext, request: Request, url: URL, issuerSlug: string) {
  if (request.method !== "POST") return methodNotAllowed("POST");
  const body = await parseBody(request);
  const payload = normalizeTicketPayload(body, url.origin);
  const signedTicket = context.issuers.sign(url.origin, issuerSlug, payload);
  const issuerInfo = context.issuers.describe(url.origin, issuerSlug);
  const explicitSessionId = extractDemoSessionId(request);
  if (explicitSessionId) {
    context.demoSessionLinks.bindTicket(explicitSessionId, signedTicket);
    emitDemoEvent(context.demoEvents.observer(explicitSessionId), buildTicketCreatedDemoEvent(payload, signedTicket));
  }
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
  await authenticateClient(
    context,
    request,
    body,
    contextRoute.mode,
    absoluteUrl(url, `${authBasePath}/introspect`),
    absoluteUrl(url, authBasePath),
  );
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
      presenter_binding: buildPresenterBindingSummary(payload),
      ticket_issuer_trust: payload.ticketIssuerTrust,
    });
  } catch {
    return jsonResponse({ active: false });
  }
}

async function handleRead(context: AppContext, request: Request, contextRoute: RouteContext, resourceType: string, logicalId: string) {
  if (request.method !== "GET") return methodNotAllowed("GET");
  const observer = demoObserverForRequest(context, request);
  try {
    const envelope = authenticateAccessToken(context, request, contextRoute);
    if (contextRoute.networkSlug) {
      const resource = readNetworkDirectory(context.config, context.store, configuredPublicUrl(context.config, request), contextRoute, resourceType, logicalId);
      return resource ? fhirResponse(resource) : notFound();
    }
    const resource = executeRead(context.store.db, envelope, contextRoute.siteSlug, resourceType, logicalId);
    if (resource && contextRoute.siteSlug) {
      const requestArtifact = demoRequestArtifact(
        absoluteUrl(configuredPublicUrl(context.config, request), `${buildFhirBasePath(context.config.strictDefaultMode, contextRoute)}/${resourceType}/${logicalId}`),
        request.method,
        {},
      );
      emitDemoEvent(observer, {
        source: "server",
        phase: "data",
        type: "query-result",
        label: resourceType,
        detail: {
          siteSlug: contextRoute.siteSlug,
          siteName: siteNameForSlug(context, contextRoute.siteSlug) ?? contextRoute.siteSlug,
          resourceType,
          count: 1,
          queryPath: `${resourceType}/${logicalId}`,
        },
        artifacts: {
          request: requestArtifact,
          response: demoResponseArtifact(200, { "content-type": "application/fhir+json" }, resource),
        },
      });
    }
    return resource ? fhirResponse(resource) : notFound();
  } catch (error) {
    if (contextRoute.siteSlug) {
      const requestArtifact = demoRequestArtifact(
        absoluteUrl(configuredPublicUrl(context.config, request), `${buildFhirBasePath(context.config.strictDefaultMode, contextRoute)}/${resourceType}/${logicalId}`),
        request.method,
        {},
      );
      emitDemoEvent(observer, {
        source: "server",
        phase: "data",
        type: "query-failed",
        label: resourceType,
        detail: {
          siteSlug: contextRoute.siteSlug,
          siteName: siteNameForSlug(context, contextRoute.siteSlug) ?? contextRoute.siteSlug,
          resourceType,
          queryPath: `${resourceType}/${logicalId}`,
          reason: error instanceof Error ? error.message : "Query failed",
        },
        artifacts: {
          request: requestArtifact,
        },
      });
    }
    throw error;
  }
}

async function handleSearch(context: AppContext, request: Request, url: URL, contextRoute: RouteContext, resourceType: string) {
  if (!["GET", "POST"].includes(request.method)) return methodNotAllowed("GET, POST");
  const observer = demoObserverForRequest(context, request);
  try {
    const envelope = authenticateAccessToken(context, request, contextRoute);
    const params = await parseSearchParams(request, url);
    if (contextRoute.networkSlug) {
      void envelope;
      return fhirResponse(searchNetworkDirectory(context.config, context.store, url, contextRoute, resourceType, params));
    }
    const basePath = buildFhirBasePath(context.config.strictDefaultMode, contextRoute);
    const bundle = executeSearch(context.store.db, envelope, contextRoute.siteSlug, resourceType, params, absoluteUrl(url, `${basePath}/${resourceType}`));
    const offset = Number(params.get("_offset") ?? 0);
    if (contextRoute.siteSlug && (!Number.isFinite(offset) || offset <= 0)) {
      const queryPath = params.size ? `${resourceType}?${params.toString()}` : resourceType;
      const requestArtifact = demoRequestArtifact(
        absoluteUrl(configuredPublicUrl(context.config, request), `${basePath}/${queryPath}`),
        request.method,
        {},
      );
      emitDemoEvent(observer, {
        source: "server",
        phase: "data",
        type: "query-result",
        label: resourceType,
        detail: {
          siteSlug: contextRoute.siteSlug,
          siteName: siteNameForSlug(context, contextRoute.siteSlug) ?? contextRoute.siteSlug,
          resourceType,
          count: Number(bundle?.total ?? bundle?.entry?.length ?? 0),
          queryPath,
        },
        artifacts: {
          request: requestArtifact,
          response: demoResponseArtifact(200, { "content-type": "application/fhir+json" }, bundle),
        },
      });
    }
    return fhirResponse(bundle);
  } catch (error) {
    if (contextRoute.siteSlug) {
      const params = request.method === "GET" ? new URL(request.url).searchParams : new URLSearchParams();
      const queryPath = params.size ? `${resourceType}?${params.toString()}` : resourceType;
      const requestArtifact = demoRequestArtifact(
        absoluteUrl(configuredPublicUrl(context.config, request), `${buildFhirBasePath(context.config.strictDefaultMode, contextRoute)}/${queryPath}`),
        request.method,
        {},
      );
      emitDemoEvent(observer, {
        source: "server",
        phase: "data",
        type: "query-failed",
        label: resourceType,
        detail: {
          siteSlug: contextRoute.siteSlug,
          siteName: siteNameForSlug(context, contextRoute.siteSlug) ?? contextRoute.siteSlug,
          resourceType,
          queryPath,
          reason: error instanceof Error ? error.message : "Query failed",
        },
        artifacts: {
          request: requestArtifact,
        },
      });
    }
    throw error;
  }
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
  const observer = demoObserverForRequest(context, request);
  switch (operation) {
    case "resolve-record-locations": {
      const bundle = resolveRecordLocationsBundle(context.config, context.store, url, contextRoute, envelope);
      emitDemoEvent(observer, {
        source: "server",
        phase: "discovery",
        type: "sites-discovered",
        label: "Sites discovered",
        detail: {
          sites: (bundle.entry ?? [])
            .filter((entry: any) => entry?.resource?.resourceType === "Endpoint")
            .map((entry: any) => ({
              siteSlug: (entry.resource.identifier ?? []).find((identifier: any) => identifier.system === "urn:smart-permission-tickets:site-slug")?.value ?? "unknown-site",
              siteName: entry.resource.managingOrganization?.display ?? "Unknown site",
              jurisdiction: undefined,
            })),
        },
        artifacts: {
          request: demoRequestArtifact(
            absoluteUrl(configuredPublicUrl(context.config, request), `${buildFhirBasePath(context.config.strictDefaultMode, contextRoute)}/$resolve-record-locations`),
            request.method,
            request.headers,
            { resourceType: "Parameters" },
          ),
          response: demoResponseArtifact(200, { "content-type": "application/fhir+json" }, bundle),
        },
      });
      return fhirResponse(bundle);
    }
  }
}

async function authenticateClient(
  context: AppContext,
  request: Request,
  body: Record<string, any>,
  mode: ModeName,
  tokenEndpointUrl: string,
  authSurfaceUrl: string,
  diagnostics?: TokenExchangeDiagnostics,
): Promise<AuthenticatedClientIdentity | null> {
  const basic = parseBasicAuth(request.headers.get("authorization"));
  const clientId = basic?.clientId ?? body.client_id;
  const requiresBoundClient = mode === "registered" || mode === "strict" || mode === "key-bound";
  const assertionJwt = body.client_assertion ? String(body.client_assertion) : null;

  if (!assertionJwt) {
    if (requiresBoundClient) throw new Error("Authenticated key-based client assertion required");
    const client = clientId ? context.clients.get(clientId) : null;
    if (!client) return null;
    enforceClientRegistrationScope(client, authSurfaceUrl);
    return toAuthenticatedClientIdentity(client);
  }

  if (body.client_assertion_type && body.client_assertion_type !== "urn:ietf:params:oauth:client-assertion-type:jwt-bearer") {
    throw new Error("Unsupported client_assertion_type");
  }

  const decoded = decodeJwtWithoutVerification<any>(assertionJwt);
  const assertedClientId = String(decoded.payload.iss ?? "");
  if (!assertedClientId) throw new Error("Client assertion iss missing");
  if (assertedClientId.startsWith("udap:") && String(body.udap ?? "") !== "1") {
    throw new Error("UDAP client authentication requires udap=1");
  }
  if (clientId && clientId !== assertedClientId) throw new Error("client_id does not match client assertion issuer");
  const frameworkClient = await context.frameworks.authenticateClientAssertion(assertedClientId, assertionJwt, tokenEndpointUrl);
  if (frameworkClient) {
    enforceClientRegistrationScope(frameworkClient, authSurfaceUrl);
    appendFrameworkClientDiagnostics(frameworkClient, diagnostics);
    return frameworkClient;
  }
  const client = context.clients.get(assertedClientId);
  if (!client) throw new Error("Authenticated registered client required");
  enforceClientRegistrationScope(client, authSurfaceUrl);
  return verifyClientAssertion(assertionJwt, client, tokenEndpointUrl);
}

function appendFrameworkClientDiagnostics(
  client: AuthenticatedClientIdentity,
  diagnostics: TokenExchangeDiagnostics | undefined,
) {
  if (!diagnostics || client.authMode !== "oidf") return;
  const metadata = client.resolvedEntity?.metadata as Record<string, any> | undefined;
  if (metadata?.trust_chain) {
    diagnostics.steps.push({
      check: "Client trust via OIDF",
      passed: true,
      evidence: `depth=${String(metadata.trust_chain_depth ?? "")}`,
      why: "Client assertion supplied a trust_chain that validated to the configured Trust Anchor",
    });
    diagnostics.relatedArtifacts.push({
      label: "Client trust via OIDF: decoded trust chain",
      kind: "json",
      content: metadata.trust_chain,
    });
  }
  if (metadata?.resolved_metadata) {
    diagnostics.steps.push({
      check: "Client metadata via OIDF policy",
      passed: true,
      evidence: typeof metadata.resolved_metadata?.oauth_client?.client_name === "string"
        ? metadata.resolved_metadata.oauth_client.client_name
        : client.clientName,
      why: "Metadata policy was applied top-down to resolve the client metadata and leaf JWKS",
    });
    diagnostics.relatedArtifacts.push({
      label: "Client trust via OIDF: resolved metadata",
      kind: "json",
      content: metadata.resolved_metadata,
    });
  }
}

async function verifyClientAssertion(jwt: string, client: RegisteredClient, tokenEndpointUrl: string): Promise<AuthenticatedClientIdentity> {
  if (client.tokenEndpointAuthMethod !== "private_key_jwt" || !client.publicJwk) {
    throw new Error("Client does not support private_key_jwt");
  }
  const { payload } = await verifyPrivateKeyJwt<any>(jwt, client.publicJwk as JsonWebKey & { kty: "EC"; crv: "P-256"; x: string; y: string });
  const now = Math.floor(Date.now() / 1000);
  if (payload.iss !== client.clientId || payload.sub !== client.clientId) throw new Error("Invalid client assertion");
  if (payload.aud !== tokenEndpointUrl) throw new Error("Client assertion audience mismatch");
  if (typeof payload.exp !== "number" || payload.exp <= now) throw new Error("Client assertion expired");
  if (typeof payload.iat === "number" && payload.iat > now + 60) throw new Error("Client assertion issued in the future");
  return toAuthenticatedClientIdentity(client);
}

function enforceClientRequirements(
  ticketJkt: string | undefined,
  frameworkClientBinding: FrameworkClientBinding | undefined,
  client: AuthenticatedClientIdentity | null,
  mode: ModeName,
) {
  if (ticketJkt && client?.jwkThumbprint !== ticketJkt) throw new Error("Ticket not bound to client key");
  if (frameworkClientBinding) {
    if (!client?.frameworkBinding) {
      throw new Error(`Ticket presenter binding requires framework ${frameworkClientBinding.framework} entity ${frameworkClientBinding.entity_uri}`);
    }
    if (
      client.frameworkBinding.method !== frameworkClientBinding.method
      || client.frameworkBinding.framework !== frameworkClientBinding.framework
      || client.frameworkBinding.framework_type !== frameworkClientBinding.framework_type
      || client.frameworkBinding.entity_uri !== frameworkClientBinding.entity_uri
    ) {
      throw new Error(`Ticket presenter binding requires framework ${frameworkClientBinding.framework} entity ${frameworkClientBinding.entity_uri}`);
    }
  }
  if ((mode === "strict" || mode === "registered" || mode === "key-bound") && !client) {
    throw new Error("Authenticated registered client required");
  }
}

function enforceClientRegistrationScope(
  client: Pick<RegisteredClient, "registeredAuthSurface" | "clientId"> | Pick<AuthenticatedClientIdentity, "registeredAuthSurface" | "clientId">,
  authSurfaceUrl: string,
) {
  if (client.registeredAuthSurface && client.registeredAuthSurface !== authSurfaceUrl) {
    throw new OAuthTokenError("invalid_client", "Client registration is scoped to a different auth surface", 401);
  }
}

function buildClientCredentialsEnvelope(
  context: AppContext,
  client: AuthenticatedClientIdentity,
  contextRoute: RouteContext,
  requestedScope: string | undefined,
): AuthorizationEnvelope {
  const scopeResult = compileClientCredentialsScopeRequest(requestedScope, client.registeredScope);
  const allowedSites = contextRoute.siteSlug ? [contextRoute.siteSlug] : undefined;
  const allowedPatientAliases = allowedSites
    ? context.store.loadResult.patientAliases.filter((alias) => allowedSites.includes(alias.siteSlug))
    : context.store.loadResult.patientAliases;
  if (!allowedPatientAliases.length) {
    throw new Error("client_credentials request resolved to no visible patient aliases");
  }
  return {
    ticketIssuer: "urn:smart-permission-tickets:udap-client-credentials",
    grantSubject: client.frameworkBinding?.entity_uri ?? client.clientId,
    ticketType: "urn:smart-permission-tickets:udap-client-credentials",
    mode: contextRoute.mode,
    scope: scopeResult.scopeString,
    grantedScopes: scopeResult.scopeStrings,
    patient: undefined,
    allowedPatientAliases,
    allowedSites,
    allowedResourceTypes: scopeResult.allowedResourceTypes,
    dateRanges: undefined,
    dateSemantics: "generated-during-period",
    sensitive: { mode: "allow" },
    requiredLabelsAll: scopeResult.requiredLabelsAll,
    deniedLabelsAny: scopeResult.deniedLabelsAny,
    granularCategoryRules: scopeResult.granularCategoryRules,
    presenterFrameworkClient: client.frameworkBinding,
  };
}

function issueAccessTokenResponse(
  context: AppContext,
  url: URL,
  contextRoute: RouteContext,
  envelope: AuthorizationEnvelope,
  client: AuthenticatedClientIdentity | null,
  observer?: DemoObserver | null,
  requestArtifact?: DemoEventArtifacts["request"],
  eventOptions?: {
    grantType: string;
    diagnostics: TokenExchangeDiagnostics;
  },
) {
  const fhirBasePath = buildFhirBasePath(context.config.strictDefaultMode, contextRoute);
  const now = Math.floor(Date.now() / 1000);
  const issuedScope = envelope.scope;
  const accessTokenPayload = {
    iss: context.config.issuer,
    aud: absoluteUrl(url, fhirBasePath),
    sub: envelope.grantSubject,
    exp: now + context.config.accessTokenTtlSeconds,
    iat: now,
    jti: randomUUID(),
    typ: "at+jwt",
    client_id: client?.clientId,
    ...envelope,
    scope: issuedScope,
  };
  const accessToken = signJwt(accessTokenPayload, context.config.accessTokenSecret);
  const responseBody = {
    access_token: accessToken,
    token_type: "Bearer",
    issued_token_type: "urn:ietf:params:oauth:token-type:access_token",
    expires_in: context.config.accessTokenTtlSeconds,
    scope: issuedScope,
    patient: contextRoute.networkSlug ? undefined : envelope.patient,
  };
  if (observer?.sessionId) {
    context.demoSessionLinks.bindAccessToken(observer.sessionId, accessToken);
  }
  emitDemoEvent(observer ?? null, buildTokenExchangeDemoEvent({
    context,
    url,
    contextRoute,
    observer,
    requestArtifact,
    responseArtifact: demoResponseArtifact(200, {
      "content-type": "application/json",
      "cache-control": "no-store",
      pragma: "no-cache",
    }, responseBody),
    grantType: eventOptions?.grantType ?? "unknown",
    diagnostics: eventOptions?.diagnostics ?? { steps: [], relatedArtifacts: [] },
    outcome: "issued",
    clientAuthMode: client?.authMode,
    clientId: client?.clientId,
    scopes: envelope.grantedScopes,
    scopeSummary: issuedScope,
    authorizedSiteCount: envelope.allowedSites?.length,
    extraRelatedArtifacts: [
      { label: "Access token", kind: "jwt", content: accessToken, copyText: accessToken },
    ],
  }));
  return tokenJsonResponse(responseBody);
}

function buildTokenExchangeDemoEvent(input: {
  context: AppContext;
  url: URL;
  contextRoute: RouteContext;
  observer?: DemoObserver | null;
  requestArtifact?: DemoEventArtifacts["request"];
  responseArtifact?: DemoEventArtifacts["response"];
  grantType: string;
  diagnostics: TokenExchangeDiagnostics;
  outcome: "issued" | "rejected";
  clientAuthMode?: AuthenticatedClientIdentity["authMode"];
  clientId?: string;
  scopes?: string[];
  scopeSummary?: string;
  authorizedSiteCount?: number;
  error?: string;
  extraRelatedArtifacts?: NonNullable<DemoEventArtifacts["related"]>;
}): DemoEventDraft {
  const siteName = input.contextRoute.siteSlug
    ? siteNameForSlug(input.context, input.contextRoute.siteSlug) ?? input.contextRoute.siteSlug
    : undefined;
  return {
    source: "server",
    type: "token-exchange",
    label: input.contextRoute.siteSlug
      ? input.outcome === "issued" ? "Site token issued" : "Site token rejected"
      : input.outcome === "issued" ? "Network token issued" : "Network token rejected",
    detail: {
      grantType: input.grantType,
      endpoint: absoluteUrl(input.url, `${buildAuthBasePath(input.context.config.strictDefaultMode, input.contextRoute)}/token`),
      mode: input.contextRoute.mode,
      outcome: input.outcome,
      ...(input.clientAuthMode ? { clientAuthMode: input.clientAuthMode } : {}),
      ...(input.clientId ? { clientId: input.clientId } : {}),
      scopes: input.scopes,
      scopeSummary: input.scopeSummary,
      ...(input.contextRoute.siteSlug ? {
        siteSlug: input.contextRoute.siteSlug,
        siteName,
      } : {
        authorizedSiteCount: input.authorizedSiteCount,
      }),
      ...(input.diagnostics.patientMatch ? { patientMatch: input.diagnostics.patientMatch } : {}),
      steps: input.diagnostics.steps,
      ...(input.error ? { error: input.error } : {}),
    },
    artifacts: {
      ...(input.requestArtifact ? { request: input.requestArtifact } : {}),
      ...(input.responseArtifact ? { response: input.responseArtifact } : {}),
      related: [
        ...input.diagnostics.relatedArtifacts,
        ...(input.extraRelatedArtifacts ?? []),
      ],
    },
  };
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
    absoluteUrl(configuredPublicUrl(context.config, request), buildFhirBasePath(context.config.strictDefaultMode, contextRoute)),
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
  if (payload.presenterProofKey?.jkt && proofJkt !== payload.presenterProofKey.jkt) throw new Error("Access token proof key mismatch");
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

function buildDemoWellKnownJwks(context: AppContext) {
  const keys = resolveDemoWellKnownClientKeys(context.config.demoCryptoBundle);
  return {
    keys: [keys.publicJwk],
  };
}

function handleDemoWellKnownRequest(context: AppContext, url: URL, clientSlug: string) {
  const client = buildDemoWellKnownClients(url.origin).find((entry) => entry.slug === clientSlug);
  if (!client) return notFound();
  if (url.pathname.endsWith("/.well-known/jwks.json")) {
    return jsonResponse(buildDemoWellKnownJwks(context));
  }
  return jsonResponse({
    entity_uri: client.entityUri,
    label: client.label,
    description: client.description,
    framework: client.framework,
    jwks_url: client.jwksUrl,
  });
}

function handleDemoUdapRequest(context: AppContext, url: URL) {
  const client = buildDemoUdapClients(url.origin, context.config.demoCryptoBundle).find((entry) => entry.entityPath === url.pathname);
  if (!client) return notFound();
  return jsonResponse({
    entity_uri: client.entityUri,
    label: client.label,
    description: client.description,
    framework: client.framework,
    algorithm: client.algorithm,
    certificate_san_uri: client.certificateSanUri,
    certificate_chain_pem: client.certificateChainPems,
    note: "This entity URI comes from the client certificate Subject Alternative Name (SAN) and is what UDAP registration binds to.",
  });
}

function buildSmartConfig(context: AppContext, url: URL, contextRoute: RouteContext) {
  const authBasePath = buildAuthBasePath(context.config.strictDefaultMode, contextRoute);
  const fhirBasePath = buildFhirBasePath(context.config.strictDefaultMode, contextRoute);
  const grantTypesSupported = ["urn:ietf:params:oauth:grant-type:token-exchange"];
  if (context.config.frameworks.some((framework) => framework.frameworkType === "udap" && framework.supportsClientAuth)) {
    grantTypesSupported.unshift("client_credentials");
  }
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
    grant_types_supported: grantTypesSupported,
    smart_permission_ticket_types_supported: [...SUPPORTED_PERMISSION_TICKET_TYPES],
    token_endpoint_auth_methods_supported: ["none", "private_key_jwt"],
    token_endpoint_auth_signing_alg_values_supported: ["ES256"],
    scopes_supported: scopesSupported,
    extensions: {
      [SMART_PERMISSION_TICKET_CONFIG_EXTENSION_URL]: {
        permission_ticket_profile: "v2",
        surface_kind: contextRoute.networkSlug ? "network" : contextRoute.siteSlug ? "site" : "global",
        surface_mode: contextRoute.mode,
        supported_client_binding_types: ["jkt", "framework_client"],
        supported_trust_frameworks: context.frameworks.getSupportedTrustFrameworks(),
        ...(contextRoute.networkSlug ? { record_location_operation: "$resolve-record-locations" } : {}),
      },
    },
  };
}

function parseRegisteredClientJwk(body: Record<string, any>) {
  const direct = body.jwk;
  const fromJwks = Array.isArray(body.jwks?.keys) ? body.jwks.keys[0] : undefined;
  const candidate = direct ?? fromJwks;
  if (!candidate || typeof candidate !== "object") throw new Error("Dynamic registration requires a public JWK");
  return candidate as JsonWebKey;
}

function registeredClientJwks(client: RegisteredClient) {
  if (client.availablePublicJwks?.length) return { keys: client.availablePublicJwks };
  if (client.publicJwk) return { keys: [client.publicJwk] };
  return undefined;
}

function normalizeTicketPayload(body: Record<string, any>, audienceOrigin: string) {
  const payload = (body.ticket ?? body.ticket_payload ?? body) as Record<string, any>;
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("Ticket payload must be an object");
  }
  const candidate = {
    ...payload,
    aud: payload.aud ?? audienceOrigin,
    ticket_type: payload.ticket_type ?? PATIENT_SELF_ACCESS_TICKET_TYPE,
  };
  const parsed = PermissionTicketSchema.safeParse(candidate);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new Error(issue?.message ?? "Invalid Permission Ticket payload");
  }
  return parsed.data;
}

function buildTicketCreatedDemoEvent(ticketPayload: PermissionTicket, signedTicket: string): DemoEventDraft {
  const patientName = formatTicketPatientName(ticketPayload.subject.patient) ?? "Permission Ticket";
  const scopes = expandPermissionLabels(ticketPayload.access.permissions);
  return {
    source: "server",
    phase: "ticket",
    type: "ticket-created",
    label: "Permission Ticket created",
    detail: {
      patientName,
      patientDob: typeof ticketPayload.subject.patient.birthDate === "string" ? ticketPayload.subject.patient.birthDate : null,
      scopes,
      dateSummary: summarizeTicketPeriod(ticketPayload.access.data_period),
      sensitiveSummary: ticketPayload.access.sensitive_data === "include"
        ? "Sensitive included"
        : ticketPayload.access.sensitive_data === "exclude"
          ? "Sensitive excluded"
          : "Sensitive policy uses recipient default",
      expirySummary: summarizeTicketExpiry(ticketPayload.exp),
      bindingSummary: summarizeTicketBinding(ticketPayload),
    },
    artifacts: {
      related: [
        {
          label: "Permission Ticket JWT",
          kind: "jwt",
          content: signedTicket,
          copyText: signedTicket,
        },
      ],
    },
  };
}

function formatTicketPatientName(patient: PermissionTicket["subject"]["patient"]) {
  const names = Array.isArray(patient.name) ? patient.name : [];
  const first = names[0];
  if (!first || typeof first !== "object") return null;
  const given = Array.isArray(first.given) ? first.given.filter((item: unknown) => typeof item === "string") : [];
  const family = typeof first.family === "string" ? first.family : null;
  return [...given, ...(family ? [family] : [])].join(" ").trim() || null;
}

function summarizeTicketPeriod(period: { start?: string; end?: string } | undefined) {
  if (!period) return "All dates";
  const startYear = typeof period.start === "string" ? period.start.slice(0, 4) : null;
  const endYear = typeof period.end === "string" ? period.end.slice(0, 4) : null;
  if (startYear && endYear) return `${startYear}–${endYear}`;
  if (startYear) return `From ${startYear}`;
  if (endYear) return `Through ${endYear}`;
  return "Custom range";
}

function summarizeTicketExpiry(exp: unknown) {
  if (typeof exp !== "number") return "Unknown expiry";
  const deltaSeconds = Math.max(0, exp - Math.floor(Date.now() / 1000));
  if (deltaSeconds >= 60 * 60 * 24 * 365 * 9) return "10 years (demo stand-in for never)";
  if (deltaSeconds >= 60 * 60 * 24 * 365) return "1 year";
  if (deltaSeconds >= 60 * 60 * 24 * 30) return "30 days";
  if (deltaSeconds >= 60 * 60 * 24 * 7) return "7 days";
  if (deltaSeconds >= 60 * 60 * 24) return "1 day";
  if (deltaSeconds >= 60 * 60) return "1 hour";
  return "Short-lived";
}

function summarizeTicketBinding(ticketPayload: PermissionTicket) {
  if (ticketPayload.presenter_binding?.method === "framework_client") return "Framework-bound client";
  if (ticketPayload.presenter_binding?.method === "jkt") return "Proof-key client";
  return "No presenter binding";
}

function buildPresenterBindingSummary(payload: {
  presenterProofKey?: { jkt: string };
  presenterFrameworkClient?: FrameworkClientBinding;
}) {
  if (payload.presenterFrameworkClient) return payload.presenterFrameworkClient;
  if (payload.presenterProofKey) {
    return {
      method: "jkt" as const,
      jkt: payload.presenterProofKey.jkt,
    };
  }
  return undefined;
}

function expandPermissionLabels(permissions: PermissionTicket["access"]["permissions"]) {
  const wildcardTypes = [
    "Patient",
    "Encounter",
    "Observation",
    "Condition",
    "DiagnosticReport",
    "DocumentReference",
    "MedicationRequest",
    "Procedure",
    "Immunization",
    "ServiceRequest",
    "AllergyIntolerance",
  ];
  const expanded = new Set<string>();
  for (const permission of permissions) {
    if (permission.kind !== "data") continue;
    const resourceType = permission.resource_type;
    if (resourceType === "*") {
      for (const type of wildcardTypes) expanded.add(type);
      continue;
    }
    expanded.add(resourceType);
  }
  const order = new Map(wildcardTypes.map((label, index) => [label, index]));
  return [...expanded].sort((left, right) => (order.get(left) ?? Number.MAX_SAFE_INTEGER) - (order.get(right) ?? Number.MAX_SAFE_INTEGER) || left.localeCompare(right));
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

function handleUdapConfig(context: AppContext, request: Request, url: URL, contextRoute: RouteContext) {
  const frameworks = context.config.frameworks.filter((framework) => framework.frameworkType === "udap" && framework.supportsClientAuth);
  if (!frameworks.length) return notFound();
  const requestedCommunity = url.searchParams.get("community");
  const selectedFramework = requestedCommunity
    ? frameworks.find((framework) => framework.framework === requestedCommunity)
    : frameworks[0];
  if (requestedCommunity && !selectedFramework) {
    return new Response(null, { status: 204 });
  }
  const authBasePath = buildAuthBasePath(context.config.strictDefaultMode, contextRoute);
  const fhirBasePath = buildFhirBasePath(context.config.strictDefaultMode, contextRoute);
  const authorizationEndpoint = null;
  const tokenEndpoint = absoluteUrl(url, `${authBasePath}/token`);
  const registrationEndpoint = absoluteUrl(url, `${authBasePath}/register`);
  const signedFramework = selectedFramework ?? frameworks[0];
  const signedMetadata = buildSignedUdapMetadata(
    signedFramework,
    absoluteUrl(url, fhirBasePath),
    {
      token_endpoint: tokenEndpoint,
      registration_endpoint: registrationEndpoint,
      ...(authorizationEndpoint ? { authorization_endpoint: authorizationEndpoint } : {}),
    },
  );
  const discoveryUrl = absoluteUrl(url, `${fhirBasePath}/.well-known/udap`) + url.search;
  const responseBody = {
    udap_versions_supported: ["1"],
    udap_profiles_supported: ["udap_dcr", "udap_authn", "udap_authz"],
    udap_authorization_extensions_supported: ["hl7-b2b"],
    udap_authorization_extensions_required: ["hl7-b2b"],
    udap_certifications_supported: [],
    grant_types_supported: ["client_credentials", "urn:ietf:params:oauth:grant-type:token-exchange"],
    scopes_supported: ["patient/*.rs", "system/*.rs"],
    token_endpoint: tokenEndpoint,
    registration_endpoint: registrationEndpoint,
    token_endpoint_auth_methods_supported: ["private_key_jwt"],
    token_endpoint_auth_signing_alg_values_supported: ["RS256", "ES256"],
    registration_endpoint_jwt_signing_alg_values_supported: ["RS256", "ES256"],
    signed_metadata: signedMetadata,
    supported_trust_communities: frameworks.map((framework) => framework.framework),
    ...(selectedFramework ? { community: selectedFramework.framework } : {}),
  };
  emitDemoEvent(demoObserverForRequest(context, request), {
    source: "server",
    phase: "registration",
    type: "udap-discovery",
    label: "UDAP discovery",
    detail: {
      endpoint: discoveryUrl,
    },
    artifacts: {
      response: demoResponseArtifact(200, { "cache-control": "public, max-age=300", "content-type": "application/json" }, responseBody),
    },
  });
  return jsonResponse(responseBody, 200, { "cache-control": "public, max-age=300" });
}

function handleUdapCrlRequest(context: AppContext, frameworkSlug: string, caSlug: string) {
  const match = findUdapFrameworkByCrlPath(context.config.frameworks, frameworkSlug, caSlug);
  if (!match) return notFound();
  const crl = generateCertificateRevocationList(match.authority);
  return new Response(Buffer.from(crl.der), {
    status: 200,
    headers: {
      "content-type": "application/pkix-crl",
    },
  });
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
  | { kind: "udap-config"; context: RouteContext }
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
  if (segments[index] === ".well-known" && segments[index + 1] === "udap" && segments.length === index + 2) {
    return { kind: "udap-config", context: { mode } };
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
  if (segments[index] === ".well-known" && segments[index + 1] === "udap" && segments.length === index + 2) {
    return { kind: "udap-config", context };
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

function resolveDemoWellKnownRoute(pathname: string) {
  const match = pathname.match(/^\/demo\/clients\/([^/]+)(?:\/\.well-known\/jwks\.json)?$/);
  if (!match) return null;
  return { clientSlug: match[1] };
}

function resolveUdapCrlRoute(pathname: string) {
  const match = pathname.match(/^\/\.well-known\/udap\/crls\/([^/]+)\/([^/]+)\.crl$/);
  if (!match) return null;
  return {
    frameworkSlug: match[1],
    caSlug: match[2],
  };
}

function resolveDemoEventsRoute(pathname: string) {
  const match = pathname.match(/^\/demo\/events\/([^/]+)$/);
  if (!match?.[1]) return null;
  return { sessionId: decodeURIComponent(match[1]) };
}

function resolveOidfRoute(topology: OidfDemoTopology, pathname: string):
  | { kind: "entity-configuration"; entityId: string }
  | { kind: "federation-fetch"; issuerEntityId: string }
  | null {
  const entityId = findOidfEntityIdByConfigurationPath(topology, pathname);
  if (entityId) {
    return { kind: "entity-configuration", entityId };
  }
  const issuerEntityId = findOidfIssuerEntityIdByFetchPath(topology, pathname);
  if (issuerEntityId) {
    return { kind: "federation-fetch", issuerEntityId };
  }
  return null;
}

function handleOidfRequest(
  topology: OidfDemoTopology,
  request: Request,
  url: URL,
  route: { kind: "entity-configuration"; entityId: string } | { kind: "federation-fetch"; issuerEntityId: string },
) {
  if (request.method !== "GET") return methodNotAllowed("GET");
  switch (route.kind) {
    case "entity-configuration": {
      const statement = mintOidfEntityConfiguration(topology, route.entityId);
      return statement
        ? jwtResponse(statement, "application/entity-statement+jwt")
        : notFound();
    }
    case "federation-fetch": {
      const subjectEntityId = url.searchParams.get("sub");
      if (!subjectEntityId) {
        return operationOutcome("Missing sub query parameter", 400);
      }
      const statement = mintOidfSubordinateStatement(topology, route.issuerEntityId, subjectEntityId);
      return statement
        ? jwtResponse(statement, "application/entity-statement+jwt")
        : notFound();
    }
  }
}

async function handleDemoEventsRequest(context: AppContext, request: Request, sessionId: string, server?: Bun.Server<any>) {
  if (request.method === "GET") {
    try {
      server?.timeout(request, 0);
    } catch {
      // Best-effort only; local/demo use still works without explicit timeout control.
    }
    const lastEventId = Number.parseInt(request.headers.get("last-event-id") ?? "0", 10);
    let unsubscribe = () => {};
    let heartbeat: ReturnType<typeof setInterval> | null = null;
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const send = (chunk: string) => controller.enqueue(encoder.encode(chunk));
        send("retry: 1000\n\n");
        unsubscribe = context.demoEvents.subscribe(
          sessionId,
          (event) => send(formatDemoEventSse(event)),
          Number.isFinite(lastEventId) ? lastEventId : 0,
        );
        heartbeat = setInterval(() => {
          send(": ping\n\n");
        }, 15000);
      },
      cancel() {
        unsubscribe();
        if (heartbeat) clearInterval(heartbeat);
      },
    });
    return new Response(stream, {
      headers: {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
        "x-accel-buffering": "no",
      },
    });
  }

  if (request.method === "POST") {
    const body = await parseBody(request);
    if (!isDemoEventDraft(body)) {
      return jsonResponse(
        {
          error: "invalid_demo_event",
          error_description: "Demo event POST body did not match the expected shape",
        },
        400,
      );
    }
    const event = context.demoEvents.emit(sessionId, {
      ...body,
      source: "viewer",
    } satisfies DemoEventDraft);
    return jsonResponse(event, 202);
  }

  return methodNotAllowed("GET, POST");
}

function handleDemoSessionsRequest(context: AppContext, request: Request) {
  if (request.method !== "GET") return methodNotAllowed("GET");
  return jsonResponse(
    {
      sessions: context.demoEvents.listSessions(),
    },
    200,
    { "cache-control": "no-store" },
  );
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

function extractDemoSessionId(request: Request) {
  const value = request.headers.get("x-demo-session")?.trim();
  return value ? value : null;
}

function inferDemoSessionId(context: AppContext, request: Request, body?: Record<string, any> | null) {
  const explicit = extractDemoSessionId(request);
  if (explicit) return explicit;
  if (body?.subject_token && typeof body.subject_token === "string") {
    const fromTicket = context.demoSessionLinks.sessionForTicket(body.subject_token);
    if (fromTicket) return fromTicket;
  }
  if (body?.client_id && typeof body.client_id === "string") {
    const fromClient = context.demoSessionLinks.sessionForClient(body.client_id);
    if (fromClient) return fromClient;
  }
  if (body?.token && typeof body.token === "string") {
    const fromToken = context.demoSessionLinks.sessionForAccessToken(body.token);
    if (fromToken) return fromToken;
  }
  const bearerToken = extractBearerToken(request);
  if (bearerToken) {
    const fromAccessToken = context.demoSessionLinks.sessionForAccessToken(bearerToken);
    if (fromAccessToken) return fromAccessToken;
  }
  return null;
}

function demoObserverForRequest(context: AppContext, request: Request, body?: Record<string, any> | null): DemoObserver | null {
  const sessionId = inferDemoSessionId(context, request, body);
  return sessionId ? context.demoEvents.observer(sessionId) : null;
}

function emitDemoEvent(observer: DemoObserver | null, event: DemoEventDraft) {
  if (!observer) return null;
  return observer.emit(event);
}

function extractBearerToken(request: Request) {
  const header = request.headers.get("authorization");
  return header?.startsWith("Bearer ") ? header.slice("Bearer ".length) : null;
}

function demoRequestArtifact(url: string, method: string, headers: Headers | Record<string, string> | undefined, body?: unknown): DemoEventArtifacts["request"] {
  const normalizedHeaders = headers instanceof Headers
    ? Object.fromEntries(headers.entries())
    : headers ?? {};
  return { method, url, headers: normalizedHeaders, body };
}

function demoResponseArtifact(status: number, headers: Headers | Record<string, string> | undefined, body?: unknown): DemoEventArtifacts["response"] {
  const normalizedHeaders = headers instanceof Headers
    ? Object.fromEntries(headers.entries())
    : headers ?? {};
  return { status, headers: normalizedHeaders, body };
}

function formatDemoEventSse(event: DemoEvent) {
  return `id: ${event.seq}\ndata: ${JSON.stringify(event)}\n\n`;
}

function siteNameForSlug(context: AppContext, siteSlug: string | undefined) {
  if (!siteSlug) return undefined;
  return context.store.listSiteSummaries().find((site) => site.siteSlug === siteSlug)?.organizationName ?? siteSlug;
}

function buildAnonymousEnvelope(context: AppContext): AuthorizationEnvelope {
  return {
    ticketIssuer: "local-anonymous-mode",
    grantSubject: "anonymous-read-only",
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

function buildKnownTicketAudienceUrls(url: URL, config: ServerConfig, contextRoute: RouteContext) {
  const authBasePath = buildAuthBasePath(config.strictDefaultMode, contextRoute);
  const fhirBasePath = buildFhirBasePath(config.strictDefaultMode, contextRoute);
  const audienceUrls = [
    url.origin,
    absoluteUrl(url, authBasePath),
    absoluteUrl(url, fhirBasePath),
    absoluteUrl(url, `${authBasePath}/token`),
  ];
  return [...new Set(audienceUrls)];
}

function configuredPublicUrl(config: ServerConfig, request: Request): URL {
  const raw = new URL(request.url);
  return new URL(`${config.publicBaseUrl}${raw.pathname}${raw.search}`);
}

class OAuthTokenError extends Error {
  constructor(
    readonly errorCode: "invalid_request" | "invalid_grant" | "invalid_scope" | "unsupported_grant_type" | "invalid_client",
    readonly description: string,
    readonly status = 400,
  ) {
    super(description);
  }
}

function asOAuthTokenError(error: unknown) {
  if (error instanceof OAuthTokenError) return error;
  return new OAuthTokenError("invalid_request", error instanceof Error ? error.message : "Token request failed");
}

function tokenErrorResponse(error: OAuthTokenError) {
  return tokenJsonResponse(
    {
      error: error.errorCode,
      error_description: error.description,
    },
    error.status,
  );
}

function registrationErrorResponse(error: ClientRegistrationError) {
  return jsonResponse(
    {
      error: error.errorCode,
      error_description: error.description,
    },
    error.status,
  );
}

function narrowScopeString(grantedScope: string, requestedScope: string | undefined) {
  if (!requestedScope) return grantedScope;
  const granted = new Set(grantedScope.split(/\s+/).map((entry) => entry.trim()).filter(Boolean));
  const requested = [...new Set(requestedScope.split(/\s+/).map((entry) => entry.trim()).filter(Boolean))];
  if (!requested.length) return grantedScope;
  for (const scope of requested) {
    if (!granted.has(scope)) {
      throw new Error(`Requested scope is not permitted by the ticket: ${scope}`);
    }
  }
  return requested.join(" ");
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
      summary: "Sender-constrained token exchange and token use when tickets carry presenter_binding.method = jkt.",
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
    ...(context.config.frameworks.some((framework) => framework.frameworkType === "udap" && framework.supportsClientAuth)
      ? [{ label: "UDAP Metadata", href: `${prefix}/.well-known/udap`, note: "UDAP discovery metadata for registration and token auth." }]
      : []),
    { label: "Dynamic Registration", href: `${prefix}/register`, note: "Client registration endpoint." },
    ...(context.config.frameworks.some((framework) => framework.frameworkType === "well-known" && framework.supportsClientAuth)
      ? [{ label: "Demo Well-Known JWKS", href: "/.well-known/jwks.json", note: "Built-in JWKS for the demo well-known client entity." }]
      : []),
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
              <td>Clinical sensitivity categories such as <code>SEX</code>, <code>MH</code>, <code>HIV</code>, <code>ETH</code>, <code>STD</code>, and <code>SDV</code>. When a ticket carries <code>access.sensitive_data=exclude</code>, resources with these labels are excluded from the visible set.</td>
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

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

function jwtResponse(body: string, contentType = "application/jwt", status = 200, headers: Record<string, string> = {}) {
  return new Response(body, {
    status,
    headers: {
      "content-type": contentType,
      "cache-control": "public, max-age=300",
      ...headers,
    },
  });
}

function tokenJsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: {
      "content-type": "application/json",
      "cache-control": "no-store",
      pragma: "no-cache",
    },
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
