import { describe, expect, test } from "bun:test";

import { generateClientKeyMaterial, signPrivateKeyJwt } from "../shared/private-key-jwt.ts";
import {
  PATIENT_SELF_ACCESS_TICKET_TYPE,
  PERMISSION_TICKET_SUBJECT_TOKEN_TYPE,
} from "../shared/permission-tickets.ts";
import { DEFAULT_DEMO_OIDF_FRAMEWORK_URI, buildDefaultFrameworks } from "../src/auth/demo-frameworks.ts";
import { SMART_PERMISSION_TICKET_ISSUER_ENTITY_TYPE } from "../src/auth/frameworks/oidf/smart-permission-ticket-issuer.ts";
import { createAppContext, startServer } from "../src/app.ts";

const ENTITY_STATEMENT_TYP = "entity-statement+jwt";

describe("OIDF client authentication", () => {
  test("unknown URL client_id authenticates successfully when a valid trust_chain header is supplied", async () => {
    const { context, server, origin, publicOrigin } = startOidfAuthServer();
    try {
      const browserClient = await issueOidfBrowserClientInstance(origin, context);
      const ticket = mintOidfTicket(context, publicOrigin, browserClient.clientId);
      const response = await postOidfToken(origin, context, ticket, {}, browserClient);
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(typeof body.access_token).toBe("string");
    } finally {
      server.stop(true);
    }
  });

  test("resolved client_name comes from metadata policy, not just the leaf metadata", async () => {
    const { context, server, origin } = startOidfAuthServer();
    try {
      const browserClient = await issueOidfBrowserClientInstance(origin, context);
      const tokenEndpointUrl = `${context.config.publicBaseUrl}/token`;
      const assertion = await buildOidfClientAssertion(browserClient, tokenEndpointUrl, { withTrustChain: true });
      const identity = await context.frameworks.authenticateClientAssertion(
        browserClient.clientId,
        assertion,
        tokenEndpointUrl,
      );
      expect(identity?.authMode).toBe("oidf");
      expect(identity?.clientName).toBe("OpenID Federation Browser Demo App");
    } finally {
      server.stop(true);
    }
  });

  test("OIDF dispatch wins based on trust_chain header even though the client_id is a URL", async () => {
    const { context, server, origin } = startOidfAuthServer();
    try {
      const browserClient = await issueOidfBrowserClientInstance(origin, context);
      const tokenEndpointUrl = `${context.config.publicBaseUrl}/token`;
      const assertion = await buildOidfClientAssertion(browserClient, tokenEndpointUrl, { withTrustChain: true });
      const identity = await context.frameworks.authenticateClientAssertion(
        browserClient.clientId,
        assertion,
        tokenEndpointUrl,
      );
      expect(identity?.frameworkBinding?.framework_type).toBe("oidf");
      expect(identity?.frameworkBinding?.entity_uri).toBe(browserClient.clientId);
    } finally {
      server.stop(true);
    }
  });

  test("a URL client_id without trust_chain continues to follow the non-OIDF path", async () => {
    const { context, server, origin, publicOrigin } = startOidfAuthServer();
    try {
      const browserClient = await issueOidfBrowserClientInstance(origin, context);
      const ticket = mintOidfTicket(context, publicOrigin, browserClient.clientId);
      const response = await postOidfToken(origin, context, ticket, { withTrustChain: false }, browserClient);
      expect(response.status).toBe(401);
      const body = await response.json();
      expect(body.error).toBe("invalid_client");
      expect(String(body.error_description)).toContain("Authenticated registered client required");
    } finally {
      server.stop(true);
    }
  });

  test("a valid anchored oauth_client leaf is accepted without any trustedLeaves configuration", async () => {
    const { context, server, origin } = startOidfAuthServer();
    try {
      const browserClient = await issueOidfBrowserClientInstance(origin, context);
      const tokenEndpointUrl = `${context.config.publicBaseUrl}/token`;
      const assertion = await buildOidfClientAssertion(browserClient, tokenEndpointUrl, { withTrustChain: true });
      const identity = await context.frameworks.authenticateClientAssertion(
        browserClient.clientId,
        assertion,
        tokenEndpointUrl,
      );
      expect(identity?.authMode).toBe("oidf");
      expect(identity?.clientId).toBe(browserClient.clientId);
    } finally {
      server.stop(true);
    }
  });

  test("a trust chain under an unconfigured anchor is rejected clearly", async () => {
    const { context, server, origin, publicOrigin } = startOidfAuthServer();
    try {
      const oidfFramework = context.config.frameworks.find((framework) => framework.frameworkType === "oidf");
      if (!oidfFramework?.oidf) throw new Error("Missing OIDF framework config");
      oidfFramework.oidf.trustAnchors = [{
        entityId: `${publicOrigin}/federation/anchors/other`,
        jwks: [context.oidfTopology.entities.anchor.publicJwk],
      }];

      const browserClient = await issueOidfBrowserClientInstance(origin, context);
      const tokenEndpointUrl = `${context.config.publicBaseUrl}/token`;
      const assertion = await buildOidfClientAssertion(browserClient, tokenEndpointUrl, { withTrustChain: true });
      await expect(
        context.frameworks.authenticateClientAssertion(
          browserClient.clientId,
          assertion,
          tokenEndpointUrl,
        ),
      ).rejects.toThrow("did not validate against any configured trust anchor");
    } finally {
      server.stop(true);
    }
  });

  test("client auth ignores smart_permission_ticket_issuer metadata on the client leaf", async () => {
    const { context, server, origin } = startOidfAuthServer();
    try {
      const browserClient = await issueOidfBrowserClientInstance(origin, context, {
        extraMetadata: {
          [SMART_PERMISSION_TICKET_ISSUER_ENTITY_TYPE]: {
            jwks: null,
          },
        },
      });
      const tokenEndpointUrl = `${context.config.publicBaseUrl}/token`;
      const assertion = await buildOidfClientAssertion(browserClient, tokenEndpointUrl, { withTrustChain: true });
      const identity = await context.frameworks.authenticateClientAssertion(
        browserClient.clientId,
        assertion,
        tokenEndpointUrl,
      );

      expect(identity?.authMode).toBe("oidf");
      expect(identity?.clientId).toBe(browserClient.clientId);
    } finally {
      server.stop(true);
    }
  });

  test("client auth rejects assertions signed with the browser leaf federation key instead of oauth_client jwks", async () => {
    const { context, server, origin } = startOidfAuthServer();
    try {
      const browserClient = await issueOidfBrowserClientInstance(origin, context);
      const tokenEndpointUrl = `${context.config.publicBaseUrl}/token`;
      const assertion = await signPrivateKeyJwt(
        {
          iss: browserClient.clientId,
          sub: browserClient.clientId,
          aud: tokenEndpointUrl,
          iat: Math.floor(Date.now() / 1000),
          exp: Math.floor(Date.now() / 1000) + 300,
          jti: crypto.randomUUID(),
        },
        browserClient.federationPrivateJwk,
        { trust_chain: browserClient.trustChain },
      );
      await expect(
        context.frameworks.authenticateClientAssertion(
          browserClient.clientId,
          assertion,
          tokenEndpointUrl,
        ),
      ).rejects.toThrow("kid_mismatch");
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

function mintOidfTicket(appContext: ReturnType<typeof createAppContext>, publicOrigin: string, entityUri = appContext.oidfTopology.demoAppEntityId) {
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
      entity_uri: entityUri,
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
  browserClient?: IssuedBrowserClient,
) {
  const activeBrowserClient = browserClient ?? await issueOidfBrowserClientInstance(origin, appContext);
  const tokenEndpointUrl = `${origin}/token`;
  const clientId = activeBrowserClient.clientId;
  const ticketEntityUri = decodeTicketPresenterEntityUri(ticket);
  return fetch(tokenEndpointUrl, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
      subject_token_type: PERMISSION_TICKET_SUBJECT_TOKEN_TYPE,
      subject_token: ticket,
      client_id: ticketEntityUri ?? clientId,
      client_assertion_type: "urn:ietf:params:oauth:client-assertion-type:jwt-bearer",
      client_assertion: await buildOidfClientAssertion(activeBrowserClient, `${appContext.config.publicBaseUrl}/token`, options),
    }),
  });
}

type IssuedBrowserClient = {
  clientId: string;
  trustChain: string[];
  federationPrivateJwk: JsonWebKey;
  oauthPrivateJwk: JsonWebKey;
};

async function issueOidfBrowserClientInstance(
  origin: string,
  appContext: ReturnType<typeof createAppContext>,
  options: {
    extraMetadata?: Record<string, unknown>;
  } = {},
): Promise<IssuedBrowserClient> {
  const federationKeys = await generateClientKeyMaterial();
  const oauthKeys = await generateClientKeyMaterial();
  const clientId = `${appContext.oidfTopology.browserInstanceEntityBaseId}/${crypto.randomUUID()}`;
  const now = Math.floor(Date.now() / 1000);
  const leafEntityConfiguration = await signPrivateKeyJwt(
    {
      iss: clientId,
      sub: clientId,
      iat: now,
      exp: now + 3600,
      jwks: {
        keys: [{
          ...federationKeys.publicJwk,
          kid: federationKeys.thumbprint,
        }],
      },
      metadata: {
        oauth_client: {
          jwks: {
            keys: [{
              ...oauthKeys.publicJwk,
              kid: oauthKeys.thumbprint,
            }],
          },
        },
        ...(options.extraMetadata ?? {}),
      },
      authority_hints: [appContext.oidfTopology.demoAppEntityId],
    },
    {
      ...federationKeys.privateJwk,
      kid: federationKeys.thumbprint,
    },
    { typ: ENTITY_STATEMENT_TYP },
  );
  const response = await fetch(`${origin}/demo/oidf/browser-client-instance`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify({
      leaf_entity_configuration: leafEntityConfiguration,
    }),
  });
  expect(response.status).toBe(201);
  const body = await response.json() as {
    entity_uri: string;
    trust_chain: string[];
  };
  expect(body.entity_uri).toBe(clientId);
  return {
    clientId,
    trustChain: body.trust_chain,
    federationPrivateJwk: {
      ...federationKeys.privateJwk,
      kid: federationKeys.thumbprint,
    },
    oauthPrivateJwk: {
      ...oauthKeys.privateJwk,
      kid: oauthKeys.thumbprint,
    },
  };
}

async function buildOidfClientAssertion(
  browserClient: IssuedBrowserClient,
  tokenEndpointUrl: string,
  options: { withTrustChain?: boolean },
) {
  const now = Math.floor(Date.now() / 1000);
  const trustChain = options.withTrustChain === false
    ? undefined
    : browserClient.trustChain;
  return signPrivateKeyJwt(
    {
      iss: browserClient.clientId,
      sub: browserClient.clientId,
      aud: tokenEndpointUrl,
      iat: now,
      exp: now + 300,
      jti: crypto.randomUUID(),
    },
    browserClient.oauthPrivateJwk,
    trustChain ? { trust_chain: trustChain } : {},
  );
}

function decodeTicketPresenterEntityUri(ticket: string) {
  const payload = ticket.split(".")[1];
  if (!payload) return null;
  const decoded = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Record<string, any>;
  const entityUri = decoded.presenter_binding?.entity_uri;
  return typeof entityUri === "string" && entityUri ? entityUri : null;
}
