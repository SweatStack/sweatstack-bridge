import type { Context as HonoContext } from "hono";
import type { Config } from "./config";
import type { Database } from "./db";
import type { Deps } from "./deps";
import type { Provider } from "./providers/types";

/** What a request for one platform has, once the bridge knows it can serve that platform. */
export interface PlatformVariables {
  deps: Deps;
  db: Database;
  config: Config;
  provider: Provider;
  /** This platform's issuer URL, derived from the address the request arrived at. */
  issuer: string;
  /** Where the platform sends the browser back to. */
  callbackUrl: string;
}

export type PlatformContext = HonoContext<{ Variables: PlatformVariables }>;

/** The redirect URI SweatStack registers: its own tenant callback, computed and never taken on trust. */
export function sweatstackRedirectUri(config: Config, provider: Provider): string {
  return `${config.sweatstackUrl}/api/v1/tenants/${config.appId}/integration-providers/${provider.name}/oauth2-authorization-callback`;
}

/** For any answer that holds a token or a secret. */
export const NO_STORE = { "Cache-Control": "no-store", Pragma: "no-cache" } as const;

/** The standard error redirect to the relying party, with its `state` untouched (RFC 6749 4.1.2.1). */
export function errorRedirect(redirectUri: string, error: string, state?: string): string {
  const url = new URL(redirectUri);
  url.searchParams.set("error", error);
  if (state !== undefined) url.searchParams.set("state", state);
  return url.toString();
}
