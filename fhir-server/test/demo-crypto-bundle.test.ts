import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { createAppContext, startServer } from "../src/app.ts";
import { DEFAULT_DEMO_UDAP_FRAMEWORK_URI } from "../src/auth/demo-frameworks.ts";
import { FhirStore } from "../src/store/store.ts";
import {
  ensureDemoCryptoBundle,
  generateDemoCryptoBundle,
  type DemoCryptoBundleDocument,
} from "../src/demo-crypto-bundle.ts";

describe("demo crypto bundle", () => {
  test("ensureDemoCryptoBundle creates the lockfile and reuses it unchanged on the second pass", () => {
    const siteSlugs = FhirStore.load().listSiteSummaries().map((site) => site.siteSlug);
    const bundlePath = tempBundlePath();
    try {
      const first = ensureDemoCryptoBundle({
        bundlePath,
        siteSlugs,
        issuerSlugs: ["reference-demo"],
      });
      const firstRaw = readBundleRaw(bundlePath);
      const firstMtime = statSync(bundlePath).mtimeMs;

      const second = ensureDemoCryptoBundle({
        bundlePath,
        siteSlugs,
        issuerSlugs: ["reference-demo"],
      });
      const secondRaw = readBundleRaw(bundlePath);
      const secondMtime = statSync(bundlePath).mtimeMs;

      expect(first.ticketIssuers["reference-demo"]?.publicJwk.kty).toBe("EC");
      expect(second.ticketIssuers["reference-demo"]?.publicJwk.kty).toBe("EC");
      expect(secondRaw).toBe(firstRaw);
      expect(secondMtime).toBe(firstMtime);
    } finally {
      cleanupBundlePath(bundlePath);
    }
  });

  test("ensureDemoCryptoBundle grows a missing provider-site entry without changing existing site keys", () => {
    const allSiteSlugs = FhirStore.load().listSiteSummaries().map((site) => site.siteSlug);
    const keptSiteSlug = allSiteSlugs[0]!;
    const missingSiteSlug = allSiteSlugs.at(-1)!;
    const bundlePath = writeBundle(generateDemoCryptoBundle(allSiteSlugs.slice(0, -1)));
    try {
      const before = readBundle(bundlePath);
      const preservedPrivateD = privateScalarFor(before.oidf.providerSites[keptSiteSlug]);

      ensureDemoCryptoBundle({
        bundlePath,
        siteSlugs: allSiteSlugs,
        issuerSlugs: ["reference-demo"],
      });

      const after = readBundle(bundlePath);
      expect(privateScalarFor(after.oidf.providerSites[keptSiteSlug])).toBe(preservedPrivateD);
      expect(privateScalarFor(after.oidf.providerSites[missingSiteSlug])).toBeString();
    } finally {
      cleanupBundlePath(bundlePath);
    }
  });

  test("ensureDemoCryptoBundle fills missing fixed roles and preserves stale provider-sites and ticket issuers", () => {
    const siteSlugs = FhirStore.load().listSiteSummaries().map((site) => site.siteSlug);
    const bundle = generateDemoCryptoBundle(siteSlugs, { issuerSlugs: ["reference-demo", "secondary-demo"] });
    delete (bundle.oidf as Record<string, unknown>).anchor;
    bundle.oidf.providerSites["stale-site"] = bundle.oidf.providerSites[siteSlugs[0]!]!;
    const bundlePath = writeBundle(bundle);
    try {
      const before = readBundle(bundlePath);
      const preservedSiteKey = privateScalarFor(before.oidf.providerSites[siteSlugs[0]!]!);
      const preservedSecondaryIssuerKey = privateScalarFor(before.ticketIssuers["secondary-demo"]!);

      ensureDemoCryptoBundle({
        bundlePath,
        siteSlugs,
        issuerSlugs: ["reference-demo"],
      });

      const after = readBundle(bundlePath);
      expect(privateScalarFor(after.oidf.anchor)).toBeString();
      expect(privateScalarFor(after.oidf.providerSites[siteSlugs[0]!]!)).toBe(preservedSiteKey);
      expect(after.oidf.providerSites["stale-site"]).toBeDefined();
      expect(privateScalarFor(after.ticketIssuers["secondary-demo"]!)).toBe(preservedSecondaryIssuerKey);
    } finally {
      cleanupBundlePath(bundlePath);
    }
  });

  test("bundle-backed startup auto-grows the lockfile and wires issuer, OIDF, well-known, and UDAP surfaces to bundle material", async () => {
    const siteSlugs = FhirStore.load().listSiteSummaries().map((site) => site.siteSlug);
    const bundlePath = writeBundle(generateDemoCryptoBundle(siteSlugs.slice(0, -1)));
    try {
      await withEnvAsync("DEMO_CRYPTO_BUNDLE_PATH", bundlePath, async () => {
        const context = createAppContext({ port: 0 });
        const grownBundle = readBundle(bundlePath);
        const server = startServer(context, 0);
        const origin = `http://127.0.0.1:${server.port}`;
        try {
          expect(grownBundle.oidf.providerSites[siteSlugs.at(-1)!]).toBeDefined();
          expect(context.issuers.get("reference-demo")?.publicJwk.x).toBe(context.config.demoCryptoBundle?.ticketIssuers["reference-demo"]?.publicJwk.x);
          expect(context.oidfTopology.entities.anchor.publicJwk.x).toBe(context.config.demoCryptoBundle?.oidf.anchor.publicJwk.x);
          expect(context.oidfTopology.providerSiteEntities[siteSlugs[0]!]!.publicJwk.x).toBe(
            context.config.demoCryptoBundle?.oidf.providerSites[siteSlugs[0]!]!.publicJwk.x,
          );

          const jwks = await fetch(`${origin}/.well-known/jwks.json`).then((response) => response.json() as Promise<{ keys: JsonWebKey[] }>);
          expect(jwks.keys[0]?.x).toBe(context.config.demoCryptoBundle?.wellKnown.default.publicJwk.x);

          const udapFramework = context.config.frameworks.find((framework) => framework.framework === DEFAULT_DEMO_UDAP_FRAMEWORK_URI);
          expect(udapFramework?.udap?.trustAnchors?.[0]).toBe(context.config.demoCryptoBundle?.udap.ec.caCertificatePem);
          expect(udapFramework?.udap?.trustAnchors?.[1]).toBe(context.config.demoCryptoBundle?.udap.rsa.caCertificatePem);
        } finally {
          server.stop(true);
        }
      });
    } finally {
      cleanupBundlePath(bundlePath);
    }
  });
});

function tempBundlePath() {
  const workspace = mkdtempSync(join(tmpdir(), "smart-permission-tickets-demo-crypto-"));
  return join(workspace, "bundle.json");
}

function writeBundle(bundle: DemoCryptoBundleDocument) {
  const bundlePath = tempBundlePath();
  writeFileSync(bundlePath, `${JSON.stringify(bundle, null, 2)}\n`, "utf8");
  return bundlePath;
}

function readBundleRaw(bundlePath: string) {
  return readFileSync(bundlePath, "utf8");
}

function readBundle(bundlePath: string) {
  return JSON.parse(readBundleRaw(bundlePath)) as DemoCryptoBundleDocument;
}

function privateScalarFor(entry: { privateJwk: JsonWebKey } | undefined) {
  return entry?.privateJwk.d;
}

function cleanupBundlePath(bundlePath: string) {
  rmSync(bundlePath, { force: true });
  rmSync(dirname(bundlePath), { recursive: true, force: true });
}

async function withEnvAsync(name: string, value: string, fn: () => Promise<void>) {
  const previous = Bun.env[name];
  Bun.env[name] = value;
  try {
    await fn();
  } finally {
    if (previous === undefined) delete Bun.env[name];
    else Bun.env[name] = previous;
  }
}
