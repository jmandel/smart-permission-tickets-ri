import { randomUUID } from "node:crypto";

import {
  computeEcJwkThumbprintSync,
  derivePublicJwk,
  normalizePrivateJwk,
  normalizePublicJwk,
  signEs256Jwt,
} from "./es256-jwt.ts";
import type { ResolvedIssuerTrust } from "../store/model.ts";

export type TicketIssuerSeed = {
  slug: string;
  name: string;
  privateJwk: JsonWebKey;
};

export type TicketIssuer = {
  slug: string;
  name: string;
  privateJwk: JsonWebKey;
  publicJwk: JsonWebKey & { kid: string };
  kid: string;
};

export type TicketIssuerInfo = {
  slug: string;
  name: string;
  issuerBasePath: string;
  issuerBaseUrl: string;
  jwksPath: string;
  jwksUrl: string;
  signTicketPath: string;
  signTicketUrl: string;
};

export const DEFAULT_PERMISSION_TICKET_ISSUER_PRIVATE_JWK: JsonWebKey = {
  kty: "EC",
  crv: "P-256",
  x: "gzhR6jZPmWHq1mMF1Id-WnbtRU4MS_bRsF6h9LBNAlg",
  y: "RQu9bKGoSCFhmJpS93Ld5KeExG-ceSJkGM65OWBsJF0",
  d: "h0Qz0inDLBLQApo-iAEzQk3QeTD2k8WO1uVFPGok2ic",
};

export class TicketIssuerRegistry {
  private readonly issuersBySlug = new Map<string, TicketIssuer>();

  constructor(seeds: TicketIssuerSeed[]) {
    for (const seed of seeds) {
      const privateJwk = normalizePrivateJwk(seed.privateJwk);
      const publicJwk = normalizePublicJwk(derivePublicJwk(privateJwk));
      const kid = computeEcJwkThumbprintSync(publicJwk);
      this.issuersBySlug.set(seed.slug, {
        slug: seed.slug,
        name: seed.name,
        privateJwk,
        publicJwk: { ...publicJwk, kid },
        kid,
      });
    }
  }

  get(slug: string | undefined | null) {
    if (!slug) return null;
    return this.issuersBySlug.get(slug) ?? null;
  }

  list(origin: string) {
    return [...this.issuersBySlug.values()].map((issuer) => this.describe(origin, issuer.slug));
  }

  describe(origin: string, slug: string): TicketIssuerInfo {
    const issuer = this.require(slug);
    const issuerBasePath = issuerBasePathFor(slug);
    const jwksPath = issuerJwksPathFor(slug);
    const signTicketPath = issuerSignTicketPathFor(slug);
    return {
      slug: issuer.slug,
      name: issuer.name,
      issuerBasePath,
      issuerBaseUrl: `${origin}${issuerBasePath}`,
      jwksPath,
      jwksUrl: `${origin}${jwksPath}`,
      signTicketPath,
      signTicketUrl: `${origin}${signTicketPath}`,
    };
  }

  sign(origin: string, slug: string, payload: Record<string, any>) {
    const issuer = this.require(slug);
    const now = Math.floor(Date.now() / 1000);
    if (typeof payload.exp !== "number") {
      throw new Error("Permission Ticket exp is required and must be a NumericDate");
    }
    if (payload.exp <= now) {
      throw new Error("Permission Ticket exp must be in the future");
    }
    const normalizedPayload = {
      ...payload,
      iss: `${origin}${issuerBasePathFor(slug)}`,
      iat: typeof payload.iat === "number" ? payload.iat : now,
      exp: payload.exp,
      jti: typeof payload.jti === "string" && payload.jti ? payload.jti : randomUUID(),
    };
    return signEs256Jwt(normalizedPayload, issuer.privateJwk, { kid: issuer.kid });
  }

  resolveTrustedIssuer(issuerUrl: string, expectedOrigin?: string): ResolvedIssuerTrust | null {
    let parsed: URL;
    try {
      parsed = new URL(issuerUrl);
    } catch {
      throw new Error("Permission Ticket issuer is not a valid URL");
    }
    const slug = issuerSlugFromPath(parsed.pathname);
    if (!slug) return null;
    if (expectedOrigin && parsed.origin !== expectedOrigin) {
      throw new Error("Permission Ticket issuer origin mismatch");
    }
    const issuer = this.get(slug);
    if (!issuer) throw new Error("Unknown Permission Ticket issuer");
    return {
      source: "local",
      issuerUrl: parsed.toString(),
      displayName: issuer.name,
      publicJwks: [issuer.publicJwk],
      metadata: {
        slug: issuer.slug,
        kid: issuer.kid,
        jwks_url: `${parsed.origin}${issuerJwksPathFor(issuer.slug)}`,
      },
    };
  }

