import { describe, expect, test } from "bun:test";
import {
  NETWORK_PATIENT_ACCESS_TICKET_TYPE,
  PERMISSION_TICKET_SUBJECT_TOKEN_TYPE,
  PUBLIC_HEALTH_INVESTIGATION_TICKET_TYPE,
} from "../shared/permission-tickets.ts";
import { parseX5cCertificates, signEs256JwtWithPem, signRs256JwtWithPem, verifyX509JwtWithKey } from "../src/auth/x509-jwt.ts";
import { createAppContext, startServer } from "../src/app.ts";
import {
  UDAP_CLIENT_A_KEY_PEM,
  UDAP_CLIENT_A_OTHER_COMMUNITY_KEY_PEM,
  UDAP_RSA_CLIENT_KEY_PEM,
  UDAP_RSA_ROOT_CERT_PEM,
  UDAP_ROOT_A_CERT_PEM,
  UDAP_ROOT_B_CERT_PEM,
  UDAP_WRONG_CLIENT_KEY_PEM,
  x5cForClientACert,
  x5cForClientAOtherCommunityCert,
  x5cForRs256ClientCert,
  x5cForWrongClientCert,
} from "./fixtures/udap-fixtures.ts";

describe("UDAP token authentication and discovery", () => {
  test("registered UDAP client can redeem a ticket bound by framework/entity identity", async () => {
    await withUdapHarness(async ({ origin, context, registeredClientId }) => {
      const ticket = context.issuers.sign(origin, context.config.defaultPermissionTicketIssuerSlug, {
        iss: `${origin}/issuer/${context.config.defaultPermissionTicketIssuerSlug}`,
        aud: origin,
        exp: Math.floor(Date.now() / 1000) + 3600,
        jti: crypto.randomUUID(),
        ticket_type: NETWORK_PATIENT_ACCESS_TICKET_TYPE,
        presenter_binding: {
          framework_client: {
            framework: "https://example.org/frameworks/tefca",
            framework_type: "udap",
            entity_uri: "https://client-a.example.org",
          },
        },
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
        context: { kind: "patient-access" },
      });

      const response = await fetch(`${origin}/token`, {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({
          grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
          subject_token_type: PERMISSION_TICKET_SUBJECT_TOKEN_TYPE,
          subject_token: ticket,
          client_id: registeredClientId,
          client_assertion_type: "urn:ietf:params:oauth:client-assertion-type:jwt-bearer",
          client_assertion: buildClientAssertion(registeredClientId, `${origin}/token`),
          udap: "1",
        }),
      });
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(typeof body.access_token).toBe("string");
    });
  });

  test("registered UDAP client can obtain a client_credentials access token with system scopes", async () => {
    await withUdapHarness(async ({ origin, registeredClientId }) => {
      const response = await fetch(`${origin}/token`, {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({
          grant_type: "client_credentials",
          scope: "system/Patient.rs",
          client_id: registeredClientId,
          client_assertion_type: "urn:ietf:params:oauth:client-assertion-type:jwt-bearer",
          client_assertion: buildClientAssertion(registeredClientId, `${origin}/token`),
          udap: "1",
        }),
      });
      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(response.headers.get("pragma")).toBe("no-cache");
      const body = await response.json();
      expect(body.scope).toBe("system/Patient.rs");
      expect(typeof body.access_token).toBe("string");

      const patientResponse = await fetch(`${origin}/fhir/Patient?_count=1`, {
        headers: {
          authorization: `Bearer ${body.access_token}`,
        },
      });
      expect(patientResponse.status).toBe(200);
    });
  });

  test("client_credentials falls back to the registered UDAP scope when request scope is omitted", async () => {
    await withUdapHarness(async ({ origin, registeredClientId }) => {
      const response = await fetch(`${origin}/token`, {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({
          grant_type: "client_credentials",
          client_id: registeredClientId,
          client_assertion_type: "urn:ietf:params:oauth:client-assertion-type:jwt-bearer",
          client_assertion: buildClientAssertion(registeredClientId, `${origin}/token`),
          udap: "1",
        }),
      });
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.scope).toBe("system/Patient.rs");
      expect(typeof body.access_token).toBe("string");
    });
  });

  test("client_credentials rejects non-system scopes for UDAP clients", async () => {
    await withUdapHarness(async ({ origin, registeredClientId }) => {
      const response = await fetch(`${origin}/token`, {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({
          grant_type: "client_credentials",
          scope: "patient/Patient.rs",
          client_id: registeredClientId,
          client_assertion_type: "urn:ietf:params:oauth:client-assertion-type:jwt-bearer",
          client_assertion: buildClientAssertion(registeredClientId, `${origin}/token`),
          udap: "1",
        }),
      });
      expect(response.status).toBe(400);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(response.headers.get("pragma")).toBe("no-cache");
      const body = await response.json();
      expect(body.error).toBe("invalid_scope");
      expect(body.error_description).toContain("only support system scopes");
    });
  });

  test("client_credentials rejects request scopes outside the registered UDAP scope", async () => {
    await withUdapHarness(async ({ origin, registeredClientId }) => {
      const response = await fetch(`${origin}/token`, {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({
          grant_type: "client_credentials",
          scope: "system/Observation.rs",
          client_id: registeredClientId,
          client_assertion_type: "urn:ietf:params:oauth:client-assertion-type:jwt-bearer",
          client_assertion: buildClientAssertion(registeredClientId, `${origin}/token`),
          udap: "1",
        }),
      });
      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body.error).toBe("invalid_scope");
      expect(body.error_description).toContain("registered client scope");
    });
  });

  test("UDAP token request fails when the token-time chain is not trusted for the registered framework", async () => {
    await withUdapHarness(async ({ origin, context, registeredClientId }) => {
      const response = await fetch(`${origin}/token`, {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({
          grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
          subject_token_type: PERMISSION_TICKET_SUBJECT_TOKEN_TYPE,
          subject_token: mintTicket(context, origin),
          client_id: registeredClientId,
          client_assertion_type: "urn:ietf:params:oauth:client-assertion-type:jwt-bearer",
          client_assertion: buildClientAssertion(registeredClientId, `${origin}/token`, {
            privateKeyPem: UDAP_CLIENT_A_OTHER_COMMUNITY_KEY_PEM,
            x5c: x5cForClientAOtherCommunityCert(),
          }),
          udap: "1",
        }),
      });
      expect(response.status).toBe(401);
      const body = await response.json();
      expect(body.error).toBe("invalid_client");
      expect(body.error_description).toContain("not trusted for framework");
    });
  });

  test("UDAP token request fails when SAN no longer matches the registered entity", async () => {
    await withUdapHarness(async ({ origin, context, registeredClientId }) => {
      const response = await fetch(`${origin}/token`, {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({
          grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
          subject_token_type: PERMISSION_TICKET_SUBJECT_TOKEN_TYPE,
          subject_token: mintTicket(context, origin),
          client_id: registeredClientId,
          client_assertion_type: "urn:ietf:params:oauth:client-assertion-type:jwt-bearer",
          client_assertion: buildClientAssertion(registeredClientId, `${origin}/token`, {
            privateKeyPem: UDAP_WRONG_CLIENT_KEY_PEM,
            x5c: x5cForWrongClientCert(),
          }),
          udap: "1",
        }),
      });
      expect(response.status).toBe(401);
      const body = await response.json();
      expect(body.error).toBe("invalid_client");
      expect(body.error_description).toContain("SAN does not match registered entity URI");
    });
  });

  test("UDAP token request fails when iss/sub use the SAN URI instead of the registered client_id", async () => {
    await withUdapHarness(async ({ origin, context, registeredClientId }) => {
      const response = await fetch(`${origin}/token`, {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({
          grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
          subject_token_type: PERMISSION_TICKET_SUBJECT_TOKEN_TYPE,
          subject_token: mintTicket(context, origin),
          client_id: registeredClientId,
          client_assertion_type: "urn:ietf:params:oauth:client-assertion-type:jwt-bearer",
          client_assertion: buildClientAssertion(registeredClientId, `${origin}/token`, {
            overrideIssSub: "https://client-a.example.org",
          }),
          udap: "1",
        }),
      });
      expect(response.status).toBe(401);
      const body = await response.json();
      expect(body.error).toBe("invalid_client");
      expect(body.error_description).toContain("client_id does not match client assertion issuer");
    });
  });

  test("replayed UDAP client assertions are rejected", async () => {
    await withUdapHarness(async ({ origin, context, registeredClientId }) => {
      const clientAssertion = buildClientAssertion(registeredClientId, `${origin}/token`, {
        jti: "replay-client-assertion",
      });
      const first = await fetch(`${origin}/token`, {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({
          grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
          subject_token_type: PERMISSION_TICKET_SUBJECT_TOKEN_TYPE,
          subject_token: mintTicket(context, origin),
          client_id: registeredClientId,
          client_assertion_type: "urn:ietf:params:oauth:client-assertion-type:jwt-bearer",
          client_assertion: clientAssertion,
          udap: "1",
        }),
      });
      expect(first.status).toBe(200);

      const second = await fetch(`${origin}/token`, {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({
          grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
          subject_token_type: PERMISSION_TICKET_SUBJECT_TOKEN_TYPE,
          subject_token: mintTicket(context, origin),
          client_id: registeredClientId,
          client_assertion_type: "urn:ietf:params:oauth:client-assertion-type:jwt-bearer",
          client_assertion: clientAssertion,
          udap: "1",
        }),
      });
      expect(second.status).toBe(401);
      const body = await second.json();
      expect(body.error).toBe("invalid_client");
      expect(body.error_description).toContain("already been used");
    });
  });

  test("superseded UDAP client_ids are rejected after re-registration", async () => {
    const context = createAppContext({
      port: 0,
      frameworks: [
        framework("https://example.org/frameworks/tefca", [UDAP_ROOT_A_CERT_PEM]),
        framework("https://example.org/frameworks/other-community", [UDAP_ROOT_B_CERT_PEM]),
      ],
    });
    const server = startServer(context, 0);
    const origin = `http://127.0.0.1:${server.port}`;
    context.config.publicBaseUrl = origin;
    context.config.issuer = origin;

    try {
      const firstRegistration = await fetch(`${origin}/register`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          udap: "1",
          software_statement: buildSoftwareStatement(`${origin}/register`, {
            jti: "superseded-reg-1",
            scope: "system/Patient.rs",
          }),
        }),
      });
      expect(firstRegistration.status).toBe(201);
      const firstBody = await firstRegistration.json();

      const secondRegistration = await fetch(`${origin}/register`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          udap: "1",
          software_statement: buildSoftwareStatement(`${origin}/register`, {
            jti: "superseded-reg-2",
            scope: "system/Observation.rs",
          }),
        }),
      });
      expect(secondRegistration.status).toBe(201);
      const secondBody = await secondRegistration.json();
      expect(secondBody.client_id).not.toBe(firstBody.client_id);

      const rejected = await fetch(`${origin}/token`, {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({
          grant_type: "client_credentials",
          scope: "system/Patient.rs",
          client_id: firstBody.client_id,
          client_assertion_type: "urn:ietf:params:oauth:client-assertion-type:jwt-bearer",
          client_assertion: buildClientAssertion(firstBody.client_id, `${origin}/token`, {
            jti: "superseded-assertion",
          }),
          udap: "1",
        }),
      });
      expect(rejected.status).toBe(401);
      const rejectedBody = await rejected.json();
      expect(rejectedBody.error).toBe("invalid_client");

      const accepted = await fetch(`${origin}/token`, {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({
          grant_type: "client_credentials",
          scope: "system/Observation.rs",
          client_id: secondBody.client_id,
          client_assertion_type: "urn:ietf:params:oauth:client-assertion-type:jwt-bearer",
          client_assertion: buildClientAssertion(secondBody.client_id, `${origin}/token`, {
            jti: "replacement-assertion",
          }),
          udap: "1",
        }),
      });
      expect(accepted.status).toBe(200);
    } finally {
      server.stop(true);
    }
  });

  test("canceled UDAP registrations reject the old client_id in-process", async () => {
    const context = createAppContext({
      port: 0,
      frameworks: [
        framework("https://example.org/frameworks/tefca", [UDAP_ROOT_A_CERT_PEM]),
        framework("https://example.org/frameworks/other-community", [UDAP_ROOT_B_CERT_PEM]),
      ],
    });
    const server = startServer(context, 0);
    const origin = `http://127.0.0.1:${server.port}`;
    context.config.publicBaseUrl = origin;
    context.config.issuer = origin;

    try {
      const registration = await fetch(`${origin}/register`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          udap: "1",
          software_statement: buildSoftwareStatement(`${origin}/register`, {
            jti: "cancel-base",
          }),
        }),
      });
      expect(registration.status).toBe(201);
      const registrationBody = await registration.json();

      const cancellation = await fetch(`${origin}/register`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          udap: "1",
          software_statement: buildSoftwareStatement(`${origin}/register`, {
            jti: "cancel-now",
            grantTypes: [""],
          }),
        }),
      });
      expect(cancellation.status).toBe(200);

      const response = await fetch(`${origin}/token`, {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({
          grant_type: "client_credentials",
          scope: "system/Patient.rs",
          client_id: registrationBody.client_id,
          client_assertion_type: "urn:ietf:params:oauth:client-assertion-type:jwt-bearer",
          client_assertion: buildClientAssertion(registrationBody.client_id, `${origin}/token`, {
            jti: "post-cancel-assertion",
          }),
          udap: "1",
        }),
      });
      expect(response.status).toBe(401);
      const body = await response.json();
      expect(body.error).toBe("invalid_client");
    } finally {
      server.stop(true);
    }
  });

  test("UDAP discovery exposes default and community-specific metadata", async () => {
    await withUdapHarness(async ({ origin }) => {
      const defaultResponse = await fetch(`${origin}/fhir/.well-known/udap`);
      expect(defaultResponse.status).toBe(200);
      const defaultBody = await defaultResponse.json();
      expect(defaultBody.udap_versions_supported).toEqual(["1"]);
      expect(defaultBody.udap_profiles_supported).toEqual(["udap_dcr", "udap_authn", "udap_authz"]);
      expect(defaultBody.udap_authorization_extensions_supported).toContain("hl7-b2b");
      expect(defaultBody.udap_authorization_extensions_required).toEqual(["hl7-b2b"]);
      expect(defaultBody.grant_types_supported).toContain("client_credentials");
      expect(defaultBody.registration_endpoint).toBe(`${origin}/register`);
      expect(defaultBody.token_endpoint).toBe(`${origin}/token`);
      expect(defaultBody.token_endpoint_auth_signing_alg_values_supported).toEqual(["RS256", "ES256"]);
      expect(defaultBody.registration_endpoint_jwt_signing_alg_values_supported).toEqual(["RS256", "ES256"]);
      expect(defaultBody.community).toBe("https://example.org/frameworks/tefca");
      expect(defaultBody.supported_trust_communities).toEqual([
        "https://example.org/frameworks/tefca",
        "https://example.org/frameworks/other-community",
      ]);
      await expectSignedMetadata(defaultBody.signed_metadata, {
        iss: `${origin}/fhir`,
        tokenEndpoint: `${origin}/token`,
        registrationEndpoint: `${origin}/register`,
      });

      const communityResponse = await fetch(`${origin}/fhir/.well-known/udap?community=${encodeURIComponent("https://example.org/frameworks/other-community")}`);
      expect(communityResponse.status).toBe(200);
      const communityBody = await communityResponse.json();
      expect(communityBody.community).toBe("https://example.org/frameworks/other-community");
      await expectSignedMetadata(communityBody.signed_metadata, {
        iss: `${origin}/fhir`,
        tokenEndpoint: `${origin}/token`,
        registrationEndpoint: `${origin}/register`,
      });

      const unknownCommunityResponse = await fetch(`${origin}/fhir/.well-known/udap?community=${encodeURIComponent("https://example.org/frameworks/unknown")}`);
      expect(unknownCommunityResponse.status).toBe(204);
    });
  });

  test("RS256 UDAP clients can register and authenticate at the token endpoint", async () => {
    const frameworkUri = "https://example.org/frameworks/rsa-community";
    const context = createAppContext({
      port: 0,
      frameworks: [framework(frameworkUri, [UDAP_RSA_ROOT_CERT_PEM])],
    });
    const server = startServer(context, 0);
    const origin = `http://127.0.0.1:${server.port}`;
    context.config.publicBaseUrl = origin;
    context.config.issuer = origin;

    try {
      const registration = await fetch(`${origin}/register`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          udap: "1",
          software_statement: buildSoftwareStatement(`${origin}/register`, {
            alg: "RS256",
            iss: "https://rs256-client.example.org",
            privateKeyPem: UDAP_RSA_CLIENT_KEY_PEM,
            x5c: x5cForRs256ClientCert(),
          }),
        }),
      });
      expect(registration.status).toBe(201);
      const registrationBody = await registration.json();

      const ticket = context.issuers.sign(origin, context.config.defaultPermissionTicketIssuerSlug, {
        iss: `${origin}/issuer/${context.config.defaultPermissionTicketIssuerSlug}`,
        aud: origin,
        exp: Math.floor(Date.now() / 1000) + 3600,
        jti: crypto.randomUUID(),
        ticket_type: NETWORK_PATIENT_ACCESS_TICKET_TYPE,
        presenter_binding: {
          framework_client: {
            framework: frameworkUri,
            framework_type: "udap",
            entity_uri: "https://rs256-client.example.org",
          },
        },
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
          sensitive_data: "exclude",
        },
        context: { kind: "patient-access" },
      });

      const response = await fetch(`${origin}/token`, {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({
          grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
          subject_token_type: PERMISSION_TICKET_SUBJECT_TOKEN_TYPE,
          subject_token: ticket,
          client_id: registrationBody.client_id,
          client_assertion_type: "urn:ietf:params:oauth:client-assertion-type:jwt-bearer",
          client_assertion: buildClientAssertion(registrationBody.client_id, `${origin}/token`, {
            alg: "RS256",
            privateKeyPem: UDAP_RSA_CLIENT_KEY_PEM,
            x5c: x5cForRs256ClientCert(),
          }),
          udap: "1",
        }),
      });
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(typeof body.access_token).toBe("string");
    } finally {
      server.stop(true);
    }
  });
});

