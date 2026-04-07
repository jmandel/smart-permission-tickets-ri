import { describe, expect, test } from "bun:test";

import { generateClientKeyMaterial, signPrivateKeyJwt, type ClientKeyMaterial } from "../shared/private-key-jwt.ts";
import {
  NETWORK_PATIENT_ACCESS_TICKET_TYPE,
  PERMISSION_TICKET_SUBJECT_TOKEN_TYPE,
  PUBLIC_HEALTH_INVESTIGATION_TICKET_TYPE,
} from "../shared/permission-tickets.ts";
import { createAppContext, startServer } from "../src/app.ts";

describe("framework-aware client auth", () => {
  test("smart config advertises supported trust frameworks and binding types", async () => {
    await withFrameworkHarness(async ({ appOrigin }) => {
      const response = await fetch(`${appOrigin}/.well-known/smart-configuration`);
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.extensions["https://smarthealthit.org/smart-permission-tickets/smart-configuration"].supported_client_binding_types).toContain("presenter_binding.framework_client");
      expect(body.extensions["https://smarthealthit.org/smart-permission-tickets/smart-configuration"].supported_trust_frameworks).toEqual([
        {
          framework: "https://example.org/frameworks/smart-health-issuers",
          framework_type: "well-known",
        },
      ]);
    });
  });

  test("strict token exchange accepts a framework-affiliated well-known client bound by presenter_binding.framework_client", async () => {
    await withFrameworkHarness(async ({ appOrigin, appContext, frameworkEntityUri, frameworkClientKeys }) => {
      const ticket = mintTicket(appContext, appOrigin, {
        frameworkClientBinding: {
          framework: "https://example.org/frameworks/smart-health-issuers",
          framework_type: "well-known",
          entity_uri: frameworkEntityUri,
        },
      });
      const response = await postWellKnownToken(`${appOrigin}/token`, frameworkEntityUri, frameworkClientKeys.privateJwk, ticket);
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(typeof body.access_token).toBe("string");
    });
  });

  test("strict token exchange accepts an unaffiliated well-known client when no framework binding is required", async () => {
    await withFrameworkHarness(async ({ appOrigin, appContext, unlistedEntityUri, unlistedClientKeys }) => {
      const response = await postWellKnownToken(`${appOrigin}/token`, unlistedEntityUri, unlistedClientKeys.privateJwk, mintTicket(appContext, appOrigin, {}));
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(typeof body.access_token).toBe("string");
    });
  });

  test("ticket presenter binding mismatch rejects a well-known client with invalid_grant", async () => {
    await withFrameworkHarness(async ({ appOrigin, appContext, frameworkEntityUri, frameworkClientKeys }) => {
      const mismatchedTicket = mintTicket(appContext, appOrigin, {
        frameworkClientBinding: {
          framework: "https://example.org/frameworks/other",
          framework_type: "well-known",
          entity_uri: frameworkEntityUri,
        },
      });
      const response = await postWellKnownToken(`${appOrigin}/token`, frameworkEntityUri, frameworkClientKeys.privateJwk, mismatchedTicket);
      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body.error).toBe("invalid_grant");
      expect(body.error_description).toContain("Ticket presenter binding requires framework https://example.org/frameworks/other entity");
    });
  });

  test("framework audience identifiers are accepted when the server is configured as a local member", async () => {
    await withFrameworkHarness(async ({ appOrigin, appContext, frameworkEntityUri, frameworkClientKeys }) => {
      appContext.config.frameworks[0]!.localAudienceMembership = { entityUri: appOrigin };
      const ticket = mintTicket(appContext, appOrigin, {
        aud: "https://example.org/frameworks/smart-health-issuers",
        frameworkClientBinding: {
          framework: "https://example.org/frameworks/smart-health-issuers",
          framework_type: "well-known",
          entity_uri: frameworkEntityUri,
        },
      });
      const response = await postWellKnownToken(`${appOrigin}/token`, frameworkEntityUri, frameworkClientKeys.privateJwk, ticket);
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(typeof body.access_token).toBe("string");
    });
  });

  test("well-known client auth rejects JWKS fetch failures and malformed JWKS responses", async () => {
    await withFrameworkHarness(async ({ appOrigin, appContext, frameworkEntityUri, frameworkClientKeys }) => {
      const missingJwks = await postWellKnownToken(`${appOrigin}/token`, frameworkEntityUri, frameworkClientKeys.privateJwk, mintTicket(appContext, appOrigin, {}));
      expect(missingJwks.status).toBe(401);
      const missingBody = await missingJwks.json();
      expect(missingBody.error).toBe("invalid_client");
      expect(missingBody.error_description).toContain("Unable to retrieve well-known JWKS (404)");
    }, {
      frameworkEntityPath: "/demo/missing-client",
      frameworkEntityHandler: () => new Response("Not found", { status: 404 }),
    });

    await withFrameworkHarness(async ({ appOrigin, appContext, frameworkEntityUri, frameworkClientKeys }) => {
      const nonJson = await postWellKnownToken(`${appOrigin}/token`, frameworkEntityUri, frameworkClientKeys.privateJwk, mintTicket(appContext, appOrigin, {}));
      expect(nonJson.status).toBe(401);
      const nonJsonBody = await nonJson.json();
      expect(nonJsonBody.error).toBe("invalid_client");
      expect(nonJsonBody.error_description).toContain("Unable to parse well-known JWKS");
    }, {
      frameworkEntityPath: "/demo/nonjson-client",
      frameworkEntityHandler: () => new Response("not-json", {
        status: 200,
        headers: { "content-type": "text/plain" },
      }),
    });

    await withFrameworkHarness(async ({ appOrigin, appContext, frameworkEntityUri, frameworkClientKeys }) => {
      const emptyKeys = await postWellKnownToken(`${appOrigin}/token`, frameworkEntityUri, frameworkClientKeys.privateJwk, mintTicket(appContext, appOrigin, {}));
      expect(emptyKeys.status).toBe(401);
      const emptyBody = await emptyKeys.json();
      expect(emptyBody.error).toBe("invalid_client");
      expect(emptyBody.error_description).toContain("did not include any keys");
    }, {
      frameworkEntityPath: "/demo/empty-client",
      frameworkEntityHandler: () => jsonResponse({ keys: [] }),
    });
  });

  test("well-known client assertions reject wrong audience and future iat", async () => {
    await withFrameworkHarness(async ({ appOrigin, appContext, frameworkEntityUri, frameworkClientKeys }) => {
      const wrongAudience = await postWellKnownToken(
        `${appOrigin}/token`,
        frameworkEntityUri,
        frameworkClientKeys.privateJwk,
        mintTicket(appContext, appOrigin, {}),
        { assertionAud: `${appOrigin}/wrong-token-endpoint` },
      );
      expect(wrongAudience.status).toBe(401);
      const wrongAudienceBody = await wrongAudience.json();
      expect(wrongAudienceBody.error).toBe("invalid_client");
      expect(wrongAudienceBody.error_description).toContain("audience mismatch");

      const futureIssuedAt = await postWellKnownToken(
        `${appOrigin}/token`,
        frameworkEntityUri,
        frameworkClientKeys.privateJwk,
        mintTicket(appContext, appOrigin, {}),
        { assertionIat: Math.floor(Date.now() / 1000) + 120 },
      );
      expect(futureIssuedAt.status).toBe(401);
      const futureIatBody = await futureIssuedAt.json();
      expect(futureIatBody.error).toBe("invalid_client");
      expect(futureIatBody.error_description).toContain("issued in the future");
    });
  });
});

