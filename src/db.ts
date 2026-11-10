/** Typed SQL, one method per query. Times are seconds since the epoch. */

export interface ClientRow {
  provider: string;
  client_id: string;
  secret_hash: string;
  redirect_uri: string;
  registered_at: number;
}

export interface FlowRow {
  id: string;
  provider: string;
  platform_verifier: string;
  rp_client_id: string;
  rp_state: string;
  rp_nonce: string | null;
  rp_redirect_uri: string;
  rp_code_challenge: string;
  taken_at: number | null;
  code_hash: string | null;
  sub: string | null;
  expires_at: number;
}

export interface ConnectionRow {
  sub: string;
  provider: string;
  user_id: string | null;
  rp_state: string | null;
  access_token: string;
  refresh_token: string;
  access_expires_at: number;
  refresh_expires_at: number;
  refresh_claimed_until: number | null;
  permissions: string | null;
  needs_reconnect: number;
  backfill_cursor: string | null;
  backfill_done_at: number | null;
  consented_at: number;
  wellness_history_done_at: number | null;
}

export interface Consent {
  sub: string;
  provider: string;
  accessToken: string;
  refreshToken: string;
  accessExpiresAt: number;
  refreshExpiresAt: number;
  permissions: string[] | null;
  consentedAt: number;
}

export type MetaKey = "webhook_secret" | "subject_key" | "signing_key";

export type JobKind =
  | "activity_file"
  | "wellness"
  | "declare"
  | "permissions_change"
  | "backfill"
  | "wellness_history"
  | "deregistration"
  | "refresh_grant"
  | "expire_unclaimed";

/** What a consent or a permission change may set off. */
export type FollowUp = "permissions_change" | "backfill" | "wellness_history";

export interface JobRow {
  id: number;
  kind: JobKind;
  provider: string;
  sub: string;
  external_id: string | null;
  payload: string | null;
  attempts: number;
  next_attempt_at: number;
  lease_until: number | null;
  last_error: string | null;
  done_at: number | null;
  received_at: number;
}

/** One thing a webhook said, ready to queue. */
export type QueuedEvent =
  | { kind: "activity_file"; provider: string; sub: string; externalId: string; payload: string; now: number }
  /** The payload is the values themselves, kept until they're written. */
  | { kind: "wellness"; provider: string; sub: string; payload: string; now: number }
  | { kind: "permissions_change" | "deregistration"; provider: string; sub: string; now: number };

/** The next run carries on, so a day when everyone is due can't become one enormous statement. */
const MAX_DUE_PER_RUN = 100;

/**
 * Whether a job the sweeper adds can be added for connection `c` (`?3` is the cutoff): not while one is
 * waiting, and not soon after one finished. Otherwise a job that gives up would start again the next minute.
 */
const NOT_RECENTLY_TRIED = (kind: JobKind) =>
  `NOT EXISTS (SELECT 1 FROM inbox i WHERE i.kind = '${kind}' AND i.sub = c.sub AND (i.done_at IS NULL OR i.done_at > ?3))`;

export class Database {
  constructor(private readonly d1: D1Database) {}

  async meta(key: MetaKey): Promise<string | null> {
    const row = await this.d1.prepare("SELECT value FROM meta WHERE key = ?").bind(key).first<{ value: string }>();
    return row?.value ?? null;
  }

  async metaValue(key: string): Promise<string | null> {
    const row = await this.d1.prepare("SELECT value FROM meta WHERE key = ?").bind(key).first<{ value: string }>();
    return row?.value ?? null;
  }

  async setMeta(key: string, value: string): Promise<void> {
    await this.d1
      .prepare("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value")
      .bind(key, value)
      .run();
  }

  client(provider: string): Promise<ClientRow | null> {
    return this.d1.prepare("SELECT * FROM clients WHERE provider = ?").bind(provider).first<ClientRow>();
  }

