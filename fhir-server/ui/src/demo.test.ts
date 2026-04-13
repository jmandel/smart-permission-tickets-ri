import { describe, expect, test } from "bun:test";

import {
  buildViewerClientPlan,
  buildFetchCurl,
  buildTicketPayload,
  buildViewerLaunch,
  buildViewerLaunchUrl,
  clientBindingForPlan,
  chooseNetworkAuthSurface,
  chooseSiteAuthSurface,
  constrainedSites,
  decodeViewerLaunch,
  defaultConsentState,
  describeClientOption,
  describeClientPlan,
  describeTicketBinding,
  isConsentValid,
  proofJktForPlan,
  scopeOptionsForPerson,
  selectedResourceTypes,
  selectedSmartScopes,
  validateConsent,
} from "./demo";
import type { DemoClientOption, NetworkInfo, PersonInfo, TicketIssuerInfo } from "./types";

const person: PersonInfo = {
  personId: "elena-reyes",
  patientSlug: "elena-reyes",
  displayName: "Elena Reyes",
  familyName: "Reyes",
  givenNames: ["Elena"],
  birthDate: "1989-09-14",
  gender: "female",
  summary: "Synthetic test patient",
  ticketScenarios: [],
  useCases: [],
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
  name: "Provider Network",
};

const wellKnownOption: DemoClientOption = {
  type: "well-known",
  label: "Well-known client",
  description: "Framework-affiliated implicit client",
  registrationMode: "implicit-well-known",
  framework: {
    uri: "https://smarthealthit.org/trust-frameworks/reference-demo-well-known",
    displayName: "Reference Demo Well-Known Clients",
  },
  entityUri: "http://localhost:8091/demo/clients/well-known-alpha",
  clientName: "Northwind Care Viewer",
  publicJwk: {
    kty: "EC",
    crv: "P-256",
    x: "gwA5e-J9PsxXXZ8arlndCk8-tqiJ3Ye0_BdBTVfvahQ",
    y: "mkjjr7GMPWB26IpuJJKsq7TkhszYr4WQID2SH8CPDbQ",
  },
  privateJwk: {
    kty: "EC",
    crv: "P-256",
    x: "gwA5e-J9PsxXXZ8arlndCk8-tqiJ3Ye0_BdBTVfvahQ",
    y: "mkjjr7GMPWB26IpuJJKsq7TkhszYr4WQID2SH8CPDbQ",
    d: "DaNuMMgobU757Zs4zr8PJFl6QnrBozHRFqT917WP0QE",
  },
};

const udapOption: DemoClientOption = {
  type: "udap",
  label: "UDAP client",
  description: "Just-in-time UDAP registration",
  registrationMode: "udap-dcr",
  framework: {
    uri: "https://smarthealthit.org/trust-frameworks/reference-demo-udap",
    displayName: "Reference Demo UDAP Community",
    documentUrl: "http://localhost:8091/.well-known/udap",
  },
  entityUri: "http://localhost:8091/demo/clients/udap/sample-client",
  clientName: "Reference Demo RSA UDAP Client",
  scope: "system/Patient.rs",
  contacts: ["mailto:ops@example.org"],
  algorithm: "RS256",
  certificatePem: "-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----",
  privateKeyPem: "-----BEGIN PRIVATE KEY-----\nMIIB\n-----END PRIVATE KEY-----",
};

const oidfOption: DemoClientOption = {
  type: "oidf",
  label: "OIDF client",
  description: "Browser-generated subordinate OIDF client",
  registrationMode: "oidf-automatic",
  framework: {
    uri: "https://smarthealthit.org/trust-frameworks/reference-demo-oidf",
    displayName: "Reference Demo OpenID Federation",
    documentUrl: "http://localhost:8091/federation/anchor/.well-known/openid-federation",
  },
  entityUri: "http://localhost:8091/demo/clients/oidf/worldwide-app",
  entityConfigurationUrl: "http://localhost:8091/demo/clients/oidf/worldwide-app/.well-known/openid-federation",
  browserInstanceBaseUri: "http://localhost:8091/demo/clients/oidf/worldwide-app/instances",
  browserInstanceIssuePath: "/demo/clients/oidf/issue-browser-instance",
  clientName: "Reference Demo OIDF Client",
};

