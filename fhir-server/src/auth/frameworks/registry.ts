import { ClientRegistry } from "../clients.ts";
import type { AuthenticatedClientIdentity, FrameworkDefinition, ResolvedIssuerTrust } from "../../store/model.ts";
import { UdapFrameworkResolver } from "./udap.ts";
import type { FrameworkClientRegistration, FrameworkResolver } from "./types.ts";
import { WellKnownFrameworkResolver } from "./well-known.ts";

export class FrameworkRegistry {
  private readonly frameworks: FrameworkDefinition[];
  private readonly resolvers: FrameworkResolver[];

  constructor(
    frameworks: FrameworkDefinition[],
    clients: ClientRegistry,
    fetchImpl: typeof fetch = fetch,
  ) {
    this.frameworks = frameworks;
    this.resolvers = [
      new WellKnownFrameworkResolver(frameworks, fetchImpl),
      new UdapFrameworkResolver(frameworks, clients),
    ];
  }

  getSupportedTrustFrameworks() {
    return this.resolvers.flatMap((resolver) => resolver.getSupportedTrustFrameworks());
  }

  async authenticateClientAssertion(clientId: string, assertionJwt: string, tokenEndpointUrl: string): Promise<AuthenticatedClientIdentity | null> {
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
    for (const resolver of this.resolvers) {
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
