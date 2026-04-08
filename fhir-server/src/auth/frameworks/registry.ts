import { ClientRegistry } from "../clients.ts";
import type { AuthenticatedClientIdentity, FrameworkDefinition, ResolvedIssuerTrust } from "../../store/model.ts";
import { OidfFrameworkResolver } from "./oidf/resolver.ts";
import { UdapFrameworkResolver } from "./udap.ts";
import type { FrameworkClientRegistration, FrameworkResolver } from "./types.ts";
import { WellKnownFrameworkResolver } from "./well-known.ts";
import type { ServerConfig } from "../../config.ts";

export class FrameworkRegistry {
  private readonly frameworks: FrameworkDefinition[];
  private readonly resolvers: FrameworkResolver[];

  constructor(
    frameworks: FrameworkDefinition[],
    clients: ClientRegistry,
    config: Pick<ServerConfig, "publicBaseUrl" | "internalBaseUrl">,
    fetchImpl: typeof fetch = fetch,
    resolverOverrides?: FrameworkResolver[],
  ) {
    this.frameworks = frameworks;
    this.resolvers = resolverOverrides ?? [
      new WellKnownFrameworkResolver(frameworks, config, fetchImpl),
      new UdapFrameworkResolver(frameworks, clients, config, fetchImpl),
      new OidfFrameworkResolver(frameworks, config, fetchImpl),
    ];
  }

  getSupportedTrustFrameworks() {
    return this.resolvers.flatMap((resolver) => resolver.getSupportedTrustFrameworks());
  }

  async authenticateClientAssertion(clientId: string, assertionJwt: string, tokenEndpointUrl: string): Promise<AuthenticatedClientIdentity | null> {
    const joseHeader = decodeJoseProtectedHeader(assertionJwt);
    for (const resolver of this.resolvers) {
      if (!resolver.matchesAssertion?.(clientId, joseHeader)) continue;
      return resolver.authenticateClientAssertion(clientId, assertionJwt, tokenEndpointUrl);
    }
    for (const resolver of this.resolvers) {
      if (!resolver.matchesClientId(clientId)) continue;
      return resolver.authenticateClientAssertion(clientId, assertionJwt, tokenEndpointUrl);
    }
    return null;
  }

  async registerClient(body: Record<string, any>, registrationEndpointUrl: string, authSurfaceUrl: string): Promise<FrameworkClientRegistration | null> {
    for (const resolver of this.resolvers) {
      if (!resolver.registerClient) continue;
      const registration = await resolver.registerClient(body, registrationEndpointUrl, authSurfaceUrl);
      if (registration) return registration;
    }
    return null;
  }

  async resolveIssuerTrust(issuerUrl: string): Promise<ResolvedIssuerTrust | null> {
    const issuerResolvers = [
      ...this.resolvers.filter((resolver) => resolver.frameworkType === "oidf"),
      ...this.resolvers.filter((resolver) => resolver.frameworkType !== "oidf"),
    ];
    for (const resolver of issuerResolvers) {
      if (!resolver.resolveIssuerTrust) continue;
      const issuerTrust = await resolver.resolveIssuerTrust(issuerUrl);
      if (issuerTrust) return issuerTrust;
    }
    return null;
  }

  async resolveIssuerTrustByType(frameworkType: FrameworkDefinition["frameworkType"], issuerUrl: string): Promise<ResolvedIssuerTrust | null> {
    for (const resolver of this.resolvers) {
      if (resolver.frameworkType !== frameworkType) continue;
      if (!resolver.resolveIssuerTrust) continue;
      const issuerTrust = await resolver.resolveIssuerTrust(issuerUrl);
      if (issuerTrust) return issuerTrust;
    }
    return null;
  }

  hasLocalAudienceMembership(frameworkUri: string) {
    return this.frameworks.some(
      (framework) => framework.framework === frameworkUri && typeof framework.localAudienceMembership?.entityUri === "string" && !!framework.localAudienceMembership.entityUri,
    );
  }
}

export function decodeJoseProtectedHeader(jwt: string): Record<string, unknown> {
  const [encodedHeader = ""] = jwt.split(".", 1);
  if (!encodedHeader) return {};
  try {
    const base64 = encodedHeader.replace(/-/g, "+").replace(/_/g, "/");
    const padded = base64 + "=".repeat((4 - (base64.length % 4)) % 4);
    const json = Buffer.from(padded, "base64").toString("utf8");
    const parsed = JSON.parse(json);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}
