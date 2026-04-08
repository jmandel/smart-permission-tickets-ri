import { X509Certificate } from "node:crypto";

import { describe, expect, test } from "bun:test";

import { PATIENT_SELF_ACCESS_TICKET_TYPE, PERMISSION_TICKET_SUBJECT_TOKEN_TYPE } from "../shared/permission-tickets.ts";
import { buildDemoUdapClients, DEFAULT_DEMO_UDAP_FRAMEWORK_URI, DEFAULT_DEMO_UDAP_TRUST_ANCHOR_PEM } from "../src/auth/demo-frameworks.ts";
import { pemToDerBase64, signEs256JwtWithPem } from "../src/auth/x509-jwt.ts";
import { createAppContext, startServer } from "../src/app.ts";
import { computeEcJwkThumbprintSync, normalizePublicJwk } from "../src/auth/es256-jwt.ts";
import { UDAP_ROOT_B_CERT_PEM } from "./fixtures/udap-fixtures.ts";

describe("UDAP issuer trust", () => {
  test("token exchange accepts a UDAP-backed issuer when UDAP issuer policy is enabled", async () => {
    await withUdapIssuerHarness(async ({ appPublicOrigin, issuerUrl, ticket, frameworkUri }) => {
      const { server, localOrigin } = startPolicyApp({
        appPublicOrigin,
        issuerTrust: {
          policies: [
            {
              type: "udap",
              require: {
                kind: "all",
                rules: [
                  { kind: "issuer_url_in", values: [issuerUrl] },
                  { kind: "udap_chains_to", trustAnchors: [DEFAULT_DEMO_UDAP_TRUST_ANCHOR_PEM] },
                ],
              },
            },
          ],
        },
        frameworks: [issuerFramework(frameworkUri, [DEFAULT_DEMO_UDAP_TRUST_ANCHOR_PEM])],
      });

      try {
        const tokenResponse = await exchangeTicket(localOrigin, ticket);
        expect(tokenResponse.status).toBe(200);
        const tokenBody = await tokenResponse.json();
        expect(typeof tokenBody.access_token).toBe("string");

        const introspectionResponse = await fetch(`${localOrigin}/modes/open/introspect`, {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({ token: tokenBody.access_token }),
        });
        expect(introspectionResponse.status).toBe(200);
        const introspectionBody = await introspectionResponse.json();
        expect(introspectionBody.ticket_issuer_trust).toEqual({
          source: "framework",
          issuerUrl,
          displayName: issuerUrl,
          framework: {
            uri: frameworkUri,
            type: "udap",
          },
        });
      } finally {
        server.stop(true);
      }
    });
  });

  test("UDAP issuer trust rejects discovery signed by an untrusted chain", async () => {
    await withUdapIssuerHarness(async ({ appPublicOrigin, ticket, frameworkUri }) => {
      const { server, localOrigin } = startPolicyApp({
        appPublicOrigin,
        issuerTrust: {
          policies: [{ type: "udap" }],
        },
        frameworks: [issuerFramework(frameworkUri, [UDAP_ROOT_B_CERT_PEM])],
      });

      try {
        const tokenResponse = await exchangeTicket(localOrigin, ticket);
        expect(tokenResponse.status).toBe(400);
        const body = await tokenResponse.json();
        expect(body.error).toBe("invalid_grant");
        expect(String(body.error_description)).toContain("UDAP discovery");
        expect(String(body.error_description)).toContain("not trusted by framework");
      } finally {
        server.stop(true);
      }
    });
  });

  test("UDAP issuer trust rejects discovery without signed_metadata", async () => {
    await withUdapIssuerHarness(
      async ({ appPublicOrigin, ticket, frameworkUri }) => {
        const { server, localOrigin } = startPolicyApp({
          appPublicOrigin,
          issuerTrust: {
            policies: [{ type: "udap" }],
          },
          frameworks: [issuerFramework(frameworkUri, [DEFAULT_DEMO_UDAP_TRUST_ANCHOR_PEM])],
        });

        try {
          const tokenResponse = await exchangeTicket(localOrigin, ticket);
          expect(tokenResponse.status).toBe(400);
          const body = await tokenResponse.json();
          expect(body.error).toBe("invalid_grant");
          expect(String(body.error_description)).toContain("did not include signed_metadata");
        } finally {
          server.stop(true);
        }
      },
      {
        omitSignedMetadata: true,
      },
    );
  });
});

