import { decodeEs256Jwt } from "./auth/es256-jwt.ts";
import { generateClientKeyMaterial, signPrivateKeyJwt } from "../shared/private-key-jwt.ts";
import { NETWORK_PATIENT_ACCESS_TICKET_TYPE } from "../shared/permission-tickets.ts";
import { createAppContext, startServer } from "./app.ts";

const context = createAppContext({ port: 0 });
const server = startServer(context, 0);
const origin = `http://127.0.0.1:${server.port}`;
context.config.issuer = origin;
const clientBootstrap = await generateClientKeyMaterial();

try {
  await expectHtml(`${origin}/`, (body) => {
    assert(body.includes("SMART Permission Tickets"), "landing page title missing");
    assert(body.includes("root"), "landing page should have React mount point");
  });
  await expectHtml(`${origin}/viewer`, (body) => {
    assert(body.includes("root"), "viewer route should serve the React app shell");
  });

  await expectJson(`${origin}/demo/bootstrap`, (body) => {
    assert(Array.isArray(body.persons) && body.persons.length > 0, "demo bootstrap should expose persons");
    assert(Array.isArray(body.searchableResourceTypes), "demo bootstrap should expose searchable resource types");
    assert(body.defaultTicketIssuer?.issuerBaseUrl === `${origin}/issuer/reference-demo`, "default ticket issuer mismatch");
  });

  await expectJson(`${origin}/issuer/reference-demo/.well-known/jwks.json`, (body) => {
    assert(Array.isArray(body.keys) && body.keys[0]?.kid, "issuer jwks should expose a kid");
    assert(body.keys[0].alg === "ES256", "issuer jwks should advertise ES256");
  });

  const signTicketResponse = await fetch(`${origin}/issuer/reference-demo/sign-ticket`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      sub: "smoke-ticket",
      aud: origin,
      ticket_type: NETWORK_PATIENT_ACCESS_TICKET_TYPE,
      authorization: {
        subject: { type: "match", traits: { resourceType: "Patient", name: [{ family: "Reyes", given: ["Elena"] }], birthDate: "1989-09-14" } },
        access: {
          scopes: ["patient/Patient.rs", "patient/Encounter.rs"],
          periods: [{ start: "2023-01-01", end: "2025-12-31" }],
        },
      },
      details: { sensitive: { mode: "deny" } },
    }),
  });
  assert(signTicketResponse.status === 201, "issuer sign-ticket should create a signed ticket");
  const signedTicketBody = await signTicketResponse.json();
  const decodedSignedTicket = decodeEs256Jwt<any>(signedTicketBody.signed_ticket);
  assert(decodedSignedTicket.payload.iss === `${origin}/issuer/reference-demo`, "signed ticket issuer mismatch");

  await expectJson(`${origin}/networks/reference/fhir/.well-known/smart-configuration`, (body) => {
    assert(body.token_endpoint === `${origin}/networks/reference/token`, "network smart config token endpoint mismatch");
    assert(body.fhir_base_url === `${origin}/networks/reference/fhir`, "network smart config fhir base mismatch");
    assert(body.smart_permission_ticket_types_supported?.includes(NETWORK_PATIENT_ACCESS_TICKET_TYPE), "network smart config ticket types missing");
    assert(body.mode === undefined, "network smart config should not expose legacy mode");
    assert(body.capabilities === undefined, "network smart config should not expose legacy custom capabilities");
  });

  await expectJson(`${origin}/.well-known/smart-configuration`, (body) => {
    assert(body.token_endpoint === `${origin}/token`, "root smart config token endpoint mismatch");
    assert(body.smart_permission_ticket_types_supported?.includes(NETWORK_PATIENT_ACCESS_TICKET_TYPE), "root smart config ticket types missing");
  });
  await expectJson(`${origin}/modes/open/sites/lone-star-womens-health/fhir/.well-known/smart-configuration`, (body) => {
    assert(body.token_endpoint === `${origin}/modes/open/sites/lone-star-womens-health/token`, "site smart config token endpoint mismatch");
    assert(body.fhir_base_url === `${origin}/modes/open/sites/lone-star-womens-health/fhir`, "site smart config fhir base mismatch");
  });

  await expectJson(`${origin}/fhir/metadata`, (body) => {
    assert(body.resourceType === "CapabilityStatement", "metadata must be CapabilityStatement");
  });

  const registration = await postJson(`${origin}/register`, {
    client_name: "Smoke Test Client",
    token_endpoint_auth_method: "private_key_jwt",
    jwk: clientBootstrap.publicJwk,
  });
  assert(registration.client_id, "dynamic registration client_id missing");
  assert(registration.jwk_thumbprint, "dynamic registration thumbprint missing");

  const networkToken = await postFormJsonWithClient(`${origin}/networks/reference/token`, {
    grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
    subject_token_type: "https://smarthealthit.org/token-type/permission-ticket",
    subject_token: signedTicketBody.signed_ticket,
  }, registration.client_id, clientBootstrap.privateJwk, clientBootstrap.thumbprint);
  assert(typeof networkToken.access_token === "string", "network token exchange should issue an access token");

  const networkLocations = await postJsonWithBearer(
    `${origin}/networks/reference/fhir/$resolve-record-locations`,
    { resourceType: "Parameters" },
    networkToken.access_token,
    clientBootstrap.thumbprint,
  );
  const resolvedSiteSlugs = (networkLocations.entry ?? [])
    .filter((entry: any) => entry?.resource?.resourceType === "Endpoint")
    .map((entry: any) => entry.resource.identifier?.find((identifier: any) => identifier.system === "urn:smart-permission-tickets:site-slug")?.value)
    .filter((value: unknown): value is string => typeof value === "string");
  assert(resolvedSiteSlugs.includes("bay-area-rheumatology-associates"), "network RLS should include surviving sites");

  const denyTicket = mintTicket({
    iss: origin,
    subject: { type: "match", traits: { resourceType: "Patient", name: [{ family: "Reyes", given: ["Elena"] }], birthDate: "1989-09-14" } },
    scopes: ["patient/DiagnosticReport.rs"],
    periods: [{ start: "2021-01-01", end: "2023-12-31" }],
    sensitiveMode: "deny",
  });
  const allowTicket = mintTicket({
    iss: origin,
    subject: { type: "match", traits: { resourceType: "Patient", name: [{ family: "Reyes", given: ["Elena"] }], birthDate: "1989-09-14" } },
    scopes: ["patient/DiagnosticReport.rs"],
    periods: [{ start: "2021-01-01", end: "2023-12-31" }],
    sensitiveMode: "allow",
  });
  const denySiteTicket = mintTicket({
    iss: origin,
    subject: { type: "match", traits: { resourceType: "Patient", name: [{ family: "Reyes", given: ["Elena"] }], birthDate: "1989-09-14" } },
    scopes: ["patient/Encounter.rs", "patient/DiagnosticReport.rs"],
    periods: [{ start: "2021-01-01", end: "2023-12-31" }],
    sensitiveMode: "deny",
  });
  const allowSiteTicket = mintTicket({
    iss: origin,
    subject: { type: "match", traits: { resourceType: "Patient", name: [{ family: "Reyes", given: ["Elena"] }], birthDate: "1989-09-14" } },
    scopes: ["patient/Encounter.rs", "patient/DiagnosticReport.rs"],
    periods: [{ start: "2021-01-01", end: "2023-12-31" }],
    sensitiveMode: "allow",
  });

  const openTokenDeny = await exchangeOpenToken(origin, denyTicket);
  const openTokenAllow = await exchangeOpenToken(origin, allowTicket);
  const openSiteTokenAllow = await exchangeOpenToken(origin, allowSiteTicket, "lone-star-womens-health");

  const denyBundle = await getJson(`${origin}/modes/open/fhir/DiagnosticReport?_count=100`, openTokenDeny.access_token);
  const allowBundle = await getJson(`${origin}/modes/open/fhir/DiagnosticReport?_count=100`, openTokenAllow.access_token);
  assert(denyBundle.total < allowBundle.total, "sensitive deny should hide some DiagnosticReports");

  const loneStarAllow = await getJson(`${origin}/modes/open/sites/lone-star-womens-health/fhir/DiagnosticReport?_count=100`, openSiteTokenAllow.access_token);
  assert(loneStarAllow.total > 0, "site-partitioned allow search should show lone-star reports");

  const loneStarDeny = await postForm(`${origin}/modes/open/sites/lone-star-womens-health/token`, {
    grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
    subject_token_type: "https://smarthealthit.org/token-type/permission-ticket",
    subject_token: denySiteTicket,
  });
  assert(loneStarDeny.status === 400, "site-partitioned deny token exchange should fail when no encounters remain");

  const globalWithSiteToken = await fetch(`${origin}/modes/open/fhir/DiagnosticReport?_count=5`, {
    headers: { authorization: `Bearer ${openSiteTokenAllow.access_token}` },
  });
  assert(globalWithSiteToken.status === 400, "site-issued token should not work on the global open FHIR base");

  const strictTicket = mintTicket({
    iss: origin,
    subject: { type: "match", traits: { resourceType: "Patient", name: [{ family: "Reyes", given: ["Elena"] }], birthDate: "1989-09-14" } },
    scopes: ["patient/Patient.rs", "patient/Observation.rs?category=laboratory"],
    periods: [{ start: "2023-01-01", end: "2025-12-31" }],
    sensitiveMode: "deny",
    cnf: { jkt: clientBootstrap.thumbprint },
  });
  const strictToken = await exchangeStrictToken(origin, registration.client_id, clientBootstrap.privateJwk, strictTicket);

  const introspection = await introspect(origin, registration.client_id, clientBootstrap.privateJwk, strictToken.access_token, clientBootstrap.thumbprint);
  assert(introspection.active === true, "strict access token should introspect active");
  assert(introspection.patient, "introspection should return patient");

  const patientId = strictToken.patient;
  const patient = await getJson(`${origin}/fhir/Patient/${patientId}`, strictToken.access_token, clientBootstrap.thumbprint);
  assert(patient.resourceType === "Patient", "read should return Patient");

  const labs = await getJson(`${origin}/fhir/Observation?patient=${patientId}&category=laboratory&_count=5`, strictToken.access_token, clientBootstrap.thumbprint);
  assert(labs.resourceType === "Bundle" && labs.total > 0, "lab search should return visible observations");

  const patientPagingToken = await exchangeOpenToken(
    origin,
    mintTicket({
      iss: origin,
      subject: { type: "match", traits: { resourceType: "Patient", name: [{ family: "Reyes", given: ["Elena"] }], birthDate: "1989-09-14" } },
      scopes: ["patient/Patient.rs"],
      periods: [{ start: "2021-01-01", end: "2025-12-31" }],
      sensitiveMode: "allow",
    }),
  );
  const patientPage = await getJson(`${origin}/modes/open/fhir/Patient?_count=1`, patientPagingToken.access_token);
  assert(Array.isArray(patientPage.entry) && patientPage.entry.length === 1, "_count=1 should limit the page to one entry");
  assert(patientPage.total > patientPage.entry.length, "paged patient search should report a larger total");
  const nextLink = patientPage.link?.find((link: any) => link.relation === "next")?.url;
  assert(typeof nextLink === "string", "paged patient search should include a next link");
  const nextPage = await getJson(nextLink, patientPagingToken.access_token);
  assert(Array.isArray(nextPage.entry) && nextPage.entry.length === 1, "next link should fetch the next page");

  const anonymousMetadata = await fetch(`${origin}/modes/anonymous/fhir/metadata`);
  assert(anonymousMetadata.ok, "anonymous metadata should be readable without a token");
  const anonymousBundle = await fetch(`${origin}/modes/anonymous/sites/lone-star-womens-health/fhir/DiagnosticReport?_count=20`);
  assert(anonymousBundle.ok, "anonymous site search should be readable without a token");
  const anonymousBody = await anonymousBundle.json();
  assert(anonymousBody.total > 0, "anonymous site search should return site data without a token");

  const strictWithoutClient = await postForm(`${origin}/token`, {
    grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
    subject_token_type: "https://smarthealthit.org/token-type/permission-ticket",
    subject_token: mintTicket({
      iss: origin,
      subject: { type: "match", traits: { resourceType: "Patient", name: [{ family: "Reyes", given: ["Elena"] }], birthDate: "1989-09-14" } },
      scopes: ["patient/Patient.rs"],
      periods: [{ start: "2023-01-01", end: "2025-12-31" }],
      sensitiveMode: "deny",
    }),
  });
  assert(strictWithoutClient.status === 400, "strict token endpoint should reject unauthenticated client");

  console.log(JSON.stringify({
    ok: true,
    origin,
    checks: {
      landingPage: true,
      demoBootstrap: true,
      smartConfig: true,
      capabilityStatement: true,
      dynamicRegistration: true,
      openTokenExchange: true,
      strictTokenExchange: true,
      introspection: true,
      guardedRead: true,
      search: true,
      sitePartitioning: true,
      anonymousReadAccess: true,
      sensitiveMode: {
        denyTotal: denyBundle.total,
        allowTotal: allowBundle.total,
      },
    },
  }, null, 2));
} finally {
  server.stop(true);
}

