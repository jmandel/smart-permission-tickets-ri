import type { FrameworkDefinition, ModeName, RegisteredClient } from "./store/model.ts";
import { buildDefaultFrameworks } from "./auth/demo-frameworks.ts";
import {
  DEFAULT_PERMISSION_TICKET_ISSUER_PRIVATE_JWK,
  type TicketIssuerSeed,
} from "./auth/issuers.ts";
import { loadDemoCryptoBundle, type DemoCryptoBundle } from "./demo-crypto-bundle.ts";

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
  defaultRegisteredClients: RegisteredClient[];
  defaultPermissionTicketIssuerSlug: string;
  defaultPermissionTicketIssuerName: string;
  permissionTicketIssuers: TicketIssuerSeed[];
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
  const demoCryptoBundle = loadDemoCryptoBundle(Bun.env.DEMO_CRYPTO_BUNDLE_PATH);
  const configuredPrivateJwk = demoCryptoBundle?.ticketIssuers[defaultPermissionTicketIssuerSlug]?.privateJwk
    ?? DEFAULT_PERMISSION_TICKET_ISSUER_PRIVATE_JWK;
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
    frameworks: buildDefaultFrameworks(publicBaseUrl, defaultPermissionTicketIssuerSlug, demoCryptoBundle),
    defaultRegisteredClients: [],
    defaultPermissionTicketIssuerSlug,
    defaultPermissionTicketIssuerName,
    permissionTicketIssuers: [
      {
        slug: defaultPermissionTicketIssuerSlug,
        name: defaultPermissionTicketIssuerName,
        privateJwk: configuredPrivateJwk,
      },
    ],
    demoCryptoBundle,
  };
}

function normalizeOriginEnv(raw: string, name: string) {
  const parsed = new URL(raw);
  if (parsed.pathname !== "/" || parsed.search || parsed.hash) {
    throw new Error(`${name} must be an origin with no path, query, or fragment`);
  }
  return parsed.origin;
}
