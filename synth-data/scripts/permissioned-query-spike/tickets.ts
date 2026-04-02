import type { HiddenRead, PatientAlias, Ticket } from "./model.ts";
import { SECURITY_SYSTEM, V3_ACTCODE_SYSTEM } from "./model.ts";

export function buildTickets(patientAliases: PatientAlias[]): Array<{ ticket: Ticket; hiddenRead?: HiddenRead }> {
  return [
    {
      ticket: {
        name: "Elena full chart across all sites",
        allowedPatientAliases: aliasesFor(patientAliases, "elena-reyes"),
      },
    },
    {
      ticket: {
        name: "Elena California-only RA slice, no clinical notes, 2023-2025",
        allowedPatientAliases: aliasesFor(patientAliases, "elena-reyes"),
        allowedSites: [
          "eastbay-primary-care-associates",
          "bay-area-rheumatology-associates",
          "bay-area-urgent-care-telegraph-ave-location",
        ],
        allowedResourceTypes: ["Encounter", "Condition", "MedicationRequest", "Observation", "DiagnosticReport", "Patient", "Organization", "Practitioner", "Location"],
        dateRange: { start: "2023-01-01", end: "2025-12-31" },
        deniedLabelsAny: [{ system: SECURITY_SYSTEM, code: "clinical-note" }],
      },
      hiddenRead: {
        resourceType: "DocumentReference",
        sourceLogicalId: "enc-007-note",
        siteSlug: "bay-area-rheumatology-associates",
      },
    },
    {
      ticket: {
        name: "Elena chart with reproductive sensitivity denied",
        allowedPatientAliases: aliasesFor(patientAliases, "elena-reyes"),
        deniedLabelsAny: [{ system: V3_ACTCODE_SYSTEM, code: "SEX" }],
      },
      hiddenRead: {
        resourceType: "Encounter",
        sourceLogicalId: "enc-001",
        siteSlug: "lone-star-womens-health",
      },
    },
    {
      ticket: {
        name: "Robert TB clinic, structured infectious-disease access, no notes",
        allowedPatientAliases: aliasesFor(patientAliases, "robert-davis", ["ui-health-ambulatory-tb-clinic"]),
        allowedSites: ["ui-health-ambulatory-tb-clinic"],
        allowedResourceTypes: ["Patient", "Encounter", "Condition", "Observation", "DiagnosticReport", "MedicationRequest", "ServiceRequest", "Procedure", "Organization", "Practitioner", "Location"],
        requiredLabelsAll: [{ system: SECURITY_SYSTEM, code: "infectious-disease" }],
        deniedLabelsAny: [{ system: SECURITY_SYSTEM, code: "clinical-note" }],
      },
    },
    {
      ticket: {
        name: "Robert chart with HIV and mental-health sensitivity denied",
        allowedPatientAliases: aliasesFor(patientAliases, "robert-davis"),
        allowedResourceTypes: ["Patient", "Encounter", "Observation", "DiagnosticReport", "Condition", "DocumentReference", "Organization", "Practitioner", "Location"],
        deniedLabelsAny: [
          { system: V3_ACTCODE_SYSTEM, code: "HIV" },
          { system: V3_ACTCODE_SYSTEM, code: "MH" },
        ],
      },
      hiddenRead: {
        resourceType: "DiagnosticReport",
        sourceLogicalId: "enc-000-hiv-report",
        siteSlug: "university-of-illinois-hospital",
      },
    },
    {
      ticket: {
        name: "Denise New Mexico renal monitoring only, 2024",
        allowedPatientAliases: aliasesFor(patientAliases, "denise-walker"),
        allowedSites: ["rio-grande-nephrology-associates", "university-of-new-mexico-hospital-and-heart-failure-clinic"],
        allowedResourceTypes: ["Patient", "Encounter", "Observation", "DiagnosticReport", "Condition", "MedicationRequest", "DocumentReference", "Organization", "Practitioner", "Location"],
        dateRange: { start: "2024-01-01", end: "2024-12-31" },
        requiredLabelsAll: [
          { system: "urn:example:permissiontickets-demo:jurisdiction-state", code: "NM" },
          { system: SECURITY_SYSTEM, code: "renal" },
        ],
        granularCategoryRules: [
          {
            resourceType: "Observation",
            system: "http://terminology.hl7.org/CodeSystem/observation-category",
            code: "laboratory",
          },
        ],
        deniedLabelsAny: [{ system: SECURITY_SYSTEM, code: "clinical-note" }],
      },
    },
    {
      ticket: {
        name: "Denise retina-only view with vision label",
        allowedPatientAliases: aliasesFor(patientAliases, "denise-walker"),
        allowedSites: ["sandia-retina-specialists"],
        allowedResourceTypes: ["Patient", "Encounter", "Observation", "DiagnosticReport", "Condition", "MedicationRequest", "Procedure", "DocumentReference", "Organization", "Practitioner", "Location"],
        requiredLabelsAll: [{ system: SECURITY_SYSTEM, code: "vision" }],
      },
    },
  ];
}

export function buildChainedTicket(patientAliases: PatientAlias[]): Ticket {
  return {
    name: "Denise NM lab Observations chained through visible Encounter.class=AMB",
    allowedPatientAliases: aliasesFor(patientAliases, "denise-walker"),
    allowedSites: ["rio-grande-nephrology-associates", "university-of-new-mexico-hospital-and-heart-failure-clinic"],
    allowedResourceTypes: ["Encounter", "Observation", "Patient", "Organization", "Practitioner", "Location"],
    dateRange: { start: "2025-01-01", end: "2025-12-31" },
    requiredLabelsAll: [{ system: "urn:example:permissiontickets-demo:jurisdiction-state", code: "NM" }],
    granularCategoryRules: [
      {
        resourceType: "Observation",
        system: "http://terminology.hl7.org/CodeSystem/observation-category",
        code: "laboratory",
      },
    ],
  };
}

function aliasesFor(patientAliases: PatientAlias[], patientSlug: string, sites?: string[]) {
  return patientAliases
    .filter((alias) => alias.patientSlug === patientSlug)
    .filter((alias) => !sites || sites.includes(alias.siteSlug))
    .map((alias) => ({ siteSlug: alias.siteSlug, sourcePatientRef: alias.sourcePatientRef }))
    .sort((a, b) => `${a.siteSlug}:${a.sourcePatientRef}`.localeCompare(`${b.siteSlug}:${b.sourcePatientRef}`));
}
