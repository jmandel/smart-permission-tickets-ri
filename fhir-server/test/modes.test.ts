import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { generateClientKeyMaterial, signPrivateKeyJwt } from "../shared/private-key-jwt.ts";
import { decodeEs256Jwt } from "../src/auth/es256-jwt.ts";
import { createAppContext, startServer } from "../src/app.ts";

let context: ReturnType<typeof createAppContext>;
let server: ReturnType<typeof startServer>;
let origin: string;

type DemoClient = {
  clientId: string;
  clientName: string;
  publicJwk: JsonWebKey;
  privateJwk: JsonWebKey;
  jwkThumbprint: string;
};

beforeAll(() => {
  context = createAppContext({ port: 0 });
  server = startServer(context, 0);
  origin = `http://127.0.0.1:${server.port}`;
  context.config.issuer = origin;
});

afterAll(() => {
  server.stop(true);
});

describe("mode surfaces", () => {
  test("root landing page lists modes, sites, and patients", async () => {
    const response = await fetch(`${origin}/`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/html");
    const body = await response.text();
    expect(body).toContain("SMART Permission Tickets");
    expect(body).toContain("<div id=\"root\"></div>");
  });

  test("demo bootstrap exposes persons, sites, and searchable resource types", async () => {
    const response = await fetch(`${origin}/demo/bootstrap`);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(Array.isArray(body.persons)).toBe(true);
    expect(body.persons.length).toBeGreaterThan(0);
    expect(Array.isArray(body.sites)).toBe(true);
    expect(Array.isArray(body.searchableResourceTypes)).toBe(true);
    expect(body.searchableResourceTypes).toContain("Patient");
    expect(body.searchableResourceTypes).toContain("Observation");
    expect(body.defaultTicketIssuer.issuerBaseUrl).toBe(`${origin}/issuer/reference-demo`);
  });

  test("issuer jwks and sign-ticket expose a discoverable ES256 issuer surface", async () => {
    const jwksResponse = await fetch(`${origin}/issuer/reference-demo/.well-known/jwks.json`);
    expect(jwksResponse.status).toBe(200);
    const jwks = await jwksResponse.json();
    expect(Array.isArray(jwks.keys)).toBe(true);
    expect(jwks.keys[0].kid).toBeTruthy();
    expect(jwks.keys[0].alg).toBe("ES256");

    const signResponse = await fetch(`${origin}/issuer/reference-demo/sign-ticket`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        sub: "mode-test-ticket",
        aud: origin,
        ticket_type: "urn:demo:ticket",
        authorization: {
          subject: elenaMatchSubject(),
          access: {
            scopes: ["patient/Patient.rs"],
            periods: [{ start: "2023-01-01", end: "2025-12-31" }],
          },
        },
        details: { sensitive: { mode: "deny" } },
      }),
    });
    expect(signResponse.status).toBe(201);
    const signed = await signResponse.json();
    const decoded = decodeEs256Jwt<any>(signed.signed_ticket);
    expect(decoded.header.alg).toBe("ES256");
    expect(decoded.header.kid).toBe(jwks.keys[0].kid);
    expect(decoded.payload.iss).toBe(`${origin}/issuer/reference-demo`);
  });

  test("network token exchange and record-location resolution return only authorized visible sites", async () => {
    const configResponse = await fetch(`${origin}/networks/reference/fhir/.well-known/smart-configuration`);
    expect(configResponse.status).toBe(200);
    const config = await configResponse.json();
    expect(config.token_endpoint).toBe(`${origin}/networks/reference/token`);
    expect(config.fhir_base_url).toBe(`${origin}/networks/reference/fhir`);

    const client = await registerDynamicClient(`${origin}/networks/reference/register`, "Network RLS Client");
    const token = await postFormJsonWithClient(`${origin}/networks/reference/token`, {
      grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
      subject_token_type: "https://smarthealthit.org/token-type/permission-ticket",
      subject_token: mintTicket({
        subject: elenaMatchSubject(),
        scopes: ["patient/*.rs"],
        periods: [{ start: "2021-01-01", end: "2025-12-31" }],
        sensitiveMode: "deny",
        cnf: { jkt: client.jwkThumbprint },
      }),
    }, client, { proofJkt: client.jwkThumbprint });
    expect(typeof token.access_token).toBe("string");

    const bundle = await postJsonWithBearer(
      `${origin}/networks/reference/fhir/$resolve-record-locations`,
      { resourceType: "Parameters" },
      token.access_token,
      client.jwkThumbprint,
    );
    const endpoints = (bundle.entry ?? []).filter((entry: any) => entry?.resource?.resourceType === "Endpoint");
    const siteSlugs = endpoints.map((entry: any) =>
      entry.resource.identifier?.find((identifier: any) => identifier.system === "urn:smart-permission-tickets:site-slug")?.value,
    );
    expect(siteSlugs).not.toContain("lone-star-womens-health");
    expect(siteSlugs).toContain("bay-area-rheumatology-associates");
    expect(endpoints[0]?.resource?.extension?.some?.((extension: any) =>
      extension?.url === "https://smarthealthit.org/fhir/StructureDefinition/smart-permission-tickets-site-patient" &&
      typeof extension?.valueReference?.reference === "string"
    )).toBe(true);
  });

  test("strict token exchange rejects anonymous clients", async () => {
    const response = await postForm(`${origin}/token`, {
      grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
      subject_token_type: "https://smarthealthit.org/token-type/permission-ticket",
      subject_token: mintTicket({
        subject: elenaMatchSubject(),
        scopes: ["patient/Patient.rs"],
        periods: [{ start: "2023-01-01", end: "2025-12-31" }],
        sensitiveMode: "deny",
      }),
    });
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.issue[0].diagnostics).toContain("Authenticated key-based client assertion required");
  });

  test("strict token exchange rejects wrong-bound client assertions", async () => {
    const registeredClient = await registerDynamicClient(`${origin}/register`, "Strict Bound Client");
    const wrongKeyClient = await registerDynamicClient(`${origin}/register`, "Strict Wrong Key Client");
    const ticket = mintTicket({
      subject: elenaMatchSubject(),
      scopes: ["patient/Patient.rs"],
      periods: [{ start: "2023-01-01", end: "2025-12-31" }],
      sensitiveMode: "deny",
      cnf: { jkt: registeredClient.jwkThumbprint },
    });

    const wrongAssertion = await postFormWithClient(
      `${origin}/token`,
      {
        grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
        subject_token_type: "https://smarthealthit.org/token-type/permission-ticket",
        subject_token: ticket,
      },
      wrongKeyClient,
      { assertionClientId: registeredClient.clientId },
    );
    expect(wrongAssertion.status).toBe(400);
    expect((await wrongAssertion.json()).issue[0].diagnostics).toContain("Invalid client assertion signature");

    const mismatchedBinding = await postFormWithClient(
      `${origin}/token`,
      {
        grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
        subject_token_type: "https://smarthealthit.org/token-type/permission-ticket",
        subject_token: ticket,
      },
      wrongKeyClient,
    );
    expect(mismatchedBinding.status).toBe(400);
    expect((await mismatchedBinding.json()).issue[0].diagnostics).toContain("Client key does not match ticket binding");
  });

  test("open token exchange allows anonymous clients", async () => {
    const body = await postFormJson(`${origin}/modes/open/token`, {
      grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
      subject_token_type: "https://smarthealthit.org/token-type/permission-ticket",
      subject_token: mintTicket({
        subject: elenaMatchSubject(),
        scopes: ["patient/Patient.rs"],
        periods: [{ start: "2023-01-01", end: "2025-12-31" }],
        sensitiveMode: "deny",
      }),
    });
    expect(typeof body.access_token).toBe("string");
    expect(typeof body.patient).toBe("string");
  });

  test("site-specific SMART config advertises site-bound auth endpoints", async () => {
    const config = await fetch(`${origin}/modes/open/sites/lone-star-womens-health/fhir/.well-known/smart-configuration`);
    expect(config.status).toBe(200);
    const body = await config.json();
    expect(body.token_endpoint).toBe(`${origin}/modes/open/sites/lone-star-womens-health/token`);
    expect(body.registration_endpoint).toBe(`${origin}/modes/open/sites/lone-star-womens-health/register`);
    expect(body.introspection_endpoint).toBe(`${origin}/modes/open/sites/lone-star-womens-health/introspect`);
    expect(body.fhir_base_url).toBe(`${origin}/modes/open/sites/lone-star-womens-health/fhir`);
  });

  test("summary=count returns totals without entry payloads", async () => {
    const tokenBody = await postFormJson(`${origin}/modes/open/token`, {
      grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
      subject_token_type: "https://smarthealthit.org/token-type/permission-ticket",
      subject_token: mintTicket({
        subject: elenaMatchSubject(),
        scopes: ["patient/DiagnosticReport.rs"],
        periods: [{ start: "2021-01-01", end: "2025-12-31" }],
        sensitiveMode: "allow",
      }),
    });

    const countOnly = await getJson(`${origin}/modes/open/fhir/DiagnosticReport?_summary=count`, tokenBody.access_token);
    const preview = await getJson(`${origin}/modes/open/fhir/DiagnosticReport?_count=5`, tokenBody.access_token);
    expect(countOnly.total).toBeGreaterThan(0);
    expect(countOnly.entry).toEqual([]);
    expect(countOnly.total).toBeGreaterThanOrEqual(preview.entry.length);
  });

  test("_count limits entries and next links page through global and site-specific searches", async () => {
    const globalToken = await postFormJson(`${origin}/modes/open/token`, {
      grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
      subject_token_type: "https://smarthealthit.org/token-type/permission-ticket",
      subject_token: mintTicket({
        subject: elenaMatchSubject(),
        scopes: ["patient/Patient.rs", "patient/Encounter.rs"],
        periods: [{ start: "2021-01-01", end: "2025-12-31" }],
        sensitiveMode: "allow",
      }),
    });

    const firstPatientPage = await getJson(`${origin}/modes/open/fhir/Patient?_count=1`, globalToken.access_token);
    expect(firstPatientPage.entry).toHaveLength(1);
    expect(firstPatientPage.total).toBeGreaterThan(1);
    const nextPatientLink = firstPatientPage.link?.find((link: any) => link.relation === "next")?.url;
    expect(typeof nextPatientLink).toBe("string");

    const secondPatientPage = await getJson(nextPatientLink, globalToken.access_token);
    expect(secondPatientPage.entry).toHaveLength(1);
    expect(secondPatientPage.entry[0].resource.id).not.toBe(firstPatientPage.entry[0].resource.id);

    const siteToken = await postFormJson(`${origin}/modes/open/sites/eastbay-primary-care-associates/token`, {
      grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
      subject_token_type: "https://smarthealthit.org/token-type/permission-ticket",
      subject_token: mintTicket({
        subject: elenaMatchSubject(),
        scopes: ["patient/Encounter.rs"],
        periods: [{ start: "2022-01-01", end: "2025-12-31" }],
        sensitiveMode: "allow",
        organizations: [
          {
            identifier: [{ system: "http://hl7.org/fhir/sid/us-npi", value: "1902847536" }],
          },
        ],
      }),
    });

    const firstEncounterPage = await getJson(`${origin}/modes/open/sites/eastbay-primary-care-associates/fhir/Encounter?_count=1`, siteToken.access_token);
    expect(firstEncounterPage.entry).toHaveLength(1);
    expect(firstEncounterPage.total).toBeGreaterThan(1);
    expect(firstEncounterPage.entry[0].fullUrl).toMatch(
      new RegExp(`^${origin}/modes/open/sites/eastbay-primary-care-associates/fhir/Encounter/[^/]+$`),
    );
    const nextEncounterLink = firstEncounterPage.link?.find((link: any) => link.relation === "next")?.url;
    expect(typeof nextEncounterLink).toBe("string");

    const secondEncounterPage = await getJson(nextEncounterLink, siteToken.access_token);
    expect(secondEncounterPage.entry).toHaveLength(1);
    expect(secondEncounterPage.entry[0].resource.id).not.toBe(firstEncounterPage.entry[0].resource.id);
  });

  test("served Patient resources include a shared cross-site identifier without changing matching", async () => {
    const tokenBody = await postFormJson(`${origin}/modes/open/token`, {
      grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
      subject_token_type: "https://smarthealthit.org/token-type/permission-ticket",
      subject_token: mintTicket({
        subject: elenaMatchSubject(),
        scopes: ["patient/Patient.rs"],
        periods: [{ start: "2021-01-01", end: "2025-12-31" }],
        sensitiveMode: "allow",
      }),
    });

    const bundle = await getJson(`${origin}/modes/open/fhir/Patient?_count=20`, tokenBody.access_token);
    expect(bundle.total).toBeGreaterThan(1);

    const personIds = new Set(
      bundle.entry
        .map((entry: any) =>
          entry.resource.identifier?.find(
            (identifier: any) => identifier.system === "urn:smart-permission-tickets:person-id",
          )?.value,
        )
        .filter(Boolean),
    );
    expect(personIds.size).toBe(1);
  });

  test("served resources no longer expose repeated source-org or jurisdiction meta tags", async () => {
    const tokenBody = await postFormJson(`${origin}/modes/open/token`, {
      grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
      subject_token_type: "https://smarthealthit.org/token-type/permission-ticket",
      subject_token: mintTicket({
        subject: elenaMatchSubject(),
        scopes: ["patient/Patient.rs", "patient/Encounter.rs"],
        periods: [{ start: "2021-01-01", end: "2025-12-31" }],
        sensitiveMode: "allow",
      }),
    });

    const patient = await getJson(`${origin}/modes/open/fhir/Patient/${tokenBody.patient}`, tokenBody.access_token);
    const patientTagSystems = new Set((patient.meta?.tag ?? []).map((tag: any) => tag.system));
    expect(patientTagSystems.has("urn:example:permissiontickets-demo:source-org-npi")).toBe(false);
    expect(patientTagSystems.has("urn:example:permissiontickets-demo:jurisdiction-state")).toBe(false);

    const encounters = await getJson(`${origin}/modes/open/fhir/Encounter?_count=5`, tokenBody.access_token);
    const firstEncounter = encounters.entry?.[0]?.resource;
    expect(firstEncounter?.resourceType).toBe("Encounter");
    const encounterTagSystems = new Set((firstEncounter.meta?.tag ?? []).map((tag: any) => tag.system));
    expect(encounterTagSystems.has("urn:example:permissiontickets-demo:source-org-npi")).toBe(false);
    expect(encounterTagSystems.has("urn:example:permissiontickets-demo:jurisdiction-state")).toBe(false);
  });

  test("registered mode accepts a dynamically registered client", async () => {
    const client = await registerDynamicClient(`${origin}/register`, "Registered Mode Test Client");
    const tokenBody = await postFormJsonWithClient(`${origin}/modes/registered/token`, {
      grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
      subject_token_type: "https://smarthealthit.org/token-type/permission-ticket",
      subject_token: mintTicket({
        subject: elenaMatchSubject(),
        scopes: ["patient/Patient.rs"],
        periods: [{ start: "2023-01-01", end: "2025-12-31" }],
        sensitiveMode: "deny",
      }),
    }, client);
    expect(typeof tokenBody.access_token).toBe("string");

    const patient = await getJson(`${origin}/modes/registered/fhir/Patient/${tokenBody.patient}`, tokenBody.access_token);
    expect(patient.resourceType).toBe("Patient");
  });

  test("dynamic registrations survive server restart without stored state", async () => {
    const client = await registerDynamicClient(`${origin}/register`, "Restart Safe Client");

    const restartedContext = createAppContext({ port: 0 });
    const restartedServer = startServer(restartedContext, 0);
    const restartedOrigin = `http://127.0.0.1:${restartedServer.port}`;
    restartedContext.config.issuer = restartedOrigin;

    try {
      const tokenBody = await postFormJsonWithClient(`${restartedOrigin}/modes/registered/token`, {
        grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
        subject_token_type: "https://smarthealthit.org/token-type/permission-ticket",
        subject_token: mintTicket({
          issuer: restartedOrigin,
          subject: elenaMatchSubject(),
          scopes: ["patient/Patient.rs"],
          periods: [{ start: "2023-01-01", end: "2025-12-31" }],
          sensitiveMode: "deny",
        }),
      }, client);
      expect(typeof tokenBody.access_token).toBe("string");
      const patient = await getJson(`${restartedOrigin}/modes/registered/fhir/Patient/${tokenBody.patient}`, tokenBody.access_token);
      expect(patient.resourceType).toBe("Patient");
    } finally {
      restartedServer.stop(true);
    }
  });

  test("key-bound mode requires matching client binding for cnf-bound tickets", async () => {
    const boundClient = await registerDynamicClient(`${origin}/modes/key-bound/register`, "Key Bound Test Client");
    const wrongClient = await registerDynamicClient(`${origin}/modes/key-bound/register`, "Wrong Key Test Client");
    const ticket = mintTicket({
      subject: elenaMatchSubject(),
      scopes: ["patient/Patient.rs"],
      periods: [{ start: "2023-01-01", end: "2025-12-31" }],
      sensitiveMode: "deny",
      cnf: { jkt: boundClient.jwkThumbprint },
    });

    const missingProof = await postForm(`${origin}/modes/key-bound/token`, {
      grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
      subject_token_type: "https://smarthealthit.org/token-type/permission-ticket",
      subject_token: ticket,
    });
    expect(missingProof.status).toBe(400);
    expect((await missingProof.json()).issue[0].diagnostics).toContain("client assertion");

    const wrongProof = await postFormWithClient(`${origin}/modes/key-bound/token`, {
        grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
        subject_token_type: "https://smarthealthit.org/token-type/permission-ticket",
        subject_token: ticket,
      }, wrongClient, { assertionClientId: boundClient.clientId });
    expect(wrongProof.status).toBe(400);
    expect((await wrongProof.json()).issue[0].diagnostics).toContain("Invalid client assertion signature");

    const okBody = await postFormJsonWithClient(`${origin}/modes/key-bound/token`, {
      grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
      subject_token_type: "https://smarthealthit.org/token-type/permission-ticket",
      subject_token: ticket,
    }, boundClient);
    expect(typeof okBody.access_token).toBe("string");

    const noProofRead = await fetch(`${origin}/modes/key-bound/fhir/Patient/${okBody.patient}`, {
      headers: {
        authorization: `Bearer ${okBody.access_token}`,
      },
    });
    expect(noProofRead.status).toBe(400);

    const okRead = await fetch(`${origin}/modes/key-bound/fhir/Patient/${okBody.patient}`, {
      headers: {
        authorization: `Bearer ${okBody.access_token}`,
        "x-client-jkt": boundClient.jwkThumbprint,
      },
    });
    expect(okRead.status).toBe(200);
  });

  test("anonymous mode allows read-only FHIR access without a token", async () => {
    const metadata = await fetch(`${origin}/modes/anonymous/fhir/metadata`);
    expect(metadata.status).toBe(200);

    const bundle = await fetch(`${origin}/modes/anonymous/sites/lone-star-womens-health/fhir/DiagnosticReport?_count=20`);
    expect(bundle.status).toBe(200);
    const body = await bundle.json();
    expect(body.total).toBeGreaterThan(0);
  });

  test("open mode still requires an access token for FHIR", async () => {
    const response = await fetch(`${origin}/modes/open/fhir/Patient?_count=5`);
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.issue[0].diagnostics).toContain("Missing Bearer access token");
  });

  test("multi-jurisdiction tickets behave as a union, not impossible AND", async () => {
    const token = await postFormJson(`${origin}/modes/open/token`, {
      grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
      subject_token_type: "https://smarthealthit.org/token-type/permission-ticket",
      subject_token: mintTicket({
        subject: elenaMatchSubject(),
        scopes: ["patient/Patient.rs"],
        periods: [{ start: "2021-01-01", end: "2025-12-31" }],
        sensitiveMode: "allow",
        jurisdictions: [{ state: "CA" }, { state: "TX" }],
      }),
    });

    const bundle = await getJson(`${origin}/modes/open/fhir/Patient?_count=20`, token.access_token);
    expect(bundle.total).toBeGreaterThan(1);
  });

  test("organization identifier-only tickets issue tokens and restrict access to matching sites", async () => {
    const token = await postFormJson(`${origin}/modes/open/sites/lone-star-womens-health/token`, {
      grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
      subject_token_type: "https://smarthealthit.org/token-type/permission-ticket",
      subject_token: mintTicket({
        subject: elenaMatchSubject(),
        scopes: ["patient/Patient.rs", "patient/Encounter.rs"],
        periods: [{ start: "2021-01-01", end: "2025-12-31" }],
        sensitiveMode: "allow",
        organizations: [
          {
            identifier: [{ system: "http://hl7.org/fhir/sid/us-npi", value: "1589043712" }],
          },
        ],
      }),
    });

    const patients = await getJson(`${origin}/modes/open/sites/lone-star-womens-health/fhir/Patient?_count=20`, token.access_token);
    expect(patients.total).toBe(1);

    const allowedSiteEncounters = await getJson(
      `${origin}/modes/open/sites/lone-star-womens-health/fhir/Encounter?_count=20`,
      token.access_token,
    );
    expect(allowedSiteEncounters.total).toBeGreaterThan(0);

    const disallowedSiteEncounters = await fetch(`${origin}/modes/open/sites/eastbay-primary-care-associates/fhir/Encounter?_count=20`, {
      headers: { authorization: `Bearer ${token.access_token}` },
    });
    expect(disallowedSiteEncounters.status).toBe(400);
  });

  test("supporting context resources remain queryable under narrow clinical scopes", async () => {
    const tokenBody = await postFormJson(`${origin}/modes/open/sites/bay-area-rheumatology-associates/token`, {
      grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
      subject_token_type: "https://smarthealthit.org/token-type/permission-ticket",
      subject_token: mintTicket({
        subject: elenaMatchSubject(),
        scopes: [
          "patient/Encounter.rs",
          "patient/Observation.rs?category=http://terminology.hl7.org/CodeSystem/observation-category|laboratory",
        ],
        periods: [{ start: "2023-01-01", end: "2025-12-31" }],
        sensitiveMode: "allow",
      }),
    });

    const organizationBundle = await getJson(`${origin}/modes/open/sites/bay-area-rheumatology-associates/fhir/Organization?_count=10`, tokenBody.access_token);
    const practitionerBundle = await getJson(`${origin}/modes/open/sites/bay-area-rheumatology-associates/fhir/Practitioner?_count=10`, tokenBody.access_token);
    const locationBundle = await getJson(`${origin}/modes/open/sites/bay-area-rheumatology-associates/fhir/Location?_count=10`, tokenBody.access_token);

    expect(organizationBundle.total).toBeGreaterThan(0);
    expect(practitionerBundle.total).toBeGreaterThan(0);
    expect(locationBundle.total).toBeGreaterThan(0);
  });

  test("organization and jurisdiction constraints intersect rather than widen", async () => {
    const response = await postForm(`${origin}/modes/open/token`, {
      grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
      subject_token_type: "https://smarthealthit.org/token-type/permission-ticket",
      subject_token: mintTicket({
        subject: elenaMatchSubject(),
        scopes: ["patient/Patient.rs"],
        periods: [{ start: "2021-01-01", end: "2025-12-31" }],
        sensitiveMode: "allow",
        jurisdictions: [{ state: "CA" }],
        organizations: [
          {
            identifier: [{ system: "http://hl7.org/fhir/sid/us-npi", value: "1589043712" }],
          },
        ],
      }),
    });
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.issue[0].diagnostics).toContain("exclude all patient aliases");
  });

  test("site token issuance fails when the requested site is excluded by jurisdiction", async () => {
    const caOnlyTicket = mintTicket({
      subject: elenaMatchSubject(),
      scopes: ["patient/Patient.rs", "patient/Encounter.rs"],
      periods: [{ start: "2021-01-01", end: "2025-12-31" }],
      sensitiveMode: "allow",
      jurisdictions: [{ state: "CA" }],
    });

    const allowed = await postFormJson(`${origin}/modes/open/sites/eastbay-primary-care-associates/token`, {
      grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
      subject_token_type: "https://smarthealthit.org/token-type/permission-ticket",
      subject_token: caOnlyTicket,
    });
    expect(typeof allowed.access_token).toBe("string");

    const rejected = await postForm(`${origin}/modes/open/sites/lone-star-womens-health/token`, {
      grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
      subject_token_type: "https://smarthealthit.org/token-type/permission-ticket",
      subject_token: caOnlyTicket,
    });
    expect(rejected.status).toBe(400);
    const body = await rejected.json();
    expect(body.issue[0].diagnostics).toContain("exclude the requested site");
  });

  test("site token issuance fails when the requested site is excluded by organization identifier", async () => {
    const loneStarOnlyTicket = mintTicket({
      subject: elenaMatchSubject(),
      scopes: ["patient/Patient.rs", "patient/Encounter.rs"],
      periods: [{ start: "2021-01-01", end: "2025-12-31" }],
      sensitiveMode: "allow",
      organizations: [
        {
          identifier: [{ system: "http://hl7.org/fhir/sid/us-npi", value: "1589043712" }],
        },
      ],
    });

    const allowed = await postFormJson(`${origin}/modes/open/sites/lone-star-womens-health/token`, {
      grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
      subject_token_type: "https://smarthealthit.org/token-type/permission-ticket",
      subject_token: loneStarOnlyTicket,
    });
    expect(typeof allowed.access_token).toBe("string");

    const rejected = await postForm(`${origin}/modes/open/sites/eastbay-primary-care-associates/token`, {
      grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
      subject_token_type: "https://smarthealthit.org/token-type/permission-ticket",
      subject_token: loneStarOnlyTicket,
    });
    expect(rejected.status).toBe(400);
    const body = await rejected.json();
    expect(body.issue[0].diagnostics).toContain("exclude the requested site");
  });

  test("site token issuance fails when filters leave the requested site with only supporting context", async () => {
    const denySensitiveTicket = mintTicket({
      subject: elenaMatchSubject(),
      scopes: ["patient/*.rs"],
      periods: [{ start: "2020-01-01", end: "2025-12-31" }],
      sensitiveMode: "deny",
    });

    const rejected = await postForm(`${origin}/modes/open/sites/lone-star-womens-health/token`, {
      grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
      subject_token_type: "https://smarthealthit.org/token-type/permission-ticket",
      subject_token: denySensitiveTicket,
    });
    expect(rejected.status).toBe(400);
    const body = await rejected.json();
    expect(body.issue[0].diagnostics).toContain("no visible encounters");

    const allowed = await postFormJson(`${origin}/modes/open/sites/lone-star-womens-health/token`, {
      grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
      subject_token_type: "https://smarthealthit.org/token-type/permission-ticket",
      subject_token: mintTicket({
        subject: elenaMatchSubject(),
        scopes: ["patient/*.rs"],
        periods: [{ start: "2020-01-01", end: "2025-12-31" }],
        sensitiveMode: "allow",
      }),
    });
    expect(typeof allowed.access_token).toBe("string");
  });
});

