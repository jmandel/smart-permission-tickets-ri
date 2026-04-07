import { describe, expect, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createAppContext } from "../src/app.ts";
import { FhirStore } from "../src/store/store.ts";
import { loadConfig } from "../src/config.ts";
import {
  DEFAULT_DEMO_UDAP_RSA_TRUST_ANCHOR_PEM,
  DEFAULT_DEMO_UDAP_RSA_TRUST_ANCHOR_PRIVATE_KEY_PEM,
  DEFAULT_DEMO_UDAP_TRUST_ANCHOR_PEM,
  DEFAULT_DEMO_UDAP_TRUST_ANCHOR_PRIVATE_KEY_PEM,
  DEFAULT_DEMO_WELL_KNOWN_CLIENT_PRIVATE_JWK,
} from "../src/auth/demo-frameworks.ts";
import { DEFAULT_PERMISSION_TICKET_ISSUER_PRIVATE_JWK } from "../src/auth/issuers.ts";

describe("demo crypto bundle", () => {
  test("loadConfig materializes bundle-backed public keys from DEMO_CRYPTO_BUNDLE_PATH", () => {
    const siteSlugs = FhirStore.load().listSiteSummaries().map((site) => site.siteSlug);
    const bundlePath = writeBundle(bundleForSites(siteSlugs));
    try {
      withEnv("DEMO_CRYPTO_BUNDLE_PATH", bundlePath, () => {
        const config = loadConfig();
        expect(config.demoCryptoBundle?.ticketIssuers["reference-demo"]?.publicJwk.kty).toBe("EC");
        expect(config.demoCryptoBundle?.wellKnown.default.publicJwk.kty).toBe("EC");
        expect(config.demoCryptoBundle?.oidf.providerSites[siteSlugs[0]!]!.publicJwk.kty).toBe("EC");
        expect(config.demoCryptoBundle?.udap.rsa.clientPublicJwk.kty).toBe("RSA");
        expect(config.demoCryptoBundle?.udap.rsa.clientPublicJwk.n).toBeString();
      });
    } finally {
      rmSync(bundlePath, { force: true });
      rmSync(join(bundlePath, ".."), { recursive: true, force: true });
    }
  });

  test("createAppContext fails loudly when bundle-backed mode is missing a discovered site key", () => {
    const allSiteSlugs = FhirStore.load().listSiteSummaries().map((site) => site.siteSlug);
    const bundlePath = writeBundle(bundleForSites(allSiteSlugs.slice(0, -1)));
    try {
      withEnv("DEMO_CRYPTO_BUNDLE_PATH", bundlePath, () => {
        expect(() => createAppContext({ port: 0 })).toThrow(/missing OIDF provider-site keys/i);
      });
    } finally {
      rmSync(bundlePath, { force: true });
      rmSync(join(bundlePath, ".."), { recursive: true, force: true });
    }
  });
});

function bundleForSites(siteSlugs: string[]) {
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
      providerSites: Object.fromEntries(siteSlugs.map((siteSlug) => [siteSlug, { privateJwk: generateEcPrivateJwk() }])),
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

function writeBundle(bundle: Record<string, unknown>) {
  const workspace = mkdtempSync(join(tmpdir(), "smart-permission-tickets-demo-crypto-"));
  const bundlePath = join(workspace, "bundle.json");
  writeFileSync(bundlePath, JSON.stringify(bundle, null, 2), "utf8");
  return bundlePath;
}

function withEnv(name: string, value: string, fn: () => void) {
  const previous = Bun.env[name];
  Bun.env[name] = value;
  try {
    fn();
  } finally {
    if (previous === undefined) delete Bun.env[name];
    else Bun.env[name] = previous;
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
