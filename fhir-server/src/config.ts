import type { FrameworkDefinition, IssuerTrustConfig, ModeName, RegisteredClient } from "./store/model.ts";
import {
  cspBasePathFor,
  DEFAULT_DEMO_CSP_NAME,
  DEFAULT_DEMO_CSP_PRIVATE_JWK,
  DEFAULT_DEMO_CSP_SLUG,
  type CredentialServiceProviderSeed,
} from "./auth/csp.ts";
import { buildDefaultFrameworks } from "./auth/demo-frameworks.ts";
import {
  DEFAULT_PERMISSION_TICKET_ISSUER_PRIVATE_JWK,
  issuerBasePathFor,
  type TicketIssuerSeed,
} from "./auth/issuers.ts";
import { resolveDemoCryptoBundlePath, type DemoCryptoBundle } from "./demo-crypto-bundle.ts";

export type ServerConfig = {
  port: number;
  publicBaseUrl: string;
  internalBaseUrl?: string;
  issuer: string;
  accessTokenSecret: string;
  clientRegistrationSecret: string;
  accessTokenTtlSeconds: number;
  strictDefaultMode: ModeName;
  defaultNetworkSlug: string;
  defaultNetworkName: string;
  frameworks: FrameworkDefinition[];
  issuerTrust: IssuerTrustConfig;
  defaultRegisteredClients: RegisteredClient[];
  defaultPermissionTicketIssuerSlug: string;
  defaultPermissionTicketIssuerName: string;
  permissionTicketIssuers: TicketIssuerSeed[];
  // The external IAL2 CSP the demo ticket issuer relies on for sign-in at
  // authorization time (topology T1). Not a ticket issuer.
  defaultCspSlug: string;
  credentialServiceProviders: CredentialServiceProviderSeed[];
  // Evidence-issuer trust, configured separately from ticket-issuer trust:
  // subject_identity_evidence is accepted only from these issuer URLs.
  trustedEvidenceIssuers: string[];
  demoCryptoBundlePath: string;
  demoCryptoBundle?: DemoCryptoBundle;
};

export function loadConfig(): ServerConfig {
  const port = Number(Bun.env.PORT ?? 8091);
  const publicBaseUrl = normalizeOriginEnv(Bun.env.PUBLIC_BASE_URL ?? Bun.env.ISSUER ?? `http://localhost:${port}`, "PUBLIC_BASE_URL");
  const internalBaseUrl = Bun.env.INTERNAL_BASE_URL
    ? normalizeOriginEnv(Bun.env.INTERNAL_BASE_URL, "INTERNAL_BASE_URL")
    : undefined;
  const issuer = normalizeOriginEnv(Bun.env.ISSUER ?? publicBaseUrl, "ISSUER");
  const defaultNetworkSlug = Bun.env.DEFAULT_NETWORK_SLUG ?? "reference";
  const defaultNetworkName = Bun.env.DEFAULT_NETWORK_NAME ?? "Provider Network";
  const defaultPermissionTicketIssuerSlug = Bun.env.DEFAULT_PERMISSION_TICKET_ISSUER_SLUG ?? "reference-demo";
  const defaultPermissionTicketIssuerName = Bun.env.DEFAULT_PERMISSION_TICKET_ISSUER_NAME ?? "Reference Demo Issuer";
  const demoCryptoBundlePath = resolveDemoCryptoBundlePath(Bun.env.DEMO_CRYPTO_BUNDLE_PATH);
  return {
    port,
    publicBaseUrl,
    internalBaseUrl,
    issuer,
    accessTokenSecret: Bun.env.ACCESS_TOKEN_SECRET ?? "reference-implementation-access-secret",
    clientRegistrationSecret: Bun.env.CLIENT_REGISTRATION_SECRET ?? Bun.env.ACCESS_TOKEN_SECRET ?? "reference-implementation-client-registration-secret",
    accessTokenTtlSeconds: Number(Bun.env.ACCESS_TOKEN_TTL_SECONDS ?? 3600),
    strictDefaultMode: "strict",
    defaultNetworkSlug,
    defaultNetworkName,
    frameworks: buildDefaultFrameworks(publicBaseUrl, defaultPermissionTicketIssuerSlug),
    issuerTrust: buildDefaultIssuerTrustConfig(publicBaseUrl, [
      {
        slug: defaultPermissionTicketIssuerSlug,
      },
    ]),
    defaultRegisteredClients: [],
    defaultPermissionTicketIssuerSlug,
    defaultPermissionTicketIssuerName,
    permissionTicketIssuers: [
      {
        slug: defaultPermissionTicketIssuerSlug,
        name: defaultPermissionTicketIssuerName,
        privateJwk: DEFAULT_PERMISSION_TICKET_ISSUER_PRIVATE_JWK,
      },
    ],
    defaultCspSlug: DEFAULT_DEMO_CSP_SLUG,
    credentialServiceProviders: [
      {
        slug: DEFAULT_DEMO_CSP_SLUG,
        name: DEFAULT_DEMO_CSP_NAME,
        privateJwk: DEFAULT_DEMO_CSP_PRIVATE_JWK,
      },
    ],
    trustedEvidenceIssuers: buildDefaultTrustedEvidenceIssuers(publicBaseUrl, [{ slug: DEFAULT_DEMO_CSP_SLUG }]),
    demoCryptoBundlePath,
    demoCryptoBundle: undefined,
  };
}

export function buildDefaultTrustedEvidenceIssuers(publicBaseUrl: string, csps: Pick<CredentialServiceProviderSeed, "slug">[]): string[] {
  return csps.map((csp) => `${publicBaseUrl}${cspBasePathFor(csp.slug)}`);
}

export function buildDefaultIssuerTrustConfig(publicBaseUrl: string, issuers: Pick<TicketIssuerSeed, "slug">[]): IssuerTrustConfig {
  return {
    policies: [
      {
        type: "direct_jwks",
        trustedIssuers: issuers.map((issuer) => `${publicBaseUrl}${issuerBasePathFor(issuer.slug)}`),
      },
    ],
  };
}

function normalizeOriginEnv(raw: string, name: string) {
  const parsed = new URL(raw);
  if (parsed.pathname !== "/" || parsed.search || parsed.hash) {
    throw new Error(`${name} must be an origin with no path, query, or fragment`);
  }
  return parsed.origin;
}
