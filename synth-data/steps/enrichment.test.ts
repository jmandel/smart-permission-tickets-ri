import { describe, expect, test } from "bun:test";

import {
  DEMO_TICKET_SCENARIOS_EXTENSION_URL,
  parseDemoTicketScenarioBundle,
} from "../../shared/demo-ticket-scenarios.ts";
import {
  PATIENT_SUMMARY_EXTENSION_URL,
  loadEnrichmentContext,
  enrichResource,
} from "./enrichment.ts";

const ROBERT_DAVIS_DIR = new URL("../patients/robert-davis", import.meta.url).pathname;

describe("enrichment", () => {
  test("loads scenario defaults from the patient-root ticket-scenarios file", async () => {
    const context = await loadEnrichmentContext(ROBERT_DAVIS_DIR);
    expect(typeof context.patientSummary).toBe("string");
    expect(typeof context.ticketScenariosJson).toBe("string");

    const parsed = parseDemoTicketScenarioBundle(JSON.parse(context.ticketScenariosJson!));
    expect(parsed.scenarios[0]?.id).toBe("tb-public-health-investigation");
    expect(parsed.scenarios[0]?.ticket.ticket_type).toBe(
      "https://smarthealthit.org/permission-ticket-type/public-health-investigation-v1",
    );
  });

  test("injects both summary markdown and serialized scenario JSON onto Patient resources", async () => {
    const context = await loadEnrichmentContext(ROBERT_DAVIS_DIR);
    const patient = enrichResource({ resourceType: "Patient", id: "example-patient" }, context, "university-of-illinois-hospital");
    const summary = patient.extension.find((entry: any) => entry.url === PATIENT_SUMMARY_EXTENSION_URL);
    const scenarios = patient.extension.find((entry: any) => entry.url === DEMO_TICKET_SCENARIOS_EXTENSION_URL);

    expect(typeof summary?.valueMarkdown).toBe("string");
    expect(typeof scenarios?.valueString).toBe("string");
    expect(parseDemoTicketScenarioBundle(JSON.parse(scenarios.valueString)).scenarios).toHaveLength(1);
  });
});
