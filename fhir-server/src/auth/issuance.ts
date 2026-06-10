// Proposal 003: ticket issuance via SMART App Launch.
//
// The issuer exposes a standard SMART configuration, authorize endpoint, and
// token endpoint. A client runs a standalone launch with PKCE and the
// permission_ticket marker scope; the token response carries freshly minted
// Permission Tickets plus endpoint hints for where they should work.
//
// In this demo the "verification and approval workflow" between authorize
// and redirect is a person picker: choosing a demo person stands in for the
// identity proofing and sharing-preference capture a real issuer would run.

import { randomUUID } from "node:crypto";

import type { DemoPersonSummary, FhirStore } from "../store/store.ts";
import { DEFAULT_DEMO_WELL_KNOWN_FRAMEWORK_URI } from "./demo-frameworks.ts";
import { PATIENT_SELF_ACCESS_TICKET_TYPE } from "../../shared/permission-tickets.ts";
import type { PresenterBinding } from "../../../shared/permission-ticket-schema.ts";
import type { ClientRegistry } from "./clients.ts";
import type { TicketIssuerRegistry } from "./issuers.ts";

const CODE_TTL_SECONDS = 300;
const TICKET_TTL_SECONDS = 3600;
const ACCESS_TOKEN_TTL_SECONDS = 300;
export const PERMISSION_TICKET_MARKER_SCOPE = "permission_ticket";

type SensitivityChoice = "release_authorized" | "withhold";

type IssuanceGrant = {
  issuerSlug: string;
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  scopes: string[];
  personSlug: string;
  sensitivity?: SensitivityChoice;
  expiresAt: number;
};

type IssuanceRefreshGrant = Omit<IssuanceGrant, "codeChallenge" | "redirectUri" | "expiresAt">;

export class IssuanceGrantStore {
  private readonly codes = new Map<string, IssuanceGrant>();
  private readonly refreshTokens = new Map<string, IssuanceRefreshGrant>();

  createCode(grant: Omit<IssuanceGrant, "expiresAt">) {
    const code = randomUUID();
    this.codes.set(code, { ...grant, expiresAt: nowSeconds() + CODE_TTL_SECONDS });
    return code;
  }

  // Codes are single-use: a second redemption attempt fails.
  consumeCode(code: string): IssuanceGrant | null {
    const grant = this.codes.get(code);
    if (!grant) return null;
    this.codes.delete(code);
    if (grant.expiresAt <= nowSeconds()) return null;
    return grant;
  }

  createRefreshToken(grant: IssuanceRefreshGrant) {
    const token = randomUUID();
    this.refreshTokens.set(token, grant);
    return token;
  }

  // Refresh tokens rotate: each use invalidates the presented token.
  consumeRefreshToken(token: string): IssuanceRefreshGrant | null {
    const grant = this.refreshTokens.get(token);
    if (!grant) return null;
    this.refreshTokens.delete(token);
    return grant;
  }
}

export function buildIssuerSmartConfiguration(origin: string, issuerSlug: string) {
  const issuerBase = `${origin}/issuer/${issuerSlug}`;
  return {
    issuer: issuerBase,
    authorization_endpoint: `${issuerBase}/authorize`,
    token_endpoint: `${issuerBase}/token`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    scopes_supported: ["openid", "fhirUser", PERMISSION_TICKET_MARKER_SCOPE, "offline_access"],
    code_challenge_methods_supported: ["S256"],
    capabilities: ["launch-standalone", "permission-ticket-issuance"],
    smart_permission_ticket_issuer: true,
    smart_permission_ticket_types_issued: [PATIENT_SELF_ACCESS_TICKET_TYPE],
  };
}

export type AuthorizeOutcome =
  | { kind: "error"; status: number; message: string }
  | { kind: "redirect"; location: string }
  | { kind: "picker"; persons: DemoPersonSummary[]; resumeParams: URLSearchParams };

