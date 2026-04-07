import { X509Certificate } from "node:crypto";

import { ClientRegistry } from "../clients.ts";
import { toAuthenticatedClientIdentity } from "../client-identity.ts";
import { TtlReplayCache } from "../replay-cache.ts";
import { decodeJwtWithoutVerification, extractUriSans, parseX5cCertificates, verifyX509JwtWithKey } from "../x509-jwt.ts";
import { computeJwkThumbprint, normalizePublicJwk } from "../../../shared/private-key-jwt.ts";
import type { DemoAuditStep } from "../../../shared/demo-events.ts";
import type { AuthenticatedClientIdentity, FrameworkClientBinding, FrameworkDefinition, ResolvedFrameworkEntity } from "../../store/model.ts";
import type { FrameworkClientRegistration, FrameworkResolver, SupportedTrustFramework } from "./types.ts";
import { ClientRegistrationError } from "./types.ts";

const UDAP_CLIENT_PREFIX = "udap:";

type UdapSoftwareStatementClaims = {
  iss?: string;
  sub?: string;
  aud?: string | string[];
  exp?: number;
  iat?: number;
  jti?: string;
  client_name?: string;
  grant_types?: string[];
  response_types?: string[];
  token_endpoint_auth_method?: string;
  scope?: string;
  redirect_uris?: string[];
  contacts?: string[];
  logo_uri?: string;
  [key: string]: any;
};

type UdapClientAssertionClaims = {
  iss?: string;
  sub?: string;
  aud?: string | string[];
  exp?: number;
  iat?: number;
  jti?: string;
  [key: string]: any;
};

export class UdapFrameworkResolver implements FrameworkResolver {
  readonly frameworkType = "udap" as const;
  private readonly replayCache = new TtlReplayCache();

  constructor(
    private readonly frameworks: FrameworkDefinition[],
    private readonly clients: ClientRegistry,
  ) {}

  getSupportedTrustFrameworks(): SupportedTrustFramework[] {
    return this.frameworks
      .filter((framework) => framework.frameworkType === "udap" && (framework.supportsClientAuth || framework.supportsIssuerTrust))
      .map((framework) => ({
        framework: framework.framework,
        framework_type: framework.frameworkType,
      }));
  }

  matchesClientId(clientId: string) {
    return clientId.startsWith(UDAP_CLIENT_PREFIX);
  }

  async authenticateClientAssertion(clientId: string, assertionJwt: string, tokenEndpointUrl: string): Promise<AuthenticatedClientIdentity | null> {
    const registeredClient = this.clients.get(clientId);
    if (!registeredClient || registeredClient.authMode !== "udap" || !registeredClient.frameworkBinding) {
      throw new Error(`UDAP client ${clientId} is not registered`);
    }

    let payload: UdapClientAssertionClaims;
    let certificates: X509Certificate[];
    try {
      ({ payload, certificates } = verifyClientAssertion(assertionJwt));
    } catch (error) {
      throw new Error(error instanceof Error ? error.message : "Invalid UDAP client assertion");
    }

    validateClientAssertionClaims(payload, registeredClient.clientId, tokenEndpointUrl);
    ensureJtiNotReplayed(this.replayCache, "udap-authn", String(payload.iss), String(payload.jti), Number(payload.exp), "UDAP client assertion");

    const framework = this.frameworks.find(
      (candidate) => candidate.frameworkType === "udap" && candidate.supportsClientAuth && candidate.framework === registeredClient.frameworkBinding?.framework,
    );
    if (!framework) {
      throw new Error(`Configured UDAP framework ${registeredClient.frameworkBinding.framework} not found for client ${clientId}`);
    }

    const uriSans = extractUriSans(certificates[0]);
    if (!uriSans.includes(registeredClient.frameworkBinding.entity_uri)) {
      throw new Error("UDAP certificate SAN does not match registered entity URI");
    }
    if (!frameworkMatches(framework, certificates, registeredClient.frameworkBinding.entity_uri)) {
      throw new Error(`UDAP certificate chain is not trusted for framework ${framework.framework}`);
    }

    const publicJwk = extractPublicJwk(certificates[0]);
    const resolvedEntity: ResolvedFrameworkEntity = {
      framework: {
        uri: framework.framework,
        type: "udap",
      },
      entityUri: registeredClient.frameworkBinding.entity_uri,
      displayName: registeredClient.clientName,
      publicJwks: publicJwk ? [publicJwk] : undefined,
      metadata: {
        certificate_thumbprint: certificates[0].fingerprint256,
      },
    };
    return toAuthenticatedClientIdentity(
      registeredClient,
      {
        resolvedEntity,
        availablePublicJwks: publicJwk ? [publicJwk] : [],
        publicJwk: publicJwk ?? undefined,
        jwkThumbprint: publicJwk ? await computeJwkThumbprint(publicJwk) : undefined,
        certificateThumbprint: certificates[0].fingerprint256,
      },
    );
  }