async function withFrameworkHarness(
  run: (harness: {
    appContext: ReturnType<typeof createAppContext>;
    appOrigin: string;
    frameworkEntityUri: string;
    unlistedEntityUri: string;
    frameworkClientKeys: ClientKeyMaterial;
    unlistedClientKeys: ClientKeyMaterial;
  }) => Promise<void>,
  options?: {
    frameworkEntityPath?: string;
    frameworkEntityHandler?: () => Response;
  },
) {
  const frameworkClientKeys = await generateClientKeyMaterial();
  const unlistedClientKeys = await generateClientKeyMaterial();
  const jwksServer = Bun.serve({
    port: 0,
    fetch(request) {
      const url = new URL(request.url);
      const frameworkEntityPath = options?.frameworkEntityPath ?? "/demo/client-a";
      if (url.pathname === `${frameworkEntityPath}/.well-known/jwks.json`) {
        if (options?.frameworkEntityHandler) return options.frameworkEntityHandler();
        return jsonResponse({ keys: [frameworkClientKeys.publicJwk] }, 200, { "cache-control": "max-age=30" });
      }
      if (url.pathname === "/demo/unlisted-client/.well-known/jwks.json") {
        return jsonResponse({ keys: [unlistedClientKeys.publicJwk] }, 200);
      }
      return new Response("Not found", { status: 404 });
    },
  });
  const jwksOrigin = `http://127.0.0.1:${jwksServer.port}`;
  const frameworkEntityPath = options?.frameworkEntityPath ?? "/demo/client-a";
  const frameworkEntityUri = `${jwksOrigin}${frameworkEntityPath}`;
  const unlistedEntityUri = `${jwksOrigin}/demo/unlisted-client`;

  const appContext = createAppContext({
    port: 0,
    frameworks: [
      {
        framework: "https://example.org/frameworks/smart-health-issuers",
        frameworkType: "well-known",
        supportsClientAuth: true,
        supportsIssuerTrust: false,
        cacheTtlSeconds: 60,
        wellKnown: {
          allowlist: [frameworkEntityUri],
          jwksRelativePath: "/.well-known/jwks.json",
        },
      },
    ],
  });
  const appServer = startServer(appContext, 0);
  const appOrigin = `http://127.0.0.1:${appServer.port}`;
  appContext.config.publicBaseUrl = appOrigin;
  appContext.config.issuer = appOrigin;

  try {
    await run({
      appContext,
      appOrigin,
      frameworkEntityUri,
      unlistedEntityUri,
      frameworkClientKeys,
      unlistedClientKeys,
    });
  } finally {
    appServer.stop(true);
    jwksServer.stop(true);
  }
}

