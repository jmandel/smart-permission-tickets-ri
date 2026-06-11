// Proposal 003: ticket issuance via SMART App Launch.
//
// The issuer exposes a standard SMART configuration, authorize endpoint, and
// token endpoint. A client runs a standalone launch with PKCE and the
// permission_ticket marker scope; the token response carries freshly minted
// Permission Tickets plus endpoint hints for where they should work.
//
// In this demo the "verification and approval workflow" between authorize
// and redirect is Elena Reyes's consent screen: it stands in for the identity
// proofing and sharing-preference capture a real issuer would run. Elena is
// fixed (the demo's story is about her), and the screen captures two choices:
// whether to include sensitive categories, and whether to share with any site
// in the network or only an explicit subset of her sites.

import { randomUUID } from "node:crypto";

import type { DemoPersonSummary, DemoSiteSummary, FhirStore } from "../store/store.ts";
import { DEFAULT_DEMO_WELL_KNOWN_FRAMEWORK_URI } from "./demo-frameworks.ts";
import { PATIENT_SELF_ACCESS_TICKET_TYPE } from "../../shared/permission-tickets.ts";
import type { PresenterBinding } from "../../../shared/permission-ticket-schema.ts";
import type { ClientRegistry } from "./clients.ts";
import type { TicketIssuerRegistry } from "./issuers.ts";

const CODE_TTL_SECONDS = 300;
const TICKET_TTL_SECONDS = 3600;
const ACCESS_TOKEN_TTL_SECONDS = 300;
export const PERMISSION_TICKET_MARKER_SCOPE = "permission_ticket";

// The demo's protagonist. The issuer's consent screen is hers and hers only;
// other demo persons exist for the workbench, not this issuance flow.
const CONSENT_PERSON_SLUG = "elena-reyes";

type SensitivityChoice = "release_authorized" | "withhold";

// An authorize request the issuer has accepted but whose approval ceremony
// (Elena's consent screen, in this demo) has not finished yet. The ceremony's
// outcomes — the sensitivity choice and the site selection — are captured by
// the issuer's own UI, never by parameters on the client's request.
type PendingAuthorization = {
  issuerSlug: string;
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  scopes: string[];
  state: string | null;
  expiresAt: number;
};

type IssuanceGrant = {
  issuerSlug: string;
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  scopes: string[];
  personSlug: string;
  sensitivity?: SensitivityChoice;
  // Site selection from the consent screen. Undefined means "any site in the
  // network" (one blanket ticket); a non-empty list means Elena chose explicit
  // sites and each gets its own site-scoped ticket. Carried through refresh so
  // re-minted tickets preserve the choice.
  selectedSites?: string[];
  expiresAt: number;
};

type IssuanceRefreshGrant = Omit<IssuanceGrant, "codeChallenge" | "redirectUri" | "expiresAt">;

export class IssuanceGrantStore {
  private readonly pending = new Map<string, PendingAuthorization>();
  private readonly codes = new Map<string, IssuanceGrant>();
  private readonly refreshTokens = new Map<string, IssuanceRefreshGrant>();

  createPending(request: Omit<PendingAuthorization, "expiresAt">) {
    const id = randomUUID();
    this.pending.set(id, { ...request, expiresAt: nowSeconds() + CODE_TTL_SECONDS });
    return id;
  }

  consumePending(id: string): PendingAuthorization | null {
    const request = this.pending.get(id);
    if (!request) return null;
    this.pending.delete(id);
    if (request.expiresAt <= nowSeconds()) return null;
    return request;
  }

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

export type ConsentSite = {
  siteSlug: string;
  orgName: string;
  // A site whose only encounters carry sensitive security labels: naming it at
  // all discloses the care relationship, so it is offered for selection only
  // when Elena chooses to include sensitive categories.
  sensitiveOnly: boolean;
};

export type AuthorizeOutcome =
  | { kind: "error"; status: number; message: string }
  | { kind: "redirect"; location: string }
  | { kind: "consent"; person: DemoPersonSummary; sites: ConsentSite[]; requestId: string };

// Accepts only the SMART App Launch authorize parameters. Everything the
// approval ceremony decides arrives later through completeAuthorization.
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

  const person = findConsentPerson(store);
  if (!person) {
    return { kind: "error", status: 500, message: `Demo consent person ${CONSENT_PERSON_SLUG} is not loaded` };
  }