  async registerClient(body: Record<string, any>, registrationEndpointUrl: string, authSurfaceUrl: string): Promise<FrameworkClientRegistration | null> {
    const looksLikeUdap = "udap" in body || "software_statement" in body;
    if (!looksLikeUdap) return null;
    const steps: DemoAuditStep[] = [];
    let algorithm = "unknown";
    let frameworkUri: string | undefined;
    let entityUri: string | undefined;
    try {
      if (String(body.udap ?? "") !== "1") {
        throw new ClientRegistrationError("invalid_software_statement", "UDAP registration requires udap=1", 400, { authMode: "udap", steps });
      }
      const softwareStatement = typeof body.software_statement === "string" ? body.software_statement.trim() : "";
      if (!softwareStatement) {
        throw new ClientRegistrationError("invalid_software_statement", "UDAP registration requires a software_statement", 400, { authMode: "udap", steps });
      }

      let payload: UdapSoftwareStatementClaims;
      let certificates: X509Certificate[];
      try {
        try {
          algorithm = String(decodeJwtWithoutVerification(body.software_statement).header.alg ?? "unknown");
        } catch {
          algorithm = "unknown";
        }
        ({ payload, certificates } = verifySoftwareStatement(softwareStatement));
        steps.push({
          check: "Signature",
          passed: true,
          evidence: `alg=${algorithm}`,
          why: "Software statement signature verified against presented x5c certificate",
        });
      } catch (error) {
        throw new ClientRegistrationError(
          "invalid_software_statement",
          error instanceof Error ? error.message : "Software statement verification failed",
          400,
          { authMode: "udap", steps, algorithm },
        );
      }
      entityUri = typeof payload.iss === "string" ? payload.iss : undefined;
      validateSoftwareStatementClaims(payload, certificates[0], registrationEndpointUrl);
      steps.push({
        check: "Claims",
        passed: true,
        evidence: payload.iss as string,
        why: "UDAP software statement claims satisfy SAN, audience, lifetime, and client metadata requirements",
      });
      ensureJtiNotReplayed(this.replayCache, "udap-dcr", String(payload.iss), String(payload.jti), Number(payload.exp), "UDAP software statement");
      steps.push({
        check: "Replay",
        passed: true,
        evidence: String(payload.jti),
        why: "Software statement jti has not been replayed",
      });

      entityUri = payload.iss as string;
      const matchingFrameworks = this.findMatchingFrameworks(certificates, entityUri);
      if (matchingFrameworks.length === 0) {
        throw new ClientRegistrationError(
          "unapproved_software_statement",
          "Software statement certificate chain is not trusted by any configured UDAP framework",
          400,
          { authMode: "udap", steps, entityUri, algorithm },
        );
      }
      if (matchingFrameworks.length > 1) {
        throw new ClientRegistrationError(
          "unapproved_software_statement",
          `Software statement matches multiple UDAP frameworks for entity ${entityUri}`,
          400,
          { authMode: "udap", steps, entityUri, algorithm },
        );
      }

      const framework = matchingFrameworks[0];
      frameworkUri = framework.framework;
      steps.push({
        check: "Framework Trust",
        passed: true,
        evidence: framework.framework,
        why: "Presented certificate chain matches exactly one configured UDAP framework",
      });
      const frameworkBinding: FrameworkClientBinding = {
        binding_type: "framework-entity",
        framework: framework.framework,
        framework_type: "udap",
        entity_uri: entityUri,
      };
      if (isCancellationRequest(payload)) {
        this.clients.cancelUdap(frameworkBinding, authSurfaceUrl);
        return {
          response: buildCancellationResponse(softwareStatement, payload, frameworkBinding),
          statusCode: 200,
          audit: {
            authMode: "udap",
            outcome: "cancelled",
            steps,
            frameworkUri,
            entityUri,
            algorithm,
          },
        };
      }
      const client = this.clients.registerUdap({
        frameworkBinding,
        authSurfaceUrl,
        clientName: payload.client_name,
        scope: payload.scope,
      });
      const resolvedEntity: ResolvedFrameworkEntity = {
        framework: {
          uri: framework.framework,
          type: framework.frameworkType,
        },
        entityUri,
        displayName: payload.client_name?.trim() || entityUri,
        metadata: {
          software_statement_claims: payload,
          certificate_thumbprint: certificates[0].fingerprint256,
        },
      };
      return {
        client,
        resolvedEntity,
        response: buildRegistrationResponse(client.clientId, softwareStatement, payload),
        audit: {
          authMode: "udap",
          outcome: "registered",
          steps,
          frameworkUri,
          entityUri,
          algorithm,
        },
      };
    } catch (error) {
      if (error instanceof ClientRegistrationError) throw error;
      throw new ClientRegistrationError(
        "invalid_software_statement",
        error instanceof Error ? error.message : "Software statement verification failed",
        400,
        { authMode: "udap", steps, frameworkUri, entityUri, algorithm },
      );
    }
  }

