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

// Runs the authorize request (spec params only), then completes the issuer's
// approval ceremony the way Elena's consent form does: the sensitivity and
// site-selection choices travel through the issuer-internal completion
// endpoint, never as authorize request parameters.
async function runAuthorize(
  clientId: string,
  challenge: string,
  options: { includeSensitive?: boolean; selectedSites?: string[]; scope?: string } = {},
) {
  const params = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: "https://app.example.com/callback",
    scope: options.scope ?? "permission_ticket patient/Observation.rs patient/Condition.rs offline_access",
    state: "xyz",
    code_challenge: challenge,
    code_challenge_method: "S256",
  });
  const consentResponse = await fetch(`${origin}/issuer/${issuerSlug}/authorize?${params}`);
  expect(consentResponse.status).toBe(200);
  const consentHtml = await consentResponse.text();
  const requestId = consentHtml.match(/name="request" value="([^"]+)"/)?.[1];
  expect(requestId).toBeTruthy();

  const completeParams = new URLSearchParams({
    request: requestId!,
    ...(options.includeSensitive ? { include_sensitive: "1" } : {}),
    ...(options.selectedSites ? { site_mode: "selected" } : {}),
  });
  for (const siteSlug of options.selectedSites ?? []) completeParams.append("site", siteSlug);
  const response = await fetch(`${origin}/issuer/${issuerSlug}/authorize/complete?${completeParams}`, { redirect: "manual" });
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

  test("authorize serves Elena's consent screen; ceremony choices are not authorize parameters", async () => {
    const params = new URLSearchParams({
      response_type: "code",
      client_id: "well-known:https://app.example.com",
      redirect_uri: "https://app.example.com/callback",
      scope: "permission_ticket",
      code_challenge: await s256("consent-test-verifier"),
      code_challenge_method: "S256",
    });
    const response = await fetch(`${origin}/issuer/${issuerSlug}/authorize?${params}`);
    expect(response.status).toBe(200);
    const html = await response.text();
    // Hardcoded to Elena: her name is fixed, no multi-person picker.
    expect(html).toContain("Authorize sharing for Elena");
    expect(html).not.toContain('name="person"');
    expect(html).toContain("include_sensitive");
    // Site selection controls.
    expect(html).toContain('name="site_mode"');
    expect(html).toContain("Any site in the network");
    expect(html).toContain('name="site"');
    expect(html).toContain("authorize/complete");
    // The sensitive-only site is rendered hidden until the sensitive opt-in.
    expect(html).toContain(
      '<li data-sensitive="1" style="display:none"><label><input type="checkbox" name="site" value="lone-star-womens-health"/>',
    );

    // The completion endpoint rejects unknown or replayed requests.
    const bogus = await fetch(`${origin}/issuer/${issuerSlug}/authorize/complete?request=nope`);
    expect(bogus.status).toBe(400);
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
    // The page opens this URL in a popup and Elena's consent screen appears;
    // here we submit the consent form the way she would: sensitive categories
    // included, any site in the network.
    const consentResponse = await fetch(authorizeUrl);
    expect(consentResponse.status).toBe(200);
    const requestId = (await consentResponse.text()).match(/name="request" value="([^"]+)"/)?.[1]!;
    const authorizeResponse = await fetch(
      `${origin}/issuer/${issuerSlug}/authorize/complete?request=${requestId}&include_sensitive=1`,
      { redirect: "manual" },
    );
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
    const discovered = await flow.discoverDataHolder(firstHint);
    expect(discovered.tokenEndpoint).toContain("/token");
    expect(discovered.registrationEndpoint).toContain("/register");
    // The hint says which minted ticket to present here via ticket_indices.
    const exchange = await flow.redeemTicketAtSite({
      hint: firstHint,
      ticket: tokens.tickets[firstHint.ticket_indices[0]!]!,
      keys,
    });
    expect(exchange.grantedScope).toContain("patient/");

    const sample = await flow.sampleSiteData(firstHint, exchange.accessToken);
    expect(sample.encounters + sample.observations).toBeGreaterThan(0);
  });
});

