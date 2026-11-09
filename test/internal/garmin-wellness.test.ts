import { describe, expect, it } from "vitest";
import { kilosFromGrams, wellnessValues } from "../../src/providers/garmin-wellness";
import fixtures from "../fixtures/garmin/wellness.json";

/**
 * The shared fixtures hold what SweatStack stores, after it refused what's out of its range. The mapper
 * doesn't know the ranges, so here a value outside them is expected to come out, to be refused there.
 */
const OUT_OF_RANGE = new Set(["a resting heart rate outside SweatStack's range gives nothing", "a weight outside SweatStack's range gives nothing"]);

const byKey = (values: { measure: string; date: string; value: number }[]) =>
  values.map(({ measure, date, value }) => ({ measure, date, value })).sort((a, b) => `${a.measure}${a.date}`.localeCompare(`${b.measure}${b.date}`));

describe("turning Garmin's health summaries into dailies", () => {
  it.each(fixtures.filter(({ name }) => !OUT_OF_RANGE.has(name)).map((fixture) => [fixture.name, fixture] as const))("%s", (_name, fixture) => {
    const values = wellnessValues(fixture.summaryType, fixture.summaries).get("garmin-user-1") ?? [];
    expect(byKey(values)).toEqual(byKey(fixture.rows));
  });

  it("passes a value outside SweatStack's range on, for SweatStack to refuse", () => {
    const weight = fixtures.find(({ name }) => name === "a weight outside SweatStack's range gives nothing");
    expect(wellnessValues("bodyComps", weight?.summaries ?? []).get("garmin-user-1")).toEqual([{ measure: "body_mass", date: "2015-08-17", value: 751.7 }]);
  });

  it("keeps each account's values apart", () => {
    const values = wellnessValues("hrv", [
      { userId: "a", calendarDate: "2026-11-08", lastNightAvg: 40 },
      { userId: 12345, calendarDate: "2026-11-08", lastNightAvg: 50 },
    ]);
    expect(Object.fromEntries(values)).toEqual({
      a: [{ measure: "hrv", date: "2026-11-08", value: 40 }],
      "12345": [{ measure: "hrv", date: "2026-11-08", value: 50 }],
    });
  });

  it.each([
    ["no account", { calendarDate: "2026-11-08", restingHeartRateInBeatsPerMinute: 50 }],
    ["a date that isn't one", { userId: "a", calendarDate: "08-11-2026", restingHeartRateInBeatsPerMinute: 50 }],
    ["a number that isn't one", { userId: "a", calendarDate: "2026-11-08", restingHeartRateInBeatsPerMinute: "50" }],
    ["not an object", "nonsense"],
  ])("skips a record with %s, and keeps the rest", (_name, record) => {
    const values = wellnessValues("dailies", [record, { userId: "a", calendarDate: "2026-11-09", restingHeartRateInBeatsPerMinute: 51 }]);
    expect(Object.fromEntries(values)).toEqual({ a: [{ measure: "resting_hr", date: "2026-11-09", value: 51 }] });
  });

  it("knows no other summary type", () => {
    expect(wellnessValues("epochs", [{ userId: "a", calendarDate: "2026-11-08", restingHeartRateInBeatsPerMinute: 50 }]).size).toBe(0);
  });
});

describe("a weight in kilos", () => {
  it.each([
    [75450, 75.5],
    [75350, 75.4],
    [65550, 65.6],
    [70250, 70.3],
    [70750, 70.8],
    [70249, 70.2],
    [80000, 80],
    [49, 0],
    [50, 0.1],
  ])("%i g is %d kg: tenths, a half up, from whole grams", (grams, kilos) => {
    expect(kilosFromGrams(grams)).toBe(kilos);
  });
});
