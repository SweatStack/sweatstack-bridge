/**
 * `npm run verify`: Garmin's partner verification, one step at a time, as RUNBOOK.md's "Pass Garmin's
 * verification" lists them. Each step waits until its data has reached the bridge, read from the bridge's
 * database, so the owner never has to guess whether it worked. The place is kept in a file, so a step that
 * takes a night, or a stop, carries on where it was.
 *
 * Everything outside, the terminal, the database and the clock, comes in through `io` and `deps`, so the
 * whole walk can run against a fake Garmin in the tests.
 */
import { RUNBOOK_SECTION, verificationSignIn } from "./verify.mjs";

/** Where the place is kept, in the owner's copy. Ignored by git. */
export const STATE_FILE = ".verification.json";

export const POLL_MS = 15_000;
const DAY = 24 * 60 * 60;
const HOURS_6 = 6 * 60 * 60;
const IMPORT_URL = "https://connect.garmin.com/app/import-data";
const TESTS_URL = "https://apis.garmin.com/tools/partnerVerification";
const NOTIFICATIONS_SECTION = "https://github.com/SweatStack/sweatstack-bridge/blob/main/RUNBOOK.md#set-up-garmins-notifications";

const quote = (value) => `'${String(value).replaceAll("'", "''")}'`;

/**
 * One query for everything the steps wait on: which accounts are connected, the pushes that came for them,
 * and the sign-in under way. Values never leave the database: only which measure, and for which day.
 * @param {{ subs: string[], flowId?: string }} options
 */
export function progressSql({ subs, flowId }) {
  const list = subs.length > 0 ? subs.map(quote).join(", ") : "''";
  return [
    `SELECT 'connection' AS what, sub, NULL AS kind, NULL AS payload, consented_at AS at FROM connections WHERE sub IN (${list})`,
    `SELECT 'job', sub, kind, CASE WHEN kind = 'wellness' THEN payload END, received_at FROM inbox WHERE sub IN (${list}) AND kind IN ('activity_file', 'wellness', 'permissions_change')`,
    `SELECT 'flow', sub, NULL, NULL, expires_at FROM flows WHERE id = ${quote(flowId ?? "")}`,
  ].join(" UNION ALL ");
}

/** The rows of `progressSql`, read. `flow` is null when the sign-in's row is gone. */
export function readProgress(rows) {
  const progress = { connected: new Set(), jobs: [], flow: null };
  for (const row of rows) {
    if (row.what === "connection") progress.connected.add(row.sub);
    else if (row.what === "flow") progress.flow = { sub: row.sub ?? null };
    else progress.jobs.push({ sub: row.sub, kind: row.kind, at: row.at, measures: measuresIn(row.payload) });
  }
  return progress;
}

function measuresIn(payload) {
  if (typeof payload !== "string") return [];
  try {
    return JSON.parse(payload).map(({ measure, date }) => ({ measure, date }));
  } catch {
    return [];
  }
}

