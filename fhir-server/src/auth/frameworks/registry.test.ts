import { describe, expect, test } from "bun:test";

import { ClientRegistry } from "../clients.ts";
import type { AuthenticatedClientIdentity } from "../../store/model.ts";
import { FrameworkRegistry, decodeJoseProtectedHeader } from "./registry.ts";
import type { FrameworkResolver } from "./types.ts";

describe("FrameworkRegistry", () => {
  test("decodes the unverified JOSE protected header for dispatch", () => {
    const jwt = makeTestJwt({
      alg: "RS256",
      trust_chain: ["statement-a", "statement-b"],
      typ: "JWT",
    });

    expect(decodeJoseProtectedHeader(jwt)).toEqual({
      alg: "RS256",
      trust_chain: ["statement-a", "statement-b"],
      typ: "JWT",
    });
  });

  test("prefers assertion-based resolver matching before client-id matching", async () => {
    const assertionResolver = makeResolver("oidf", {
      matchesAssertion: (_clientId, header) => Array.isArray(header.trust_chain),
    });
    const clientIdResolver = makeResolver("well-known", {
      matchesClientId: (clientId) => clientId.startsWith("well-known:"),
    });
    const registry = new FrameworkRegistry(
      [],
      new ClientRegistry([], "test-secret"),
      { publicBaseUrl: "https://tickets.example.test", internalBaseUrl: undefined },
      fetch,
      [assertionResolver, clientIdResolver],
    );

    const identity = await registry.authenticateClientAssertion(
      "well-known:https://entity.example/client",
      makeTestJwt({ alg: "RS256", trust_chain: ["statement"] }),
      "https://tickets.example.test/token",
    );

    expect(identity?.authMode).toBe("oidf");
    expect(identity?.clientId).toBe("oidf-client");
  });

  test("falls back to client-id matching when no assertion-based resolver matches", async () => {
    const assertionResolver = makeResolver("oidf", {
      matchesAssertion: () => false,
    });
    const clientIdResolver = makeResolver("well-known", {
      matchesClientId: (clientId) => clientId.startsWith("well-known:"),
    });
    const registry = new FrameworkRegistry(
      [],
      new ClientRegistry([], "test-secret"),
      { publicBaseUrl: "https://tickets.example.test", internalBaseUrl: undefined },
      fetch,
      [assertionResolver, clientIdResolver],
    );

    const identity = await registry.authenticateClientAssertion(
      "well-known:https://entity.example/client",
      makeTestJwt({ alg: "RS256" }),
      "https://tickets.example.test/token",
    );

    expect(identity?.authMode).toBe("well-known");
    expect(identity?.clientId).toBe("well-known-client");
  });
});

function makeResolver(
  authMode: AuthenticatedClientIdentity["authMode"],
  options?: {
    matchesAssertion?: NonNullable<FrameworkResolver["matchesAssertion"]>;
    matchesClientId?: FrameworkResolver["matchesClientId"];
  },
): FrameworkResolver {
  return {
    frameworkType: authMode === "oidf" ? "oidf" : authMode === "udap" ? "udap" : "well-known",
    getSupportedTrustFrameworks: () => [],
    matchesAssertion: options?.matchesAssertion,
    matchesClientId: options?.matchesClientId ?? (() => false),
    authenticateClientAssertion: async () => ({
      clientId: `${authMode}-client`,
      clientName: `${authMode} client`,
      tokenEndpointAuthMethod: "private_key_jwt",
      dynamic: false,
      authMode,
      availablePublicJwks: [],
    }),
  };
}

function makeTestJwt(header: Record<string, unknown>) {
  const encodedHeader = Buffer.from(JSON.stringify(header)).toString("base64url");
  const encodedPayload = Buffer.from(JSON.stringify({ sub: "client" })).toString("base64url");
  return `${encodedHeader}.${encodedPayload}.signature`;
}
