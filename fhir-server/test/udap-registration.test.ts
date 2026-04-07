import { describe, expect, test } from "bun:test";

import { signEs256JwtWithPem, signRs256JwtWithPem } from "../src/auth/x509-jwt.ts";
import { createAppContext, startServer } from "../src/app.ts";
import {
  UDAP_CLIENT_A_KEY_PEM,
  UDAP_CLIENT_B_KEY_PEM,
  UDAP_RSA_CLIENT_KEY_PEM,
  UDAP_RSA_ROOT_CERT_PEM,
  UDAP_ROOT_A_CERT_PEM,
  UDAP_ROOT_B_CERT_PEM,
  x5cForClientACert,
  x5cForClientBCert,
  x5cForRs256ClientCert,
} from "./fixtures/udap-fixtures.ts";

describe("UDAP registration", () => {
  test("accepts a trusted UDAP software statement and returns a stable server-assigned client_id", async () => {
    await withUdapHarness(
      [
        framework("https://example.org/frameworks/tefca", [UDAP_ROOT_A_CERT_PEM]),
        framework("https://example.org/frameworks/other-community", [UDAP_ROOT_B_CERT_PEM]),
      ],
      async ({ origin, context }) => {
        const firstStatement = buildSoftwareStatement(`${origin}/register`, {
          clientName: "UDAP Client A",
        });
        const first = await postRegistration(`${origin}/register`, firstStatement);
        expect(first.status).toBe(201);
        const firstBody = await first.json();
        expect(String(firstBody.client_id)).toStartWith("udap:");
        expect(firstBody.client_name).toBe("UDAP Client A");
        expect(firstBody.token_endpoint_auth_method).toBe("private_key_jwt");
        expect(firstBody.software_statement).toBe(firstStatement);

        const secondStatement = buildSoftwareStatement(`${origin}/register`, {
          clientName: "UDAP Client A Renamed",
        });
        const second = await postRegistration(`${origin}/register`, secondStatement);
        expect(second.status).toBe(201);
        const secondBody = await second.json();
        expect(secondBody.client_id).toBe(firstBody.client_id);

        const registered = context.clients.get(firstBody.client_id);
        expect(registered?.frameworkBinding).toEqual({
          method: "framework_client",
          framework: "https://example.org/frameworks/tefca",
          framework_type: "udap",
          entity_uri: "https://client-a.example.org",
        });
      },
    );
  });

  test("rejects untrusted certificate chains with unapproved_software_statement", async () => {
    await withUdapHarness([framework("https://example.org/frameworks/tefca", [UDAP_ROOT_A_CERT_PEM])], async ({ origin }) => {
      const response = await postRegistration(`${origin}/register`, buildSoftwareStatement(`${origin}/register`, {
        clientName: "UDAP Client B",
        privateKeyPem: UDAP_CLIENT_B_KEY_PEM,
        x5c: x5cForClientBCert(),
        iss: "https://client-b.example.org",
      }));
      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body.error).toBe("unapproved_software_statement");
    });
  });

  test("rejects invalid software-statement signatures", async () => {
    await withUdapHarness([framework("https://example.org/frameworks/tefca", [UDAP_ROOT_A_CERT_PEM])], async ({ origin }) => {
      const response = await postRegistration(`${origin}/register`, buildSoftwareStatement(`${origin}/register`, {
        clientName: "Bad Signature",
        privateKeyPem: UDAP_CLIENT_B_KEY_PEM,
      }));
      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body.error).toBe("invalid_software_statement");
    });
  });

  test("rejects malformed software statements with invalid_software_statement", async () => {
    await withUdapHarness([framework("https://example.org/frameworks/tefca", [UDAP_ROOT_A_CERT_PEM])], async ({ origin }) => {
      const response = await postRegistration(`${origin}/register`, "not-a-jwt");
      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body.error).toBe("invalid_software_statement");
      expect(body.error_description).toContain("Malformed JWT");
    });
  });

  test("rejects malformed x5c headers with invalid_software_statement", async () => {
    await withUdapHarness([framework("https://example.org/frameworks/tefca", [UDAP_ROOT_A_CERT_PEM])], async ({ origin }) => {
      const now = Math.floor(Date.now() / 1000);
      const softwareStatement = signEs256JwtWithPem(
        {
          iss: "https://client-a.example.org",
          sub: "https://client-a.example.org",
          aud: `${origin}/register`,
          iat: now,
          exp: now + 300,
          jti: crypto.randomUUID(),
          client_name: "Broken x5c",
          grant_types: ["client_credentials"],
          token_endpoint_auth_method: "private_key_jwt",
          scope: "system/Patient.rs",
        },
        UDAP_CLIENT_A_KEY_PEM,
        {
          x5c: ["%%%not-base64%%%"],
        },
      );
      const response = await postRegistration(`${origin}/register`, softwareStatement);
      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body.error).toBe("invalid_software_statement");
    });
  });

  test("rejects SAN URI mismatches in the software statement", async () => {
    await withUdapHarness([framework("https://example.org/frameworks/tefca", [UDAP_ROOT_A_CERT_PEM])], async ({ origin }) => {
      const response = await postRegistration(`${origin}/register`, buildSoftwareStatement(`${origin}/register`, {
        iss: "https://wrong-client.example.org",
      }));
      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body.error).toBe("invalid_software_statement");
      expect(body.error_description).toContain("URI SAN");
    });
  });

  test("rejects ambiguous UDAP framework matches", async () => {
    await withUdapHarness(
      [
        framework("https://example.org/frameworks/tefca", [UDAP_ROOT_A_CERT_PEM]),
        framework("https://example.org/frameworks/tefca-duplicate", [UDAP_ROOT_A_CERT_PEM]),
      ],
      async ({ origin }) => {
        const response = await postRegistration(`${origin}/register`, buildSoftwareStatement(`${origin}/register`));
        expect(response.status).toBe(400);
        const body = await response.json();
        expect(body.error).toBe("unapproved_software_statement");
        expect(body.error_description).toContain("multiple UDAP frameworks");
      },
    );
  });

  test("accepts RS256-signed software statements when the certificate chain is trusted", async () => {
    await withUdapHarness([framework("https://example.org/frameworks/rsa-community", [UDAP_RSA_ROOT_CERT_PEM])], async ({ origin, context }) => {
      const statement = buildSoftwareStatement(`${origin}/register`, {
        alg: "RS256",
        clientName: "UDAP RSA Client",
        iss: "https://rs256-client.example.org",
        privateKeyPem: UDAP_RSA_CLIENT_KEY_PEM,
        x5c: x5cForRs256ClientCert(),
      });
      const response = await postRegistration(`${origin}/register`, statement);
      expect(response.status).toBe(201);
      const body = await response.json();
      expect(String(body.client_id)).toStartWith("udap:");
      expect(body.client_name).toBe("UDAP RSA Client");

      const registered = context.clients.get(body.client_id);
      expect(registered?.frameworkBinding).toEqual({
        method: "framework_client",
        framework: "https://example.org/frameworks/rsa-community",
        framework_type: "udap",
        entity_uri: "https://rs256-client.example.org",
      });
    });
  });

  test("rejects replayed UDAP software statements", async () => {
    await withUdapHarness([framework("https://example.org/frameworks/tefca", [UDAP_ROOT_A_CERT_PEM])], async ({ origin }) => {
      const statement = buildSoftwareStatement(`${origin}/register`, {
        clientName: "Replay Test Client",
        jti: "replay-jti-1",
      });

      const first = await postRegistration(`${origin}/register`, statement);
      expect(first.status).toBe(201);

      const second = await postRegistration(`${origin}/register`, statement);
      expect(second.status).toBe(400);
      const body = await second.json();
      expect(body.error).toBe("invalid_software_statement");
      expect(body.error_description).toContain("already been used");
    });
  });

  test("re-registration with a new client descriptor supersedes the previous UDAP client_id", async () => {
    await withUdapHarness([framework("https://example.org/frameworks/tefca", [UDAP_ROOT_A_CERT_PEM])], async ({ origin }) => {
      const first = await postRegistration(`${origin}/register`, buildSoftwareStatement(`${origin}/register`, {
        clientName: "UDAP Client A",
        scope: "system/Patient.rs",
        jti: "supersede-1",
      }));
      expect(first.status).toBe(201);
      const firstBody = await first.json();

      const second = await postRegistration(`${origin}/register`, buildSoftwareStatement(`${origin}/register`, {
        clientName: "UDAP Client A",
        scope: "system/Observation.rs",
        jti: "supersede-2",
      }));
      expect(second.status).toBe(201);
      const secondBody = await second.json();

      expect(secondBody.client_id).not.toBe(firstBody.client_id);
    });
  });

  test("empty grant_types cancels the active UDAP registration", async () => {
    await withUdapHarness([framework("https://example.org/frameworks/tefca", [UDAP_ROOT_A_CERT_PEM])], async ({ origin, context }) => {
      const registration = await postRegistration(`${origin}/register`, buildSoftwareStatement(`${origin}/register`, {
        clientName: "Cancelable Client",
        jti: "cancel-register",
      }));
      expect(registration.status).toBe(201);
      const registrationBody = await registration.json();
      expect(context.clients.get(registrationBody.client_id)).not.toBeNull();

      const cancellation = await postRegistration(`${origin}/register`, buildSoftwareStatement(`${origin}/register`, {
        grantTypes: [""],
        clientName: "Cancelable Client",
        jti: "cancel-request",
      }));
      expect(cancellation.status).toBe(200);
      const cancellationBody = await cancellation.json();
      expect(cancellationBody.grant_types).toEqual([""]);

      expect(context.clients.get(registrationBody.client_id)).toBeNull();
    });
  });
});

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

async function withUdapHarness(
  frameworks: ReturnType<typeof framework>[],
  run: (harness: {
    origin: string;
    context: ReturnType<typeof createAppContext>;
  }) => Promise<void>,
) {
  const context = createAppContext({
    port: 0,
    frameworks,
  });
  const server = startServer(context, 0);
  const origin = `http://127.0.0.1:${server.port}`;
  context.config.publicBaseUrl = origin;
  context.config.issuer = origin;

  try {
    await run({ origin, context });
  } finally {
    server.stop(true);
  }
}

async function postRegistration(url: string, softwareStatement: string) {
  return fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify({
      udap: "1",
      software_statement: softwareStatement,
    }),
  });
}

function buildSoftwareStatement(
  registrationEndpoint: string,
  overrides: {
    alg?: "ES256" | "RS256";
    clientName?: string;
    iss?: string;
    privateKeyPem?: string;
    x5c?: string[];
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
