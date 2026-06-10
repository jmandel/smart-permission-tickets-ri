import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { generateClientKeyMaterial, signPrivateKeyJwt } from "../shared/private-key-jwt.ts";
import {
  PATIENT_SELF_ACCESS_TICKET_TYPE,
  PERMISSION_TICKET_SUBJECT_TOKEN_TYPE,
} from "../shared/permission-tickets.ts";
import { decodeEs256Jwt } from "../src/auth/es256-jwt.ts";
import { createAppContext, startServer } from "../src/app.ts";

// Proposal 003: ticket issuance via SMART App Launch. The issuer is a SMART
// authorization server whose token response carries Permission Tickets.

let context: ReturnType<typeof createAppContext>;
let server: ReturnType<typeof startServer>;
let origin = "";
let issuerSlug = "";

beforeAll(() => {
  context = createAppContext({ port: 0 });
  server = startServer(context, 0);
  origin = `http://127.0.0.1:${server.port}`;
  context.config.publicBaseUrl = origin;
  context.config.issuer = origin;
  issuerSlug = context.config.defaultPermissionTicketIssuerSlug;
});

afterAll(() => {
  server.stop(true);
});

function pkcePair() {
  const verifier = crypto.randomUUID() + crypto.randomUUID();
  return { verifier, challengePromise: s256(verifier) };
}

async function s256(verifier: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  let binary = "";
  for (const byte of new Uint8Array(digest)) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function registerClient(clientName: string) {
  const keyMaterial = await generateClientKeyMaterial();
  const response = await fetch(`${origin}/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      client_name: clientName,
      token_endpoint_auth_method: "private_key_jwt",
      jwk: keyMaterial.publicJwk,
    }),
  });
  expect(response.status).toBe(201);
  const registration = await response.json();
  return { clientId: registration.client_id as string, keyMaterial };
}

async function runAuthorize(clientId: string, challenge: string, extraParams: Record<string, string> = {}) {
  const params = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: "https://app.example.com/callback",
    scope: "permission_ticket patient/Observation.rs patient/Condition.rs offline_access",
    state: "xyz",
    code_challenge: challenge,
    code_challenge_method: "S256",
    person: "elena-reyes",
    ...extraParams,
  });
  const response = await fetch(`${origin}/issuer/${issuerSlug}/authorize?${params}`, { redirect: "manual" });
  expect(response.status).toBe(302);
  const location = new URL(response.headers.get("location")!);
  expect(location.origin + location.pathname).toBe("https://app.example.com/callback");
  expect(location.searchParams.get("state")).toBe("xyz");
  return location.searchParams.get("code")!;
}

async function redeemCode(code: string, clientId: string, verifier: string) {
  return fetch(`${origin}/issuer/${issuerSlug}/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: "https://app.example.com/callback",
      client_id: clientId,
      code_verifier: verifier,
    }),
  });
}

