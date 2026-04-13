import { createHash, randomUUID } from "node:crypto";

import { computeJwkThumbprint, normalizePublicJwk } from "../../shared/private-key-jwt.ts";
import type { FrameworkClientBinding, RegisteredClient } from "../store/model.ts";
import { signJwt, verifyJwt } from "./jwt.ts";

type DynamicClientPayload = {
  sub: "dynamic-client";
  iat: number;
  jti: string;
  client_name: string;
  token_endpoint_auth_method: RegisteredClient["tokenEndpointAuthMethod"];
  auth_surface: string;
  public_jwk: JsonWebKey;
  jwk_thumbprint: string;
};

type UdapClientPayload = {
  sub: "udap-client";
  framework: string;
  framework_type: "udap";
  entity_uri: string;
  token_endpoint_auth_method: "private_key_jwt";
  auth_surface: string;
  scope?: string;
};

export class ClientRegistry {
  private readonly clients = new Map<string, RegisteredClient>();
  private readonly activeUdapRegistrations = new Map<string, string | null>();
  private readonly registrationSecret: string;

  constructor(seed: RegisteredClient[], registrationSecret: string) {
    this.registrationSecret = registrationSecret;
    for (const client of seed) this.clients.set(client.clientId, normalizeClientRecord(client));
  }

  get(clientId: string | undefined | null) {
    if (!clientId) return null;
    const client = this.clients.get(clientId) ?? this.decodeDynamicClient(clientId) ?? this.decodeUdapClient(clientId);
    if (!client) return null;
    if (client.authMode === "udap" && !this.isActiveUdapClient(client)) return null;
    return client;
  }

  async register(input: {
    clientName?: string;
    publicJwk: JsonWebKey;
    authSurfaceUrl: string;
    tokenEndpointAuthMethod?: RegisteredClient["tokenEndpointAuthMethod"];
  }) {
    if (input.tokenEndpointAuthMethod && input.tokenEndpointAuthMethod !== "private_key_jwt") {
      throw new Error("Dynamic registration only supports private_key_jwt");
    }
    const jti = randomUUID();
    const publicJwk = normalizePublicJwk(input.publicJwk);
    const jwkThumbprint = await computeJwkThumbprint(publicJwk);
    const payload: DynamicClientPayload = {
      sub: "dynamic-client",
      iat: Math.floor(Date.now() / 1000),
      jti,
      client_name: input.clientName?.trim() || "Dynamic Client",
      token_endpoint_auth_method: input.tokenEndpointAuthMethod ?? "private_key_jwt",
      auth_surface: input.authSurfaceUrl,
      public_jwk: publicJwk,
      jwk_thumbprint: jwkThumbprint,
    };
    const clientId = signJwt(payload, this.registrationSecret, { typ: "client-id+jwt" });
    const client: RegisteredClient = {
      clientId,
      clientName: payload.client_name,
      tokenEndpointAuthMethod: payload.token_endpoint_auth_method,
      registeredAuthSurface: payload.auth_surface,
      publicJwk,
      jwkThumbprint,
      dynamic: true,
      authMode: "unaffiliated",
    };
    return client;
  }

  registerUdap(input: { frameworkBinding: FrameworkClientBinding; authSurfaceUrl: string; clientName?: string; scope?: string }) {
    if (input.frameworkBinding.framework_type !== "udap") {
      throw new Error("UDAP registrations require a UDAP framework binding");
    }
    const payload: UdapClientPayload = {
      sub: "udap-client",
      framework: input.frameworkBinding.framework,
      framework_type: "udap",
      entity_uri: input.frameworkBinding.entity_uri,
      token_endpoint_auth_method: "private_key_jwt",
      auth_surface: input.authSurfaceUrl,
      scope: input.scope?.trim() || undefined,
    };
    const signedDescriptor = signJwt(payload, this.registrationSecret, { typ: "client-id+jwt" });
    const client = normalizeClientRecord({
      clientId: `udap:${signedDescriptor}`,
      clientName: input.clientName?.trim() || input.frameworkBinding.entity_uri,
      tokenEndpointAuthMethod: "private_key_jwt",
      registeredAuthSurface: payload.auth_surface,
      registeredScope: payload.scope,
      dynamic: false,
      authMode: "udap",
      frameworkBinding: input.frameworkBinding,
    });
    this.activeUdapRegistrations.set(this.udapRegistrationKey(input.frameworkBinding, input.authSurfaceUrl), hashClientId(client.clientId));
    this.clients.set(client.clientId, client);
    return client;
  }

