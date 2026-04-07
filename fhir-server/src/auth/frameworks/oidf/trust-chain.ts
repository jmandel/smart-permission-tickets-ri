import { decodeJwtWithoutVerification, normalizePublicJwk, verifyPrivateKeyJwt } from "../../../../shared/private-key-jwt.ts";

export const ENTITY_STATEMENT_TYP = "entity-statement+jwt";
export const ACCEPTED_ENTITY_STATEMENT_ALGS = ["ES256"] as const;

const CLOCK_SKEW_SECONDS = 60;
const MAX_ENTITY_DEPTH = 3;
const MAX_CHAIN_LENGTH = MAX_ENTITY_DEPTH + 1;

export type EntityStatementAlg = (typeof ACCEPTED_ENTITY_STATEMENT_ALGS)[number];

export type EntityStatementHeader = {
  alg: EntityStatementAlg;
  typ: typeof ENTITY_STATEMENT_TYP;
  kid?: string;
  [key: string]: unknown;
};

export type EntityMetadata = Record<string, Record<string, unknown>>;
export type EntityMetadataPolicy = Record<string, Record<string, Record<string, unknown>>>;

export type EntityStatementPayload = {
  iss: string;
  sub: string;
  iat: number;
  exp: number;
  jwks?: { keys: JsonWebKey[] };
  metadata?: EntityMetadata;
  metadata_policy?: EntityMetadataPolicy;
  authority_hints?: string[];
  trust_marks?: string[];
  [key: string]: unknown;
};

export type ParsedEntityStatement = {
  jwt: string;
  position: number;
  kind: "entity-configuration" | "subordinate-statement";
  header: EntityStatementHeader;
  payload: EntityStatementPayload;
  entityId: string;
  signerEntityId: string;
};

export type VerifiedTrustChain = {
  expectedAnchor: string;
  depth: number;
  statements: ParsedEntityStatement[];
  subordinateStatements: ParsedEntityStatement[];
  leaf: ParsedEntityStatement;
  anchor: ParsedEntityStatement;
  leafMetadata: EntityMetadata;
  /**
   * Ordered from closest-to-leaf upward.
   * Consumers that apply policy top-down per OIDF 6.1.4.2 must reverse this list.
   */
  metadataPolicies: Array<{
    issuer: string;
    subject: string;
    metadataPolicy: EntityMetadataPolicy;
  }>;
};

export async function verifyTrustChain(
  chain: string[],
  options: {
    expectedAnchor: string;
    trustedAnchorJwks: JsonWebKey[];
    supplementalEntityConfigurations?: string[];
    nowSeconds?: number;
  },
): Promise<VerifiedTrustChain> {
  const nowSeconds = options.nowSeconds ?? Math.floor(Date.now() / 1000);
  if (!Array.isArray(chain) || chain.length === 0) {
    throw new Error("OIDF trust chain must be a non-empty array of entity statements");
  }
  if (chain.length === 2 || chain.length > MAX_CHAIN_LENGTH) {
    throw new Error(`OIDF trust chain exceeds the supported depth of ${MAX_ENTITY_DEPTH}`);
  }

  const statements = chain.map((jwt, position) => parseEntityStatement(jwt, position, nowSeconds));
  const depth = chain.length === 1 ? 1 : chain.length - 1;
  const leaf = statements[0];
  const anchor = statements[statements.length - 1];
  if (leaf.kind !== "entity-configuration") {
    throw new Error("OIDF trust chain must begin with an entity configuration");
  }
  if (anchor.kind !== "entity-configuration") {
    throw new Error("OIDF trust chain must end with the trust anchor entity configuration");
  }
  if (anchor.entityId !== options.expectedAnchor) {
    throw new Error(`OIDF trust chain terminates at ${anchor.entityId}, expected ${options.expectedAnchor}`);
  }

  const subordinateStatements = statements.slice(1, -1);
  if (subordinateStatements.some((statement) => statement.kind !== "subordinate-statement")) {
    throw new Error("OIDF trust chain may only contain subordinate statements between the leaf and trust anchor");
  }

  await verifyEntityStatementSignature(leaf, requiredJwks(leaf));
  for (let index = 0; index < statements.length - 1; index += 1) {
    const statement = statements[index];
    const signer = statements[index + 1];
    await verifyEntityStatementSignature(statement, requiredJwks(signer));
  }
  await verifyEntityStatementSignature(anchor, options.trustedAnchorJwks.map((jwk) => normalizePublicJwk(jwk)));

  const supplementalConfigurations = parseSupplementalEntityConfigurations(
    options.supplementalEntityConfigurations ?? [],
    nowSeconds,
  );
  for (const [index, subordinate] of subordinateStatements.entries()) {
    const expectedSubjectEntityId = index === 0 ? leaf.entityId : subordinateStatements[index - 1]?.payload.iss;
    if (subordinate.payload.sub !== expectedSubjectEntityId) {
      throw new Error(`Subordinate statement ${subordinate.position} must target ${expectedSubjectEntityId}`);
    }
    const subjectConfiguration = subordinate.payload.sub === leaf.entityId
      ? leaf
      : subordinate.payload.sub === anchor.entityId
      ? anchor
      : supplementalConfigurations.get(subordinate.payload.sub);
    if (!subjectConfiguration) {
      throw new Error(`OIDF trust chain is missing the subject entity configuration for ${subordinate.payload.sub}`);
    }
    const authorityHints = subjectConfiguration.payload.authority_hints ?? [];
    if (!authorityHints.includes(subordinate.payload.iss)) {
      throw new Error(`Entity configuration ${subjectConfiguration.entityId} does not name ${subordinate.payload.iss} in authority_hints`);
    }
  }

  const metadataPolicies = subordinateStatements
    .filter((statement) => statement.payload.metadata_policy)
    .map((statement) => ({
      issuer: statement.payload.iss,
      subject: statement.payload.sub,
      metadataPolicy: statement.payload.metadata_policy ?? {},
    }));

  return {
    expectedAnchor: options.expectedAnchor,
    depth,
    statements,
    subordinateStatements,
    leaf,
    anchor,
    leafMetadata: leaf.payload.metadata ?? {},
    metadataPolicies,
  };
}

