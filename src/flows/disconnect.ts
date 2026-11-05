import { errors, jwtVerify, type JWTPayload } from "jose";
import { deregisterAtPlatform } from "../connections";
import { NO_STORE, type PlatformContext } from "../context";
import { log } from "../log";
import { sweatstackKeys } from "../sweatstack";

const SECURITY_EVENT_TYP = "secevent+jwt";
const DISCONNECT_EVENT = "https://sweatstack.no/events/connection-disconnect";
const MAX_AGE_SECONDS = 5 * 60;

/** Well past the five minutes a request is accepted for, so a copy of one can never be taken again. */
const KEEP_JTI_SECONDS = 24 * 60 * 60;

/** SweatStack's request to end a connection, from the Portal or for a deleted user. */
export async function disconnect(c: PlatformContext): Promise<Response> {
  const { config, db, deps, provider } = c.var;

  const request = await verifiedRequest(c);
  if (request === null) return c.json({ error: "invalid_request" }, 400, NO_STORE);

  const now = deps.now();
  // After verifying, so only SweatStack can add to this table. SweatStack signs every try anew, so a retry
  // after the 503 below has a jti of its own.
  if (!(await db.takeJti(request.jti, now + KEEP_JTI_SECONDS))) {
    log("disconnect_refused", { reason: "jti_seen" });
    return c.json({ error: "invalid_request" }, 400, NO_STORE);
  }

  // No subject means a connection this bridge didn't declare. And a connection that has another user is
  // someone's new one, found by a late retry for a deleted user. Either way there's nothing here to end.
  const connection = request.subject === null ? null : await db.connection(request.subject);
  if (connection === null || (connection.user_id !== null && connection.user_id !== request.userId)) return c.body(null, 204);

  try {
    await deregisterAtPlatform({ config, db, deps, provider }, connection);
  } catch (error) {
    log("disconnect_failed", { provider: provider.name, error: error instanceof Error ? error.name : "unknown" });
    return c.json({ error: "temporarily_unavailable" }, 503, NO_STORE);
  }

  // SweatStack deletes its side on this answer. The `DELETE` this queues is harmless then, and it clears up
  // after a connection call that was on its way while this ran.
  await db.forgetDisconnected(connection.sub, provider.name, connection.consented_at, deps.now());
  return c.body(null, 204);
}

interface DisconnectRequest {
  jti: string;
  userId: string;
  /** The bridge's own subject for the connection. Null when SweatStack holds none. */
  subject: string | null;
}

/** Null if this isn't a request SweatStack made, for this bridge and this platform, just now. */
async function verifiedRequest(c: PlatformContext): Promise<DisconnectRequest | null> {
  const { config, deps, issuer, provider } = c.var;
  const refuse = (reason: string) => {
    log("disconnect_refused", { reason });
    return null;
  };

  let payload: JWTPayload;
  try {
    ({ payload } = await jwtVerify(new Uint8Array(await c.req.arrayBuffer()), sweatstackKeys(config, deps), {
      algorithms: ["RS256"],
      issuer: config.sweatstackUrl,
      audience: issuer,
      typ: SECURITY_EVENT_TYP,
      requiredClaims: ["sub", "jti", "iat"],
      maxTokenAge: MAX_AGE_SECONDS,
      currentDate: new Date(deps.now() * 1000),
    }));
  } catch (error) {
    return refuse(error instanceof errors.JOSEError ? error.code : "unknown");
  }

  const event = (payload.events as Record<string, { provider?: unknown; subject?: IssuerAndSubject }> | undefined)?.[DISCONNECT_EVENT];
  if (event?.provider !== provider.name) return refuse("event");

  const { subject } = event;
  if (subject !== undefined && (subject.format !== "iss_sub" || subject.iss !== issuer || typeof subject.sub !== "string")) {
    return refuse("subject");
  }
  return { jti: payload.jti as string, userId: payload.sub as string, subject: subject?.sub ?? null };
}

/** RFC 9493's way to name someone by who knows them. */
interface IssuerAndSubject {
  format?: unknown;
  iss?: unknown;
  sub?: string;
}
