import { describe, expect, test } from "bun:test";

import { PATIENT_SELF_ACCESS_TICKET_TYPE } from "../../shared/permission-tickets.ts";
import type { PermissionTicket } from "../../../shared/permission-ticket-schema.ts";
import type { ViewerResourceItem } from "./lib/viewer-model";
import { buildViewerPatientBanner, viewerPatientBannerTitle } from "./lib/viewer-patient-banner";

describe("viewer patient banner", () => {
  test("renders ticket name, DOB, and gender when present", () => {
    const banner = buildViewerPatientBanner(
      makeTicket({
        name: [{ family: "Reyes", given: ["Elena", "Marisol"] }],
        birthDate: "1989-09-14",
        gender: "female",
      }),
      [],
    );

    expect(banner.displayName).toBe("Elena Marisol Reyes");
    expect(banner.birthDate).toBe("1989-09-14");
    expect(banner.gender).toBe("female");
  });

  test("fills missing fields from a loaded Patient resource", () => {
    const banner = buildViewerPatientBanner(
      makeTicket({
        identifier: [
          {
            type: { coding: [{ code: "SS" }] },
            value: "999-99-9999",
          },
        ],
      }),
      [
        makePatientResourceItem({
          name: [{ family: "Reyes", given: ["Elena"] }],
          birthDate: "1989-09-14",
          gender: "female",
          identifier: [
            {
              type: { coding: [{ code: "MR" }] },
              value: "loaded-mr-123",
            },
          ],
        }),
      ],
    );

    expect(banner.displayName).toBe("Elena Reyes");
    expect(banner.birthDate).toBe("1989-09-14");
    expect(banner.gender).toBe("female");
    expect(banner.mrIdentifier).toBeNull();
  });

  test("does not override ticket values when a loaded Patient disagrees", () => {
    const banner = buildViewerPatientBanner(
      makeTicket({
        name: [{ family: "Reyes", given: ["Elena"] }],
        birthDate: "1989-09-14",
        gender: "female",
      }),
      [
        makePatientResourceItem({
          name: [{ family: "Walker", given: ["Denise"] }],
          birthDate: "1977-01-01",
          gender: "male",
        }),
      ],
    );

    expect(banner.displayName).toBe("Elena Reyes");
    expect(banner.birthDate).toBe("1989-09-14");
    expect(banner.gender).toBe("female");
  });

  test("renders the muted placeholder title when no name is available yet", () => {
    const banner = buildViewerPatientBanner(makeTicket({}), []);

    expect(banner.displayName).toBeNull();
    expect(banner.hasLoadedPatient).toBe(false);
    expect(viewerPatientBannerTitle(banner)).toBe("Patient record");
  });

  test("picks only an MR-coded identifier from the ticket subject", () => {
    const banner = buildViewerPatientBanner(
      makeTicket({
        identifier: [
          {
            type: { coding: [{ code: "AN" }] },
            value: "account-1",
          },
          {
            type: { coding: [{ code: "MR" }] },
            value: "mr-12345",
          },
          {
            type: { coding: [{ code: "MR" }] },
            value: "mr-99999",
          },
        ],
      }),
      [],
    );

    expect(banner.mrIdentifier).toBe("mr-12345");
  });
});

function makeTicket(patientOverrides: Record<string, any>): PermissionTicket {
  return {
    iss: "https://issuer.example",
    aud: "https://server.example",
    exp: 1760000000,
    jti: "ticket-1",
    ticket_type: PATIENT_SELF_ACCESS_TICKET_TYPE,
    subject: {
      patient: {
        resourceType: "Patient",
        ...patientOverrides,
      },
    },
    access: {
      permissions: [
        {
          kind: "data",
          resource_type: "Patient",
          interactions: ["read"],
        },
      ],
    },
  };
}

function makePatientResourceItem(patientOverrides: Record<string, any>): ViewerResourceItem {
  return {
    key: "site-a:Patient/p-1",
    siteSlug: "site-a",
    siteName: "Site A",
    siteJurisdiction: "CA",
    resourceType: "Patient",
    id: "p-1",
    label: "Patient",
    sublabel: null,
    timelineDate: null,
    encounterRef: null,
    fullUrl: null,
    resource: {
      resourceType: "Patient",
      id: "p-1",
      ...patientOverrides,
    },
  };
}
