import { describe, expect, test } from "bun:test";

import { generateClientKeyMaterial, signPrivateKeyJwt } from "../../../../shared/private-key-jwt.ts";
import { TRUST_MARK_TYP, verifyTrustMark } from "./trust-mark.ts";

describe("OIDF trust mark validation", () => {
  test("missing header kid is rejected", async () => {
    const issuerKeys = await generateKeyFixture();
    const trustMark = await signPrivateKeyJwt({
      iss: "https://demo.example/federation/trust-mark-issuer",
      sub: "https://demo.example/federation/leafs/demo-app",
      iat: Math.floor(Date.now() / 1000) - 60,
      exp: Math.floor(Date.now() / 1000) + 3600,
      trust_mark_type: "https://demo.example/trust-marks/demo",
    }, issuerKeys.privateJwk, {
      typ: TRUST_MARK_TYP,
      kid: undefined,
    });

    await expect(verifyTrustMark(trustMark, {
      issuerEntityId: "https://demo.example/federation/trust-mark-issuer",
      subjectEntityId: "https://demo.example/federation/leafs/demo-app",
      expectedTrustMarkType: "https://demo.example/trust-marks/demo",
      issuerJwks: [issuerKeys.publicJwk],
    })).rejects.toThrow("header kid");
  });

  test("kid mismatch against issuer jwks is rejected", async () => {
    const issuerKeys = await generateKeyFixture();
    const trustMark = await signPrivateKeyJwt({
      iss: "https://demo.example/federation/trust-mark-issuer",
      sub: "https://demo.example/federation/leafs/demo-app",
      iat: Math.floor(Date.now() / 1000) - 60,
      exp: Math.floor(Date.now() / 1000) + 3600,
      trust_mark_type: "https://demo.example/trust-marks/demo",
    }, issuerKeys.privateJwk, {
      typ: TRUST_MARK_TYP,
      kid: "missing-issuer-key",
    });

    await expect(verifyTrustMark(trustMark, {
      issuerEntityId: "https://demo.example/federation/trust-mark-issuer",
      subjectEntityId: "https://demo.example/federation/leafs/demo-app",
      expectedTrustMarkType: "https://demo.example/trust-marks/demo",
      issuerJwks: [issuerKeys.publicJwk],
    })).rejects.toThrow("kid");
  });

  test("delegated trust marks fail with an explicit unsupported error", async () => {
    const issuerKeys = await generateKeyFixture();
    const trustMark = await signPrivateKeyJwt({
      iss: "https://demo.example/federation/trust-mark-issuer",
      sub: "https://demo.example/federation/leafs/demo-app",
      iat: Math.floor(Date.now() / 1000) - 60,
      exp: Math.floor(Date.now() / 1000) + 3600,
      trust_mark_type: "https://demo.example/trust-marks/demo",
      delegation: "eyJhbGciOiJFUzI1NiJ9.e30.signature",
    }, issuerKeys.privateJwk, {
      typ: TRUST_MARK_TYP,
      kid: issuerKeys.privateJwk.kid,
    });

    await expect(verifyTrustMark(trustMark, {
      issuerEntityId: "https://demo.example/federation/trust-mark-issuer",
      subjectEntityId: "https://demo.example/federation/leafs/demo-app",
      expectedTrustMarkType: "https://demo.example/trust-marks/demo",
      issuerJwks: [issuerKeys.publicJwk],
    })).rejects.toThrow("delegat");
  });
});

async function generateKeyFixture() {
  const keyMaterial = await generateClientKeyMaterial();
  return {
    publicJwk: {
      ...keyMaterial.publicJwk,
      kid: keyMaterial.thumbprint,
    } satisfies JsonWebKey & { kid: string },
    privateJwk: {
      ...keyMaterial.privateJwk,
      kid: keyMaterial.thumbprint,
    } satisfies JsonWebKey & { kid: string },
  };
}