describe("issued token behavior", () => {
  test("strict-issued token works on strict endpoints and introspects active", async () => {
    const client = await registerDynamicClient(`${origin}/register`, "Strict Flow Client");
    const token = await issueStrictToken(client, ["patient/Patient.rs", "patient/Observation.rs?category=laboratory"]);
    const introspection = await postFormJsonWithClient(`${origin}/introspect`, {
      token: token.access_token,
    }, client, { proofJkt: client.jwkThumbprint });
    expect(introspection.active).toBe(true);
    expect(introspection.mode).toBe("strict");
    expect(introspection.client_id).toBe(client.clientId);
    expect(introspection.clientId).toBeUndefined();

    const accessTokenClaims = decodeJwtClaims(token.access_token);
    expect(accessTokenClaims.client_id).toBe(client.clientId);
    expect(accessTokenClaims.clientId).toBeUndefined();

    const patient = await getJson(`${origin}/fhir/Patient/${token.patient}`, token.access_token, client.jwkThumbprint);
    expect(patient.resourceType).toBe("Patient");

    const labs = await getJson(
      `${origin}/fhir/Observation?patient=${token.patient}&category=laboratory&_count=5`,
      token.access_token,
      client.jwkThumbprint,
    );
    expect(labs.resourceType).toBe("Bundle");
    expect(labs.total).toBeGreaterThan(0);
  });

  test("mode-bound tokens cannot be replayed across mode surfaces", async () => {
    const openToken = await issueOpenToken(["patient/Patient.rs"]);
    const strictReadWithOpenToken = await fetch(`${origin}/fhir/Patient/${openToken.patient}`, {
      headers: { authorization: `Bearer ${openToken.access_token}` },
    });
    expect(strictReadWithOpenToken.status).toBe(400);

    const strictClient = await registerDynamicClient(`${origin}/register`, "Strict Replay Client");
    const strictToken = await issueStrictToken(strictClient, ["patient/Patient.rs"]);
    const openReadWithStrictToken = await fetch(`${origin}/modes/open/fhir/Patient/${strictToken.patient}`, {
      headers: { authorization: `Bearer ${strictToken.access_token}` },
    });
    expect(openReadWithStrictToken.status).toBe(400);

    const siteToken = await issueOpenToken(
      ["patient/Encounter.rs", "patient/DiagnosticReport.rs"],
      "allow",
      [{ start: "2021-01-01", end: "2023-12-31" }],
      "lone-star-womens-health",
    );
    const siteRead = await fetch(`${origin}/modes/open/sites/lone-star-womens-health/fhir/DiagnosticReport?_count=5`, {
      headers: { authorization: `Bearer ${siteToken.access_token}` },
    });
    expect(siteRead.status).toBe(200);

    const globalReadWithSiteToken = await fetch(`${origin}/modes/open/fhir/DiagnosticReport?_count=5`, {
      headers: { authorization: `Bearer ${siteToken.access_token}` },
    });
    expect(globalReadWithSiteToken.status).toBe(400);
  });

  test("sensitive mode changes visible results after issuance", async () => {
    const denyToken = await issueOpenToken(["patient/DiagnosticReport.rs"], "deny", [{ start: "2021-01-01", end: "2023-12-31" }]);
    const allowToken = await issueOpenToken(["patient/DiagnosticReport.rs"], "allow", [{ start: "2021-01-01", end: "2023-12-31" }]);
    const allowSiteToken = await issueOpenToken(["patient/Encounter.rs", "patient/DiagnosticReport.rs"], "allow", [{ start: "2021-01-01", end: "2023-12-31" }], "lone-star-womens-health");

    const denyBundle = await getJson(`${origin}/modes/open/fhir/DiagnosticReport?_count=100`, denyToken.access_token);
    const allowBundle = await getJson(`${origin}/modes/open/fhir/DiagnosticReport?_count=100`, allowToken.access_token);
    expect(denyBundle.total).toBeLessThan(allowBundle.total);

    const denySiteRequest = await postForm(`${origin}/modes/open/sites/lone-star-womens-health/token`, {
      grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
      subject_token_type: "https://smarthealthit.org/token-type/permission-ticket",
      subject_token: mintTicket({
        subject: elenaMatchSubject(),
        scopes: ["patient/DiagnosticReport.rs"],
        periods: [{ start: "2021-01-01", end: "2023-12-31" }],
        sensitiveMode: "deny",
      }),
    });
    expect(denySiteRequest.status).toBe(400);
    expect((await denySiteRequest.json()).issue[0].diagnostics).toContain("no visible encounters");

    const allowSite = await getJson(`${origin}/modes/open/sites/lone-star-womens-health/fhir/DiagnosticReport?_count=100`, allowSiteToken.access_token);
    expect(allowSite.total).toBeGreaterThan(0);
  });
});

