import path from "node:path";

export type Label = {
  system: string;
  code: string;
};

export type CategoryRule = {
  resourceType: string;
  system: string;
  code: string;
};

export type AllowedPatientAlias = {
  siteSlug: string;
  sourcePatientRef: string;
};

export type DateSemantics = "generated-during-period" | "care-overlap";
export type SensitiveMode = "deny" | "allow";

export type SensitiveSharing = {
  mode?: SensitiveMode;
};

export type Ticket = {
  name: string;
  allowedPatientAliases: AllowedPatientAlias[];
  allowedSites?: string[];
  allowedResourceTypes?: string[];
  dateRange?: { start: string; end: string };
  dateSemantics?: DateSemantics;
  sensitive?: SensitiveSharing;
  requiredLabelsAll?: Label[];
  deniedLabelsAny?: Label[];
  granularCategoryRules?: CategoryRule[];
};

export type Search = {
  resourceType: string;
  category?: Label;
  limit?: number;
};

export type HiddenRead = {
  resourceType: string;
  sourceLogicalId: string;
  siteSlug: string;
};

export type ScopeClass = "patient" | "site";

export type ResourceDescriptor = {
  filePath: string;
  patientSlug: string;
  siteSlug: string;
  resourceType: string;
  sourceLogicalId: string;
  sourceRef: string;
  localPatientSourceRef: string;
  scopeClass: ScopeClass;
  sourceJson: any;
  serverKey: string;
  serverLogicalId: string;
  serverRef: string;
};

export type PatientAlias = {
  patientSlug: string;
  siteSlug: string;
  sourcePatientRef: string;
  serverPatientRef: string;
};

export type LoadResult = {
  patientAliases: PatientAlias[];
  sourceCollisionCount: number;
  serverCollisionCount: number;
};

export type WindowSourceKind = "direct" | "encounter-fallback" | "identity-exempt" | "missing";

export type ResourceRow = {
  resource_pk: number;
  site_slug: string;
  resource_type: string;
  source_logical_id: string;
  server_logical_id: string;
  care_start: string | null;
  care_end: string | null;
  care_source_rule: string | null;
  care_source_kind: WindowSourceKind;
  generated_start: string | null;
  generated_end: string | null;
  generated_source_rule: string | null;
  generated_source_kind: WindowSourceKind;
};

export const DATA_ROOT = path.resolve(import.meta.dir, "..", "..", "patients");
export const SECURITY_SYSTEM = "urn:example:permissiontickets-demo:security";
export const SOURCE_ORG_NPI_SYSTEM = "urn:example:permissiontickets-demo:source-org-npi";
export const JURISDICTION_STATE_SYSTEM = "urn:example:permissiontickets-demo:jurisdiction-state";
export const V3_ACTCODE_SYSTEM = "http://terminology.hl7.org/CodeSystem/v3-ActCode";
export const SENSITIVE_LABELS: Label[] = [
  { system: V3_ACTCODE_SYSTEM, code: "SEX" },
  { system: V3_ACTCODE_SYSTEM, code: "ETH" },
  { system: V3_ACTCODE_SYSTEM, code: "MH" },
  { system: V3_ACTCODE_SYSTEM, code: "HIV" },
  { system: V3_ACTCODE_SYSTEM, code: "STD" },
  { system: V3_ACTCODE_SYSTEM, code: "SDV" },
];
export const SITE_SCOPED_TYPES = new Set(["Organization", "Location", "Practitioner", "PractitionerRole"]);
export const IDENTITY_TYPES = new Set(["Patient", "Organization", "Practitioner", "Location", "PractitionerRole"]);
