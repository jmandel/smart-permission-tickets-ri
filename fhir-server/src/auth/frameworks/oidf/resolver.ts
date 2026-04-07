import { computeJwkThumbprint, normalizePublicJwk, verifyPrivateKeyJwt } from "../../../../shared/private-key-jwt.ts";
import { toAuthenticatedClientIdentity } from "../../client-identity.ts";
import type {
  AuthenticatedClientIdentity,
  FrameworkDefinition,
  ResolvedFrameworkEntity,
  ResolvedIssuerTrust,
} from "../../../store/model.ts";
import type { ServerConfig } from "../../../config.ts";
import type { FrameworkResolver, SupportedTrustFramework } from "../types.ts";
import { applyMetadataPolicy } from "./policy.ts";
import { verifyTrustChain } from "./trust-chain.ts";

export class OidfFrameworkResolver implements FrameworkResolver {
  readonly frameworkType = "oidf" as const;

  constructor(
    private readonly frameworks: FrameworkDefinition[],
    private readonly config: Pick<ServerConfig, "publicBaseUrl" | "internalBaseUrl">,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  getSupportedTrustFrameworks(): SupportedTrustFramework[] {
    return this.frameworks
      .filter((framework) => framework.frameworkType === "oidf" && (framework.supportsClientAuth || framework.supportsIssuerTrust))
      .map((framework) => ({
        framework: framework.framework,
        framework_type: framework.frameworkType,
      }));
  }

  matchesAssertion(_clientId: string, joseHeader: Record<string, unknown>) {
    return Array.isArray(joseHeader.trust_chain);
  }

  matchesClientId(_clientId: string) {
    return false;
  }

  async authenticateClientAssertion(clientId: string, assertionJwt: string, tokenEndpointUrl: string): Promise<AuthenticatedClientIdentity | null> {
    const joseHeader = decodeOidfJoseHeader(assertionJwt);
    const trustChain = normalizeTrustChain(joseHeader.trust_chain);
    const oidfFrameworks = this.frameworks.filter((framework) => framework.frameworkType === "oidf" && framework.supportsClientAuth && framework.oidf);
    if (!oidfFrameworks.length) {
      throw new Error("OIDF client authentication is not configured");
    }

    let lastError: Error | null = null;
    for (const framework of oidfFrameworks) {
      try {
        return await this.authenticateAgainstFramework(framework, clientId, assertionJwt, tokenEndpointUrl, trustChain);
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
      }
    }

    throw lastError ?? new Error("OIDF client authentication failed");
  }

  async resolveIssuerTrust(_issuerUrl: string): Promise<ResolvedIssuerTrust | null> {
    void this.config;
    void this.fetchImpl;
    return null;
  }

  private async authenticateAgainstFramework(
    framework: FrameworkDefinition,
    clientId: string,
    assertionJwt: string,
    tokenEndpointUrl: string,
    trustChain: string[],
  ) {
    const oidf = framework.oidf;
    if (!oidf) {
      throw new Error(`OIDF framework ${framework.framework} is missing topology settings`);
    }

    const verifiedChain = await verifyTrustChain(trustChain, oidf.trustAnchorEntityId);
    if (verifiedChain.leaf.entityId !== clientId) {
      throw new Error(`OIDF client_id ${clientId} does not match trust-chain leaf ${verifiedChain.leaf.entityId}`);
    }
    const resolved = applyMetadataPolicy(verifiedChain);
    const verifiedAssertion = await verifyAssertionAgainstJwks(assertionJwt, resolved.jwks, clientId, tokenEndpointUrl);
    const clientName = typeof resolved.metadata.oauth_client?.client_name === "string"
      ? resolved.metadata.oauth_client.client_name
      : clientId;

    const resolvedEntity: ResolvedFrameworkEntity = {
      framework: {
        uri: framework.framework,
        type: "oidf",
      },
      entityUri: clientId,
      displayName: clientName,
      publicJwks: resolved.jwks,
      metadata: {
        resolution: "oidf-trust-chain",
        trust_chain_depth: verifiedChain.depth,
        resolved_metadata: resolved.metadata,
      },
    };

    return toAuthenticatedClientIdentity(
      {
        clientId,
        clientName,
        tokenEndpointAuthMethod: "private_key_jwt",
        dynamic: false,
        authMode: "oidf",
        frameworkBinding: {
          method: "framework_client",
          framework: framework.framework,
          framework_type: "oidf",
          entity_uri: clientId,
        },
        publicJwk: verifiedAssertion.publicJwk,
        availablePublicJwks: resolved.jwks,
        jwkThumbprint: verifiedAssertion.jwkThumbprint,
      },
      {
        resolvedEntity,
        availablePublicJwks: resolved.jwks,
        publicJwk: verifiedAssertion.publicJwk,
        jwkThumbprint: verifiedAssertion.jwkThumbprint,
      },
    );
  }
}

async function verifyAssertionAgainstJwks(
  assertionJwt: string,
  candidateJwks: JsonWebKey[],
  clientId: string,
  tokenEndpointUrl: string,
) {
  const now = Math.floor(Date.now() / 1000);
  let lastError: Error | null = null;
  for (const jwk of candidateJwks) {
    try {
      const normalizedKey = normalizePublicJwk(jwk);
      const { payload } = await verifyPrivateKeyJwt<any>(assertionJwt, normalizedKey);
      if (payload.iss !== clientId || payload.sub !== clientId) throw new Error("Invalid client assertion");
      if (payload.aud !== tokenEndpointUrl) throw new Error("Client assertion audience mismatch");
      if (typeof payload.exp !== "number" || payload.exp <= now) throw new Error("Client assertion expired");
      if (typeof payload.iat === "number" && payload.iat > now + 60) throw new Error("Client assertion issued in the future");
      if (typeof payload.jti !== "string" || !payload.jti.trim()) throw new Error("Client assertion jti missing");
      return {
        publicJwk: normalizedKey,
        jwkThumbprint: await computeJwkThumbprint(normalizedKey),
      };
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
    }
  }
  throw lastError ?? new Error("Invalid client assertion signature");
}

function decodeOidfJoseHeader(assertionJwt: string) {
  const [encodedHeader = ""] = assertionJwt.split(".", 1);
  if (!encodedHeader) return {};
  try {
    return JSON.parse(Buffer.from(encodedHeader, "base64url").toString("utf8")) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function normalizeTrustChain(value: unknown) {
  if (!Array.isArray(value) || value.length === 0 || !value.every((entry) => typeof entry === "string" && entry.trim())) {
    throw new Error("OIDF trust_chain header must be a non-empty array of entity statements");
  }
  return value;
}
