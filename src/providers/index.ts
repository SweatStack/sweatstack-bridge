import { garmin } from "./garmin";
import type { Provider } from "./types";

const providers: readonly Provider[] = [garmin];

export function findProvider(name: string): Provider | undefined {
  return providers.find((provider) => provider.name === name);
}