function mintTicket(input: {
  iss: string;
  subject: any;
  scopes: string[];
  periods: Array<{ start?: string; end?: string }>;
  sensitiveMode: "deny" | "allow";
  cnf?: { jkt: string };
}) {
  const ticketOrigin = input.iss;
  return context.issuers.sign(ticketOrigin, context.config.defaultPermissionTicketIssuerSlug, {
    iss: `${ticketOrigin}/issuer/${context.config.defaultPermissionTicketIssuerSlug}`,
    sub: "smoke-ticket",
    aud: ticketOrigin,
    exp: Math.floor(Date.now() / 1000) + 3600,
    ticket_type: NETWORK_PATIENT_ACCESS_TICKET_TYPE,
    cnf: input.cnf,
    authorization: {
      subject: input.subject,
      access: {
        scopes: input.scopes,
        periods: input.periods,
      },
    },
    details: {
      sensitive: {
        mode: input.sensitiveMode,
      },
    },
  });
}

async function exchangeOpenToken(origin: string, ticket: string, siteSlug?: string) {
  const prefix = siteSlug ? `${origin}/modes/open/sites/${siteSlug}` : `${origin}/modes/open`;
  return postFormJson(`${prefix}/token`, {
    grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
    subject_token_type: "https://smarthealthit.org/token-type/permission-ticket",
    subject_token: ticket,
  });
}

