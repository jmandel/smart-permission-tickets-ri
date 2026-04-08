import { createPrivateKey, createPublicKey, generateKeyPairSync } from "node:crypto";
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";

import {
  DEFAULT_DEMO_UDAP_RSA_TRUST_ANCHOR_PEM,
  DEFAULT_DEMO_UDAP_RSA_TRUST_ANCHOR_PRIVATE_KEY_PEM,
  DEFAULT_DEMO_UDAP_TRUST_ANCHOR_PEM,
  DEFAULT_DEMO_UDAP_TRUST_ANCHOR_PRIVATE_KEY_PEM,
  DEFAULT_DEMO_WELL_KNOWN_CLIENT_PRIVATE_JWK,
} from "./auth/demo-frameworks.ts";
import { DEFAULT_PERMISSION_TICKET_ISSUER_PRIVATE_JWK } from "./auth/issuers.ts";

type DemoCryptoBundlePrivateJwkEntry = {
  privateJwk: JsonWebKey;
};

type DemoCryptoBundleJwkEntry = DemoCryptoBundlePrivateJwkEntry & {
  publicJwk: JsonWebKey;
};

type DemoCryptoBundleUdapEntry = {
  caCertificatePem: string;
  caPrivateKeyPem: string;
  clientPrivateJwk: JsonWebKey;
  clientPublicJwk: JsonWebKey;
};

export type DemoCryptoBundleDocument = {
  version: 1;
  ticketIssuers: Record<string, DemoCryptoBundlePrivateJwkEntry>;
  oidf: {
    anchor: DemoCryptoBundlePrivateJwkEntry;
    appNetwork: DemoCryptoBundlePrivateJwkEntry;
    providerNetwork: DemoCryptoBundlePrivateJwkEntry;
    demoApp: DemoCryptoBundlePrivateJwkEntry;
    providerSites: Record<string, DemoCryptoBundlePrivateJwkEntry>;
  };
  wellKnown: {
    default: DemoCryptoBundlePrivateJwkEntry;
  };
  udap: {
    ec: Omit<DemoCryptoBundleUdapEntry, "clientPublicJwk">;
    rsa: Omit<DemoCryptoBundleUdapEntry, "clientPublicJwk">;
  };
};

export type DemoCryptoBundle = {
  version: 1;
  ticketIssuers: Record<string, DemoCryptoBundleJwkEntry>;
  oidf: {
    anchor: DemoCryptoBundleJwkEntry;
    appNetwork: DemoCryptoBundleJwkEntry;
    providerNetwork: DemoCryptoBundleJwkEntry;
    demoApp: DemoCryptoBundleJwkEntry;
    providerSites: Record<string, DemoCryptoBundleJwkEntry>;
  };
  wellKnown: {
    default: DemoCryptoBundleJwkEntry;
  };
  udap: {
    ec: DemoCryptoBundleUdapEntry;
    rsa: DemoCryptoBundleUdapEntry;
  };
};

type EnsureDemoCryptoBundleOptions = {
  bundlePath: string;
  siteSlugs: string[];
  issuerSlugs: string[];
};

type BundleEntryKind =
  | { kind: "ticket-issuer"; slug: string }
  | { kind: "provider-site"; slug: string }
  | { kind: "fixed-role"; name: string };

const CONVENTIONAL_BUNDLE_PATH = path.resolve(import.meta.dir, "..", ".demo-crypto-bundle.json");

export function resolveDemoCryptoBundlePath(configuredPath: string | undefined) {
  return configuredPath ?? CONVENTIONAL_BUNDLE_PATH;
}

export function loadDemoCryptoBundle(configuredPath: string | undefined): DemoCryptoBundle | undefined {
  const bundlePath = resolveDemoCryptoBundlePath(configuredPath);
  if (!existsSync(bundlePath)) return undefined;
  return parseDemoCryptoBundle(readFileSync(bundlePath, "utf8"), bundlePath);
}

