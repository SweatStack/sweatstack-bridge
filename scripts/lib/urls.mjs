/**
 * Where the owner of a bridge pastes each URL, per platform, in the words of the tool they paste it in.
 * @returns {{ where: string, urls: { setting: string, url: string, check?: "discovery" | "webhook" }[] }[]}
 */
export function urlsToPaste(origin, webhookSecret) {
  const provider = "garmin_connect";
  const webhook = (kind) => `${origin}/${provider}/${webhookSecret}/${kind}`;
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
        "Enable these three and leave every other setting disabled",
      urls: [
        { setting: "Activity: Activity Files (ping)", url: webhook("activity-files"), check: "webhook" },
        { setting: "Common: User Permissions Change", url: webhook("user-permissions"), check: "webhook" },
        { setting: "Common: Deregistrations", url: webhook("deregistrations"), check: "webhook" },
      ],
    },
  ];
}

/** The custom domain in the Worker's configuration, if it has one. */
export function customDomain(routes = []) {
  const route = routes.find((candidate) => typeof candidate === "object" && candidate.custom_domain === true);
  return route ? `https://${route.pattern}` : null;
}
