import { describe, expect, test } from "bun:test";

import { generateClientKeyMaterial, normalizePublicJwk } from "../shared/private-key-jwt.ts";
import { PATIENT_SELF_ACCESS_TICKET_TYPE, PERMISSION_TICKET_SUBJECT_TOKEN_TYPE } from "../shared/permission-tickets.ts";
import { decodeEs256Jwt } from "../src/auth/es256-jwt.ts";
import { buildDefaultFrameworks } from "../src/auth/demo-frameworks.ts";
import { SMART_PERMISSION_TICKET_ISSUER_ENTITY_TYPE } from "../src/auth/frameworks/oidf/smart-permission-ticket-issuer.ts";
import { createAppContext, startServer } from "../src/app.ts";

describe("issuer key publication consistency", () => {
  test("multi-method issuer publishes the same signing key through direct JWKS and OIDF", async () => {
    const { context, origin, publicOrigin, server } = startHarness();
    try {
      const issuer = context.issuers.get(context.config.defaultPermissionTicketIssuerSlug);
      if (!issuer) throw new Error("Missing direct issuer");

      const directJwks = await fetchJson<{ keys: JsonWebKey[] }>(`${origin}/issuer/reference-demo/.well-known/jwks.json`);
      const oidfTrust = await context.frameworks.resolveIssuerTrustByType("oidf", `${publicOrigin}/issuer/reference-demo`);
      if (!oidfTrust) throw new Error("Expected OIDF issuer trust");

      const directKey = directJwks.keys.find((key) => key.kid === issuer.kid);
      const oidfKey = oidfTrust.publicJwks.find((key) => key.kid === issuer.kid);
      if (!directKey || !oidfKey) throw new Error("Missing published key for issuer kid");

      expect(canonicalizePublicJwk(directKey)).toEqual(canonicalizePublicJwk(oidfKey));
    } finally {
      server.stop(true);
    }
  });

  test("ticket issuer entity configuration publishes a federation key distinct from the inline ticket-signing jwks", async () => {
    const { context, origin, server } = startHarness();
    try {
      const entityStatement = await fetchText(`${origin}/issuer/reference-demo/.well-known/openid-federation`);
      const decoded = decodeEs256Jwt<Record<string, any>>(entityStatement);
      const federationKey = decoded.payload.jwks.keys[0];
      const inlineKey = inlineTicketIssuerJwks(context)[0];
      if (!federationKey || !inlineKey) throw new Error("Missing published ticket issuer keys");

      expect(canonicalizePublicJwk(federationKey)).not.toEqual(canonicalizePublicJwk(inlineKey));
    } finally {
      server.stop(true);
    }
  });

  test("publication consistency helper flags shared-kid disagreement", async () => {
    const { context, origin, publicOrigin, server } = startHarness();
    try {
      const issuer = context.issuers.get(context.config.defaultPermissionTicketIssuerSlug);
      if (!issuer) throw new Error("Missing direct issuer");
      const alternate = await generateClientKeyMaterial();

      setInlineTicketIssuerJwks(context, [
        {
          ...alternate.publicJwk,
          kid: issuer.kid,
        },
      ]);

      const directJwks = await fetchJson<{ keys: JsonWebKey[] }>(`${origin}/issuer/reference-demo/.well-known/jwks.json`);
      const oidfTrust = await context.frameworks.resolveIssuerTrustByType("oidf", `${publicOrigin}/issuer/reference-demo`);
      if (!oidfTrust) throw new Error("Expected OIDF issuer trust");

      expect(() => assertPublishedKeyConsistency(issuer.kid, [
        { label: "direct JWKS", keys: directJwks.keys },
        { label: "OIDF", keys: oidfTrust.publicJwks },
      ])).toThrow(`OIDF issuer key for kid ${issuer.kid} disagrees with direct JWKS`);
    } finally {
      server.stop(true);
    }
  });

  test("runtime verification follows the selected primary source and ignores mismatched secondary publication", async () => {
    const { context, origin, publicOrigin, server } = startHarness((resolvedPublicOrigin) => ({
      issuerTrust: {
        policies: [
          {
            type: "direct_jwks",
            trustedIssuers: [`${resolvedPublicOrigin}/issuer/reference-demo`],
          },
          {
            type: "oidf",
          },
        ],
      },
    }));
    try {
      const issuer = context.issuers.get(context.config.defaultPermissionTicketIssuerSlug);
      if (!issuer) throw new Error("Missing direct issuer");
      const alternate = await generateClientKeyMaterial();

      setInlineTicketIssuerJwks(context, [
        {
          ...alternate.publicJwk,
          kid: issuer.kid,
        },
      ]);

      const response = await exchangeTicket(origin, mintTicket(context, publicOrigin));
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(typeof body.access_token).toBe("string");
    } finally {
      server.stop(true);
    }
  });
});

