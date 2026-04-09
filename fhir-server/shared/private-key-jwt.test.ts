import { describe, expect, test } from "bun:test";

import {
  decodeJwtWithoutVerification,
  generateClientKeyMaterial,
  selectJwtVerificationCandidates,
  signPrivateKeyJwt,
} from "./private-key-jwt.ts";

describe("private-key-jwt helpers", () => {
  test("signPrivateKeyJwt emits kid by default for ES256 keys", async () => {
    const keyMaterial = await generateClientKeyMaterial();
    const token = await signPrivateKeyJwt({ iss: "client", sub: "client" }, keyMaterial.privateJwk);
    const { header } = selectJwtVerificationCandidates(token, [keyMaterial.publicJwk], {
      unknownKidMessage: "kid mismatch",
    });
    expect(header.kid).toBe(keyMaterial.thumbprint);
  });

  test("explicit caller-supplied kid wins over the default thumbprint kid", async () => {
    const keyMaterial = await generateClientKeyMaterial();
    const token = await signPrivateKeyJwt(
      { iss: "client", sub: "client" },
      keyMaterial.privateJwk,
      { kid: "custom-kid" },
    );
    const { header } = decodeJwtWithoutVerification(token);
    expect(header.kid).toBe("custom-kid");
  });

  test("kid selection falls back to all candidates when the key set has no kid values", async () => {
    const keyMaterial = await generateClientKeyMaterial();
    const token = await signPrivateKeyJwt({ iss: "client", sub: "client" }, keyMaterial.privateJwk);
    const { candidateJwks } = selectJwtVerificationCandidates(token, [
      {
        ...keyMaterial.publicJwk,
        kid: undefined,
      },
    ], {
      unknownKidMessage: "kid mismatch",
    });
    expect(candidateJwks).toHaveLength(1);
  });

  test("generated client key material carries thumbprint kid values on both JWKs", async () => {
    const keyMaterial = await generateClientKeyMaterial();
    expect(keyMaterial.publicJwk.kid).toBe(keyMaterial.thumbprint);
    expect(keyMaterial.privateJwk.kid).toBe(keyMaterial.thumbprint);
  });

  test("kid selection narrows to the matching candidate when keyed JWKs are available", async () => {
    const first = await generateClientKeyMaterial();
    const second = await generateClientKeyMaterial();
    const token = await signPrivateKeyJwt({ iss: "client", sub: "client" }, second.privateJwk);
    const { candidateJwks } = selectJwtVerificationCandidates(token, [
      { ...first.publicJwk, kid: first.thumbprint },
      { ...second.publicJwk, kid: second.thumbprint },
    ], {
      unknownKidMessage: "kid mismatch",
    });
    expect(candidateJwks).toEqual([{ ...second.publicJwk, kid: second.thumbprint }]);
  });
});
