import type { Provider } from "./types";

export const garmin: Provider = {
  name: "garmin_connect",
  label: "Garmin Connect",
  requiredSettings: ["GARMIN_CLIENT_ID", "GARMIN_CLIENT_SECRET"],
};
