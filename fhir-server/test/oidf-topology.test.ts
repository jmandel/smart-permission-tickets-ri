import { describe, expect, test } from "bun:test";

import { createAppContext, startServer } from "../src/app.ts";
import { decodeEs256Jwt } from "../src/auth/es256-jwt.ts";
import { DEFAULT_DEMO_OIDF_FRAMEWORK_URI } from "../src/auth/demo-frameworks.ts";

describe("OIDF demo topology", () => {
  test("publishes entity configurations and federation-fetch endpoints", async () => {
    const context = createAppContext({ port: 0 });
    const server = startServer(context, 0);
    const origin = `http://127.0.0.1:${server.port}`;
    const publicOrigin = context.config.publicBaseUrl;
    try {
      const entityResponse = await fetch(`${origin}/federation/leafs/demo-app/.well-known/openid-federation`);
      expect(entityResponse.status).toBe(200);
      expect(entityResponse.headers.get("content-type")).toBe("application/entity-statement+jwt");
      const entityStatement = await entityResponse.text();
      const decodedEntity = decodeEs256Jwt<Record<string, any>>(entityStatement);
      expect(decodedEntity.header.typ).toBe("entity-statement+jwt");
      expect(decodedEntity.payload.iss).toBe(`${publicOrigin}/federation/leafs/demo-app`);
      expect(decodedEntity.payload.authority_hints).toEqual([`${publicOrigin}/federation/networks/app`]);

      const fetchResponse = await fetch(
        `${origin}/federation/networks/app/federation_fetch_endpoint?sub=${encodeURIComponent(`${publicOrigin}/federation/leafs/demo-app`)}`,
      );
      expect(fetchResponse.status).toBe(200);
      const subordinateStatement = await fetchResponse.text();
      const decodedSubordinate = decodeEs256Jwt<Record<string, any>>(subordinateStatement);
      expect(decodedSubordinate.header.typ).toBe("entity-statement+jwt");
      expect(decodedSubordinate.payload.iss).toBe(`${publicOrigin}/federation/networks/app`);
      expect(decodedSubordinate.payload.sub).toBe(`${publicOrigin}/federation/leafs/demo-app`);
      expect(decodedSubordinate.payload.metadata_policy.oauth_client.client_name.value).toBe("OpenID Federation Demo App");
    } finally {
      server.stop(true);
    }
  });

  test("embeds a provider-issued trust mark in the ticket issuer entity configuration", async () => {
    const context = createAppContext({ port: 0 });
    const server = startServer(context, 0);
    const origin = `http://127.0.0.1:${server.port}`;
    const publicOrigin = context.config.publicBaseUrl;
    try {
      const response = await fetch(`${origin}/federation/leafs/ticket-issuer/.well-known/openid-federation`);
      expect(response.status).toBe(200);
      const entityStatement = await response.text();
      const decodedEntity = decodeEs256Jwt<Record<string, any>>(entityStatement);
      const trustMarks = decodedEntity.payload.trust_marks;
      expect(Array.isArray(trustMarks)).toBe(true);
      expect(trustMarks).toHaveLength(1);
      const decodedTrustMark = decodeEs256Jwt<Record<string, any>>(trustMarks[0]);
      expect(decodedTrustMark.header.typ).toBe("trust-mark+jwt");
      expect(decodedTrustMark.payload.iss).toBe(`${publicOrigin}/federation/networks/provider`);
      expect(decodedTrustMark.payload.sub).toBe(`${publicOrigin}/federation/leafs/ticket-issuer`);
      expect(decodedTrustMark.payload.trust_mark_type).toBe(`${publicOrigin}/federation/trust-marks/permission-ticket-issuer`);
    } finally {
      server.stop(true);
    }
  });

  test("default frameworks include a dormant OIDF definition with stable entity ids", () => {
    const context = createAppContext({ port: 0 });
    const oidfFramework = context.config.frameworks.find((framework) => framework.frameworkType === "oidf");
    expect(oidfFramework?.framework).toBe(DEFAULT_DEMO_OIDF_FRAMEWORK_URI);
    expect(oidfFramework?.supportsClientAuth).toBe(true);
    expect(oidfFramework?.supportsIssuerTrust).toBe(true);
    expect(oidfFramework?.oidf?.trustAnchorEntityId).toBe(`${context.config.publicBaseUrl}/federation/anchor`);
    expect(oidfFramework?.oidf?.ticketIssuerUrl).toBe(`${context.config.publicBaseUrl}/issuer/${context.config.defaultPermissionTicketIssuerSlug}`);
  });
});
