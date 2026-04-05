import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";

import type { FrameworkDefinition } from "../store/model.ts";
import { buildUdapCrlUrl, findUdapCertificateAuthority } from "./udap-crl.ts";
import { pemToDerBase64, signRs256JwtWithPem } from "./x509-jwt.ts";

type UdapMetadataSigner = {
  certificateChainPems: string[];
  privateKeyPem: string;
};

const generatedSignerCache = new Map<string, UdapMetadataSigner>();

export function buildSignedUdapMetadata(
  framework: FrameworkDefinition,
  fhirBaseUrl: string,
  claims: {
    authorization_endpoint?: string;
    token_endpoint: string;
    registration_endpoint: string;
  },
) {
  const signer = resolveUdapMetadataSigner(framework, fhirBaseUrl);
  const now = Math.floor(Date.now() / 1000);
  return signRs256JwtWithPem(
    {
      iss: fhirBaseUrl,
      sub: fhirBaseUrl,
      iat: now,
      exp: now + 3600,
      jti: randomUUID(),
      ...claims,
    },
    signer.privateKeyPem,
    {
      x5c: signer.certificateChainPems.map((pem) => pemToDerBase64(pem)),
    },
  );
}

function resolveUdapMetadataSigner(framework: FrameworkDefinition, fhirBaseUrl: string): UdapMetadataSigner {
  const crlDistributionUrl = resolveMetadataSignerCrlDistributionUrl(framework, fhirBaseUrl);
  const configuredCertificatePem = framework.udap?.metadataSigningCertificatePem?.trim();
  const configuredPrivateKeyPem = framework.udap?.metadataSigningPrivateKeyPem?.trim();
  if (configuredCertificatePem && configuredPrivateKeyPem) {
    return {
      certificateChainPems: [configuredCertificatePem],
      privateKeyPem: configuredPrivateKeyPem,
    };
  }

  const issuerCertificatePem = framework.udap?.metadataSigningIssuerCertificatePem?.trim();
  const issuerPrivateKeyPem = framework.udap?.metadataSigningIssuerPrivateKeyPem?.trim();
  if (issuerCertificatePem && issuerPrivateKeyPem) {
    const cacheKey = `${framework.framework}|issuer|${fhirBaseUrl}`;
    const cached = generatedSignerCache.get(cacheKey);
    if (cached) return cached;
    const generated = generateIssuerSignedRsaCertificate(
      fhirBaseUrl,
      framework.framework,
      issuerCertificatePem,
      issuerPrivateKeyPem,
      crlDistributionUrl,
    );
    generatedSignerCache.set(cacheKey, generated);
    return generated;
  }

  const cacheKey = `${framework.framework}|${fhirBaseUrl}`;
  const cached = generatedSignerCache.get(cacheKey);
  if (cached) return cached;

  const generated = generateSelfSignedRsaCertificate(fhirBaseUrl, framework.framework, crlDistributionUrl);
  generatedSignerCache.set(cacheKey, generated);
  return generated;
}