async function withUdapHarness(
  run: (harness: {
    origin: string;
    context: ReturnType<typeof createAppContext>;
    registeredClientId: string;
  }) => Promise<void>,
) {
  const context = createAppContext({
    port: 0,
    frameworks: [
      framework("https://example.org/frameworks/tefca", [UDAP_ROOT_A_CERT_PEM]),
      framework("https://example.org/frameworks/other-community", [UDAP_ROOT_B_CERT_PEM]),
    ],
  });
  const server = startServer(context, 0);
  const origin = `http://127.0.0.1:${server.port}`;
  context.config.publicBaseUrl = origin;
  context.config.issuer = origin;

  try {
    const registration = await fetch(`${origin}/register`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        udap: "1",
        software_statement: buildSoftwareStatement(`${origin}/register`),
      }),
    });
    expect(registration.status).toBe(201);
    const registrationBody = await registration.json();
    await run({
      origin,
      context,
      registeredClientId: registrationBody.client_id,
    });
  } finally {
    server.stop(true);
  }
}

function framework(frameworkUri: string, trustAnchors: string[]) {
  return {
    framework: frameworkUri,
    frameworkType: "udap" as const,
    supportsClientAuth: true,
    supportsIssuerTrust: false,
    cacheTtlSeconds: 3600,
    udap: {
      trustAnchors,
    },
  };
}