  /** There is one client per platform, so a new registration replaces the old one. */
  async saveClient(client: ClientRow): Promise<void> {
    await this.d1
      .prepare(
        `INSERT INTO clients (provider, client_id, secret_hash, redirect_uri, registered_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (provider) DO UPDATE SET
           client_id = excluded.client_id, secret_hash = excluded.secret_hash,
           redirect_uri = excluded.redirect_uri, registered_at = excluded.registered_at`,
      )
      .bind(client.provider, client.client_id, client.secret_hash, client.redirect_uri, client.registered_at)
      .run();
  }

  async createFlow(flow: Omit<FlowRow, "taken_at" | "code_hash" | "sub">): Promise<void> {
    await this.d1
      .prepare(
        `INSERT INTO flows (id, provider, platform_verifier, rp_client_id, rp_state, rp_nonce, rp_redirect_uri, rp_code_challenge, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        flow.id, flow.provider, flow.platform_verifier, flow.rp_client_id, flow.rp_state, flow.rp_nonce,
        flow.rp_redirect_uri, flow.rp_code_challenge, flow.expires_at,
      )
      .run();
  }

  /** A flow that the platform's redirect could still take. Reading it takes nothing. */
  openFlow(id: string, provider: string, now: number): Promise<FlowRow | null> {
    return this.d1
      .prepare("SELECT * FROM flows WHERE id = ? AND provider = ? AND taken_at IS NULL AND expires_at > ?")
      .bind(id, provider, now)
      .first<FlowRow>();
  }

  /** Takes a flow for the platform's redirect. Only one redirect can ever get it. */
  takeFlow(id: string, provider: string, now: number): Promise<FlowRow | null> {
    return this.d1
      .prepare(
        `UPDATE flows SET taken_at = ?1
         WHERE id = ?2 AND provider = ?3 AND taken_at IS NULL AND expires_at > ?1
         RETURNING *`,
      )
      .bind(now, id, provider)
      .first<FlowRow>();
  }

  async issueCode(flowId: string, codeHash: string, sub: string, expiresAt: number): Promise<void> {
    await this.d1
      .prepare("UPDATE flows SET code_hash = ?, sub = ?, expires_at = ? WHERE id = ?")
      .bind(codeHash, sub, expiresAt, flowId)
      .run();
  }

  async deleteFlow(id: string): Promise<void> {
    await this.d1.prepare("DELETE FROM flows WHERE id = ?").bind(id).run();
  }

  /** Using a code deletes its flow, in one statement, so a code can't be used twice. */
  redeemCode(codeHash: string, provider: string, now: number): Promise<FlowRow | null> {
    return this.d1
      .prepare("DELETE FROM flows WHERE code_hash = ? AND provider = ? AND expires_at > ? RETURNING *")
      .bind(codeHash, provider, now)
      .first<FlowRow>();
  }

  connection(sub: string): Promise<ConnectionRow | null> {
    return this.d1.prepare("SELECT * FROM connections WHERE sub = ?").bind(sub).first<ConnectionRow>();
  }

  /**
   * Stores a consent. For an account the bridge knows, the new tokens win, and clearing the refresh claim
   * makes any refresh still in flight unable to write over them, and the flow's `state` is only kept if
   * there's still a user to ask for. What the consent still needs done goes
   * in with it, so it can't be lost, and it's due now even if an earlier try was backing off.
   */
  async saveConsent(consent: Consent, followUps: FollowUp[]): Promise<void> {
    const saved = this.d1
      .prepare(
        `INSERT INTO connections
           (sub, provider, access_token, refresh_token, access_expires_at, refresh_expires_at, permissions, consented_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (sub) DO UPDATE SET
           rp_state = NULL,
           access_token = excluded.access_token,
           refresh_token = excluded.refresh_token,
           access_expires_at = excluded.access_expires_at,
           refresh_expires_at = excluded.refresh_expires_at,
           refresh_claimed_until = NULL,
           permissions = excluded.permissions,
           needs_reconnect = 0,
           consented_at = excluded.consented_at`,
      )
      .bind(
        consent.sub, consent.provider, consent.accessToken, consent.refreshToken, consent.accessExpiresAt,
        consent.refreshExpiresAt, consent.permissions === null ? null : JSON.stringify(consent.permissions), consent.consentedAt,
      );
    const due = this.d1
      .prepare("UPDATE inbox SET next_attempt_at = ?, attempts = 0 WHERE sub = ? AND kind IN ('permissions_change', 'backfill', 'wellness_history') AND done_at IS NULL AND lease_until IS NULL")
      .bind(consent.consentedAt, consent.sub);
    await this.d1.batch([saved, due, ...followUps.map((kind) => this.enqueueOnce(kind, consent.sub, consent.consentedAt))]);
  }

  /** What the platform answered, with what follows from it, together. */
  async savePermissions(sub: string, provider: string, permissions: string[], followUps: ("backfill" | "wellness_history")[], now: number): Promise<void> {
    await this.d1.batch([
      this.d1.prepare("UPDATE connections SET permissions = ? WHERE sub = ?").bind(JSON.stringify(permissions), sub),
      this.enqueueStatement({ kind: "declare", provider, sub, nextAttemptAt: now, receivedAt: now }),
      ...followUps.map((kind) => this.enqueueOnce(kind, sub, now)),
    ]);
  }

  async saveBackfillCursor(sub: string, cursor: string | null): Promise<void> {
    await this.d1.prepare("UPDATE connections SET backfill_cursor = ? WHERE sub = ?").bind(cursor, sub).run();
  }

  /** Marked together with telling SweatStack, so `syncing` can't outlive it by accident. */
  async finishBackfill(sub: string, provider: string, now: number): Promise<void> {
    await this.d1.batch([
      this.d1.prepare("UPDATE connections SET backfill_cursor = NULL, backfill_done_at = ? WHERE sub = ?").bind(now, sub),
      this.enqueueStatement({ kind: "declare", provider, sub, nextAttemptAt: now, receivedAt: now }),
    ]);
  }

  /** Marked together with telling SweatStack, as for the backfill. */
  async finishWellnessHistory(sub: string, provider: string, now: number): Promise<void> {
    await this.d1.batch([
      this.d1.prepare("UPDATE connections SET wellness_history_done_at = ? WHERE sub = ?").bind(now, sub),
      this.enqueueStatement({ kind: "declare", provider, sub, nextAttemptAt: now, receivedAt: now }),
    ]);
  }

  /** The platform says it's over. A consent newer than that message stands. */
  forgetDeregistered(sub: string, provider: string, receivedAt: number, now: number): Promise<void> {
    return this.forget(this.d1.prepare("DELETE FROM connections WHERE sub = ? AND consented_at < ?").bind(sub, receivedAt), sub, provider, now);
  }

  /** The person ended it. A consent that landed since stands: they've come back. */
  forgetDisconnected(sub: string, provider: string, consentedAt: number, now: number): Promise<void> {
    return this.forget(this.d1.prepare("DELETE FROM connections WHERE sub = ? AND consented_at = ?").bind(sub, consentedAt), sub, provider, now);
  }

  /** Nobody claimed it. A new consent, or a user named at the last moment, keeps it. */
  forgetUnclaimed(sub: string, provider: string, consentedAt: number, now: number): Promise<void> {
    return this.forget(this.d1.prepare("DELETE FROM connections WHERE sub = ? AND consented_at = ? AND user_id IS NULL").bind(sub, consentedAt), sub, provider, now);
  }

  /**
   * Deletes a connection and its jobs, and queues telling SweatStack. It all happens only if the row went:
   * one that was kept keeps its jobs, and SweatStack has nothing to hear.
   */
  private async forget(deleteRow: D1PreparedStatement, sub: string, provider: string, now: number): Promise<void> {
    await this.d1.batch([
      deleteRow,
      this.d1.prepare("DELETE FROM inbox WHERE sub = ?1 AND NOT EXISTS (SELECT 1 FROM connections WHERE sub = ?1)").bind(sub),
      this.d1
        .prepare(
          `INSERT INTO inbox (kind, provider, sub, next_attempt_at, received_at)
           SELECT 'declare', ?1, ?2, ?3, ?3 WHERE NOT EXISTS (SELECT 1 FROM connections WHERE sub = ?2)`,
        )
        .bind(provider, sub, now),
    ]);
  }

  /** Whether this signed request's id is new. Taking it is atomic, so of two copies only one goes through. */
  async takeJti(jti: string, expiresAt: number): Promise<boolean> {
    const { meta } = await this.d1.prepare("INSERT OR IGNORE INTO seen_jtis (jti, expires_at) VALUES (?, ?)").bind(jti, expiresAt).run();
    return meta.changes === 1;
  }

  /** Whatever was waiting on this connection is due now: a new consent may be what it needed. */
  async wakeJobs(sub: string, now: number): Promise<void> {
    await this.d1.prepare("UPDATE inbox SET next_attempt_at = ? WHERE sub = ? AND done_at IS NULL AND lease_until IS NULL").bind(now, sub).run();
  }

  /**
   * SweatStack has named the user, so the flow's `state` has done its job, and whatever was waiting for
   * this user is due now.
   */
  async setConnectionUser(sub: string, userId: string, now: number): Promise<void> {
    await this.d1.batch([
      this.d1.prepare("UPDATE connections SET user_id = ?, rp_state = NULL WHERE sub = ?").bind(userId, sub),
      this.d1.prepare("UPDATE inbox SET next_attempt_at = ? WHERE sub = ? AND done_at IS NULL AND lease_until IS NULL").bind(now, sub),
    ]);
  }

  /** The call after consent failed, so its retry needs the flow's `state`. */
  async keepState(sub: string, state: string): Promise<void> {
    await this.d1.prepare("UPDATE connections SET rp_state = ? WHERE sub = ?").bind(state, sub).run();
  }

  /** SweatStack has answered the retry this `state` was for. Only that one: a new try may have brought another. */
  async forgetState(sub: string, state: string): Promise<void> {
    await this.d1.prepare("UPDATE connections SET rp_state = NULL WHERE sub = ? AND rp_state = ?").bind(sub, state).run();
  }

  /**
   * Claims the right to refresh, before anything is sent: a refresh token works once, and using a spent
   * one may revoke the grant. Null when someone else holds the claim.
   */
  claimRefresh(sub: string, now: number, until: number): Promise<ConnectionRow | null> {
    return this.d1
      .prepare(
        `UPDATE connections SET refresh_claimed_until = ?1
         WHERE sub = ?2 AND (refresh_claimed_until IS NULL OR refresh_claimed_until <= ?3)
         RETURNING *`,
      )
      .bind(until, sub, now)
      .first<ConnectionRow>();
  }

  /** Lands only while the claim holds, so a new consent that replaced it keeps its own tokens. */
  async saveRefreshedTokens(
    sub: string,
    claim: number,
    tokens: { accessToken: string; refreshToken: string; accessExpiresAt: number; refreshExpiresAt: number },
  ): Promise<void> {
    await this.d1
      .prepare(
        `UPDATE connections SET access_token = ?, refresh_token = ?, access_expires_at = ?, refresh_expires_at = ?, refresh_claimed_until = NULL
         WHERE sub = ? AND refresh_claimed_until = ?`,
      )
      .bind(tokens.accessToken, tokens.refreshToken, tokens.accessExpiresAt, tokens.refreshExpiresAt, sub, claim)
      .run();
  }

  async releaseRefreshClaim(sub: string, claim: number, { needsReconnect }: { needsReconnect: boolean }): Promise<void> {
    await this.d1
      .prepare(
        `UPDATE connections SET refresh_claimed_until = NULL, needs_reconnect = CASE WHEN ?1 THEN 1 ELSE needs_reconnect END
         WHERE sub = ?2 AND refresh_claimed_until = ?3`,
      )
      .bind(needsReconnect ? 1 : 0, sub, claim)
      .run();
  }

  async sweatstackToken(holder: string, now: number): Promise<string | null> {
    const row = await this.d1
      .prepare("SELECT access_token FROM tokens WHERE holder = ? AND expires_at > ?")
      .bind(holder, now)
      .first<{ access_token: string }>();
    return row?.access_token ?? null;
  }

  async saveSweatstackToken(holder: string, accessToken: string, expiresAt: number): Promise<void> {
    await this.d1
      .prepare(
        `INSERT INTO tokens (holder, access_token, expires_at) VALUES (?, ?, ?)
         ON CONFLICT (holder) DO UPDATE SET access_token = excluded.access_token, expires_at = excluded.expires_at`,
      )
      .bind(holder, accessToken, expiresAt)
      .run();
  }

  async deleteSweatstackToken(holder: string): Promise<void> {
    await this.d1.prepare("DELETE FROM tokens WHERE holder = ?").bind(holder).run();
  }

  /**
   * One atomic statement: two runs can never claim the same job. With a `sub`, only that connection's
   * jobs, so someone connecting doesn't wait behind everyone else's backlog.
   *
   * A connection's wellness jobs go in the order they arrived: one waits while an older one hasn't
   * finished, running or not. A later value for a day is the newer one, so an older job that failed and
   * ran again after it would put the older value back.
   */
  claimJob(now: number, leaseUntil: number, sub: string | null): Promise<JobRow | null> {
    return this.d1
      .prepare(
        `UPDATE inbox SET lease_until = ?1, attempts = attempts + 1
         WHERE id = (
           SELECT id FROM inbox j
           WHERE done_at IS NULL AND next_attempt_at <= ?2 AND (lease_until IS NULL OR lease_until <= ?2) AND (?3 IS NULL OR sub = ?3)
             AND NOT (kind = 'wellness' AND EXISTS (
               SELECT 1 FROM inbox o WHERE o.kind = 'wellness' AND o.sub = j.sub AND o.done_at IS NULL AND o.id < j.id
             ))
           ORDER BY next_attempt_at, id LIMIT 1
         )
         RETURNING *`,
      )
      .bind(leaseUntil, now, sub)
      .first<JobRow>();
  }

  /** A finished job stays for `npm run status`, without what it needed to run. `lastError` set means it failed. */
  async finishJob(id: number, now: number, lastError: string | null): Promise<void> {
    await this.d1
      .prepare("UPDATE inbox SET done_at = ?, last_error = ?, payload = NULL, lease_until = NULL WHERE id = ?")
      .bind(now, lastError, id)
      .run();
  }

  async retryJob(id: number, nextAttemptAt: number, reason: string): Promise<void> {
    await this.d1
      .prepare("UPDATE inbox SET next_attempt_at = ?, last_error = ?, lease_until = NULL WHERE id = ?")
      .bind(nextAttemptAt, reason, id)
      .run();
  }

  /** A job with more to do goes straight back in line, and its next stretch starts with a clean slate. */
  async continueJob(id: number, now: number): Promise<void> {
    await this.d1.prepare("UPDATE inbox SET next_attempt_at = ?, attempts = 0, last_error = NULL, lease_until = NULL WHERE id = ?").bind(now, id).run();
  }

  /**
   * What webhooks said. A repeated ping about the same file adds nothing. Values for an account the bridge
   * doesn't hold are never stored: the test is in the statement, so there's nothing to read first.
   */
  async enqueueEvents(events: QueuedEvent[]): Promise<void> {
    if (events.length === 0) return;
    await this.d1.batch(
      events.map((event) => {
        switch (event.kind) {
          case "activity_file":
            return this.d1
              .prepare(
                `INSERT INTO inbox (kind, provider, sub, external_id, payload, next_attempt_at, received_at)
                 VALUES ('activity_file', ?1, ?2, ?3, ?4, ?5, ?5)
                 ON CONFLICT (kind, sub, external_id) DO NOTHING`,
              )
              .bind(event.provider, event.sub, event.externalId, event.payload, event.now);
          case "wellness":
            return this.d1
              .prepare(
                `INSERT INTO inbox (kind, provider, sub, payload, next_attempt_at, received_at)
                 SELECT 'wellness', ?1, ?2, ?3, ?4, ?4 WHERE EXISTS (SELECT 1 FROM connections WHERE sub = ?2)`,
              )
              .bind(event.provider, event.sub, event.payload, event.now);
          default:
            return this.enqueueStatement({ kind: event.kind, provider: event.provider, sub: event.sub, nextAttemptAt: event.now, receivedAt: event.now });
        }
      }),
    );
  }

  /** Quiet connections whose grant is near its end. Writes nothing when none are. */
  async enqueueDueRefreshes(refreshBefore: number, now: number, triedSince: number): Promise<void> {
    await this.d1
      .prepare(
        `INSERT INTO inbox (kind, provider, sub, next_attempt_at, received_at)
         SELECT 'refresh_grant', c.provider, c.sub, ?1, ?1 FROM connections c
         WHERE c.refresh_expires_at <= ?2 AND c.needs_reconnect = 0 AND ${NOT_RECENTLY_TRIED("refresh_grant")}
         LIMIT ${MAX_DUE_PER_RUN}`,
      )
      .bind(now, refreshBefore, triedSince)
      .run();
  }

  /** Connections that have had their day. Writes nothing when none have. */
  async enqueueUnclaimed(consentedBefore: number, now: number, triedSince: number): Promise<void> {
    await this.d1
      .prepare(
        `INSERT INTO inbox (kind, provider, sub, next_attempt_at, received_at)
         SELECT 'expire_unclaimed', c.provider, c.sub, ?1, ?1 FROM connections c
         WHERE c.user_id IS NULL AND c.consented_at <= ?2 AND ${NOT_RECENTLY_TRIED("expire_unclaimed")}
         LIMIT ${MAX_DUE_PER_RUN}`,
      )
      .bind(now, consentedBefore, triedSince)
      .run();
  }

  /** What a platform app offers has changed, so what every connection provides, or could, may have too. */
  async enqueueRecheckForAll(provider: string, now: number): Promise<void> {
    const enqueueForAll = (kind: JobKind) =>
      this.d1
        .prepare(
          `INSERT INTO inbox (kind, provider, sub, next_attempt_at, received_at)
           SELECT ?1, provider, sub, ?2, ?2 FROM connections WHERE provider = ?3`,
        )
        .bind(kind, now, provider);
    await this.d1.batch([enqueueForAll("declare"), enqueueForAll("permissions_change")]);
  }

  /** Deletes what's over. Each statement touches nothing when there's nothing to delete. */
  async purge(now: number, finishedBefore: number): Promise<void> {
    await this.d1.batch([
      this.d1.prepare("DELETE FROM flows WHERE expires_at <= ?").bind(now),
      this.d1.prepare("DELETE FROM inbox WHERE done_at IS NOT NULL AND done_at <= ?").bind(finishedBefore),
      this.d1.prepare("DELETE FROM tokens WHERE expires_at <= ?").bind(now),
      this.d1.prepare("DELETE FROM seen_jtis WHERE expires_at <= ?").bind(now),
    ]);
  }

  async enqueue(job: { kind: JobKind; provider: string; sub: string; nextAttemptAt: number; receivedAt: number }): Promise<void> {
    await this.enqueueStatement(job).run();
  }

  private enqueueStatement(job: { kind: JobKind; provider: string; sub: string; nextAttemptAt: number; receivedAt: number }): D1PreparedStatement {
    return this.d1
      .prepare("INSERT INTO inbox (kind, provider, sub, next_attempt_at, received_at) VALUES (?, ?, ?, ?, ?)")
      .bind(job.kind, job.provider, job.sub, job.nextAttemptAt, job.receivedAt);
  }

  /** Adds a job unless one is already waiting, and asks for no history a connection has already had. */
  private enqueueOnce(kind: FollowUp, sub: string, now: number): D1PreparedStatement {
    return this.d1
      .prepare(
        `INSERT INTO inbox (kind, provider, sub, next_attempt_at, received_at)
         SELECT ?1, c.provider, c.sub, ?2, ?2 FROM connections c
         WHERE c.sub = ?3
           AND (?1 <> 'backfill' OR c.backfill_done_at IS NULL)
           AND (?1 <> 'wellness_history' OR c.wellness_history_done_at IS NULL)
           AND NOT EXISTS (SELECT 1 FROM inbox i WHERE i.kind = ?1 AND i.sub = c.sub AND i.done_at IS NULL)`,
      )
      .bind(kind, now, sub);
  }
}