function startHarness(
  overrides: Parameters<typeof createAppContext>[0] | ((publicOrigin: string) => Parameters<typeof createAppContext>[0]) = {},
) {
  const publicOrigin = "https://tickets.example.test";
  const resolvedOverrides = typeof overrides === "function" ? overrides(publicOrigin) : overrides;
  const context = createAppContext({
    port: 0,
    publicBaseUrl: publicOrigin,
    issuer: publicOrigin,
    frameworks: buildDefaultFrameworks(publicOrigin, "reference-demo"),
    ...resolvedOverrides,
  });
  const server = startServer(context, 0);
  const origin = `http://127.0.0.1:${server.port}`;
  context.config.internalBaseUrl = origin;
  return { context, server, origin, publicOrigin };
}

async function fetchJson<T>(url: string) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Failed to fetch ${url}: ${response.status}`);
  return response.json() as Promise<T>;
}

async function fetchText(url: string) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Failed to fetch ${url}: ${response.status}`);
  return response.text();
}

function assertPublishedKeyConsistency(kid: string, sources: Array<{ label: string; keys: JsonWebKey[] }>) {
  const primary = sources[0]!;
  const primaryKey = primary.keys.find((key) => key.kid === kid);
  if (!primaryKey) throw new Error(`Missing key ${kid} in ${primary.label}`);
  const normalizedPrimary = canonicalizePublicJwk(primaryKey);

  for (const source of sources.slice(1)) {
    const candidate = source.keys.find((key) => key.kid === kid);
    if (!candidate) continue;
    if (canonicalizePublicJwk(candidate) !== normalizedPrimary) {
      throw new Error(`${source.label} issuer key for kid ${kid} disagrees with ${primary.label}`);
    }
  }
}

function canonicalizePublicJwk(jwk: JsonWebKey) {
  if (jwk.kty === "EC" && jwk.crv === "P-256" && jwk.x && jwk.y) {
    const normalized = normalizePublicJwk(jwk);
    return JSON.stringify({
      kty: normalized.kty,
      crv: normalized.crv,
      x: normalized.x,
      y: normalized.y,
    });
  }
  if (jwk.kty === "RSA" && jwk.n && jwk.e) {
    return JSON.stringify({
      kty: "RSA",
      n: jwk.n,
      e: jwk.e,
    });
  }
  throw new Error("Unsupported issuer public JWK type");
}

function inlineTicketIssuerJwks(context: ReturnType<typeof createAppContext>) {
  const metadata = context.oidfTopology.entities["ticket-issuer"].metadata[SMART_PERMISSION_TICKET_ISSUER_ENTITY_TYPE];
  if (!metadata) throw new Error("Missing smart_permission_ticket_issuer metadata");
  const jwks = (metadata as { jwks?: { keys?: JsonWebKey[] } }).jwks;
  if (!Array.isArray(jwks?.keys)) throw new Error("Missing smart_permission_ticket_issuer.jwks.keys");
  return jwks.keys;
}

function setInlineTicketIssuerJwks(context: ReturnType<typeof createAppContext>, keys: JsonWebKey[]) {
  const metadata = context.oidfTopology.entities["ticket-issuer"].metadata[SMART_PERMISSION_TICKET_ISSUER_ENTITY_TYPE];
  if (!metadata) throw new Error("Missing smart_permission_ticket_issuer metadata");
  (metadata as { jwks?: { keys?: JsonWebKey[] } }).jwks = { keys };
}

function mintTicket(context: ReturnType<typeof createAppContext>, publicOrigin: string) {
  return context.issuers.sign(publicOrigin, context.config.defaultPermissionTicketIssuerSlug, {
    iss: `${publicOrigin}/issuer/${context.config.defaultPermissionTicketIssuerSlug}`,
    aud: publicOrigin,
    exp: Math.floor(Date.now() / 1000) + 3600,
    jti: crypto.randomUUID(),
    ticket_type: PATIENT_SELF_ACCESS_TICKET_TYPE,
    subject: {
      patient: {
        resourceType: "Patient",
        name: [{ family: "Reyes", given: ["Elena"] }],
        birthDate: "1989-09-14",
      },
    },
    access: {
      permissions: [{
        kind: "data",
        resource_type: "Patient",
        interactions: ["read", "search"],
      }],
      data_period: { start: "2023-01-01", end: "2025-12-31" },
      sensitive_data: "exclude",
    },
  });
}

function exchangeTicket(origin: string, ticket: string) {
  return fetch(`${origin}/modes/open/token`, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
      subject_token_type: PERMISSION_TICKET_SUBJECT_TOKEN_TYPE,
      subject_token: ticket,
    }),
  });
}
