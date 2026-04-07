import { computeJwkThumbprint, decodeJwtWithoutVerification, normalizePublicJwk, verifyPrivateKeyJwt } from "../../../../shared/private-key-jwt.ts";
import { toAuthenticatedClientIdentity } from "../../client-identity.ts";
import type {
  AuthenticatedClientIdentity,
  FrameworkDefinition,
  ResolvedFrameworkEntity,
  ResolvedIssuerTrust,
} from "../../../store/model.ts";
import type { ServerConfig } from "../../../config.ts";
import type { FrameworkResolver, SupportedTrustFramework } from "../types.ts";
import { federationFetchEndpointPath, oidfEntityConfigurationPath } from "./demo-topology.ts";
import { applyMetadataPolicy } from "./policy.ts";
import type { EntityStatementPayload, VerifiedTrustChain } from "./trust-chain.ts";
import { verifyTrustChain } from "./trust-chain.ts";
import { verifyTrustMark } from "./trust-mark.ts";

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
    const oidfFrameworks = this.frameworks.filter((framework) => framework.frameworkType === "oidf" && framework.supportsIssuerTrust && framework.oidf);
    for (const framework of oidfFrameworks) {
      if (framework.oidf?.ticketIssuerUrl !== _issuerUrl) continue;
      return this.resolveIssuerTrustAgainstFramework(framework, _issuerUrl);
    }
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

    const verifiedChain = await verifyTrustChain(trustChain, {
      expectedAnchor: oidf.trustAnchorEntityId,
      trustedAnchorJwks: requiredTrustedAnchorJwks(oidf),
    });
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
        trust_chain: buildDecodedTrustChainArtifact(verifiedChain),
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

  private async resolveIssuerTrustAgainstFramework(framework: FrameworkDefinition, issuerUrl: string): Promise<ResolvedIssuerTrust> {
    const oidf = framework.oidf;
    if (!oidf) {
      throw new Error(`OIDF framework ${framework.framework} is missing topology settings`);
    }

    const trustChain = await fetchTrustChain(
      oidf.ticketIssuerEntityId,
      oidf.trustAnchorEntityId,
      this.config,
      this.fetchImpl,
    );
    const verifiedChain = await verifyTrustChain(trustChain, {
      expectedAnchor: oidf.trustAnchorEntityId,
      trustedAnchorJwks: requiredTrustedAnchorJwks(oidf),
    });
    if (verifiedChain.leaf.entityId !== oidf.ticketIssuerEntityId) {
      throw new Error(`OIDF issuer trust leaf ${verifiedChain.leaf.entityId} does not match ${oidf.ticketIssuerEntityId}`);
    }

    const resolved = applyMetadataPolicy(verifiedChain);
    const resolvedIssuerUrl = resolved.metadata.federation_entity?.issuer_url;
    if (resolvedIssuerUrl !== issuerUrl) {
      throw new Error(`OIDF issuer_url ${String(resolvedIssuerUrl ?? "")} does not match ${issuerUrl}`);
    }

    const providerNetworkStatement = verifiedChain.subordinateStatements.find((statement) => statement.payload.sub === oidf.providerNetworkEntityId);
    if (!providerNetworkStatement) {
      throw new Error(`OIDF trust chain does not endorse provider network ${oidf.providerNetworkEntityId}`);
    }

    const trustMarks = verifiedChain.leaf.payload.trust_marks;
    if (!Array.isArray(trustMarks) || trustMarks.length === 0) {
      throw new Error("OIDF issuer trust mark is missing");
    }

    let verifiedTrustMark: Awaited<ReturnType<typeof verifyTrustMark>> | null = null;
    let trustMarkError: Error | null = null;
    for (const trustMark of trustMarks) {
      try {
        verifiedTrustMark = await verifyTrustMark(trustMark, {
          issuerEntityId: oidf.providerNetworkEntityId,
          subjectEntityId: oidf.ticketIssuerEntityId,
          expectedTrustMarkType: oidf.trustMarkType,
          issuerJwks: providerNetworkStatement.payload.jwks?.keys ?? [],
        });
        break;
      } catch (error) {
        trustMarkError = error instanceof Error ? error : new Error(String(error));
      }
    }
    if (!verifiedTrustMark) {
      throw trustMarkError ?? new Error("OIDF issuer trust mark verification failed");
    }

    const displayName = typeof resolved.metadata.federation_entity?.organization_name === "string"
      ? resolved.metadata.federation_entity.organization_name
      : verifiedChain.leaf.entityId;

    return {
      source: "framework",
      issuerUrl,
      displayName,
      framework: {
        uri: framework.framework,
        type: "oidf",
      },
      publicJwks: resolved.jwks,
      metadata: {
        resolution: "oidf-issuer-trust",
        entity_id: verifiedChain.leaf.entityId,
        trust_chain_depth: verifiedChain.depth,
        trust_chain: buildDecodedTrustChainArtifact(verifiedChain),
        resolved_metadata: resolved.metadata,
        trust_mark: verifiedTrustMark.payload,
      },
    };
  }
}