function issuerFramework(frameworkUri: string, trustAnchors: string[]) {
  return {
    framework: frameworkUri,
    frameworkType: "udap" as const,
    supportsClientAuth: false,
    supportsIssuerTrust: true,
    cacheTtlSeconds: 300,
    udap: {
      trustAnchors,
    },
  };
}

function startPolicyApp(input: Parameters<typeof createAppContext>[0] & { appPublicOrigin: string }) {
  const context = createAppContext({
    port: 0,
    publicBaseUrl: input.appPublicOrigin,
    issuer: input.appPublicOrigin,
    frameworks: input.frameworks,
    issuerTrust: input.issuerTrust,
  });
  const server = startServer(context, 0);
  const localOrigin = `http://127.0.0.1:${server.port}`;
  context.config.internalBaseUrl = localOrigin;
  return { context, server, localOrigin };
}

async function withUdapIssuerHarness(
  run: (input: { appPublicOrigin: string; issuerUrl: string; ticket: string; frameworkUri: string }) => Promise<void>,
  options: { omitSignedMetadata?: boolean } = {},
) {
  const frameworkUri = `${DEFAULT_DEMO_UDAP_FRAMEWORK_URI}/issuer-trust`;
  const issuerServer = Bun.serve({
    port: 0,
    fetch(request) {
      const url = new URL(request.url);
      const clients = buildDemoUdapClients(url.origin);
      const issuerClient = clients.find((client) => client.algorithm === "ES256");
      if (!issuerClient) return new Response("missing issuer client", { status: 500 });

      const discoveryPath = new URL(".well-known/udap", `${issuerClient.entityUri}/`).pathname;
      if (url.pathname === discoveryPath) {
        const signedMetadata = options.omitSignedMetadata
          ? undefined
          : signEs256JwtWithPem(
              {
                iss: issuerClient.entityUri,
                sub: issuerClient.entityUri,
                iat: Math.floor(Date.now() / 1000),
                exp: Math.floor(Date.now() / 1000) + 3600,
                token_endpoint: `${issuerClient.entityUri}/token`,
                registration_endpoint: `${issuerClient.entityUri}/register`,
              },
              issuerClient.privateKeyPem,
              {
                x5c: issuerClient.certificateChainPems.map((pem) => pemToDerBase64(pem)),
              },
            );
        return Response.json({
          community: frameworkUri,
          supported_trust_communities: [frameworkUri],
          token_endpoint_auth_signing_alg_values_supported: ["ES256", "RS256"],
          registration_endpoint_jwt_signing_alg_values_supported: ["ES256", "RS256"],
          registration_endpoint: `${issuerClient.entityUri}/register`,
          token_endpoint: `${issuerClient.entityUri}/token`,
          ...(signedMetadata ? { signed_metadata: signedMetadata } : {}),
        });
      }
      return new Response("not found", { status: 404 });
    },
  });

  const issuerOrigin = `http://127.0.0.1:${issuerServer.port}`;
  const issuerClient = buildDemoUdapClients(issuerOrigin).find((client) => client.algorithm === "ES256");
  if (!issuerClient) {
    issuerServer.stop(true);
    throw new Error("Missing demo UDAP ES256 client");
  }

  const leafCertificate = new X509Certificate(issuerClient.certificatePem);
  const publicJwk = normalizePublicJwk(leafCertificate.publicKey.export({ format: "jwk" }) as JsonWebKey);
  const issuerKid = computeEcJwkThumbprintSync(publicJwk);
  const appPublicOrigin = "https://tickets.example.test";
  const ticket = signEs256JwtWithPem(
    {
      iss: issuerClient.entityUri,
      aud: appPublicOrigin,
      exp: Math.floor(Date.now() / 1000) + 3600,
      jti: crypto.randomUUID(),
      ticket_type: PATIENT_SELF_ACCESS_TICKET_TYPE,
      subject: {
        patient: {
          resourceType: "Patient",
          name: [{ family: "Reyes", given: ["Elena"] }],
          birthDate: "1989-09-14",
        },
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
    },
    issuerClient.privateKeyPem,
    { kid: issuerKid },
  );

  try {
    await run({
      appPublicOrigin,
      issuerUrl: issuerClient.entityUri,
      ticket,
      frameworkUri,
    });
  } finally {
    issuerServer.stop(true);
  }
}

function exchangeTicket(appOrigin: string, ticket: string) {
  return fetch(`${appOrigin}/modes/open/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
      subject_token_type: PERMISSION_TICKET_SUBJECT_TOKEN_TYPE,
      subject_token: ticket,
    }),
  });
}