/** The day on this computer's calendar, as Garmin dates a day: the owner, the watch and this are in one place. */
export function localDay(seconds) {
  const date = new Date(seconds * 1000);
  const pad = (number) => String(number).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function when(seconds) {
  return `${new Date(seconds * 1000).toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

const jobs = (progress, sub, kind, since) => progress.jobs.filter((job) => job.sub === sub && job.kind === kind && job.at >= since);

/** A value of this measure, pushed since `since`, for a day from `fromDay` on: history Garmin sends doesn't count. */
const measured = (progress, sub, measure, since, fromDay) =>
  jobs(progress, sub, "wellness", since).some((job) => job.measures.some((value) => value.measure === measure && value.date >= fromDay));

/**
 * Waits until `check` gives an outcome, reading the database every `POLL_MS`. The owner can type a key
 * meanwhile: q always stops, and `keys` names the others this wait takes.
 */
async function waitFor(io, deps, state, check, { keys = {}, quiet = false } = {}) {
  const options = [...Object.entries(keys).map(([key, what]) => `${key} to ${what}`), "q to stop and continue later"];
  if (!quiet) io.print(`   Waiting for it to reach the bridge. Type ${options.join(", or ")}, then Enter.`);
  let failing = false;
  for (;;) {
    const rows = await deps.query(progressSql({ subs: Object.values(state.accounts), flowId: state.flow?.id }));
    if (rows === null) {
      if (!failing) io.print("   Couldn't read the bridge's database. Trying again.");
      failing = true;
    } else {
      failing = false;
      const outcome = check(readProgress(rows));
      if (outcome) return outcome;
    }
    const typed = (await io.idle(POLL_MS))?.trim().toLowerCase();
    if (typed === "q") return "quit";
    if (typed !== undefined && Object.hasOwn(keys, typed)) return typed;
  }
}

/** A wait that the owner may skip: Garmin's tests then say whether the data came. */
async function waitForData(io, deps, state, check, arrived) {
  const outcome = await waitFor(io, deps, state, (progress) => (check(progress) ? "done" : null), { keys: { s: "skip this check" } });
  if (outcome === "done") io.print(`   ${arrived}`);
  if (outcome === "s") io.print("   Skipped. Garmin's tests will show whether it came.");
  return outcome === "quit" ? "quit" : "done";
}

/** Connects account `key` with a sign-in link, a new one whenever the last can't work anymore. */
async function connect(io, deps, state, key) {
  const label = key.toUpperCase();
  const other = key === "a" ? state.accounts.b : state.accounts.a;
  for (;;) {
    if (state.flow === undefined || state.flow.expiresAt <= deps.now()) {
      const signIn = verificationSignIn({ now: deps.now() });
      if (!(await deps.execute(signIn.sql))) {
        io.print("   Couldn't write the sign-in to the bridge's database. Check your Cloudflare login, then run npm run verify again.");
        return "quit";
      }
      state.flow = { id: signIn.id, path: signIn.path, expiresAt: signIn.expiresAt };
      deps.saveState(state);
    }
    io.print(`   Open this link in a private browser window. Sign in to Garmin with account ${label}, and allow all
   permissions. Garmin then sends you to the runbook. The link works once, until ${when(state.flow.expiresAt)}. Don't share it.

   ${deps.origin}${state.flow.path}
`);
    let sub = null;
    const outcome = await waitFor(
      io,
      deps,
      state,
      (progress) => {
        if (deps.now() >= state.flow.expiresAt) return "expired";
        if (progress.flow === null) return "refused";
        sub = progress.flow.sub;
        if (sub === null) return null;
        return sub === other ? "same" : "connected";
      },
      { keys: { n: "get a new link" } },
    );
    if (outcome === "quit") return "quit";
    if (outcome === "connected") {
      state.accounts[key] = sub;
      if (key === "a") state.connectedAt = deps.now();
      delete state.flow;
      io.print(`   Account ${label} is connected.`);
      return "done";
    }
    delete state.flow;
    if (outcome === "same") io.print(`   That was account ${key === "a" ? "B" : "A"}. Sign out of Garmin, or use a new private window, and sign in with account ${label}.`);
    if (outcome === "refused") io.print("   Garmin didn't connect the account. Here's a new link.");
    if (outcome === "expired") io.print("   The link expired. Here's a new one.");
    if (outcome === "n") io.print("   Here's a new link.");
  }
}

async function importWalk(io, deps, state, key) {
  const label = key.toUpperCase();
  const file = await deps.writeWalk();
  io.print(`   With account ${label}, import this walk at ${IMPORT_URL}:

   ${file}
`);
  const sub = state.accounts[key];
  return waitForData(io, deps, state, (progress) => jobs(progress, sub, "activity_file", state.since).length > 0, `Garmin sent account ${label}'s activity file.`);
}

/**
 * The steps, in order, as the runbook lists them. Without wellness, Garmin needs no more than two accounts with
 * an activity each, one permission taken back and one removal. Wellness adds a weight and a night, last, so the
 * night is the only wait.
 */
const STEPS = [
  {
    id: "notifications",
    title: "Garmin's notifications",
    run: async (io, deps) => {
      const health = deps.wellness ? ", including the health settings" : "";
      io.print(`   In Garmin's developer portal, paste the URLs that npm run urls prints, and enable the settings it lists${health}.
   More: ${NOTIFICATIONS_SECTION}`);
      return (await io.ask("   Press Enter when they're set, or type q to stop.")) === "q" ? "quit" : "done";
    },
  },
  { id: "connect_a", title: "connect account A", run: (io, deps, state) => connect(io, deps, state, "a") },
  { id: "walk_a", title: "a walk for account A", run: (io, deps, state) => importWalk(io, deps, state, "a") },
  { id: "connect_b", title: "connect account B", run: (io, deps, state) => connect(io, deps, state, "b") },
  { id: "walk_b", title: "a walk for account B", run: (io, deps, state) => importWalk(io, deps, state, "b") },
  {
    id: "permission_b",
    title: "take back a permission for account B",
    run: (io, deps, state) => {
      io.print("   With account B, turn off one of your app's permissions in Garmin Connect.");
      const changed = (progress) => jobs(progress, state.accounts.b, "permissions_change", state.since).length > 0;
      return waitForData(io, deps, state, changed, "Garmin sent account B's permission change.");
    },
  },
  {
    id: "remove_b",
    title: "remove the app for account B",
    run: (io, deps, state) => {
      io.print("   With account B, remove your app in Garmin Connect.");
      return waitForData(io, deps, state, (progress) => !progress.connected.has(state.accounts.b), "Garmin sent account B's deregistration.");
    },
  },
  {
    id: "weight_a",
    title: "a weight for account A",
    wellness: true,
    run: (io, deps, state) => {
      io.print("   With account A, enter a weight in Garmin Connect.");
      const day = localDay(state.since);
      return waitForData(io, deps, state, (progress) => measured(progress, state.accounts.a, "body_mass", state.since, day), "Garmin sent account A's weight.");
    },
  },
  {
    id: "night_a",
    title: "a night with the watch",
    wellness: true,
    run: (io, deps, state) => {
      io.print(`   With account A, wear the watch tonight. Tomorrow morning, sync it with the Garmin Connect app.
   You can stop now with q. Run npm run verify again in the morning, and it carries on here.`);
      // Tonight's sleep is dated tomorrow, or today for a start after midnight. A night Garmin sent as history is older.
      const day = localDay(state.since + HOURS_6);
      const slept = (progress) => ["sleep_duration", "hrv"].every((measure) => measured(progress, state.accounts.a, measure, state.since, day));
      return waitForData(io, deps, state, slept, "Garmin sent account A's sleep and HRV status.");
    },
  },
  {
    id: "tests",
    title: "Garmin's tests",
    run: async (io, deps, state) => {
      const deadline = state.connectedAt === undefined ? "" : ` Do it before ${when(state.connectedAt + DAY)}: Garmin counts the last 24 hours.`;
      io.print(`   Open ${TESTS_URL}, sign in with your consumer key, and select Run Tests.${deadline}
   If a test fails, the table in the runbook says which step passes it: ${RUNBOOK_SECTION}`);
      return (await io.ask("   Press Enter when the tests pass, or type q to stop.")) === "q" ? "quit" : "done";
    },
  },
];

/** The steps for this app: the wellness ones only when it offers wellness. */
export function stepsFor(wellness) {
  return STEPS.filter((step) => wellness || !step.wellness);
}

function introduction(deps, count) {
  const watch = deps.wellness ? ", with a Garmin watch that records sleep and HRV status" : ". It needs no watch";
  const time = deps.wellness ? "It takes one night, because Garmin must receive sleep and HRV status." : "It takes about 15 minutes.";
  return `Garmin's partner verification, for ${deps.name}

Your app works without it. Until it passes, Garmin shows your athletes that your app is unverified.
You need two Garmin accounts:
- Account A: your own${watch}.
- Account B: a new one. Make it at https://connect.garmin.com: it's free and needs no watch.
${time} There are ${count} steps, and each one waits until its data reaches the bridge.
The steps, in more detail: ${RUNBOOK_SECTION}`;
}

/**
 * The whole walk. Returns when it's done or the owner stops; the place is saved after every step.
 * @param {{ print(text: string): void, ask(question: string): Promise<string>, idle(ms: number): Promise<string | null> }} io
 *   `ask` and `idle` give "q" once the input has ended; `idle` gives null when nothing was typed in time.
 * @param {{ name: string, origin: string, wellness: boolean, now(): number, query(sql: string): Promise<object[] | null>,
 *   execute(sql: string): Promise<boolean>, writeWalk(): Promise<string>, loadState(): object | null, saveState(state: object | null): void }} deps
 */
export async function guide(io, deps) {
  const steps = stepsFor(deps.wellness);
  const indexOf = (id) => steps.findIndex((step) => step.id === id);

  let state = deps.loadState();
  // Another bridge's walk, or a step this app doesn't have since its offers changed: start again.
  if (state !== null && (state.origin !== deps.origin || indexOf(state.step) === -1)) state = null;

  if (state !== null) {
    const step = steps[indexOf(state.step)];
    const answer = (await io.ask(`You stopped at step ${indexOf(state.step) + 1}, ${step.title}. Press Enter to carry on there, or type new to start again.`)).trim().toLowerCase();
    if (answer === "q") return;
    if (answer === "new") state = null;
  }

  // The bridge ends an account nobody claims a day after its sign-in, so a walk left too long starts again.
  const afterConnectA = state !== null && indexOf(state.step) > indexOf("connect_a") && state.step !== "tests";
  if (afterConnectA && state.accounts.a !== undefined) {
    const rows = await deps.query(progressSql({ subs: [state.accounts.a] }));
    if (rows !== null && !readProgress(rows).connected.has(state.accounts.a)) {
      io.print(`The bridge has ended account A's connection: it does that a day after the sign-in. Starting again at step ${indexOf("connect_a") + 1}.`);
      state = { origin: state.origin, step: "connect_a", since: deps.now(), accounts: {} };
    }
  }

  if (state === null) {
    state = { origin: deps.origin, step: steps[0].id, since: deps.now(), accounts: {} };
    io.print(introduction(deps, steps.length));
  }
  deps.saveState(state);

  for (let index = indexOf(state.step); index < steps.length; index += 1) {
    const step = steps[index];
    state.step = step.id;
    deps.saveState(state);
    io.print(`\nStep ${index + 1} of ${steps.length}: ${step.title}`);
    if ((await step.run(io, deps, state)) === "quit") {
      deps.saveState(state);
      io.print(`\nStopped at step ${index + 1}. Run npm run verify again to carry on there.`);
      return;
    }
    state.since = deps.now();
  }
  deps.saveState(null);
  io.print("\nDone. The bridge ends these test connections itself, a day after their sign-in.");
}
