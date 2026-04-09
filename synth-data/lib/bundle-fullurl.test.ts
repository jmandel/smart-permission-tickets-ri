import { describe, expect, test } from "bun:test";

import {
  buildBundle,
  bundleEntryUuidForResourceId,
  normalizeBundleEntryFullUrls,
} from "./bundle-fullurl.ts";

describe("bundle fullUrl helpers", () => {
  test("preserves real UUID resource ids in Bundle.entry.fullUrl", () => {
    const bundle = buildBundle([{ resourceType: "Patient", id: "123e4567-e89b-12d3-a456-426614174000" }]);
    expect(bundle.entry[0].fullUrl).toBe("urn:uuid:123e4567-e89b-12d3-a456-426614174000");
  });

  test("deterministically maps non-UUID resource ids to UUID-shaped fullUrls", () => {
    const first = bundleEntryUuidForResourceId("enc-000-note");
    const second = bundleEntryUuidForResourceId("enc-000-note");

    expect(first).toBe(second);
    expect(first).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });

  test("normalizes legacy bundle entries in place", () => {
    const bundle = {
      resourceType: "Bundle",
      entry: [
        {
          fullUrl: "urn:uuid:enc-000-note",
          resource: { resourceType: "DocumentReference", id: "enc-000-note" },
        },
      ],
    };

    const result = normalizeBundleEntryFullUrls(bundle);

    expect(result.changedEntries).toBe(1);
    expect(bundle.entry[0].fullUrl).toMatch(/^urn:uuid:[0-9a-f-]{36}$/);
  });
});