  private findMatchingFrameworks(certificates: X509Certificate[], entityUri: string) {
    const udapFrameworks = this.frameworks.filter((framework) => framework.frameworkType === "udap" && framework.supportsClientAuth);
    return udapFrameworks.filter((framework) => frameworkMatches(framework, certificates, entityUri));
  }
}

function verifySoftwareStatement(softwareStatement: string) {
  const { header } = decodeJwtWithoutVerification<UdapSoftwareStatementClaims>(softwareStatement);
  const certificates = parseX5cCertificates(header.x5c);
  const { payload } = verifyX509JwtWithKey<UdapSoftwareStatementClaims>(softwareStatement, certificates[0].publicKey);
  return { payload, certificates };
}

function verifyClientAssertion(assertionJwt: string) {
  const { header } = decodeJwtWithoutVerification<UdapClientAssertionClaims>(assertionJwt);
  const certificates = parseX5cCertificates(header.x5c);
  const { payload } = verifyX509JwtWithKey<UdapClientAssertionClaims>(assertionJwt, certificates[0].publicKey);
  return { payload, certificates };
}

function validateSoftwareStatementClaims(
  payload: UdapSoftwareStatementClaims,
  leafCertificate: X509Certificate,
  registrationEndpointUrl: string,
) {
  const now = Math.floor(Date.now() / 1000);
  if (typeof payload.iss !== "string" || !payload.iss) {
    throw new ClientRegistrationError("invalid_software_statement", "Software statement iss missing");
  }
  if (payload.sub !== payload.iss) {
    throw new ClientRegistrationError("invalid_software_statement", "Software statement sub must match iss");
  }
  if (!audienceIncludes(payload.aud, registrationEndpointUrl)) {
    throw new ClientRegistrationError("invalid_software_statement", "Software statement aud must match the registration endpoint");
  }
  if (typeof payload.exp !== "number" || typeof payload.iat !== "number" || payload.exp <= now || payload.iat > now + 60) {
    throw new ClientRegistrationError("invalid_software_statement", "Software statement exp/iat invalid");
  }
  if (payload.exp - payload.iat > 300) {
    throw new ClientRegistrationError("invalid_software_statement", "Software statement lifetime must not exceed 5 minutes");
  }
  if (typeof payload.jti !== "string" || !payload.jti.trim()) {
    throw new ClientRegistrationError("invalid_software_statement", "Software statement jti missing");
  }
  if (typeof payload.client_name !== "string" || !payload.client_name.trim()) {
    if (!isCancellationRequest(payload)) {
      throw new ClientRegistrationError("invalid_software_statement", "Software statement client_name missing");
    }
  }
  if (!Array.isArray(payload.grant_types) || payload.grant_types.length === 0) {
    throw new ClientRegistrationError("invalid_software_statement", "Software statement grant_types missing");
  }
  if (payload.token_endpoint_auth_method !== "private_key_jwt") {
    throw new ClientRegistrationError("invalid_software_statement", "Software statement token_endpoint_auth_method must be private_key_jwt");
  }
  const uriSans = extractUriSans(leafCertificate);
  if (!uriSans.includes(payload.iss)) {
    throw new ClientRegistrationError("invalid_software_statement", "Software statement iss must match a URI SAN on the client certificate");
  }
}

