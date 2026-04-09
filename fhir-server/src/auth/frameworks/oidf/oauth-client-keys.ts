import { normalizePublicJwk } from "../../../../shared/private-key-jwt.ts";
import type { EntityMetadata } from "./trust-chain.ts";

export type OidfOauthClientPublicJwk = ReturnType<typeof normalizePublicJwk> & {
  kid: string;
};

export function extractOidfOauthClientPublicJwks(metadata: EntityMetadata): OidfOauthClientPublicJwk[] {
  const oauthClient = metadata.oauth_client;
  if (!oauthClient || typeof oauthClient !== "object" || Array.isArray(oauthClient)) {
    throw new Error(
      "OIDF oidf_oauth_client_metadata_missing: resolved metadata is missing oauth_client for client authentication",
    );
  }
  if (typeof oauthClient.jwks_uri === "string" && oauthClient.jwks_uri) {
    throw new Error(
      "OIDF oidf_oauth_client_jwks_uri_unsupported: oauth_client.jwks_uri is not implemented for client authentication",
    );
  }
  if (typeof oauthClient.signed_jwks_uri === "string" && oauthClient.signed_jwks_uri) {
    throw new Error(
      "OIDF oidf_oauth_client_signed_jwks_uri_unsupported: oauth_client.signed_jwks_uri is not implemented for client authentication",
    );
  }

  const jwks = oauthClient.jwks;
  const keys = (jwks as { keys?: JsonWebKey[] } | undefined)?.keys;
  if (!Array.isArray(keys) || keys.length === 0) {
    throw new Error(
      "OIDF oidf_oauth_client_jwks_missing: oauth_client.jwks.keys must be a non-empty array for client authentication",
    );
  }

  const normalizedKeys = keys.map((jwk, index) => normalizeOidfOauthClientPublicJwk(jwk, index));
  const kids = normalizedKeys.map((key) => key.kid);
  if (new Set(kids).size !== kids.length) {
    throw new Error(
      "OIDF oidf_oauth_client_jwks_duplicate_kid: oauth_client.jwks contains duplicate kid values",
    );
  }

  return normalizedKeys;
}

function normalizeOidfOauthClientPublicJwk(jwk: JsonWebKey, index: number): OidfOauthClientPublicJwk {
  const keyKid = (jwk as JsonWebKey & { kid?: string }).kid;
  const kid = typeof keyKid === "string"
    ? keyKid.trim()
    : "";
  if (!kid) {
    throw new Error(
      `OIDF oidf_oauth_client_jwks_kid_missing: oauth_client.jwks key ${index} is missing kid`,
    );
  }

  try {
    return {
      ...normalizePublicJwk(jwk),
      kid,
    };
  } catch (error) {
    throw new Error(
      `OIDF oidf_oauth_client_jwks_invalid_key: oauth_client.jwks key ${index} is invalid (${error instanceof Error ? error.message : String(error)})`,
    );
  }
}
