import { decodeJwtWithoutVerification, normalizePublicJwk, verifyPrivateKeyJwt } from "../../../../shared/private-key-jwt.ts";

export const ENTITY_STATEMENT_TYP = "entity-statement+jwt";
export const ACCEPTED_ENTITY_STATEMENT_ALGS = ["ES256"] as const;
export const STANDARD_METADATA_POLICY_OPERATORS = [
  "value",
  "add",
  "default",
  "one_of",
  "subset_of",
  "superset_of",
  "essential",
] as const;

const CLOCK_SKEW_SECONDS = 60;
const DEFAULT_MAX_ENTITY_DEPTH = 10;
const STANDARD_ENTITY_STATEMENT_CLAIMS = new Set([
  "iss",
  "sub",
  "iat",
  "exp",
  "jwks",
  "metadata",
  "crit",
  "authority_hints",
  "trust_anchor_hints",
  "trust_marks",
  "trust_mark_issuers",
  "trust_mark_owners",
  "constraints",
  "metadata_policy",
  "metadata_policy_crit",
  "source_endpoint",
]);

export type EntityStatementAlg = (typeof ACCEPTED_ENTITY_STATEMENT_ALGS)[number];
export type StandardMetadataPolicyOperator = (typeof STANDARD_METADATA_POLICY_OPERATORS)[number];

export type EntityStatementHeader = {
  alg: EntityStatementAlg;
  typ: typeof ENTITY_STATEMENT_TYP;
  kid: string;
  [key: string]: unknown;
};

export type EntityMetadata = Record<string, Record<string, unknown>>;
export type EntityMetadataPolicy = Record<string, Record<string, Record<string, unknown>>>;
export type NamingConstraints = {
  permitted?: string[];
  excluded?: string[];
};
export type EntityConstraints = {
  max_path_length?: number;
  naming_constraints?: NamingConstraints;
  allowed_entity_types?: string[];
  [key: string]: unknown;
};

export type EntityStatementPayload = {
  iss: string;
  sub: string;
  iat: number;
  exp: number;
  jwks?: { keys: JsonWebKey[] };
  metadata?: EntityMetadata;
  metadata_policy?: EntityMetadataPolicy;
  metadata_policy_crit?: string[];
  constraints?: EntityConstraints;
  crit?: string[];
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
  directSubjectMetadata: EntityMetadata;
  allowedEntityTypes: string[] | null;
  /**
   * Ordered from closest-to-leaf upward.
   * Consumers that apply policy top-down per OIDF 6.1.4.2 must reverse this list.
   */
  metadataPolicies: Array<{
    issuer: string;
    subject: string;
    metadataPolicy: EntityMetadataPolicy;
    metadataPolicyCrit: string[];
  }>;
  criticalMetadataPolicyOperators: string[];
  constraints: Array<{
    issuer: string;
    subject: string;
    constraints: EntityConstraints;
    distanceToLeaf: number;
  }>;
};

