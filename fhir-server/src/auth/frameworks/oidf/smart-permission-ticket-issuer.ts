import { normalizePublicJwk } from "../../../../shared/private-key-jwt.ts";
import type { EntityMetadata } from "./trust-chain.ts";

export const SMART_PERMISSION_TICKET_ISSUER_ENTITY_TYPE = "smart_permission_ticket_issuer";

export function extractTicketIssuerMetadata(resolvedMetadata: EntityMetadata) {
  const metadata = resolvedMetadata[SMART_PERMISSION_TICKET_ISSUER_ENTITY_TYPE];
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    throw new Error(
      `OIDF oidf_ticket_issuer_metadata_missing: resolved metadata is missing ${SMART_PERMISSION_TICKET_ISSUER_ENTITY_TYPE}`,
    );
  }

  const rawIssuerUrl = metadata.issuer_url;
  if (typeof rawIssuerUrl !== "string" || !rawIssuerUrl.trim()) {
    throw new Error(
      `OIDF oidf_ticket_issuer_url_missing: ${SMART_PERMISSION_TICKET_ISSUER_ENTITY_TYPE}.issuer_url must be a non-empty string`,
    );
  }

  let issuer_url: string;
  try {
    issuer_url = new URL(rawIssuerUrl).toString();
  } catch (error) {
    throw new Error(
      `OIDF oidf_ticket_issuer_url_invalid: ${SMART_PERMISSION_TICKET_ISSUER_ENTITY_TYPE}.issuer_url must be a parseable absolute URL (${error instanceof Error ? error.message : String(error)})`,
    );
  }

  const jwks = metadata.jwks;
  const keys = jwks && typeof jwks === "object" && !Array.isArray(jwks) ? (jwks as { keys?: unknown }).keys : undefined;
  if (!Array.isArray(keys) || keys.length === 0) {
    throw new Error(
      `OIDF oidf_ticket_issuer_jwks_missing: ${SMART_PERMISSION_TICKET_ISSUER_ENTITY_TYPE}.jwks.keys must be a non-empty array`,
    );
  }

  const publicJwks: JsonWebKey[] = [];
  const seenKids = new Set<string>();
  for (const [index, key] of keys.entries()) {
    if (!key || typeof key !== "object" || Array.isArray(key)) {
      throw new Error(
        `OIDF oidf_ticket_issuer_jwks_invalid_key: ${SMART_PERMISSION_TICKET_ISSUER_ENTITY_TYPE}.jwks.keys[${index}] must be an object`,
      );
    }
    const kid = typeof (key as { kid?: unknown }).kid === "string" ? (key as { kid: string }).kid : "";
    if (!kid.trim()) {
      throw new Error(
        `OIDF oidf_ticket_issuer_jwks_kid_missing: ${SMART_PERMISSION_TICKET_ISSUER_ENTITY_TYPE}.jwks.keys[${index}].kid must be a non-empty string`,
      );
    }
    if (seenKids.has(kid)) {
      throw new Error(
        `OIDF oidf_ticket_issuer_jwks_duplicate_kid: duplicate kid ${kid} in ${SMART_PERMISSION_TICKET_ISSUER_ENTITY_TYPE}.jwks`,
      );
    }
    try {
      const normalizedPublicJwk = normalizePublicJwk(key as JsonWebKey);
      publicJwks.push({
        ...normalizedPublicJwk,
        kid,
      } as JsonWebKey);
    } catch (error) {
      throw new Error(
        `OIDF oidf_ticket_issuer_jwks_invalid_key: ${SMART_PERMISSION_TICKET_ISSUER_ENTITY_TYPE}.jwks.keys[${index}] failed normalization (${error instanceof Error ? error.message : String(error)})`,
      );
    }
    seenKids.add(kid);
  }

  return { issuer_url, publicJwks };
}