function elenaMatchSubject() {
  return {
    type: "match" as const,
    traits: {
      resourceType: "Patient" as const,
      name: [{ family: "Reyes", given: ["Elena"] }],
      birthDate: "1989-09-14",
    },
  };
}

function mintTicket(input: {
  issuer?: string;
  subject: any;
  scopes: string[];
  periods: Array<{ start?: string; end?: string }>;
  sensitiveMode: "deny" | "allow";
  cnf?: { jkt: string };
  jurisdictions?: Array<{ state?: string }>;
  organizations?: Array<{ name?: string; identifier?: Array<{ system?: string; value?: string }> }>;
}) {
  const ticketOrigin = input.issuer ?? origin;
  return context.issuers.sign(ticketOrigin, context.config.defaultPermissionTicketIssuerSlug, {
    iss: `${ticketOrigin}/issuer/${context.config.defaultPermissionTicketIssuerSlug}`,
    sub: "mode-test-ticket",
    aud: ticketOrigin,
    exp: Math.floor(Date.now() / 1000) + 3600,
    ticket_type: "urn:demo:ticket",
    cnf: input.cnf,
    authorization: {
      subject: input.subject,
      access: {
        scopes: input.scopes,
        periods: input.periods,
        jurisdictions: input.jurisdictions,
        organizations: input.organizations,
      },
    },
    details: {
      sensitive: { mode: input.sensitiveMode },
    },
  });
}