export async function verifyTrustChain(
  chain: string[],
  options: {
    expectedAnchor: string;
    trustedAnchorJwks: JsonWebKey[];
    nowSeconds?: number;
    maxDepth?: number;
  },
): Promise<VerifiedTrustChain> {
  const nowSeconds = options.nowSeconds ?? Math.floor(Date.now() / 1000);
  const maxDepth = options.maxDepth ?? DEFAULT_MAX_ENTITY_DEPTH;
  if (!Array.isArray(chain) || chain.length === 0) {
    throw new Error("OIDF trust chain must be a non-empty array of entity statements");
  }

  const depth = chain.length === 1 ? 1 : chain.length - 1;
  if (chain.length === 2 || depth > maxDepth) {
    throw new Error(`OIDF trust chain exceeds the supported depth of ${maxDepth}`);
  }

  const statements = chain.map((jwt, position) => parseEntityStatement(jwt, position, nowSeconds));
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
    if (statement.payload.iss !== signer.payload.sub) {
      throw new Error(`OIDF trust chain linkage failed: ES[${index}].iss must equal ES[${index + 1}].sub`);
    }
    await verifyEntityStatementSignature(statement, requiredJwks(signer));
  }
  await verifyEntityStatementSignature(anchor, options.trustedAnchorJwks.map((jwk) => normalizeFederationPublicJwk(jwk)));

  if (subordinateStatements.length > 0) {
    const leafAuthorityHints = Array.isArray(leaf.payload.authority_hints)
      ? leaf.payload.authority_hints.filter((hint): hint is string => typeof hint === "string" && !!hint)
      : [];
    if (!leafAuthorityHints.includes(subordinateStatements[0].payload.iss)) {
      throw new Error(`Leaf entity configuration does not name ${subordinateStatements[0].payload.iss} in authority_hints`);
    }
  }

  const constraints = subordinateStatements
    .flatMap((statement, distanceToLeaf) => statement.payload.constraints
      ? [{
        issuer: statement.payload.iss,
        subject: statement.payload.sub,
        constraints: statement.payload.constraints ?? {},
        distanceToLeaf,
      }]
      : []);
  enforceTrustChainConstraints(subordinateStatements, constraints);

  const metadataPolicies = subordinateStatements
    .filter((statement) => statement.payload.metadata_policy)
    .map((statement) => ({
      issuer: statement.payload.iss,
      subject: statement.payload.sub,
      metadataPolicy: statement.payload.metadata_policy ?? {},
      metadataPolicyCrit: normalizeMetadataPolicyCrit(statement),
    }));

  return {
    expectedAnchor: options.expectedAnchor,
    depth,
    statements,
    subordinateStatements,
    leaf,
    anchor,
    leafMetadata: cloneMetadata(leaf.payload.metadata ?? {}),
    directSubjectMetadata: subordinateStatements[0]?.payload.metadata
      ? applyDirectSubjectMetadata(leaf.payload.metadata ?? {}, subordinateStatements[0].payload.metadata ?? {})
      : cloneMetadata(leaf.payload.metadata ?? {}),
    allowedEntityTypes: resolveAllowedEntityTypes(constraints),
    criticalMetadataPolicyOperators: dedupeStrings(metadataPolicies.flatMap((entry) => entry.metadataPolicyCrit)),
    metadataPolicies,
    constraints,
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
  if (typeof header.kid !== "string" || !header.kid.trim()) {
    throw new Error(`Entity statement ${position} is missing a non-empty header kid`);
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

  validateCriticalClaims(statement);
  validateClaimUsage(statement);
  requiredJwks(statement);

  return statement;
}

function requiredJwks(statement: ParsedEntityStatement) {
  const jwks = statement.payload.jwks?.keys;
  if (!Array.isArray(jwks) || jwks.length === 0) {
    throw new Error(`Entity statement ${statement.position} is missing jwks`);
  }
  const normalizedKeys = jwks.map((jwk, index) => {
    const normalized = normalizeFederationPublicJwk(jwk);
    if (!normalized.kid.trim()) {
      throw new Error(`Entity statement ${statement.position} jwks key ${index} is missing kid`);
    }
    return normalized;
  });
  const kids = normalizedKeys.map((key) => key.kid);
  if (new Set(kids).size !== kids.length) {
    throw new Error(`Entity statement ${statement.position} jwks contains duplicate kid values`);
  }
  return normalizedKeys;
}

async function verifyEntityStatementSignature(statement: ParsedEntityStatement, keys: Array<JsonWebKey & { kid: string }>) {
  const signingKey = keys.find((key) => key.kid === statement.header.kid);
  if (!signingKey) {
    throw new Error(`Entity statement ${statement.position} kid ${statement.header.kid} does not match issuer jwks`);
  }

  try {
    await verifyPrivateKeyJwt(statement.jwt, signingKey);
  } catch (error) {
    const lastError = error instanceof Error ? error : new Error(String(error));
    throw new Error(`Entity statement ${statement.position} signature verification failed: ${lastError.message}`);
  }
}

function validateCriticalClaims(statement: ParsedEntityStatement) {
  if (!("crit" in statement.payload) || statement.payload.crit === undefined) return;
  if (!Array.isArray(statement.payload.crit) || statement.payload.crit.length === 0) {
    throw new Error(`Entity statement ${statement.position} crit must be a non-empty array`);
  }
  for (const claim of statement.payload.crit) {
    if (typeof claim !== "string" || !claim.trim()) {
      throw new Error(`Entity statement ${statement.position} crit contains a non-string claim name`);
    }
    if (STANDARD_ENTITY_STATEMENT_CLAIMS.has(claim)) {
      throw new Error(`Entity statement ${statement.position} crit must not reference standard claim ${claim}`);
    }
    throw new Error(`Entity statement ${statement.position} crit references unsupported claim ${claim}`);
  }
}

function validateClaimUsage(statement: ParsedEntityStatement) {
  if ("authority_hints" in statement.payload) {
    if (statement.kind !== "entity-configuration") {
      throw new Error(`Entity statement ${statement.position} authority_hints may only appear in entity configurations`);
    }
    const hints = statement.payload.authority_hints;
    if (!Array.isArray(hints) || hints.length === 0 || hints.some((hint) => typeof hint !== "string" || !hint)) {
      throw new Error(`Entity statement ${statement.position} authority_hints must be a non-empty string array`);
    }
  }

  if ("metadata_policy" in statement.payload && statement.payload.metadata_policy !== undefined && statement.kind !== "subordinate-statement") {
    throw new Error(`Entity statement ${statement.position} metadata_policy may only appear in subordinate statements`);
  }
  if ("constraints" in statement.payload && statement.payload.constraints !== undefined && statement.kind !== "subordinate-statement") {
    throw new Error(`Entity statement ${statement.position} constraints may only appear in subordinate statements`);
  }
  if ("metadata_policy_crit" in statement.payload && statement.payload.metadata_policy_crit !== undefined) {
    if (statement.kind !== "subordinate-statement") {
      throw new Error(`Entity statement ${statement.position} metadata_policy_crit may only appear in subordinate statements`);
    }
    if (!Array.isArray(statement.payload.metadata_policy_crit) || statement.payload.metadata_policy_crit.length === 0) {
      throw new Error(`Entity statement ${statement.position} metadata_policy_crit must be a non-empty array`);
    }
    for (const operator of statement.payload.metadata_policy_crit) {
      if (typeof operator !== "string" || !operator.trim()) {
        throw new Error(`Entity statement ${statement.position} metadata_policy_crit contains a non-string operator`);
      }
      if ((STANDARD_METADATA_POLICY_OPERATORS as readonly string[]).includes(operator)) {
        throw new Error(`Entity statement ${statement.position} metadata_policy_crit must not reference standard operator ${operator}`);
      }
    }
  }
}

function normalizeMetadataPolicyCrit(statement: ParsedEntityStatement) {
  if (!Array.isArray(statement.payload.metadata_policy_crit)) return [];
  return statement.payload.metadata_policy_crit.filter((operator): operator is string => typeof operator === "string" && !!operator);
}

function enforceTrustChainConstraints(
  subordinateStatements: ParsedEntityStatement[],
  constraints: VerifiedTrustChain["constraints"],
) {
  for (const constraintLayer of constraints) {
    const layerConstraints = constraintLayer.constraints;
    if (typeof layerConstraints.max_path_length === "number") {
      if (!Number.isInteger(layerConstraints.max_path_length) || layerConstraints.max_path_length < 0) {
        throw new Error(`OIDF constraints max_path_length from ${constraintLayer.issuer} must be a non-negative integer`);
      }
      if (constraintLayer.distanceToLeaf > layerConstraints.max_path_length) {
        throw new Error(`OIDF constraints max_path_length from ${constraintLayer.issuer} rejects this trust chain`);
      }
    }

    if (layerConstraints.naming_constraints) {
      const affectedEntityIds = [
        constraintLayer.subject,
        ...subordinateStatements.slice(0, constraintLayer.distanceToLeaf).map((statement) => statement.payload.sub),
      ];
      validateNamingConstraints(constraintLayer.issuer, affectedEntityIds, layerConstraints.naming_constraints);
    }
  }
}

function validateNamingConstraints(
  issuer: string,
  entityIds: string[],
  namingConstraints: NamingConstraints,
) {
  const permitted = normalizeConstraintHostList(namingConstraints.permitted);
  const excluded = normalizeConstraintHostList(namingConstraints.excluded);
  for (const entityId of entityIds) {
    const hostname = new URL(entityId).hostname;
    if (excluded.some((constraint) => hostMatchesConstraint(hostname, constraint))) {
      throw new Error(`OIDF naming_constraints from ${issuer} excludes ${entityId}`);
    }
    if (permitted.length > 0 && !permitted.some((constraint) => hostMatchesConstraint(hostname, constraint))) {
      throw new Error(`OIDF naming_constraints from ${issuer} does not permit ${entityId}`);
    }
  }
}

function normalizeConstraintHostList(value: unknown) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string" || !entry)) {
    throw new Error("OIDF naming_constraints must be arrays of non-empty strings");
  }
  return value;
}