function parseEntityStatement(jwt: string, position: number, nowSeconds: number): ParsedEntityStatement {
  let decoded: { header: Record<string, unknown>; payload: Record<string, unknown> };
  try {
    decoded = decodeJwtWithoutVerification<Record<string, unknown>>(jwt);
  } catch (error) {
    throw new Error(`Malformed entity statement at position ${position}: ${formatError(error)}`);
  }

  const header = decoded.header as Partial<EntityStatementHeader>;
  if (header.typ !== ENTITY_STATEMENT_TYP) {
    throw new Error(`Entity statement ${position} must use typ=${ENTITY_STATEMENT_TYP}`);
  }
  if (header.alg !== "ES256") {
    throw new Error(`Entity statement ${position} uses unsupported alg ${String(header.alg ?? "")}`);
  }

  const payload = decoded.payload as Partial<EntityStatementPayload>;
  if (typeof payload.iss !== "string" || !payload.iss) {
    throw new Error(`Entity statement ${position} is missing iss`);
  }
  if (typeof payload.sub !== "string" || !payload.sub) {
    throw new Error(`Entity statement ${position} is missing sub`);
  }
  if (typeof payload.iat !== "number") {
    throw new Error(`Entity statement ${position} is missing iat`);
  }
  if (typeof payload.exp !== "number") {
    throw new Error(`Entity statement ${position} is missing exp`);
  }
  if (payload.iat > nowSeconds + CLOCK_SKEW_SECONDS) {
    throw new Error(`Entity statement ${position} has an iat in the future`);
  }
  if (payload.exp <= nowSeconds - CLOCK_SKEW_SECONDS) {
    throw new Error(`Entity statement ${position} has expired`);
  }

  const kind = payload.iss === payload.sub ? "entity-configuration" : "subordinate-statement";
  const statement: ParsedEntityStatement = {
    jwt,
    position,
    kind,
    header: header as EntityStatementHeader,
    payload: payload as EntityStatementPayload,
    entityId: payload.sub,
    signerEntityId: payload.iss,
  };
  requiredJwks(statement);
  return statement;
}

function requiredJwks(statement: ParsedEntityStatement) {
  const jwks = statement.payload.jwks?.keys;
  if (!Array.isArray(jwks) || jwks.length === 0) {
    throw new Error(`Entity statement ${statement.position} is missing jwks`);
  }
  return jwks.map((jwk) => normalizePublicJwk(jwk));
}

async function verifyEntityStatementSignature(statement: ParsedEntityStatement, keys: JsonWebKey[]) {
  let lastError: Error | null = null;
  for (const key of keys) {
    try {
      await verifyPrivateKeyJwt(statement.jwt, key);
      return;
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
    }
  }
  throw new Error(
    `Entity statement ${statement.position} signature verification failed: ${lastError?.message ?? "no key matched"}`,
  );
}

function formatError(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function parseSupplementalEntityConfigurations(entityConfigurations: string[], nowSeconds: number) {
  const map = new Map<string, ParsedEntityStatement>();
  for (const [index, jwt] of entityConfigurations.entries()) {
    const parsed = parseEntityStatement(jwt, MAX_CHAIN_LENGTH + index, nowSeconds);
    if (parsed.kind !== "entity-configuration") {
      throw new Error(`OIDF supplemental entity statement ${parsed.position} must be an entity configuration`);
    }
    map.set(parsed.entityId, parsed);
  }
  return map;
}
