import { createHash, createPrivateKey, createPublicKey, sign, verify } from "node:crypto";

export type Es256JwtHeader = {
  alg: "ES256";
  typ: "JWT";
  kid?: string;
  [key: string]: any;
};

type EcPublicJwk = JsonWebKey & {
  kty: "EC";
  crv: "P-256";
  x: string;
  y: string;
};

type EcPrivateJwk = EcPublicJwk & {
  d: string;
};

export function signEs256Jwt(payload: Record<string, any>, privateJwk: JsonWebKey, extraHeader: Record<string, any> = {}) {
  const header: Es256JwtHeader = { alg: "ES256", typ: "JWT", ...extraHeader };
  const encodedHeader = base64url(JSON.stringify(header));
  const encodedPayload = base64url(JSON.stringify(payload));
  const signingInput = `${encodedHeader}.${encodedPayload}`;
  const key = createPrivateKey({ key: normalizePrivateJwk(privateJwk), format: "jwk" });
  const signature = sign("sha256", Buffer.from(signingInput, "utf8"), { key, dsaEncoding: "ieee-p1363" });
  return `${signingInput}.${signature.toString("base64url")}`;
}

export function verifyEs256Jwt<T>(token: string, publicJwk: JsonWebKey): { header: Es256JwtHeader; payload: T } {
  const { header, payload, signingInput, signature } = decodeJwtParts<T>(token);
  if (header.alg !== "ES256") throw new Error("Unsupported JWT alg");
  const key = createPublicKey({ key: normalizePublicJwk(publicJwk), format: "jwk" });
  const ok = verify("sha256", Buffer.from(signingInput, "utf8"), { key, dsaEncoding: "ieee-p1363" }, signature);
  if (!ok) throw new Error("Invalid JWT signature");
  return { header, payload };
}

export function decodeEs256Jwt<T>(token: string): { header: Es256JwtHeader; payload: T } {
  const { header, payload } = decodeJwtParts<T>(token);
  return { header, payload };
}

export function derivePublicJwk(privateJwk: JsonWebKey) {
  const key = createPrivateKey({ key: normalizePrivateJwk(privateJwk), format: "jwk" });
  const publicKey = createPublicKey(key);
  return normalizePublicJwk(publicKey.export({ format: "jwk" }) as JsonWebKey);
}

export function computeEcJwkThumbprintSync(jwk: JsonWebKey) {
  const publicJwk = normalizePublicJwk(jwk);
  const canonical = JSON.stringify({
    crv: publicJwk.crv,
    kty: publicJwk.kty,
    x: publicJwk.x,
    y: publicJwk.y,
  });
  return createHash("sha256").update(canonical).digest("base64url");
}

export function normalizePublicJwk(jwk: JsonWebKey): EcPublicJwk {
  if (jwk.kty !== "EC" || jwk.crv !== "P-256" || !jwk.x || !jwk.y) {
    throw new Error("Only EC P-256 public JWKs are supported");
  }
  return {
    kty: "EC",
    crv: "P-256",
    x: jwk.x,
    y: jwk.y,
    alg: "ES256",
    use: "sig",
    key_ops: ["verify"],
  };
}

export function normalizePrivateJwk(jwk: JsonWebKey): EcPrivateJwk {
  if (jwk.kty !== "EC" || jwk.crv !== "P-256" || !jwk.x || !jwk.y || !jwk.d) {
    throw new Error("Only EC P-256 private JWKs are supported");
  }
  return {
    kty: "EC",
    crv: "P-256",
    x: jwk.x,
    y: jwk.y,
    d: jwk.d,
    alg: "ES256",
    use: "sig",
    key_ops: ["sign"],
  };
}

function decodeJwtParts<T>(token: string) {
  const [encodedHeader, encodedPayload, encodedSignature] = token.split(".");
  if (!encodedHeader || !encodedPayload || !encodedSignature) throw new Error("Malformed JWT");
  return {
    header: JSON.parse(Buffer.from(encodedHeader, "base64url").toString("utf8")) as Es256JwtHeader,
    payload: JSON.parse(Buffer.from(encodedPayload, "base64url").toString("utf8")) as T,
    signingInput: `${encodedHeader}.${encodedPayload}`,
    signature: Buffer.from(encodedSignature, "base64url"),
  };
}

function base64url(value: string) {
  return Buffer.from(value, "utf8").toString("base64url");
}
