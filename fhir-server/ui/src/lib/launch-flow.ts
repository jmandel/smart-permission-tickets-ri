// Logic for the guided app-driven launch (/launch): a scripted walk through
// Proposal 003 issuance and ticket redemption, where every step performs the
// real protocol call against this server. Pre-baked for the demo: one app
// persona with a fresh P-256 keypair per visit, fixed scopes, and the demo
// person picker standing in for the issuer's verification workflow.

import {
  generateClientKeyMaterial,
  signPrivateKeyJwt,
  type ClientKeyMaterial,
} from "../../../shared/private-key-jwt.ts";

export const LAUNCH_APP_NAME = "Pocket Health (demo app)";
export const LAUNCH_SCOPE = "permission_ticket patient/*.rs offline_access";
export const CALLBACK_PATH = "/launch/callback";
export const CALLBACK_MESSAGE_TYPE = "smart-permission-tickets-issuance-callback";

export type RecordedCall = {
  label: string;
  request: { method: string; url: string; body?: string };
  status: number;
  response: unknown;
};

export type EndpointHint = {
  fhir_base_url: string;
  organization: { resourceType: "Organization"; name: string; identifier?: Array<{ system: string; value: string }> };
  ticket_indices: number[];
};

export async function generateAppIdentity(): Promise<ClientKeyMaterial> {
  return generateClientKeyMaterial();
}

export async function generatePkce() {
  const verifier = base64UrlEncode(crypto.getRandomValues(new Uint8Array(32)));
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return { verifier, challenge: base64UrlEncode(new Uint8Array(digest)) };
}

export async function discoverIssuer(origin: string, issuerSlug: string): Promise<RecordedCall> {
  const url = `${origin}/issuer/${issuerSlug}/.well-known/smart-configuration`;
  const response = await fetch(url);
  return { label: "Issuer discovery", request: { method: "GET", url }, status: response.status, response: await response.json() };
}

export async function registerApp(origin: string, keys: ClientKeyMaterial): Promise<RecordedCall & { clientId: string }> {
  const url = `${origin}/register`;
  const body = JSON.stringify({
    client_name: LAUNCH_APP_NAME,
    token_endpoint_auth_method: "private_key_jwt",
    jwk: keys.publicJwk,
  }, null, 2);
  const response = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body });
  const json = await response.json();
  if (response.status !== 201) throw new Error(json.error_description ?? "Dynamic registration failed");
  return {
    label: "Dynamic client registration",
    request: { method: "POST", url, body },
    status: response.status,
    response: json,
    clientId: json.client_id as string,
  };
}

export function buildAuthorizeUrl(input: {
  origin: string;
  issuerSlug: string;
  clientId: string;
  challenge: string;
  state: string;
}) {
  const params = new URLSearchParams({
    response_type: "code",
    client_id: input.clientId,
    redirect_uri: `${input.origin}${CALLBACK_PATH}`,
    scope: LAUNCH_SCOPE,
    state: input.state,
    code_challenge: input.challenge,
    code_challenge_method: "S256",
  });
  return `${input.origin}/issuer/${input.issuerSlug}/authorize?${params.toString()}`;
}

export async function redeemAuthorizationCode(input: {
  origin: string;
  issuerSlug: string;
  code: string;
  clientId: string;
  verifier: string;
}): Promise<RecordedCall & { tickets: string[]; endpoints: EndpointHint[]; refreshToken?: string }> {
  const url = `${input.origin}/issuer/${input.issuerSlug}/token`;
  const form = new URLSearchParams({
    grant_type: "authorization_code",
    code: input.code,
    redirect_uri: `${input.origin}${CALLBACK_PATH}`,
    client_id: input.clientId,
    code_verifier: input.verifier,
  });
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: form,
  });
  const json = await response.json();
  if (response.status !== 200) throw new Error(json.error_description ?? "Code redemption failed");
  return {
    label: "Issuer token endpoint",
    request: { method: "POST", url, body: form.toString() },
    status: response.status,
    response: json,
    tickets: json.smart_permission_ticket ?? [],
    endpoints: json.smart_permission_ticket_endpoints ?? [],
    refreshToken: json.refresh_token,
  };
}

