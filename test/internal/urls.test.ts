import { describe, expect, it } from "vitest";
import { offersWellness, urlsToPaste } from "../../scripts/lib/urls.mjs";
import { garmin } from "../../src/providers/garmin";

const webhooks = (offers?: { wellness: boolean }) =>
  urlsToPaste("https://bridge.test", "secret", offers)
    .flatMap((place) => place.urls)
    .filter((entry) => entry.check === "webhook")
    .map((entry) => entry.url.split("/").at(-1));

describe("npm run urls", () => {
  it("lists exactly the webhooks the provider takes, for an app that offers wellness", () => {
    const provider = garmin({ env: {} as never, fetch, now: () => 0 });
    expect(webhooks({ wellness: true }).sort()).toEqual([...provider.webhookKinds].sort());
  });

  it("leaves the health rows out for an app that doesn't offer wellness", () => {
    expect(webhooks()).toEqual(["activity-files", "user-permissions", "deregistrations"]);
  });

  it.each([
    [undefined, false],
    ["activities,activity_history", false],
    ["activities, wellness", true],
    ["activities,wellnesses", false],
  ])("reads %j as %s for wellness", (offers, expected) => {
    expect(offersWellness(offers)).toBe(expected);
  });
});
