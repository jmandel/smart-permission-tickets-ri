import { describe, expect, test } from "bun:test";

import { resourcePrimaryDisplay } from "./resource-display.ts";

describe("resource display", () => {
  test("renders practitioner names from HumanName", () => {
    expect(
      resourcePrimaryDisplay({
        resourceType: "Practitioner",
        id: "abc",
        name: [{ given: ["James"], family: "Tran" }],
      }),
    ).toBe("James Tran");
  });

  test("renders organization and location names from name", () => {
    expect(
      resourcePrimaryDisplay({
        resourceType: "Organization",
        id: "org-1",
        name: "Bay Area Rheumatology Associates",
      }),
    ).toBe("Bay Area Rheumatology Associates");

    expect(
      resourcePrimaryDisplay({
        resourceType: "Location",
        id: "loc-1",
        name: "Telegraph Ave Clinic",
      }),
    ).toBe("Telegraph Ave Clinic");
  });

  test("falls back to resource type and id only when nothing better exists", () => {
    expect(
      resourcePrimaryDisplay({
        resourceType: "Practitioner",
        id: "abc123",
      }),
    ).toBe("Practitioner/abc123");
  });
});
