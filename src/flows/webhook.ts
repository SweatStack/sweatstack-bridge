import type { PlatformContext } from "../context";
import { deriveSubject, secureEqual } from "../crypto";
import type { QueuedEvent } from "../db";
import { drain } from "../inbox/worker";

/**
 * A ping from the platform: stored, acknowledged at once, then worked on behind the answer. The path
 * holds a secret, because the platform signs nothing.
 */
export async function webhook(c: PlatformContext): Promise<Response> {
  const { db, deps, provider } = c.var;

  const secret = await db.meta("webhook_secret");
  if (secret === null || !(await secureEqual(c.req.param("secret") ?? "", secret))) return c.notFound();

  const kind = c.req.param("kind") ?? "";
  if (!provider.webhookKinds.includes(kind)) return c.notFound();

  const body = await c.req.json<unknown>().catch(() => undefined);
  if (body === undefined) return c.json({ error: "invalid_request" }, 400);

  const subjectKey = await db.meta("subject_key");
  if (subjectKey === null) throw new Error("The database has no subject key");

  const now = deps.now();
  const events = await Promise.all(
    provider.parseWebhook(kind, body).map(async (event): Promise<QueuedEvent> => {
      const about = { provider: provider.name, sub: await deriveSubject(subjectKey, provider.name, event.platformUserId), now };
      switch (event.type) {
        case "file":
          return { ...about, kind: "activity_file", externalId: event.externalId, payload: JSON.stringify(event.reference) };
        case "wellness":
          return { ...about, kind: "wellness", payload: JSON.stringify(event.values) };
        case "permissions_changed":
          return { ...about, kind: "permissions_change" };
        case "deregistered":
          return { ...about, kind: "deregistration" };
      }
    }),
  );
  await db.enqueueEvents(events);

  deps.waitUntil(drain(deps));
  return c.body(null, 200);
}