  const requestId = grants.createPending({
    issuerSlug,
    clientId,
    redirectUri,
    codeChallenge,
    scopes,
    state,
  });
  return { kind: "consent", person, sites: consentSitesForPerson(store, person), requestId };
}

// Elena is the only person the consent screen offers; the demo's whole story
// is about her records moving across sites with one authorization.
function findConsentPerson(store: FhirStore): DemoPersonSummary | undefined {
  return store.listDemoPersons().find((candidate) => candidate.patientSlug === CONSENT_PERSON_SLUG);
}

// The sites the consent screen may offer, flagged for the sensitivity rule:
// a site whose only encounters are sensitivity-labeled is "sensitive-only" and
// is offered for selection only after Elena includes sensitive categories.
function consentSitesForPerson(store: FhirStore, person: DemoPersonSummary): ConsentSite[] {
  return person.sites.map((site) => ({
    siteSlug: site.siteSlug,
    orgName: site.orgName,
    sensitiveOnly: store.countNonSensitiveEncounters(person.patientSlug, site.siteSlug) === 0,
  }));
}

// Finishes the approval ceremony. In this demo the inputs come from Elena's
// consent form; a real issuer would gather them from its verification and
// consent workflow. Not part of the authorize request API.
export function completeAuthorization(
  store: FhirStore,
  grants: IssuanceGrantStore,
  issuerSlug: string,
  params: URLSearchParams,
): AuthorizeOutcome {
  const requestId = params.get("request");
  const pending = requestId ? grants.consumePending(requestId) : null;
  if (!pending || pending.issuerSlug !== issuerSlug) {
    return { kind: "error", status: 400, message: "Unknown or expired authorization request" };
  }
  // Elena is fixed: the consent screen never offers anyone else.
  const person = findConsentPerson(store);
  if (!person) return { kind: "error", status: 500, message: `Demo consent person ${CONSENT_PERSON_SLUG} is not loaded` };
  const sensitivity: SensitivityChoice | undefined = params.get("include_sensitive") ? "release_authorized" : undefined;

  // Site selection: "any" (no data_holder_filter, one blanket ticket) or an
  // explicit subset. Only sites visible under the sensitivity decision count;
  // a sensitive-only site selected without including sensitive categories is
  // silently dropped, never named.
  const selectedSites = resolveSelectedSites(store, person, params, sensitivity);

  const code = grants.createCode({
    issuerSlug: pending.issuerSlug,
    clientId: pending.clientId,
    redirectUri: pending.redirectUri,
    codeChallenge: pending.codeChallenge,
    scopes: pending.scopes,
    personSlug: person.patientSlug,
    sensitivity,
    selectedSites,
  });
  const target = new URL(pending.redirectUri);
  target.searchParams.set("code", code);
  if (pending.state) target.searchParams.set("state", pending.state);
  return { kind: "redirect", location: target.toString() };
}

// Maps the consent form's site-selection inputs to a concrete list of site
// slugs, or undefined for "any site in the network". An explicit selection
// that nets zero valid sites stays an empty array: the person asked for "only
// these sites" and named none we can honor, so zero tickets are minted rather
// than silently widening to a blanket grant. The chosen sites are always
// intersected with the sites visible under the sensitivity decision, so a
// sensitive-only site can never leak in without the sensitive opt-in.
function resolveSelectedSites(
  store: FhirStore,
  person: DemoPersonSummary,
  params: URLSearchParams,
  sensitivity: SensitivityChoice | undefined,
): string[] | undefined {
  if (params.get("site_mode") !== "selected") return undefined;
  const visible = new Set(
    consentSitesForPerson(store, person)
      .filter((site) => sensitivity === "release_authorized" || !site.sensitiveOnly)
      .map((site) => site.siteSlug),
  );
  const chosen = params.getAll("site").filter((slug) => visible.has(slug));
  return [...new Set(chosen)];
}

