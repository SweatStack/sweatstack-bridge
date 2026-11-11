/**
 * What `npm run status` reads from the database: counts and the reasons jobs record, which are fixed codes.
 * Its output is meant to be shared, so nothing here selects a token, a subject or a user id.
 */
export const STATUS_QUERIES = {
  connections:
    "SELECT provider, COUNT(*) AS total, SUM(user_id IS NULL) AS waiting_for_user, SUM(needs_reconnect) AS needs_reconnect FROM connections GROUP BY provider ORDER BY provider",
  waiting:
    "SELECT kind, last_error AS reason, COUNT(*) AS count FROM inbox WHERE done_at IS NULL GROUP BY kind, last_error ORDER BY kind, last_error",
  failures:
    "SELECT kind, last_error AS reason, COUNT(*) AS count, MAX(done_at) AS latest FROM inbox WHERE done_at IS NOT NULL AND last_error IS NOT NULL GROUP BY kind, last_error ORDER BY latest DESC",
  lastFile: "SELECT MAX(received_at) AS at FROM inbox WHERE kind = 'activity_file'",
  lastWellness: "SELECT MAX(received_at) AS at FROM inbox WHERE kind = 'wellness'",
  signingKey: "SELECT COUNT(*) AS count FROM meta WHERE key = 'signing_key'",
};

const TICK_ACTIVITIES = "Tick write for Activities under Data your app uses, on your app's Consent screen tab in SweatStack.";
const TICK_WELLNESS = "Tick write for Wellness under Data your app uses, on your app's Consent screen tab in SweatStack.";

/** Failures with one known fix. Retrying can't help with any of them: they need the owner. */
const FIXES = {
  "activity_file:sweatstack_400": TICK_ACTIVITIES,
  "activity_file:sweatstack_403": TICK_ACTIVITIES,
  "wellness:sweatstack_400": TICK_WELLNESS,
  "wellness:sweatstack_403": TICK_WELLNESS,
  "declare:sweatstack_403": "Check that the token is your app's, and that Garmin is set to Self-hosted on your app's Data sources tab in SweatStack.",
  "declare:sweatstack_409": "Set Garmin to Self-hosted, with your issuer URL, on your app's Data sources tab in SweatStack.",
};

/** Secrets that had another name before, by their name now. The same as RENAMED_FROM in src/config.ts. */
export const RENAMED_FROM = { SWEATSTACK_CLIENT_ID: "SWEATSTACK_APP_ID" };

