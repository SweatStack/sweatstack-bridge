import { describe, expect, it } from "vitest";
import { offersWellness } from "../../scripts/lib/urls.mjs";

describe("npm run verify's reading of GARMIN_APP_OFFERS", () => {
  it.each([
    [undefined, false],
    ["activities,activity_history", false],
    ["activities, wellness", true],
    ["activities,wellnesses", false],
  ])("reads %j as %s for wellness", (offers, expected) => {
    expect(offersWellness(offers)).toBe(expected);
  });
});
