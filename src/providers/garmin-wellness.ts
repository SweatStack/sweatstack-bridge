import type { DailyValue } from "./types";

/**
 * Garmin's health summaries as SweatStack dailies, the same as SweatStack's own Garmin connection makes
 * them: the same fields, the same skips, the same dates, the same rounding. The shared fixtures in
 * `test/fixtures/garmin/wellness.json` hold the two equal. Pure: no I/O, and it never sees a token.
 *
 * Values outside SweatStack's ranges come out as they are. SweatStack refuses them, and its ranges stay in
 * one place.
 */

type Fields = Record<string, unknown>;
type Mapper = (record: Fields) => DailyValue[];

const OFF_WRIST = "OFF_WRIST";
const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** Garmin's summary types, by the key of their list in a push. */
const MAPPERS: Readonly<Record<string, Mapper>> = {
  dailies: (record) => {
    const day = calendarDate(record);
    const restingHeartRate = number(record.restingHeartRateInBeatsPerMinute);
    // Absent or 0 on a day the watch was barely worn. The 7-day average is never a resting value.
    return day !== null && restingHeartRate !== null && restingHeartRate > 0 ? [{ measure: "resting_hr", date: day, value: restingHeartRate }] : [];
  },
  sleeps: (record) => {
    const day = calendarDate(record);
    const duration = number(record.durationInSeconds);
    // Off the wrist, there's a start and an end but no measured sleep. The duration excludes time awake.
    if (record.validation === OFF_WRIST || day === null || duration === null || duration === 0) return [];
    return [{ measure: "sleep_duration", date: day, value: duration }];
  },
  bodyComps: (record) => {
    const day = measurementDate(record);
    if (day === null) return [];
    const grams = number(record.weightInGrams);
    const fat = number(record.bodyFatInPercent);
    return [
      ...(grams === null ? [] : [{ measure: "body_mass", date: day, value: kilosFromGrams(grams) }]),
      ...(fat === null ? [] : [{ measure: "body_fat_pct", date: day, value: fat }]),
    ];
  },
  hrv: (record) => {
    const day = calendarDate(record);
    // The overnight average, already in milliseconds.
    const average = number(record.lastNightAvg);
    return day !== null && average !== null ? [{ measure: "hrv", date: day, value: average }] : [];
  },
};

/** The summary types this maps, by the key of their list in a push. */
export const WELLNESS_SUMMARY_TYPES: readonly string[] = Object.keys(MAPPERS);

/**
 * Each account's values in one list of summaries. Within the list, the last value for a measure and day
 * wins: a push can carry a day twice, as a correction or a second weigh-in. A record that can't be read
 * gives nothing, and the others still count.
 */
export function wellnessValues(summaryType: string, records: readonly unknown[]): Map<string, DailyValue[]> {
  const mapper = Object.hasOwn(MAPPERS, summaryType) ? MAPPERS[summaryType] : undefined;
  const latest = new Map<string, Map<string, DailyValue>>();
  if (mapper === undefined) return new Map();
  for (const record of records) {
    if (typeof record !== "object" || record === null) continue;
    const fields = record as Fields;
    const { userId } = fields;
    if (typeof userId !== "string" && typeof userId !== "number") continue;
    const account = latest.get(String(userId)) ?? new Map<string, DailyValue>();
    for (const value of mapper(fields)) account.set(`${value.measure} ${value.date}`, value);
    if (account.size > 0) latest.set(String(userId), account);
  }
  return new Map([...latest].map(([account, values]) => [account, [...values.values()]]));
}

/**
 * Tenths of a kilo, a half up, from whole grams. Integer arithmetic, so it's exact: rounding the float
 * `grams / 1000` instead depends on how that float happens to be stored, and sends equal halves either way.
 */
export function kilosFromGrams(grams: number): number {
  return Math.floor((grams + 50) / 100) / 10;
}

function number(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function calendarDate(record: Fields): string | null {
  const { calendarDate: day } = record;
  return typeof day === "string" && DAY.test(day) ? day : null;
}

/** A body composition has no calendar date. Its day is the device's: the moment, moved by the device's offset. */
function measurementDate(record: Fields): string | null {
  const moment = number(record.measurementTimeInSeconds);
  if (moment === null || !Number.isInteger(moment)) return null;
  const offset = number(record.measurementTimeOffsetInSeconds) ?? 0;
  return new Date((moment + offset) * 1000).toISOString().slice(0, 10);
}
