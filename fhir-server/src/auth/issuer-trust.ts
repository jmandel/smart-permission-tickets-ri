import type { ServerConfig } from "../config.ts";
import type { IssuerTrustConfig, IssuerTrustPolicy, IssuerTrustPredicate, ResolvedIssuerTrust } from "../store/model.ts";
import type { FrameworkRegistry } from "./frameworks/registry.ts";
import { resolveDirectJwksIssuerTrust } from "./issuers.ts";

export async function resolveConfiguredIssuerTrust(
  issuerUrl: string,
  config: Pick<ServerConfig, "issuerTrust" | "publicBaseUrl" | "internalBaseUrl">,
  frameworks: FrameworkRegistry,
  fetchImpl: typeof fetch = fetch,
): Promise<ResolvedIssuerTrust> {
  const normalizedIssuerUrl = normalizeIssuerUrl(issuerUrl);
  const policies = config.issuerTrust?.policies ?? [];
  for (const policy of policies) {
    const resolved = await resolveIssuerTrustViaPolicy(policy, normalizedIssuerUrl, config, frameworks, fetchImpl);
    if (resolved) return resolved;
  }
  throw new Error("Unknown Permission Ticket issuer");
}

async function resolveIssuerTrustViaPolicy(
  policy: IssuerTrustPolicy,
  issuerUrl: string,
  config: Pick<ServerConfig, "publicBaseUrl" | "internalBaseUrl">,
  frameworks: FrameworkRegistry,
  fetchImpl: typeof fetch,
): Promise<ResolvedIssuerTrust | null> {
  switch (policy.type) {
    case "direct_jwks":
      if (!policy.trustedIssuers.map(normalizeIssuerUrl).includes(issuerUrl)) return null;
      return resolveDirectJwksIssuerTrust(issuerUrl, config, fetchImpl);
    case "oidf": {
      const resolved = await frameworks.resolveIssuerTrustByType("oidf", issuerUrl);
      if (!resolved) return null;
      return policy.require && !matchesPredicate(policy.require, issuerUrl, resolved) ? null : resolved;
    }
    case "udap": {
      const resolved = await frameworks.resolveIssuerTrustByType("udap", issuerUrl);
      if (!resolved) return null;
      return policy.require && !matchesPredicate(policy.require, issuerUrl, resolved) ? null : resolved;
    }
  }
}

function matchesPredicate(predicate: IssuerTrustPredicate, issuerUrl: string, issuerTrust: ResolvedIssuerTrust): boolean {
  switch (predicate.kind) {
    case "all":
      return predicate.rules.every((rule) => matchesPredicate(rule, issuerUrl, issuerTrust));
    case "any":
      return predicate.rules.some((rule) => matchesPredicate(rule, issuerUrl, issuerTrust));
    case "issuer_url_in":
      return predicate.values.map(normalizeIssuerUrl).includes(issuerUrl);
    case "oidf_chain_anchored_in": {
      if (issuerTrust.framework?.type !== "oidf") return false;
      const metadata = asRecord(issuerTrust.metadata);
      const trustChain = asRecord(metadata?.trust_chain);
      const anchorEntityId = stringValue(trustChain?.anchor_entity_id) ?? stringValue(trustChain?.expected_anchor);
      return !!anchorEntityId && predicate.entityIds.includes(anchorEntityId);
    }
    case "oidf_has_trust_mark": {
      if (issuerTrust.framework?.type !== "oidf") return false;
      const metadata = asRecord(issuerTrust.metadata);
      const trustMark = asRecord(metadata?.trust_mark);
      const trustMarkType = stringValue(trustMark?.trust_mark_type);
      return !!trustMarkType && predicate.trustMarkTypes.includes(trustMarkType);
    }
    case "udap_chains_to": {
      if (issuerTrust.framework?.type !== "udap") return false;
      const metadata = asRecord(issuerTrust.metadata);
      const trustAnchors = arrayOfStrings(metadata?.trust_anchors);
      return trustAnchors.some((trustAnchor) => predicate.trustAnchors.includes(trustAnchor));
    }
  }
}

function normalizeIssuerUrl(raw: string) {
  const parsed = new URL(raw);
  parsed.hash = "";
  parsed.search = "";
  if (parsed.pathname.length > 1 && parsed.pathname.endsWith("/")) {
    parsed.pathname = parsed.pathname.replace(/\/+$/, "");
  }
  return parsed.toString();
}

function asRecord(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function stringValue(value: unknown) {
  return typeof value === "string" && value.trim() ? value : null;
}

function arrayOfStrings(value: unknown) {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string" && !!entry.trim()) : [];
}