async function exchangeStrictToken(origin: string, clientId: string, privateJwk: JsonWebKey, ticket: string) {
  return postFormJsonWithClient(`${origin}/token`, {
    grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
    subject_token_type: "https://smarthealthit.org/token-type/permission-ticket",
    subject_token: ticket,
  }, clientId, privateJwk);
}

async function introspect(origin: string, clientId: string, privateJwk: JsonWebKey, token: string, proofJkt?: string) {
  return postFormJsonWithClient(`${origin}/introspect`, {
    token,
  }, clientId, privateJwk, proofJkt);
}

async function expectJson(url: string, check: (body: any) => void) {
  const response = await fetch(url);
  assert(response.ok, `${url} failed with ${response.status}`);
  const body = await response.json();
  check(body);
}

async function expectHtml(url: string, check: (body: string) => void) {
  const response = await fetch(url);
  assert(response.ok, `${url} failed with ${response.status}`);
  const body = await response.text();
  check(body);
}

async function getJson(url: string, accessToken: string, proofJkt?: string) {
  const response = await fetch(url, {
    headers: {
      authorization: `Bearer ${accessToken}`,
      ...(proofJkt ? { "x-client-jkt": proofJkt } : {}),
    },
  });
  assert(response.ok, `${url} failed with ${response.status}`);
  return response.json();
}

