import type { FrameworkDefinition, ModeName, RegisteredClient } from "./store/model.ts";
import { buildDefaultFrameworks } from "./auth/demo-frameworks.ts";
import {
  DEFAULT_PERMISSION_TICKET_ISSUER_PRIVATE_JWK,
  type TicketIssuerSeed,
} from "./auth/issuers.ts";

export type ServerConfig = {
  port: number;
  publicBaseUrl: string;
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
};

export function loadConfig(): ServerConfig {
  const port = Number(Bun.env.PORT ?? 8091);
  const publicBaseUrl = normalizeOriginEnv(Bun.env.PUBLIC_BASE_URL ?? Bun.env.ISSUER ?? `http://localhost:${port}`, "PUBLIC_BASE_URL");
  const issuer = normalizeOriginEnv(Bun.env.ISSUER ?? publicBaseUrl, "ISSUER");
  const defaultNetworkSlug = Bun.env.DEFAULT_NETWORK_SLUG ?? "reference";
  const defaultNetworkName = Bun.env.DEFAULT_NETWORK_NAME ?? "Reference Network";
  const defaultPermissionTicketIssuerSlug = Bun.env.DEFAULT_PERMISSION_TICKET_ISSUER_SLUG ?? "reference-demo";
  const defaultPermissionTicketIssuerName = Bun.env.DEFAULT_PERMISSION_TICKET_ISSUER_NAME ?? "Reference Demo Issuer";
  const configuredPrivateJwk = parsePrivateJwk(
    Bun.env.DEFAULT_PERMISSION_TICKET_ISSUER_PRIVATE_JWK_JSON,
  ) ?? DEFAULT_PERMISSION_TICKET_ISSUER_PRIVATE_JWK;
  return {
    port,
    publicBaseUrl,
    issuer,
    accessTokenSecret: Bun.env.ACCESS_TOKEN_SECRET ?? "reference-implementation-access-secret",
    clientRegistrationSecret: Bun.env.CLIENT_REGISTRATION_SECRET ?? Bun.env.ACCESS_TOKEN_SECRET ?? "reference-implementation-client-registration-secret",
    accessTokenTtlSeconds: Number(Bun.env.ACCESS_TOKEN_TTL_SECONDS ?? 3600),
    strictDefaultMode: "strict",
    defaultNetworkSlug,
    defaultNetworkName,
    frameworks: buildDefaultFrameworks(publicBaseUrl, defaultPermissionTicketIssuerSlug),
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
  };
}

function parsePrivateJwk(raw: string | undefined) {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed as JsonWebKey : null;
  } catch {
    return null;
  }
}

function normalizeOriginEnv(raw: string, name: string) {
  const parsed = new URL(raw);
  if (parsed.pathname !== "/" || parsed.search || parsed.hash) {
    throw new Error(`${name} must be an origin with no path, query, or fragment`);
  }
  return parsed.origin;
}
