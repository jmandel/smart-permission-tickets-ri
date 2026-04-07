import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { X509Certificate } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";

import { generateClientKeyMaterial, signPrivateKeyJwt } from "../shared/private-key-jwt.ts";
import {
  PATIENT_SELF_ACCESS_TICKET_TYPE,
  PERMISSION_TICKET_SUBJECT_TOKEN_TYPE,
  PUBLIC_HEALTH_INVESTIGATION_TICKET_TYPE,
} from "../shared/permission-tickets.ts";
import {
  buildDefaultFrameworks,
  buildDemoUdapClients,
  DEFAULT_DEMO_UDAP_FRAMEWORK_URI,
  DEFAULT_DEMO_UDAP_RSA_CA_ID,
  DEFAULT_DEMO_UDAP_RSA_CLIENT_PATH,
  DEFAULT_DEMO_UDAP_RSA_TRUST_ANCHOR_PEM,
  DEFAULT_DEMO_WELL_KNOWN_FRAMEWORK_URI,
} from "../src/auth/demo-frameworks.ts";
import { buildUdapCrlUrl } from "../src/auth/udap-crl.ts";
import { decodeEs256Jwt, signEs256Jwt } from "../src/auth/es256-jwt.ts";
import { parseX5cCertificates, pemToDerBase64, signRs256JwtWithPem, verifyX509JwtWithKey } from "../src/auth/x509-jwt.ts";
import { createAppContext, handleRequest, startServer } from "../src/app.ts";

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
  context.config.publicBaseUrl = origin;
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
    expect(Array.isArray(body.demoClientOptions)).toBe(true);
    expect(body.demoClientOptions.map((option: any) => option.type)).toEqual(["unaffiliated", "well-known", "udap"]);
    expect(body.demoClientOptions.find((option: any) => option.type === "well-known")?.entityUri).toBe(`${origin}/demo/clients/well-known-alpha`);
    expect(body.demoClientOptions.find((option: any) => option.type === "udap")?.entityUri).toBe(`${origin}${DEFAULT_DEMO_UDAP_RSA_CLIENT_PATH}`);
  });

  test("configured public base URL drives advertised endpoints instead of request origin", async () => {
    const previousPublicBaseUrl = context.config.publicBaseUrl;
    const previousIssuer = context.config.issuer;
    context.config.publicBaseUrl = "https://tickets.example.test";
    context.config.issuer = "https://tickets.example.test";
    try {
      const bootstrapResponse = await handleRequest(context, new Request(`${origin}/demo/bootstrap`));
      expect(bootstrapResponse.status).toBe(200);
      const bootstrapBody = await bootstrapResponse.json();
      expect(bootstrapBody.defaultTicketIssuer.issuerBaseUrl).toBe("https://tickets.example.test/issuer/reference-demo");

      const smartConfigResponse = await handleRequest(
        context,
        new Request(`${origin}/networks/reference/fhir/.well-known/smart-configuration`),
      );
      expect(smartConfigResponse.status).toBe(200);
      const smartConfig = await smartConfigResponse.json();
      expect(smartConfig.token_endpoint).toBe("https://tickets.example.test/networks/reference/token");
      expect(smartConfig.fhir_base_url).toBe("https://tickets.example.test/networks/reference/fhir");
    } finally {
      context.config.publicBaseUrl = previousPublicBaseUrl;
      context.config.issuer = previousIssuer;
    }
  });

  test("public-facing metadata and demo client surfaces honor configured public origin end to end", async () => {
    const publicOrigin = "https://tickets.example.test";
    const publicContext = createAppContext({
      publicBaseUrl: publicOrigin,
      issuer: publicOrigin,
      frameworks: buildDefaultFrameworks(publicOrigin, "reference-demo"),
    });
    const publicServer = startServer(publicContext, 0);
    const localOrigin = `http://127.0.0.1:${publicServer.port}`;
    const assertPublicOnly = (body: unknown) => {
      const serialized = JSON.stringify(body);
      expect(serialized).toContain(publicOrigin);
      expect(serialized).not.toContain(localOrigin);
      expect(serialized).not.toContain("localhost");
    };
    try {
      const bootstrap = await fetch(`${localOrigin}/demo/bootstrap`).then((response) => response.json());
      assertPublicOnly(bootstrap);
      expect(bootstrap.defaultTicketIssuer.issuerBaseUrl).toBe(`${publicOrigin}/issuer/reference-demo`);
      expect(bootstrap.demoClientOptions.find((option: any) => option.type === "well-known")?.entityUri).toBe(`${publicOrigin}/demo/clients/well-known-alpha`);
      expect(bootstrap.demoClientOptions.find((option: any) => option.type === "udap")?.entityUri).toBe(`${publicOrigin}${DEFAULT_DEMO_UDAP_RSA_CLIENT_PATH}`);

      const frameworkDoc = await fetch(`${localOrigin}/demo/frameworks/well-known-reference.json`).then((response) => response.json());
      assertPublicOnly(frameworkDoc);
      expect(frameworkDoc.clients[0].entityUri).toBe(`${publicOrigin}/demo/clients/well-known-alpha`);

      const wellKnownClient = await fetch(`${localOrigin}/demo/clients/well-known-alpha`).then((response) => response.json());
      assertPublicOnly(wellKnownClient);
      expect(wellKnownClient.jwks_url).toBe(`${publicOrigin}/demo/clients/well-known-alpha/.well-known/jwks.json`);

      const udapClient = await fetch(`${localOrigin}${DEFAULT_DEMO_UDAP_RSA_CLIENT_PATH}`).then((response) => response.json());
      assertPublicOnly(udapClient);
      expect(udapClient.entity_uri).toBe(`${publicOrigin}${DEFAULT_DEMO_UDAP_RSA_CLIENT_PATH}`);
      expect(udapClient.certificate_san_uri).toBe(`${publicOrigin}${DEFAULT_DEMO_UDAP_RSA_CLIENT_PATH}`);

      const udapMetadata = await fetch(`${localOrigin}/fhir/.well-known/udap`).then((response) => response.json());
      assertPublicOnly(udapMetadata);
      expect(udapMetadata.registration_endpoint).toBe(`${publicOrigin}/register`);
      const udapPayload = JSON.parse(Buffer.from(String(udapMetadata.signed_metadata).split(".")[1] ?? "", "base64url").toString("utf8"));
      expect(udapPayload.iss).toBe(`${publicOrigin}/fhir`);

      const networkSmartConfig = await fetch(`${localOrigin}/networks/reference/fhir/.well-known/smart-configuration`).then((response) => response.json());
      assertPublicOnly(networkSmartConfig);
      expect(networkSmartConfig.token_endpoint).toBe(`${publicOrigin}/networks/reference/token`);
      expect(networkSmartConfig.fhir_base_url).toBe(`${publicOrigin}/networks/reference/fhir`);

      const issuerMetadata = await fetch(`${localOrigin}/issuer/reference-demo`).then((response) => response.json());
      assertPublicOnly(issuerMetadata);
      expect(issuerMetadata.issuer).toBe(`${publicOrigin}/issuer/reference-demo`);
      expect(issuerMetadata.sign_ticket_endpoint).toBe(`${publicOrigin}/issuer/reference-demo/sign-ticket`);

      const signResponse = await fetch(`${localOrigin}/issuer/reference-demo/sign-ticket`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          iss: `${publicOrigin}/issuer/reference-demo`,
          aud: publicOrigin,
          exp: Math.floor(Date.now() / 1000) + 3600,
          jti: crypto.randomUUID(),
          ticket_type: PATIENT_SELF_ACCESS_TICKET_TYPE,
          presenter_binding: { method: "jkt", jkt: "public-origin-test-jkt" },
          subject: {
            patient: elenaPatient(),
          },
          access: {
            permissions: [{
              kind: "data",
              resource_type: "Patient",
              interactions: ["read"],
            }],
          },
        }),
      });
      expect(signResponse.status).toBe(201);
      const signedTicketBody = await signResponse.json();
      assertPublicOnly(signedTicketBody);
      expect(signedTicketBody.issuer).toBe(`${publicOrigin}/issuer/reference-demo`);
      expect(signedTicketBody.jwks_uri).toBe(`${publicOrigin}/issuer/reference-demo/.well-known/jwks.json`);
      const signedTicket = decodeEs256Jwt<any>(signedTicketBody.signed_ticket);
      expect(signedTicket.payload.iss).toBe(`${publicOrigin}/issuer/reference-demo`);
      expect(signedTicket.payload.aud).toBe(publicOrigin);
    } finally {
      publicServer.stop(true);
    }
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
        iss: `${origin}/issuer/reference-demo`,
        aud: origin,
        exp: Math.floor(Date.now() / 1000) + 3600,
        jti: crypto.randomUUID(),
        ticket_type: PATIENT_SELF_ACCESS_TICKET_TYPE,
        presenter_binding: { method: "jkt", jkt: "sign-ticket-test-jkt" },
        subject: {
          patient: elenaPatient(),
        },
        access: {
          permissions: [{
            kind: "data",
            resource_type: "Patient",
            interactions: ["read", "search"],
          }],
          data_period: { start: "2023-01-01", end: "2025-12-31" },
          sensitive_data: "exclude",
        },
      }),
    });
    expect(signResponse.status).toBe(201);
    const signed = await signResponse.json();
    const decoded = decodeEs256Jwt<any>(signed.signed_ticket);
    expect(decoded.header.alg).toBe("ES256");
    expect(decoded.header.kid).toBe(jwks.keys[0].kid);
    expect(decoded.payload.iss).toBe(`${origin}/issuer/reference-demo`);
    expect(typeof decoded.payload.exp).toBe("number");
  });

  test("issuer sign-ticket rejects missing exp", async () => {
    const signResponse = await fetch(`${origin}/issuer/reference-demo/sign-ticket`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        iss: `${origin}/issuer/reference-demo`,
        aud: origin,
        jti: crypto.randomUUID(),
        ticket_type: PATIENT_SELF_ACCESS_TICKET_TYPE,
        presenter_binding: { method: "jkt", jkt: "missing-exp-test-jkt" },
        subject: {
          patient: elenaPatient(),
        },
        access: {
          permissions: [{
            kind: "data",
            resource_type: "Patient",
            interactions: ["read", "search"],
          }],
        },
      }),
    });
    expect(signResponse.status).toBe(400);
    const body = await signResponse.json();
    expect(body.issue?.[0]?.diagnostics ?? "").toContain("exp");
  });

  test("default config advertises built-in framework metadata and demo jwks surfaces", async () => {
    const smartConfigResponse = await fetch(`${origin}/.well-known/smart-configuration`);
    expect(smartConfigResponse.status).toBe(200);
    expect(smartConfigResponse.headers.get("cache-control")).toBe("public, max-age=300");
    const smartConfig = await smartConfigResponse.json();
    const extension = smartConfig.extensions["https://smarthealthit.org/smart-permission-tickets/smart-configuration"];
    expect(smartConfig.grant_types_supported).toContain("client_credentials");
    expect(smartConfig.grant_types_supported).toContain("urn:ietf:params:oauth:grant-type:token-exchange");
    expect(extension.supported_client_binding_types).toContain("framework_client");
    expect(extension.supported_client_binding_types).toContain("jkt");
    expect(extension.supported_trust_frameworks).toEqual([
      {
        framework: "https://smarthealthit.org/trust-frameworks/reference-demo-well-known",
        framework_type: "well-known",
      },
      {
        framework: "https://smarthealthit.org/trust-frameworks/reference-demo-udap",
        framework_type: "udap",
      },
    ]);

    const jwksResponse = await fetch(`${origin}/.well-known/jwks.json`);
    expect(jwksResponse.status).toBe(200);
    const jwks = await jwksResponse.json();
    expect(Array.isArray(jwks.keys)).toBe(true);
    expect(jwks.keys[0].kid).toBeTruthy();

    const frameworkResponse = await fetch(`${origin}/demo/frameworks/well-known-reference.json`);
    expect(frameworkResponse.status).toBe(200);
    const frameworkBody = await frameworkResponse.json();
    expect(frameworkBody.framework).toBe("https://smarthealthit.org/trust-frameworks/reference-demo-well-known");
    expect(Array.isArray(frameworkBody.clients)).toBe(true);
    expect(frameworkBody.clients).toHaveLength(2);
    expect(frameworkBody.clients[0].entityUri).toBe(`${origin}/demo/clients/well-known-alpha`);

    const entityResponse = await fetch(`${origin}/demo/clients/well-known-alpha`);
    expect(entityResponse.status).toBe(200);
    const entityBody = await entityResponse.json();
    expect(entityBody.jwks_url).toBe(`${origin}/demo/clients/well-known-alpha/.well-known/jwks.json`);

    const entityJwksResponse = await fetch(`${origin}/demo/clients/well-known-alpha/.well-known/jwks.json`);
    expect(entityJwksResponse.status).toBe(200);
    const entityJwks = await entityJwksResponse.json();
    expect(Array.isArray(entityJwks.keys)).toBe(true);
    expect(entityJwks.keys[0].kid).toBeTruthy();

    const udapEntityResponse = await fetch(`${origin}${DEFAULT_DEMO_UDAP_RSA_CLIENT_PATH}`);
    expect(udapEntityResponse.status).toBe(200);
    const udapEntity = await udapEntityResponse.json();
    expect(udapEntity.entity_uri).toBe(`${origin}${DEFAULT_DEMO_UDAP_RSA_CLIENT_PATH}`);
    expect(udapEntity.certificate_san_uri).toBe(`${origin}${DEFAULT_DEMO_UDAP_RSA_CLIENT_PATH}`);
    expect(Array.isArray(udapEntity.certificate_chain_pem)).toBe(true);
    expect(String(udapEntity.note)).toContain("Subject Alternative Name");

    const udapResponse = await fetch(`${origin}/fhir/.well-known/udap`);
    expect(udapResponse.status).toBe(200);
    expect(udapResponse.headers.get("cache-control")).toBe("public, max-age=300");
    const udap = await udapResponse.json();
    expect(udap.community).toBe("https://smarthealthit.org/trust-frameworks/reference-demo-udap");
    expect(udap.udap_profiles_supported).toContain("udap_authz");
    expect(udap.udap_authorization_extensions_supported).toContain("hl7-b2b");
    expect(udap.udap_authorization_extensions_required).toEqual(["hl7-b2b"]);
    expect(udap.grant_types_supported).toContain("client_credentials");
    expect(udap.registration_endpoint).toBe(`${origin}/register`);
    expect(udap.token_endpoint_auth_signing_alg_values_supported).toContain("RS256");
    expect(typeof udap.signed_metadata).toBe("string");

    const [encodedHeader] = udap.signed_metadata.split(".", 1);
    const header = JSON.parse(Buffer.from(encodedHeader, "base64url").toString("utf8")) as { x5c?: string[] };
    const certificates = parseX5cCertificates(header.x5c);
    expect(certificates).toHaveLength(2);
    const expectedCrlUrl = buildUdapCrlUrl(origin, DEFAULT_DEMO_UDAP_FRAMEWORK_URI, DEFAULT_DEMO_UDAP_RSA_CA_ID);
    const certificateText = describeDerCertificate(certificates[0].raw);
    expect(certificateText).toContain(expectedCrlUrl);
    const trustAnchor = new X509Certificate(DEFAULT_DEMO_UDAP_RSA_TRUST_ANCHOR_PEM);
    expect(certificates[1].raw.equals(trustAnchor.raw)).toBe(true);
    expect(certificates[0].checkIssued(certificates[1]) && certificates[0].verify(certificates[1].publicKey)).toBe(true);
    const { payload } = verifyX509JwtWithKey<Record<string, any>>(udap.signed_metadata, certificates[0].publicKey);
    expect(payload.iss).toBe(`${origin}/fhir`);

    const crlResponse = await fetch(expectedCrlUrl);
    expect(crlResponse.status).toBe(200);
    expect(crlResponse.headers.get("content-type")).toContain("application/pkix-crl");
    const crlText = describeDerCrl(new Uint8Array(await crlResponse.arrayBuffer()));
    expect(crlText).toContain("Issuer: CN=UDAP RSA Root");
  });

  test("default config accepts built-in RS256 UDAP registrations", async () => {
    const rsaClient = buildDemoUdapClients(origin).find((entry) => entry.algorithm === "RS256");
    expect(rsaClient).toBeTruthy();
    const now = Math.floor(Date.now() / 1000);
    const softwareStatement = signRs256JwtWithPem(
      {
        iss: rsaClient!.entityUri,
        sub: rsaClient!.entityUri,
        aud: `${origin}/register`,
        iat: now,
        exp: now + 300,
        jti: crypto.randomUUID(),
        client_name: "Reference Demo RSA UDAP Client",
        grant_types: ["client_credentials"],
        token_endpoint_auth_method: "private_key_jwt",
        scope: "system/Patient.rs",
      },
      rsaClient!.privateKeyPem,
      {
        x5c: [pemToDerBase64(rsaClient!.certificatePem)],
      },
    );
    const response = await fetch(`${origin}/register`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        udap: "1",
        software_statement: softwareStatement,
      }),
    });
    expect(response.status).toBe(201);
    const body = await response.json();
    expect(String(body.client_id)).toStartWith("udap:");
    expect(body.client_name).toBe("Reference Demo RSA UDAP Client");
  });

  test("network token exchange and record-location resolution return only authorized visible sites", async () => {
    const configResponse = await fetch(`${origin}/networks/reference/fhir/.well-known/smart-configuration`);
    expect(configResponse.status).toBe(200);
    const config = await configResponse.json();
    expect(config.token_endpoint).toBe(`${origin}/networks/reference/token`);
    expect(config.fhir_base_url).toBe(`${origin}/networks/reference/fhir`);
    expect(config.smart_permission_ticket_types_supported).toContain(PATIENT_SELF_ACCESS_TICKET_TYPE);
    expect(config.mode).toBeUndefined();
    expect(config.capabilities).toBeUndefined();

    const client = await registerDynamicClient(`${origin}/networks/reference/register`, "Network RLS Client");
    const token = await postFormJsonWithClient(`${origin}/networks/reference/token`, {
      grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
      subject_token_type: "https://smarthealthit.org/token-type/permission-ticket",
      subject_token: mintTicket({
        aud: `${origin}/networks/reference/fhir`,
        subject: elenaPatient(),
        scopes: ["patient/*.rs"],
        periods: [{ start: "2021-01-01", end: "2025-12-31" }],
        sensitiveMode: "deny",
        presenterBinding: { method: "jkt", jkt: client.jwkThumbprint },
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
    expect(typeof endpoints[0]?.resource?.address).toBe("string");
    expect(endpoints[0]?.resource?.extension).toBeUndefined();
  });

  test("configured framework audiences are accepted when this server is a local member", async () => {
    const response = await postForm(`${origin}/modes/open/token`, {
      grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
      subject_token_type: PERMISSION_TICKET_SUBJECT_TOKEN_TYPE,
      subject_token: mintTicket({
        aud: DEFAULT_DEMO_WELL_KNOWN_FRAMEWORK_URI,
        subject: elenaPatient(),
        scopes: ["patient/Patient.rs"],
        periods: [{ start: "2023-01-01", end: "2025-12-31" }],
        sensitiveMode: "deny",
      }),
    });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(typeof body.access_token).toBe("string");
  });

  test("unknown framework audiences are rejected", async () => {
    await expectTokenError(
      await postForm(`${origin}/modes/open/token`, {
        grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
        subject_token_type: PERMISSION_TICKET_SUBJECT_TOKEN_TYPE,
        subject_token: mintTicket({
          aud: "https://example.org/frameworks/not-a-member",
          subject: elenaPatient(),
          scopes: ["patient/Patient.rs"],
          periods: [{ start: "2023-01-01", end: "2025-12-31" }],
          sensitiveMode: "deny",
        }),
      }),
      "invalid_grant",
      "Permission Ticket audience mismatch",
    );
  });

  test("strict token exchange rejects anonymous clients", async () => {
    const response = await postForm(`${origin}/token`, {
      grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
      subject_token_type: PERMISSION_TICKET_SUBJECT_TOKEN_TYPE,
      subject_token: mintTicket({
        subject: elenaPatient(),
        scopes: ["patient/Patient.rs"],
        periods: [{ start: "2023-01-01", end: "2025-12-31" }],
        sensitiveMode: "deny",
      }),
    });
    await expectTokenError(response, "invalid_client", "Authenticated key-based client assertion required", 401);
  });

  test("strict token exchange rejects wrong-bound client assertions", async () => {
    const registeredClient = await registerDynamicClient(`${origin}/register`, "Strict Bound Client");
    const wrongKeyClient = await registerDynamicClient(`${origin}/register`, "Strict Wrong Key Client");
    const ticket = mintTicket({
      subject: elenaPatient(),
      scopes: ["patient/Patient.rs"],
      periods: [{ start: "2023-01-01", end: "2025-12-31" }],
      sensitiveMode: "deny",
      presenterBinding: { method: "jkt", jkt: registeredClient.jwkThumbprint },
    });

    const wrongAssertion = await postFormWithClient(
      `${origin}/token`,
      {
        grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
        subject_token_type: PERMISSION_TICKET_SUBJECT_TOKEN_TYPE,
        subject_token: ticket,
      },
      wrongKeyClient,
      { assertionClientId: registeredClient.clientId },
    );
    await expectTokenError(wrongAssertion, "invalid_client", "Invalid client assertion signature", 401);

    const mismatchedBinding = await postFormWithClient(
      `${origin}/token`,
      {
        grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
        subject_token_type: PERMISSION_TICKET_SUBJECT_TOKEN_TYPE,
        subject_token: ticket,
      },
      wrongKeyClient,
    );
    await expectTokenError(mismatchedBinding, "invalid_grant", "Ticket not bound to client key", 400);
  });

  test("ticket validation rejects non-ES256 algorithms, kid mismatches, and bad signatures", async () => {
    const validTicket = mintTicket({
      subject: elenaPatient(),
      scopes: ["patient/Patient.rs"],
      periods: [{ start: "2023-01-01", end: "2025-12-31" }],
      sensitiveMode: "deny",
    });

    const nonEs256Ticket = rewriteJwtHeader(validTicket, { alg: "RS256" });
    await expectTokenError(
      await postForm(`${origin}/modes/open/token`, {
        grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
        subject_token_type: PERMISSION_TICKET_SUBJECT_TOKEN_TYPE,
        subject_token: nonEs256Ticket,
      }),
      "invalid_grant",
      "must be signed with ES256",
    );

    const wrongKidTicket = rewriteJwtHeader(validTicket, { kid: "missing-ticket-key" });
    await expectTokenError(
      await postForm(`${origin}/modes/open/token`, {
        grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
        subject_token_type: PERMISSION_TICKET_SUBJECT_TOKEN_TYPE,
        subject_token: wrongKidTicket,
      }),
      "invalid_grant",
      "kid mismatch",
    );

    const badSignatureTicket = corruptJwtSignature(validTicket);
    await expectTokenError(
      await postForm(`${origin}/modes/open/token`, {
        grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
        subject_token_type: PERMISSION_TICKET_SUBJECT_TOKEN_TYPE,
        subject_token: badSignatureTicket,
      }),
      "invalid_grant",
      "Invalid JWT signature",
    );
  });

  test("client assertion rejects audience mismatch and future iat", async () => {
    const client = await registerDynamicClient(`${origin}/register`, "Assertion Edge Client");
    const ticket = mintTicket({
      subject: elenaPatient(),
      scopes: ["patient/Patient.rs"],
      periods: [{ start: "2023-01-01", end: "2025-12-31" }],
      sensitiveMode: "deny",
    });

    const wrongAudience = await postFormWithClient(
      `${origin}/token`,
      {
        grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
        subject_token_type: PERMISSION_TICKET_SUBJECT_TOKEN_TYPE,
        subject_token: ticket,
      },
      client,
      { assertionAud: `${origin}/wrong-token-endpoint` },
    );
    await expectTokenError(wrongAudience, "invalid_client", "audience mismatch", 401);

    const futureIssuedAt = await postFormWithClient(
      `${origin}/token`,
      {
        grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
        subject_token_type: PERMISSION_TICKET_SUBJECT_TOKEN_TYPE,
        subject_token: ticket,
      },
      client,
      { assertionIat: Math.floor(Date.now() / 1000) + 120 },
    );
    await expectTokenError(futureIssuedAt, "invalid_client", "issued in the future", 401);
  });

  test("open token exchange allows anonymous clients", async () => {
    const body = await postFormJson(`${origin}/modes/open/token`, {
      grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
      subject_token_type: "https://smarthealthit.org/token-type/permission-ticket",
      subject_token: mintTicket({
        subject: elenaPatient(),
        scopes: ["patient/Patient.rs"],
        periods: [{ start: "2023-01-01", end: "2025-12-31" }],
        sensitiveMode: "deny",
      }),
    });
    expect(typeof body.access_token).toBe("string");
    expect(typeof body.patient).toBe("string");
  });

  test("subject resolution rejects zero-match and ambiguous patient subjects", async () => {
    const zeroMatch = await postForm(`${origin}/modes/open/token`, {
      grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
      subject_token_type: PERMISSION_TICKET_SUBJECT_TOKEN_TYPE,
      subject_token: mintTicket({
        subject: {
          type: "match",
          traits: {
            resourceType: "Patient",
            name: [{ family: "NotARealFamily", given: ["Nobody"] }],
            birthDate: "1900-01-01",
          },
        },
        scopes: ["patient/Patient.rs"],
        periods: [{ start: "2023-01-01", end: "2025-12-31" }],
        sensitiveMode: "deny",
      }),
    });
    await expectTokenError(zeroMatch, "invalid_grant", "No patient matched the ticket subject");

    const ambiguous = await postForm(`${origin}/modes/open/token`, {
      grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
      subject_token_type: PERMISSION_TICKET_SUBJECT_TOKEN_TYPE,
      subject_token: mintTicket({
        subject: {
          type: "match",
          traits: {
            resourceType: "Patient",
            name: [{ given: ["James"] }],
          },
        },
        scopes: ["patient/Patient.rs"],
        periods: [{ start: "2023-01-01", end: "2025-12-31" }],
        sensitiveMode: "deny",
      }),
    });
    await expectTokenError(ambiguous, "invalid_grant", "matched more than one patient");
  });

  test("subject payload must satisfy the new subject schema", async () => {
    const inconsistentMatch = await postForm(`${origin}/modes/open/token`, {
      grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
      subject_token_type: PERMISSION_TICKET_SUBJECT_TOKEN_TYPE,
      subject_token: context.issuers.sign(origin, context.config.defaultPermissionTicketIssuerSlug, {
        iss: `${origin}/issuer/${context.config.defaultPermissionTicketIssuerSlug}`,
        aud: origin,
        exp: Math.floor(Date.now() / 1000) + 3600,
        jti: crypto.randomUUID(),
        ticket_type: PUBLIC_HEALTH_INVESTIGATION_TICKET_TYPE,
        requester: defaultRequester(PUBLIC_HEALTH_INVESTIGATION_TICKET_TYPE),
        access: {
          permissions: projectScopesToPermissions(["patient/Patient.rs"]),
          data_period: { start: "2023-01-01", end: "2025-12-31" },
          sensitive_data: "exclude",
        },
        context: defaultContext(PUBLIC_HEALTH_INVESTIGATION_TICKET_TYPE),
        subject: {
          recipient_record: { reference: "Patient/123", type: "Patient" },
        },
      } as any),
    });
    await expectTokenError(inconsistentMatch, "invalid_grant", "expected object");

    const inconsistentReference = await postForm(`${origin}/modes/open/token`, {
      grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
      subject_token_type: PERMISSION_TICKET_SUBJECT_TOKEN_TYPE,
      subject_token: context.issuers.sign(origin, context.config.defaultPermissionTicketIssuerSlug, {
        iss: `${origin}/issuer/${context.config.defaultPermissionTicketIssuerSlug}`,
        aud: origin,
        exp: Math.floor(Date.now() / 1000) + 3600,
        jti: crypto.randomUUID(),
        ticket_type: PUBLIC_HEALTH_INVESTIGATION_TICKET_TYPE,
        requester: defaultRequester(PUBLIC_HEALTH_INVESTIGATION_TICKET_TYPE),
        access: {
          permissions: projectScopesToPermissions(["patient/Patient.rs"]),
          data_period: { start: "2023-01-01", end: "2025-12-31" },
          sensitive_data: "exclude",
        },
        context: defaultContext(PUBLIC_HEALTH_INVESTIGATION_TICKET_TYPE),
        subject: "not-an-object",
      } as any),
    });
    await expectTokenError(inconsistentReference, "invalid_grant", "expected object");
  });

  test("must_understand rejects unrecognized top-level claims", async () => {
    const response = await postForm(`${origin}/modes/open/token`, {
      grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
      subject_token_type: PERMISSION_TICKET_SUBJECT_TOKEN_TYPE,
      subject_token: context.issuers.sign(origin, context.config.defaultPermissionTicketIssuerSlug, {
        iss: `${origin}/issuer/${context.config.defaultPermissionTicketIssuerSlug}`,
        aud: origin,
        exp: Math.floor(Date.now() / 1000) + 3600,
        jti: crypto.randomUUID(),
        ticket_type: PUBLIC_HEALTH_INVESTIGATION_TICKET_TYPE,
        requester: defaultRequester(PUBLIC_HEALTH_INVESTIGATION_TICKET_TYPE),
        must_understand: ["experimental_constraint"],
        experimental_constraint: { foo: true },
        subject: { patient: elenaPatient() },
        access: {
          permissions: projectScopesToPermissions(["patient/Patient.rs"]),
          data_period: { start: "2023-01-01", end: "2025-12-31" },
          sensitive_data: "exclude",
        },
        context: defaultContext(PUBLIC_HEALTH_INVESTIGATION_TICKET_TYPE),
      } as any),
    });
    await expectTokenError(response, "invalid_grant", "Unrecognized must_understand claim: experimental_constraint");
  });

  test("site-specific SMART config advertises site-bound auth endpoints", async () => {
    const config = await fetch(`${origin}/modes/open/sites/lone-star-womens-health/fhir/.well-known/smart-configuration`);
    expect(config.status).toBe(200);
    expect(config.headers.get("cache-control")).toBe("public, max-age=300");
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
        subject: elenaPatient(),
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
        subject: elenaPatient(),
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
        subject: elenaPatient(),
        scopes: ["patient/Encounter.rs"],
        periods: [{ start: "2022-01-01", end: "2025-12-31" }],
        sensitiveMode: "allow",
        responderFilter: [
          {
            kind: "organization",
            organization: {
              resourceType: "Organization",
              identifier: [{ system: "http://hl7.org/fhir/sid/us-npi", value: "1902847536" }],
            },
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
        subject: elenaPatient(),
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
        subject: elenaPatient(),
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
    const client = await registerDynamicClient(`${origin}/modes/registered/register`, "Registered Mode Test Client");
    const tokenBody = await postFormJsonWithClient(`${origin}/modes/registered/token`, {
      grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
      subject_token_type: "https://smarthealthit.org/token-type/permission-ticket",
      subject_token: mintTicket({
        subject: elenaPatient(),
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
    const client = await registerDynamicClient(`${origin}/modes/registered/register`, "Restart Safe Client");

    const restartedContext = createAppContext({ port: 0 });
    restartedContext.config.publicBaseUrl = origin;
    restartedContext.config.issuer = origin;
    const now = Math.floor(Date.now() / 1000);
    const clientAssertion = await signPrivateKeyJwt(
      {
        iss: client.clientId,
        sub: client.clientId,
        aud: `${origin}/modes/registered/token`,
        iat: now,
        exp: now + 300,
        jti: crypto.randomUUID(),
      },
      client.privateJwk,
    );

    const tokenResponse = await handleRequest(
      restartedContext,
      new Request(`${origin}/modes/registered/token`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
          subject_token_type: "https://smarthealthit.org/token-type/permission-ticket",
          subject_token: mintTicket({
            issuer: origin,
            subject: elenaPatient(),
            scopes: ["patient/Patient.rs"],
            periods: [{ start: "2023-01-01", end: "2025-12-31" }],
            sensitiveMode: "deny",
          }),
          client_id: client.clientId,
          client_assertion_type: "urn:ietf:params:oauth:client-assertion-type:jwt-bearer",
          client_assertion: clientAssertion,
        }),
      }),
    );
    expect(tokenResponse.status).toBe(200);
    const tokenBody = await tokenResponse.json();
    expect(typeof tokenBody.access_token).toBe("string");

    const patientResponse = await handleRequest(
      restartedContext,
      new Request(`${origin}/modes/registered/fhir/Patient/${tokenBody.patient}`, {
        headers: { authorization: `Bearer ${tokenBody.access_token}` },
      }),
    );
    expect(patientResponse.status).toBe(200);
    const patient = await patientResponse.json();
    expect(patient.resourceType).toBe("Patient");
  });

  test("key-bound mode requires matching presenter binding for key-bound tickets", async () => {
    const boundClient = await registerDynamicClient(`${origin}/modes/key-bound/register`, "Key Bound Test Client");
    const wrongClient = await registerDynamicClient(`${origin}/modes/key-bound/register`, "Wrong Key Test Client");
    const ticket = mintTicket({
      subject: elenaPatient(),
      scopes: ["patient/Patient.rs"],
      periods: [{ start: "2023-01-01", end: "2025-12-31" }],
      sensitiveMode: "deny",
      presenterBinding: { method: "jkt", jkt: boundClient.jwkThumbprint },
    });

    const missingProof = await postForm(`${origin}/modes/key-bound/token`, {
      grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
      subject_token_type: PERMISSION_TICKET_SUBJECT_TOKEN_TYPE,
      subject_token: ticket,
    });
    await expectTokenError(missingProof, "invalid_client", "client assertion", 401);

    const wrongProof = await postFormWithClient(`${origin}/modes/key-bound/token`, {
        grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
        subject_token_type: PERMISSION_TICKET_SUBJECT_TOKEN_TYPE,
        subject_token: ticket,
      }, wrongClient, { assertionClientId: boundClient.clientId });
    await expectTokenError(wrongProof, "invalid_client", "Invalid client assertion signature", 401);

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
        subject: elenaPatient(),
        scopes: ["patient/Patient.rs"],
        periods: [{ start: "2021-01-01", end: "2025-12-31" }],
        sensitiveMode: "allow",
        responderFilter: [
          { kind: "jurisdiction", address: { state: "CA" } },
          { kind: "jurisdiction", address: { state: "TX" } },
        ],
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
        subject: elenaPatient(),
        scopes: ["patient/Patient.rs", "patient/Encounter.rs"],
        periods: [{ start: "2021-01-01", end: "2025-12-31" }],
        sensitiveMode: "allow",
        responderFilter: [
          {
            kind: "organization",
            organization: {
              resourceType: "Organization",
              identifier: [{ system: "http://hl7.org/fhir/sid/us-npi", value: "1589043712" }],
            },
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
        subject: elenaPatient(),
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

  test("responder filters widen by union across organization and jurisdiction matches", async () => {
    const tokenBody = await postFormJson(`${origin}/modes/open/token`, {
      grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
      subject_token_type: "https://smarthealthit.org/token-type/permission-ticket",
      subject_token: mintTicket({
        subject: elenaPatient(),
        scopes: ["patient/Patient.rs"],
        periods: [{ start: "2021-01-01", end: "2025-12-31" }],
        sensitiveMode: "allow",
        responderFilter: [
          { kind: "jurisdiction", address: { state: "CA" } },
          {
            kind: "organization",
            organization: {
              resourceType: "Organization",
              identifier: [{ system: "http://hl7.org/fhir/sid/us-npi", value: "1589043712" }],
            },
          },
        ],
      }),
    });
    const bundle = await getJson(`${origin}/modes/open/fhir/Patient?_count=20`, tokenBody.access_token);
    expect(bundle.total).toBeGreaterThan(1);
  });

  test("site token issuance fails when the requested site is excluded by jurisdiction", async () => {
    const caOnlyTicket = mintTicket({
      subject: elenaPatient(),
      scopes: ["patient/Patient.rs", "patient/Encounter.rs"],
      periods: [{ start: "2021-01-01", end: "2025-12-31" }],
      sensitiveMode: "allow",
      responderFilter: [{ kind: "jurisdiction", address: { state: "CA" } }],
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
    await expectTokenError(rejected, "invalid_grant", "exclude the requested site");
  });

  test("site token issuance fails when the requested site is excluded by organization identifier", async () => {
    const loneStarOnlyTicket = mintTicket({
      subject: elenaPatient(),
      scopes: ["patient/Patient.rs", "patient/Encounter.rs"],
      periods: [{ start: "2021-01-01", end: "2025-12-31" }],
      sensitiveMode: "allow",
      responderFilter: [
        {
          kind: "organization",
          organization: {
            resourceType: "Organization",
            identifier: [{ system: "http://hl7.org/fhir/sid/us-npi", value: "1589043712" }],
          },
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
    await expectTokenError(rejected, "invalid_grant", "exclude the requested site");
  });

  test("site-registered clients cannot be reused at a different site token endpoint", async () => {
    const loneStarClient = await registerDynamicClient(
      `${origin}/modes/open/sites/lone-star-womens-health/register`,
      "Lone Star scoped client",
    );
    const ticket = mintTicket({
      subject: elenaPatient(),
      scopes: ["patient/Patient.rs", "patient/Encounter.rs"],
      periods: [{ start: "2021-01-01", end: "2025-12-31" }],
      sensitiveMode: "allow",
      presenterBinding: { method: "jkt", jkt: loneStarClient.jwkThumbprint },
    });

    const allowed = await postFormWithClient(
      `${origin}/modes/open/sites/lone-star-womens-health/token`,
      {
        grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
        subject_token_type: PERMISSION_TICKET_SUBJECT_TOKEN_TYPE,
        subject_token: ticket,
      },
      loneStarClient,
      { proofJkt: loneStarClient.jwkThumbprint },
    );
    expect(allowed.status).toBe(200);

    const rejected = await postFormWithClient(
      `${origin}/modes/open/sites/eastbay-primary-care-associates/token`,
      {
        grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
        subject_token_type: PERMISSION_TICKET_SUBJECT_TOKEN_TYPE,
        subject_token: ticket,
      },
      loneStarClient,
      { proofJkt: loneStarClient.jwkThumbprint },
    );
    await expectTokenError(rejected, "invalid_client", "scoped to a different auth surface", 401);
  });

  test("site token issuance fails when filters leave the requested site with only supporting context", async () => {
    const denySensitiveTicket = mintTicket({
      subject: elenaPatient(),
      scopes: ["patient/*.rs"],
      periods: [{ start: "2020-01-01", end: "2025-12-31" }],
      sensitiveMode: "deny",
    });

    const rejected = await postForm(`${origin}/modes/open/sites/lone-star-womens-health/token`, {
      grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
      subject_token_type: "https://smarthealthit.org/token-type/permission-ticket",
      subject_token: denySensitiveTicket,
    });
    await expectTokenError(rejected, "invalid_grant", "no visible encounters");

    const allowed = await postFormJson(`${origin}/modes/open/sites/lone-star-womens-health/token`, {
      grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
      subject_token_type: "https://smarthealthit.org/token-type/permission-ticket",
      subject_token: mintTicket({
        subject: elenaPatient(),
        scopes: ["patient/*.rs"],
        periods: [{ start: "2020-01-01", end: "2025-12-31" }],
        sensitiveMode: "allow",
      }),
    });
    expect(typeof allowed.access_token).toBe("string");
  });

  test("revocable tickets are accepted when the status list bit is clear", async () => {
    const revocationServer = startTicketRevocationServer({
      "/status.json": () => jsonResponse({
        kid: "issuer-key-1",
        bits: encodeStatusBits([]),
      }, 200, { "cache-control": "max-age=60" }),
    });
    const revocationUrl = `${revocationServer.origin}/status.json`;
    try {
      const tokenBody = await postFormJson(`${origin}/modes/open/token`, {
        grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
        subject_token_type: "https://smarthealthit.org/token-type/permission-ticket",
        subject_token: mintTicket({
          subject: elenaPatient(),
          scopes: ["patient/Patient.rs"],
          periods: [{ start: "2023-01-01", end: "2025-12-31" }],
          sensitiveMode: "deny",
          revocation: { url: revocationUrl, index: 7 },
        }),
      });
      expect(typeof tokenBody.access_token).toBe("string");
    } finally {
      revocationServer.stop(true);
    }
  });

  test("revoked tickets are rejected", async () => {
    const revocationServer = startTicketRevocationServer({
      "/status.json": () => jsonResponse({
        kid: "issuer-key-1",
        bits: encodeStatusBits([7]),
      }, 200, { "cache-control": "max-age=60" }),
    });
    const revocationUrl = `${revocationServer.origin}/status.json`;
    try {
      const response = await postForm(`${origin}/modes/open/token`, {
        grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
        subject_token_type: "https://smarthealthit.org/token-type/permission-ticket",
        subject_token: mintTicket({
          subject: elenaPatient(),
          scopes: ["patient/Patient.rs"],
          periods: [{ start: "2023-01-01", end: "2025-12-31" }],
          sensitiveMode: "deny",
          revocation: { url: revocationUrl, index: 7 },
        }),
      });
      await expectTokenError(response, "invalid_grant", "has been revoked");
    } finally {
      revocationServer.stop(true);
    }
  });

  test("revocable tickets without jti are rejected", async () => {
    const revocationServer = startTicketRevocationServer({
      "/status.json": () => jsonResponse({
        kid: "issuer-key-1",
        bits: encodeStatusBits([]),
      }),
    });
    const revocationUrl = `${revocationServer.origin}/status.json`;
    try {
      const response = await postForm(`${origin}/modes/open/token`, {
        grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
        subject_token_type: "https://smarthealthit.org/token-type/permission-ticket",
        subject_token: mintTicket({
          subject: elenaPatient(),
          scopes: ["patient/Patient.rs"],
          periods: [{ start: "2023-01-01", end: "2025-12-31" }],
          sensitiveMode: "deny",
          jti: null,
          revocation: { url: revocationUrl, index: 7 },
          rawSign: true,
        }),
      });
      await expectTokenError(response, "invalid_grant", "expected string");
    } finally {
      revocationServer.stop(true);
    }
  });

  test("revocable tickets fail closed when the CRL cannot be retrieved", async () => {
    const revocationServer = startTicketRevocationServer({
      "/status.json": () => jsonResponse({ error: "unavailable" }, 503),
    });
    const revocationUrl = `${revocationServer.origin}/status.json`;
    try {
      const response = await postForm(`${origin}/modes/open/token`, {
        grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
        subject_token_type: "https://smarthealthit.org/token-type/permission-ticket",
        subject_token: mintTicket({
          subject: elenaPatient(),
          scopes: ["patient/Patient.rs"],
          periods: [{ start: "2023-01-01", end: "2025-12-31" }],
          sensitiveMode: "deny",
          revocation: { url: revocationUrl, index: 7 },
        }),
      });
      await expectTokenError(response, "invalid_grant", "revocation status could not be determined");
    } finally {
      revocationServer.stop(true);
    }
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
        subject: elenaPatient(),
        scopes: ["patient/DiagnosticReport.rs"],
        periods: [{ start: "2021-01-01", end: "2023-12-31" }],
        sensitiveMode: "deny",
      }),
    });
    await expectTokenError(denySiteRequest, "invalid_grant", "no visible encounters");

    const allowSite = await getJson(`${origin}/modes/open/sites/lone-star-womens-health/fhir/DiagnosticReport?_count=100`, allowSiteToken.access_token);
    expect(allowSite.total).toBeGreaterThan(0);
  });

  test("token endpoint validates token-exchange request fields explicitly", async () => {
    const validTicket = mintTicket({
      subject: elenaPatient(),
      scopes: ["patient/Patient.rs"],
      periods: [{ start: "2023-01-01", end: "2025-12-31" }],
      sensitiveMode: "deny",
    });

    await expectTokenError(
      await postForm(`${origin}/modes/open/token`, {
        grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
        subject_token: validTicket,
      }),
      "invalid_request",
      "Missing subject_token_type",
    );

    await expectTokenError(
      await postForm(`${origin}/modes/open/token`, {
        grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
        subject_token_type: "urn:example:wrong",
        subject_token: validTicket,
      }),
      "invalid_request",
      "Unsupported subject_token_type",
    );

    await expectTokenError(
      await postForm(`${origin}/modes/open/token`, {
        grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
        subject_token_type: PERMISSION_TICKET_SUBJECT_TOKEN_TYPE,
      }),
      "invalid_request",
      "No permission ticket provided",
    );

    const missingTypeTicket = context.issuers.sign(origin, context.config.defaultPermissionTicketIssuerSlug, {
      iss: `${origin}/issuer/${context.config.defaultPermissionTicketIssuerSlug}`,
      aud: origin,
      exp: Math.floor(Date.now() / 1000) + 3600,
      jti: crypto.randomUUID(),
      requester: defaultRequester(PUBLIC_HEALTH_INVESTIGATION_TICKET_TYPE),
      subject: {
        patient: elenaPatient(),
      },
      access: {
        permissions: projectScopesToPermissions(["patient/Patient.rs"]),
        data_period: { start: "2023-01-01", end: "2025-12-31" },
        sensitive_data: "exclude",
      },
      context: defaultContext(PUBLIC_HEALTH_INVESTIGATION_TICKET_TYPE),
    } as any);
    await expectTokenError(
      await postForm(`${origin}/modes/open/token`, {
        grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
        subject_token_type: PERMISSION_TICKET_SUBJECT_TOKEN_TYPE,
        subject_token: missingTypeTicket,
      }),
      "invalid_grant",
      "Invalid input",
    );

    await expectTokenError(
      await postForm(`${origin}/modes/open/token`, {
        grant_type: "client_credentials",
        subject_token_type: PERMISSION_TICKET_SUBJECT_TOKEN_TYPE,
        subject_token: validTicket,
      }),
      "invalid_client",
      "UDAP-authenticated client required for client_credentials",
      401,
    );
  });

  test("requested scope narrows issued access and rejects widening beyond the ticket", async () => {
    const narrowed = await postFormJson(`${origin}/modes/open/token`, {
      grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
      subject_token_type: PERMISSION_TICKET_SUBJECT_TOKEN_TYPE,
      subject_token: mintTicket({
        subject: elenaPatient(),
        scopes: ["patient/*.rs"],
        periods: [{ start: "2021-01-01", end: "2025-12-31" }],
        sensitiveMode: "allow",
      }),
      scope: "patient/Observation.rs?category=laboratory",
    });
    expect(narrowed.scope).toBe("patient/Observation.rs?category=laboratory");
    const narrowedClaims = decodeJwtClaims(narrowed.access_token);
    expect(narrowedClaims.scope).toBe("patient/Observation.rs?category=laboratory");

    const narrowedObs = await getJson(`${origin}/modes/open/fhir/Observation?category=laboratory&_summary=count`, narrowed.access_token);
    const narrowedEncounters = await getJson(`${origin}/modes/open/fhir/Encounter?_summary=count`, narrowed.access_token);
    expect(narrowedObs.total).toBeGreaterThan(0);
    expect(narrowedEncounters.total).toBe(0);

    await expectTokenError(
      await postForm(`${origin}/modes/open/token`, {
        grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
        subject_token_type: PERMISSION_TICKET_SUBJECT_TOKEN_TYPE,
        subject_token: mintTicket({
          subject: elenaPatient(),
          scopes: ["patient/Observation.rs?category=laboratory"],
          periods: [{ start: "2021-01-01", end: "2025-12-31" }],
          sensitiveMode: "allow",
        }),
        scope: "patient/Observation.rs",
      }),
      "invalid_scope",
      "Requested scope is not permitted by the ticket",
    );
  });

  test("broader resource types are searchable for supported patient-facing stories", async () => {
    const aishaToken = await postFormJson(`${origin}/modes/open/token`, {
      grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
      subject_token_type: PERMISSION_TICKET_SUBJECT_TOKEN_TYPE,
      subject_token: mintTicket({
        subject: aishaPatient(),
        scopes: ["patient/AllergyIntolerance.rs", "patient/Immunization.rs", "patient/ServiceRequest.rs"],
        periods: [{ start: "2020-01-01", end: "2026-12-31" }],
        sensitiveMode: "allow",
      }),
    });
    const allergies = await getJson(`${origin}/modes/open/fhir/AllergyIntolerance?patient=${aishaToken.patient}&_summary=count`, aishaToken.access_token);
    const immunizations = await getJson(`${origin}/modes/open/fhir/Immunization?patient=${aishaToken.patient}&_summary=count`, aishaToken.access_token);
    const serviceRequests = await getJson(`${origin}/modes/open/fhir/ServiceRequest?patient=${aishaToken.patient}&_summary=count`, aishaToken.access_token);
    expect(allergies.total).toBeGreaterThan(0);
    expect(immunizations.total).toBeGreaterThan(0);
    expect(serviceRequests.total).toBeGreaterThan(0);

    const deniseToken = await postFormJson(`${origin}/modes/open/token`, {
      grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
      subject_token_type: PERMISSION_TICKET_SUBJECT_TOKEN_TYPE,
      subject_token: mintTicket({
        subject: denisePatient(),
        scopes: ["patient/Procedure.rs"],
        periods: [{ start: "2020-01-01", end: "2026-12-31" }],
        sensitiveMode: "allow",
      }),
    });
    const procedures = await getJson(`${origin}/modes/open/fhir/Procedure?patient=${deniseToken.patient}&_summary=count`, deniseToken.access_token);
    expect(procedures.total).toBeGreaterThan(0);
  });
});

function elenaPatient() {
  return {
    resourceType: "Patient" as const,
    name: [{ family: "Reyes", given: ["Elena"] }],
    birthDate: "1989-09-14",
  };
}

function aishaPatient() {
  return {
    resourceType: "Patient" as const,
    name: [{ family: "Patel", given: ["Aisha"] }],
    birthDate: "2020-03-15",
  };
}

function denisePatient() {
  return {
    resourceType: "Patient" as const,
    name: [{ family: "Walker", given: ["Denise"] }],
    birthDate: "1958-07-22",
  };
}

function mintTicket(input: {
  issuer?: string;
  aud?: string | string[];
  subject: any;
  scopes: string[];
  periods: Array<{ start?: string; end?: string }>;
  sensitiveMode: "deny" | "allow";
  presenterBinding?: { method: "jkt"; jkt: string } | { method: "framework_client"; framework: string; framework_type: "well-known" | "udap"; entity_uri: string };
  ticketType?: string;
  requester?: Record<string, unknown>;
  context?: Record<string, unknown>;
  exp?: number;
  iat?: number;
  jti?: string | null;
  revocation?: { url: string; index: number };
  responderFilter?: Array<
    | { kind: "jurisdiction"; address: { state?: string; country?: string } }
    | { kind: "organization"; organization: { resourceType: "Organization"; name?: string; identifier?: Array<{ system?: string; value?: string }> } }
  >;
  accessExtras?: Record<string, unknown>;
  rawSign?: boolean;
}) {
  const ticketOrigin = input.issuer ?? origin;
  const ticketType = input.ticketType
    ?? (input.presenterBinding ? PATIENT_SELF_ACCESS_TICKET_TYPE : PUBLIC_HEALTH_INVESTIGATION_TICKET_TYPE);
  const requester = input.requester ?? defaultRequester(ticketType);
  const effectiveContext = input.context ?? defaultContext(ticketType);
  const payload = {
    iss: `${ticketOrigin}/issuer/${context.config.defaultPermissionTicketIssuerSlug}`,
    aud: input.aud ?? ticketOrigin,
    ...(typeof input.exp === "number" ? { exp: input.exp } : { exp: Math.floor(Date.now() / 1000) + 3600 }),
    ...(typeof input.iat === "number" ? { iat: input.iat } : {}),
    ...(input.jti === null ? {} : (typeof input.jti === "string" ? { jti: input.jti } : { jti: crypto.randomUUID() })),
    ticket_type: ticketType,
    ...(input.presenterBinding ? { presenter_binding: input.presenterBinding } : {}),
    ...(input.revocation ? { revocation: input.revocation } : {}),
    subject: normalizeSubject(input.subject),
    ...(requester ? { requester } : {}),
    access: {
      permissions: projectScopesToPermissions(input.scopes),
      data_period: normalizeDataPeriod(input.periods),
      responder_filter: input.responderFilter,
      sensitive_data: input.sensitiveMode === "allow" ? "include" : "exclude",
      ...input.accessExtras,
    },
    ...(effectiveContext ? { context: effectiveContext } : {}),
  };
  if (input.rawSign) {
    const issuer = context.issuers.get(context.config.defaultPermissionTicketIssuerSlug);
    if (!issuer) throw new Error("Default issuer not configured");
    return signEs256Jwt(payload, issuer.privateJwk, { kid: issuer.kid });
  }
  return context.issuers.sign(ticketOrigin, context.config.defaultPermissionTicketIssuerSlug, payload);
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
      subject: elenaPatient(),
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
      subject: elenaPatient(),
      scopes,
      periods,
      sensitiveMode,
      presenterBinding: { method: "jkt", jkt: client.jwkThumbprint },
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

function normalizeSubject(subject: any) {
  if (subject?.patient) return subject;
  if (subject?.resourceType === "Patient") return { patient: subject };
  if (subject?.type === "match") return { patient: subject.traits };
  if (subject?.type === "reference") {
    return {
      patient: elenaPatient(),
      recipient_record: {
        reference: subject.reference,
        type: "Patient",
      },
    };
  }
  if (subject?.type === "identifier") {
    return {
      patient: subject.traits ?? elenaPatient(),
      recipient_record: {
        identifier: subject.identifier?.[0],
        type: "Patient",
      },
    };
  }
  return subject;
}

function projectScopesToPermissions(scopes: string[]) {
  return scopes.map((scope) => {
    const [baseScope, query] = scope.split("?", 2);
    const resourceType = baseScope.match(/^[^/]+\/([A-Za-z*]+)\./)?.[1] ?? "*";
    const permission: Record<string, unknown> = {
      kind: "data",
      resource_type: resourceType,
      interactions: ["read", "search"],
    };
    if (query) {
      const params = new URLSearchParams(query);
      const category = params.get("category");
      if (category) {
        const [system, code] = category.includes("|")
          ? category.split("|", 2)
          : [undefined, category];
        permission.category_any_of = [{
          ...(system ? { system } : {}),
          ...(code ? { code } : {}),
        }];
      }
    }
    return permission;
  });
}

function normalizeDataPeriod(periods: Array<{ start?: string; end?: string }>) {
  const [first] = periods;
  if (!first || (!first.start && !first.end)) return undefined;
  return {
    start: first.start,
    end: first.end,
  };
}

function defaultContext(ticketType: string) {
  if (ticketType === PUBLIC_HEALTH_INVESTIGATION_TICKET_TYPE) {
    return {
      reportable_condition: { text: "Public health investigation" },
    };
  }
  return undefined;
}

function defaultRequester(ticketType: string) {
  if (ticketType !== PUBLIC_HEALTH_INVESTIGATION_TICKET_TYPE) return undefined;
  return {
    resourceType: "Organization",
    identifier: [{ system: "urn:example:org", value: "public-health-dept" }],
    name: "Public Health Department",
  };
}

async function expectTokenError(
  response: Response,
  errorCode: string,
  descriptionSubstring: string,
  status = 400,
) {
  expect(response.status).toBe(status);
  const body = await response.json();
  expect(body.error).toBe(errorCode);
  expect(body.error_description).toContain(descriptionSubstring);
}

function startTicketRevocationServer(routes: Record<string, () => Response>) {
  const server = Bun.serve({
    port: 0,
    fetch(request) {
      const pathname = new URL(request.url).pathname;
      const handler = routes[pathname];
      return handler ? handler() : jsonResponse({ error: "not found" }, 404);
    },
  });
  return {
    origin: `http://127.0.0.1:${server.port}`,
    stop(force?: boolean) {
      server.stop(force);
    },
  };
}

function encodeStatusBits(revokedIndexes: number[]) {
  const maxIndex = revokedIndexes.length ? Math.max(...revokedIndexes) : -1;
  const bytes = new Uint8Array(Math.max(1, Math.floor(maxIndex / 8) + 1));
  for (const index of revokedIndexes) {
    bytes[Math.floor(index / 8)] |= 1 << (index % 8);
  }
  return Buffer.from(gzipSync(bytes)).toString("base64url");
}

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json",
      ...headers,
    },
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
  options?: {
    assertionClientId?: string;
    signingPrivateJwk?: JsonWebKey;
    proofJkt?: string;
    assertionAud?: string;
    assertionIat?: number;
    assertionExp?: number;
  },
) {
  const response = await postFormWithClient(url, body, client, options);
  expect(response.status).toBe(200);
  return response.json();
}

async function postFormWithClient(
  url: string,
  body: Record<string, string>,
  client: DemoClient,
  options?: {
    assertionClientId?: string;
    signingPrivateJwk?: JsonWebKey;
    proofJkt?: string;
    assertionAud?: string;
    assertionIat?: number;
    assertionExp?: number;
  },
) {
  const assertionClientId = options?.assertionClientId ?? client.clientId;
  const signingPrivateJwk = options?.signingPrivateJwk ?? client.privateJwk;
  const now = Math.floor(Date.now() / 1000);
  const assertionIat = options?.assertionIat ?? now;
  const clientAssertion = await signPrivateKeyJwt(
    {
      iss: assertionClientId,
      sub: assertionClientId,
      aud: options?.assertionAud ?? url,
      iat: assertionIat,
      exp: options?.assertionExp ?? (assertionIat + 300),
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

function rewriteJwtHeader(jwt: string, patch: Record<string, unknown>) {
  const [header, payload, signature] = jwt.split(".", 3);
  if (!header || !payload || !signature) throw new Error("Invalid JWT");
  const parsedHeader = JSON.parse(Buffer.from(header, "base64url").toString("utf8"));
  const nextHeader = Buffer.from(JSON.stringify({ ...parsedHeader, ...patch }), "utf8").toString("base64url");
  return `${nextHeader}.${payload}.${signature}`;
}

function corruptJwtSignature(jwt: string) {
  const [header, payload, signature] = jwt.split(".", 3);
  if (!header || !payload || !signature) throw new Error("Invalid JWT");
  const bytes = Buffer.from(signature, "base64url");
  if (!bytes.length) throw new Error("Invalid JWT signature");
  bytes[0] = bytes[0] ^ 0xff;
  return `${header}.${payload}.${bytes.toString("base64url")}`;
}

function describeDerCertificate(der: Uint8Array) {
  return withTempBinaryFile(der, ".cer", (filePath) =>
    execFileSync("openssl", ["x509", "-inform", "DER", "-in", filePath, "-noout", "-text"], { encoding: "utf8" }),
  );
}

function describeDerCrl(der: Uint8Array) {
  return withTempBinaryFile(der, ".crl", (filePath) =>
    execFileSync("openssl", ["crl", "-inform", "DER", "-in", filePath, "-noout", "-text"], { encoding: "utf8" }),
  );
}

function withTempBinaryFile<T>(bytes: Uint8Array, extension: string, run: (filePath: string) => T) {
  const workspace = mkdtempSync(join(tmpdir(), "smart-permission-tickets-test-"));
  const filePath = join(workspace, `artifact${extension}`);
  try {
    writeFileSync(filePath, bytes);
    return run(filePath);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
}