function mintTicket(
  appContext: ReturnType<typeof createAppContext>,
  appOrigin: string,
  input: { aud?: string | string[]; frameworkClientBinding?: Record<string, string> },
) {
  const ticketType = input.frameworkClientBinding ? NETWORK_PATIENT_ACCESS_TICKET_TYPE : PUBLIC_HEALTH_INVESTIGATION_TICKET_TYPE;
  return appContext.issuers.sign(appOrigin, appContext.config.defaultPermissionTicketIssuerSlug, {
    iss: `${appOrigin}/issuer/${appContext.config.defaultPermissionTicketIssuerSlug}`,
    aud: input.aud ?? appOrigin,
    exp: Math.floor(Date.now() / 1000) + 3600,
    jti: crypto.randomUUID(),
    ticket_type: ticketType,
    ...(input.frameworkClientBinding ? { presenter_binding: { framework_client: input.frameworkClientBinding } } : {}),
    ...(ticketType === PUBLIC_HEALTH_INVESTIGATION_TICKET_TYPE
      ? {
          requester: {
            resourceType: "Organization",
            identifier: [{ system: "urn:example:org", value: "public-health-dept" }],
            name: "Public Health Department",
          },
        }
      : {}),
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
    context: ticketType === PUBLIC_HEALTH_INVESTIGATION_TICKET_TYPE
      ? {
          kind: "public-health",
          reportable_condition: { text: "Public health investigation" },
        }
      : {
          kind: "patient-access",
        },
  });
}

async function postWellKnownToken(
  url: string,
  entityUri: string,
  privateJwk: JsonWebKey,
  ticket: string,
  options?: { assertionAud?: string; assertionIat?: number; assertionExp?: number },
) {
  const clientId = `well-known:${entityUri}`;
  return fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
      subject_token_type: PERMISSION_TICKET_SUBJECT_TOKEN_TYPE,
      subject_token: ticket,
      client_id: clientId,
      client_assertion_type: "urn:ietf:params:oauth:client-assertion-type:jwt-bearer",
      client_assertion: await buildClientAssertion(clientId, privateJwk, url, options),
    }),
  });
}

async function buildClientAssertion(
  clientId: string,
  privateJwk: JsonWebKey,
  audience: string,
  options?: { assertionAud?: string; assertionIat?: number; assertionExp?: number },
) {
  const now = Math.floor(Date.now() / 1000);
  const assertionIat = options?.assertionIat ?? now;
  return signPrivateKeyJwt(
    {
      iss: clientId,
      sub: clientId,
      aud: options?.assertionAud ?? audience,
      iat: assertionIat,
      exp: options?.assertionExp ?? (assertionIat + 300),
      jti: crypto.randomUUID(),
    },
    privateJwk,
  );
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