describe("Proposal 003 issuance", () => {
  test("issuer publishes a SMART configuration with issuance capability", async () => {
    const response = await fetch(`${origin}/issuer/${issuerSlug}/.well-known/smart-configuration`);
    expect(response.status).toBe(200);
    const config = await response.json();
    expect(config.authorization_endpoint).toBe(`${origin}/issuer/${issuerSlug}/authorize`);
    expect(config.token_endpoint).toBe(`${origin}/issuer/${issuerSlug}/token`);
    expect(config.code_challenge_methods_supported).toEqual(["S256"]);
    expect(config.capabilities).toContain("permission-ticket-issuance");
    expect(config.smart_permission_ticket_issuer).toBe(true);
    expect(config.smart_permission_ticket_types_issued).toEqual([PATIENT_SELF_ACCESS_TICKET_TYPE]);
  });

  test("authorize without a person serves the demo approval picker", async () => {
    const params = new URLSearchParams({
      response_type: "code",
      client_id: "well-known:https://app.example.com",
      redirect_uri: "https://app.example.com/callback",
      scope: "permission_ticket",
      code_challenge: await s256("picker-test-verifier"),
      code_challenge_method: "S256",
    });
    const response = await fetch(`${origin}/issuer/${issuerSlug}/authorize?${params}`);
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain("who is authorizing");
    expect(html).toContain("person=elena-reyes");
  });

  test("full launch issues a redeemable, presenter-bound ticket with endpoint hints", async () => {
    const client = await registerClient("Issuance Flow Client");
    const { verifier, challengePromise } = pkcePair();
    const code = await runAuthorize(client.clientId, await challengePromise);

    const tokenResponse = await redeemCode(code, client.clientId, verifier);
    expect(tokenResponse.status).toBe(200);
    const body = await tokenResponse.json();
    expect(body.token_type).toBe("Bearer");
    expect(typeof body.refresh_token).toBe("string");
    expect(Array.isArray(body.smart_permission_ticket)).toBe(true);
    expect(body.smart_permission_ticket).toHaveLength(1);

    const decoded = decodeEs256Jwt<any>(body.smart_permission_ticket[0]);
    expect(decoded.payload.ticket_type).toBe(PATIENT_SELF_ACCESS_TICKET_TYPE);
    expect(typeof decoded.payload.iat).toBe("number");
    expect(decoded.payload.presenter_binding).toEqual({ method: "jkt", jkt: client.keyMaterial.thumbprint });
    expect(decoded.payload.subject.patient.name[0].family).toBe("Reyes");
    expect(decoded.payload.access.permissions.map((permission: any) => permission.resource_type).sort()).toEqual([
      "Condition",
      "Observation",
    ]);

    const hints = body.smart_permission_ticket_endpoints;
    expect(Array.isArray(hints)).toBe(true);
    expect(hints.length).toBeGreaterThan(0);
    expect(hints[0].fhir_base_url).toContain("/sites/");
    expect(hints[0].organization.resourceType).toBe("Organization");
    expect(hints[0].ticket_indices).toEqual([0]);

    // Redeem the minted ticket at a Data Holder surface via token exchange,
    // authenticating as the bound client.
    const tokenEndpoint = `${origin}/token`;
    const assertion = await signPrivateKeyJwt(
      {
        iss: client.clientId,
        sub: client.clientId,
        aud: tokenEndpoint,
        iat: Math.floor(Date.now() / 1000),
        exp: Math.floor(Date.now() / 1000) + 300,
        jti: crypto.randomUUID(),
      },
      client.keyMaterial.privateJwk,
    );
    const exchangeResponse = await fetch(tokenEndpoint, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
        subject_token_type: PERMISSION_TICKET_SUBJECT_TOKEN_TYPE,
        subject_token: body.smart_permission_ticket[0],
        client_assertion_type: "urn:ietf:params:oauth:client-assertion-type:jwt-bearer",
        client_assertion: assertion,
      }),
    });
    expect(exchangeResponse.status).toBe(200);
    const exchangeBody = await exchangeResponse.json();
    expect(typeof exchangeBody.access_token).toBe("string");
    expect(exchangeBody.scope).toContain("patient/Observation.rs");
  });

  test("well-known client identifiers get trust-framework presenter binding", async () => {
    const clientId = "well-known:https://app.example.com";
    const { verifier, challengePromise } = pkcePair();
    const code = await runAuthorize(clientId, await challengePromise);
    const tokenResponse = await redeemCode(code, clientId, verifier);
    expect(tokenResponse.status).toBe(200);
    const body = await tokenResponse.json();
    const decoded = decodeEs256Jwt<any>(body.smart_permission_ticket[0]);
    expect(decoded.payload.presenter_binding.method).toBe("trust_framework_client");
    expect(decoded.payload.presenter_binding.entity_uri).toBe("https://app.example.com");
  });

  test("PKCE mismatch and code replay are rejected", async () => {
    const client = await registerClient("PKCE Client");
    const { verifier, challengePromise } = pkcePair();
    const code = await runAuthorize(client.clientId, await challengePromise);

    const wrongVerifier = await redeemCode(code, client.clientId, "not-the-verifier");
    expect(wrongVerifier.status).toBe(400);
    expect((await wrongVerifier.json()).error).toBe("invalid_grant");

    // The failed attempt consumed the code; replay with the right verifier fails too.
    const replay = await redeemCode(code, client.clientId, verifier);
    expect(replay.status).toBe(400);
  });

  test("unbindable clients are refused: individual-access tickets must be presenter-bound", async () => {
    const { verifier, challengePromise } = pkcePair();
    const code = await runAuthorize("mystery-client-with-no-key", await challengePromise);
    const tokenResponse = await redeemCode(code, "mystery-client-with-no-key", verifier);
    expect(tokenResponse.status).toBe(400);
    const body = await tokenResponse.json();
    expect(body.error).toBe("invalid_client");
    expect(body.error_description).toContain("presenter-bound");
  });

  test("refresh token rotates and returns fresh tickets", async () => {
    const client = await registerClient("Refresh Client");
    const { verifier, challengePromise } = pkcePair();
    const code = await runAuthorize(client.clientId, await challengePromise);
    const first = await (await redeemCode(code, client.clientId, verifier)).json();
    expect(typeof first.refresh_token).toBe("string");

    const refreshResponse = await fetch(`${origin}/issuer/${issuerSlug}/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: first.refresh_token }),
    });
    expect(refreshResponse.status).toBe(200);
    const second = await refreshResponse.json();
    expect(second.smart_permission_ticket).toHaveLength(1);
    expect(second.smart_permission_ticket[0]).not.toBe(first.smart_permission_ticket[0]);
    expect(second.refresh_token).not.toBe(first.refresh_token);

    // Rotation: the old refresh token is dead.
    const reuse = await fetch(`${origin}/issuer/${issuerSlug}/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: first.refresh_token }),
    });
    expect(reuse.status).toBe(400);
  });
});