export function renderConsentScreen(
  origin: string,
  issuerSlug: string,
  person: DemoPersonSummary,
  sites: ConsentSite[],
  requestId: string,
) {
  const personLabel = `${person.displayName}${person.birthDate ? ` (${person.birthDate})` : ""}`;
  const siteRows = sites
    .map((site) => {
      const sensitiveAttr = site.sensitiveOnly ? ' data-sensitive="1" style="display:none"' : "";
      const sensitiveNote = site.sensitiveOnly ? " <em>(sensitive — shown only with sensitive categories)</em>" : "";
      return `<li${sensitiveAttr}><label><input type="checkbox" name="site" value="${escapeHtml(site.siteSlug)}"/> ${escapeHtml(site.orgName)}${sensitiveNote}</label></li>`;
    })
    .join("\n");
  return `<!doctype html><html><head><title>Permission Ticket Issuer</title></head><body>
<h1>Authorize sharing for ${escapeHtml(person.displayName)}</h1>
<p>In a real deployment this step is the issuer's identity verification and
sharing-preference workflow. In this demo it is ${escapeHtml(personLabel)}'s consent screen.</p>
<form method="GET" action="${origin}/issuer/${issuerSlug}/authorize/complete">
  <input type="hidden" name="request" value="${escapeHtml(requestId)}"/>
  <p><label><input type="checkbox" name="include_sensitive" value="1" id="include_sensitive"/> Include sensitive categories (becomes a sensitivity_policy claim on the ticket)</label></p>
  <fieldset>
    <legend>Which sites may receive this authorization?</legend>
    <p><label><input type="radio" name="site_mode" value="any" checked/> Any site in the network</label></p>
    <p><label><input type="radio" name="site_mode" value="selected"/> Only these sites:</label></p>
    <ul id="site-list">${siteRows}</ul>
  </fieldset>
  <p><button type="submit">Authorize</button></p>
</form>
<script>
  // Reveal sensitive-only sites only after sensitive categories are included,
  // so a withheld care relationship is never even named in the list.
  (function () {
    var include = document.getElementById("include_sensitive");
    function sync() {
      var show = include.checked;
      document.querySelectorAll('#site-list li[data-sensitive="1"]').forEach(function (item) {
        item.style.display = show ? "" : "none";
        if (!show) {
          var box = item.querySelector('input[name="site"]');
          if (box) box.checked = false;
        }
      });
    }
    include.addEventListener("change", sync);
    sync();
    // Ticking any site checkbox is an explicit selection: flip the radio.
    var selectedRadio = document.querySelector('input[name="site_mode"][value="selected"]');
    document.getElementById("site-list").addEventListener("change", function (event) {
      if (event.target && event.target.name === "site" && event.target.checked) {
        selectedRadio.checked = true;
      }
    });
  })();
</script>
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
  const issuance = mintTicketsForPerson(input, person, grant.scopes, binding, grant.sensitivity, grant.selectedSites);

  // Proposal 003: an issuer that mints no tickets SHALL NOT grant the
  // permission_ticket scope, and the ticket fields are omitted entirely.
  const grantedScopes = grant.scopes
    .filter((scope) => scope !== "openid" && scope !== "fhirUser")
    .filter((scope) => issuance.tickets.length > 0 || scope !== "permission_ticket");
  const response: Record<string, unknown> = {
    access_token: `issuance-${randomUUID()}`,
    token_type: "Bearer",
    expires_in: ACCESS_TOKEN_TTL_SECONDS,
    scope: grantedScopes.join(" "),
  };
  if (issuance.tickets.length > 0) {
    response.smart_permission_ticket = issuance.tickets;
    response.smart_permission_ticket_endpoints = issuance.endpoints;
  }
  if (grant.scopes.includes("offline_access")) {
    response.refresh_token = input.grants.createRefreshToken({
      issuerSlug: grant.issuerSlug,
      clientId: grant.clientId,
      scopes: grant.scopes,
      personSlug: grant.personSlug,
      sensitivity: grant.sensitivity,
      selectedSites: grant.selectedSites,
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
  input: { origin: string; issuerSlug: string; issuers: TicketIssuerRegistry; store: FhirStore },
  person: DemoPersonSummary,
  scopes: string[],
  binding: PresenterBinding,
  sensitivity?: SensitivityChoice,
  selectedSites?: string[],
): TicketIssuanceResult {
  const permissions = permissionsFromScopes(scopes);
  const issuerUrl = `${input.origin}/issuer/${input.issuerSlug}`;
  const subject = {
    patient: {
      resourceType: "Patient" as const,
      name: [{ family: person.familyName ?? undefined, given: person.givenNames }],
      birthDate: person.birthDate ?? undefined,
    },
  };
  // Identity proofing stand-in: a real signed id_token from the issuer (a CSP
  // would sign this in production) asserting IAL2 verification of Elena, with
  // demographics matching the ticket subject. Embedded so each Data Holder can
  // verify the evidence without a back-channel to the CSP.
  const identityEvidence = buildSubjectIdentityEvidence(input, person, subject.patient);

  const basePayload = (extra: Record<string, unknown>) => ({
    ...(sensitivity
      ? {
          must_understand: ["sensitivity_policy"],
          sensitivity_policy: { unlisted_sensitive_data: sensitivity },
        }
      : {}),
    iss: issuerUrl,
    aud: input.origin,
    exp: nowSeconds() + TICKET_TTL_SECONDS,
    iat: nowSeconds(),
    jti: randomUUID(),
    ticket_type: PATIENT_SELF_ACCESS_TICKET_TYPE,
    presenter_binding: binding,
    subject_identity_evidence: identityEvidence,
    subject,
    ...extra,
  });

  // Endpoint hints disclose where the patient receives care, and a site's
  // name can reveal exactly what a withheld category protects (a women's
  // health clinic in the list says plenty). So the grant's sensitivity
  // decision applies to the hint list itself: unless the person authorized
  // sensitive categories, sites with nothing else visible are not named.
  const hintedSites = sensitivity === "release_authorized"
    ? person.sites
    : person.sites.filter((site) => input.store.countNonSensitiveEncounters(person.patientSlug, site.siteSlug) > 0);

  // "Any site in the network": one blanket ticket with no data_holder_filter;
  // every hinted endpoint points at ticket index 0. An explicit-but-empty
  // selection falls through to the per-site path and mints zero tickets.
  if (!selectedSites) {
    const ticket = input.issuers.sign(input.origin, input.issuerSlug, basePayload({ access: { permissions } }));
    const endpoints = hintedSites.map((site) => ({
      fhir_base_url: siteFhirBaseUrl(input.origin, site.siteSlug),
      organization: siteOrganization(site),
      ticket_indices: [0],
    }));
    return { tickets: [ticket], endpoints };
  }

  // Explicit sites: one site-scoped ticket each, carrying a data_holder_filter
  // with the chosen site's Organization. Each endpoint hint points at its own
  // ticket's index, so the client presents the right ticket at each door.
  const chosen = new Set(selectedSites);
  const chosenSites = hintedSites.filter((site) => chosen.has(site.siteSlug));
  const tickets: string[] = [];
  const endpoints: TicketIssuanceResult["endpoints"] = [];
  for (const site of chosenSites) {
    const organization = siteOrganization(site);
    const ticketIndex = tickets.length;
    tickets.push(
      input.issuers.sign(
        input.origin,
        input.issuerSlug,
        basePayload({
          access: {
            permissions,
            data_holder_filter: [{ kind: "organization" as const, organization }],
          },
        }),
      ),
    );
    endpoints.push({
      fhir_base_url: siteFhirBaseUrl(input.origin, site.siteSlug),
      organization,
      ticket_indices: [ticketIndex],
    });
  }
  return { tickets, endpoints };
}

function siteFhirBaseUrl(origin: string, siteSlug: string) {
  return `${origin}/modes/open/sites/${siteSlug}/fhir`;
}

function siteOrganization(site: DemoSiteSummary) {
  return {
    resourceType: "Organization" as const,
    name: site.orgName,
    ...(site.organizationNpi
      ? { identifier: [{ system: "http://hl7.org/fhir/sid/us-npi", value: site.organizationNpi }] }
      : {}),
  };
}

// A real ES256-signed id_token, signed by the ticket issuer's own key (a
// verisimilitude stand-in for a CSP). Per spec the evidence aud names the
// issuer or presenting client, never the data holder — here, the issuer URL.
function buildSubjectIdentityEvidence(
  input: { origin: string; issuerSlug: string; issuers: TicketIssuerRegistry },
  person: DemoPersonSummary,
  patient: { name: Array<{ family?: string; given: string[] }>; birthDate?: string },
) {
  const issuerUrl = `${input.origin}/issuer/${input.issuerSlug}`;
  const now = nowSeconds();
  const idTokenPayload: Record<string, unknown> = {
    iss: issuerUrl,
    aud: issuerUrl,
    sub: person.personId,
    iat: now,
    exp: now + TICKET_TTL_SECONDS,
    auth_time: now,
    identity_assurance_level: 2,
    ...(patient.name[0]?.given.length ? { given_name: patient.name[0].given.join(" ") } : {}),
    ...(patient.name[0]?.family ? { family_name: patient.name[0].family } : {}),
    ...(patient.birthDate ? { birthdate: patient.birthDate } : {}),
  };
  const jwt = input.issuers.sign(input.origin, input.issuerSlug, idTokenPayload);
  return { source: "embedded" as const, token_type: "id_token" as const, jwt };
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
