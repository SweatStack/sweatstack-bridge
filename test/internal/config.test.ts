import { describe, expect, it } from "vitest";
import { readConfig, type Env } from "../../src/config";

const COMPLETE_SETTINGS = {
  SWEATSTACK_URL: "https://sweatstack.test",
  SWEATSTACK_APP_ID: "test-app",
  SWEATSTACK_CLIENT_SECRET: "test-client-secret",
  GARMIN_CLIENT_ID: "test-garmin-id",
  GARMIN_CLIENT_SECRET: "test-garmin-secret",
  BACKFILL_DAYS: "90",
};

const garmin = { requiredSettings: ["GARMIN_CLIENT_ID", "GARMIN_CLIENT_SECRET"] };
const read = (settings: Record<string, string>) => readConfig({ ...settings } as unknown as Env, garmin);

describe("readConfig", () => {
  it("reads a complete configuration", () => {
    expect(read(COMPLETE_SETTINGS)).toEqual({
      ok: true,
      config: {
        sweatstackUrl: "https://sweatstack.test",
        appId: "test-app",
        clientSecret: "test-client-secret",
        backfillDays: 90,
      },
    });
  });

  it("reports everything that's missing at once, and the deploy form's empty strings count", () => {
    const result = read({ SWEATSTACK_URL: "https://sweatstack.test", SWEATSTACK_APP_ID: "  " });
    expect(result).toEqual({
      ok: false,
      problems: [
        "SWEATSTACK_APP_ID is not set",
        "SWEATSTACK_CLIENT_SECRET is not set",
        "GARMIN_CLIENT_ID is not set",
        "GARMIN_CLIENT_SECRET is not set",
      ],
    });
  });

  it("refuses to send tokens over plain http, except to localhost", () => {
    expect(read({ ...COMPLETE_SETTINGS, SWEATSTACK_URL: "http://sweatstack.test" })).toEqual({
      ok: false,
      problems: ["SWEATSTACK_URL must use https"],
    });
    expect(read({ ...COMPLETE_SETTINGS, SWEATSTACK_URL: "http://localhost:8000" }).ok).toBe(true);
  });

  it("refuses a URL that isn't one", () => {
    expect(read({ ...COMPLETE_SETTINGS, SWEATSTACK_URL: "sweatstack" })).toEqual({
      ok: false,
      problems: ["SWEATSTACK_URL is not a URL"],
    });
  });

  it("keeps only the origin of the URL, so paths can be joined safely", () => {
    const result = read({ ...COMPLETE_SETTINGS, SWEATSTACK_URL: "https://sweatstack.test/" });
    expect(result).toMatchObject({ config: { sweatstackUrl: "https://sweatstack.test" } });
  });

  it("defaults BACKFILL_DAYS and refuses a value that isn't a whole number", () => {
    const { BACKFILL_DAYS: _, ...withoutDays } = COMPLETE_SETTINGS;
    expect(read(withoutDays)).toMatchObject({ config: { backfillDays: 90 } });
    expect(read({ ...COMPLETE_SETTINGS, BACKFILL_DAYS: "soon" })).toEqual({
      ok: false,
      problems: ["BACKFILL_DAYS must be a whole number"],
    });
  });
});
