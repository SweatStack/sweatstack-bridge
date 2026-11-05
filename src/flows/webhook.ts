import type { PlatformContext } from "../context";
import { deriveSubject, secureEqual } from "../crypto";
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
  const files = await Promise.all(
    provider.parseWebhook(kind, body).map(async (file) => ({
      provider: provider.name,
      sub: await deriveSubject(subjectKey, provider.name, file.platformUserId),
      externalId: file.externalId,
      payload: JSON.stringify(file.reference),
      now,
    })),
  );
  await db.enqueueFiles(files);

  deps.waitUntil(drain(deps));
  return c.body(null, 200);
}
