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
}

export interface Consent {
  sub: string;
  provider: string;
  rpState: string;
  accessToken: string;
  refreshToken: string;
  accessExpiresAt: number;
  refreshExpiresAt: number;
  permissions: string[] | null;
  consentedAt: number;
}

export type MetaKey = "webhook_secret" | "subject_key" | "signing_key";

export type JobKind = "declare";

export class Database {
  constructor(private readonly d1: D1Database) {}

  async meta(key: MetaKey): Promise<string | null> {
    const row = await this.d1.prepare("SELECT value FROM meta WHERE key = ?").bind(key).first<{ value: string }>();
    return row?.value ?? null;
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
   * makes any refresh still in flight unable to write over them.
   */
  async saveConsent(consent: Consent): Promise<void> {
    await this.d1
      .prepare(
        `INSERT INTO connections
           (sub, provider, rp_state, access_token, refresh_token, access_expires_at, refresh_expires_at, permissions, consented_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (sub) DO UPDATE SET
           rp_state = excluded.rp_state,
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
        consent.sub, consent.provider, consent.rpState, consent.accessToken, consent.refreshToken, consent.accessExpiresAt,
        consent.refreshExpiresAt, consent.permissions === null ? null : JSON.stringify(consent.permissions), consent.consentedAt,
      )
      .run();
  }

  /** SweatStack has named the user, so the flow's `state` has done its job. */
  async setConnectionUser(sub: string, userId: string): Promise<void> {
    await this.d1.prepare("UPDATE connections SET user_id = ?, rp_state = NULL WHERE sub = ?").bind(userId, sub).run();
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

  async enqueue(job: { kind: JobKind; provider: string; sub: string; nextAttemptAt: number; receivedAt: number }): Promise<void> {
    await this.d1
      .prepare("INSERT INTO inbox (kind, provider, sub, next_attempt_at, received_at) VALUES (?, ?, ?, ?, ?)")
      .bind(job.kind, job.provider, job.sub, job.nextAttemptAt, job.receivedAt)
      .run();
  }
}
