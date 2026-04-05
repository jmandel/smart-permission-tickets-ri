import { createPrivateKey, sign, verify, type KeyObject, X509Certificate } from "node:crypto";

export type X509JwtAlg = "ES256" | "RS256";

export type X509JwtHeader = {
  alg: X509JwtAlg;
  typ: "JWT";
  x5c?: string[];
  [key: string]: any;
};

export function signX509JwtWithPem(
  payload: Record<string, any>,
  privateKeyPem: string,
  alg: X509JwtAlg,
  extraHeader: Record<string, any> = {},
) {
  const header: X509JwtHeader = { alg, typ: "JWT", ...extraHeader };
  const encodedHeader = base64url(JSON.stringify(header));
  const encodedPayload = base64url(JSON.stringify(payload));
  const signingInput = `${encodedHeader}.${encodedPayload}`;
  const key = createPrivateKey(privateKeyPem);
  const signature = alg === "ES256"
    ? sign("sha256", Buffer.from(signingInput, "utf8"), { key, dsaEncoding: "ieee-p1363" })
    : sign("RSA-SHA256", Buffer.from(signingInput, "utf8"), key);
  return `${signingInput}.${signature.toString("base64url")}`;
}

export function signEs256JwtWithPem(
  payload: Record<string, any>,
  privateKeyPem: string,
  extraHeader: Record<string, any> = {},
) {
  return signX509JwtWithPem(payload, privateKeyPem, "ES256", extraHeader);
}

export function signRs256JwtWithPem(
  payload: Record<string, any>,
  privateKeyPem: string,
  extraHeader: Record<string, any> = {},
) {
  return signX509JwtWithPem(payload, privateKeyPem, "RS256", extraHeader);
}

export function verifyX509JwtWithKey<T>(
  token: string,
  publicKey: KeyObject,
): { header: X509JwtHeader; payload: T } {
  const { header, payload, signingInput, signature } = decodeJwtParts<T>(token);
  if (header.alg !== "ES256" && header.alg !== "RS256") throw new Error("Unsupported JWT alg");
  const ok = header.alg === "ES256"
    ? verify("sha256", Buffer.from(signingInput, "utf8"), { key: publicKey, dsaEncoding: "ieee-p1363" }, signature)
    : verify("RSA-SHA256", Buffer.from(signingInput, "utf8"), publicKey, signature);
  if (!ok) throw new Error("Invalid JWT signature");
  return { header, payload };
}

export function verifyEs256JwtWithKey<T>(
  token: string,
  publicKey: KeyObject,
): { header: X509JwtHeader; payload: T } {
  const verified = verifyX509JwtWithKey<T>(token, publicKey);
  if (verified.header.alg !== "ES256") throw new Error("Unsupported JWT alg");
  return verified;
}

export function decodeJwtWithoutVerification<T>(token: string): { header: X509JwtHeader; payload: T } {
  const { header, payload } = decodeJwtParts<T>(token);
  return { header, payload };
}

export function parseX5cCertificates(x5c: unknown): X509Certificate[] {
  if (!Array.isArray(x5c) || x5c.length === 0) throw new Error("x5c header missing");
  return x5c.map((entry) => {
    if (typeof entry !== "string" || !entry.trim()) throw new Error("x5c header entry must be a non-empty string");
    return new X509Certificate(Buffer.from(entry, "base64"));
  });
}

export function extractUriSans(cert: X509Certificate) {
  const raw = cert.subjectAltName ?? "";
  if (!raw.trim()) return [];
  return raw
    .split(/,\s*/)
    .map((entry) => entry.trim())
    .filter((entry) => entry.startsWith("URI:"))
    .map((entry) => entry.slice("URI:".length));
}

export function pemToDerBase64(pem: string) {
  return pem
    .replace(/-----BEGIN CERTIFICATE-----/g, "")
    .replace(/-----END CERTIFICATE-----/g, "")
    .replace(/\s+/g, "");
}

function decodeJwtParts<T>(token: string) {
  const [encodedHeader, encodedPayload, encodedSignature] = token.split(".");
  if (!encodedHeader || !encodedPayload || !encodedSignature) throw new Error("Malformed JWT");
  return {
    header: JSON.parse(Buffer.from(encodedHeader, "base64url").toString("utf8")) as X509JwtHeader,
    payload: JSON.parse(Buffer.from(encodedPayload, "base64url").toString("utf8")) as T,
    signingInput: `${encodedHeader}.${encodedPayload}`,
    signature: Buffer.from(encodedSignature, "base64url"),
  };
}

function base64url(value: string) {
  return Buffer.from(value, "utf8").toString("base64url");
}
