import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { createAppContext } from "../src/app.ts";
import { FhirStore } from "../src/store/store.ts";
import { loadConfig } from "../src/config.ts";
import { generateDemoCryptoBundle } from "../src/demo-crypto-bundle.ts";

describe("demo crypto bundle", () => {
  test("loadConfig materializes bundle-backed public keys from DEMO_CRYPTO_BUNDLE_PATH", () => {
    const siteSlugs = FhirStore.load().listSiteSummaries().map((site) => site.siteSlug);
    const bundlePath = writeBundle(generateDemoCryptoBundle(siteSlugs));
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
      rmSync(dirname(bundlePath), { recursive: true, force: true });
    }
  });

  test("createAppContext fails loudly when bundle-backed mode is missing a discovered site key", () => {
    const allSiteSlugs = FhirStore.load().listSiteSummaries().map((site) => site.siteSlug);
    const bundlePath = writeBundle(generateDemoCryptoBundle(allSiteSlugs.slice(0, -1)));
    try {
      withEnv("DEMO_CRYPTO_BUNDLE_PATH", bundlePath, () => {
        expect(() => createAppContext({ port: 0 })).toThrow(/missing OIDF provider-site keys/i);
      });
    } finally {
      rmSync(bundlePath, { force: true });
      rmSync(dirname(bundlePath), { recursive: true, force: true });
    }
  });
  
  test("generateDemoCryptoBundle emits one provider-site key per requested site slug", () => {
    const siteSlugs = ["alpha-site", "zeta-site", "beta-site"];
    const bundle = generateDemoCryptoBundle(siteSlugs);
    expect(Object.keys(bundle.oidf.providerSites)).toEqual(["alpha-site", "beta-site", "zeta-site"]);
  });
});

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
