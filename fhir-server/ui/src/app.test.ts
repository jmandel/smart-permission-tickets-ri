import { describe, expect, test } from "bun:test";

import { nextSelectedUseCaseKey } from "./use-case-filter";

describe("use case filter toggle", () => {
  test("selects a use case when none is active", () => {
    expect(nextSelectedUseCaseKey(null, "uc3")).toBe("uc3");
  });

  test("switches to a different use case when another is clicked", () => {
    expect(nextSelectedUseCaseKey("uc3", "uc5")).toBe("uc5");
  });

  test("clears the filter when the active use case is clicked again", () => {
    expect(nextSelectedUseCaseKey("uc3", "uc3")).toBeNull();
  });
});