function when(seconds) {
  return `${new Date(seconds * 1000).toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

function plural(count, one, many = `${one}s`) {
  return `${count} ${count === 1 ? one : many}`;
}

/**
 * The settings with no value. `secretNames` is null while they can't be read: the Worker has no deploy yet.
 */
export function missingSettings({ requiredSecrets, secretNames, vars }) {
  const has = (name) => secretNames.includes(name);
  return {
    secrets: secretNames === null ? null : requiredSecrets.filter((name) => !has(name) && !has(RENAMED_FROM[name])),
    vars: ["SWEATSTACK_URL", "GARMIN_APP_OFFERS"].filter((name) => !vars?.[name]),
    renamed: secretNames === null ? [] : requiredSecrets.filter((name) => !has(name) && has(RENAMED_FROM[name])),
  };
}

function settingsLines({ secrets, vars, renamed = [] }) {
  if (secrets === null) return ["Settings:    can't be read until the first deploy"];
  // Nothing to do yet: the old name still works. Said so the owner can move over when it suits them.
  const renames = renamed.flatMap((name) => [
    `  ${RENAMED_FROM[name]} is now called ${name}. The old name still works. To move over:`,
    `    npx wrangler secret put ${name}, with the same value, then npx wrangler secret delete ${RENAMED_FROM[name]}`,
  ]);
  if (secrets.length === 0 && vars.length === 0) return ["Settings:    all set", ...renames];
  return [
    "Settings:    missing",
    ...secrets.map((name) => `  ${name}: npx wrangler secret put ${name}`),
    ...vars.map((name) => `  ${name}: set it under vars in wrangler.jsonc`),
    ...renames,
  ];
}

function releaseLines({ version, latest }) {
  if (latest === undefined) return [`Version:     ${version} (couldn't check for a newer release)`];
  if (latest === null || latest === `v${version}`) return [`Version:     ${version}${latest === null ? " (no releases yet)" : " (the latest)"}`];
  return [`Version:     ${version}, and ${latest} is available: npm run update`];
}

function bridgeLines({ origin, originProblem, answer, settings }) {
  if (origin === null) return [`Address:     unknown. ${originProblem}`];
  if (answer === 200) return [`Address:     ${origin}, and the bridge answers`];
  if (answer === null) return [`Address:     ${origin}, and nothing answers there. Is it deployed?`];
  if (answer !== 503) return [`Address:     ${origin}, which answers ${answer}, so the bridge isn't there. Is it deployed?`];
  const incomplete = settings.secrets?.length > 0 || settings.vars.length > 0;
  const why = incomplete ? "normal until its settings are complete" : "so one of its settings isn't valid: check SWEATSTACK_URL, BACKFILL_DAYS and GARMIN_APP_OFFERS";
  return [`Address:     ${origin}, and the bridge answers ${answer}, ${why}`];
}

function sweatstackLines({ sweatstackUrl, sweatstackKeys }) {
  if (!sweatstackUrl) return [];
  return sweatstackKeys
    ? [`SweatStack:  ${sweatstackUrl}, and it answers with its keys`]
    : [`SweatStack:  ${sweatstackUrl} doesn't answer with SweatStack's keys. Check SWEATSTACK_URL in wrangler.jsonc: registration can't work without them`];
}

function databaseLines(database, { wellnessOffered }) {
  const { connections, waiting, failures, lastFile, lastWellness, signingKey } = database;
  const lines = [];

  if (signingKey[0].count === 0) lines.push("Signing key: missing. npm run deploy makes it");

  if (connections.length === 0) lines.push("Connections: none");
  for (const { provider, total, waiting_for_user: unclaimed, needs_reconnect: reconnect } of connections) {
    lines.push(`Connections: ${provider}: ${total}, of which ${unclaimed} waiting for a user and ${reconnect} needing a reconnect`);
  }

  lines.push(`Last file:   ${lastFile[0].at === null ? "none on record. If you expect some, see RUNBOOK.md: Set up Garmin's notifications" : when(lastFile[0].at)}`);
  if (wellnessOffered) {
    // A health row left disabled in Garmin's tool, or set to ping, looks just like athletes who didn't sync.
    const last = lastWellness[0].at;
    lines.push(`Last wellness: ${last === null ? "none on record. If you expect some, see RUNBOOK.md: Wellness" : when(last)}`);
  }

  const queued = waiting.reduce((sum, { count }) => sum + count, 0);
  lines.push(`Jobs:        ${queued === 0 ? "nothing waiting" : `${queued} waiting`}`);
  for (const { kind, reason, count } of waiting) {
    lines.push(`  ${kind}: ${count}${reason === null ? "" : `, last try: ${reason}`}`);
  }

  lines.push(`Failures:    ${failures.length === 0 ? "none on record" : "gave up on these in the last 30 days, the latest first"}`);
  for (const { kind, reason, count, latest } of failures) {
    lines.push(`  ${kind}: ${reason}, ${plural(count, "time")}, the latest ${when(latest)}`);
    const fix = FIXES[`${kind}:${reason}`];
    if (fix !== undefined) lines.push(`    ${fix}`);
  }
  return lines;
}

/** The whole report, as text. `database` is null, with `databaseProblem` saying why, if it can't be read. */
export function statusReport(facts) {
  return [
    `SweatStack bridge, ${facts.name}`,
    ...releaseLines(facts),
    ...bridgeLines(facts),
    ...settingsLines(facts.settings),
    ...sweatstackLines(facts),
    ...(facts.database === null ? [`Database:    ${facts.databaseProblem}`] : databaseLines(facts.database, facts)),
  ].join("\n");
}
