import { describe, expect, test } from "bun:test";

import { normalizeWellKnownEntityUri } from "./well-known.ts";

describe("well-known entity normalization", () => {
  test("allows secure local origins with subpaths and removes trailing slash", () => {
    expect(normalizeWellKnownEntityUri("http://127.0.0.1:9000/demo/client-a/")).toBe("http://127.0.0.1:9000/demo/client-a");
  });

  test("allows https entity URIs unchanged except for hash and query removal", () => {
    expect(normalizeWellKnownEntityUri("https://clinic.example.com/app?ignored=1#fragment")).toBe("https://clinic.example.com/app");
  });

  test("rejects insecure non-local http origins", () => {
    expect(() => normalizeWellKnownEntityUri("http://clinic.example.com/app")).toThrow("well-known entities must use HTTPS or a secure local origin");
  });
});