const scenarioPerson: PersonInfo = {
  ...person,
  ticketScenarios: [
    {
      id: "public-health",
      label: "Public health investigation",
      summary: "Focused scenario for testing requester, context, and access projection.",
      ticket: {
        ticket_type: "https://smarthealthit.org/permission-ticket-type/public-health-investigation-v1",
        requester: {
          resourceType: "Organization",
          name: "County Public Health"
        },
        context: {
          reportable_condition: {
            text: "Tuberculosis"
          }
        },
        access: {
          permissions: [
            {
              kind: "data",
              resource_type: "Patient",
              interactions: ["read", "search"],
            },
            {
              kind: "data",
              resource_type: "DiagnosticReport",
              interactions: ["read", "search"],
            },
            {
              kind: "data",
              resource_type: "DocumentReference",
              interactions: ["read", "search"],
            },
          ],
          data_period: {
            start: "2023-01-01",
            end: "2025-12-31",
          },
          data_holder_filter: [
            {
              kind: "organization",
              organization: {
                resourceType: "Organization",
                name: "Eastbay Primary Care Associates",
              },
            },
            {
              kind: "organization",
              organization: {
                resourceType: "Organization",
                name: "Bay Area Rheumatology Associates",
              },
            },
          ],
          sensitive_data: "include",
        },
      },
    },
  ],
};

