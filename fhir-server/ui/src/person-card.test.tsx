import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { PersonCard } from "./components/PersonCard";
import type { PersonInfo } from "./types";

const person: PersonInfo = {
  personId: "robert-davis",
  patientSlug: "robert-davis",
  displayName: "Robert Davis",
  familyName: "Davis",
  givenNames: ["Robert"],
  birthDate: "1960-09-14",
  gender: "male",
  summary: "Generic patient summary that should not be shown when a scenario preview is provided.",
  ticketScenarios: [],
  useCases: [
    {
      system: "https://smarthealthit.org/fhir/CodeSystem/smart-permission-ticket-use-case",
      code: "uc3",
      display: "Public Health Investigation",
    },
  ],
  resourceCounts: { Patient: 2, Encounter: 15 },
  sensitiveResourceCount: 0,
  startDate: "2026-01-22",
  endDate: "2026-04-16",
  sites: [
    {
      siteSlug: "university-of-illinois-hospital",
      orgName: "University of Illinois Hospital",
      organizationNpi: null,
      jurisdiction: "IL",
      patientId: "patient-1",
      resourceCounts: { Patient: 1, Encounter: 2 },
      sensitiveResourceCount: 0,
      startDate: "2026-01-22",
      endDate: "2026-02-10",
      encounters: [],
    },
  ],
};

describe("PersonCard", () => {
  test("renders the scenario preview instead of the generic patient summary when provided", () => {
    const html = renderToStaticMarkup(
      <PersonCard
        person={person}
        selected={false}
        onSelect={() => {}}
        scenarioPreview={{
          label: "Tuberculosis investigation",
          summary: "Illinois public health access focused on the TB episode.",
        }}
      />,
    );

    expect(html).toContain("Tuberculosis investigation");
    expect(html).toContain("Illinois public health access focused on the TB episode.");
    expect(html).not.toContain("Generic patient summary");
  });
});
