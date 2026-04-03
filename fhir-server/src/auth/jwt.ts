import { createHmac, timingSafeEqual } from "node:crypto";

export type JwtHeader = {
  alg: "HS256";
  typ: "JWT";
  [key: string]: any;
};

export function signJwt(payload: Record<string, any>, secret: string, extraHeader: Record<string, any> = {}) {
  const header: JwtHeader = { alg: "HS256", typ: "JWT", ...extraHeader };
  const encodedHeader = base64url(JSON.stringify(header));
  const encodedPayload = base64url(JSON.stringify(payload));
  const signingInput = `${encodedHeader}.${encodedPayload}`;
  const signature = sign(signingInput, secret);
  return `${signingInput}.${signature}`;
}

export function verifyJwt<T>(token: string, secret: string): { header: JwtHeader; payload: T } {
  const [encodedHeader, encodedPayload, signature] = token.split(".");
  if (!encodedHeader || !encodedPayload || !signature) throw new Error("Malformed JWT");
  const signingInput = `${encodedHeader}.${encodedPayload}`;
  const expected = sign(signingInput, secret);
  if (!safeEqual(signature, expected)) throw new Error("Invalid JWT signature");
  const header = JSON.parse(Buffer.from(encodedHeader, "base64url").toString("utf8")) as JwtHeader;
  if (header.alg !== "HS256") throw new Error("Unsupported JWT alg");
  const payload = JSON.parse(Buffer.from(encodedPayload, "base64url").toString("utf8")) as T;
  return { header, payload };
}

export function decodeJwt<T>(token: string): { header: JwtHeader; payload: T } {
  const [encodedHeader, encodedPayload] = token.split(".");
  if (!encodedHeader || !encodedPayload) throw new Error("Malformed JWT");
  return {
    header: JSON.parse(Buffer.from(encodedHeader, "base64url").toString("utf8")) as JwtHeader,
    payload: JSON.parse(Buffer.from(encodedPayload, "base64url").toString("utf8")) as T,
  };
}

function sign(input: string, secret: string) {
  return createHmac("sha256", secret).update(input).digest("base64url");
}

function safeEqual(left: string, right: string) {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  if (leftBuffer.length !== rightBuffer.length) return false;
  return timingSafeEqual(leftBuffer, rightBuffer);
}

function base64url(value: string) {
  return Buffer.from(value, "utf8").toString("base64url");
}
