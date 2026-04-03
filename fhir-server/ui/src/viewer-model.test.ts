import { describe, expect, test } from "bun:test";

import { buildArtifactHull, buildEncounterDashboard, summarizeSiteResources } from "./lib/viewer-model";
import type { ViewerLaunchSite } from "./types";

const site: ViewerLaunchSite = {
  siteSlug: "bay-area-rheumatology-associates",
  orgName: "Bay Area Rheumatology Associates",
  jurisdiction: "CA",
  patientId: "patient-1",
  authSurface: {
    kind: "site",
    siteSlug: "bay-area-rheumatology-associates",
    smartConfigPath: "/sites/bay-area-rheumatology-associates/fhir/.well-known/smart-configuration",
    registerPath: "/sites/bay-area-rheumatology-associates/register",
    tokenPath: "/sites/bay-area-rheumatology-associates/token",
    introspectPath: "/sites/bay-area-rheumatology-associates/introspect",
    fhirBasePath: "/sites/bay-area-rheumatology-associates/fhir",
    previewFhirBasePath: "/modes/anonymous/sites/bay-area-rheumatology-associates/fhir",
  },
};

describe("viewer model", () => {
  test("encounter dashboard groups resources under their encounter and leaves longitudinal items unassigned", () => {
    const resources = summarizeSiteResources(
      site,
      {
        resourceType: "Bundle",
        entry: [
          {
            resource: {
              resourceType: "Encounter",
              id: "enc-1",
              status: "finished",
              period: { start: "2025-01-10T10:00:00Z", end: "2025-01-10T11:00:00Z" },
              type: [{ text: "Follow-up Visit" }],
            },
          },
          {
            resource: {
              resourceType: "Observation",
              id: "obs-1",
              status: "final",
              encounter: { reference: "Encounter/enc-1" },
              effectiveDateTime: "2025-01-10T10:30:00Z",
              code: { text: "C-reactive protein" },
            },
          },
          {
            resource: {
              resourceType: "DocumentReference",
              id: "note-1",
              status: "current",
              context: { encounter: [{ reference: "Encounter/enc-1" }] },
              date: "2025-01-10T10:45:00Z",
              type: { text: "Progress Note" },
            },
          },
          {
            resource: {
              resourceType: "Condition",
              id: "cond-1",
              recordedDate: "2024-12-01T00:00:00Z",
              clinicalStatus: { coding: [{ code: "active" }] },
              code: { text: "Rheumatoid arthritis" },
            },
          },
        ],
      },
      null,
    );

    const dashboard = buildEncounterDashboard(resources);

    expect(dashboard.lanes).toHaveLength(1);
    expect(dashboard.encounters).toHaveLength(1);
    expect(dashboard.encounters[0]?.encounterId).toBe("Encounter/enc-1");
    expect(dashboard.encounters[0]?.resources.map((item) => item.id)).toEqual(["note-1", "obs-1"]);
    expect(dashboard.encounters[0]?.notes.map((item) => item.id)).toEqual(["note-1"]);
    expect(dashboard.encounters[0]?.resourceCounts).toEqual({
      DocumentReference: 1,
      Observation: 1,
    });
    expect(dashboard.unassignedResources.map((item) => item.id)).toEqual(["cond-1"]);
  });

  test("site resource summaries use human-friendly labels for supporting context resources", () => {
    const resources = summarizeSiteResources(
      site,
      {
        resourceType: "Bundle",
        entry: [
          {
            resource: {
              resourceType: "Practitioner",
              id: "prac-1",
              name: [{ given: ["James"], family: "Tran" }],
            },
          },
          {
            resource: {
              resourceType: "Organization",
              id: "org-1",
              name: "Bay Area Rheumatology Associates",
            },
          },
          {
            resource: {
              resourceType: "Location",
              id: "loc-1",
              name: "Telegraph Ave Clinic",
            },
          },
        ],
      },
      null,
    );

    expect(resources.map((item) => item.label)).toEqual([
      "James Tran",
      "Bay Area Rheumatology Associates",
      "Telegraph Ave Clinic",
    ]);
  });

  test("artifact hull includes same-encounter resources and notes for an encounter-bound focus", () => {
    const resources = summarizeSiteResources(
      site,
      {
        resourceType: "Bundle",
        entry: [
          {
            resource: {
              resourceType: "Encounter",
              id: "enc-1",
              status: "finished",
              period: { start: "2025-01-10T10:00:00Z", end: "2025-01-10T11:00:00Z" },
              type: [{ text: "Follow-up Visit" }],
            },
          },
          {
            resource: {
              resourceType: "DocumentReference",
              id: "note-1",
              status: "current",
              context: { encounter: [{ reference: "Encounter/enc-1" }] },
              date: "2025-01-10T10:45:00Z",
              type: { text: "Progress Note" },
            },
          },
          {
            resource: {
              resourceType: "Observation",
              id: "obs-1",
              status: "final",
              encounter: { reference: "Encounter/enc-1" },
              effectiveDateTime: "2025-01-10T10:30:00Z",
              code: { text: "C-reactive protein" },
            },
          },
        ],
      },
      null,
    );

    const dashboard = buildEncounterDashboard(resources);
    const hull = buildArtifactHull(`${site.siteSlug}:DocumentReference/note-1`, dashboard);

    expect(hull?.focus.id).toBe("note-1");
    expect(hull?.encounter?.encounter.id).toBe("enc-1");
    expect(hull?.groups.map((group) => group.label)).toEqual(["Encounter", "Notes", "Observation"]);
    expect(hull?.groups[1]?.items.map((item) => item.id)).toEqual(["note-1"]);
    expect(hull?.groups[2]?.items.map((item) => item.id)).toEqual(["obs-1"]);
  });
});