export function ensureDemoCryptoBundle({
  bundlePath,
  siteSlugs,
  issuerSlugs,
}: EnsureDemoCryptoBundleOptions): DemoCryptoBundle {
  const normalizedSiteSlugs = normalizeSlugs(siteSlugs);
  const normalizedIssuerSlugs = normalizeSlugs(issuerSlugs);

  if (!existsSync(bundlePath)) {
    const created = generateDemoCryptoBundle(normalizedSiteSlugs, { issuerSlugs: normalizedIssuerSlugs });
    writeBundleDocumentAtomically(bundlePath, created);
    console.info(`demo crypto bundle: created ${bundlePath} with ${countManagedEntries(created)} entries`);
    return parseDemoCryptoBundle(serializeBundleDocument(created), bundlePath);
  }

  const raw = readFileSync(bundlePath, "utf8");
  const bundleDocument = parseDemoCryptoBundleDocumentTolerantly(raw, bundlePath);
  const additions = growDemoCryptoBundleDocument(bundleDocument, {
    siteSlugs: normalizedSiteSlugs,
    issuerSlugs: normalizedIssuerSlugs,
  });

  if (!additions.length) {
    return parseDemoCryptoBundle(raw, bundlePath);
  }

  writeBundleDocumentAtomically(bundlePath, bundleDocument);
  for (const addition of additions) {
    if (addition.kind === "provider-site") {
      console.info(`demo crypto bundle: added provider-site key for ${addition.slug}`);
    } else if (addition.kind === "ticket-issuer") {
      console.info(`demo crypto bundle: added ticket-issuer key for ${addition.slug}`);
    } else {
      console.info(`demo crypto bundle: added fixed role key for ${addition.name}`);
    }
  }
  console.info(`demo crypto bundle: grew with ${additions.length} new entries, wrote ${bundlePath}`);
  return parseDemoCryptoBundle(serializeBundleDocument(bundleDocument), bundlePath);
}

