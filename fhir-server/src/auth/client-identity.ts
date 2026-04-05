import type { AuthenticatedClientIdentity, RegisteredClient } from "../store/model.ts";

export function toAuthenticatedClientIdentity(
  client: RegisteredClient,
  overrides: Partial<AuthenticatedClientIdentity> = {},
): AuthenticatedClientIdentity {
  const availablePublicJwks = overrides.availablePublicJwks
    ?? client.availablePublicJwks
    ?? (client.publicJwk ? [client.publicJwk] : []);
  return {
    clientId: client.clientId,
    clientName: client.clientName,
    tokenEndpointAuthMethod: client.tokenEndpointAuthMethod,
    dynamic: client.dynamic,
    authMode: client.authMode ?? "unaffiliated",
    registeredScope: client.registeredScope,
    frameworkBinding: client.frameworkBinding,
    resolvedEntity: overrides.resolvedEntity,
    availablePublicJwks,
    publicJwk: overrides.publicJwk ?? client.publicJwk,
    jwkThumbprint: overrides.jwkThumbprint ?? client.jwkThumbprint,
    certificateThumbprint: overrides.certificateThumbprint,
  };
}
