import { createPrivateKey, createPublicKey, generateKeyPairSync } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
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

const CONVENTIONAL_BUNDLE_PATH = path.resolve(import.meta.dir, "..", ".demo-crypto-bundle.json");

export function loadDemoCryptoBundle(configuredPath: string | undefined): DemoCryptoBundle | undefined {
  const bundlePath = resolveBundlePath(configuredPath);
  if (!bundlePath) return undefined;
  return parseDemoCryptoBundle(readFileSync(bundlePath, "utf8"), bundlePath);
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

export function generateDemoCryptoBundle(siteSlugs: string[]): DemoCryptoBundleDocument {
  return {
    version: 1,
    ticketIssuers: {
      "reference-demo": {
        privateJwk: DEFAULT_PERMISSION_TICKET_ISSUER_PRIVATE_JWK,
      },
    },
    oidf: {
      anchor: { privateJwk: generateEcPrivateJwk() },
      appNetwork: { privateJwk: generateEcPrivateJwk() },
      providerNetwork: { privateJwk: generateEcPrivateJwk() },
      demoApp: { privateJwk: generateEcPrivateJwk() },
      providerSites: Object.fromEntries(
        [...siteSlugs].sort().map((siteSlug) => [siteSlug, { privateJwk: generateEcPrivateJwk() }]),
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

export function assertDemoCryptoBundleCoversSites(bundle: DemoCryptoBundle | undefined, siteSlugs: string[]) {
  if (!bundle) return;
  const missing = siteSlugs.filter((siteSlug) => !bundle.oidf.providerSites[siteSlug]);
  if (!missing.length) return;
  throw new Error(`Demo crypto bundle is missing OIDF provider-site keys for: ${missing.join(", ")}`);
}

export function conventionalDemoCryptoBundlePath() {
  return CONVENTIONAL_BUNDLE_PATH;
}

function resolveBundlePath(configuredPath: string | undefined) {
  if (configuredPath) return configuredPath;
  return existsSync(CONVENTIONAL_BUNDLE_PATH) ? CONVENTIONAL_BUNDLE_PATH : undefined;
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
