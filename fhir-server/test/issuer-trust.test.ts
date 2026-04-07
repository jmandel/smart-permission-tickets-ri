import { describe, expect, test } from "bun:test";

import { generateClientKeyMaterial } from "../shared/private-key-jwt.ts";
import {
  PERMISSION_TICKET_SUBJECT_TOKEN_TYPE,
  PUBLIC_HEALTH_INVESTIGATION_TICKET_TYPE,
} from "../shared/permission-tickets.ts";
import { computeEcJwkThumbprintSync, signEs256Jwt } from "../src/auth/es256-jwt.ts";
import { createAppContext, startServer } from "../src/app.ts";

describe("framework-backed issuer trust", () => {
  test("open-mode token exchange accepts a well-known issuer trusted through the shared framework registry", async () => {
    const issuerKeys = await generateClientKeyMaterial();
    const issuerKid = computeEcJwkThumbprintSync(issuerKeys.publicJwk);

    const jwksServer = Bun.serve({
      port: 0,
      fetch(request) {
        const url = new URL(request.url);
        if (url.pathname === "/demo/issuer-a/.well-known/jwks.json") {
          return jsonResponse({
            keys: [{ ...issuerKeys.publicJwk, kid: issuerKid }],
          });
        }
        return new Response("Not found", { status: 404 });
      },
    });

    const issuerOrigin = `http://127.0.0.1:${jwksServer.port}`;
    const issuerUrl = `${issuerOrigin}/demo/issuer-a`;
    const context = createAppContext({
      port: 0,
      frameworks: [
        {
          framework: "https://example.org/frameworks/smart-health-issuers",
          frameworkType: "well-known",
          supportsClientAuth: false,
          supportsIssuerTrust: true,
          cacheTtlSeconds: 60,
          wellKnown: {
            allowlist: [issuerUrl],
            jwksRelativePath: "/.well-known/jwks.json",
          },
        },
      ],
    });
    const server = startServer(context, 0);
    const origin = `http://127.0.0.1:${server.port}`;
    context.config.publicBaseUrl = origin;
    context.config.issuer = origin;

    try {
      const ticket = signEs256Jwt(
        {
          iss: issuerUrl,
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
        },
        issuerKeys.privateJwk,
        { kid: issuerKid },
      );

      const tokenResponse = await fetch(`${origin}/modes/open/token`, {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({
          grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
          subject_token_type: PERMISSION_TICKET_SUBJECT_TOKEN_TYPE,
          subject_token: ticket,
        }),
      });
      expect(tokenResponse.status).toBe(200);
      const tokenBody = await tokenResponse.json();
      expect(typeof tokenBody.access_token).toBe("string");

      const introspectionResponse = await fetch(`${origin}/modes/open/introspect`, {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({
          token: tokenBody.access_token,
        }),
      });
      expect(introspectionResponse.status).toBe(200);
      const introspectionBody = await introspectionResponse.json();
      expect(introspectionBody.active).toBe(true);
      expect(introspectionBody.ticket_issuer_trust).toEqual({
        source: "framework",
        issuerUrl,
        displayName: issuerUrl,
        framework: {
          uri: "https://example.org/frameworks/smart-health-issuers",
          type: "well-known",
        },
      });
    } finally {
      server.stop(true);
      jwksServer.stop(true);
    }
  });
});

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json",
      ...headers,
    },
  });
}