  cancelUdap(frameworkBinding: FrameworkClientBinding, authSurfaceUrl: string) {
    if (frameworkBinding.framework_type !== "udap") {
      throw new Error("UDAP cancellation requires a UDAP framework binding");
    }
    this.activeUdapRegistrations.set(this.udapRegistrationKey(frameworkBinding, authSurfaceUrl), null);
  }

  private decodeDynamicClient(clientId: string): RegisteredClient | null {
    try {
      const { payload } = verifyJwt<DynamicClientPayload>(clientId, this.registrationSecret);
      if (payload.sub !== "dynamic-client" || !payload.jti || !payload.client_name || !payload.token_endpoint_auth_method || !payload.auth_surface || !payload.public_jwk || !payload.jwk_thumbprint) return null;
      const publicJwk = normalizePublicJwk(payload.public_jwk);
      return {
        clientId,
        clientName: payload.client_name,
        tokenEndpointAuthMethod: payload.token_endpoint_auth_method,
        registeredAuthSurface: payload.auth_surface,
        publicJwk,
        jwkThumbprint: payload.jwk_thumbprint,
        dynamic: true,
        authMode: "unaffiliated",
      };
    } catch {
      return null;
    }
  }

  private decodeUdapClient(clientId: string): RegisteredClient | null {
    if (!clientId.startsWith("udap:")) return null;
    try {
      const descriptor = clientId.slice("udap:".length);
      const { payload } = verifyJwt<UdapClientPayload>(descriptor, this.registrationSecret);
      if (
        payload.sub !== "udap-client"
        || payload.framework_type !== "udap"
        || payload.token_endpoint_auth_method !== "private_key_jwt"
        || !payload.auth_surface
        || !payload.framework
        || !payload.entity_uri
      ) {
        return null;
      }
      return normalizeClientRecord({
        clientId,
        clientName: payload.entity_uri,
        tokenEndpointAuthMethod: "private_key_jwt",
        registeredAuthSurface: payload.auth_surface,
        registeredScope: payload.scope?.trim() || undefined,
        dynamic: false,
        authMode: "udap",
        frameworkBinding: {
          method: "trust_framework_client",
          framework: payload.framework,
          framework_type: "udap",
          entity_uri: payload.entity_uri,
        },
      });
    } catch {
      return null;
    }
  }

  private isActiveUdapClient(client: RegisteredClient) {
    if (client.authMode !== "udap" || !client.frameworkBinding) return true;
    const activeHash = this.activeUdapRegistrations.get(this.udapRegistrationKey(client.frameworkBinding, client.registeredAuthSurface ?? ""));
    if (activeHash === undefined) return true;
    if (activeHash === null) return false;
    return activeHash === hashClientId(client.clientId);
  }

  private udapRegistrationKey(binding: FrameworkClientBinding, authSurfaceUrl: string) {
    return `${binding.framework}|${binding.entity_uri}|${authSurfaceUrl}`;
  }
}

function normalizeClientRecord(client: RegisteredClient): RegisteredClient {
  return {
    ...client,
    authMode: client.authMode ?? "unaffiliated",
  };
}

function hashClientId(clientId: string) {
  return createHash("sha256").update(clientId).digest("base64url");
}
