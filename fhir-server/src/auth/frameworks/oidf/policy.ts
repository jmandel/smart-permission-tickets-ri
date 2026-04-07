import type { EntityMetadata, EntityMetadataPolicy, VerifiedTrustChain } from "./trust-chain.ts";

export const SUPPORTED_METADATA_POLICY_OPERATORS = ["value", "default", "one_of"] as const;

type SupportedMetadataPolicyOperator = (typeof SUPPORTED_METADATA_POLICY_OPERATORS)[number];
type MetadataFieldPolicy = Partial<Record<SupportedMetadataPolicyOperator, unknown>> & Record<string, unknown>;
type MetadataTypePolicy = Record<string, MetadataFieldPolicy>;

export type ResolvedOidfClientMetadata = {
  metadata: EntityMetadata;
  jwks: JsonWebKey[];
};

type FieldConstraint = {
  allowedValues?: unknown[];
};

export function applyMetadataPolicy(verifiedChain: VerifiedTrustChain): ResolvedOidfClientMetadata {
  const jwks = verifiedChain.leaf.payload.jwks?.keys;
  if (!Array.isArray(jwks) || jwks.length === 0) {
    throw new Error("OIDF resolved metadata is missing the leaf entity jwks");
  }

  const resolvedMetadata = cloneMetadata(verifiedChain.leafMetadata);
  const fieldConstraints = new Map<string, FieldConstraint>();

  // OIDF 6.1.4.2 applies metadata policy top-down starting from the Trust Anchor.
  // VerifiedTrustChain.metadataPolicies is stored leaf-up, so reverse it here.
  const policyLayers = [...verifiedChain.metadataPolicies].reverse();
  for (const layer of policyLayers) {
    for (const [metadataType, metadataTypePolicy] of Object.entries(layer.metadataPolicy)) {
      const typedPolicy = asMetadataTypePolicy(metadataTypePolicy, metadataType, layer.issuer);
      for (const [fieldName, fieldPolicy] of Object.entries(typedPolicy)) {
        validateSupportedOperators(fieldPolicy, metadataType, fieldName, layer.issuer);
        applyFieldPolicy(resolvedMetadata, fieldConstraints, metadataType, fieldName, fieldPolicy, layer.issuer);
      }
    }
  }

  return {
    metadata: resolvedMetadata,
    jwks,
  };
}

function asMetadataTypePolicy(value: unknown, metadataType: string, issuer: string): MetadataTypePolicy {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`OIDF metadata_policy for ${metadataType} from ${issuer} must be an object`);
  }
  return value as MetadataTypePolicy;
}

function validateSupportedOperators(fieldPolicy: MetadataFieldPolicy, metadataType: string, fieldName: string, issuer: string) {
  for (const operator of Object.keys(fieldPolicy)) {
    if (!(SUPPORTED_METADATA_POLICY_OPERATORS as readonly string[]).includes(operator)) {
      throw new Error(`OIDF metadata_policy operator ${operator} on ${metadataType}.${fieldName} from ${issuer} is unsupported`);
    }
  }
}

function applyFieldPolicy(
  metadata: EntityMetadata,
  fieldConstraints: Map<string, FieldConstraint>,
  metadataType: string,
  fieldName: string,
  fieldPolicy: MetadataFieldPolicy,
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

  let currentValue = metadata[metadataType]?.[fieldName];

  if ("value" in fieldPolicy) {
    currentValue = fieldPolicy.value;
    assertAllowedValue(currentConstraint.allowedValues, currentValue, metadataType, fieldName, issuer, "value");
    setResolvedField(metadata, metadataType, fieldName, currentValue);
  } else if ("default" in fieldPolicy && currentValue === undefined) {
    currentValue = fieldPolicy.default;
    assertAllowedValue(currentConstraint.allowedValues, currentValue, metadataType, fieldName, issuer, "default");
    setResolvedField(metadata, metadataType, fieldName, currentValue);
  }

  currentValue = metadata[metadataType]?.[fieldName];
  if (currentValue !== undefined) {
    assertAllowedValue(currentConstraint.allowedValues, currentValue, metadataType, fieldName, issuer, "resolved");
  } else if (currentConstraint.allowedValues?.length === 1) {
    setResolvedField(metadata, metadataType, fieldName, currentConstraint.allowedValues[0]);
  }

  fieldConstraints.set(constraintKey, currentConstraint);
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
