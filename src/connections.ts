import type { Config } from "./config";
import type { ConnectionRow, Database } from "./db";
import type { Deps } from "./deps";
import type { Provider } from "./providers/types";
import { declareConnection as sendDeclaration } from "./sweatstack";

export interface ConnectionServices {
  config: Config;
  db: Database;
  deps: Pick<Deps, "fetch" | "now" | "sleep" | "waitUntil">;
  provider: Provider;
}

/**
 * Tells SweatStack what a connection provides, as it stands right now, and keeps the user it answers
 * with. The one function behind every such call, so duplicates and retries are harmless.
 *
 * @returns the user, or null while SweatStack doesn't know yet whose connection this is.
 */
export async function declare(services: ConnectionServices, connection: ConnectionRow): Promise<string | null> {
  const { db, provider } = services;
  const capabilities = provider.capabilityMap({
    permissions: connection.permissions === null ? null : (JSON.parse(connection.permissions) as string[]),
    needsReconnect: connection.needs_reconnect !== 0,
    backfillDone: connection.backfill_done_at !== null,
  });

  const userId = await sendDeclaration(services, {
    provider: provider.name,
    subject: connection.sub,
    capabilities,
    // Only for a call during an authorization request, and only while the user is unknown.
    state: connection.user_id === null ? connection.rp_state : null,
  });

  if (userId !== null && userId !== connection.user_id) await db.setConnectionUser(connection.sub, userId);
  return userId ?? connection.user_id;
}