describe("demo helpers", () => {
  test("default consent enables every resource type present for the patient", () => {
    const consent = defaultConsentState(person);
    expect(consent.resourceScopeMode).toBe("all");
    expect(consent.locationMode).toBe("all");
    expect(consent.dateMode).toBe("all");
    expect(selectedResourceTypes(consent)).toEqual(["*"]);
  });

  test("scenario defaults project ticket access into editable consent state", () => {
    const consent = defaultConsentState(scenarioPerson, scenarioPerson.ticketScenarios[0]);
    expect(consent.resourceScopeMode).toBe("selected");
    expect(consent.scopeSelections["patient/Patient.rs"]).toBe(true);
    expect(consent.scopeSelections["patient/DiagnosticReport.rs"]).toBe(true);
    expect(consent.scopeSelections["patient/DocumentReference.rs"]).toBe(true);
    expect(consent.locationMode).toBe("organizations");
    expect(consent.selectedSiteSlugs["eastbay-primary-care-associates"]).toBe(true);
    expect(consent.selectedSiteSlugs["bay-area-rheumatology-associates"]).toBe(true);
    expect(consent.dateMode).toBe("window");
    expect(consent.dateRange).toEqual({ start: "2023-01-01", end: "2025-12-31" });
    expect(consent.sensitiveMode).toBe("allow");
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
    const clientPlan = {
      type: "unaffiliated" as const,
      displayLabel: "Unaffiliated registered client",
      registrationMode: "dynamic-jwk" as const,
      clientName: "Viewer client for Elena Reyes",
      publicJwk: {
        kty: "EC",
        crv: "P-256",
        x: "gwA5e-J9PsxXXZ8arlndCk8-tqiJ3Ye0_BdBTVfvahQ",
        y: "mkjjr7GMPWB26IpuJJKsq7TkhszYr4WQID2SH8CPDbQ",
      },
      privateJwk: {
        kty: "EC",
        crv: "P-256",
        x: "gwA5e-J9PsxXXZ8arlndCk8-tqiJ3Ye0_BdBTVfvahQ",
        y: "mkjjr7GMPWB26IpuJJKsq7TkhszYr4WQID2SH8CPDbQ",
        d: "DaNuMMgobU757Zs4zr8PJFl6QnrBozHRFqT917WP0QE",
      },
      jwkThumbprint: "thumb-1",
    };
    const launch = buildViewerLaunch(
      "session-1",
      "http://localhost:8091",
      "registered",
      person,
      network,
      ticketIssuer,
      ticketPayload,
      "signed-ticket",
      null,
      clientPlan,
      {
        dateSummary: "All dates",
        sensitiveSummary: "Sensitive excluded",
        expirySummary: "1 hour",
        bindingSummary: "Proof key",
        clientLabel: clientPlan.displayLabel,
      },
    );
    const roundTrip = decodeViewerLaunch(new URL(buildViewerLaunchUrl(launch), "http://localhost:8091").searchParams.get("session")!);

    expect(roundTrip.network.slug).toBe("reference");
    expect(roundTrip.network.authSurface.kind).toBe("network");
    expect(roundTrip.network.authSurface.fhirBasePath).toBe("/modes/registered/networks/reference/fhir");
    expect(roundTrip.clientPlan?.type).toBe("unaffiliated");
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
    expect(ticket.access.data_holder_filter).toEqual([
      { kind: "jurisdiction", address: { state: "TX" } },
    ]);
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
    expect(ticket.access.data_holder_filter).toEqual([
      {
        kind: "organization",
        organization: {
          resourceType: "Organization",
          identifier: [
            {
              system: "http://hl7.org/fhir/sid/us-npi",
              value: "2222222222",
            },
          ],
          name: "Eastbay Primary Care Associates",
        },
      },
    ]);
    expect(constrainedSites(person, consent).map((site) => site.siteSlug)).toEqual(["eastbay-primary-care-associates"]);
  });

  test("ticket payload supports bounded and long-lived demo ticket lifetimes", () => {
    const oneYearConsent = defaultConsentState(person);
    oneYearConsent.ticketLifetime = "1y";
    const oneYearTicket = buildTicketPayload(ticketIssuer.issuerBaseUrl, "http://localhost:8091", person, oneYearConsent);
    expect(typeof oneYearTicket.exp).toBe("number");
    expect((oneYearTicket.exp ?? 0) - Math.floor(Date.now() / 1000)).toBeGreaterThan(60 * 60 * 24 * 364);

    const neverConsent = defaultConsentState(person);
    neverConsent.ticketLifetime = "never";
    const neverTicket = buildTicketPayload(ticketIssuer.issuerBaseUrl, "http://localhost:8091", person, neverConsent);
    expect(typeof neverTicket.exp).toBe("number");
    expect((neverTicket.exp ?? 0) - Math.floor(Date.now() / 1000)).toBeGreaterThan(60 * 60 * 24 * 365 * 9);
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
    expect(allTicket.access.permissions).toEqual([
      {
        kind: "data",
        resource_type: "*",
        interactions: ["read", "search"],
      },
    ]);

    const selectedConsent = defaultConsentState(person);
    selectedConsent.resourceScopeMode = "selected";
    selectedConsent.scopeSelections = {
      "patient/Patient.rs": true,
      "patient/Observation.rs?category=http://terminology.hl7.org/CodeSystem/observation-category|laboratory": true,
      "patient/Observation.rs?category=http://terminology.hl7.org/CodeSystem/observation-category|vital-signs": false,
    };
    const selectedTicket = buildTicketPayload(ticketIssuer.issuerBaseUrl, "http://localhost:8091", person, selectedConsent);
    expect(selectedTicket.access.permissions).toEqual([
      {
        kind: "data",
        resource_type: "Observation",
        interactions: ["read", "search"],
        category_any_of: [{
          system: "http://terminology.hl7.org/CodeSystem/observation-category",
          code: "laboratory",
        }],
      },
      {
        kind: "data",
        resource_type: "Patient",
        interactions: ["read", "search"],
      },
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
    expect(typeof ticket.jti).toBe("string");
    expect(ticket.presenter_binding).toEqual({ method: "jkt", jkt: "demo-proof" });
    expect(ticket.subject.patient.resourceType).toBe("Patient");
    expect(ticket.access.sensitive_data).toBe("exclude");
    expect(ticket.context).toBeUndefined();
  });

  test("ticket payload merges runtime fields onto a scenario fragment", () => {
    const scenario = scenarioPerson.ticketScenarios[0];
    const consent = defaultConsentState(scenarioPerson, scenario);
    const ticket = buildTicketPayload(ticketIssuer.issuerBaseUrl, "http://localhost:8091", scenarioPerson, consent, {
      scenario,
      proofJkt: "demo-proof",
    });

    expect(ticket.ticket_type).toBe("https://smarthealthit.org/permission-ticket-type/public-health-investigation-v1");
    expect(ticket.requester as any).toEqual((scenario.ticket as any).requester);
    expect(ticket.context).toEqual(scenario.ticket.context);
    expect(ticket.presenter_binding).toEqual({ method: "jkt", jkt: "demo-proof" });
    expect(ticket.access.data_period).toEqual({ start: "2023-01-01", end: "2025-12-31" });
    expect(ticket.access.sensitive_data).toBe("include");
    expect(ticket.access.data_holder_filter).toHaveLength(2);
  });

  test("well-known client plan drives framework presenter binding without jkt binding", async () => {
    const clientPlan = await buildViewerClientPlan(person, wellKnownOption);
    expect(clientPlan.type).toBe("well-known");
    expect(clientBindingForPlan(clientPlan)).toEqual({
      method: "trust_framework_client",
      trust_framework: "https://smarthealthit.org/trust-frameworks/reference-demo-well-known",
      framework_type: "well-known",
      entity_uri: "http://localhost:8091/demo/clients/well-known-alpha",
    });
    expect(proofJktForPlan("strict", clientPlan)).toBeNull();
  });

  test("client story description explains well-known framework binding", () => {
    const story = describeClientOption("strict", wellKnownOption);
    expect(story.registrationLabel).toBe("Implicit");
    expect(story.authenticationLabel).toBe("private_key_jwt with current entity JWKS");
    expect(story.effectiveClientId).toBe("well-known:http://localhost:8091/demo/clients/well-known-alpha");
    expect(story.ticketBinding.shape).toBe("presenter_binding.method=trust_framework_client");
    expect(story.whatThisDemonstrates).toContain("skip registration entirely");
  });

  test("client story description explains unaffiliated strict binding", async () => {
    const unaffiliatedPlan = await buildViewerClientPlan(person, {
      type: "unaffiliated",
      label: "Unaffiliated registered client",
      description: "One-off client",
      registrationMode: "dynamic-jwk",
    });
    const story = describeClientPlan("strict", unaffiliatedPlan, "client-123");
    expect(story.effectiveClientId).toBe("client-123");
    expect(story.ticketBinding.shape).toBe("presenter_binding.method=jkt");
    expect(story.ticketBinding.rationale).toContain("generated JWK thumbprint");
  });

  test("client story description uses the generated OIDF browser instance entity URI", async () => {
    const oidfPlan = await buildViewerClientPlan(person, oidfOption);
    expect(oidfPlan.type).toBe("oidf");
    if (oidfPlan.type !== "oidf") throw new Error("Expected OIDF client plan");
    const story = describeClientPlan("strict", oidfPlan);
    expect(story.effectiveClientId).toBe(oidfPlan.entityUri);
    expect(story.entityUri).toBe(oidfPlan.entityUri);
  });

  test("client story description explains UDAP SAN-based entity binding", () => {
    const story = describeClientOption("strict", udapOption);
    expect(story.registrationLabel).toBe("UDAP DCR");
    expect(story.authenticationLabel).toContain("SAN entity URI");
    expect(story.entityUri).toBe("http://localhost:8091/demo/clients/udap/sample-client");
    expect(story.whatThisDemonstrates).toContain("Subject Alternative Name");
    expect(story.ticketBinding.shape).toBe("presenter_binding.method=trust_framework_client");
  });

  test("ticket binding description distinguishes proof and framework binding", () => {
    expect(describeTicketBinding("strict", "unaffiliated", "<jkt>", null).shape).toBe("presenter_binding.method=jkt");
    expect(
      describeTicketBinding("strict", "well-known", null, {
        method: "trust_framework_client",
        trust_framework: "https://smarthealthit.org/trust-frameworks/reference-demo-well-known",
        framework_type: "well-known",
        entity_uri: "http://localhost:8091/demo/clients/well-known-alpha",
      }).shape,
    ).toBe("presenter_binding.method=trust_framework_client");
  });

  test("copied curls inline the actual bearer token and proof header", () => {
    expect(buildFetchCurl("http://localhost:8091/fhir/Patient?_count=20", "abc123", "proof-1")).toBe(
      "curl -H 'authorization: Bearer abc123' -H 'x-client-jkt: proof-1' 'http://localhost:8091/fhir/Patient?_count=20'",
    );
  });
});
