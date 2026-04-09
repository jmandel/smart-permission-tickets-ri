import { describe, expect, test } from "bun:test";

import { extractOidfOauthClientPublicJwks } from "./oauth-client-keys.ts";

describe("extractOidfOauthClientPublicJwks", () => {
  test("returns normalized oauth_client jwks when present", () => {
    const keys = extractOidfOauthClientPublicJwks({
      oauth_client: {
        jwks: {
          keys: [
            {
              kty: "EC",
              crv: "P-256",
              x: "aIPj1kY8r5eVaVB57CMyU3XraRf_gpMI-5D4yECK26k",
              y: "tXrlRRr2-XeuYoqfj7clF14Av6HR5uyrgp0BYrDEvdw",
              kid: "oauth-key-1",
            },
          ],
        },
      },
    });

    expect(keys).toEqual([
      {
        kty: "EC",
        crv: "P-256",
        x: "aIPj1kY8r5eVaVB57CMyU3XraRf_gpMI-5D4yECK26k",
        y: "tXrlRRr2-XeuYoqfj7clF14Av6HR5uyrgp0BYrDEvdw",
        alg: "ES256",
        use: "sig",
        key_ops: ["verify"],
        kid: "oauth-key-1",
      },
    ]);
  });

  test("rejects missing oauth_client metadata", () => {
    expect(() => extractOidfOauthClientPublicJwks({})).toThrow("oidf_oauth_client_metadata_missing");
  });

  test("rejects empty oauth_client.jwks.keys", () => {
    expect(() => extractOidfOauthClientPublicJwks({
      oauth_client: {
        jwks: {
          keys: [],
        },
      },
    })).toThrow("oidf_oauth_client_jwks_missing");
  });

  test("rejects oauth_client.jwks keys without kid", () => {
    expect(() => extractOidfOauthClientPublicJwks({
      oauth_client: {
        jwks: {
          keys: [
            {
              kty: "EC",
              crv: "P-256",
              x: "aIPj1kY8r5eVaVB57CMyU3XraRf_gpMI-5D4yECK26k",
              y: "tXrlRRr2-XeuYoqfj7clF14Av6HR5uyrgp0BYrDEvdw",
            },
          ],
        },
      },
    })).toThrow("oidf_oauth_client_jwks_kid_missing");
  });

  test("rejects duplicate oauth_client.jwks kid values", () => {
    expect(() => extractOidfOauthClientPublicJwks({
      oauth_client: {
        jwks: {
          keys: [
            {
              kty: "EC",
              crv: "P-256",
              x: "aIPj1kY8r5eVaVB57CMyU3XraRf_gpMI-5D4yECK26k",
              y: "tXrlRRr2-XeuYoqfj7clF14Av6HR5uyrgp0BYrDEvdw",
              kid: "duplicate",
            },
            {
              kty: "EC",
              crv: "P-256",
              x: "G_bGcRe90WoD5N-oGXdAm2YLyN21eRYzb_aCGw3jqPU",
              y: "QJydAGOfWweSiqtHTW83sMY5BO_UmlMIy8yz8iuGibw",
              kid: "duplicate",
            },
          ],
        },
      },
    })).toThrow("oidf_oauth_client_jwks_duplicate_kid");
  });

  test("rejects invalid oauth_client.jwks keys", () => {
    expect(() => extractOidfOauthClientPublicJwks({
      oauth_client: {
        jwks: {
          keys: [
            {
              kty: "RSA",
              kid: "oauth-key-1",
            },
          ],
        },
      },
    })).toThrow("oidf_oauth_client_jwks_invalid_key");
  });

  test("rejects oauth_client.jwks_uri in first pass", () => {
    expect(() => extractOidfOauthClientPublicJwks({
      oauth_client: {
        jwks_uri: "https://example.org/jwks.json",
      },
    })).toThrow("oidf_oauth_client_jwks_uri_unsupported");
  });

  test("rejects oauth_client.signed_jwks_uri in first pass", () => {
    expect(() => extractOidfOauthClientPublicJwks({
      oauth_client: {
        signed_jwks_uri: "https://example.org/jwks.jwt",
      },
    })).toThrow("oidf_oauth_client_signed_jwks_uri_unsupported");
  });
});
