import { describe, expect, test } from "bun:test";

import { signPrivateKeyJwt } from "../shared/private-key-jwt.ts";
import {
  PATIENT_SELF_ACCESS_TICKET_TYPE,
  PERMISSION_TICKET_SUBJECT_TOKEN_TYPE,
} from "../shared/permission-tickets.ts";
import { DEFAULT_DEMO_OIDF_FRAMEWORK_URI, buildDefaultFrameworks } from "../src/auth/demo-frameworks.ts";
import { buildOidfTrustChain } from "../src/auth/frameworks/oidf/demo-topology.ts";
import { SMART_PERMISSION_TICKET_ISSUER_ENTITY_TYPE } from "../src/auth/frameworks/oidf/smart-permission-ticket-issuer.ts";
import { createAppContext, startServer } from "../src/app.ts";

describe("OIDF client authentication", () => {
  test("unknown URL client_id authenticates successfully when a valid trust_chain header is supplied", async () => {
    const { context, server, origin, publicOrigin } = startOidfAuthServer();
    try {
      const ticket = mintOidfTicket(context, publicOrigin);
      const response = await postOidfToken(origin, context, ticket);
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(typeof body.access_token).toBe("string");
    } finally {
      server.stop(true);
    }
  });

  test("resolved client_name comes from metadata policy, not just the leaf metadata", async () => {
    const { context, server } = startOidfAuthServer();
    try {
      const tokenEndpointUrl = `${context.config.publicBaseUrl}/token`;
      const assertion = await buildOidfClientAssertion(context, tokenEndpointUrl, { withTrustChain: true });
      const identity = await context.frameworks.authenticateClientAssertion(
        context.oidfTopology.demoAppEntityId,
        assertion,
        tokenEndpointUrl,
      );
      expect(identity?.authMode).toBe("oidf");
      expect(identity?.clientName).toBe("OpenID Federation Demo App");
    } finally {
      server.stop(true);
    }
  });

  test("OIDF dispatch wins based on trust_chain header even though the client_id is a URL", async () => {
    const { context, server } = startOidfAuthServer();
    try {
      const tokenEndpointUrl = `${context.config.publicBaseUrl}/token`;
      const assertion = await buildOidfClientAssertion(context, tokenEndpointUrl, { withTrustChain: true });
      const identity = await context.frameworks.authenticateClientAssertion(
        context.oidfTopology.demoAppEntityId,
        assertion,
        tokenEndpointUrl,
      );
      expect(identity?.frameworkBinding?.framework_type).toBe("oidf");
      expect(identity?.frameworkBinding?.entity_uri).toBe(context.oidfTopology.demoAppEntityId);
    } finally {
      server.stop(true);
    }
  });

  test("a URL client_id without trust_chain continues to follow the non-OIDF path", async () => {
    const { context, server, origin, publicOrigin } = startOidfAuthServer();
    try {
      const ticket = mintOidfTicket(context, publicOrigin);
      const response = await postOidfToken(origin, context, ticket, { withTrustChain: false });
      expect(response.status).toBe(401);
      const body = await response.json();
      expect(body.error).toBe("invalid_client");
      expect(String(body.error_description)).toContain("Authenticated registered client required");
    } finally {
      server.stop(true);
    }
  });

  test("a valid trust chain is rejected when the leaf is not allowlisted for client usage", async () => {
    const { context, server } = startOidfAuthServer();
    try {
      const oidfFramework = context.config.frameworks.find((framework) => framework.frameworkType === "oidf");
      if (!oidfFramework?.oidf) throw new Error("Missing OIDF framework config");
      oidfFramework.oidf.trustedLeaves = oidfFramework.oidf.trustedLeaves.filter((leaf) => leaf.entityId !== context.oidfTopology.demoAppEntityId);

      const tokenEndpointUrl = `${context.config.publicBaseUrl}/token`;
      const assertion = await buildOidfClientAssertion(context, tokenEndpointUrl, { withTrustChain: true });
      await expect(
        context.frameworks.authenticateClientAssertion(
          context.oidfTopology.demoAppEntityId,
          assertion,
          tokenEndpointUrl,
        ),
      ).rejects.toThrow("not allowlisted for client authentication");
    } finally {
      server.stop(true);
    }
  });

  test("a trust chain under an unconfigured anchor is rejected clearly", async () => {
    const { context, server, publicOrigin } = startOidfAuthServer();
    try {
      const oidfFramework = context.config.frameworks.find((framework) => framework.frameworkType === "oidf");
      if (!oidfFramework?.oidf) throw new Error("Missing OIDF framework config");
      oidfFramework.oidf.trustAnchors = [{
        entityId: `${publicOrigin}/federation/anchors/other`,
        jwks: [context.oidfTopology.entities.anchor.publicJwk],
      }];

      const tokenEndpointUrl = `${context.config.publicBaseUrl}/token`;
      const assertion = await buildOidfClientAssertion(context, tokenEndpointUrl, { withTrustChain: true });
      await expect(
        context.frameworks.authenticateClientAssertion(
          context.oidfTopology.demoAppEntityId,
          assertion,
          tokenEndpointUrl,
        ),
      ).rejects.toThrow("did not validate against any configured trust anchor");
    } finally {
      server.stop(true);
    }
  });

  test("client auth ignores smart_permission_ticket_issuer metadata on the client leaf", async () => {
    const { context, server } = startOidfAuthServer();
    try {
      context.oidfTopology.entities["demo-app"].metadata[SMART_PERMISSION_TICKET_ISSUER_ENTITY_TYPE] = {
        issuer_url: 7,
        jwks: null,
      };

      const tokenEndpointUrl = `${context.config.publicBaseUrl}/token`;
      const assertion = await buildOidfClientAssertion(context, tokenEndpointUrl, { withTrustChain: true });
      const identity = await context.frameworks.authenticateClientAssertion(
        context.oidfTopology.demoAppEntityId,
        assertion,
        tokenEndpointUrl,
      );

      expect(identity?.authMode).toBe("oidf");
      expect(identity?.clientId).toBe(context.oidfTopology.demoAppEntityId);
    } finally {
      server.stop(true);
    }
  });
});