function hostMatchesConstraint(hostname: string, constraint: string) {
  if (constraint.startsWith(".")) {
    const suffix = constraint.slice(1);
    return hostname.endsWith(constraint) && hostname !== suffix;
  }
  return hostname === constraint;
}

function resolveAllowedEntityTypes(constraints: VerifiedTrustChain["constraints"]) {
  let allowed: string[] | null = null;
  for (const layer of constraints) {
    const configured = layer.constraints.allowed_entity_types;
    if (configured === undefined) continue;
    if (!Array.isArray(configured) || configured.some((value) => typeof value !== "string" || !value)) {
      throw new Error(`OIDF constraints allowed_entity_types from ${layer.issuer} must be an array of non-empty strings`);
    }
    if (configured.includes("federation_entity")) {
      throw new Error(`OIDF constraints allowed_entity_types from ${layer.issuer} must not include federation_entity`);
    }
    allowed = allowed === null ? [...configured] : allowed.filter((entityType) => configured.includes(entityType));
  }
  return allowed;
}

function applyDirectSubjectMetadata(leafMetadata: EntityMetadata, directSubjectMetadata: EntityMetadata) {
  const resolved = cloneMetadata(leafMetadata);
  for (const entityType of Object.keys(leafMetadata)) {
    const override = directSubjectMetadata[entityType];
    if (!override || typeof override !== "object" || Array.isArray(override)) continue;
    resolved[entityType] = {
      ...(resolved[entityType] ?? {}),
      ...override,
    };
  }
  return resolved;
}

function normalizeFederationPublicJwk(jwk: JsonWebKey) {
  const normalized = normalizePublicJwk(jwk);
  const kid = (jwk as JsonWebKey & { kid?: string }).kid;
  return {
    ...normalized,
    kid: typeof kid === "string" ? kid : "",
  };
}

function cloneMetadata(metadata: EntityMetadata) {
  return structuredClone(metadata);
}

function dedupeStrings(values: string[]) {
  return [...new Set(values)];
}

function formatError(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