async function issueOpenToken(
  scopes: string[],
  sensitiveMode: "deny" | "allow" = "deny",
  periods: Array<{ start?: string; end?: string }> = [{ start: "2023-01-01", end: "2025-12-31" }],
  siteSlug?: string,
) {
  const prefix = siteSlug ? `${origin}/modes/open/sites/${siteSlug}` : `${origin}/modes/open`;
  return postFormJson(`${prefix}/token`, {
    grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
    subject_token_type: "https://smarthealthit.org/token-type/permission-ticket",
    subject_token: mintTicket({
      subject: elenaMatchSubject(),
      scopes,
      periods,
      sensitiveMode,
    }),
  });
}

async function issueStrictToken(
  client: DemoClient,
  scopes: string[],
  sensitiveMode: "deny" | "allow" = "deny",
  periods: Array<{ start?: string; end?: string }> = [{ start: "2023-01-01", end: "2025-12-31" }],
) {
  return postFormJsonWithClient(`${origin}/token`, {
    grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
    subject_token_type: "https://smarthealthit.org/token-type/permission-ticket",
    subject_token: mintTicket({
      subject: elenaMatchSubject(),
      scopes,
      periods,
      sensitiveMode,
      cnf: { jkt: client.jwkThumbprint },
    }),
  }, client);
}

