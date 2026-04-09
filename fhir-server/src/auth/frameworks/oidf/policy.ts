import {
  STANDARD_METADATA_POLICY_OPERATORS,
  type EntityMetadata,
  type EntityMetadataPolicy,
  type StandardMetadataPolicyOperator,
  type VerifiedTrustChain,
} from "./trust-chain.ts";

export const SUPPORTED_METADATA_POLICY_OPERATORS = ["value", "default", "one_of"] as const;

type SupportedMetadataPolicyOperator = (typeof SUPPORTED_METADATA_POLICY_OPERATORS)[number];
type MetadataFieldPolicy = Partial<Record<StandardMetadataPolicyOperator, unknown>> & Record<string, unknown>;
type SupportedFieldPolicy = Partial<Record<SupportedMetadataPolicyOperator, unknown>>;
type MetadataTypePolicy = Record<string, MetadataFieldPolicy>;

export type ResolvedOidfMetadataPolicyResult = {
  metadata: EntityMetadata;
  // These remain federation entity keys from the leaf entity statement.
  // Protocol-specific consumers must read their own keys from resolved metadata.
  leafFederationEntityJwks: JsonWebKey[];
};

type FieldConstraint = {
  allowedValues?: unknown[];
  hasValuePolicy?: boolean;
  valuePolicy?: unknown;
  hasDefaultPolicy?: boolean;
  defaultPolicy?: unknown;
};

export function applyMetadataPolicy(verifiedChain: VerifiedTrustChain): ResolvedOidfMetadataPolicyResult {
  const leafFederationEntityJwks = verifiedChain.leaf.payload.jwks?.keys;
  if (!Array.isArray(leafFederationEntityJwks) || leafFederationEntityJwks.length === 0) {
    throw new Error("OIDF resolved metadata is missing the leaf entity jwks");
  }

  const resolvedMetadata = cloneMetadata(verifiedChain.directSubjectMetadata);
  applyAllowedEntityTypes(resolvedMetadata, verifiedChain.allowedEntityTypes);

  const fieldConstraints = new Map<string, FieldConstraint>();
  const criticalOperators = new Set(verifiedChain.criticalMetadataPolicyOperators);

  // OIDF 6.1.4.2 applies metadata policy top-down starting from the Trust Anchor.
  // VerifiedTrustChain.metadataPolicies is stored leaf-up, so reverse it here.
  const policyLayers = [...verifiedChain.metadataPolicies].reverse();
  for (const layer of policyLayers) {
    for (const [metadataType, metadataTypePolicy] of Object.entries(layer.metadataPolicy)) {
      if (!isAllowedEntityType(metadataType, verifiedChain.allowedEntityTypes)) continue;
      const typedPolicy = asMetadataTypePolicy(metadataTypePolicy, metadataType, layer.issuer);
      for (const [fieldName, fieldPolicy] of Object.entries(typedPolicy)) {
        const supportedFieldPolicy = normalizeSupportedOperators(
          fieldPolicy,
          metadataType,
          fieldName,
          layer.issuer,
          criticalOperators,
        );
        if (!supportedFieldPolicy) continue;
        applyFieldPolicy(resolvedMetadata, fieldConstraints, metadataType, fieldName, supportedFieldPolicy, layer.issuer);
      }
    }
  }

  return {
    metadata: resolvedMetadata,
    leafFederationEntityJwks,
  };
}

function asMetadataTypePolicy(value: unknown, metadataType: string, issuer: string): MetadataTypePolicy {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`OIDF metadata_policy for ${metadataType} from ${issuer} must be an object`);
  }
  return value as MetadataTypePolicy;
}

function normalizeSupportedOperators(
  fieldPolicy: MetadataFieldPolicy,
  metadataType: string,
  fieldName: string,
  issuer: string,
  criticalOperators: Set<string>,
) {
  const supportedOperators: SupportedFieldPolicy = {};
  let hasSupportedOperator = false;

  for (const [operator, value] of Object.entries(fieldPolicy)) {
    if ((SUPPORTED_METADATA_POLICY_OPERATORS as readonly string[]).includes(operator)) {
      supportedOperators[operator as SupportedMetadataPolicyOperator] = value;
      hasSupportedOperator = true;
      continue;
    }

    if ((STANDARD_METADATA_POLICY_OPERATORS as readonly string[]).includes(operator)) {
      throw new Error(
        `OIDF metadata_policy unsupported_standard_operator: metadata_policy operator ${operator} on ${metadataType}.${fieldName} from ${issuer} is unsupported`,
      );
    }

    if (criticalOperators.has(operator)) {
      throw new Error(
        `OIDF metadata_policy_crit unsupported_operator: metadata_policy_crit requires unsupported operator ${operator} on ${metadataType}.${fieldName} from ${issuer}`,
      );
    }
  }

  return hasSupportedOperator ? supportedOperators : null;
}

