import { describe, expect, test } from "bun:test";
import { generateClientKeyMaterial, signPrivateKeyJwt } from "../../../../shared/private-key-jwt.ts";
import { verifyTrustChain } from "./trust-chain.ts";

describe("OIDF trust chain validation", () => {
  test("valid 3-deep chain succeeds", async () => {
    const fixture = await makeTrustChainFixture();

    const verified = await verifyTrustChain(fixture.chain, {
      expectedAnchor: fixture.anchor.entityId,
      trustedAnchorJwks: fixture.anchor.jwks.keys,
      nowSeconds: fixture.now,
    });

    expect(verified.depth).toBe(3);
    expect(verified.leaf.entityId).toBe(fixture.leaf.entityId);
    expect(verified.anchor.entityId).toBe(fixture.anchor.entityId);
    expect(verified.subordinateStatements).toHaveLength(2);
    expect(verified.statements).toHaveLength(4);
    expect(verified.metadataPolicies.map((entry) => entry.issuer)).toEqual([
      fixture.network.entityId,
      fixture.anchor.entityId,
    ]);
    expect(verified.leafMetadata.oauth_client?.client_name).toBe("Demo App");
    expect(verified.subordinateStatements[0]?.payload.jwks).toEqual(fixture.leaf.jwks);
    expect(verified.subordinateStatements[1]?.payload.jwks).toEqual(fixture.network.jwks);
  });

  test("tampering with the leaf statement breaks signature chaining", async () => {
    const fixture = await makeTrustChainFixture();
    const tamperedLeaf = tamperJwtPayload(fixture.chain[0], (payload) => ({
      ...payload,
      metadata: {
        ...payload.metadata,
        oauth_client: {
          ...(payload.metadata?.oauth_client ?? {}),
          client_name: "Mallory App",
        },
      },
    }));

    await expect(verifyTrustChain([tamperedLeaf, ...fixture.chain.slice(1)], {
      expectedAnchor: fixture.anchor.entityId,
      trustedAnchorJwks: fixture.anchor.jwks.keys,
      nowSeconds: fixture.now,
    }))
      .rejects.toThrow("signature verification failed");
  });

  test("expired subordinate statement invalidates the whole chain", async () => {
    const fixture = await makeTrustChainFixture({
      anchorToNetwork: {
        payloadOverrides: {
          iat: fixtureBaseNow() - 7200,
          exp: fixtureBaseNow() - 3600,
        },
      },
    });

    await expect(verifyTrustChain(fixture.chain, {
      expectedAnchor: fixture.anchor.entityId,
      trustedAnchorJwks: fixture.anchor.jwks.keys,
      nowSeconds: fixture.now,
    }))
      .rejects.toThrow("has expired");
  });

  test("wrong anchor invalidates the chain", async () => {
    const fixture = await makeTrustChainFixture();

    await expect(verifyTrustChain(fixture.chain, {
      expectedAnchor: "https://demo.example/federation/anchor/other",
      trustedAnchorJwks: fixture.anchor.jwks.keys,
      nowSeconds: fixture.now,
    }))
      .rejects.toThrow("terminates at");
  });

  test("wrong iss/sub linkage invalidates the chain", async () => {
    const fixture = await makeTrustChainFixture({
      networkToLeaf: {
        payloadOverrides: {
          sub: "https://demo.example/federation/leafs/other-app",
        },
      },
    });

    await expect(verifyTrustChain(fixture.chain, {
      expectedAnchor: fixture.anchor.entityId,
      trustedAnchorJwks: fixture.anchor.jwks.keys,
      nowSeconds: fixture.now,
    }))
      .rejects.toThrow("ES[0].iss must equal ES[1].sub");
  });

  test("missing leaf authority_hints invalidates the chain", async () => {
    const fixture = await makeTrustChainFixture({
      leaf: {
        configOverrides: {
          authority_hints: [],
        },
      },
    });

    await expect(verifyTrustChain(fixture.chain, {
      expectedAnchor: fixture.anchor.entityId,
      trustedAnchorJwks: fixture.anchor.jwks.keys,
      nowSeconds: fixture.now,
    }))
      .rejects.toThrow("authority_hints");
  });

  test("missing intermediate authority_hints does not invalidate static trust-chain validation", async () => {
    const fixture = await makeTrustChainFixture({
      network: {
        configOverrides: {
          authority_hints: [],
        },
      },
    });

    const verified = await verifyTrustChain(fixture.chain, {
      expectedAnchor: fixture.anchor.entityId,
      trustedAnchorJwks: fixture.anchor.jwks.keys,
      nowSeconds: fixture.now,
    });

    expect(verified.depth).toBe(3);
  });

  test("malformed trust_chain payload is rejected", async () => {
    const fixture = await makeTrustChainFixture();

    await expect(verifyTrustChain(["not-a-jwt", ...fixture.chain.slice(1)], {
      expectedAnchor: fixture.anchor.entityId,
      trustedAnchorJwks: fixture.anchor.jwks.keys,
      nowSeconds: fixture.now,
    }))
      .rejects.toThrow("Malformed entity statement");
  });

  test("missing header kid is rejected", async () => {
    const fixture = await makeTrustChainFixture({
      leaf: {
        headerOverrides: {
          kid: undefined,
        },
      },
    });

    await expect(verifyTrustChain(fixture.chain, {
      expectedAnchor: fixture.anchor.entityId,
      trustedAnchorJwks: fixture.anchor.jwks.keys,
      nowSeconds: fixture.now,
    })).rejects.toThrow("kid");
  });

  test("empty header kid is rejected", async () => {
    const fixture = await makeTrustChainFixture({
      networkToLeaf: {
        headerOverrides: {
          kid: "",
        },
      },
    });

    await expect(verifyTrustChain(fixture.chain, {
      expectedAnchor: fixture.anchor.entityId,
      trustedAnchorJwks: fixture.anchor.jwks.keys,
      nowSeconds: fixture.now,
    })).rejects.toThrow("kid");
  });

  test("kid mismatch against issuer jwks is rejected", async () => {
    const fixture = await makeTrustChainFixture({
      anchorToNetwork: {
        headerOverrides: {
          kid: "missing-anchor-key",
        },
      },
    });

    await expect(verifyTrustChain(fixture.chain, {
      expectedAnchor: fixture.anchor.entityId,
      trustedAnchorJwks: fixture.anchor.jwks.keys,
      nowSeconds: fixture.now,
    })).rejects.toThrow("kid");
  });

  test("duplicate kid values inside a statement jwks are rejected", async () => {
    const fixture = await makeTrustChainFixture({
      leaf: {
        configOverrides: {
          jwks: {
            keys: [
              fixtureDuplicateKey("duplicate-leaf-key"),
              fixtureDuplicateKey("duplicate-leaf-key"),
            ],
          },
        },
      },
    });

    await expect(verifyTrustChain(fixture.chain, {
      expectedAnchor: fixture.anchor.entityId,
      trustedAnchorJwks: fixture.anchor.jwks.keys,
      nowSeconds: fixture.now,
    })).rejects.toThrow("duplicate");
  });

  test("critical unknown claims are rejected", async () => {
    const fixture = await makeTrustChainFixture({
      leaf: {
        configOverrides: {
          crit: ["unsupported_crit_extension"],
          unsupported_crit_extension: true,
        },
      },
    });

    await expect(verifyTrustChain(fixture.chain, {
      expectedAnchor: fixture.anchor.entityId,
      trustedAnchorJwks: fixture.anchor.jwks.keys,
      nowSeconds: fixture.now,
    })).rejects.toThrow("crit");
  });

  test("critical claims cannot reference RFC-defined entity-statement claims", async () => {
    const fixture = await makeTrustChainFixture({
      leaf: {
        configOverrides: {
          crit: ["metadata"],
        },
      },
    });

    await expect(verifyTrustChain(fixture.chain, {
      expectedAnchor: fixture.anchor.entityId,
      trustedAnchorJwks: fixture.anchor.jwks.keys,
      nowSeconds: fixture.now,
    })).rejects.toThrow("crit");
  });

  test("max_path_length constraints reject chains with too many intermediates", async () => {
    const fixture = await makeTrustChainFixture({
      anchorToNetwork: {
        payloadOverrides: {
          constraints: {
            max_path_length: 0,
          },
        },
      },
    });

    await expect(verifyTrustChain(fixture.chain, {
      expectedAnchor: fixture.anchor.entityId,
      trustedAnchorJwks: fixture.anchor.jwks.keys,
      nowSeconds: fixture.now,
    })).rejects.toThrow("max_path_length");
  });

  test("naming_constraints permitted rejects a leaf outside the permitted host set", async () => {
    const fixture = await makeTrustChainFixture({
      anchorToNetwork: {
        payloadOverrides: {
          constraints: {
            naming_constraints: {
              permitted: ["issuer.example.test"],
            },
          },
        },
      },
    });

    await expect(verifyTrustChain(fixture.chain, {
      expectedAnchor: fixture.anchor.entityId,
      trustedAnchorJwks: fixture.anchor.jwks.keys,
      nowSeconds: fixture.now,
    })).rejects.toThrow("naming_constraints");
  });

  test("naming_constraints excluded rejects a leaf even when otherwise allowed", async () => {
    const fixture = await makeTrustChainFixture({
      anchorToNetwork: {
        payloadOverrides: {
          constraints: {
            naming_constraints: {
              permitted: ["demo.example"],
              excluded: ["demo.example"],
            },
          },
        },
      },
    });

    await expect(verifyTrustChain(fixture.chain, {
      expectedAnchor: fixture.anchor.entityId,
      trustedAnchorJwks: fixture.anchor.jwks.keys,
      nowSeconds: fixture.now,
    })).rejects.toThrow("naming_constraints");
  });
});