function buildDecodedTrustChainArtifact(verifiedChain: VerifiedTrustChain) {
  return {
    expected_anchor: verifiedChain.expectedAnchor,
    anchor_entity_id: verifiedChain.anchor.entityId,
    leaf_entity_id: verifiedChain.leaf.entityId,
    trust_chain_depth: verifiedChain.depth,
    statements: verifiedChain.statements.map((statement) => ({
      position: statement.position,
      kind: statement.kind,
      entity_id: statement.entityId,
      signer_entity_id: statement.signerEntityId,
      header: statement.header,
      payload: statement.payload,
    })),
  };
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

async function fetchTrustChain(
  leafEntityId: string,
  expectedAnchorEntityId: string,
  config: Pick<ServerConfig, "publicBaseUrl" | "internalBaseUrl">,
  fetchImpl: typeof fetch,
) {
  const chain: string[] = [];
  let currentEntityId: string | undefined = leafEntityId;
  let currentEntityConfigurationJwt: string | undefined;
  let depth = 0;

  while (currentEntityId) {
    depth += 1;
    if (depth > 3) {
      throw new Error("OIDF issuer trust chain exceeds the supported depth of 3");
    }

    if (!currentEntityConfigurationJwt) {
      currentEntityConfigurationJwt = await fetchJwt(
        `${config.publicBaseUrl}${oidfEntityConfigurationPath(currentEntityId)}`,
        "entity configuration",
        config,
        fetchImpl,
      );
      chain.push(currentEntityConfigurationJwt);
    }
    const decoded = decodeEntityStatementPayload(currentEntityConfigurationJwt);
    const authorityHints = Array.isArray(decoded.authority_hints)
      ? decoded.authority_hints.filter((hint): hint is string => typeof hint === "string" && !!hint)
      : [];
    if (authorityHints.length === 0) break;
    if (authorityHints.length > 1) {
      throw new Error(`OIDF issuer trust only supports a single authority_hints parent for ${currentEntityId}`);
    }

    const parentEntityId = authorityHints[0];
    const fetchUrl = new URL(`${config.publicBaseUrl}${federationFetchEndpointPath(parentEntityId)}`);
    fetchUrl.searchParams.set("sub", currentEntityId);
    const subordinateStatementJwt = await fetchJwt(fetchUrl.toString(), "subordinate statement", config, fetchImpl);
    chain.push(subordinateStatementJwt);

    const parentEntityConfigurationJwt = await fetchJwt(
      `${config.publicBaseUrl}${oidfEntityConfigurationPath(parentEntityId)}`,
      "entity configuration",
      config,
      fetchImpl,
    );
    if (parentEntityId === expectedAnchorEntityId) {
      chain.push(parentEntityConfigurationJwt);
      break;
    }

    currentEntityId = parentEntityId;
    currentEntityConfigurationJwt = parentEntityConfigurationJwt;
  }

  return chain;
}

async function fetchJwt(
  targetUrl: string,
  label: string,
  config: Pick<ServerConfig, "publicBaseUrl" | "internalBaseUrl">,
  fetchImpl: typeof fetch,
) {
  const response = await fetchImpl(rewriteSelfFetchUrl(targetUrl, config.publicBaseUrl, config.internalBaseUrl), { redirect: "follow" });
  if (!response.ok) {
    throw new Error(`OIDF ${label} fetch failed (${response.status})`);
  }
  const body = (await response.text()).trim();
  if (!body) {
    throw new Error(`OIDF ${label} fetch returned an empty body`);
  }
  return body;
}

function decodeEntityStatementPayload(jwt: string) {
  try {
    return decodeJwtWithoutVerification<EntityStatementPayload>(jwt).payload;
  } catch (error) {
    throw new Error(`Malformed OIDF entity statement during fetch: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function rewriteSelfFetchUrl(targetUrl: string, publicBaseUrl: string, internalBaseUrl: string | undefined) {
  if (!internalBaseUrl) return targetUrl;
  const target = new URL(targetUrl);
  const publicBase = new URL(publicBaseUrl);
  if (target.origin !== publicBase.origin) return targetUrl;
  const internalBase = new URL(internalBaseUrl);
  return `${internalBase.origin}${target.pathname}${target.search}`;
}

function requiredTrustedAnchorJwks(oidf: NonNullable<FrameworkDefinition["oidf"]>) {
  if (!Array.isArray(oidf.trustAnchorJwks) || oidf.trustAnchorJwks.length === 0) {
    throw new Error("OIDF framework is missing configured trust anchor jwks");
  }
  return oidf.trustAnchorJwks;
}
