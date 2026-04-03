import { describe, expect, test } from "bun:test";

import {
  buildFetchCurl,
  buildTicketPayload,
  buildViewerLaunch,
  buildViewerLaunchUrl,
  chooseNetworkAuthSurface,
  chooseSiteAuthSurface,
  constrainedSites,
  decodeViewerLaunch,
  defaultConsentState,
  isConsentValid,
  scopeOptionsForPerson,
  selectedResourceTypes,
  selectedSmartScopes,
  validateConsent,
} from "./demo";
import type { NetworkInfo, PersonInfo, TicketIssuerInfo } from "./types";

const person: PersonInfo = {
  personId: "elena-reyes",
  patientSlug: "elena-reyes",
  displayName: "Elena Reyes",
  familyName: "Reyes",
  givenNames: ["Elena"],
  birthDate: "1989-09-14",
  gender: "female",
  summary: "Synthetic test patient",
  resourceCounts: {
    Patient: 2,
    Encounter: 6,
    Observation: 12,
    DiagnosticReport: 5,
    AllergyIntolerance: 1,
  },
  sensitiveResourceCount: 3,
  startDate: "2021-01-01",
  endDate: "2025-12-31",
  sites: [
    {
      siteSlug: "lone-star-womens-health",
      orgName: "Lone Star Women's Health",
      organizationNpi: "1111111111",
      jurisdiction: "TX",
      patientId: "p-tx",
      resourceCounts: { Patient: 1, Encounter: 2, DiagnosticReport: 2 },
      sensitiveResourceCount: 2,
      startDate: "2021-01-01",
      endDate: "2021-06-01",
      encounters: [],
    },
    {
      siteSlug: "eastbay-primary-care-associates",
      orgName: "Eastbay Primary Care Associates",
      organizationNpi: "2222222222",
      jurisdiction: "CA",
      patientId: "p-ca",
      resourceCounts: { Patient: 1, Encounter: 4, Observation: 12, AllergyIntolerance: 1 },
      sensitiveResourceCount: 0,
      startDate: "2023-01-01",
      endDate: "2025-12-31",
      encounters: [],
    },
    {
      siteSlug: "bay-area-rheumatology-associates",
      orgName: "Bay Area Rheumatology Associates",
      organizationNpi: "3333333333",
      jurisdiction: "CA",
      patientId: "p-ca-rheum",
      resourceCounts: { Patient: 1, Encounter: 3, MedicationRequest: 2 },
      sensitiveResourceCount: 0,
      startDate: "2023-04-01",
      endDate: "2025-12-31",
      encounters: [],
    },
  ],
};

const ticketIssuer: TicketIssuerInfo = {
  slug: "reference-demo",
  name: "Reference Demo Issuer",
  issuerBasePath: "/issuer/reference-demo",
  issuerBaseUrl: "http://localhost:8091/issuer/reference-demo",
  jwksPath: "/issuer/reference-demo/.well-known/jwks.json",
  jwksUrl: "http://localhost:8091/issuer/reference-demo/.well-known/jwks.json",
  signTicketPath: "/issuer/reference-demo/sign-ticket",
  signTicketUrl: "http://localhost:8091/issuer/reference-demo/sign-ticket",
};

const network: NetworkInfo = {
  slug: "reference",
  name: "Reference Network",
};