function generateSelfSignedRsaCertificate(
  fhirBaseUrl: string,
  frameworkUri: string,
  crlDistributionUrl?: string,
): UdapMetadataSigner {
  const workspace = mkdtempSync(join(tmpdir(), "smart-permission-tickets-udap-"));
  const configPath = join(workspace, "openssl.cnf");
  const keyPath = join(workspace, "metadata.key");
  const certPath = join(workspace, "metadata.crt");
  try {
    writeFileSync(
      configPath,
      [
        "[ req ]",
        "prompt = no",
        "distinguished_name = dn",
        "x509_extensions = v3_req",
        "[ dn ]",
        `CN = ${escapeDnValue(shortMetadataCommonName(frameworkUri))}`,
        "[ v3_req ]",
        "basicConstraints = critical, CA:FALSE",
        "subjectKeyIdentifier = hash",
        "keyUsage = critical, digitalSignature",
        "extendedKeyUsage = serverAuth",
        `subjectAltName = URI:${fhirBaseUrl}`,
        ...(crlDistributionUrl ? [`crlDistributionPoints = URI:${crlDistributionUrl}`] : []),
      ].join("\n"),
      "utf8",
    );
    execFileSync(
      "openssl",
      [
        "req",
        "-x509",
        "-newkey",
        "rsa:2048",
        "-sha256",
        "-nodes",
        "-days",
        "365",
        "-keyout",
        keyPath,
        "-out",
        certPath,
        "-config",
        configPath,
      ],
      {
        stdio: ["ignore", "ignore", "pipe"],
      },
    );
    return {
      certificateChainPems: [readFileSync(certPath, "utf8")],
      privateKeyPem: readFileSync(keyPath, "utf8"),
    };
  } catch (error) {
    const detail = error instanceof Error ? error.message : "Unknown error";
    throw new Error(`Unable to generate UDAP metadata signing certificate: ${detail}`);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
}

function generateIssuerSignedRsaCertificate(
  fhirBaseUrl: string,
  frameworkUri: string,
  issuerCertificatePem: string,
  issuerPrivateKeyPem: string,
  crlDistributionUrl?: string,
): UdapMetadataSigner {
  const workspace = mkdtempSync(join(tmpdir(), "smart-permission-tickets-udap-"));
  const requestConfigPath = join(workspace, "request.cnf");
  const signConfigPath = join(workspace, "sign.cnf");
  const keyPath = join(workspace, "metadata.key");
  const csrPath = join(workspace, "metadata.csr");
  const certPath = join(workspace, "metadata.crt");
  const issuerCertPath = join(workspace, "issuer.crt");
  const issuerKeyPath = join(workspace, "issuer.key");
  try {
    writeFileSync(
      requestConfigPath,
      [
        "[ req ]",
        "prompt = no",
        "distinguished_name = dn",
        "req_extensions = v3_req",
        "[ dn ]",
        `CN = ${escapeDnValue(shortMetadataCommonName(frameworkUri))}`,
        "[ v3_req ]",
        "basicConstraints = critical, CA:FALSE",
        "subjectKeyIdentifier = hash",
        "keyUsage = critical, digitalSignature",
        "extendedKeyUsage = serverAuth",
        `subjectAltName = URI:${fhirBaseUrl}`,
        ...(crlDistributionUrl ? [`crlDistributionPoints = URI:${crlDistributionUrl}`] : []),
      ].join("\n"),
      "utf8",
    );
    writeFileSync(
      signConfigPath,
      [
        "[ v3_req ]",
        "basicConstraints = critical, CA:FALSE",
        "subjectKeyIdentifier = hash",
        "authorityKeyIdentifier = keyid,issuer",
        "keyUsage = critical, digitalSignature",
        "extendedKeyUsage = serverAuth",
        `subjectAltName = URI:${fhirBaseUrl}`,
        ...(crlDistributionUrl ? [`crlDistributionPoints = URI:${crlDistributionUrl}`] : []),
      ].join("\n"),
      "utf8",
    );
    writeFileSync(issuerCertPath, issuerCertificatePem, "utf8");
    writeFileSync(issuerKeyPath, issuerPrivateKeyPem, "utf8");
    execFileSync(
      "openssl",
      [
        "req",
        "-new",
        "-newkey",
        "rsa:2048",
        "-sha256",
        "-nodes",
        "-keyout",
        keyPath,
        "-out",
        csrPath,
        "-config",
        requestConfigPath,
      ],
      {
        stdio: ["ignore", "ignore", "pipe"],
      },
    );
    execFileSync(
      "openssl",
      [
        "x509",
        "-req",
        "-in",
        csrPath,
        "-CA",
        issuerCertPath,
        "-CAkey",
        issuerKeyPath,
        "-CAcreateserial",
        "-out",
        certPath,
        "-days",
        "365",
        "-sha256",
        "-extfile",
        signConfigPath,
        "-extensions",
        "v3_req",
      ],
      {
        stdio: ["ignore", "ignore", "pipe"],
      },
    );
    return {
      certificateChainPems: [readFileSync(certPath, "utf8"), issuerCertificatePem],
      privateKeyPem: readFileSync(keyPath, "utf8"),
    };
  } catch (error) {
    const detail = error instanceof Error ? error.message : "Unknown error";
    throw new Error(`Unable to generate UDAP metadata signing certificate: ${detail}`);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
}

function escapeDnValue(value: string) {
  return value.replace(/[\\,+<>;"=]/g, "\\$&");
}

function shortMetadataCommonName(frameworkUri: string) {
  try {
    const parsed = new URL(frameworkUri);
    const suffix = parsed.hostname.replace(/^www\./, "").slice(0, 40);
    return `UDAP Metadata ${suffix}`.slice(0, 64);
  } catch {
    return "UDAP Metadata";
  }
}

function resolveMetadataSignerCrlDistributionUrl(framework: FrameworkDefinition, fhirBaseUrl: string) {
  const caId = framework.udap?.metadataSigningIssuerCaId?.trim();
  if (!caId) return undefined;
  const authority = findUdapCertificateAuthority(framework, caId);
  if (!authority) return undefined;
  return buildUdapCrlUrl(new URL(fhirBaseUrl).origin, framework.framework, authority.caId);
}
