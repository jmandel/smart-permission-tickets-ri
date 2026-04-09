import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { TicketReadonlyPanel } from "./components/TicketReadonlyPanel";
import type { DemoTicketScenario } from "../../../shared/demo-ticket-scenarios";

const scenario: DemoTicketScenario = {
  id: "tb-investigation",
  label: "Tuberculosis investigation",
  summary: "Public health follow-up for an active pulmonary TB case.",
  ticket: {
    ticket_type: "https://smarthealthit.org/permission-ticket-type/public-health-investigation-v1",
    requester: {
      resourceType: "Organization",
      name: "Illinois Department of Public Health",
      identifier: [
        {
          system: "http://hl7.org/fhir/sid/us-npi",
          value: "1234567893",
        },
      ],
    },
    context: {
      reportable_condition: {
        text: "Tuberculosis",
        coding: [
          {
            system: "http://snomed.info/sct",
            code: "56717001",
            display: "Tuberculosis",
          },
        ],
      },
    },
    access: {
      permissions: [
        {
          kind: "data",
          resource_type: "Patient",
          interactions: ["read", "search"],
        },
      ],
      sensitive_data: "exclude",
    },
  },
};

describe("TicketReadonlyPanel", () => {
  test("renders fixed ticket claims as read-only form content", () => {
    const html = renderToStaticMarkup(<TicketReadonlyPanel scenario={scenario} />);

    expect(html).toContain("Included In Ticket");
    expect(html).toContain("Read-only claims from the selected scenario");
    expect(html).toContain("ticket_type");
    expect(html).toContain("https://smarthealthit.org/permission-ticket-type/public-health-investigation-v1");
    expect(html).toContain("Illinois Department of Public Health");
    expect(html).toContain("http://hl7.org/fhir/sid/us-npi");
    expect(html).toContain("1234567893");
    expect(html).toContain("Tuberculosis");
    expect(html).toContain("http://snomed.info/sct");
    expect(html).toContain("56717001");
    expect(html).toContain("identifier");
  });
});
