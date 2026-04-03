import { randomUUID } from "node:crypto";

import {
  computeEcJwkThumbprintSync,
  derivePublicJwk,
  normalizePrivateJwk,
  normalizePublicJwk,
  signEs256Jwt,
} from "./es256-jwt.ts";

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
    const normalizedPayload = {
      ...payload,
      iss: `${origin}${issuerBasePathFor(slug)}`,
      iat: typeof payload.iat === "number" ? payload.iat : now,
      exp: typeof payload.exp === "number" ? payload.exp : now + 3600,
      jti: typeof payload.jti === "string" && payload.jti ? payload.jti : randomUUID(),
    };
    return signEs256Jwt(normalizedPayload, issuer.privateJwk, { kid: issuer.kid });
  }

  resolveFromIssuerUrl(issuerUrl: string, expectedOrigin?: string) {
    let parsed: URL;
    try {
      parsed = new URL(issuerUrl);
    } catch {
      throw new Error("Permission Ticket issuer is not a valid URL");
    }
    if (expectedOrigin && parsed.origin !== expectedOrigin) {
      throw new Error("Permission Ticket issuer origin mismatch");
    }
    const slug = issuerSlugFromPath(parsed.pathname);
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

export function issuerSignTicketPathFor(slug: string) {
  return `${issuerBasePathFor(slug)}/sign-ticket`;
}

export function issuerSlugFromPath(pathname: string) {
  const match = pathname.match(/^\/issuer\/([^/]+)(?:\/|$)/);
  return match?.[1] ?? null;
}
