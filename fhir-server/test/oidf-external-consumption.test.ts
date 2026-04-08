import { describe, expect, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";

import { signPrivateKeyJwt } from "../shared/private-key-jwt.ts";
import { OidfFrameworkResolver } from "../src/auth/frameworks/oidf/resolver.ts";
import { SMART_PERMISSION_TICKET_ISSUER_ENTITY_TYPE } from "../src/auth/frameworks/oidf/smart-permission-ticket-issuer.ts";
import { ENTITY_STATEMENT_TYP } from "../src/auth/frameworks/oidf/trust-chain.ts";
import { TRUST_MARK_TYP } from "../src/auth/frameworks/oidf/trust-mark.ts";
import { federationFetchEndpointPath, oidfEntityConfigurationPath } from "../src/auth/frameworks/oidf/urls.ts";
import { computeEcJwkThumbprintSync, normalizePrivateJwk, normalizePublicJwk, signEs256Jwt } from "../src/auth/es256-jwt.ts";
import type { FrameworkDefinition } from "../src/store/model.ts";

describe("OIDF external entity consumption", () => {
  test("external OIDF client authentication stays offline when trust_chain is supplied", async () => {
    const fixture = buildExternalOidfFixture("https://external-clients.example.test");
    const resolver = new OidfFrameworkResolver(
      [buildExternalOidfFramework(fixture)],
      {
        publicBaseUrl: "https://tickets.example.test",
        internalBaseUrl: "http://127.0.0.1:9999",
      },
      async () => {
        throw new Error("OIDF client authentication should not fetch during static trust_chain validation");
      },
    );

    const tokenEndpointUrl = "https://tickets.example.test/token";
    const assertion = await signPrivateKeyJwt(
      {
        iss: fixture.clientLeafEntityId,
        sub: fixture.clientLeafEntityId,
        aud: tokenEndpointUrl,
        iat: Math.floor(Date.now() / 1000),
        exp: Math.floor(Date.now() / 1000) + 300,
        jti: crypto.randomUUID(),
      },
      fixture.clientLeaf.privateJwk,
      { trust_chain: fixture.clientTrustChain },
    );

    const identity = await resolver.authenticateClientAssertion(
      fixture.clientLeafEntityId,
      assertion,
      tokenEndpointUrl,
    );
    expect(identity?.authMode).toBe("oidf");
    expect(identity?.clientId).toBe(fixture.clientLeafEntityId);
    expect(identity?.clientName).toBe("External OIDF Client");
  });

  test("external OIDF issuer trust fetches foreign URLs as-is", async () => {
    let fixture: ReturnType<typeof buildExternalOidfFixture> | null = null;
    const server = Bun.serve({
      port: 0,
      fetch(request) {
        if (!fixture) return new Response("fixture not ready", { status: 500 });
        const url = new URL(request.url);
        const body = fixture.responses.get(url.pathname + url.search);
        return body ? new Response(body, { status: 200, headers: { "content-type": "application/entity-statement+jwt" } }) : new Response("not found", { status: 404 });
      },
    });
    fixture = buildExternalOidfFixture(`http://127.0.0.1:${server.port}`);

    const seenUrls: string[] = [];
    const resolver = new OidfFrameworkResolver(
      [buildExternalOidfFramework(fixture)],
      {
        publicBaseUrl: "https://tickets.example.test",
        internalBaseUrl: "http://127.0.0.1:9999",
      },
      async (input, init) => {
        const url = typeof input === "string" ? input : input.url;
        seenUrls.push(url);
        return fetch(input, init);
      },
    );

    try {
      const issuerTrust = await resolver.resolveIssuerTrust(fixture.expectedIssuerUrl);
      expect(issuerTrust?.framework?.type).toBe("oidf");
      expect(issuerTrust?.issuerUrl).toBe(fixture.expectedIssuerUrl);
      expect(issuerTrust?.metadata?.entity_id).toBe(fixture.issuerLeafEntityId);
      expect(seenUrls.length).toBeGreaterThan(0);
      expect(seenUrls.every((url) => new URL(url).origin === fixture.baseOrigin)).toBe(true);
    } finally {
      server.stop(true);
    }
  });

  test("external OIDF issuer trust caches successful resolutions while the cache is fresh", async () => {
    let fixture: ReturnType<typeof buildExternalOidfFixture> | null = null;
    const server = Bun.serve({
      port: 0,
      fetch(request) {
        if (!fixture) return new Response("fixture not ready", { status: 500 });
        const url = new URL(request.url);
        const body = fixture.responses.get(url.pathname + url.search);
        return body ? new Response(body, { status: 200, headers: { "content-type": "application/entity-statement+jwt" } }) : new Response("not found", { status: 404 });
      },
    });
    fixture = buildExternalOidfFixture(`http://127.0.0.1:${server.port}`);

    const seenUrls: string[] = [];
    const resolver = new OidfFrameworkResolver(
      [buildExternalOidfFramework(fixture)],
      {
        publicBaseUrl: "https://tickets.example.test",
        internalBaseUrl: "http://127.0.0.1:9999",
      },
      async (input, init) => {
        const url = typeof input === "string" ? input : input.url;
        seenUrls.push(url);
        return fetch(input, init);
      },
    );

    try {
      const first = await resolver.resolveIssuerTrust(fixture.expectedIssuerUrl);
      const firstFetchCount = seenUrls.length;
      const second = await resolver.resolveIssuerTrust(fixture.expectedIssuerUrl);
      expect(first?.issuerUrl).toBe(fixture.expectedIssuerUrl);
      expect(second?.issuerUrl).toBe(fixture.expectedIssuerUrl);
      expect(seenUrls).toHaveLength(firstFetchCount);
    } finally {
      server.stop(true);
    }
  });

  test("external OIDF issuer trust explores later authority_hints when the first parent path fails", async () => {
    let fixture: ReturnType<typeof buildExternalOidfFixture> | null = null;
    const server = Bun.serve({
      port: 0,
      fetch(request) {
        if (!fixture) return new Response("fixture not ready", { status: 500 });
        const url = new URL(request.url);
        const body = fixture.responses.get(url.pathname + url.search);
        return body ? new Response(body, { status: 200, headers: { "content-type": "application/entity-statement+jwt" } }) : new Response("not found", { status: 404 });
      },
    });
    fixture = buildExternalOidfFixture(`http://127.0.0.1:${server.port}`, {
      issuerAuthorityHints: [
        `${baseOriginForFixture(server.port)}/federation/networks/untrusted`,
        `${baseOriginForFixture(server.port)}/federation/networks/provider`,
      ],
    });

    const resolver = new OidfFrameworkResolver(
      [buildExternalOidfFramework(fixture)],
      {
        publicBaseUrl: "https://tickets.example.test",
        internalBaseUrl: "http://127.0.0.1:9999",
      },
      fetch,
    );

    try {
      const issuerTrust = await resolver.resolveIssuerTrust(fixture.expectedIssuerUrl);
      expect(issuerTrust?.framework?.type).toBe("oidf");
      expect(issuerTrust?.metadata?.entity_id).toBe(fixture.issuerLeafEntityId);
    } finally {
      server.stop(true);
    }
  });
});

function buildExternalOidfFramework(
  fixture: ReturnType<typeof buildExternalOidfFixture>,
  overrides: Partial<NonNullable<FrameworkDefinition["oidf"]>> = {},
): FrameworkDefinition {
  return {
    framework: "https://smarthealthit.org/trust-frameworks/external-oidf-test",
    frameworkType: "oidf",
    supportsClientAuth: true,
    supportsIssuerTrust: true,
    cacheTtlSeconds: 300,
    oidf: {
      trustAnchors: [
        {
          entityId: fixture.anchorEntityId,
          jwks: [fixture.anchor.publicJwk],
        },
      ],
      trustedLeaves: [
        {
          entityId: fixture.clientLeafEntityId,
          usage: "client",
        },
        {
          entityId: fixture.issuerLeafEntityId,
          usage: "issuer",
          expectedIssuerUrl: fixture.expectedIssuerUrl,
          requiredTrustMarkType: fixture.trustMarkType,
        },
      ],
      ...overrides,
    },
  };
}

function buildExternalOidfFixture(baseOrigin: string, overrides: {
  issuerAuthorityHints?: string[];
} = {}) {
  const anchorEntityId = `${baseOrigin}/federation/anchor`;
  const providerNetworkEntityId = `${baseOrigin}/federation/networks/provider`;
  const clientLeafEntityId = `${baseOrigin}/federation/leafs/external-client`;
  const issuerLeafEntityId = `${baseOrigin}/federation/leafs/external-issuer`;
  const expectedIssuerUrl = "https://issuer.example.test/issuer/external-demo";
  const trustMarkType = `${baseOrigin}/federation/trust-marks/permission-ticket-issuer`;
  const now = Math.floor(Date.now() / 1000);

  const anchor = generateEcKeyPair();
  const providerNetwork = generateEcKeyPair();
  const clientLeaf = generateEcKeyPair();
  const issuerLeaf = generateEcKeyPair();
  const issuerTicketSigning = generateEcKeyPair();

  const anchorEc = signEntityStatement({
    iss: anchorEntityId,
    sub: anchorEntityId,
    iat: now,
    exp: now + 3600,
    jwks: { keys: [anchor.publicJwk] },
    metadata: {
      federation_entity: {
        federation_fetch_endpoint: `${baseOrigin}${federationFetchEndpointPath(anchorEntityId)}`,
      },
    },
  }, anchor.privateJwk, anchor.publicJwk.kid);

  const providerNetworkEc = signEntityStatement({
    iss: providerNetworkEntityId,
    sub: providerNetworkEntityId,
    iat: now,
    exp: now + 3600,
    jwks: { keys: [providerNetwork.publicJwk] },
    metadata: {
      federation_entity: {
        federation_fetch_endpoint: `${baseOrigin}${federationFetchEndpointPath(providerNetworkEntityId)}`,
      },
    },
    authority_hints: [anchorEntityId],
  }, providerNetwork.privateJwk, providerNetwork.publicJwk.kid);

  const clientLeafEc = signEntityStatement({
    iss: clientLeafEntityId,
    sub: clientLeafEntityId,
    iat: now,
    exp: now + 3600,
    jwks: { keys: [clientLeaf.publicJwk] },
    metadata: {
      oauth_client: {
        client_name: "External Leaf App",
        token_endpoint_auth_method: "private_key_jwt",
      },
    },
    authority_hints: [providerNetworkEntityId],
  }, clientLeaf.privateJwk, clientLeaf.publicJwk.kid);

  const issuerTrustMark = signEs256Jwt({
    iss: providerNetworkEntityId,
    sub: issuerLeafEntityId,
    iat: now,
    exp: now + 86400,
    trust_mark_type: trustMarkType,
  }, providerNetwork.privateJwk, {
    typ: TRUST_MARK_TYP,
    kid: providerNetwork.publicJwk.kid,
  });

  const issuerLeafEc = signEntityStatement({
    iss: issuerLeafEntityId,
    sub: issuerLeafEntityId,
    iat: now,
    exp: now + 3600,
    jwks: { keys: [issuerLeaf.publicJwk] },
    metadata: {
      federation_entity: {
        organization_name: "External OIDF Issuer",
      },
      [SMART_PERMISSION_TICKET_ISSUER_ENTITY_TYPE]: {
        issuer_url: expectedIssuerUrl,
        jwks: {
          keys: [issuerTicketSigning.publicJwk],
        },
      },
    },
    authority_hints: overrides.issuerAuthorityHints ?? [providerNetworkEntityId],
    trust_marks: [issuerTrustMark],
  }, issuerLeaf.privateJwk, issuerLeaf.publicJwk.kid);

  const networkAboutClient = signEntityStatement({
    iss: providerNetworkEntityId,
    sub: clientLeafEntityId,
    iat: now,
    exp: now + 3600,
    jwks: { keys: [clientLeaf.publicJwk] },
    metadata_policy: {
      oauth_client: {
        client_name: {
          value: "External OIDF Client",
        },
      },
    },
  }, providerNetwork.privateJwk, providerNetwork.publicJwk.kid);

  const networkAboutIssuer = signEntityStatement({
    iss: providerNetworkEntityId,
    sub: issuerLeafEntityId,
    iat: now,
    exp: now + 3600,
    jwks: { keys: [issuerLeaf.publicJwk] },
    metadata_policy: {
      [SMART_PERMISSION_TICKET_ISSUER_ENTITY_TYPE]: {
        issuer_url: {
          value: expectedIssuerUrl,
        },
      },
    },
  }, providerNetwork.privateJwk, providerNetwork.publicJwk.kid);

  const anchorAboutNetwork = signEntityStatement({
    iss: anchorEntityId,
    sub: providerNetworkEntityId,
    iat: now,
    exp: now + 3600,
    jwks: { keys: [providerNetwork.publicJwk] },
    metadata_policy: {
      federation_entity: {
        federation_fetch_endpoint: {
          value: `${baseOrigin}${federationFetchEndpointPath(providerNetworkEntityId)}`,
        },
      },
    },
  }, anchor.privateJwk, anchor.publicJwk.kid);

  return {
    baseOrigin,
    anchorEntityId,
    clientLeafEntityId,
    expectedIssuerUrl,
    issuerLeafEntityId,
    trustMarkType,
    anchor,
    clientLeaf,
    issuerLeaf,
    issuerTicketSigning,
    clientTrustChain: [clientLeafEc, networkAboutClient, anchorAboutNetwork, anchorEc],
    responses: new Map<string, string>([
      [new URL(oidfEntityConfigurationPath(clientLeafEntityId), baseOrigin).pathname, clientLeafEc],
      [new URL(oidfEntityConfigurationPath(issuerLeafEntityId), baseOrigin).pathname, issuerLeafEc],
      [new URL(oidfEntityConfigurationPath(providerNetworkEntityId), baseOrigin).pathname, providerNetworkEc],
      [new URL(oidfEntityConfigurationPath(anchorEntityId), baseOrigin).pathname, anchorEc],
      [`${new URL(federationFetchEndpointPath(providerNetworkEntityId), baseOrigin).pathname}?sub=${encodeURIComponent(clientLeafEntityId)}`, networkAboutClient],
      [`${new URL(federationFetchEndpointPath(providerNetworkEntityId), baseOrigin).pathname}?sub=${encodeURIComponent(issuerLeafEntityId)}`, networkAboutIssuer],
      [`${new URL(federationFetchEndpointPath(anchorEntityId), baseOrigin).pathname}?sub=${encodeURIComponent(providerNetworkEntityId)}`, anchorAboutNetwork],
    ]),
  };
}

function baseOriginForFixture(port: number) {
  return `http://127.0.0.1:${port}`;
}

function generateEcKeyPair() {
  const { privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const privateJwk = normalizePrivateJwk(privateKey.export({ format: "jwk" }) as JsonWebKey);
  const publicJwk = normalizePublicJwk({
    kty: "EC",
    crv: "P-256",
    x: privateJwk.x!,
    y: privateJwk.y!,
  });
  const kid = computeEcJwkThumbprintSync(publicJwk);
  return {
    privateJwk: {
      ...privateJwk,
      kid,
    },
    publicJwk: {
      ...publicJwk,
      kid,
    },
  };
}

function signEntityStatement(payload: Record<string, unknown>, privateJwk: JsonWebKey, kid: string) {
  return signEs256Jwt(payload, privateJwk, {
    typ: ENTITY_STATEMENT_TYP,
    kid,
  });
}
