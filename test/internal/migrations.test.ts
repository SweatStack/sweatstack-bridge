/// <reference types="vite/client" />
import { describe, expect, it } from "vitest";

/**
 * A database that has run a migration never runs it again, so editing a published one changes nothing
 * for existing deployments, and their schema silently stops matching the code. A change is a new
 * migration. Add its hash here when you add the file.
 */
const PUBLISHED: Record<string, string> = {
  "/migrations/0001_init.sql": "8c36ea7c24c30b642a0ed83f01cb04a57dae57b2484ac4d58abd9b4532b3d1ac",
  "/migrations/0002_flows_client.sql": "a0981a6f6a2c823ca31145910b83252a43868161ba028616c277979c9f32401d",
};

const files = import.meta.glob("/migrations/*.sql", { query: "?raw", import: "default", eager: true }) as Record<string, string>;

async function sha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

describe("migrations", () => {
  it("are never edited once published, and each one is listed", async () => {
    const hashes = Object.fromEntries(await Promise.all(Object.entries(files).map(async ([path, text]) => [path, await sha256(text)])));
    expect(hashes).toEqual(PUBLISHED);
  });
});
