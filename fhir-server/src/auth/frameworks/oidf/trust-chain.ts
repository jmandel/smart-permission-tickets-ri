import { decodeJwtWithoutVerification, normalizePublicJwk, verifyPrivateKeyJwt } from "../../../../shared/private-key-jwt.ts";

export const ENTITY_STATEMENT_TYP = "entity-statement+jwt";
export const ACCEPTED_ENTITY_STATEMENT_ALGS = ["ES256"] as const;

const CLOCK_SKEW_SECONDS = 60;
const MAX_ENTITY_DEPTH = 3;

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
  entityConfigurations: ParsedEntityStatement[];
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
  expectedAnchor: string,
  nowSeconds = Math.floor(Date.now() / 1000),
): Promise<VerifiedTrustChain> {
  if (!Array.isArray(chain) || chain.length === 0 || chain.length % 2 === 0) {
    throw new Error("OIDF trust chain must be an odd-length array of entity statements");
  }

  const depth = (chain.length + 1) / 2;
  if (depth > MAX_ENTITY_DEPTH) {
    throw new Error(`OIDF trust chain exceeds the supported depth of ${MAX_ENTITY_DEPTH}`);
  }

  const statements = chain.map((jwt, position) => parseEntityStatement(jwt, position, nowSeconds));
  const entityConfigurations: ParsedEntityStatement[] = [];
  const subordinateStatements: ParsedEntityStatement[] = [];

  for (const statement of statements) {
    if (statement.position % 2 === 0) {
      if (statement.kind !== "entity-configuration") {
        throw new Error(`Entity statement ${statement.position} must be an entity configuration`);
      }
      entityConfigurations.push(statement);
    } else {
      if (statement.kind !== "subordinate-statement") {
        throw new Error(`Entity statement ${statement.position} must be a subordinate statement`);
      }
      subordinateStatements.push(statement);
    }
  }

  if (entityConfigurations.length !== subordinateStatements.length + 1) {
    throw new Error("OIDF trust chain structure is inconsistent");
  }

  const leaf = entityConfigurations[0];
  const anchor = entityConfigurations[entityConfigurations.length - 1];
  if (anchor.entityId !== expectedAnchor) {
    throw new Error(`OIDF trust chain terminates at ${anchor.entityId}, expected ${expectedAnchor}`);
  }

  await Promise.all(entityConfigurations.map((statement) => verifyEntityStatementSignature(statement, requiredJwks(statement))));

  for (const subordinate of subordinateStatements) {
    const parentConfiguration = statements[subordinate.position + 1];
    if (!parentConfiguration || parentConfiguration.kind !== "entity-configuration") {
      throw new Error(`Subordinate statement ${subordinate.position} is missing its superior entity configuration`);
    }
    await verifyEntityStatementSignature(subordinate, requiredJwks(parentConfiguration));
  }

  for (let index = 0; index < subordinateStatements.length; index += 1) {
    const child = entityConfigurations[index];
    const parent = entityConfigurations[index + 1];
    const subordinate = subordinateStatements[index];
    const authorityHints = child.payload.authority_hints ?? [];

    if (!authorityHints.includes(parent.entityId)) {
      throw new Error(`Entity configuration ${child.entityId} does not name ${parent.entityId} in authority_hints`);
    }
    if (subordinate.payload.sub !== child.entityId) {
      throw new Error(`Subordinate statement ${subordinate.position} must target ${child.entityId}`);
    }
    if (subordinate.payload.iss !== parent.entityId) {
      throw new Error(`Subordinate statement ${subordinate.position} must be issued by ${parent.entityId}`);
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
    expectedAnchor,
    depth,
    statements,
    entityConfigurations,
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
  if (kind === "entity-configuration") {
    requiredJwks({
      jwt,
      position,
      kind,
      header: header as EntityStatementHeader,
      payload: payload as EntityStatementPayload,
      entityId: payload.sub,
      signerEntityId: payload.iss,
    });
  }

  return {
    jwt,
    position,
    kind,
    header: header as EntityStatementHeader,
    payload: payload as EntityStatementPayload,
    entityId: payload.sub,
    signerEntityId: payload.iss,
  };
}

function requiredJwks(statement: ParsedEntityStatement) {
  const jwks = statement.payload.jwks?.keys;
  if (!Array.isArray(jwks) || jwks.length === 0) {
    throw new Error(`Entity configuration ${statement.entityId} is missing jwks`);
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