describe("disclosure-aware endpoint hints", () => {
  test("a grant without sensitive categories does not name sites whose relationship would reveal them", async () => {
    const run = async (includeSensitive: boolean) => {
      const client = await registerClient(`Hints Client ${includeSensitive}`);
      const { verifier, challengePromise } = pkcePair();
      const code = await runAuthorize(client.clientId, await challengePromise, { includeSensitive });
      const body = await (await redeemCode(code, client.clientId, verifier)).json();
      return (body.smart_permission_ticket_endpoints as Array<{ fhir_base_url: string }>).map((hint) => hint.fhir_base_url);
    };

    const withoutSensitive = await run(false);
    const withSensitive = await run(true);

    // Elena's women's health site only has sensitivity-labeled encounters:
    // hinting it under a non-sensitive grant would disclose the relationship.
    expect(withSensitive.some((url) => url.includes("lone-star-womens-health"))).toBe(true);
    expect(withoutSensitive.some((url) => url.includes("lone-star-womens-health"))).toBe(false);
    expect(withoutSensitive.length).toBeLessThan(withSensitive.length);
    expect(withoutSensitive.length).toBeGreaterThan(0);
  });
});

describe("per-site ticket selection", () => {
  const SELECTED = ["central-austin-family-medicine", "eastbay-primary-care-associates"];

  test("choosing specific sites mints one site-scoped ticket per site", async () => {
    const client = await registerClient("Per-Site Client");
    const { verifier, challengePromise } = pkcePair();
    const code = await runAuthorize(client.clientId, await challengePromise, {
      selectedSites: SELECTED,
      scope: "permission_ticket patient/*.rs offline_access",
    });
    const body = await (await redeemCode(code, client.clientId, verifier)).json();

    expect(body.smart_permission_ticket).toHaveLength(2);
    const hints = body.smart_permission_ticket_endpoints as Array<{
      fhir_base_url: string;
      organization: { name: string };
      ticket_indices: number[];
    }>;
    expect(hints).toHaveLength(2);
    const hintedSlugs = hints.map((hint) => hint.fhir_base_url.match(/\/sites\/([^/]+)\//)![1]).sort();
    expect(hintedSlugs).toEqual([...SELECTED].sort());

    // Each endpoint hint points at ITS ticket, and each ticket carries a
    // data_holder_filter naming exactly that site's organization.
    for (const [index, hint] of hints.entries()) {
      expect(hint.ticket_indices).toEqual([index]);
      const decoded = decodeEs256Jwt<any>(body.smart_permission_ticket[index]);
      const filter = decoded.payload.access.data_holder_filter;
      expect(filter).toHaveLength(1);
      expect(filter[0].kind).toBe("organization");
      expect(filter[0].organization.resourceType).toBe("Organization");
      expect(filter[0].organization.name).toBe(hint.organization.name);
    }

    // Each ticket redeems at its own site; presenting it at the other chosen
    // site fails, because the data_holder_filter does not cover it.
    const flow = await import("../ui/src/lib/launch-flow.ts");
    for (const hint of hints) {
      const exchange = await flow.redeemTicketAtSite({
        hint,
        ticket: body.smart_permission_ticket[hint.ticket_indices[0]!]!,
        keys: client.keyMaterial,
      });
      expect(exchange.grantedScope).toContain("patient/");
    }
    await expect(
      flow.redeemTicketAtSite({
        hint: hints[1]!,
        ticket: body.smart_permission_ticket[hints[0]!.ticket_indices[0]!]!,
        keys: client.keyMaterial,
      }),
    ).rejects.toThrow();
  });

  test("site selection survives refresh-token redemption", async () => {
    const client = await registerClient("Per-Site Refresh Client");
    const { verifier, challengePromise } = pkcePair();
    const code = await runAuthorize(client.clientId, await challengePromise, { selectedSites: SELECTED });
    const first = await (await redeemCode(code, client.clientId, verifier)).json();
    expect(first.smart_permission_ticket).toHaveLength(2);

    const refreshResponse = await fetch(`${origin}/issuer/${issuerSlug}/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: first.refresh_token }),
    });
    expect(refreshResponse.status).toBe(200);
    const second = await refreshResponse.json();

    // Re-minted tickets preserve Elena's site choice: same per-site shape.
    expect(second.smart_permission_ticket).toHaveLength(2);
    const firstUrls = first.smart_permission_ticket_endpoints.map((hint: { fhir_base_url: string }) => hint.fhir_base_url);
    const secondUrls = second.smart_permission_ticket_endpoints.map((hint: { fhir_base_url: string }) => hint.fhir_base_url);
    expect(secondUrls).toEqual(firstUrls);
    for (const [index, signedTicket] of (second.smart_permission_ticket as string[]).entries()) {
      const decoded = decodeEs256Jwt<any>(signedTicket);
      expect(decoded.payload.access.data_holder_filter[0].organization.name)
        .toBe(second.smart_permission_ticket_endpoints[index].organization.name);
    }
  });

  test("a sensitive-only site cannot be selected without including sensitive categories", async () => {
    const client = await registerClient("Sensitive Guard Client");
    const { verifier, challengePromise } = pkcePair();
    const code = await runAuthorize(client.clientId, await challengePromise, {
      selectedSites: ["lone-star-womens-health"],
    });
    const body = await (await redeemCode(code, client.clientId, verifier)).json();

    // The selection is silently dropped: one blanket ticket, and the
    // sensitive-only site is never named in the hints.
    expect(body.smart_permission_ticket).toHaveLength(1);
    const decoded = decodeEs256Jwt<any>(body.smart_permission_ticket[0]);
    expect(decoded.payload.access.data_holder_filter).toBeUndefined();
    const urls = body.smart_permission_ticket_endpoints.map((hint: { fhir_base_url: string }) => hint.fhir_base_url);
    expect(urls.some((url: string) => url.includes("lone-star-womens-health"))).toBe(false);

    // With the sensitive opt-in the same selection works and is site-scoped.
    const optIn = await registerClient("Sensitive Opt-In Client");
    const pkce = pkcePair();
    const optInCode = await runAuthorize(optIn.clientId, await pkce.challengePromise, {
      includeSensitive: true,
      selectedSites: ["lone-star-womens-health"],
    });
    const optInBody = await (await redeemCode(optInCode, optIn.clientId, pkce.verifier)).json();
    expect(optInBody.smart_permission_ticket).toHaveLength(1);
    const optInTicket = decodeEs256Jwt<any>(optInBody.smart_permission_ticket[0]);
    expect(optInTicket.payload.access.data_holder_filter).toHaveLength(1);
    expect(optInBody.smart_permission_ticket_endpoints).toHaveLength(1);
    expect(optInBody.smart_permission_ticket_endpoints[0].fhir_base_url).toContain("lone-star-womens-health");
  });

  test("the protocol trace shows the mint count and which ticket index each site redeems", async () => {
    const sessionId = `per-site-trace-${crypto.randomUUID()}`;
    const client = await registerClient("Per-Site Trace Client");
    const { verifier, challengePromise } = pkcePair();
    const code = await runAuthorize(client.clientId, await challengePromise, {
      selectedSites: SELECTED,
      scope: "permission_ticket patient/*.rs offline_access",
    });

    const tokenResponse = await fetch(`${origin}/issuer/${issuerSlug}/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", "x-demo-session": sessionId },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: "https://app.example.com/callback",
        client_id: client.clientId,
        code_verifier: verifier,
      }),
    });
    expect(tokenResponse.status).toBe(200);
    const body = await tokenResponse.json();

    // One ticket-created event per minted ticket, each naming its position.
    const created = context.demoEvents.getEvents(sessionId).filter((event) => event.type === "ticket-created");
    expect(created).toHaveLength(2);
    expect(created.map((event) => (event.detail as { ticketIndex?: number }).ticketIndex)).toEqual([0, 1]);
    expect(created.map((event) => (event.detail as { ticketCount?: number }).ticketCount)).toEqual([2, 2]);
    expect(created[1]!.label).toContain("index 1 of 2");

    // Redeeming at the second site (session inferred from the ticket) traces
    // which ticket index the client presented there.
    const flow = await import("../ui/src/lib/launch-flow.ts");
    const hint = body.smart_permission_ticket_endpoints[1];
    await flow.redeemTicketAtSite({
      hint,
      ticket: body.smart_permission_ticket[hint.ticket_indices[0]],
      keys: client.keyMaterial,
    });
    const exchanges = context.demoEvents
      .getEvents(sessionId)
      .filter((event) => event.type === "token-exchange" && event.detail.outcome === "issued");
    expect(exchanges.length).toBeGreaterThan(0);
    const steps = (exchanges.at(-1)!.detail as { steps: Array<{ check: string; passed: boolean; evidence?: string }> }).steps;
    const selection = steps.find((step) => step.check === "Ticket Selection");
    expect(selection?.passed).toBe(true);
    expect(selection?.evidence).toContain("ticket index 1 of 2");
  });
});