export function handleAuthorizeRequest(
  url: URL,
  store: FhirStore,
  grants: IssuanceGrantStore,
  issuerSlug: string,
): AuthorizeOutcome {
  const params = url.searchParams;
  const redirectUri = params.get("redirect_uri");
  if (!redirectUri || !isHttpUrl(redirectUri)) {
    // Without a trustworthy redirect_uri, errors must not redirect.
    return { kind: "error", status: 400, message: "redirect_uri is required and must be an absolute URL" };
  }
  const state = params.get("state");
  const fail = (error: string, description: string): AuthorizeOutcome => {
    const target = new URL(redirectUri);
    target.searchParams.set("error", error);
    target.searchParams.set("error_description", description);
    if (state) target.searchParams.set("state", state);
    return { kind: "redirect", location: target.toString() };
  };

  if (params.get("response_type") !== "code") {
    return fail("unsupported_response_type", "response_type must be code");
  }
  const clientId = params.get("client_id");
  if (!clientId) return fail("invalid_request", "client_id is required");
  const codeChallenge = params.get("code_challenge");
  if (!codeChallenge) return fail("invalid_request", "code_challenge is required (PKCE S256)");
  const challengeMethod = params.get("code_challenge_method") ?? "plain";
  if (challengeMethod !== "S256") return fail("invalid_request", "code_challenge_method must be S256");
  const scopes = (params.get("scope") ?? "").split(/\s+/).filter(Boolean);
  if (!scopes.includes(PERMISSION_TICKET_MARKER_SCOPE)) {
    return fail("invalid_scope", `scope must include ${PERMISSION_TICKET_MARKER_SCOPE}`);
  }

  // Demo parameter: the authorizing person's sensitivity choice, captured
  // here because this picker stands in for the issuer's approval workflow.
  // It becomes a Proposal 005 sensitivity_policy claim on the minted ticket.
  const sensitivityParam = params.get("sensitivity");
  let sensitivity: SensitivityChoice | undefined;
  if (sensitivityParam !== null) {
    if (sensitivityParam !== "release_authorized" && sensitivityParam !== "withhold") {
      return fail("invalid_request", "sensitivity must be release_authorized or withhold");
    }
    sensitivity = sensitivityParam;
  }

  const persons = store.listDemoPersons();
  const personSlug = params.get("person");
  if (!personSlug) {
    return { kind: "picker", persons, resumeParams: params };
  }
  const person = persons.find((candidate) => candidate.patientSlug === personSlug);
  if (!person) return fail("invalid_request", `Unknown person: ${personSlug}`);

  const code = grants.createCode({
    issuerSlug,
    clientId,
    redirectUri,
    codeChallenge,
    scopes,
    personSlug,
    sensitivity,
  });
  const target = new URL(redirectUri);
  target.searchParams.set("code", code);
  if (state) target.searchParams.set("state", state);
  return { kind: "redirect", location: target.toString() };
}

export function renderPersonPicker(origin: string, issuerSlug: string, persons: DemoPersonSummary[], resumeParams: URLSearchParams) {
  const links = persons.map((person) => {
    const next = new URLSearchParams(resumeParams);
    next.set("person", person.patientSlug);
    const label = `${person.displayName}${person.birthDate ? ` (${person.birthDate})` : ""}`;
    return `<li><a href="${origin}/issuer/${issuerSlug}/authorize?${next.toString()}">${escapeHtml(label)}</a></li>`;
  });
  return `<!doctype html><html><head><title>Permission Ticket Issuer</title></head><body>
<h1>Demo issuer: who is authorizing?</h1>
<p>In a real deployment this step is the issuer's identity verification and
sharing-preference workflow. In this demo, picking a person stands in for it.</p>
<ul>${links.join("\n")}</ul>
</body></html>`;
}

export type TicketIssuanceResult = {
  tickets: string[];
  endpoints: Array<{
    fhir_base_url: string;
    organization: { resourceType: "Organization"; name: string; identifier?: Array<{ system: string; value: string }> };
    ticket_indices: number[];
  }>;
};

export async function redeemAuthorizationCode(input: {
  origin: string;
  issuerSlug: string;
  body: Record<string, any>;
  grants: IssuanceGrantStore;
  store: FhirStore;
  clients: ClientRegistry;
  issuers: TicketIssuerRegistry;
}): Promise<Record<string, unknown>> {
  const { body } = input;
  if (body.grant_type === "refresh_token") {
    if (typeof body.refresh_token !== "string" || !body.refresh_token) {
      throw new IssuanceTokenError("invalid_request", "refresh_token is required");
    }
    const grant = input.grants.consumeRefreshToken(body.refresh_token);
    if (!grant) throw new IssuanceTokenError("invalid_grant", "Unknown or already-used refresh token");
    return buildTokenResponse(input, grant);
  }

  if (body.grant_type !== "authorization_code") {
    throw new IssuanceTokenError("unsupported_grant_type", "Unsupported grant_type");
  }
  if (typeof body.code !== "string" || !body.code) {
    throw new IssuanceTokenError("invalid_request", "code is required");
  }
  const grant = input.grants.consumeCode(body.code);
  if (!grant || grant.issuerSlug !== input.issuerSlug) {
    throw new IssuanceTokenError("invalid_grant", "Unknown or expired authorization code");
  }
  if (body.client_id !== grant.clientId) {
    throw new IssuanceTokenError("invalid_grant", "client_id does not match the authorization request");
  }
  if (body.redirect_uri !== grant.redirectUri) {
    throw new IssuanceTokenError("invalid_grant", "redirect_uri does not match the authorization request");
  }
  if (typeof body.code_verifier !== "string" || !body.code_verifier) {
    throw new IssuanceTokenError("invalid_request", "code_verifier is required");
  }
  const computedChallenge = await s256Challenge(body.code_verifier);
  if (computedChallenge !== grant.codeChallenge) {
    throw new IssuanceTokenError("invalid_grant", "PKCE verification failed");
  }
  return buildTokenResponse(input, grant);
}