type EntityFixture = {
  entityId: string;
  jwks: { keys: JsonWebKey[] };
  privateJwk: JsonWebKey & { kid: string };
  metadata?: Record<string, Record<string, unknown>>;
  authorityHints?: string[];
};

type TrustChainFixture = {
  now: number;
  chain: string[];
  leaf: EntityFixture;
  network: EntityFixture;
  anchor: EntityFixture;
};

type FixtureOverrides = {
  leaf?: {
    configOverrides?: Partial<Record<string, unknown>>;
    headerOverrides?: Record<string, unknown>;
  };
  network?: {
    configOverrides?: Partial<Record<string, unknown>>;
    headerOverrides?: Record<string, unknown>;
  };
  anchor?: {
    configOverrides?: Partial<Record<string, unknown>>;
    headerOverrides?: Record<string, unknown>;
  };
  networkToLeaf?: {
    payloadOverrides?: Partial<Record<string, unknown>>;
    headerOverrides?: Record<string, unknown>;
  };
  anchorToNetwork?: {
    payloadOverrides?: Partial<Record<string, unknown>>;
    headerOverrides?: Record<string, unknown>;
  };
};

async function makeTrustChainFixture(overrides: FixtureOverrides = {}): Promise<TrustChainFixture> {
  const now = fixtureBaseNow();

  const leafKeys = await generateKeyFixture();
  const networkKeys = await generateKeyFixture();
  const anchorKeys = await generateKeyFixture();

  const leaf: EntityFixture = {
    entityId: "https://demo.example/federation/leafs/demo-app",
    jwks: { keys: [leafKeys.publicJwk] },
    privateJwk: leafKeys.privateJwk,
    authorityHints: ["https://demo.example/federation/networks/app"],
    metadata: {
      oauth_client: {
        client_name: "Demo App",
        grant_types: ["client_credentials"],
        token_endpoint_auth_method: "private_key_jwt",
      },
    },
  };
  const network: EntityFixture = {
    entityId: "https://demo.example/federation/networks/app",
    jwks: { keys: [networkKeys.publicJwk] },
    privateJwk: networkKeys.privateJwk,
    authorityHints: ["https://demo.example/federation/anchor"],
    metadata: {
      federation_entity: {
        organization_name: "App Network",
      },
    },
  };
  const anchor: EntityFixture = {
    entityId: "https://demo.example/federation/anchor",
    jwks: { keys: [anchorKeys.publicJwk] },
    privateJwk: anchorKeys.privateJwk,
    metadata: {
      federation_entity: {
        organization_name: "Trust Anchor",
      },
    },
  };

  const leafConfiguration = await signEntityStatement(
    {
      iss: leaf.entityId,
      sub: leaf.entityId,
      iat: now - 60,
      exp: now + 3600,
      jwks: leaf.jwks,
      metadata: leaf.metadata,
      authority_hints: leaf.authorityHints,
      ...overrides.leaf?.configOverrides,
    },
    leaf.privateJwk,
    overrides.leaf?.headerOverrides,
  );

  const networkToLeaf = await signEntityStatement(
    {
      iss: network.entityId,
      sub: leaf.entityId,
      iat: now - 60,
      exp: now + 3600,
      jwks: leaf.jwks,
      metadata_policy: {
        oauth_client: {
          client_name: {
            value: "Demo App from Policy",
          },
        },
      },
      ...overrides.networkToLeaf?.payloadOverrides,
    },
    network.privateJwk,
    overrides.networkToLeaf?.headerOverrides,
  );

  await signEntityStatement(
    {
      iss: network.entityId,
      sub: network.entityId,
      iat: now - 60,
      exp: now + 3600,
      jwks: network.jwks,
      metadata: network.metadata,
      authority_hints: network.authorityHints,
      ...overrides.network?.configOverrides,
    },
    network.privateJwk,
    overrides.network?.headerOverrides,
  );

  const anchorToNetwork = await signEntityStatement(
    {
      iss: anchor.entityId,
      sub: network.entityId,
      iat: now - 60,
      exp: now + 3600,
      jwks: network.jwks,
      metadata_policy: {
        federation_entity: {
          organization_name: {
            default: "Provider Network",
          },
        },
      },
      ...overrides.anchorToNetwork?.payloadOverrides,
    },
    anchor.privateJwk,
    overrides.anchorToNetwork?.headerOverrides,
  );

  const anchorConfiguration = await signEntityStatement(
    {
      iss: anchor.entityId,
      sub: anchor.entityId,
      iat: now - 60,
      exp: now + 3600,
      jwks: anchor.jwks,
      metadata: anchor.metadata,
      ...overrides.anchor?.configOverrides,
    },
    anchor.privateJwk,
    overrides.anchor?.headerOverrides,
  );

  return {
    now,
    chain: [
      leafConfiguration,
      networkToLeaf,
      anchorToNetwork,
      anchorConfiguration,
    ],
    leaf,
    network,
    anchor,
  };
}