function startOidfAuthServer() {
  const publicOrigin = "https://tickets.example.test";
  const context = createAppContext({
    port: 0,
    publicBaseUrl: publicOrigin,
    issuer: publicOrigin,
    frameworks: buildDefaultFrameworks(publicOrigin, "reference-demo"),
  });
  const server = startServer(context, 0);
  const origin = `http://127.0.0.1:${server.port}`;
  context.config.internalBaseUrl = origin;
  return { context, server, origin, publicOrigin };
}

function mintOidfTicket(appContext: ReturnType<typeof createAppContext>, publicOrigin: string) {
  return appContext.issuers.sign(publicOrigin, appContext.config.defaultPermissionTicketIssuerSlug, {
    iss: `${publicOrigin}/issuer/${appContext.config.defaultPermissionTicketIssuerSlug}`,
    aud: publicOrigin,
    exp: Math.floor(Date.now() / 1000) + 3600,
    jti: crypto.randomUUID(),
    ticket_type: PATIENT_SELF_ACCESS_TICKET_TYPE,
    presenter_binding: {
      method: "framework_client",
      framework: DEFAULT_DEMO_OIDF_FRAMEWORK_URI,
      framework_type: "oidf",
      entity_uri: appContext.oidfTopology.demoAppEntityId,
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
  });
}

async function postOidfToken(
  origin: string,
  appContext: ReturnType<typeof createAppContext>,
  ticket: string,
  options: { withTrustChain?: boolean } = {},
) {
  const tokenEndpointUrl = `${origin}/token`;
  const clientId = appContext.oidfTopology.demoAppEntityId;
  return fetch(tokenEndpointUrl, {
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
      client_assertion: await buildOidfClientAssertion(appContext, `${appContext.config.publicBaseUrl}/token`, options),
    }),
  });
}

async function buildOidfClientAssertion(
  appContext: ReturnType<typeof createAppContext>,
  tokenEndpointUrl: string,
  options: { withTrustChain?: boolean },
) {
  const now = Math.floor(Date.now() / 1000);
  const trustChain = options.withTrustChain === false
    ? undefined
    : buildOidfTrustChain(appContext.oidfTopology, appContext.oidfTopology.demoAppEntityId);
  return signPrivateKeyJwt(
    {
      iss: appContext.oidfTopology.demoAppEntityId,
      sub: appContext.oidfTopology.demoAppEntityId,
      aud: tokenEndpointUrl,
      iat: now,
      exp: now + 300,
      jti: crypto.randomUUID(),
    },
    appContext.oidfTopology.entities["demo-app"].privateJwk,
    trustChain ? { trust_chain: trustChain } : {},
  );
}
