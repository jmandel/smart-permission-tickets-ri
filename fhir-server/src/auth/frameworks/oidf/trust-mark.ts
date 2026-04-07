import { decodeJwtWithoutVerification, verifyPrivateKeyJwt } from "../../../../shared/private-key-jwt.ts";

export const TRUST_MARK_TYP = "trust-mark+jwt";
export const ACCEPTED_TRUST_MARK_ALGS = ["ES256"] as const;

const CLOCK_SKEW_SECONDS = 60;

export type TrustMarkPayload = {
  iss: string;
  sub: string;
  iat: number;
  exp: number;
  trust_mark_type: string;
  [key: string]: unknown;
};

export async function verifyTrustMark(
  jwt: string,
  options: {
    issuerEntityId: string;
    subjectEntityId: string;
    expectedTrustMarkType: string;
    issuerJwks: JsonWebKey[];
    nowSeconds?: number;
  },
) {
  const nowSeconds = options.nowSeconds ?? Math.floor(Date.now() / 1000);
  const decoded = decodeJwtWithoutVerification<TrustMarkPayload>(jwt);
  if (decoded.header.typ !== TRUST_MARK_TYP) {
    throw new Error(`OIDF trust mark must use typ=${TRUST_MARK_TYP}`);
  }
  if (!ACCEPTED_TRUST_MARK_ALGS.includes(decoded.header.alg)) {
    throw new Error(`OIDF trust mark uses unsupported alg ${String(decoded.header.alg ?? "")}`);
  }

  const payload = decoded.payload;
  if (typeof payload.iss !== "string" || !payload.iss) {
    throw new Error("OIDF trust mark is missing iss");
  }
  if (typeof payload.sub !== "string" || !payload.sub) {
    throw new Error("OIDF trust mark is missing sub");
  }
  if (typeof payload.iat !== "number") {
    throw new Error("OIDF trust mark is missing iat");
  }
  if (typeof payload.exp !== "number") {
    throw new Error("OIDF trust mark is missing exp");
  }
  if (typeof payload.trust_mark_type !== "string" || !payload.trust_mark_type) {
    throw new Error("OIDF trust mark is missing trust_mark_type");
  }
  if (payload.iss !== options.issuerEntityId) {
    throw new Error(`OIDF trust mark issuer ${payload.iss} does not match ${options.issuerEntityId}`);
  }
  if (payload.sub !== options.subjectEntityId) {
    throw new Error(`OIDF trust mark subject ${payload.sub} does not match ${options.subjectEntityId}`);
  }
  if (payload.trust_mark_type !== options.expectedTrustMarkType) {
    throw new Error(`OIDF trust mark type ${payload.trust_mark_type} does not match ${options.expectedTrustMarkType}`);
  }
  if (payload.iat > nowSeconds + CLOCK_SKEW_SECONDS) {
    throw new Error("OIDF trust mark has an iat in the future");
  }
  if (payload.exp <= nowSeconds - CLOCK_SKEW_SECONDS) {
    throw new Error("OIDF trust mark has expired");
  }

  let lastError: Error | null = null;
  for (const key of options.issuerJwks) {
    try {
      await verifyPrivateKeyJwt(jwt, key);
      return {
        header: decoded.header,
        payload,
      };
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
    }
  }

  throw new Error(`OIDF trust mark signature verification failed: ${lastError?.message ?? "no key matched"}`);
}
