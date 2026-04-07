import { describe, expect, test } from "bun:test";

import { PATIENT_SELF_ACCESS_TICKET_TYPE, PERMISSION_TICKET_SUBJECT_TOKEN_TYPE } from "../shared/permission-tickets.ts";
import { signEs256Jwt } from "../src/auth/es256-jwt.ts";
import { buildDefaultFrameworks } from "../src/auth/demo-frameworks.ts";
import type { OidfDemoEntity, OidfDemoTopology } from "../src/auth/frameworks/oidf/demo-topology.ts";
import { OidfFrameworkResolver } from "../src/auth/frameworks/oidf/resolver.ts";
import { createAppContext, startServer } from "../src/app.ts";

const ENTITY_STATEMENT_TYP = "entity-statement+jwt";
const TRUST_MARK_TYP = "trust-mark+jwt";

describe("OIDF issuer trust", () => {
  test("Ticket Issuer trust resolves through the OIDF topology", async () => {
    const { context, server, publicOrigin } = startOidfIssuerTrustServer();
    const origin = `http://127.0.0.1:${server.port}`;
    try {
      const directIssuerTrust = await context.frameworks.resolveIssuerTrust(
        `${publicOrigin}/issuer/${context.config.defaultPermissionTicketIssuerSlug}`,
      );
      expect(directIssuerTrust?.metadata?.trust_mark?.trust_mark_type).toBe(context.oidfTopology.trustMarkType);

      const response = await exchangeTicket(origin, mintOidfIssuerTicket(context, publicOrigin));
      expect(response.status).toBe(200);
      const tokenBody = await response.json();
      const introspection = await introspectToken(origin, tokenBody.access_token);
      expect(introspection.status).toBe(200);
      const introspectionBody = await introspection.json();
      expect(introspectionBody.ticket_issuer_trust).toMatchObject({
        source: "framework",
        issuerUrl: `${publicOrigin}/issuer/${context.config.defaultPermissionTicketIssuerSlug}`,
        displayName: context.config.defaultPermissionTicketIssuerName,
        framework: {
          uri: context.oidfTopology.frameworkUri,
          type: "oidf",
        },
      });
    } finally {
      server.stop(true);
    }
  });

  test("missing trust mark rejects issuer trust", async () => {
    const { context, server, publicOrigin } = startOidfIssuerTrustServer();
    const origin = `http://127.0.0.1:${server.port}`;
    try {
      const ticketIssuer = context.oidfTopology.entities["ticket-issuer"];
      ticketIssuer.trustMarks = [];

      const response = await exchangeTicket(origin, mintOidfIssuerTicket(context, publicOrigin));
      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body.error).toBe("invalid_grant");
      expect(String(body.error_description)).toContain("trust mark");
    } finally {
      server.stop(true);
    }
  });

  test("wrong trust mark type rejects issuer trust", async () => {
    const { context, server, publicOrigin } = startOidfIssuerTrustServer();
    const origin = `http://127.0.0.1:${server.port}`;
    try {
      const now = Math.floor(Date.now() / 1000);
      const provider = context.oidfTopology.entities["provider-network"];
      const ticketIssuer = context.oidfTopology.entities["ticket-issuer"];
      ticketIssuer.trustMarks = [
        signEs256Jwt({
          iss: provider.entityId,
          sub: ticketIssuer.entityId,
          iat: now - 60,
          exp: now + 3600,
          trust_mark_type: `${publicOrigin}/federation/trust-marks/wrong-demo-mark`,
        }, provider.privateJwk, {
          typ: TRUST_MARK_TYP,
          kid: provider.publicJwk.kid,
        }),
      ];

      const response = await exchangeTicket(origin, mintOidfIssuerTicket(context, publicOrigin));
      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body.error).toBe("invalid_grant");
      expect(String(body.error_description)).toContain("trust mark type");
    } finally {
      server.stop(true);
    }
  });

  test("issuer trust fails closed when multiple allowlisted leaves match the same issuer URL", async () => {
    const { context, server, publicOrigin } = startOidfIssuerTrustServer();
    try {
      const oidfFramework = context.config.frameworks.find((framework) => framework.frameworkType === "oidf");
      if (!oidfFramework?.oidf) throw new Error("Missing OIDF framework config");
      oidfFramework.oidf.trustedLeaves.push({
        entityId: `${publicOrigin}/federation/leafs/duplicate-ticket-issuer`,
        usage: "issuer",
        expectedIssuerUrl: `${publicOrigin}/issuer/${context.config.defaultPermissionTicketIssuerSlug}`,
        requiredTrustMarkType: context.oidfTopology.trustMarkType,
      });

      await expect(
        context.frameworks.resolveIssuerTrust(`${publicOrigin}/issuer/${context.config.defaultPermissionTicketIssuerSlug}`),
      ).rejects.toThrow("matches multiple allowlisted leaves");
    } finally {
      server.stop(true);
    }
  });

  test("demo issuer trust uses INTERNAL_BASE_URL only for self-origin loopback", async () => {
    const { context, server, publicOrigin } = startOidfIssuerTrustServer();
    const seenUrls: string[] = [];
    const resolver = new OidfFrameworkResolver(
      context.config.frameworks,
      context.config,
      async (input, init) => {
        const targetUrl = typeof input === "string" ? input : input.url;
        seenUrls.push(targetUrl);
        return fetch(input, init);
      },
    );
    try {
      const issuerTrust = await resolver.resolveIssuerTrust(
        `${publicOrigin}/issuer/${context.config.defaultPermissionTicketIssuerSlug}`,
      );
      expect(issuerTrust?.framework?.type).toBe("oidf");
      expect(seenUrls.length).toBeGreaterThan(0);
      const internalOrigin = new URL(context.config.internalBaseUrl!).origin;
      expect(seenUrls.every((url) => new URL(url).origin === internalOrigin)).toBe(true);
    } finally {
      server.stop(true);
    }
  });
});

function startOidfIssuerTrustServer() {
  const publicOrigin = "https://tickets.example.test";
  const context = createAppContext({
    port: 0,
    publicBaseUrl: publicOrigin,
    issuer: publicOrigin,
    frameworks: buildDefaultFrameworks(publicOrigin, "reference-demo"),
  });
  const server = startServer(context, 0);
  context.config.internalBaseUrl = `http://127.0.0.1:${server.port}`;
  return { context, server, publicOrigin };
}

function mintOidfIssuerTicket(appContext: ReturnType<typeof createAppContext>, publicOrigin: string) {
  return appContext.issuers.sign(publicOrigin, appContext.config.defaultPermissionTicketIssuerSlug, {
    iss: `${publicOrigin}/issuer/${appContext.config.defaultPermissionTicketIssuerSlug}`,
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

function introspectToken(origin: string, accessToken: string) {
  return fetch(`${origin}/modes/open/introspect`, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      token: accessToken,
    }),
  });
}
