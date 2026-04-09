import { describe, expect, test } from "bun:test";

import { createAppContext, startServer } from "../src/app.ts";
import { decodeEs256Jwt } from "../src/auth/es256-jwt.ts";
import { DEFAULT_DEMO_OIDF_FRAMEWORK_URI } from "../src/auth/demo-frameworks.ts";
import { buildOidfTrustChain } from "../src/auth/frameworks/oidf/demo-topology.ts";

describe("OIDF demo topology", () => {
  test("publishes entity configurations and federation-fetch endpoints", async () => {
    const context = createAppContext({ port: 0 });
    const server = startServer(context, 0);
    const origin = `http://127.0.0.1:${server.port}`;
    const publicOrigin = context.config.publicBaseUrl;
    const firstSite = context.store.listSiteSummaries()[0];
    const firstSiteEntityId = context.oidfTopology.providerSiteEntityIds[firstSite!.siteSlug];
    try {
      const entityResponse = await fetch(`${origin}/demo/clients/oidf/worldwide-app/.well-known/openid-federation`);
      expect(entityResponse.status).toBe(200);
      expect(entityResponse.headers.get("content-type")).toBe("application/entity-statement+jwt");
      const entityStatement = await entityResponse.text();
      const decodedEntity = decodeEs256Jwt<Record<string, any>>(entityStatement);
      expect(decodedEntity.header.typ).toBe("entity-statement+jwt");
      expect(decodedEntity.payload.iss).toBe(`${publicOrigin}/demo/clients/oidf/worldwide-app`);
      expect(decodedEntity.payload.authority_hints).toEqual([`${publicOrigin}/federation/networks/app`]);
      expect(decodedEntity.payload.metadata.federation_entity.organization_name).toBe("OIDF Worldwide Demo App");

      const appNetworkResponse = await fetch(`${origin}/federation/networks/app/.well-known/openid-federation`);
      expect(appNetworkResponse.status).toBe(200);
      const appNetworkStatement = await appNetworkResponse.text();
      const decodedAppNetwork = decodeEs256Jwt<Record<string, any>>(appNetworkStatement);
      expect(decodedAppNetwork.payload.metadata.federation_entity.federation_fetch_endpoint).toBe(
        `${publicOrigin}/federation/networks/app/federation_fetch_endpoint`,
      );

      const fetchResponse = await fetch(
        `${origin}/federation/networks/app/federation_fetch_endpoint?sub=${encodeURIComponent(`${publicOrigin}/demo/clients/oidf/worldwide-app`)}`,
      );
      expect(fetchResponse.status).toBe(200);
      const subordinateStatement = await fetchResponse.text();
      const decodedSubordinate = decodeEs256Jwt<Record<string, any>>(subordinateStatement);
      expect(decodedSubordinate.header.typ).toBe("entity-statement+jwt");
      expect(decodedSubordinate.payload.iss).toBe(`${publicOrigin}/federation/networks/app`);
      expect(decodedSubordinate.payload.sub).toBe(`${publicOrigin}/demo/clients/oidf/worldwide-app`);
      expect(decodedSubordinate.payload.jwks.keys).toEqual(decodedEntity.payload.jwks.keys);
      expect(decodedSubordinate.payload.metadata_policy).toEqual({});

      const siteEntityResponse = await fetch(`${origin}/federation/leafs/provider-sites/${firstSite!.siteSlug}/.well-known/openid-federation`);
      expect(siteEntityResponse.status).toBe(200);
      const siteEntityStatement = await siteEntityResponse.text();
      const decodedSiteEntity = decodeEs256Jwt<Record<string, any>>(siteEntityStatement);
      expect(decodedSiteEntity.payload.iss).toBe(firstSiteEntityId);
      expect(decodedSiteEntity.payload.authority_hints).toEqual([`${publicOrigin}/federation/networks/provider`]);
      expect(decodedSiteEntity.payload.metadata.oauth_authorization_server.token_endpoint).toBe(
        `${publicOrigin}/sites/${firstSite!.siteSlug}/token`,
      );
      expect(decodedSiteEntity.payload.metadata.oauth_resource.resource).toBe(
        `${publicOrigin}/sites/${firstSite!.siteSlug}/fhir`,
      );

      const siteFetchResponse = await fetch(
        `${origin}/federation/networks/provider/federation_fetch_endpoint?sub=${encodeURIComponent(firstSiteEntityId)}`,
      );
      expect(siteFetchResponse.status).toBe(200);
      const siteSubordinateStatement = await siteFetchResponse.text();
      const decodedSiteSubordinate = decodeEs256Jwt<Record<string, any>>(siteSubordinateStatement);
      expect(decodedSiteSubordinate.payload.iss).toBe(`${publicOrigin}/federation/networks/provider`);
      expect(decodedSiteSubordinate.payload.sub).toBe(firstSiteEntityId);
      expect(decodedSiteSubordinate.payload.jwks.keys).toEqual(decodedSiteEntity.payload.jwks.keys);
      expect(decodedSiteSubordinate.payload.metadata_policy.oauth_authorization_server.token_endpoint.value).toBe(
        `${publicOrigin}/sites/${firstSite!.siteSlug}/token`,
      );
      expect(decodedSiteSubordinate.payload.metadata_policy.oauth_resource.resource.value).toBe(
        `${publicOrigin}/sites/${firstSite!.siteSlug}/fhir`,
      );
    } finally {
      server.stop(true);
    }
  });

  test("provider network federation fetch resolves subordinate statements for every discovered site leaf", async () => {
    const context = createAppContext({ port: 0 });
    const server = startServer(context, 0);
    const origin = `http://127.0.0.1:${server.port}`;
    try {
      for (const site of context.store.listSiteSummaries()) {
        const siteEntityId = context.oidfTopology.providerSiteEntityIds[site.siteSlug];
        expect(typeof siteEntityId).toBe("string");
        const response = await fetch(
          `${origin}/federation/networks/provider/federation_fetch_endpoint?sub=${encodeURIComponent(siteEntityId)}`,
        );
        expect(response.status).toBe(200);
        const statement = await response.text();
        const decoded = decodeEs256Jwt<Record<string, any>>(statement);
        expect(decoded.payload.sub).toBe(siteEntityId);
      }
    } finally {
      server.stop(true);
    }
  });

  test("builds a 4-statement RFC-shaped trust chain without intermediate entity configurations", () => {
    const context = createAppContext({ port: 0 });
    const chain = buildOidfTrustChain(context.oidfTopology, context.oidfTopology.demoAppEntityId);
    expect(chain).toHaveLength(4);

    const decoded = chain.map((statement) => decodeEs256Jwt<Record<string, any>>(statement).payload);
    expect(decoded[0]?.iss).toBe(context.oidfTopology.demoAppEntityId);
    expect(decoded[0]?.sub).toBe(context.oidfTopology.demoAppEntityId);
    expect(decoded[1]?.iss).toBe(context.oidfTopology.appNetworkEntityId);
    expect(decoded[1]?.sub).toBe(context.oidfTopology.demoAppEntityId);
    expect(decoded[2]?.iss).toBe(context.oidfTopology.trustAnchorEntityId);
    expect(decoded[2]?.sub).toBe(context.oidfTopology.appNetworkEntityId);
    expect(decoded[3]?.iss).toBe(context.oidfTopology.trustAnchorEntityId);
    expect(decoded[3]?.sub).toBe(context.oidfTopology.trustAnchorEntityId);
  });

  test("embeds a provider-issued trust mark in the ticket issuer entity configuration", async () => {
    const context = createAppContext({ port: 0 });
    const server = startServer(context, 0);
    const origin = `http://127.0.0.1:${server.port}`;
    const publicOrigin = context.config.publicBaseUrl;
    try {
      const response = await fetch(`${origin}/issuer/${context.config.defaultPermissionTicketIssuerSlug}/.well-known/openid-federation`);
      expect(response.status).toBe(200);
      const entityStatement = await response.text();
      const decodedEntity = decodeEs256Jwt<Record<string, any>>(entityStatement);
      expect(decodedEntity.payload.iss).toBe(`${publicOrigin}/issuer/${context.config.defaultPermissionTicketIssuerSlug}`);
      expect(decodedEntity.payload.sub).toBe(`${publicOrigin}/issuer/${context.config.defaultPermissionTicketIssuerSlug}`);
      expect(decodedEntity.payload.metadata.federation_entity).toEqual({
        organization_name: context.config.defaultPermissionTicketIssuerName,
      });
      expect(decodedEntity.payload.metadata.smart_permission_ticket_issuer.jwks.keys).toHaveLength(1);
      const trustMarks = decodedEntity.payload.trust_marks;
      expect(Array.isArray(trustMarks)).toBe(true);
      expect(trustMarks).toHaveLength(1);
      const decodedTrustMark = decodeEs256Jwt<Record<string, any>>(trustMarks[0]);
      expect(decodedTrustMark.header.typ).toBe("trust-mark+jwt");
      expect(decodedTrustMark.payload.iss).toBe(`${publicOrigin}/federation/networks/provider`);
      expect(decodedTrustMark.payload.sub).toBe(`${publicOrigin}/issuer/${context.config.defaultPermissionTicketIssuerSlug}`);
      expect(decodedTrustMark.payload.trust_mark_type).toBe(`${publicOrigin}/federation/trust-marks/permission-ticket-issuer`);
    } finally {
      server.stop(true);
    }
  });

  test("serves both issuer JWKS and OIDF entity configuration from the issuer base path", async () => {
    const context = createAppContext({ port: 0 });
    const server = startServer(context, 0);
    const origin = `http://127.0.0.1:${server.port}`;
    const issuerBasePath = `/issuer/${context.config.defaultPermissionTicketIssuerSlug}`;
    try {
      const jwksResponse = await fetch(`${origin}${issuerBasePath}/.well-known/jwks.json`);
      expect(jwksResponse.status).toBe(200);
      const jwksBody = await jwksResponse.json() as { keys?: JsonWebKey[] };
      expect(Array.isArray(jwksBody.keys)).toBe(true);
      expect(jwksBody.keys).toHaveLength(1);

      const oidfResponse = await fetch(`${origin}${issuerBasePath}/.well-known/openid-federation`);
      expect(oidfResponse.status).toBe(200);
      expect(oidfResponse.headers.get("content-type")).toBe("application/entity-statement+jwt");
      const entityStatement = await oidfResponse.text();
      const decodedEntity = decodeEs256Jwt<Record<string, any>>(entityStatement);
      expect(decodedEntity.payload.iss).toBe(`${context.config.publicBaseUrl}${issuerBasePath}`);
      expect(decodedEntity.payload.metadata.smart_permission_ticket_issuer.jwks.keys).toHaveLength(1);
    } finally {
      server.stop(true);
    }
  });

  test("re-mints entity statements on fetch instead of serving stale boot-time JWTs", async () => {
    const realDateNow = Date.now;
    Date.now = () => new Date("2026-04-07T12:00:00.000Z").getTime();
    const context = createAppContext({ port: 0 });
    const server = startServer(context, 0);
    const origin = `http://127.0.0.1:${server.port}`;
    try {
      const firstResponse = await fetch(`${origin}/demo/clients/oidf/worldwide-app/.well-known/openid-federation`);
      expect(firstResponse.status).toBe(200);
      const firstStatement = await firstResponse.text();
      const firstDecoded = decodeEs256Jwt<Record<string, any>>(firstStatement);

      Date.now = () => new Date("2026-04-07T14:30:00.000Z").getTime();

      const secondResponse = await fetch(`${origin}/demo/clients/oidf/worldwide-app/.well-known/openid-federation`);
      expect(secondResponse.status).toBe(200);
      const secondStatement = await secondResponse.text();
      const secondDecoded = decodeEs256Jwt<Record<string, any>>(secondStatement);

      expect(secondDecoded.payload.iat).toBeGreaterThan(firstDecoded.payload.iat);
      expect(secondDecoded.payload.exp).toBeGreaterThan(firstDecoded.payload.exp);
      expect(secondDecoded.payload.exp - secondDecoded.payload.iat).toBe(firstDecoded.payload.exp - firstDecoded.payload.iat);
    } finally {
      Date.now = realDateNow;
      server.stop(true);
    }
  });

  test("default frameworks include a dormant OIDF definition with stable entity ids", () => {
    const context = createAppContext({ port: 0 });
    const oidfFramework = context.config.frameworks.find((framework) => framework.frameworkType === "oidf");
    expect(oidfFramework?.framework).toBe(DEFAULT_DEMO_OIDF_FRAMEWORK_URI);
    expect(oidfFramework?.supportsClientAuth).toBe(true);
    expect(oidfFramework?.supportsIssuerTrust).toBe(true);
    expect(oidfFramework?.oidf?.trustAnchors).toEqual([
      {
        entityId: `${context.config.publicBaseUrl}/federation/anchor`,
        jwks: [context.oidfTopology.entities.anchor.publicJwk],
      },
    ]);
    expect(oidfFramework?.oidf?.requiredIssuerTrustMarkType).toBe(context.oidfTopology.trustMarkType);
    expect(oidfFramework?.oidf?.maxTrustChainDepth).toBeUndefined();
  });

  test("demo bootstrap publishes an OIDF client option for browser-instance issuance", async () => {
    const context = createAppContext({ port: 0 });
    const server = startServer(context, 0);
    const origin = `http://127.0.0.1:${server.port}`;
    try {
      const response = await fetch(`${origin}/demo/bootstrap`);
      expect(response.status).toBe(200);
      const body = await response.json() as { demoClientOptions?: Array<Record<string, any>> };
      const oidf = body.demoClientOptions?.find((option) => option.type === "oidf");
      expect(oidf?.label).toBe("OIDF client");
      expect(oidf?.entityUri).toBe(context.oidfTopology.demoAppEntityId);
      expect(typeof oidf?.entityConfigurationUrl).toBe("string");
      expect(oidf?.browserInstanceBaseUri).toBe(context.oidfTopology.browserInstanceEntityBaseId);
      expect(oidf?.browserInstanceIssuePath).toBe("/demo/oidf/browser-client-instance");
      expect(oidf?.publicJwk).toBeUndefined();
      expect(oidf?.privateJwk).toBeUndefined();
      expect(oidf?.trustChain).toBeUndefined();
    } finally {
      server.stop(true);
    }
  });
});
