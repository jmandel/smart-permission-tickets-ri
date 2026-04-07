import { describe, expect, test } from "bun:test";
import { generateClientKeyMaterial, signPrivateKeyJwt } from "../../../../shared/private-key-jwt.ts";
import { applyMetadataPolicy } from "./policy.ts";
import { verifyTrustChain } from "./trust-chain.ts";

describe("OIDF metadata policy", () => {
  test("value forces the resolved value", async () => {
    const fixture = await makePolicyFixture();

    const verified = await verifyTrustChain(fixture.chain, {
      expectedAnchor: fixture.anchorEntityId,
      trustedAnchorJwks: fixture.anchorJwks.keys,
      nowSeconds: fixture.now,
    });
    const resolved = applyMetadataPolicy(verified);

    expect(resolved.metadata.oauth_client?.client_name).toBe("Demo App from Policy");
  });

  test("default fills only when the leaf omits the field", async () => {
    const fixture = await makePolicyFixture({
      leafMetadata: {
        oauth_client: {
          token_endpoint_auth_method: "private_key_jwt",
        },
      },
      networkPolicy: {
        oauth_client: {
          logo_uri: {
            default: "https://assets.example/logo.png",
          },
        },
      },
      anchorPolicy: {
        oauth_client: {
          client_name: {
            default: "Anchor Default Name",
          },
        },
      },
    });

    const verified = await verifyTrustChain(fixture.chain, {
      expectedAnchor: fixture.anchorEntityId,
      trustedAnchorJwks: fixture.anchorJwks.keys,
      nowSeconds: fixture.now,
    });
    const resolved = applyMetadataPolicy(verified);

    expect(resolved.metadata.oauth_client?.logo_uri).toBe("https://assets.example/logo.png");
    expect(resolved.metadata.oauth_client?.client_name).toBe("Anchor Default Name");
  });

  test("one_of narrows to an allowed value", async () => {
    const fixture = await makePolicyFixture({
      leafMetadata: {
        oauth_client: {
          client_name: "Demo App",
          token_endpoint_auth_method: "private_key_jwt",
        },
      },
      networkPolicy: {
        oauth_client: {
          token_endpoint_auth_method: {
            one_of: ["private_key_jwt", "tls_client_auth"],
          },
        },
      },
      anchorPolicy: {
        oauth_client: {
          token_endpoint_auth_method: {
            one_of: ["private_key_jwt"],
          },
        },
      },
    });

    const verified = await verifyTrustChain(fixture.chain, {
      expectedAnchor: fixture.anchorEntityId,
      trustedAnchorJwks: fixture.anchorJwks.keys,
      nowSeconds: fixture.now,
    });
    const resolved = applyMetadataPolicy(verified);

    expect(resolved.metadata.oauth_client?.token_endpoint_auth_method).toBe("private_key_jwt");
  });

  test("conflicting one_of policies fail resolution", async () => {
    const fixture = await makePolicyFixture({
      leafMetadata: {
        oauth_client: {
          token_endpoint_auth_method: "private_key_jwt",
        },
      },
      networkPolicy: {
        oauth_client: {
          token_endpoint_auth_method: {
            one_of: ["private_key_jwt"],
          },
        },
      },
      anchorPolicy: {
        oauth_client: {
          token_endpoint_auth_method: {
            one_of: ["tls_client_auth"],
          },
        },
      },
    });

    const verified = await verifyTrustChain(fixture.chain, {
      expectedAnchor: fixture.anchorEntityId,
      trustedAnchorJwks: fixture.anchorJwks.keys,
      nowSeconds: fixture.now,
    });

    expect(() => applyMetadataPolicy(verified)).toThrow("one_of");
  });

  test("unsupported operator causes chain invalidation", async () => {
    const fixture = await makePolicyFixture({
      networkPolicy: {
        oauth_client: {
          grant_types: {
            add: ["client_credentials"],
          },
        },
      },
    });

    const verified = await verifyTrustChain(fixture.chain, {
      expectedAnchor: fixture.anchorEntityId,
      trustedAnchorJwks: fixture.anchorJwks.keys,
      nowSeconds: fixture.now,
    });

    expect(() => applyMetadataPolicy(verified)).toThrow("unsupported");
  });
});

type PolicyFixtureOptions = {
  leafMetadata?: Record<string, Record<string, unknown>>;
  networkPolicy?: Record<string, Record<string, Record<string, unknown>>>;
  anchorPolicy?: Record<string, Record<string, Record<string, unknown>>>;
};

async function makePolicyFixture(options: PolicyFixtureOptions = {}) {
  const now = Math.floor(Date.now() / 1000);
  const leafKeys = await generateClientKeyMaterial();
  const networkKeys = await generateClientKeyMaterial();
  const anchorKeys = await generateClientKeyMaterial();

  const leafEntityId = "https://demo.example/federation/leafs/demo-app";
  const networkEntityId = "https://demo.example/federation/networks/app";
  const anchorEntityId = "https://demo.example/federation/anchor";

  const leafConfiguration = await signStatement({
    iss: leafEntityId,
    sub: leafEntityId,
    iat: now - 60,
    exp: now + 3600,
    jwks: { keys: [leafKeys.publicJwk] },
    metadata: options.leafMetadata ?? {
      oauth_client: {
        client_name: "Leaf Demo App",
      },
    },
    authority_hints: [networkEntityId],
  }, leafKeys.privateJwk);

  const networkToLeaf = await signStatement({
    iss: networkEntityId,
    sub: leafEntityId,
    iat: now - 60,
    exp: now + 3600,
    jwks: { keys: [leafKeys.publicJwk] },
    metadata_policy: options.networkPolicy ?? {
      oauth_client: {
        client_name: {
          value: "Demo App from Policy",
        },
      },
    },
  }, networkKeys.privateJwk);

  const anchorToNetwork = await signStatement({
    iss: anchorEntityId,
    sub: networkEntityId,
    iat: now - 60,
    exp: now + 3600,
    jwks: { keys: [networkKeys.publicJwk] },
    metadata_policy: options.anchorPolicy ?? {
      oauth_client: {
        client_name: {
          default: "Anchor Demo App",
        },
      },
    },
  }, anchorKeys.privateJwk);

  const anchorConfiguration = await signStatement({
    iss: anchorEntityId,
    sub: anchorEntityId,
    iat: now - 60,
    exp: now + 3600,
    jwks: { keys: [anchorKeys.publicJwk] },
    metadata: {
      federation_entity: {
        organization_name: "Trust Anchor",
      },
    },
  }, anchorKeys.privateJwk);

  return {
    now,
    anchorEntityId,
    anchorJwks: { keys: [anchorKeys.publicJwk] },
    chain: [
      leafConfiguration,
      networkToLeaf,
      anchorToNetwork,
      anchorConfiguration,
    ],
  };
}

async function signStatement(payload: Record<string, unknown>, privateJwk: JsonWebKey) {
  return signPrivateKeyJwt(payload, privateJwk, { typ: "entity-statement+jwt" });
}
