/** Whether a `GARMIN_APP_OFFERS` value offers wellness. Unset offers what the bridge offers by default, which isn't it. */
export function offersWellness(offers) {
  return typeof offers === "string" && offers.split(",").map((name) => name.trim()).includes("wellness");
}