export function parseDemoCryptoBundle(raw: string, sourceLabel = "demo crypto bundle"): DemoCryptoBundle {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`Invalid ${sourceLabel}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`Invalid ${sourceLabel}: expected a JSON object`);
  }
  const bundle = parsed as Record<string, unknown>;
  if (bundle.version !== 1) {
    throw new Error(`Invalid ${sourceLabel}: only version 1 bundles are supported`);
  }
  return {
    version: 1,
    ticketIssuers: materializeJwkEntryRecord(readObject(bundle.ticketIssuers, `${sourceLabel}.ticketIssuers`), `${sourceLabel}.ticketIssuers`),
    oidf: {
      anchor: materializeJwkEntry(readObject(bundle.oidf, `${sourceLabel}.oidf`).anchor, `${sourceLabel}.oidf.anchor`),
      appNetwork: materializeJwkEntry(readObject(bundle.oidf, `${sourceLabel}.oidf`).appNetwork, `${sourceLabel}.oidf.appNetwork`),
      providerNetwork: materializeJwkEntry(readObject(bundle.oidf, `${sourceLabel}.oidf`).providerNetwork, `${sourceLabel}.oidf.providerNetwork`),
      demoApp: materializeJwkEntry(readObject(bundle.oidf, `${sourceLabel}.oidf`).demoApp, `${sourceLabel}.oidf.demoApp`),
      providerSites: materializeJwkEntryRecord(
        readObject(readObject(bundle.oidf, `${sourceLabel}.oidf`).providerSites, `${sourceLabel}.oidf.providerSites`),
        `${sourceLabel}.oidf.providerSites`,
      ),
    },
    wellKnown: {
      default: materializeJwkEntry(readObject(bundle.wellKnown, `${sourceLabel}.wellKnown`).default, `${sourceLabel}.wellKnown.default`),
    },
    udap: {
      ec: materializeUdapEntry(readObject(bundle.udap, `${sourceLabel}.udap`).ec, `${sourceLabel}.udap.ec`),
      rsa: materializeUdapEntry(readObject(bundle.udap, `${sourceLabel}.udap`).rsa, `${sourceLabel}.udap.rsa`),
    },
  };
}

export function generateDemoCryptoBundle(
  siteSlugs: string[],
  options: { issuerSlugs?: string[] } = {},
): DemoCryptoBundleDocument {
  return {
    version: 1,
    ticketIssuers: Object.fromEntries(
      normalizeSlugs(options.issuerSlugs ?? ["reference-demo"]).map((issuerSlug) => [
        issuerSlug,
        {
          privateJwk: issuerSlug === "reference-demo" ? DEFAULT_PERMISSION_TICKET_ISSUER_PRIVATE_JWK : generateEcPrivateJwk(),
        },
      ]),
    ),
    oidf: {
      anchor: { privateJwk: generateEcPrivateJwk() },
      appNetwork: { privateJwk: generateEcPrivateJwk() },
      providerNetwork: { privateJwk: generateEcPrivateJwk() },
      demoApp: { privateJwk: generateEcPrivateJwk() },
      providerSites: Object.fromEntries(
        normalizeSlugs(siteSlugs).map((siteSlug) => [siteSlug, { privateJwk: generateEcPrivateJwk() }]),
      ),
    },
    wellKnown: {
      default: {
        privateJwk: DEFAULT_DEMO_WELL_KNOWN_CLIENT_PRIVATE_JWK,
      },
    },
    udap: {
      ec: {
        caCertificatePem: DEFAULT_DEMO_UDAP_TRUST_ANCHOR_PEM,
        caPrivateKeyPem: DEFAULT_DEMO_UDAP_TRUST_ANCHOR_PRIVATE_KEY_PEM,
        clientPrivateJwk: generateEcPrivateJwk(),
      },
      rsa: {
        caCertificatePem: DEFAULT_DEMO_UDAP_RSA_TRUST_ANCHOR_PEM,
        caPrivateKeyPem: DEFAULT_DEMO_UDAP_RSA_TRUST_ANCHOR_PRIVATE_KEY_PEM,
        clientPrivateJwk: generateRsaPrivateJwk(),
      },
    },
  };
}

export function conventionalDemoCryptoBundlePath() {
  return CONVENTIONAL_BUNDLE_PATH;
}

function growDemoCryptoBundleDocument(
  bundleDocument: Record<string, unknown>,
  { siteSlugs, issuerSlugs }: { siteSlugs: string[]; issuerSlugs: string[] },
) {
  if (bundleDocument.version === undefined) {
    bundleDocument.version = 1;
  } else if (bundleDocument.version !== 1) {
    throw new Error(`Invalid demo crypto bundle: only version 1 bundles are supported`);
  }

  const additions: BundleEntryKind[] = [];
  const ticketIssuers = ensureObjectChild(bundleDocument, "ticketIssuers", "demo crypto bundle.ticketIssuers");
  for (const issuerSlug of issuerSlugs) {
    if (ticketIssuers[issuerSlug] !== undefined) continue;
    ticketIssuers[issuerSlug] = {
      privateJwk: issuerSlug === "reference-demo" ? DEFAULT_PERMISSION_TICKET_ISSUER_PRIVATE_JWK : generateEcPrivateJwk(),
    } satisfies DemoCryptoBundlePrivateJwkEntry;
    additions.push({ kind: "ticket-issuer", slug: issuerSlug });
  }

  const oidf = ensureObjectChild(bundleDocument, "oidf", "demo crypto bundle.oidf");
  additions.push(...ensureOidfFixedRole(oidf, "anchor"));
  additions.push(...ensureOidfFixedRole(oidf, "appNetwork"));
  additions.push(...ensureOidfFixedRole(oidf, "providerNetwork"));
  additions.push(...ensureOidfFixedRole(oidf, "demoApp"));
  const providerSites = ensureObjectChild(oidf, "providerSites", "demo crypto bundle.oidf.providerSites");
  for (const siteSlug of siteSlugs) {
    if (providerSites[siteSlug] !== undefined) continue;
    providerSites[siteSlug] = {
      privateJwk: generateEcPrivateJwk(),
    } satisfies DemoCryptoBundlePrivateJwkEntry;
    additions.push({ kind: "provider-site", slug: siteSlug });
  }

  const wellKnown = ensureObjectChild(bundleDocument, "wellKnown", "demo crypto bundle.wellKnown");
  if (wellKnown.default === undefined) {
    wellKnown.default = {
      privateJwk: DEFAULT_DEMO_WELL_KNOWN_CLIENT_PRIVATE_JWK,
    } satisfies DemoCryptoBundlePrivateJwkEntry;
    additions.push({ kind: "fixed-role", name: "wellKnown.default" });
  }

  const udap = ensureObjectChild(bundleDocument, "udap", "demo crypto bundle.udap");
  if (udap.ec === undefined) {
    udap.ec = {
      caCertificatePem: DEFAULT_DEMO_UDAP_TRUST_ANCHOR_PEM,
      caPrivateKeyPem: DEFAULT_DEMO_UDAP_TRUST_ANCHOR_PRIVATE_KEY_PEM,
      clientPrivateJwk: generateEcPrivateJwk(),
    } satisfies Omit<DemoCryptoBundleUdapEntry, "clientPublicJwk">;
    additions.push({ kind: "fixed-role", name: "udap.ec" });
  }
  if (udap.rsa === undefined) {
    udap.rsa = {
      caCertificatePem: DEFAULT_DEMO_UDAP_RSA_TRUST_ANCHOR_PEM,
      caPrivateKeyPem: DEFAULT_DEMO_UDAP_RSA_TRUST_ANCHOR_PRIVATE_KEY_PEM,
      clientPrivateJwk: generateRsaPrivateJwk(),
    } satisfies Omit<DemoCryptoBundleUdapEntry, "clientPublicJwk">;
    additions.push({ kind: "fixed-role", name: "udap.rsa" });
  }
  return additions;
}

function ensureOidfFixedRole(oidf: Record<string, unknown>, role: "anchor" | "appNetwork" | "providerNetwork" | "demoApp") {
  if (oidf[role] !== undefined) return [];
  oidf[role] = {
    privateJwk: generateEcPrivateJwk(),
  } satisfies DemoCryptoBundlePrivateJwkEntry;
  return [{ kind: "fixed-role", name: `oidf.${role}` } satisfies BundleEntryKind];
}

function parseDemoCryptoBundleDocumentTolerantly(raw: string, sourceLabel: string) {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`Invalid ${sourceLabel}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`Invalid ${sourceLabel}: expected a JSON object`);
  }
  return parsed as Record<string, unknown>;
}

