import { randomUUID } from "node:crypto";

import { computeJwkThumbprint, normalizePublicJwk } from "../../shared/private-key-jwt.ts";
import type { RegisteredClient } from "../store/model.ts";
import { signJwt, verifyJwt } from "./jwt.ts";

type DynamicClientPayload = {
  sub: "dynamic-client";
  iat: number;
  jti: string;
  client_name: string;
  token_endpoint_auth_method: RegisteredClient["tokenEndpointAuthMethod"];
  public_jwk: JsonWebKey;
  jwk_thumbprint: string;
};

export class ClientRegistry {
  private readonly clients = new Map<string, RegisteredClient>();
  private readonly registrationSecret: string;

  constructor(seed: RegisteredClient[], registrationSecret: string) {
    this.registrationSecret = registrationSecret;
    for (const client of seed) this.clients.set(client.clientId, client);
  }

  get(clientId: string | undefined | null) {
    if (!clientId) return null;
    return this.clients.get(clientId) ?? this.decodeDynamicClient(clientId);
  }

  async register(input: { clientName?: string; publicJwk: JsonWebKey; tokenEndpointAuthMethod?: RegisteredClient["tokenEndpointAuthMethod"] }) {
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
      public_jwk: publicJwk,
      jwk_thumbprint: jwkThumbprint,
    };
    const clientId = signJwt(payload, this.registrationSecret, { typ: "client-id+jwt" });
    const client: RegisteredClient = {
      clientId,
      clientName: payload.client_name,
      tokenEndpointAuthMethod: payload.token_endpoint_auth_method,
      publicJwk,
      jwkThumbprint,
      dynamic: true,
    };
    return client;
  }

  private decodeDynamicClient(clientId: string): RegisteredClient | null {
    try {
      const { payload } = verifyJwt<DynamicClientPayload>(clientId, this.registrationSecret);
      if (payload.sub !== "dynamic-client" || !payload.jti || !payload.client_name || !payload.token_endpoint_auth_method || !payload.public_jwk || !payload.jwk_thumbprint) return null;
      const publicJwk = normalizePublicJwk(payload.public_jwk);
      return {
        clientId,
        clientName: payload.client_name,
        tokenEndpointAuthMethod: payload.token_endpoint_auth_method,
        publicJwk,
        jwkThumbprint: payload.jwk_thumbprint,
        dynamic: true,
      };
    } catch {
      return null;
    }
  }
}
