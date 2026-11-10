import { Encoder, Profile } from "@garmin/fitsdk";

const SECONDS = 10 * 60;
const METRES_PER_SECOND = 1.3;

/**
 * A 10-minute walk as a FIT activity file, for an owner to import into Garmin Connect during Garmin's partner
 * verification. It ends at `endsAt`, so each one is new to Garmin and recent. It has no location and nothing
 * about a person: time, distance and speed only.
 * @param {Date} endsAt
 * @returns {Uint8Array}
 */
export function walk(endsAt) {
  const end = new Date(Math.floor(endsAt.getTime() / 1000) * 1000);
  const start = new Date(end.getTime() - SECONDS * 1000);
  const at = (second) => new Date(start.getTime() + second * 1000);
  const distance = SECONDS * METRES_PER_SECOND;

  const encoder = new Encoder();
  encoder.onMesg(Profile.MesgNum.FILE_ID, { type: "activity", manufacturer: "development", product: 0, timeCreated: start });
  encoder.onMesg(Profile.MesgNum.EVENT, { timestamp: start, event: "timer", eventType: "start" });
  for (let second = 0; second <= SECONDS; second += 1) {
    encoder.onMesg(Profile.MesgNum.RECORD, { timestamp: at(second), distance: second * METRES_PER_SECOND, speed: METRES_PER_SECOND });
  }
  encoder.onMesg(Profile.MesgNum.EVENT, { timestamp: end, event: "timer", eventType: "stop" });
  const totals = { startTime: start, totalElapsedTime: SECONDS, totalTimerTime: SECONDS, totalDistance: distance, avgSpeed: METRES_PER_SECOND };
  encoder.onMesg(Profile.MesgNum.LAP, { timestamp: end, event: "lap", eventType: "stop", ...totals });
  encoder.onMesg(Profile.MesgNum.SESSION, { timestamp: end, event: "session", eventType: "stop", sport: "walking", subSport: "generic", firstLapIndex: 0, numLaps: 1, ...totals });
  encoder.onMesg(Profile.MesgNum.ACTIVITY, { timestamp: end, numSessions: 1, type: "manual", event: "activity", eventType: "stop", totalTimerTime: SECONDS });
  return encoder.close();
}
