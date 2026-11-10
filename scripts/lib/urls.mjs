/**
 * Where the owner of a bridge pastes each URL, per platform, in the words of the tool they paste it in.
 * Garmin's settings are named and ordered as its endpoint configuration lists them, so the owner can go
 * down the page. The health ones are only for an app that offers wellness: anyone else leaves them disabled.
 * @param {{ wellness?: boolean }} [offers]
 * @returns {{ where: string, urls: { setting: string, url: string, check?: "discovery" | "webhook" }[] }[]}
 */
export function urlsToPaste(origin, webhookSecret, { wellness = false } = {}) {
  const provider = "garmin_connect";
  const webhook = (kind) => `${origin}/${provider}/${webhookSecret}/${kind}`;
  const endpoints = [
    { setting: "ACTIVITY - Activity Files", url: webhook("activity-files"), check: "webhook" },
    { setting: "COMMON - Deregistrations", url: webhook("deregistrations"), check: "webhook" },
    { setting: "COMMON - User Permissions Change", url: webhook("user-permissions"), check: "webhook" },
    ...(wellness
      ? [
          { setting: "HEALTH - Body Compositions", url: webhook("body-compositions"), check: "webhook" },
          { setting: "HEALTH - Dailies", url: webhook("dailies"), check: "webhook" },
          { setting: "HEALTH - HRV Summary", url: webhook("hrv"), check: "webhook" },
          { setting: "HEALTH - Sleeps", url: webhook("sleeps"), check: "webhook" },
        ]
      : []),
  ];
  const count = wellness ? "seven" : "three";
  return [
    {
      where: "SweatStack: your app's Data sources tab, Self-hosted on the Garmin card",
      urls: [{ setting: "Issuer URL", url: `${origin}/oidc/${provider}`, check: "discovery" }],
    },
    {
      where: "Garmin's developer portal: your app's settings",
      urls: [{ setting: "OAuth 2 redirect URL", url: `${origin}/callback/${provider}` }],
    },
    {
      where:
        "Garmin's endpoint configuration: https://apis.garmin.com/tools/endpoints, signed in with your consumer key and secret.\n" +
        `Enable these ${count} and leave every other setting disabled`,
      urls: endpoints,
    },
  ];
}

/** Whether a `GARMIN_APP_OFFERS` value offers wellness. Unset offers what the bridge offers by default, which isn't it. */
export function offersWellness(offers) {
  return typeof offers === "string" && offers.split(",").map((name) => name.trim()).includes("wellness");
}