describe("demo helpers", () => {
  test("default consent enables every resource type present for the patient", () => {
    const consent = defaultConsentState(person);
    expect(consent.resourceScopeMode).toBe("all");
    expect(consent.locationMode).toBe("all");
    expect(consent.dateMode).toBe("all");
    expect(selectedResourceTypes(consent)).toEqual(["*"]);
  });

  test("chooseSiteAuthSurface uses a site-bound surface", () => {
    const surface = chooseSiteAuthSurface("open", person.sites[0]);
    expect(surface.kind).toBe("site");
    expect(surface.tokenPath).toBe("/modes/open/sites/lone-star-womens-health/token");
  });

  test("chooseNetworkAuthSurface uses a network-bound surface", () => {
    const surface = chooseNetworkAuthSurface("registered", network);
    expect(surface.kind).toBe("network");
    expect(surface.tokenPath).toBe("/modes/registered/networks/reference/token");
  });

  test("viewer launch encodes the selected network surface", () => {
    const consent = defaultConsentState(person);
    consent.locationMode = "organizations";
    consent.selectedSiteSlugs = {
      "lone-star-womens-health": false,
      "eastbay-primary-care-associates": true,
      "bay-area-rheumatology-associates": true,
    };
    const ticketPayload = buildTicketPayload(ticketIssuer.issuerBaseUrl, "http://localhost:8091", person, consent);
    const launch = buildViewerLaunch(
      "http://localhost:8091",
      "registered",
      person,
      network,
      ticketIssuer,
      ticketPayload,
      "signed-ticket",
      null,
      null,
    );
    const roundTrip = decodeViewerLaunch(new URL(buildViewerLaunchUrl(launch), "http://localhost:8091").searchParams.get("session")!);

    expect(roundTrip.network.slug).toBe("reference");
    expect(roundTrip.network.authSurface.kind).toBe("network");
    expect(roundTrip.network.authSurface.fhirBasePath).toBe("/modes/registered/networks/reference/fhir");
  });

  test("ticket payload compiles full-state selection to jurisdictions and partial selection to organizations", () => {
    const consent = defaultConsentState(person);
    consent.locationMode = "states";
    consent.selectedSiteSlugs = {
      "lone-star-womens-health": true,
      "eastbay-primary-care-associates": false,
      "bay-area-rheumatology-associates": false,
    };
    consent.selectedStateCodes = { TX: true, CA: false };
    const ticket = buildTicketPayload(ticketIssuer.issuerBaseUrl, "http://localhost:8091", person, consent);
    expect(ticket.authorization.access.jurisdictions).toEqual([{ state: "TX" }]);
    expect(ticket.authorization.access.organizations).toBeUndefined();
  });

  test("ticket payload prefers organization identifiers over names when a partial state selection is needed", () => {
    const consent = defaultConsentState(person);
    consent.locationMode = "organizations";
    consent.selectedSiteSlugs = {
      "lone-star-womens-health": false,
      "eastbay-primary-care-associates": true,
      "bay-area-rheumatology-associates": false,
    };
    const ticket = buildTicketPayload(ticketIssuer.issuerBaseUrl, "http://localhost:8091", person, consent);
    expect(ticket.authorization.access.jurisdictions).toBeUndefined();
    expect(ticket.authorization.access.organizations).toEqual([
      {
        identifier: [{ system: "http://hl7.org/fhir/sid/us-npi", value: "2222222222" }],
      },
    ]);
    expect(constrainedSites(person, consent).map((site) => site.siteSlug)).toEqual(["eastbay-primary-care-associates"]);
  });

  test("state-limited consent is invalid until at least one state is selected", () => {
    const consent = defaultConsentState(person);
    consent.locationMode = "states";
    consent.selectedStateCodes = { TX: false, CA: false };

    expect(isConsentValid(person, consent)).toBe(false);
    expect(validateConsent(person, consent)).toContainEqual({
      section: "sites",
      message: "Select at least one state.",
    });
  });

  test("all-resource mode emits wildcard scopes while selected mode emits explicit scopes", () => {
    const allConsent = defaultConsentState(person);
    const allTicket = buildTicketPayload(ticketIssuer.issuerBaseUrl, "http://localhost:8091", person, allConsent);
    expect(allTicket.authorization.access.scopes).toEqual(["patient/*.rs"]);

    const selectedConsent = defaultConsentState(person);
    selectedConsent.resourceScopeMode = "selected";
    selectedConsent.scopeSelections = {
      "patient/Patient.rs": true,
      "patient/Observation.rs?category=http://terminology.hl7.org/CodeSystem/observation-category|laboratory": true,
      "patient/Observation.rs?category=http://terminology.hl7.org/CodeSystem/observation-category|vital-signs": false,
    };
    const selectedTicket = buildTicketPayload(ticketIssuer.issuerBaseUrl, "http://localhost:8091", person, selectedConsent);
    expect(selectedTicket.authorization.access.scopes).toEqual([
      "patient/Observation.rs?category=http://terminology.hl7.org/CodeSystem/observation-category|laboratory",
      "patient/Patient.rs",
    ]);
    expect(selectedResourceTypes(selectedConsent)).toEqual(["Observation", "Patient"]);
  });

  test("selected smart scopes can mix observation and condition granular categories", () => {
    const consent = defaultConsentState(person);
    consent.resourceScopeMode = "selected";
    consent.scopeSelections = {
      "patient/Observation.rs?category=http://terminology.hl7.org/CodeSystem/observation-category|laboratory": true,
      "patient/Observation.rs?category=http://terminology.hl7.org/CodeSystem/observation-category|vital-signs": true,
      "patient/Condition.rs?category=http://terminology.hl7.org/CodeSystem/condition-category|problem-list-item": true,
    };

    expect(selectedSmartScopes(consent)).toEqual([
      "patient/Condition.rs?category=http://terminology.hl7.org/CodeSystem/condition-category|problem-list-item",
      "patient/Observation.rs?category=http://terminology.hl7.org/CodeSystem/observation-category|laboratory",
      "patient/Observation.rs?category=http://terminology.hl7.org/CodeSystem/observation-category|vital-signs",
    ]);
  });

  test("scope options are grouped by US Core resource and granular category shape", () => {
    const shapedPerson: PersonInfo = {
      ...person,
      resourceCounts: {
        ...person.resourceCounts,
        Condition: 4,
      },
    };

    const groups = scopeOptionsForPerson(shapedPerson);
    expect(groups.map((group) => group.label)).toEqual([
      "Foundational record scopes",
      "Clinical resource scopes",
      "Observation categories",
      "Condition categories",
    ]);

    expect(groups.find((group) => group.id === "observation")?.options.map((option) => option.scope)).toEqual([
      "patient/Observation.rs?category=http://terminology.hl7.org/CodeSystem/observation-category|laboratory",
      "patient/Observation.rs?category=http://terminology.hl7.org/CodeSystem/observation-category|vital-signs",
      "patient/Observation.rs?category=http://terminology.hl7.org/CodeSystem/observation-category|social-history",
      "patient/Observation.rs?category=http://terminology.hl7.org/CodeSystem/observation-category|survey",
      "patient/Observation.rs?category=http://hl7.org/fhir/us/core/CodeSystem/us-core-category|sdoh",
    ]);

    expect(groups.find((group) => group.id === "condition")?.options.map((option) => option.scope)).toEqual([
      "patient/Condition.rs?category=http://terminology.hl7.org/CodeSystem/condition-category|problem-list-item",
      "patient/Condition.rs?category=http://terminology.hl7.org/CodeSystem/condition-category|encounter-diagnosis",
      "patient/Condition.rs?category=http://hl7.org/fhir/us/core/CodeSystem/condition-category|health-concern",
    ]);
  });

  test("ticket payload uses the issuer base URL and audience origin", () => {
    const ticket = buildTicketPayload(ticketIssuer.issuerBaseUrl, "http://localhost:8091", person, defaultConsentState(person), { proofJkt: "demo-proof" });
    expect(ticket.iss).toBe(ticketIssuer.issuerBaseUrl);
    expect(ticket.aud).toBe("http://localhost:8091");
    expect(ticket.cnf).toEqual({ jkt: "demo-proof" });
  });

  test("copied curls inline the actual bearer token and proof header", () => {
    expect(buildFetchCurl("http://localhost:8091/fhir/Patient?_count=20", "abc123", "proof-1")).toBe(
      "curl -H 'authorization: Bearer abc123' -H 'x-client-jkt: proof-1' 'http://localhost:8091/fhir/Patient?_count=20'",
    );
  });
});
