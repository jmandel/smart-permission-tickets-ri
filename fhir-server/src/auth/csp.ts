// Demo Credential Service Provider (CSP): the external IAL2 identity service
// the ticket issuer relies on. The issuer is a relying party here (topology
// T1): when Elena authorizes ticket creation, the CSP signs her in and mints
// an id_token whose iss is the CSP and whose aud names the issuer. The CSP is
// deliberately NOT a ticket issuer — it signs id_tokens, never Permission
// Tickets, and it lives under /csp/* paths, away from /issuer/* namespaces.

import {
  computeEcJwkThumbprintSync,
  derivePublicJwk,
  normalizePrivateJwk,
  normalizePublicJwk,
  signEs256Jwt,
  verifyEs256Jwt,
} from "./es256-jwt.ts";

export type CredentialServiceProviderSeed = {
  slug: string;
  name: string;
  privateJwk: JsonWebKey;
};

export type CredentialServiceProvider = {
  slug: string;
  name: string;
  privateJwk: JsonWebKey;
  publicJwk: JsonWebKey & { kid: string };
  kid: string;
};

export type CredentialServiceProviderInfo = {
  slug: string;
  name: string;
  cspBasePath: string;
  cspBaseUrl: string;
  jwksPath: string;
  jwksUrl: string;
};

export const DEFAULT_DEMO_CSP_SLUG = "demo-csp";
export const DEFAULT_DEMO_CSP_NAME = "Reference Demo CSP (IAL2 identity service)";

export const DEFAULT_DEMO_CSP_PRIVATE_JWK: JsonWebKey = {
  kty: "EC",
  crv: "P-256",
  x: "Xs4RJR359075cHTIjgIHFzJpgT7Fie-jehsLYWLWRQI",
  y: "oG6MyLX5TQuhzszKFXmRSiv4W7y38RxrnFFaZkDbmZk",
  d: "cXWYJzxQ4x8xT56Y90-3OUsWcYs489lG68gsFND-3bA",
};

export class CredentialServiceProviderRegistry {
  private readonly cspsBySlug = new Map<string, CredentialServiceProvider>();

  constructor(seeds: CredentialServiceProviderSeed[]) {
    for (const seed of seeds) {
      const privateJwk = normalizePrivateJwk(seed.privateJwk);
      const publicJwk = normalizePublicJwk(derivePublicJwk(privateJwk));
      const kid = computeEcJwkThumbprintSync(publicJwk);
      this.cspsBySlug.set(seed.slug, {
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
    return this.cspsBySlug.get(slug) ?? null;
  }

  list(origin: string) {
    return [...this.cspsBySlug.values()].map((csp) => this.describe(origin, csp.slug));
  }

  describe(origin: string, slug: string): CredentialServiceProviderInfo {
    const csp = this.require(slug);
    const cspBasePath = cspBasePathFor(slug);
    const jwksPath = cspJwksPathFor(slug);
    return {
      slug: csp.slug,
      name: csp.name,
      cspBasePath,
      cspBaseUrl: `${origin}${cspBasePath}`,
      jwksPath,
      jwksUrl: `${origin}${jwksPath}`,
    };
  }

  // The CSP side of an IAL2 sign-in: mints the id_token a relying party
  // receives. iss is always the CSP's own URL; the relying party (aud) and
  // the subject's verified attributes come from the sign-in event.
  signIdToken(
    origin: string,
    slug: string,
    input: {
      audience: string;
      subject: string;
      claims?: Record<string, unknown>;
      ttlSeconds?: number;
    },
  ) {
    const csp = this.require(slug);
    const now = Math.floor(Date.now() / 1000);
    const payload = {
      ...input.claims,
      iss: `${origin}${cspBasePathFor(slug)}`,
      aud: input.audience,
      sub: input.subject,
      iat: now,
      exp: now + (input.ttlSeconds ?? 3600),
      auth_time: now,
      identity_assurance_level: 2,
    };
    return signEs256Jwt(payload, csp.privateJwk, { kid: csp.kid });
  }

  // Relying-party-side signature check. In production the relying party
  // fetches the CSP JWKS over the wire; in-process the registry's public key
  // is byte-identical to what /csp/<slug>/.well-known/jwks.json publishes.
  verifyIdTokenSignature<T>(slug: string, jwt: string) {
    const csp = this.require(slug);
    return verifyEs256Jwt<T>(jwt, csp.publicJwk);
  }

  private require(slug: string) {
    const csp = this.get(slug);
    if (!csp) throw new Error(`Unknown CSP: ${slug}`);
    return csp;
  }
}

export function cspBasePathFor(slug: string) {
  return `/csp/${slug}`;
}

export function cspJwksPathFor(slug: string) {
  return `${cspBasePathFor(slug)}/.well-known/jwks.json`;
}

export function cspSlugFromPath(pathname: string) {
  const match = pathname.match(/^\/csp\/([^/]+)(?:\/|$)/);
  return match?.[1] ?? null;
}