function buildSoftwareStatement(
  registrationEndpoint: string,
  overrides: {
    alg?: "ES256" | "RS256";
    iss?: string;
    privateKeyPem?: string;
    x5c?: string[];
    clientName?: string;
    jti?: string;
    scope?: string;
    grantTypes?: string[];
  } = {},
) {
  const iss = overrides.iss ?? "https://client-a.example.org";
  const payload = {
    iss,
    sub: iss,
    aud: registrationEndpoint,
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + 300,
    jti: overrides.jti ?? crypto.randomUUID(),
    client_name: overrides.clientName ?? "UDAP Client A",
    grant_types: overrides.grantTypes ?? ["client_credentials"],
    token_endpoint_auth_method: "private_key_jwt",
    scope: overrides.scope ?? "system/Patient.rs",
    contacts: ["mailto:ops@example.org"],
  };
  const privateKeyPem = overrides.privateKeyPem ?? UDAP_CLIENT_A_KEY_PEM;
  const header = {
    x5c: overrides.x5c ?? x5cForClientACert(),
  };
  return overrides.alg === "RS256"
    ? signRs256JwtWithPem(payload, privateKeyPem, header)
    : signEs256JwtWithPem(payload, privateKeyPem, header);
}

function buildClientAssertion(
  clientId: string,
  tokenEndpoint: string,
  overrides: {
    alg?: "ES256" | "RS256";
    overrideIssSub?: string;
    privateKeyPem?: string;
    x5c?: string[];
    jti?: string;
  } = {},
) {
  const issSub = overrides.overrideIssSub ?? clientId;
  const payload = {
    iss: issSub,
    sub: issSub,
    aud: tokenEndpoint,
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + 300,
    jti: overrides.jti ?? crypto.randomUUID(),
  };
  const privateKeyPem = overrides.privateKeyPem ?? UDAP_CLIENT_A_KEY_PEM;
  const header = {
    x5c: overrides.x5c ?? x5cForClientACert(),
  };
  return overrides.alg === "RS256"
    ? signRs256JwtWithPem(payload, privateKeyPem, header)
    : signEs256JwtWithPem(payload, privateKeyPem, header);
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
  expect(typeof payload.iat).toBe("number");
  expect(typeof payload.exp).toBe("number");
  expect(payload.exp - payload.iat).toBeLessThanOrEqual(365 * 24 * 60 * 60);
  expect(typeof payload.jti).toBe("string");
}

function mintTicket(context: ReturnType<typeof createAppContext>, origin: string) {
  return context.issuers.sign(origin, context.config.defaultPermissionTicketIssuerSlug, {
    iss: `${origin}/issuer/${context.config.defaultPermissionTicketIssuerSlug}`,
    aud: origin,
    exp: Math.floor(Date.now() / 1000) + 3600,
    jti: crypto.randomUUID(),
    ticket_type: PUBLIC_HEALTH_INVESTIGATION_TICKET_TYPE,
    requester: {
      resourceType: "Organization",
      identifier: [{ system: "urn:example:org", value: "public-health-dept" }],
      name: "Public Health Department",
    },
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
    context: {
      kind: "public-health",
      reportable_condition: { text: "Public health investigation" },
    },
  });
}
