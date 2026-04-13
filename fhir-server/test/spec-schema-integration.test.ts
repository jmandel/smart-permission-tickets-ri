import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

import { PATIENT_SELF_ACCESS_TICKET_TYPE } from "../shared/permission-tickets.ts";
import { PermissionTicketSchema } from "../../shared/permission-ticket-schema.ts";

describe("spec-owned Permission Ticket schema", () => {
  test("parses the current trust-framework-bound ticket shape inside the reference implementation", () => {
    const parsed = PermissionTicketSchema.parse({
      iss: "https://issuer.example.org",
      aud: "https://example.org/frameworks/smart-health-issuers",
      aud_type: "trust_framework",
      exp: Math.floor(Date.now() / 1000) + 3600,
      jti: "ticket-example-001",
      ticket_type: PATIENT_SELF_ACCESS_TICKET_TYPE,
      presenter_binding: {
        method: "trust_framework_client",
        trust_framework: "https://example.org/frameworks/smart-health-issuers",
        framework_type: "oidf",
        entity_uri: "https://client.example.org/browser/instance-123",
      },
      subject: {
        patient: {
          resourceType: "Patient",
          identifier: [{ system: "urn:example:mrn", value: "12345" }],
        },
      },
      access: {
        permissions: [{ kind: "data", resource_type: "Patient", interactions: ["read", "search"] }],
        data_holder_filter: [
          { kind: "jurisdiction", address: { state: "CA" } },
          {
            kind: "organization",
            organization: {
              resourceType: "Organization",
              identifier: [{ system: "http://hl7.org/fhir/sid/us-npi", value: "1234567890" }],
            },
          },
        ],
        sensitive_data: "exclude",
      },
    });

    expect(parsed.aud_type).toBe("trust_framework");
    expect(parsed.presenter_binding?.method).toBe("trust_framework_client");
    expect(parsed.access.data_holder_filter).toHaveLength(2);
  });

  test("the local shared schema module remains a pure re-export shim", () => {
    const shim = readFileSync(new URL("../../shared/permission-ticket-schema.ts", import.meta.url), "utf8").trim();
    expect(shim).toBe('export * from "./spec-permission-ticket-schema.ts";');
  });
});
