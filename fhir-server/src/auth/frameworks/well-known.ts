import { computeJwkThumbprint, normalizePublicJwk, verifyPrivateKeyJwt } from "../../../shared/private-key-jwt.ts";
import { toAuthenticatedClientIdentity } from "../client-identity.ts";
import type {
  AuthenticatedClientIdentity,
  FrameworkDefinition,
  FrameworkClientBinding,
  RegisteredClient,
  ResolvedFrameworkEntity,
  ResolvedIssuerTrust,
} from "../../store/model.ts";
import type { ServerConfig } from "../../config.ts";
import type { FrameworkResolver, SupportedTrustFramework } from "./types.ts";

const DEFAULT_CACHE_TTL_SECONDS = 3600;
const WELL_KNOWN_PREFIX = "well-known:";

type CachedWellKnownEntity = {
  entity: ResolvedFrameworkEntity;
  expiresAt: number;
};

export class WellKnownFrameworkResolver implements FrameworkResolver {
  readonly frameworkType = "well-known" as const;
  private readonly cache = new Map<string, CachedWellKnownEntity>();

  constructor(
    private readonly frameworks: FrameworkDefinition[],
    private readonly config: Pick<ServerConfig, "publicBaseUrl" | "internalBaseUrl">,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  getSupportedTrustFrameworks(): SupportedTrustFramework[] {
    return this.frameworks
      .filter((framework) => framework.frameworkType === "well-known" && (framework.supportsClientAuth || framework.supportsIssuerTrust))
      .map((framework) => ({
        framework: framework.framework,
        framework_type: framework.frameworkType,
      }));
  }

  matchesClientId(clientId: string) {
    return clientId.startsWith(WELL_KNOWN_PREFIX);
  }

  async authenticateClientAssertion(clientId: string, assertionJwt: string, tokenEndpointUrl: string): Promise<AuthenticatedClientIdentity> {
    const entityUri = normalizeWellKnownEntityUri(clientId.slice(WELL_KNOWN_PREFIX.length));
    const cached = this.cache.get(entityUri);
    const nowMs = Date.now();
    if (cached && cached.expiresAt > nowMs) {
      try {
        return await this.verifyAgainstResolvedEntity(cached.entity, assertionJwt, tokenEndpointUrl);
      } catch {
        this.cache.delete(entityUri);
      }
    }

    const resolved = await this.resolveEntity(entityUri, "client");
    if (!resolved) {
      throw new Error(`well-known client ${entityUri} could not be resolved`);
    }
    const { entity, expiresAt } = resolved;
    const verified = await this.verifyAgainstResolvedEntity(entity, assertionJwt, tokenEndpointUrl);
    this.cache.set(entityUri, { entity, expiresAt });
    return verified;
  }

  async resolveIssuerTrust(issuerUrl: string): Promise<ResolvedIssuerTrust | null> {
    const entityUri = normalizeWellKnownEntityUri(issuerUrl);
    const cached = this.cache.get(entityUri);
    const nowMs = Date.now();
    if (cached && cached.expiresAt > nowMs && cached.entity.framework) {
      return toIssuerTrust(cached.entity);
    }

    const resolved = await this.resolveEntity(entityUri, "issuer");
    if (!resolved) return null;
    this.cache.set(entityUri, { entity: resolved.entity, expiresAt: resolved.expiresAt });
    return toIssuerTrust(resolved.entity);
  }

  private async verifyAgainstResolvedEntity(entity: ResolvedFrameworkEntity, assertionJwt: string, tokenEndpointUrl: string) {
    const client = registeredClientForEntity(entity);
    const keys = entity.publicJwks ?? [];
    if (!keys.length) throw new Error("No client keys available");

    let lastError: Error | null = null;
    for (const key of keys) {
      try {
        const normalizedKey = normalizePublicJwk(key);
        const { payload } = await verifyPrivateKeyJwt<any>(assertionJwt, normalizedKey);
        const now = Math.floor(Date.now() / 1000);
        if (payload.iss !== client.clientId || payload.sub !== client.clientId) throw new Error("Invalid client assertion");
        if (payload.aud !== tokenEndpointUrl) throw new Error("Client assertion audience mismatch");
        if (typeof payload.exp !== "number" || payload.exp <= now) throw new Error("Client assertion expired");
        if (typeof payload.iat === "number" && payload.iat > now + 60) throw new Error("Client assertion issued in the future");
        return toAuthenticatedClientIdentity(
          {
            ...client,
            availablePublicJwks: keys,
          },
          {
            resolvedEntity: entity,
            availablePublicJwks: keys,
            publicJwk: normalizedKey,
            jwkThumbprint: await computeJwkThumbprint(normalizedKey),
          },
        );
      } catch (error) {
        lastError = error instanceof Error ? error : new Error("Client assertion verification failed");
      }
    }

    throw lastError ?? new Error("Invalid client assertion signature");
  }

  private async resolveEntity(entityUri: string, capability: "client" | "issuer") {
    const frameworkBinding = resolveFrameworkBinding(this.frameworks, entityUri, capability);
    if (capability === "issuer" && !frameworkBinding) return null;
    const jwksUrl = buildEntityRelativeUrl(entityUri, frameworkBinding?.jwksRelativePath ?? "/.well-known/jwks.json");
    const response = await this.fetchImpl(rewriteSelfFetchUrl(jwksUrl, this.config.publicBaseUrl, this.config.internalBaseUrl), { redirect: "follow" });
    if (!response.ok) {
      throw new Error(`Unable to retrieve well-known JWKS (${response.status})`);
    }
    let body: any;
    try {
      body = await response.json();
    } catch {
      throw new Error("Unable to parse well-known JWKS");
    }
    if (!body || !Array.isArray(body.keys) || body.keys.length === 0) {
      throw new Error("Well-known JWKS did not include any keys");
    }
    const publicKeys = body.keys.map((key: JsonWebKey) => normalizePublicJwkWithMetadata(key));
    const expiresAt = Date.now() + cacheTtlMs(response.headers, frameworkBinding?.cacheTtlSeconds ?? DEFAULT_CACHE_TTL_SECONDS);
    const entity: ResolvedFrameworkEntity = {
      framework: frameworkBinding
        ? {
          uri: frameworkBinding.binding.framework,
          type: frameworkBinding.binding.framework_type,
        }
        : undefined,
      entityUri,
      displayName: entityUri,
      publicJwks: publicKeys,
    };
    return { entity, expiresAt };
  }
}

function registeredClientForEntity(entity: ResolvedFrameworkEntity): RegisteredClient {
  return {
    clientId: `${WELL_KNOWN_PREFIX}${entity.entityUri}`,
    clientName: entity.displayName,
    tokenEndpointAuthMethod: "private_key_jwt",
    publicJwk: entity.publicJwks?.[0],
    availablePublicJwks: entity.publicJwks,
    jwkThumbprint: undefined,
    dynamic: false,
    authMode: "well-known",
    frameworkBinding: entity.framework
      ? {
        method: "framework_client",
        framework: entity.framework.uri,
        framework_type: entity.framework.type,
        entity_uri: entity.entityUri,
      }
      : undefined,
  };
}

function resolveFrameworkBinding(
  frameworks: FrameworkDefinition[],
  entityUri: string,
  capability: "client" | "issuer",
): { binding: FrameworkClientBinding; jwksRelativePath: string; cacheTtlSeconds: number } | null {
  for (const framework of frameworks) {
    if (framework.frameworkType !== "well-known") continue;
    if (capability === "client" && !framework.supportsClientAuth) continue;
    if (capability === "issuer" && !framework.supportsIssuerTrust) continue;
    const allowlist = framework.wellKnown?.allowlist ?? [];
    if (!allowlist.includes(entityUri)) continue;
    return {
      binding: {
        method: "framework_client",
        framework: framework.framework,
        framework_type: framework.frameworkType,
        entity_uri: entityUri,
      },
      jwksRelativePath: framework.wellKnown?.jwksRelativePath ?? "/.well-known/jwks.json",
      cacheTtlSeconds: framework.cacheTtlSeconds,
    };
  }
  return null;
}

function toIssuerTrust(entity: ResolvedFrameworkEntity): ResolvedIssuerTrust {
  return {
    source: "framework",
    issuerUrl: entity.entityUri,
    displayName: entity.displayName,
    framework: entity.framework,
    publicJwks: entity.publicJwks ?? [],
    metadata: {
      resolution: "well-known-jwks",
      jwks_url: buildEntityRelativeUrl(entity.entityUri, "/.well-known/jwks.json"),
      ...(entity.metadata ?? {}),
    },
  };
}

function normalizePublicJwkWithMetadata(jwk: JsonWebKey) {
  const normalized = normalizePublicJwk(jwk);
  return {
    ...(typeof (jwk as JsonWebKey & { kid?: string }).kid === "string" ? { kid: (jwk as JsonWebKey & { kid?: string }).kid } : {}),
    ...normalized,
  };
}

function buildEntityRelativeUrl(entityUri: string, relativePath: string) {
  const normalizedBase = entityUri.endsWith("/") ? entityUri : `${entityUri}/`;
  const trimmedPath = relativePath.replace(/^\/+/, "");
  return new URL(trimmedPath, normalizedBase).toString();
}

function cacheTtlMs(headers: Headers, fallbackSeconds: number) {
  const cacheControl = headers.get("cache-control") ?? "";
  const match = cacheControl.match(/max-age=(\d+)/i);
  if (match) {
    const seconds = Number(match[1]);
    if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  }
  return fallbackSeconds * 1000;
}

function rewriteSelfFetchUrl(targetUrl: string, publicBaseUrl: string, internalBaseUrl: string | undefined) {
  if (!internalBaseUrl) return targetUrl;
  const target = new URL(targetUrl);
  const publicBase = new URL(publicBaseUrl);
  if (target.origin !== publicBase.origin) return targetUrl;
  const internalBase = new URL(internalBaseUrl);
  return `${internalBase.origin}${target.pathname}${target.search}`;
}

function isSecureLocalOrigin(url: URL) {
  return url.protocol === "http:" && (url.hostname === "localhost" || url.hostname === "127.0.0.1");
}

export function normalizeWellKnownEntityUri(raw: string) {
  const parsed = new URL(raw);
  if (parsed.protocol !== "https:" && !isSecureLocalOrigin(parsed)) {
    throw new Error("well-known entities must use HTTPS or a secure local origin");
  }
  parsed.hash = "";
  parsed.search = "";
  if (parsed.pathname.length > 1 && parsed.pathname.endsWith("/")) {
    parsed.pathname = parsed.pathname.replace(/\/+$/, "");
  }
  return parsed.toString();
}
