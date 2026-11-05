import type { Deps } from "../deps";
import { GARMIN_NAME, garmin } from "./garmin";
import type { Provider } from "./types";

const factories: Readonly<Record<string, (deps: Deps) => Provider>> = {
  [GARMIN_NAME]: garmin,
};

export function allProviders(deps: Deps): Provider[] {
  return Object.values(factories).map((factory) => factory(deps));
}

export function findProvider(name: string, deps: Deps): Provider | undefined {
  return Object.hasOwn(factories, name) ? factories[name]?.(deps) : undefined;
}
