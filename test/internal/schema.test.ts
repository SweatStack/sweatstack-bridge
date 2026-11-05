import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { resetDatabase } from "../support/world";

const meta = async (key: string) =>
  (await env.DB.prepare("SELECT value FROM meta WHERE key = ?").bind(key).first<{ value: string }>())?.value;

const addJob = (kind: string, externalId: string | null) =>
  env.DB.prepare(
    `INSERT INTO inbox (kind, provider, sub, external_id, next_attempt_at, received_at)
     VALUES (?, 'garmin_connect', 'a-subject', ?, 0, 0) ON CONFLICT DO NOTHING`,
  )
    .bind(kind, externalId)
    .run();

beforeEach(() => resetDatabase({ withSigningKey: false }));

describe("the first migration", () => {
  it("creates the webhook secret and the subject key, each random and different", async () => {
    const webhookSecret = await meta("webhook_secret");
    const subjectKey = await meta("subject_key");
    expect(webhookSecret).toMatch(/^[0-9a-f]{64}$/);
    expect(subjectKey).toMatch(/^[0-9a-f]{64}$/);
    expect(webhookSecret).not.toBe(subjectKey);
  });

  it("adds no signing key: the deploy script does", async () => {
    expect(await meta("signing_key")).toBeUndefined();
  });
});

describe("the inbox", () => {
  it("adds one row for a repeated ping about the same file", async () => {
    await addJob("activity_file", "activity-1");
    const repeated = await addJob("activity_file", "activity-1");
    expect(repeated.meta.changes).toBe(0);
  });

  it("adds a row each time for a kind without an external id", async () => {
    await addJob("declare", null);
    const second = await addJob("declare", null);
    expect(second.meta.changes).toBe(1);
  });
});