// Per Proposal 003, endpoint hints carry a fhir_base_url; the client
// discovers each Data Holder's endpoints from
// ${fhir_base_url}/.well-known/smart-configuration rather than assuming
// any URL layout.
export async function discoverDataHolder(hint: EndpointHint) {
  const response = await fetch(`${hint.fhir_base_url}/.well-known/smart-configuration`);
  if (response.status !== 200) throw new Error(`Discovery failed at ${hint.organization.name}`);
  const config = await response.json();
  if (typeof config.token_endpoint !== "string") throw new Error(`No token endpoint advertised by ${hint.organization.name}`);
  return {
    tokenEndpoint: config.token_endpoint as string,
    registrationEndpoint: typeof config.registration_endpoint === "string" ? config.registration_endpoint as string : null,
  };
}

export async function redeemTicketAtSite(input: {
  hint: EndpointHint;
  ticket: string;
  keys: ClientKeyMaterial;
}): Promise<RecordedCall & { accessToken: string; grantedScope: string }> {
  const endpoints = await discoverDataHolder(input.hint);
  if (!endpoints.registrationEndpoint) throw new Error(`No registration endpoint advertised by ${input.hint.organization.name}`);
  // Registration is local to each Data Holder: the app introduces the same
  // key at each site and gets a site-scoped client_id. The ticket is the
  // portable part; the jkt presenter binding follows the key, not the id.
  const registerResponse = await fetch(endpoints.registrationEndpoint, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      client_name: LAUNCH_APP_NAME,
      token_endpoint_auth_method: "private_key_jwt",
      jwk: input.keys.publicJwk,
    }),
  });
  const registration = await registerResponse.json();
  if (registerResponse.status !== 201) {
    throw new Error(registration.error_description ?? `Registration failed at ${input.hint.organization.name}`);
  }
  const siteClientId = registration.client_id as string;

  const tokenEndpoint = endpoints.tokenEndpoint;
  const now = Math.floor(Date.now() / 1000);
  const assertion = await signPrivateKeyJwt(
    {
      iss: siteClientId,
      sub: siteClientId,
      aud: tokenEndpoint,
      iat: now,
      exp: now + 300,
      jti: crypto.randomUUID(),
    },
    input.keys.privateJwk,
  );
  const form = new URLSearchParams({
    grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
    subject_token_type: "https://smarthealthit.org/token-type/permission-ticket",
    subject_token: input.ticket,
    client_assertion_type: "urn:ietf:params:oauth:client-assertion-type:jwt-bearer",
    client_assertion: assertion,
  });
  const response = await fetch(tokenEndpoint, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: form,
  });
  const json = await response.json();
  if (response.status !== 200) throw new Error(json.error_description ?? `Token exchange failed at ${input.hint.organization.name}`);
  return {
    label: `Token exchange: ${input.hint.organization.name}`,
    request: { method: "POST", url: tokenEndpoint, body: form.toString() },
    status: response.status,
    response: json,
    accessToken: json.access_token as string,
    grantedScope: json.scope as string,
  };
}

export type SiteSample = {
  encounters: number;
  observations: number;
};

export async function sampleSiteData(hint: EndpointHint, accessToken: string): Promise<SiteSample> {
  const count = async (resourceType: string) => {
    const response = await fetch(`${hint.fhir_base_url}/${resourceType}?_summary=count`, {
      headers: { authorization: `Bearer ${accessToken}` },
    });
    if (response.status !== 200) return 0;
    const bundle = await response.json();
    return typeof bundle.total === "number" ? bundle.total : 0;
  };
  return {
    encounters: await count("Encounter"),
    observations: await count("Observation"),
  };
}

export function decodeJwtPayload(jwt: string): Record<string, unknown> {
  const segments = jwt.split(".");
  if (segments.length !== 3) throw new Error("Malformed JWT");
  return JSON.parse(new TextDecoder().decode(base64UrlDecode(segments[1])));
}

function base64UrlEncode(bytes: Uint8Array) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64UrlDecode(value: string): Uint8Array {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}
