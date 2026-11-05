import { describe, expect, it } from "vitest";
import { customDomain, urlsToPaste } from "../../scripts/lib/urls.mjs";
import { garmin } from "../../src/providers/garmin";

describe("npm run urls", () => {
  it("lists exactly the webhooks the provider takes", () => {
    const provider = garmin({ env: {} as never, fetch, now: () => 0 });
    const listed = urlsToPaste("https://bridge.test", "secret")
      .flatMap((place) => place.urls)
      .filter((entry) => entry.check === "webhook")
      .map((entry) => entry.url.split("/").at(-1));
    expect(listed.sort()).toEqual([...provider.webhookKinds].sort());
  });

  it("prefers a custom domain, and ignores a route that isn't one", () => {
    expect(customDomain(undefined)).toBeNull();
    expect(customDomain(["example.com/*", { pattern: "zone.example/*", zone_name: "zone.example" }])).toBeNull();
    expect(customDomain([{ pattern: "bridge.example", custom_domain: true }])).toBe("https://bridge.example");
  });
});
