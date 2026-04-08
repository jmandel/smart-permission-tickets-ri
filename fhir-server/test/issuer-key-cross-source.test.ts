import { describe, expect, test } from "bun:test";

import { generateClientKeyMaterial } from "../shared/private-key-jwt.ts";
import { PATIENT_SELF_ACCESS_TICKET_TYPE, PERMISSION_TICKET_SUBJECT_TOKEN_TYPE } from "../shared/permission-tickets.ts";
import { buildDefaultFrameworks } from "../src/auth/demo-frameworks.ts";
import { createAppContext, startServer } from "../src/app.ts";

describe("issuer key cross-source consistency", () => {
  test("direct JWKS + OIDF agreement passes", async () => {
    const { context, origin, publicOrigin, server } = startCrossSourceHarness();
    try {
      const response = await exchangeTicket(origin, mintTicket(context, publicOrigin));
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(typeof body.access_token).toBe("string");
    } finally {
      server.stop(true);
    }
  });

  test("direct JWKS + OIDF disagreement on the JWT kid fails closed", async () => {
    const { context, origin, publicOrigin, server } = startCrossSourceHarness();
    try {
      const directIssuer = context.issuers.get(context.config.defaultPermissionTicketIssuerSlug);
      if (!directIssuer) throw new Error("Missing direct issuer");

      const alternate = await generateClientKeyMaterial();
      context.oidfTopology.entities["ticket-issuer"].privateJwk = alternate.privateJwk;
      context.oidfTopology.entities["ticket-issuer"].publicJwk = {
        ...alternate.publicJwk,
        kid: directIssuer.kid,
      };

      const response = await exchangeTicket(origin, mintTicket(context, publicOrigin));
      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body.error).toBe("invalid_grant");
      expect(String(body.error_description)).toContain(`OIDF issuer key for kid ${directIssuer.kid} disagrees with direct JWKS`);
    } finally {
      server.stop(true);
    }
  });

  test("direct JWKS + OIDF disagreement on a different kid does not fail the ticket", async () => {
    const { context, origin, publicOrigin, server } = startCrossSourceHarness();
    try {
      const alternate = await generateClientKeyMaterial();
      context.oidfTopology.entities["ticket-issuer"].privateJwk = alternate.privateJwk;
      context.oidfTopology.entities["ticket-issuer"].publicJwk = {
        ...alternate.publicJwk,
        kid: alternate.thumbprint,
      };

      const response = await exchangeTicket(origin, mintTicket(context, publicOrigin));
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(typeof body.access_token).toBe("string");
    } finally {
      server.stop(true);
    }
  });
});

function startCrossSourceHarness() {
  const publicOrigin = "https://tickets.example.test";
  const context = createAppContext({
    port: 0,
    publicBaseUrl: publicOrigin,
    issuer: publicOrigin,
    frameworks: buildDefaultFrameworks(publicOrigin, "reference-demo"),
    issuerTrust: {
      policies: [
        {
          type: "direct_jwks",
          trustedIssuers: [`${publicOrigin}/issuer/reference-demo`],
        },
        {
          type: "oidf",
        },
      ],
    },
  });
  const server = startServer(context, 0);
  const origin = `http://127.0.0.1:${server.port}`;
  context.config.internalBaseUrl = origin;
  return { context, server, origin, publicOrigin };
}

function mintTicket(context: ReturnType<typeof createAppContext>, publicOrigin: string) {
  return context.issuers.sign(publicOrigin, context.config.defaultPermissionTicketIssuerSlug, {
    iss: `${publicOrigin}/issuer/${context.config.defaultPermissionTicketIssuerSlug}`,
    aud: publicOrigin,
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
  });
}

function exchangeTicket(origin: string, ticket: string) {
  return fetch(`${origin}/modes/open/token`, {
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
}