describe("embedded identity evidence", () => {
  test("issued tickets carry an issuer-signed IAL2 id_token matching the subject", async () => {
    const client = await registerClient("Evidence Client");
    const { verifier, challengePromise } = pkcePair();
    const code = await runAuthorize(client.clientId, await challengePromise);
    const body = await (await redeemCode(code, client.clientId, verifier)).json();

    const decoded = decodeEs256Jwt<any>(body.smart_permission_ticket[0]);
    const evidence = decoded.payload.subject_identity_evidence;
    expect(evidence.source).toBe("embedded");
    expect(evidence.token_type).toBe("id_token");

    const idToken = decodeEs256Jwt<any>(evidence.jwt);
    const issuerUrl = `${origin}/issuer/${issuerSlug}`;
    expect(idToken.header.alg).toBe("ES256");
    // aud names the issuer (the CSP stand-in), never the data holder.
    expect(idToken.payload.iss).toBe(issuerUrl);
    expect(idToken.payload.aud).toBe(issuerUrl);
    expect(typeof idToken.payload.sub).toBe("string");
    expect(idToken.payload.sub.length).toBeGreaterThan(0);
    expect(typeof idToken.payload.iat).toBe("number");
    expect(typeof idToken.payload.exp).toBe("number");
    expect(typeof idToken.payload.auth_time).toBe("number");
    expect(idToken.payload.identity_assurance_level).toBe(2);
    expect(idToken.payload.family_name).toBe("Reyes");
    expect(idToken.payload.given_name).toContain("Elena");
    expect(idToken.payload.birthdate).toBe(decoded.payload.subject.patient.birthDate);
  });

  test("redemption verifies the evidence and traces it; tampered evidence is rejected", async () => {
    const sessionId = `evidence-trace-${crypto.randomUUID()}`;
    const client = await registerClient("Evidence Trace Client");
    const { verifier, challengePromise } = pkcePair();
    const code = await runAuthorize(client.clientId, await challengePromise);
    const tokenResponse = await fetch(`${origin}/issuer/${issuerSlug}/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", "x-demo-session": sessionId },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: "https://app.example.com/callback",
        client_id: client.clientId,
        code_verifier: verifier,
      }),
    });
    const body = await tokenResponse.json();
    const signedTicket = body.smart_permission_ticket[0] as string;
    const evidenceJwt = decodeEs256Jwt<any>(signedTicket).payload.subject_identity_evidence.jwt as string;

    const exchangeAt = async (subjectToken: string) => {
      const now = Math.floor(Date.now() / 1000);
      const assertion = await signPrivateKeyJwt(
        { iss: client.clientId, sub: client.clientId, aud: `${origin}/token`, iat: now, exp: now + 300, jti: crypto.randomUUID() },
        client.keyMaterial.privateJwk,
      );
      return fetch(`${origin}/token`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
          subject_token_type: PERMISSION_TICKET_SUBJECT_TOKEN_TYPE,
          subject_token: subjectToken,
          client_assertion_type: "urn:ietf:params:oauth:client-assertion-type:jwt-bearer",
          client_assertion: assertion,
        }),
      });
    };

    const exchange = await exchangeAt(signedTicket);
    expect(exchange.status).toBe(200);
    const exchanges = context.demoEvents
      .getEvents(sessionId)
      .filter((event) => event.type === "token-exchange" && event.detail.outcome === "issued");
    const steps = (exchanges.at(-1)!.detail as { steps: Array<{ check: string; passed: boolean; evidence?: string }> }).steps;
    const evidenceStep = steps.find((step) => step.check === "Identity evidence");
    expect(evidenceStep?.passed).toBe(true);
    expect(evidenceStep?.evidence).toContain("IAL2 id_token verified");
    expect(evidenceStep?.evidence).toContain(`${origin}/issuer/${issuerSlug}`);

    // Tampered evidence: re-sign a workbench ticket carrying the evidence jwt
    // with its payload swapped out, so the evidence signature no longer
    // verifies. The ticket itself is validly signed; redemption must reject it.
    const [evidenceHeader, , evidenceSignature] = evidenceJwt.split(".");
    const forgedClaims = btoa(JSON.stringify({ iss: `${origin}/issuer/${issuerSlug}`, sub: "someone-else" }))
      .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    const baseTicket = {
      iss: `${origin}/issuer/${issuerSlug}`,
      aud: origin,
      exp: Math.floor(Date.now() / 1000) + 3600,
      jti: crypto.randomUUID(),
      ticket_type: PATIENT_SELF_ACCESS_TICKET_TYPE,
      presenter_binding: { method: "jkt", jkt: client.keyMaterial.thumbprint },
      subject: { patient: { resourceType: "Patient", name: [{ family: "Reyes", given: ["Elena"] }], birthDate: "1989-09-14" } },
      access: { permissions: [{ kind: "data", resource_type: "Observation", interactions: ["read", "search"] }] },
    };
    const signTicket = async (payload: Record<string, unknown>) => {
      const response = await fetch(`${origin}/issuer/${issuerSlug}/sign-ticket`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      expect(response.status).toBe(201);
      return (await response.json()).signed_ticket as string;
    };

    const tamperedTicket = await signTicket({
      ...baseTicket,
      subject_identity_evidence: {
        source: "embedded",
        token_type: "id_token",
        jwt: `${evidenceHeader}.${forgedClaims}.${evidenceSignature}`,
      },
    });
    const rejected = await exchangeAt(tamperedTicket);
    expect(rejected.status).toBe(400);
    const rejection = await rejected.json();
    expect(rejection.error).toBe("invalid_grant");
    expect(rejection.error_description).toContain("subject_identity_evidence");

    // Absence stays valid: the same workbench ticket without evidence redeems.
    const evidenceFreeTicket = await signTicket(baseTicket);
    const accepted = await exchangeAt(evidenceFreeTicket);
    expect(accepted.status).toBe(200);
  });
});

describe("guided launch protocol trace", () => {
  test("issuance with a demo session header populates the trace, and exchanges inherit it", async () => {
    const sessionId = `guided-${crypto.randomUUID()}`;
    const client = await registerClient("Trace Client");
    const { verifier, challengePromise } = pkcePair();
    const code = await runAuthorize(client.clientId, await challengePromise, { includeSensitive: true });

    const tokenResponse = await fetch(`${origin}/issuer/${issuerSlug}/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", "x-demo-session": sessionId },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: "https://app.example.com/callback",
        client_id: client.clientId,
        code_verifier: verifier,
      }),
    });
    expect(tokenResponse.status).toBe(200);
    const body = await tokenResponse.json();

    // The ticket-created event lands in the session timeline.
    const sessionInfo = async () => {
      const body = await (await fetch(`${origin}/demo/sessions`)).json() as { sessions: Array<{ sessionId: string; eventCount: number }> };
      return body.sessions.find((session) => session.sessionId === sessionId) ?? null;
    };
    const afterIssuance = await sessionInfo();
    expect(afterIssuance).not.toBeNull();
    expect(afterIssuance!.eventCount).toBeGreaterThan(0);

    // A token exchange with NO header still lands in the same session,
    // inferred from the ticket binding.
    const { signPrivateKeyJwt: sign } = await import("../shared/private-key-jwt.ts");
    const now = Math.floor(Date.now() / 1000);
    const assertion = await sign(
      { iss: client.clientId, sub: client.clientId, aud: `${origin}/token`, iat: now, exp: now + 300, jti: crypto.randomUUID() },
      client.keyMaterial.privateJwk,
    );
    const exchange = await fetch(`${origin}/token`, {
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
    expect(exchange.status).toBe(200);
    const afterExchange = await sessionInfo();
    expect(afterExchange!.eventCount).toBeGreaterThan(afterIssuance!.eventCount);
  });
});
