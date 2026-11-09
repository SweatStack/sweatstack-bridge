/**
 * Where the owner of a bridge pastes each URL, per platform, in the words of the tool they paste it in.
 * The health rows are only for an app that offers wellness: anyone else leaves them disabled.
 * @param {{ wellness?: boolean }} [offers]
 * @returns {{ where: string, urls: { setting: string, url: string, check?: "discovery" | "webhook" }[] }[]}
 */
export function urlsToPaste(origin, webhookSecret, { wellness = false } = {}) {
  const provider = "garmin_connect";
  const webhook = (kind) => `${origin}/${provider}/${webhookSecret}/${kind}`;
  const endpoints = [
    { setting: "Activity: Activity Files (ping)", url: webhook("activity-files"), check: "webhook" },
    { setting: "Common: User Permissions Change", url: webhook("user-permissions"), check: "webhook" },
    { setting: "Common: Deregistrations", url: webhook("deregistrations"), check: "webhook" },
    ...(wellness
      ? [
          { setting: "Health: Dailies (push)", url: webhook("dailies"), check: "webhook" },
          { setting: "Health: Sleeps (push)", url: webhook("sleeps"), check: "webhook" },
          { setting: "Health: Body Compositions (push)", url: webhook("body-compositions"), check: "webhook" },
          { setting: "Health: HRV Summary (push)", url: webhook("hrv"), check: "webhook" },
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
