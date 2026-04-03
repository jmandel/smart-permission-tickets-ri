export type EcPublicJwk = JsonWebKey & {
  kty: "EC";
  crv: "P-256";
  x: string;
  y: string;
  alg?: "ES256";
  use?: "sig";
  key_ops?: string[];
};

export type EcPrivateJwk = EcPublicJwk & {
  d: string;
};

export type ClientKeyMaterial = {
  publicJwk: EcPublicJwk;
  privateJwk: EcPrivateJwk;
  thumbprint: string;
};

export type JwtPayload = Record<string, any>;

export async function generateClientKeyMaterial(): Promise<ClientKeyMaterial> {
  const keyPair = await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"],
  );
  const publicJwk = normalizePublicJwk(
    (await crypto.subtle.exportKey("jwk", keyPair.publicKey)) as EcPublicJwk,
  );
  const privateJwk = normalizePrivateJwk(
    (await crypto.subtle.exportKey("jwk", keyPair.privateKey)) as EcPrivateJwk,
  );
  return {
    publicJwk,
    privateJwk,
    thumbprint: await computeJwkThumbprint(publicJwk),
  };
}

export async function computeJwkThumbprint(jwk: JsonWebKey): Promise<string> {
  if (jwk.kty !== "EC" || jwk.crv !== "P-256" || !jwk.x || !jwk.y) {
    throw new Error("Only EC P-256 JWKs are supported");
  }
  const canonical = JSON.stringify({
    crv: jwk.crv,
    kty: jwk.kty,
    x: jwk.x,
    y: jwk.y,
  });
  const digest = await crypto.subtle.digest("SHA-256", utf8(canonical));
  return base64UrlEncode(new Uint8Array(digest));
}

export async function signPrivateKeyJwt(
  payload: JwtPayload,
  privateJwk: JsonWebKey,
  extraHeader: Record<string, any> = {},
): Promise<string> {
  const header = { alg: "ES256", typ: "JWT", ...extraHeader };
  const encodedHeader = base64UrlEncodeJson(header);
  const encodedPayload = base64UrlEncodeJson(payload);
  const signingInput = `${encodedHeader}.${encodedPayload}`;
  const key = await crypto.subtle.importKey(
    "jwk",
    normalizePrivateJwk(privateJwk),
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    key,
    utf8(signingInput),
  );
  return `${signingInput}.${base64UrlEncode(new Uint8Array(signature))}`;
}

export async function verifyPrivateKeyJwt<T extends JwtPayload>(
  token: string,
  publicJwk: JsonWebKey,
): Promise<{ header: Record<string, any>; payload: T }> {
  const [encodedHeader, encodedPayload, encodedSignature] = token.split(".");
  if (!encodedHeader || !encodedPayload || !encodedSignature) throw new Error("Malformed JWT");
  const header = JSON.parse(utf8Decode(base64UrlDecode(encodedHeader))) as Record<string, any>;
  if (header.alg !== "ES256") throw new Error("Unsupported client assertion alg");
  const payload = JSON.parse(utf8Decode(base64UrlDecode(encodedPayload))) as T;
  const key = await crypto.subtle.importKey(
    "jwk",
    normalizePublicJwk(publicJwk),
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["verify"],
  );
  const ok = await crypto.subtle.verify(
    { name: "ECDSA", hash: "SHA-256" },
    key,
    base64UrlDecode(encodedSignature),
    utf8(`${encodedHeader}.${encodedPayload}`),
  );
  if (!ok) throw new Error("Invalid client assertion signature");
  return { header, payload };
}

export function decodeJwtWithoutVerification<T extends JwtPayload>(token: string): { header: Record<string, any>; payload: T } {
  const [encodedHeader, encodedPayload] = token.split(".");
  if (!encodedHeader || !encodedPayload) throw new Error("Malformed JWT");
  return {
    header: JSON.parse(utf8Decode(base64UrlDecode(encodedHeader))) as Record<string, any>,
    payload: JSON.parse(utf8Decode(base64UrlDecode(encodedPayload))) as T,
  };
}

export function normalizePublicJwk(jwk: JsonWebKey): EcPublicJwk {
  if (jwk.kty !== "EC" || jwk.crv !== "P-256" || !jwk.x || !jwk.y) throw new Error("Only EC P-256 JWKs are supported");
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
  if (jwk.kty !== "EC" || jwk.crv !== "P-256" || !jwk.x || !jwk.y || !jwk.d) throw new Error("Only EC P-256 private JWKs are supported");
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

function utf8(value: string) {
  return new TextEncoder().encode(value);
}

function utf8Decode(bytes: Uint8Array) {
  return new TextDecoder().decode(bytes);
}

function base64UrlEncodeJson(value: unknown) {
  return base64UrlEncode(utf8(JSON.stringify(value)));
}

function base64UrlEncode(bytes: Uint8Array) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function base64UrlDecode(value: string) {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  const binary = atob(padded);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}