  resolveFromIssuerUrl(issuerUrl: string, expectedOrigin?: string) {
    const trustedIssuer = this.resolveTrustedIssuer(issuerUrl, expectedOrigin);
    if (!trustedIssuer) throw new Error("Unknown Permission Ticket issuer");
    const slug = issuerSlugFromPath(new URL(issuerUrl).pathname);
    if (!slug) throw new Error("Unknown Permission Ticket issuer");
    const issuer = this.get(slug);
    if (!issuer) throw new Error("Unknown Permission Ticket issuer");
    return issuer;
  }

  private require(slug: string) {
    const issuer = this.get(slug);
    if (!issuer) throw new Error(`Unknown issuer: ${slug}`);
    return issuer;
  }
}

export function issuerBasePathFor(slug: string) {
  return `/issuer/${slug}`;
}

export function issuerJwksPathFor(slug: string) {
  return `${issuerBasePathFor(slug)}/.well-known/jwks.json`;
}

export function issuerJwksUrlForIssuerUrl(issuerUrl: string) {
  const normalizedIssuerUrl = normalizeIssuerUrl(issuerUrl);
  return `${normalizedIssuerUrl}/.well-known/jwks.json`;
}

export function issuerSignTicketPathFor(slug: string) {
  return `${issuerBasePathFor(slug)}/sign-ticket`;
}

export function issuerSlugFromPath(pathname: string) {
  const match = pathname.match(/^\/issuer\/([^/]+)(?:\/|$)/);
  return match?.[1] ?? null;
}

export async function resolveDirectJwksIssuerTrust(
  issuerUrl: string,
  config: { publicBaseUrl: string; internalBaseUrl?: string },
  fetchImpl: typeof fetch = fetch,
): Promise<ResolvedIssuerTrust> {
  const normalizedIssuerUrl = normalizeIssuerUrl(issuerUrl);
  const jwksUrl = issuerJwksUrlForIssuerUrl(normalizedIssuerUrl);
  const effectiveJwksUrl = rewriteSelfOriginIssuerFetchUrl(jwksUrl, config.publicBaseUrl, config.internalBaseUrl);

  let response: Response;
  try {
    response = await fetchImpl(effectiveJwksUrl, { redirect: "follow" });
  } catch (error) {
    throw new Error(`Unable to retrieve issuer JWKS for ${describeFetchRoute(jwksUrl, effectiveJwksUrl)}: ${formatError(error)}`);
  }
  if (!response.ok) {
    throw new Error(`Unable to retrieve issuer JWKS (${response.status}) for ${describeFetchRoute(jwksUrl, effectiveJwksUrl)}`);
  }

  let body: any;
  try {
    body = await response.json();
  } catch {
    throw new Error(`Unable to parse issuer JWKS for ${jwksUrl}`);
  }
  if (!body || !Array.isArray(body.keys) || body.keys.length === 0) {
    throw new Error(`Issuer JWKS did not include any keys for ${jwksUrl}`);
  }

  return {
    source: "direct",
    issuerUrl: normalizedIssuerUrl,
    displayName: normalizedIssuerUrl,
    publicJwks: body.keys.map((key: JsonWebKey) => normalizePublicJwkWithMetadata(key)),
    metadata: {
      resolution: "direct-jwks",
      jwks_url: jwksUrl,
      ...(effectiveJwksUrl !== jwksUrl ? { effective_jwks_url: effectiveJwksUrl } : {}),
    },
  };
}

function normalizeIssuerUrl(raw: string) {
  const parsed = new URL(raw);
  parsed.hash = "";
  parsed.search = "";
  if (parsed.pathname.length > 1 && parsed.pathname.endsWith("/")) {
    parsed.pathname = parsed.pathname.replace(/\/+$/, "");
  }
  return parsed.toString();
}

function normalizePublicJwkWithMetadata(jwk: JsonWebKey) {
  const normalized = normalizePublicJwk(jwk);
  return {
    ...(typeof (jwk as JsonWebKey & { kid?: string }).kid === "string" ? { kid: (jwk as JsonWebKey & { kid?: string }).kid } : {}),
    ...normalized,
  };
}

function rewriteSelfOriginIssuerFetchUrl(targetUrl: string, publicBaseUrl: string, internalBaseUrl: string | undefined) {
  if (!internalBaseUrl) return targetUrl;
  const target = new URL(targetUrl);
  const publicBase = new URL(publicBaseUrl);
  if (target.origin !== publicBase.origin) return targetUrl;
  const internalBase = new URL(internalBaseUrl);
  return `${internalBase.origin}${target.pathname}${target.search}`;
}

function describeFetchRoute(publishedUrl: string, effectiveUrl: string) {
  return publishedUrl === effectiveUrl ? publishedUrl : `${publishedUrl} via ${effectiveUrl}`;
}

function formatError(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
