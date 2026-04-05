import { describe, expect, test } from "bun:test";

import { TtlReplayCache } from "./replay-cache.ts";

describe("TTL replay cache", () => {
  test("rejects replay until the entry expires", () => {
    let nowMs = 1_000;
    const cache = new TtlReplayCache(() => nowMs);

    expect(cache.consume("udap-dcr|client-a|nonce-1", 2)).toBe(true);
    expect(cache.consume("udap-dcr|client-a|nonce-1", 2)).toBe(false);

    nowMs = 2_100;
    expect(cache.consume("udap-dcr|client-a|nonce-1", 2)).toBe(true);
  });

  test("evicts expired entries while tracking newer ones", () => {
    let nowMs = 1_000;
    const cache = new TtlReplayCache(() => nowMs);

    expect(cache.consume("k1", 2)).toBe(true);
    expect(cache.consume("k2", 5)).toBe(true);
    expect(cache.size()).toBe(2);

    nowMs = 2_100;
    expect(cache.size()).toBe(1);
    expect(cache.consume("k2", 5)).toBe(false);
  });
});