async function buildTokenResponse(
  input: {
    origin: string;
    issuerSlug: string;
    grants: IssuanceGrantStore;
    store: FhirStore;
    clients: ClientRegistry;
    issuers: TicketIssuerRegistry;
  },
  grant: IssuanceRefreshGrant,
) {
  const person = input.store.listDemoPersons().find((candidate) => candidate.patientSlug === grant.personSlug);
  if (!person) throw new IssuanceTokenError("invalid_grant", "Authorized person no longer exists");
  const binding = resolvePresenterBinding(grant.clientId, input.clients);
  const issuance = mintTicketsForPerson(input, person, grant.scopes, binding, grant.sensitivity);

  const grantedScopes = grant.scopes.filter((scope) => scope !== "openid" && scope !== "fhirUser");
  const response: Record<string, unknown> = {
    access_token: `issuance-${randomUUID()}`,
    token_type: "Bearer",
    expires_in: ACCESS_TOKEN_TTL_SECONDS,
    scope: grantedScopes.join(" "),
    smart_permission_ticket: issuance.tickets,
    smart_permission_ticket_endpoints: issuance.endpoints,
  };
  if (grant.scopes.includes("offline_access")) {
    response.refresh_token = input.grants.createRefreshToken({
      issuerSlug: grant.issuerSlug,
      clientId: grant.clientId,
      scopes: grant.scopes,
      personSlug: grant.personSlug,
      sensitivity: grant.sensitivity,
    });
  }
  return response;
}

// UC1 tickets must be presenter-bound, so the issuer needs a way to identify
// the client cryptographically: a well-known entity URI, or a client
// registered here with a known key.
function resolvePresenterBinding(clientId: string, clients: ClientRegistry): PresenterBinding {
  if (clientId.startsWith("well-known:")) {
    return {
      method: "trust_framework_client",
      trust_framework: DEFAULT_DEMO_WELL_KNOWN_FRAMEWORK_URI,
      framework_type: "well-known",
      entity_uri: clientId.slice("well-known:".length),
    };
  }
  const registered = clients.get(clientId);
  if (registered?.jwkThumbprint) {
    return { method: "jkt", jkt: registered.jwkThumbprint };
  }
  throw new IssuanceTokenError(
    "invalid_client",
    "Individual-access tickets must be presenter-bound; register this client with a key or use a well-known: client_id",
  );
}

function mintTicketsForPerson(
  input: { origin: string; issuerSlug: string; issuers: TicketIssuerRegistry },
  person: DemoPersonSummary,
  scopes: string[],
  binding: PresenterBinding,
  sensitivity?: SensitivityChoice,
): TicketIssuanceResult {
  const permissions = permissionsFromScopes(scopes);
  const now = nowSeconds();
  const payload = {
    ...(sensitivity
      ? {
          must_understand: ["sensitivity_policy"],
          sensitivity_policy: { unlisted_sensitive_data: sensitivity },
        }
      : {}),
    iss: `${input.origin}/issuer/${input.issuerSlug}`,
    aud: input.origin,
    exp: now + TICKET_TTL_SECONDS,
    iat: now,
    jti: randomUUID(),
    ticket_type: PATIENT_SELF_ACCESS_TICKET_TYPE,
    presenter_binding: binding,
    subject: {
      patient: {
        resourceType: "Patient" as const,
        name: [{ family: person.familyName ?? undefined, given: person.givenNames }],
        birthDate: person.birthDate ?? undefined,
      },
    },
    access: { permissions },
  };
  const ticket = input.issuers.sign(input.origin, input.issuerSlug, payload);

  const endpoints = person.sites.map((site) => ({
    fhir_base_url: `${input.origin}/modes/open/sites/${site.siteSlug}/fhir`,
    organization: {
      resourceType: "Organization" as const,
      name: site.orgName,
      ...(site.organizationNpi
        ? { identifier: [{ system: "http://hl7.org/fhir/sid/us-npi", value: site.organizationNpi }] }
        : {}),
    },
    ticket_indices: [0],
  }));

  return { tickets: [ticket], endpoints };
}

// SMART scopes from the authorize request describe the access the resulting
// tickets should authorize at Data Holders. Marker and identity scopes are
// not data scopes; everything else must be patient/<Type>.rs-shaped.
function permissionsFromScopes(scopes: string[]) {
  const permissions: Array<Record<string, unknown>> = [];
  for (const scope of scopes) {
    if ([PERMISSION_TICKET_MARKER_SCOPE, "openid", "fhirUser", "offline_access"].includes(scope)) continue;
    const match = scope.match(/^patient\/([A-Za-z*]+)\.rs$/);
    if (!match) throw new IssuanceTokenError("invalid_scope", `Unsupported scope for ticket issuance: ${scope}`);
    permissions.push({ kind: "data", resource_type: match[1], interactions: ["read", "search"] });
  }
  if (!permissions.length) {
    permissions.push({ kind: "data", resource_type: "*", interactions: ["read", "search"] });
  }
  return permissions;
}

export class IssuanceTokenError extends Error {
  readonly oauthError: string;
  constructor(oauthError: string, message: string) {
    super(message);
    this.oauthError = oauthError;
  }
}

async function s256Challenge(verifier: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return base64UrlEncode(new Uint8Array(digest));
}

function base64UrlEncode(bytes: Uint8Array) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function isHttpUrl(value: string) {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

function escapeHtml(value: string) {
  return value.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!);
}

function nowSeconds() {
  return Math.floor(Date.now() / 1000);
}