async function getJson(url: string, accessToken: string, proofJkt?: string) {
  const response = await fetch(url, {
    headers: {
      authorization: `Bearer ${accessToken}`,
      ...(proofJkt ? { "x-client-jkt": proofJkt } : {}),
    },
  });
  expect(response.status).toBe(200);
  return response.json();
}

async function postJson(url: string, body: Record<string, any>) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  expect(response.status).toBe(201);
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
  expect(response.status).toBe(200);
  return response.json();
}

async function postFormJson(url: string, body: Record<string, string>) {
  const response = await postForm(url, body);
  expect(response.status).toBe(200);
  return response.json();
}

async function postForm(url: string, body: Record<string, string>) {
  return fetch(url, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(body),
  });
}

async function registerDynamicClient(url: string, clientName: string): Promise<DemoClient> {
  const keyMaterial = await generateClientKeyMaterial();
  const registration = await postJson(url, {
    client_name: clientName,
    token_endpoint_auth_method: "private_key_jwt",
    jwk: keyMaterial.publicJwk,
  });
  expect(typeof registration.client_id).toBe("string");
  return {
    clientId: registration.client_id,
    clientName: registration.client_name ?? clientName,
    publicJwk: keyMaterial.publicJwk,
    privateJwk: keyMaterial.privateJwk,
    jwkThumbprint: keyMaterial.thumbprint,
  };
}