function applyFieldPolicy(
  metadata: EntityMetadata,
  fieldConstraints: Map<string, FieldConstraint>,
  metadataType: string,
  fieldName: string,
  fieldPolicy: SupportedFieldPolicy,
  issuer: string,
) {
  const constraintKey = `${metadataType}.${fieldName}`;
  const currentConstraint = fieldConstraints.get(constraintKey) ?? {};

  if ("one_of" in fieldPolicy) {
    const allowedValues = normalizeOneOf(fieldPolicy.one_of, metadataType, fieldName, issuer);
    currentConstraint.allowedValues = currentConstraint.allowedValues
      ? intersectValues(currentConstraint.allowedValues, allowedValues)
      : allowedValues;
    if (currentConstraint.allowedValues.length === 0) {
      throw new Error(`OIDF metadata_policy one_of conflict on ${metadataType}.${fieldName}`);
    }
  }

  if ("value" in fieldPolicy) {
    if (currentConstraint.hasValuePolicy && !jsonEqual(currentConstraint.valuePolicy, fieldPolicy.value)) {
      throw new Error(`OIDF metadata_policy value conflict on ${metadataType}.${fieldName}`);
    }
    currentConstraint.hasValuePolicy = true;
    currentConstraint.valuePolicy = fieldPolicy.value;
  }

  if ("default" in fieldPolicy) {
    if (fieldPolicy.default === null) {
      throw new Error(`OIDF metadata_policy default on ${metadataType}.${fieldName} from ${issuer} must not be null`);
    }
    if (currentConstraint.hasDefaultPolicy && !jsonEqual(currentConstraint.defaultPolicy, fieldPolicy.default)) {
      throw new Error(`OIDF metadata_policy default conflict on ${metadataType}.${fieldName}`);
    }
    currentConstraint.hasDefaultPolicy = true;
    currentConstraint.defaultPolicy = fieldPolicy.default;
  }

  validateSupportedOperatorCombinations(currentConstraint, metadataType, fieldName, issuer);

  if ("value" in fieldPolicy) {
    assertAllowedValue(currentConstraint.allowedValues, fieldPolicy.value, metadataType, fieldName, issuer, "value");
    if (fieldPolicy.value === null) {
      unsetResolvedField(metadata, metadataType, fieldName);
    } else {
      setResolvedField(metadata, metadataType, fieldName, fieldPolicy.value);
    }
  } else if ("default" in fieldPolicy && metadata[metadataType]?.[fieldName] === undefined) {
    assertAllowedValue(currentConstraint.allowedValues, fieldPolicy.default, metadataType, fieldName, issuer, "default");
    setResolvedField(metadata, metadataType, fieldName, fieldPolicy.default);
  }

  const currentValue = metadata[metadataType]?.[fieldName];
  if (currentValue !== undefined) {
    assertAllowedValue(currentConstraint.allowedValues, currentValue, metadataType, fieldName, issuer, "resolved");
  }

  fieldConstraints.set(constraintKey, currentConstraint);
}

function validateSupportedOperatorCombinations(
  fieldConstraint: FieldConstraint,
  metadataType: string,
  fieldName: string,
  issuer: string,
) {
  if (fieldConstraint.hasValuePolicy && fieldConstraint.valuePolicy === null && fieldConstraint.hasDefaultPolicy) {
    throw new Error(`OIDF metadata_policy value on ${metadataType}.${fieldName} from ${issuer} cannot be null when default is present`);
  }
  if (fieldConstraint.hasValuePolicy) {
    assertAllowedValue(fieldConstraint.allowedValues, fieldConstraint.valuePolicy, metadataType, fieldName, issuer, "value");
  }
}

function normalizeOneOf(value: unknown, metadataType: string, fieldName: string, issuer: string) {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`OIDF metadata_policy one_of for ${metadataType}.${fieldName} from ${issuer} must be a non-empty array`);
  }
  return dedupeValues(value);
}

function assertAllowedValue(
  allowedValues: unknown[] | undefined,
  value: unknown,
  metadataType: string,
  fieldName: string,
  issuer: string,
  operator: string,
) {
  if (!allowedValues) return;
  if (allowedValues.some((candidate) => jsonEqual(candidate, value))) return;
  throw new Error(`OIDF metadata_policy ${operator} on ${metadataType}.${fieldName} from ${issuer} violates one_of constraints`);
}

function setResolvedField(metadata: EntityMetadata, metadataType: string, fieldName: string, value: unknown) {
  metadata[metadataType] ??= {};
  metadata[metadataType][fieldName] = value;
}

function unsetResolvedField(metadata: EntityMetadata, metadataType: string, fieldName: string) {
  if (!metadata[metadataType]) return;
  delete metadata[metadataType][fieldName];
  if (Object.keys(metadata[metadataType] ?? {}).length === 0) {
    delete metadata[metadataType];
  }
}

function applyAllowedEntityTypes(metadata: EntityMetadata, allowedEntityTypes: string[] | null) {
  if (allowedEntityTypes === null) return;
  const allowed = new Set(["federation_entity", ...allowedEntityTypes]);
  for (const entityType of Object.keys(metadata)) {
    if (allowed.has(entityType)) continue;
    delete metadata[entityType];
  }
}

function isAllowedEntityType(metadataType: string, allowedEntityTypes: string[] | null) {
  if (allowedEntityTypes === null) return true;
  return metadataType === "federation_entity" || allowedEntityTypes.includes(metadataType);
}

function cloneMetadata(metadata: EntityMetadata): EntityMetadata {
  return structuredClone(metadata);
}

function intersectValues(left: unknown[], right: unknown[]) {
  return left.filter((leftValue) => right.some((rightValue) => jsonEqual(leftValue, rightValue)));
}

function dedupeValues(values: unknown[]) {
  const seen = new Set<string>();
  const deduped: unknown[] = [];
  for (const value of values) {
    const key = JSON.stringify(value);
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(value);
  }
  return deduped;
}

function jsonEqual(left: unknown, right: unknown) {
  return JSON.stringify(left) === JSON.stringify(right);
}