function ensureObjectChild(parent: Record<string, unknown>, key: string, label: string) {
  const existing = parent[key];
  if (existing === undefined) {
    const created: Record<string, unknown> = {};
    parent[key] = created;
    return created;
  }
  if (!existing || typeof existing !== "object" || Array.isArray(existing)) {
    throw new Error(`Invalid ${label}: expected an object`);
  }
  return existing as Record<string, unknown>;
}

function writeBundleDocumentAtomically(bundlePath: string, bundleDocument: DemoCryptoBundleDocument | Record<string, unknown>) {
  mkdirSync(path.dirname(bundlePath), { recursive: true });
  const tempPath = `${bundlePath}.tmp`;
  const fd = openSync(tempPath, "w");
  try {
    writeFileSync(fd, serializeBundleDocument(bundleDocument), "utf8");
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tempPath, bundlePath);
}

function serializeBundleDocument(bundleDocument: DemoCryptoBundleDocument | Record<string, unknown>) {
  return `${JSON.stringify(bundleDocument, null, 2)}\n`;
}

function countManagedEntries(bundle: DemoCryptoBundleDocument) {
  return Object.keys(bundle.ticketIssuers).length
    + 4
    + Object.keys(bundle.oidf.providerSites).length
    + 1
    + 2;
}

function normalizeSlugs(values: string[]) {
  return [...new Set(values.filter((value) => value.trim()))].sort();
}

function materializeJwkEntryRecord(record: Record<string, unknown>, label: string) {
  return Object.fromEntries(
    Object.entries(record).map(([key, value]) => [key, materializeJwkEntry(value, `${label}.${key}`)]),
  );
}

function materializeJwkEntry(value: unknown, label: string): DemoCryptoBundleJwkEntry {
  const record = readObject(value, label);
  const privateJwk = readObject(record.privateJwk, `${label}.privateJwk`) as JsonWebKey;
  return {
    privateJwk,
    publicJwk: derivePublicJwk(privateJwk, label),
  };
}

function materializeUdapEntry(value: unknown, label: string): DemoCryptoBundleUdapEntry {
  const record = readObject(value, label);
  return {
    caCertificatePem: readString(record.caCertificatePem, `${label}.caCertificatePem`),
    caPrivateKeyPem: readString(record.caPrivateKeyPem, `${label}.caPrivateKeyPem`),
    clientPrivateJwk: readObject(record.clientPrivateJwk, `${label}.clientPrivateJwk`) as JsonWebKey,
    clientPublicJwk: derivePublicJwk(readObject(record.clientPrivateJwk, `${label}.clientPrivateJwk`) as JsonWebKey, label),
  };
}

function derivePublicJwk(privateJwk: JsonWebKey, label: string) {
  try {
    const privateKey = createPrivateKey({ key: privateJwk, format: "jwk" });
    return createPublicKey(privateKey).export({ format: "jwk" }) as JsonWebKey;
  } catch (error) {
    throw new Error(`Invalid ${label}.privateJwk: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function generateEcPrivateJwk() {
  const { privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  return privateKey.export({ format: "jwk" }) as JsonWebKey;
}

function generateRsaPrivateJwk() {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  return privateKey.export({ format: "jwk" }) as JsonWebKey;
}

function readObject(value: unknown, label: string) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Invalid ${label}: expected an object`);
  }
  return value as Record<string, unknown>;
}

function readString(value: unknown, label: string) {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`Invalid ${label}: expected a non-empty string`);
  }
  return value;
}