async function postFormJsonWithClient(
  url: string,
  body: Record<string, string>,
  client: DemoClient,
  options?: { assertionClientId?: string; signingPrivateJwk?: JsonWebKey; proofJkt?: string },
) {
  const response = await postFormWithClient(url, body, client, options);
  expect(response.status).toBe(200);
  return response.json();
}

async function postFormWithClient(
  url: string,
  body: Record<string, string>,
  client: DemoClient,
  options?: { assertionClientId?: string; signingPrivateJwk?: JsonWebKey; proofJkt?: string },
) {
  const assertionClientId = options?.assertionClientId ?? client.clientId;
  const signingPrivateJwk = options?.signingPrivateJwk ?? client.privateJwk;
  const clientAssertion = await signPrivateKeyJwt(
    {
      iss: assertionClientId,
      sub: assertionClientId,
      aud: url,
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 300,
      jti: crypto.randomUUID(),
    },
    signingPrivateJwk,
  );
  return fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      ...(options?.proofJkt ? { "x-client-jkt": options.proofJkt } : {}),
    },
    body: new URLSearchParams({
      ...body,
      client_id: assertionClientId,
      client_assertion_type: "urn:ietf:params:oauth:client-assertion-type:jwt-bearer",
      client_assertion: clientAssertion,
    }),
  });
}

function decodeJwtClaims(jwt: string) {
  const [, payload] = jwt.split(".", 3);
  if (!payload) throw new Error("Invalid JWT");
  return JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
}
