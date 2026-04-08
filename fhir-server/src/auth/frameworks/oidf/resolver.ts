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
import { applyMetadataPolicy } from "./policy.ts";
import { extractTicketIssuerMetadata } from "./smart-permission-ticket-issuer.ts";
import type { EntityStatementPayload, VerifiedTrustChain } from "./trust-chain.ts";
import { verifyTrustChain } from "./trust-chain.ts";
import { verifyTrustMark } from "./trust-mark.ts";
import {
  fetchOidfText,
  oidfEntityConfigurationUrl,
  resolvePublishedFederationFetchEndpointUrl,
  rewriteSelfOriginFetchUrl,
} from "./urls.ts";

export class OidfFrameworkResolver implements FrameworkResolver {
  readonly frameworkType = "oidf" as const;
  private readonly issuerTrustCache = new Map<string, { expiresAt: number; value: ResolvedIssuerTrust }>();

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
      const trustedLeaves = findTrustedIssuerLeaves(framework, _issuerUrl);
      if (!trustedLeaves.length) continue;
      if (trustedLeaves.length > 1) {
        throw new Error(`OIDF issuer ${_issuerUrl} matches multiple allowlisted leaves`);
      }
      const cacheKey = buildIssuerTrustCacheKey(framework, _issuerUrl, trustedLeaves[0]!);
      const cached = this.readIssuerTrustCache(cacheKey);
      if (cached) return cached;
      return this.resolveIssuerTrustAgainstFramework(framework, _issuerUrl, trustedLeaves[0]!);
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