async function signEntityStatement(
  payload: Record<string, unknown>,
  privateJwk: JsonWebKey & { kid: string },
  headerOverrides: Record<string, unknown> = {},
) {
  return signPrivateKeyJwt(payload, privateJwk, {
    typ: "entity-statement+jwt",
    kid: privateJwk.kid,
    ...headerOverrides,
  });
}

function tamperJwtPayload(token: string, update: (payload: Record<string, any>) => Record<string, any>) {
  const [encodedHeader, encodedPayload, encodedSignature] = token.split(".");
  if (!encodedHeader || !encodedPayload || !encodedSignature) throw new Error("Malformed JWT");
  const payload = JSON.parse(Buffer.from(encodedPayload, "base64url").toString("utf8")) as Record<string, any>;
  const nextPayload = update(payload);
  return `${encodedHeader}.${Buffer.from(JSON.stringify(nextPayload), "utf8").toString("base64url")}.${encodedSignature}`;
}

function fixtureBaseNow() {
  return Math.floor(Date.now() / 1000);
}

async function generateKeyFixture() {
  const keyMaterial = await generateClientKeyMaterial();
  return {
    publicJwk: {
      ...keyMaterial.publicJwk,
      kid: keyMaterial.thumbprint,
    } satisfies JsonWebKey & { kid: string },
    privateJwk: {
      ...keyMaterial.privateJwk,
      kid: keyMaterial.thumbprint,
    } satisfies JsonWebKey & { kid: string },
  };
}

function fixtureDuplicateKey(kid: string): JsonWebKey & { kid: string } {
  return {
    kty: "EC",
    crv: "P-256",
    x: "f83OJ3D2xF4wD7-BL3J6dOrjP6KycdxY6z3n9JVpazA",
    y: "x_FEzRu9dJ0M1nP9Wcv16O3MHuvb6jVWeItPxX2VINo",
    alg: "ES256",
    use: "sig",
    key_ops: ["verify"],
    kid,
  };
}