async function postJson(url: string, body: Record<string, any>) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  assert(response.ok, `${url} failed with ${response.status}`);
  return response.json();
}

async function postJsonWithBearer(url: string, body: Record<string, any>, accessToken: string, proofJkt?: string) {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${accessToken}`,
      ...(proofJkt ? { "x-client-jkt": proofJkt } : {}),
    },
    body: JSON.stringify(body),
  });
  assert(response.status === 200, `expected 200 from ${url}, got ${response.status}`);
  return response.json();
}

async function postFormJson(url: string, body: Record<string, string>) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(body),
  });
  assert(response.ok, `${url} failed with ${response.status}`);
  return response.json();
}

async function postForm(url: string, body: Record<string, string>) {
  return fetch(url, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(body),
  });
}

async function postFormJsonWithClient(
  url: string,
  body: Record<string, string>,
  clientId: string,
  privateJwk: JsonWebKey,
  proofJkt?: string,
) {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      ...(proofJkt ? { "x-client-jkt": proofJkt } : {}),
    },
    body: new URLSearchParams({
      ...body,
      client_id: clientId,
      client_assertion_type: "urn:ietf:params:oauth:client-assertion-type:jwt-bearer",
      client_assertion: await signPrivateKeyJwt(
        {
          iss: clientId,
          sub: clientId,
          aud: url,
          iat: Math.floor(Date.now() / 1000),
          exp: Math.floor(Date.now() / 1000) + 300,
          jti: crypto.randomUUID(),
        },
        privateJwk,
      ),
    }),
  });
  assert(response.ok, `${url} failed with ${response.status}`);
  return response.json();
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
