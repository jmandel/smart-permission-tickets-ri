import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { FrameworkDefinition, UdapCertificateAuthority } from "../store/model.ts";

type GeneratedCertificateRevocationList = {
  pem: string;
  der: Uint8Array;
};

const crlCache = new Map<string, GeneratedCertificateRevocationList>();

export function buildUdapCrlPath(frameworkUri: string, caId: string) {
  return `/.well-known/udap/crls/${slugifyFrameworkUri(frameworkUri)}/${slugifyToken(caId)}.crl`;
}

export function buildUdapCrlUrl(origin: string, frameworkUri: string, caId: string) {
  return `${origin}${buildUdapCrlPath(frameworkUri, caId)}`;
}

export function findUdapCertificateAuthority(framework: FrameworkDefinition, caId: string) {
  return framework.udap?.certificateAuthorities?.find((authority) => authority.caId === caId) ?? null;
}

export function findUdapFrameworkByCrlPath(frameworks: FrameworkDefinition[], frameworkSlug: string, caSlug: string) {
  for (const framework of frameworks) {
    if (framework.frameworkType !== "udap") continue;
    if (slugifyFrameworkUri(framework.framework) !== frameworkSlug) continue;
    const authority = framework.udap?.certificateAuthorities?.find((candidate) => slugifyToken(candidate.caId) === caSlug);
    if (authority) return { framework, authority };
  }
  return null;
}

export function generateCertificateRevocationList(authority: UdapCertificateAuthority): GeneratedCertificateRevocationList {
  const cacheKey = `${authority.caId}:${authority.certificatePem}`;
  const cached = crlCache.get(cacheKey);
  if (cached) return cached;

  const workspace = mkdtempSync(join(tmpdir(), "smart-permission-tickets-crl-"));
  const caConfigPath = join(workspace, "openssl.cnf");
  const caCertPath = join(workspace, "ca.crt");
  const caKeyPath = join(workspace, "ca.key");
  const indexPath = join(workspace, "index.txt");
  const serialPath = join(workspace, "serial");
  const crlNumberPath = join(workspace, "crlnumber");
  const crlPemPath = join(workspace, "ca.crl.pem");
  const crlDerPath = join(workspace, "ca.crl");

  try {
    writeFileSync(caCertPath, authority.certificatePem, "utf8");
    writeFileSync(caKeyPath, authority.privateKeyPem, "utf8");
    writeFileSync(indexPath, "", "utf8");
    writeFileSync(serialPath, "1000\n", "utf8");
    writeFileSync(crlNumberPath, "1000\n", "utf8");
    writeFileSync(
      caConfigPath,
      [
        "[ ca ]",
        "default_ca = demo_ca",
        "[ demo_ca ]",
        `database = ${indexPath}`,
        `certificate = ${caCertPath}`,
        `private_key = ${caKeyPath}`,
        `serial = ${serialPath}`,
        `crlnumber = ${crlNumberPath}`,
        "default_md = sha256",
        "default_crl_days = 30",
        "unique_subject = no",
      ].join("\n"),
      "utf8",
    );
    execFileSync(
      "openssl",
      [
        "ca",
        "-gencrl",
        "-config",
        caConfigPath,
        "-name",
        "demo_ca",
        "-out",
        crlPemPath,
        "-batch",
      ],
      { stdio: ["ignore", "ignore", "pipe"] },
    );
    execFileSync(
      "openssl",
      [
        "crl",
        "-in",
        crlPemPath,
        "-inform",
        "PEM",
        "-out",
        crlDerPath,
        "-outform",
        "DER",
      ],
      { stdio: ["ignore", "ignore", "pipe"] },
    );

    const generated = {
      pem: readFileSync(crlPemPath, "utf8"),
      der: new Uint8Array(readFileSync(crlDerPath)),
    };
    crlCache.set(cacheKey, generated);
    return generated;
  } catch (error) {
    const detail = error instanceof Error ? error.message : "Unknown error";
    throw new Error(`Unable to generate demo UDAP CRL: ${detail}`);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
}

function slugifyFrameworkUri(value: string) {
  try {
    const parsed = new URL(value);
    return slugifyToken(`${parsed.hostname}${parsed.pathname}`);
  } catch {
    return slugifyToken(value);
  }
}

function slugifyToken(value: string) {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    || "default";
}