describe("guided launch page", () => {
  test("/launch serves the app shell and /launch/callback relays the code", async () => {
    const page = await fetch(`${origin}/launch`);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain("<div id=\"root\">");

    const callback = await fetch(`${origin}/launch/callback?code=abc&state=xyz`);
    expect(callback.status).toBe(200);
    const html = await callback.text();
    expect(html).toContain("smart-permission-tickets-issuance-callback");
    expect(html).toContain("postMessage");
  });

  test("launch-flow logic drives the full story end to end", async () => {
    const flow = await import("../ui/src/lib/launch-flow.ts");

    const discovery = await flow.discoverIssuer(origin, issuerSlug);
    expect((discovery.response as any).smart_permission_ticket_issuer).toBe(true);

    const keys = await flow.generateAppIdentity();
    const registration = await flow.registerApp(origin, keys);
    expect(registration.clientId).toBeTruthy();

    const pkce = await flow.generatePkce();
    const authorizeUrl = flow.buildAuthorizeUrl({
      origin,
      issuerSlug,
      clientId: registration.clientId,
      challenge: pkce.challenge,
      state: "guided-state",
    });
    // The page opens this URL in a popup and the person picker appears;
    // here we pick Elena by parameter, as the picker links do.
    const authorizeResponse = await fetch(`${authorizeUrl}&person=elena-reyes`, { redirect: "manual" });
    expect(authorizeResponse.status).toBe(302);
    const location = new URL(authorizeResponse.headers.get("location")!);
    expect(location.pathname).toBe("/launch/callback");
    expect(location.searchParams.get("state")).toBe("guided-state");
    const code = location.searchParams.get("code")!;

    const tokens = await flow.redeemAuthorizationCode({
      origin,
      issuerSlug,
      code,
      clientId: registration.clientId,
      verifier: pkce.verifier,
    });
    expect(tokens.tickets).toHaveLength(1);
    expect(tokens.endpoints.length).toBeGreaterThan(0);
    const payload = flow.decodeJwtPayload(tokens.tickets[0]);
    expect(payload.ticket_type).toBe(PATIENT_SELF_ACCESS_TICKET_TYPE);

    const firstHint = tokens.endpoints[0];
    expect(flow.tokenEndpointForHint(firstHint)).toBe(firstHint.fhir_base_url.replace(/\/fhir$/, "/token"));
    const exchange = await flow.redeemTicketAtSite({
      hint: firstHint,
      ticket: tokens.tickets[0],
      keys,
    });
    expect(exchange.grantedScope).toContain("patient/");

    const sample = await flow.sampleSiteData(firstHint, exchange.accessToken, keys.thumbprint);
    expect(sample.encounters + sample.observations).toBeGreaterThan(0);
  });
});