function validateClientAssertionClaims(
  payload: UdapClientAssertionClaims,
  clientId: string,
  tokenEndpointUrl: string,
) {
  const now = Math.floor(Date.now() / 1000);
  if (payload.iss !== clientId || payload.sub !== clientId) {
    throw new Error("UDAP client assertion iss/sub must match the registered client_id");
  }
  if (!audienceIncludes(payload.aud, tokenEndpointUrl)) {
    throw new Error("UDAP client assertion aud must match the token endpoint");
  }
  if (typeof payload.exp !== "number" || typeof payload.iat !== "number" || payload.exp <= now || payload.iat > now + 60) {
    throw new Error("UDAP client assertion exp/iat invalid");
  }
  if (payload.exp - payload.iat > 300) {
    throw new Error("UDAP client assertion lifetime must not exceed 5 minutes");
  }
  if (typeof payload.jti !== "string" || !payload.jti.trim()) {
    throw new Error("UDAP client assertion jti missing");
  }
}

function frameworkMatches(framework: FrameworkDefinition, certificates: X509Certificate[], entityUri: string) {
  const allowlist = framework.udap?.entityAllowlist;
  if (allowlist?.length && !allowlist.includes(entityUri)) return false;
  const trustAnchors = framework.udap?.trustAnchors ?? [];
  return trustAnchors.some((trustAnchorPem) => validateCertificatePath(certificates, new X509Certificate(trustAnchorPem)));
}

function validateCertificatePath(certificates: X509Certificate[], trustAnchor: X509Certificate) {
  if (!trustAnchor.ca) return false;
  if (certificates.length === 0) return false;
  const now = Date.now();
  for (const certificate of certificates) {
    if (!isCurrentlyValid(certificate, now)) return false;
  }
  if (!isCurrentlyValid(trustAnchor, now)) return false;

  for (let index = 0; index < certificates.length - 1; index += 1) {
    if (!certificateIssuedBy(certificates[index], certificates[index + 1])) return false;
  }

  const lastPresented = certificates[certificates.length - 1];
  if (sameCertificate(lastPresented, trustAnchor)) return true;
  return certificateIssuedBy(lastPresented, trustAnchor);
}

function isCurrentlyValid(certificate: X509Certificate, nowMs: number) {
  const validFrom = certificate.validFromDate?.getTime() ?? new Date(certificate.validFrom).getTime();
  const validTo = certificate.validToDate?.getTime() ?? new Date(certificate.validTo).getTime();
  return Number.isFinite(validFrom) && Number.isFinite(validTo) && validFrom <= nowMs && nowMs <= validTo;
}

function certificateIssuedBy(certificate: X509Certificate, issuer: X509Certificate) {
  return certificate.checkIssued(issuer) && certificate.verify(issuer.publicKey);
}

function sameCertificate(left: X509Certificate, right: X509Certificate) {
  return left.raw.equals(right.raw);
}

function audienceIncludes(aud: string | string[] | undefined, expected: string) {
  if (typeof aud === "string") return aud === expected;
  return Array.isArray(aud) && aud.includes(expected);
}

function extractPublicJwk(certificate: X509Certificate) {
  try {
    return normalizePublicJwk(certificate.publicKey.export({ format: "jwk" }) as JsonWebKey);
  } catch {
    return null;
  }
}

function buildRegistrationResponse(clientId: string, softwareStatement: string, payload: UdapSoftwareStatementClaims) {
  const response: Record<string, any> = {
    client_id: clientId,
    software_statement: softwareStatement,
  };
  for (const key of [
    "client_name",
    "grant_types",
    "response_types",
    "token_endpoint_auth_method",
    "scope",
    "redirect_uris",
    "contacts",
    "logo_uri",
  ] satisfies Array<keyof UdapSoftwareStatementClaims>) {
    if (payload[key] !== undefined) {
      response[key] = payload[key];
    }
  }
  return response;
}

function buildCancellationResponse(softwareStatement: string, payload: UdapSoftwareStatementClaims, frameworkBinding: FrameworkClientBinding) {
  return {
    client_id: null,
    software_statement: softwareStatement,
    client_name: payload.client_name?.trim() || frameworkBinding.entity_uri,
    grant_types: payload.grant_types,
    token_endpoint_auth_method: payload.token_endpoint_auth_method,
  };
}

function ensureJtiNotReplayed(
  replayCache: TtlReplayCache,
  purpose: "udap-dcr" | "udap-authn",
  issuer: string,
  jti: string,
  exp: number,
  label: string,
) {
  const replayKey = `${purpose}|${issuer}|${jti}`;
  if (!replayCache.consume(replayKey, exp)) {
    throw new Error(`${label} jti has already been used`);
  }
}

function isCancellationRequest(payload: UdapSoftwareStatementClaims) {
  return Array.isArray(payload.grant_types) && payload.grant_types.length === 1 && payload.grant_types[0] === "";
}
