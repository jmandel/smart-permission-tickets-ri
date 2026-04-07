import { describe, expect, test } from "bun:test";

import { decodeJwtWithoutVerification } from "../../shared/private-key-jwt";
import { buildClientAssertion } from "./lib/viewer-client";
import type { RegisteredClientInfo, ViewerOidfClientPlan } from "./types";

const privateJwk: JsonWebKey = {
  kty: "EC",
  crv: "P-256",
  x: "gwA5e-J9PsxXXZ8arlndCk8-tqiJ3Ye0_BdBTVfvahQ",
  y: "mkjjr7GMPWB26IpuJJKsq7TkhszYr4WQID2SH8CPDbQ",
  d: "DaNuMMgobU757Zs4zr8PJFl6QnrBozHRFqT917WP0QE",
};

describe("viewer OIDF client assertion", () => {
  test("injects trust_chain into the client_assertion JOSE header", async () => {
    const client: RegisteredClientInfo = {
      clientId: "https://tickets.example.test/federation/leafs/demo-app",
      clientName: "OpenID Federation Demo App",
      tokenEndpointAuthMethod: "private_key_jwt",
      authMode: "oidf",
      publicJwk: privateJwk,
    };
    const clientPlan: ViewerOidfClientPlan = {
      type: "oidf",
      displayLabel: "OIDF client",
      registrationMode: "oidf-automatic",
      entityUri: client.clientId,
      entityConfigurationUrl: `${client.clientId}/.well-known/openid-federation`,
      clientName: client.clientName,
      publicJwk: privateJwk,
      privateJwk,
      trustChain: [
        "leaf-config-jwt",
        "app-network-subordinate-jwt",
        "anchor-subordinate-jwt",
        "anchor-config-jwt",
      ],
      framework: {
        uri: "https://smarthealthit.org/trust-frameworks/reference-demo-oidf",
        displayName: "Demo OpenID Federation",
      },
    };

    const assertion = await buildClientAssertion(client, clientPlan, "https://tickets.example.test/token");
    const decoded = decodeJwtWithoutVerification<Record<string, any>>(assertion);

    expect(decoded.header.trust_chain).toEqual(clientPlan.trustChain);
    expect(decoded.payload.iss).toBe(client.clientId);
    expect(decoded.payload.aud).toBe("https://tickets.example.test/token");
  });
});