    const verifiedChain = await verifyTrustChainAgainstConfiguredAnchors(trustChain, oidf);
    if (verifiedChain.leaf.entityId !== clientId) {
      throw new Error(`OIDF client_id ${clientId} does not match trust-chain leaf ${verifiedChain.leaf.entityId}`);
    }
    if (!isAllowlistedClientLeaf(oidf, verifiedChain.leaf.entityId)) {
      throw new Error(`OIDF leaf ${verifiedChain.leaf.entityId} is not allowlisted for client authentication`);
    }
    const resolved = applyMetadataPolicy(verifiedChain);
    const verifiedAssertion = await verifyAssertionAgainstJwks(assertionJwt, resolved.leafEntityJwks, clientId, tokenEndpointUrl);
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
      publicJwks: resolved.leafEntityJwks,
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
        availablePublicJwks: resolved.leafEntityJwks,
        jwkThumbprint: verifiedAssertion.jwkThumbprint,
      },
      {
        resolvedEntity,
        availablePublicJwks: resolved.leafEntityJwks,
        publicJwk: verifiedAssertion.publicJwk,
        jwkThumbprint: verifiedAssertion.jwkThumbprint,
      },
    );
  }

  private async resolveIssuerTrustAgainstFramework(
    framework: FrameworkDefinition,
    issuerUrl: string,
    trustedLeaf: NonNullable<FrameworkDefinition["oidf"]>["trustedLeaves"][number],
  ): Promise<ResolvedIssuerTrust> {
    const oidf = framework.oidf;
    if (!oidf) {
      throw new Error(`OIDF framework ${framework.framework} is missing topology settings`);
    }
    const cacheKey = buildIssuerTrustCacheKey(framework, issuerUrl, trustedLeaf);

    let fetchedTrustChain: FetchedTrustChain;
    try {
      fetchedTrustChain = await fetchTrustChain(
        trustedLeaf.entityId,
        firstTrustedAnchor(oidf).entityId,
        this.config,
        this.fetchImpl,
        {
          maxDepth: oidf.maxTrustChainDepth ?? 10,
          maxAuthorityHints: oidf.maxAuthorityHints ?? 8,
        },
      );
    } catch (error) {
      throw new Error(`OIDF issuer trust discovery failed for ${trustedLeaf.entityId}: ${formatError(error)}`);
    }
    const verifiedChain = await verifyTrustChainAgainstConfiguredAnchors(fetchedTrustChain.chain, oidf);
    if (verifiedChain.leaf.entityId !== trustedLeaf.entityId) {
      throw new Error(`OIDF issuer trust leaf ${verifiedChain.leaf.entityId} does not match ${trustedLeaf.entityId}`);
    }

    const resolved = applyMetadataPolicy(verifiedChain);
    const ticketIssuer = extractTicketIssuerMetadata(resolved.metadata);
    if (ticketIssuer.issuer_url !== issuerUrl) {
      throw new Error(
        `OIDF oidf_ticket_issuer_url_mismatch: ${ticketIssuer.issuer_url} does not match resolved issuer ${issuerUrl}`,
      );
    }

    const trustMarkType = trustedLeaf.requiredTrustMarkType;
    if (!trustMarkType) {
      throw new Error(`OIDF issuer leaf ${trustedLeaf.entityId} is missing requiredTrustMarkType`);
    }

    const immediateSuperiorEntityId = verifiedChain.subordinateStatements[0]?.payload.iss;
    if (typeof immediateSuperiorEntityId !== "string" || !immediateSuperiorEntityId) {
      throw new Error("OIDF issuer trust chain is missing an immediate superior for trust-mark verification");
    }
    const trustMarkIssuerJwks = findStatementJwksForEntity(verifiedChain, immediateSuperiorEntityId);
    if (!trustMarkIssuerJwks.length) {
      throw new Error(`OIDF trust chain does not expose jwks for trust-mark issuer ${immediateSuperiorEntityId}`);
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
          issuerEntityId: immediateSuperiorEntityId,
          subjectEntityId: trustedLeaf.entityId,
          expectedTrustMarkType: trustMarkType,
          issuerJwks: trustMarkIssuerJwks,
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

    const resolvedIssuerTrust: ResolvedIssuerTrust = {
      source: "framework",
      issuerUrl,
      displayName,
      framework: {
        uri: framework.framework,
        type: "oidf",
      },
      publicJwks: ticketIssuer.publicJwks,
      metadata: {
        resolution: "oidf-issuer-trust",
        entity_id: verifiedChain.leaf.entityId,
        trust_chain_depth: verifiedChain.depth,
        trust_chain: buildDecodedTrustChainArtifact(verifiedChain),
        trust_chain_discovery: fetchedTrustChain.discoverySources,
        resolved_metadata: resolved.metadata,
        trust_mark: verifiedTrustMark.payload,
      },
    };
    const expiresAt = computeIssuerTrustCacheExpiry(verifiedChain, verifiedTrustMark, framework.cacheTtlSeconds);
    if (expiresAt > Date.now()) {
      this.issuerTrustCache.set(cacheKey, {
        expiresAt,
        value: resolvedIssuerTrust,
      });
    }
    return resolvedIssuerTrust;
  }

  private readIssuerTrustCache(cacheKey: string) {
    const entry = this.issuerTrustCache.get(cacheKey);
    if (!entry) return null;
    if (entry.expiresAt <= Date.now()) {
      this.issuerTrustCache.delete(cacheKey);
      return null;
    }
    return entry.value;
  }
}

type FetchedTrustChain = {
  chain: string[];
  discoverySources: Array<{
    kind: "entity-configuration" | "subordinate-statement";
    entity_id: string;
    published_url: string;
    published_request: string;
    effective_request?: string;
  }>;
};

function buildDecodedTrustChainArtifact(
  verifiedChain: VerifiedTrustChain,
) {
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
  options: {
    maxDepth: number;
    maxAuthorityHints: number;
  },
) : Promise<FetchedTrustChain> {
  return fetchTrustChainPath({
    currentEntityId: leafEntityId,
    expectedAnchorEntityId,
    config,
    fetchImpl,
    maxDepth: options.maxDepth,
    maxAuthorityHints: options.maxAuthorityHints,
    depth: 1,
    visited: new Set(),
  });
}

