import { describe, expect, test } from "bun:test";
import { createAppContext, startServer } from "../src/app.ts";
import { parseX5cCertificates, verifyX509JwtWithKey } from "../src/auth/x509-jwt.ts";
import { UDAP_ROOT_A_CERT_PEM } from "./fixtures/udap-fixtures.ts";

describe("framework discovery surfaces", () => {
  test("global, site, and network SMART + UDAP discovery stay coherent", async () => {
    const context = createAppContext({
      port: 0,
      frameworks: [
        {
          framework: "https://example.org/frameworks/smart-health-issuers",
          frameworkType: "well-known",
          supportsClientAuth: true,
          supportsIssuerTrust: false,
          cacheTtlSeconds: 3600,
          wellKnown: {
            allowlist: ["https://client.example.org"],
            jwksRelativePath: "/.well-known/jwks.json",
          },
        },
        {
          framework: "https://example.org/frameworks/tefca",
          frameworkType: "udap",
          supportsClientAuth: true,
          supportsIssuerTrust: false,
          cacheTtlSeconds: 3600,
          udap: {
            trustAnchors: [UDAP_ROOT_A_CERT_PEM],
          },
        },
      ],
    });
    const server = startServer(context, 0);
    const origin = `http://127.0.0.1:${server.port}`;
    context.config.publicBaseUrl = origin;
    context.config.issuer = origin;

    try {
      const [globalSmart, siteSmart, networkSmart] = await Promise.all([
        fetchJson(`${origin}/fhir/.well-known/smart-configuration`),
        fetchJson(`${origin}/sites/bay-area-rheumatology-associates/fhir/.well-known/smart-configuration`),
        fetchJson(`${origin}/networks/reference/fhir/.well-known/smart-configuration`),
      ]);
      const globalExtension = globalSmart.extensions["https://smarthealthit.org/smart-permission-tickets/smart-configuration"];
      const siteExtension = siteSmart.extensions["https://smarthealthit.org/smart-permission-tickets/smart-configuration"];
      const networkExtension = networkSmart.extensions["https://smarthealthit.org/smart-permission-tickets/smart-configuration"];

      expect(siteExtension.supported_client_binding_types).toEqual(globalExtension.supported_client_binding_types);
      expect(networkExtension.supported_client_binding_types).toEqual(globalExtension.supported_client_binding_types);
      expect(siteExtension.supported_trust_frameworks).toEqual(globalExtension.supported_trust_frameworks);
      expect(networkExtension.supported_trust_frameworks).toEqual(globalExtension.supported_trust_frameworks);
      expect(globalSmart.grant_types_supported).toContain("client_credentials");
      expect(siteSmart.grant_types_supported).toEqual(globalSmart.grant_types_supported);
      expect(networkSmart.grant_types_supported).toEqual(globalSmart.grant_types_supported);
      expect(globalSmart.token_endpoint).toBe(`${origin}/token`);
      expect(siteSmart.token_endpoint).toBe(`${origin}/sites/bay-area-rheumatology-associates/token`);
      expect(networkSmart.token_endpoint).toBe(`${origin}/networks/reference/token`);

      const [globalUdap, siteUdap, networkUdap] = await Promise.all([
        fetchJson(`${origin}/fhir/.well-known/udap`),
        fetchJson(`${origin}/sites/bay-area-rheumatology-associates/fhir/.well-known/udap`),
        fetchJson(`${origin}/networks/reference/fhir/.well-known/udap`),
      ]);

      expect(globalUdap.community).toBe("https://example.org/frameworks/tefca");
      expect(siteUdap.community).toBe(globalUdap.community);
      expect(networkUdap.community).toBe(globalUdap.community);
      expect(globalUdap.udap_profiles_supported).toContain("udap_authz");
      expect(globalUdap.udap_authorization_extensions_supported).toContain("hl7-b2b");
      expect(globalUdap.udap_authorization_extensions_required).toEqual(["hl7-b2b"]);
      expect(globalUdap.grant_types_supported).toContain("client_credentials");
      expect(globalUdap.registration_endpoint).toBe(`${origin}/register`);
      expect(siteUdap.registration_endpoint).toBe(`${origin}/sites/bay-area-rheumatology-associates/register`);
      expect(networkUdap.registration_endpoint).toBe(`${origin}/networks/reference/register`);
      expect(globalUdap.token_endpoint).toBe(`${origin}/token`);
      expect(siteUdap.token_endpoint).toBe(`${origin}/sites/bay-area-rheumatology-associates/token`);
      expect(networkUdap.token_endpoint).toBe(`${origin}/networks/reference/token`);
      expect(siteUdap.supported_trust_communities).toEqual(globalUdap.supported_trust_communities);
      expect(networkUdap.supported_trust_communities).toEqual(globalUdap.supported_trust_communities);
      await expectSignedMetadata(globalUdap.signed_metadata, {
        iss: `${origin}/fhir`,
        tokenEndpoint: `${origin}/token`,
        registrationEndpoint: `${origin}/register`,
      });
      await expectSignedMetadata(siteUdap.signed_metadata, {
        iss: `${origin}/sites/bay-area-rheumatology-associates/fhir`,
        tokenEndpoint: `${origin}/sites/bay-area-rheumatology-associates/token`,
        registrationEndpoint: `${origin}/sites/bay-area-rheumatology-associates/register`,
      });
      await expectSignedMetadata(networkUdap.signed_metadata, {
        iss: `${origin}/networks/reference/fhir`,
        tokenEndpoint: `${origin}/networks/reference/token`,
        registrationEndpoint: `${origin}/networks/reference/register`,
      });
    } finally {
      server.stop(true);
    }
  });
});

async function fetchJson(url: string) {
  const response = await fetch(url);
  expect(response.status).toBe(200);
  return response.json();
}

async function expectSignedMetadata(
  token: string,
  expected: {
    iss: string;
    tokenEndpoint: string;
    registrationEndpoint: string;
  },
) {
  const [encodedHeader] = token.split(".", 1);
  const header = JSON.parse(Buffer.from(encodedHeader, "base64url").toString("utf8")) as { alg?: string; x5c?: string[] };
  expect(header.alg).toBe("RS256");
  const certificates = parseX5cCertificates(header.x5c);
  expect(certificates[0]?.subject).toContain("CN=");
  const { payload } = verifyX509JwtWithKey<Record<string, any>>(token, certificates[0].publicKey);
  expect(payload.iss).toBe(expected.iss);
  expect(payload.sub).toBe(expected.iss);
  expect(payload.token_endpoint).toBe(expected.tokenEndpoint);
  expect(payload.registration_endpoint).toBe(expected.registrationEndpoint);
}
