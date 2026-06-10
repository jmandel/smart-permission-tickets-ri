import { describe, expect, test } from "bun:test";

import { allowsGeneratedEncounterFallback, extractConfiguredGeneratedWindow } from "../src/store/generated-date.ts";

// data_period enforcement uses one designated date element per resource type
// (the spec's Data Period Enforcement table). No fallbacks: a resource with
// no value in its designated element does not match any window.
describe("designated date extraction", () => {
  test("Condition uses recordedDate, not onset", () => {
    const withBoth = extractConfiguredGeneratedWindow({
      resourceType: "Condition",
      onsetDateTime: "2010-01-01",
      abatementDateTime: "2012-01-01",
      recordedDate: "2024-03-05",
    });
    expect(withBoth.generatedStart).toBe("2024-03-05");
    expect(withBoth.generatedSourceRule).toBe("Condition.recordedDate");

    const onsetOnly = extractConfiguredGeneratedWindow({
      resourceType: "Condition",
      onsetDateTime: "2010-01-01",
    });
    expect(onsetOnly.generatedStart).toBeNull();
    expect(onsetOnly.generatedSourceKind).toBe("missing");
  });

  test("Observation uses effective[x]; issued alone no longer counts", () => {
    const effective = extractConfiguredGeneratedWindow({
      resourceType: "Observation",
      effectiveDateTime: "2024-05-01",
      issued: "2024-05-03",
    });
    expect(effective.generatedStart).toBe("2024-05-01");

    const issuedOnly = extractConfiguredGeneratedWindow({
      resourceType: "Observation",
      issued: "2024-05-03",
    });
    expect(issuedOnly.generatedStart).toBeNull();
    expect(issuedOnly.generatedSourceKind).toBe("missing");
  });

  test("MedicationRequest uses authoredOn", () => {
    const window = extractConfiguredGeneratedWindow({
      resourceType: "MedicationRequest",
      authoredOn: "2023-11-20",
    });
    expect(window.generatedStart).toBe("2023-11-20");
    expect(window.generatedSourceRule).toBe("MedicationRequest.authoredOn");
  });

  test("Encounter uses period with start and end", () => {
    const window = extractConfiguredGeneratedWindow({
      resourceType: "Encounter",
      period: { start: "2024-01-10", end: "2024-01-12" },
    });
    expect(window.generatedStart).toBe("2024-01-10");
    expect(window.generatedEnd).toBe("2024-01-12");
  });

  test("AllergyIntolerance uses recordedDate", () => {
    const window = extractConfiguredGeneratedWindow({
      resourceType: "AllergyIntolerance",
      recordedDate: "2022-08-15",
      onsetDateTime: "1999-01-01",
    });
    expect(window.generatedStart).toBe("2022-08-15");
  });

  test("encounter fallback is disabled for every resource type", () => {
    for (const resourceType of [
      "Observation",
      "DiagnosticReport",
      "DocumentReference",
      "Procedure",
      "MedicationRequest",
      "Condition",
      "Immunization",
      "ServiceRequest",
      "AllergyIntolerance",
    ]) {
      expect(allowsGeneratedEncounterFallback(resourceType)).toBe(false);
    }
  });

  test("resource types without a designated element yield no window", () => {
    const window = extractConfiguredGeneratedWindow({
      resourceType: "Coverage",
      period: { start: "2024-01-01", end: "2024-12-31" },
    });
    expect(window.generatedStart).toBeNull();
    expect(window.generatedSourceKind).toBe("missing");
  });
});