function decodeEntityStatementPayload(jwt: string) {
  try {
    return decodeJwtWithoutVerification<EntityStatementPayload>(jwt).payload;
  } catch (error) {
    throw new Error(`Malformed OIDF entity statement during fetch: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function firstTrustedAnchor(oidf: NonNullable<FrameworkDefinition["oidf"]>) {
  const anchor = oidf.trustAnchors[0];
  if (!anchor) {
    throw new Error("OIDF framework is missing configured trust anchors");
  }
  return anchor;
}

async function verifyTrustChainAgainstConfiguredAnchors(
  trustChain: string[],
  oidf: NonNullable<FrameworkDefinition["oidf"]>,
) {
  if (!Array.isArray(oidf.trustAnchors) || oidf.trustAnchors.length === 0) {
    throw new Error("OIDF framework is missing configured trust anchors");
  }
  let lastError: Error | null = null;
  for (const trustAnchor of oidf.trustAnchors) {
    if (!Array.isArray(trustAnchor.jwks) || trustAnchor.jwks.length === 0) {
      continue;
    }
    try {
      return await verifyTrustChain(trustChain, {
        expectedAnchor: trustAnchor.entityId,
        trustedAnchorJwks: trustAnchor.jwks,
        maxDepth: oidf.maxTrustChainDepth ?? 10,
      });
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
    }
  }
  if (!lastError) {
    throw new Error("OIDF framework is missing configured trust anchor jwks");
  }
  throw new Error(`OIDF trust chain did not validate against any configured trust anchor: ${lastError.message}`);
}

function findTrustedIssuerLeaves(
  framework: FrameworkDefinition,
  issuerUrl: string,
) {
  return framework.oidf?.trustedLeaves.filter((leaf) => (
    (leaf.usage === "issuer" || leaf.usage === "both")
    && leaf.expectedIssuerUrl === issuerUrl
  )) ?? [];
}

function isAllowlistedClientLeaf(
  oidf: NonNullable<FrameworkDefinition["oidf"]>,
  entityId: string,
) {
  return oidf.trustedLeaves.some((leaf) => (
    leaf.entityId === entityId
    && (leaf.usage === "client" || leaf.usage === "both")
  ));
}

function findStatementJwksForEntity(
  verifiedChain: VerifiedTrustChain,
  entityId: string,
) {
  if (verifiedChain.anchor.entityId === entityId) {
    return verifiedChain.anchor.payload.jwks?.keys ?? [];
  }
  return verifiedChain.subordinateStatements.find((statement) => statement.payload.sub === entityId)?.payload.jwks?.keys ?? [];
}

function formatError(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function buildDiscoverySource(
  kind: FetchedTrustChain["discoverySources"][number]["kind"],
  entityId: string,
  publishedUrl: string,
  config: Pick<ServerConfig, "publicBaseUrl" | "internalBaseUrl">,
) {
  const effectiveRequestUrl = rewriteSelfOriginFetchUrl(publishedUrl, config);
  return {
    kind,
    entity_id: entityId,
    published_url: publishedUrl,
    published_request: `GET ${publishedUrl}`,
    ...(effectiveRequestUrl !== publishedUrl ? { effective_request: `GET ${effectiveRequestUrl}` } : {}),
  };
}

async function fetchTrustChainPath(options: {
  currentEntityId: string;
  expectedAnchorEntityId: string;
  config: Pick<ServerConfig, "publicBaseUrl" | "internalBaseUrl">;
  fetchImpl: typeof fetch;
  maxDepth: number;
  maxAuthorityHints: number;
  depth: number;
  visited: Set<string>;
  prefetchedEntityConfigurationJwt?: string;
  prefetchedDiscoverySource?: FetchedTrustChain["discoverySources"][number];
}): Promise<FetchedTrustChain> {
  if (options.depth > options.maxDepth) {
    throw new Error(`OIDF issuer trust chain exceeds the configured depth of ${options.maxDepth}`);
  }
  if (options.visited.has(options.currentEntityId)) {
    throw new Error(`OIDF issuer trust discovery encountered a cycle at ${options.currentEntityId}`);
  }

  const entityConfigurationUrl = oidfEntityConfigurationUrl(options.currentEntityId);
  const entityConfigurationJwt = options.prefetchedEntityConfigurationJwt ?? await fetchOidfText(
    entityConfigurationUrl,
    `entity configuration for ${options.currentEntityId}`,
    options.config,
    options.fetchImpl,
  );
  const entityConfigurationSource = options.prefetchedDiscoverySource
    ?? buildDiscoverySource("entity-configuration", options.currentEntityId, entityConfigurationUrl, options.config);

  if (options.currentEntityId === options.expectedAnchorEntityId) {
    return {
      chain: [entityConfigurationJwt],
      discoverySources: [entityConfigurationSource],
    };
  }

  const decoded = decodeEntityStatementPayload(entityConfigurationJwt);
  const authorityHints = Array.isArray(decoded.authority_hints)
    ? decoded.authority_hints.filter((hint): hint is string => typeof hint === "string" && !!hint)
    : [];
  if (authorityHints.length === 0) {
    throw new Error(`OIDF issuer trust path from ${options.currentEntityId} has no authority_hints`);
  }

  const candidateHints = authorityHints.slice(0, options.maxAuthorityHints);
  let lastError: Error | null = null;
  for (const parentEntityId of candidateHints) {
    try {
      const parentEntityConfigurationUrl = oidfEntityConfigurationUrl(parentEntityId);
      const parentEntityConfigurationJwt = await fetchOidfText(
        parentEntityConfigurationUrl,
        `entity configuration for ${parentEntityId}`,
        options.config,
        options.fetchImpl,
      );
      const parentEntityConfigurationSource = buildDiscoverySource(
        "entity-configuration",
        parentEntityId,
        parentEntityConfigurationUrl,
        options.config,
      );
      const parentDecoded = decodeEntityStatementPayload(parentEntityConfigurationJwt);
      const fetchUrl = new URL(resolvePublishedFederationFetchEndpointUrl(parentEntityId, parentDecoded));
      fetchUrl.searchParams.set("sub", options.currentEntityId);
      const subordinateStatementUrl = fetchUrl.toString();
      const subordinateStatementJwt = await fetchOidfText(
        subordinateStatementUrl,
        `subordinate statement from ${parentEntityId} about ${options.currentEntityId}`,
        options.config,
        options.fetchImpl,
      );
      const subordinateStatementSource = buildDiscoverySource(
        "subordinate-statement",
        options.currentEntityId,
        subordinateStatementUrl,
        options.config,
      );

      if (parentEntityId === options.expectedAnchorEntityId) {
        return {
          chain: [entityConfigurationJwt, subordinateStatementJwt, parentEntityConfigurationJwt],
          discoverySources: [entityConfigurationSource, parentEntityConfigurationSource, subordinateStatementSource],
        };
      }

      const tail = await fetchTrustChainPath({
        currentEntityId: parentEntityId,
        expectedAnchorEntityId: options.expectedAnchorEntityId,
        config: options.config,
        fetchImpl: options.fetchImpl,
        maxDepth: options.maxDepth,
        maxAuthorityHints: options.maxAuthorityHints,
        depth: options.depth + 1,
        visited: new Set([...options.visited, options.currentEntityId]),
        prefetchedEntityConfigurationJwt: parentEntityConfigurationJwt,
        prefetchedDiscoverySource: parentEntityConfigurationSource,
      });
      return {
        chain: [entityConfigurationJwt, subordinateStatementJwt, ...tail.chain.slice(1)],
        discoverySources: [entityConfigurationSource, parentEntityConfigurationSource, subordinateStatementSource, ...tail.discoverySources.slice(1)],
      };
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
    }
  }

  if (authorityHints.length > options.maxAuthorityHints) {
    throw new Error(
      `OIDF issuer trust discovery inspected ${options.maxAuthorityHints} authority_hints for ${options.currentEntityId} without finding a valid path: ${lastError?.message ?? "no path"}`,
    );
  }
  throw lastError ?? new Error(`OIDF issuer trust discovery found no valid parent for ${options.currentEntityId}`);
}

function buildIssuerTrustCacheKey(
  framework: FrameworkDefinition,
  issuerUrl: string,
  trustedLeaf: NonNullable<FrameworkDefinition["oidf"]>["trustedLeaves"][number],
) {
  return `${framework.framework}|${trustedLeaf.entityId}|${issuerUrl}`;
}

function computeIssuerTrustCacheExpiry(
  verifiedChain: VerifiedTrustChain,
  verifiedTrustMark: Awaited<ReturnType<typeof verifyTrustMark>>,
  frameworkCacheTtlSeconds: number,
) {
  const frameworkExpiry = Date.now() + Math.max(0, frameworkCacheTtlSeconds) * 1000;
  const statementExpiry = Math.min(
    ...verifiedChain.statements.map((statement) => statement.payload.exp * 1000),
    verifiedTrustMark.payload.exp * 1000,
  );
  return Math.min(frameworkExpiry, statementExpiry);
}
