import type { Child } from "hono/jsx";
import { raw } from "hono/html";
import type { Capability, VerificationGuide, VerificationStep } from "../providers/types";
import type { Facts } from "./facts";
import { banners, cloudflareSettings, notificationRows, pasteValues, setup, sweatstackTab, type Banner, type NotificationRow, type Proof } from "./setup";
import { status } from "./status";
import { ago, utc } from "./time";
import type { Notice, Walk } from "./verification";

/**
 * The console's pages, rendered on the server. No inline script or style: the CSP allows only the files under
 * `public/console/`. Every value the owner pastes is in a read-only field, so the page works without the
 * script, which only adds the copy buttons and the theme toggle.
 */

const RUNBOOK = "https://github.com/SweatStack/sweatstack-bridge/blob/main/RUNBOOK.md";
const RELEASES = "https://github.com/SweatStack/sweatstack-bridge/releases";

/** Tabler Icons (MIT, tabler.io/icons), drawn inline so the page needs no request for them. */
const ICON_PATHS = {
  bridge: (
    <>
      <path d="M6 5l0 14" />
      <path d="M18 5l0 14" />
      <path d="M2 15l20 0" />
      <path d="M3 8a7.5 7.5 0 0 0 3 -2a6.5 6.5 0 0 0 12 0a7.5 7.5 0 0 0 3 2" />
      <path d="M12 10l0 5" />
    </>
  ),
  sun: (
    <>
      <path d="M12 12m-4 0a4 4 0 1 0 8 0a4 4 0 1 0 -8 0" />
      <path d="M3 12h1m8 -9v1m8 8h1m-9 8v1m-6.4 -15.4l.7 .7m12.1 -.7l-.7 .7m0 11.4l.7 .7m-12.1 -.7l-.7 .7" />
    </>
  ),
  moon: <path d="M12 3c.132 0 .263 0 .393 0a7.5 7.5 0 0 0 7.92 12.446a9 9 0 1 1 -8.313 -12.454z" />,
  pin: (
    <>
      <path d="M9 11a3 3 0 1 0 6 0a3 3 0 0 0 -6 0" />
      <path d="M17.657 16.657l-4.243 4.243a2 2 0 0 1 -2.827 0l-4.244 -4.243a8 8 0 1 1 11.314 0z" />
    </>
  ),
};

function Icon({ name, class: className = "icon" }: { name: "sun" | "moon" | "pin"; class?: string }) {
  return (
    <svg class={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      {ICON_PATHS[name]}
    </svg>
  );
}

/** The app icon: a rounded square in the Norwegian flag's red, with the bridge in its blue. As `icon.svg`. */
function AppIcon({ class: className }: { class: string }) {
  return (
    <svg class={className} viewBox="0 0 24 24" aria-hidden="true">
      <rect width="24" height="24" rx="5.5" fill="#BA0C2F" />
      <g transform="translate(4 4) scale(0.6667)" fill="none" stroke="#00205B" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round">
        {ICON_PATHS.bridge}
      </g>
    </svg>
  );
}

/** A link out of the console: a new tab, and no referrer, so the console's address stays here. */
function Out({ href, class: className, children }: { href: string; class?: string; children: Child }) {
  return (
    <a href={href} class={className} target="_blank" rel="noopener noreferrer">
      {children} ↗
    </a>
  );
}

function When({ at, now }: { at: number; now: number }) {
  return (
    <time datetime={new Date(at * 1000).toISOString()} title={utc(at)}>
      {ago(at, now)}
    </time>
  );
}

function Layout({ host, signedIn, refresh, children }: { host: string; signedIn: boolean; refresh?: number; children: Child }) {
  return (
    <>
      {raw("<!doctype html>")}
      <html lang="en">
        <head>
          <meta charset="utf-8" />
          <meta name="viewport" content="width=device-width, initial-scale=1" />
          <meta name="robots" content="noindex" />
          {/* While the page waits for data to reach the bridge. No script needed. */}
          {refresh !== undefined && <meta http-equiv="refresh" content={String(refresh)} />}
          <title>SweatStack bridge</title>
          <link rel="icon" type="image/svg+xml" href="/console/icon.svg" />
          <link rel="stylesheet" href="/console/console.css" />
          {/* In <head>, so the page never shows the other theme first. It waits for the page itself. */}
          <script src="/console/console.js"></script>
        </head>
        <body>
          <header class="topbar">
            <span class="brand">
              <AppIcon class="icon" />
              SweatStack bridge
            </span>
            <span class="host">{host}</span>
            <span class="right">
              {signedIn && (
                <form method="post" action="/console/sign-out">
                  <button class="link-button" type="submit">
                    Sign out
                  </button>
                </form>
              )}
              <button class="theme-toggle" type="button" data-theme-toggle hidden>
                <Icon name="moon" class="icon show-light" />
                <Icon name="sun" class="icon show-dark" />
              </button>
            </span>
          </header>
          {children}
        </body>
      </html>
    </>
  );
}

/** Before `SWEATSTACK_CLIENT_SECRET` is set: nobody can sign in, and the bridge has nothing to protect yet. */
export function NoSecretPage({ origin }: { origin: string }) {
  return (
    <Layout host={new URL(origin).host} signedIn={false}>
      <main class="public">
        <AppIcon class="mark" />
        <h1>Almost there</h1>
        <p>
          This bridge has no SweatStack client secret yet, so nobody can sign in. Add <code>SWEATSTACK_CLIENT_SECRET</code> to this Worker in
          Cloudflare, under Settings, Variables and Secrets. You don't need to deploy again.
        </p>
        <Out href={cloudflareSettings(origin)} class="btn btn-primary">
          Open the Worker in Cloudflare
        </Out>
      </main>
    </Layout>
  );
}

/** Signed out: nothing about the bridge, only the form. */
export function SignInPage({ origin, failed }: { origin: string; failed: boolean }) {
  return (
    <Layout host={new URL(origin).host} signedIn={false}>
      <main class="public">
        <AppIcon class="mark" />
        <h1>A SweatStack bridge</h1>
        <p>It connects a wearable platform to an app built on SweatStack. Its owner signs in here.</p>
        <form class="signin" method="post" action="/console/sign-in">
          {/* A fixed username, so a password manager saves the secret for this site. */}
          <input type="hidden" name="username" autocomplete="username" value="owner" />
          <div>
            <label for="secret">Your bridge's SweatStack client secret</label>
            <input id="secret" type="password" name="secret" autocomplete="current-password" required autofocus />
          </div>
          {failed && (
            <p class="error" role="alert">
              That isn't this bridge's secret.
            </p>
          )}
          <button class="btn btn-primary" type="submit">
            Sign in
          </button>
          <p class="hint">
            The secret you pasted when you deployed. Lost it? Create a new one on your app's OAuth tab in SweatStack, and replace{" "}
            <code>SWEATSTACK_CLIENT_SECRET</code> in Cloudflare.
          </p>
        </form>
      </main>
    </Layout>
  );
}

const LEFT = ["", "One step left.", "Two steps left.", "Three steps left."];
const NUMBERS = ["no", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten"];
const inWords = (count: number) => NUMBERS[count] ?? String(count);

/** Signed in: the steps until they're proven, and the status. Once they are, the status comes first. */
export function ConsolePage({ facts }: { facts: Facts }) {
  const state = setup(facts);
  const done = state.left === 0;
  const optional = facts.platform.guide.verification === undefined ? "" : " Step 3 is optional.";
  return (
    <Layout host={new URL(facts.origin).host} signedIn={true}>
      <main data-page="console">
        <section class="hero">
          <AppIcon class="mark" />
          {done ? (
            <>
              <h1>
                <span>Your bridge is working.</span>
              </h1>
              <p>Nobody at SweatStack watches your bridge, so this page is where you look.</p>
            </>
          ) : (
            <>
              <h1>
                <span>Your bridge is running.</span>
                <span>{LEFT[state.left]}</span>
              </h1>
              <p>Each step happens in one place, and ticks itself off when the bridge sees it working.{optional}</p>
            </>
          )}
        </section>
        <div class="column">
          {banners(facts).map((banner) => (
            <BannerView banner={banner} facts={facts} />
          ))}
          {done ? (
            <>
              <StatusView facts={facts} />
              <h2 class="section-title">Setup</h2>
              <ol class="steps">
                <li class="step" data-state="proven">
                  <details>
                    <summary>
                      <span class="num">✓</span>
                      <span>
                        <h2>Every step is done</h2>
                        <span class="proof-line">The values to paste are here when you need them again</span>
                      </span>
                      <span class="fold"></span>
                    </summary>
                    <div class="step-body">
                      <Steps facts={facts} />
                    </div>
                  </details>
                </li>
              </ol>
            </>
          ) : (
            <>
              <Steps facts={facts} />
              <h2 class="section-title">Status</h2>
              <StatusView facts={facts} />
            </>
          )}
        </div>
      </main>
    </Layout>
  );
}

function Steps({ facts }: { facts: Facts }) {
  const state = setup(facts);
  const { guide } = facts.platform;
  const { now } = facts;
  return (
    <ol class="steps">
      <Step number={1} title={`Connect your ${guide.name} app`} place={<Out href={guide.developerPortal.url}>{guide.developerPortal.label}</Out>} proof={state.app} provenBy={(at) => <>{guide.name} connected an account <When at={at} now={now} /></>}>
        <ConnectApp facts={facts} />
      </Step>
      <Step number={2} title={`Turn on ${guide.name}'s notifications`} place={<Out href={guide.notifications.url}>{guide.notifications.label}</Out>} proof={state.notifications} provenBy={(at) => <>{guide.name} last sent a notification <When at={at} now={now} /></>}>
        <Notifications facts={facts} />
      </Step>
      {guide.verification !== undefined && (
        <Step number={3} optional title={`Pass ${guide.name}'s verification`} place={guide.verification.place} proof={state.verification} provenBy={(at) => <>{guide.name}'s tests passed <When at={at} now={now} /></>}>
          <p>{guide.verification.why} Do it before step 4, so they never see that. About 15 minutes, one step at a time, and each step moves on by itself.</p>
          <div class="row">
            <a class="btn btn-secondary btn-small" href="/console/verification">
              {facts.walk === null ? "Start the walk" : facts.walk.saved.finishedAt === undefined ? `Carry on: step ${facts.walk.number} of ${facts.walk.of}` : "Open the walk"}
            </a>
          </div>
        </Step>
      )}
      <Step
        number={4}
        title="Switch SweatStack to your bridge"
        place={(() => {
          const tab = sweatstackTab(facts, "data-sources");
          return tab === null ? "SweatStack, your app's Data sources tab" : <Out href={tab}>SweatStack, your app's Data sources tab</Out>;
        })()}
        proof={state.sweatstack}
        provenBy={(at) => <>SweatStack registered with the bridge <When at={at} now={now} /></>}
      >
        <div>
          <Copy label="Issuer URL" value={pasteValues(facts).issuer} />
          <p class="hint">
            On the {guide.name} card, choose Self-hosted, paste it, and Save. From then on, your athletes connect {guide.name} through your bridge.
          </p>
        </div>
        {state.sweatstack === null && (
          <Pending>SweatStack registers with the bridge as soon as you save. Then sign in to your own app in a private window, and choose {guide.name}.</Pending>
        )}
      </Step>
    </ol>
  );
}

function Step({
  number,
  title,
  place,
  optional = false,
  proof,
  provenBy,
  children,
}: {
  number: number;
  title: string;
  place: Child;
  optional?: boolean;
  proof: Proof;
  provenBy: (at: number) => Child;
  children: Child;
}) {
  const proven = proof !== null;
  return (
    <li class="step" data-state={proven ? "proven" : "open"} aria-label={`Step ${number}: ${title}, ${proven ? "done" : "to do"}`}>
      <details open={!proven}>
        <summary>
          <span class="num">{proven ? "✓" : number}</span>
          <span>
            {!proven && (
              <span class="step-label">
                Step {number} {optional && <span class="optional">Optional</span>}
              </span>
            )}
            <h2>{title}</h2>
            {proven ? (
              <span class="proof-line">{provenBy(proof.at)}</span>
            ) : (
              <span class="place">
                <Icon name="pin" />
                {place}
              </span>
            )}
          </span>
          <span class="fold"></span>
        </summary>
        <div class="step-body">{children}</div>
      </details>
    </li>
  );
}

function ConnectApp({ facts }: { facts: Facts }) {
  const { guide, offers, missingSettings } = facts.platform;
  const proven = facts.platform.lastConsent !== null;
  return (
    <>
      <div>
        <Copy label={guide.redirectUrlLabel} value={pasteValues(facts).redirectUrl} />
        <p class="hint">Paste it in your {guide.name} app's settings, and save.</p>
      </div>
      <div>
        <div class="copy-label">What your {guide.name} app is approved for</div>
        <ul class="facts">
          {(Object.entries(guide.capabilities) as [Capability, { label: string; description: string }][]).map(([capability, { label, description }]) => {
            const offered = offers.has(capability);
            return (
              <li class={offered ? undefined : "off"}>
                <span class={offered ? "tick" : "tick todo"} aria-hidden="true">
                  {offered ? "✓" : ""}
                </span>
                <span>
                  {label}
                  {offered ? "" : <span class="visually-hidden"> (not approved)</span>}
                  <small>{description}</small>
                </span>
              </li>
            );
          })}
        </ul>
        <p class="hint">
          Not right? On GitHub, open <code>wrangler.jsonc</code> in your copy, select the pencil, change <code>{guide.offersSetting}</code>, and commit.
          Cloudflare deploys it in a minute.
        </p>
      </div>
      {!proven && (
        <Pending>
          {missingSettings.length > 0
            ? `Add ${missingSettings.join(" and ")} in Cloudflare first: the banner above says how. `
            : ""}
          {guide.name} checks your keys and this URL when the first account connects, in step 3 or 4. This step ticks itself off then.
        </Pending>
      )}
    </>
  );
}

function Notifications({ facts }: { facts: Facts }) {
  const { guide } = facts.platform;
  const rows = notificationRows(facts);
  const proven = setup(facts).notifications !== null;
  const proving = rows.filter((row) => row.setting.quietUntil === undefined).map((row) => row.setting.label);
  return (
    <>
      <p>
        {guide.notifications.signIn} Enable these {inWords(rows.length)} settings, each with its URL, and leave every other setting disabled. Keep these URLs
        private: they hold a secret.
      </p>
      {rows.map((row) => (
        <Copy label={row.setting.label} value={row.url} seen={<LastSent row={row} now={facts.now} />} />
      ))}
      {!proven && (
        <Pending>
          This step ticks itself off when {guide.name} first sends to {proving.join(" and ")}, once an athlete, or you in step 3, syncs. The other
          settings only send when an athlete acts.
        </Pending>
      )}
    </>
  );
}

function LastSent({ row, now }: { row: NotificationRow; now: number }) {
  if (row.lastPush !== null) {
    return (
      <span class="seen ok">
        <span class="tick" aria-hidden="true">
          ✓
        </span>
        Last sent <When at={row.lastPush} now={now} />
      </span>
    );
  }
  return (
    <span class="seen">
      <span class="tick todo" aria-hidden="true"></span>
      {row.setting.quietUntil === undefined ? "Nothing yet" : `Nothing yet, which is normal until ${row.setting.quietUntil}`}
    </span>
  );
}

function Copy({ label, value, seen }: { label: string; value: string; seen?: Child }) {
  return (
    <div>
      <div class="copy-label">
        <span>{label}</span>
        {seen}
      </div>
      <div class="copy">
        <input readonly value={value} aria-label={label} />
        <button type="button" data-copy hidden>
          Copy
        </button>
      </div>
    </div>
  );
}

function Pending({ children }: { children: Child }) {
  return (
    <div class="proof">
      <span class="tick todo" aria-hidden="true"></span>
      <span>{children}</span>
    </div>
  );
}

function BannerView({ banner, facts }: { banner: Banner; facts: Facts }) {
  const cloudflare = cloudflareSettings(facts.origin);
  switch (banner.kind) {
    case "settings":
      return (
        <div class="banner banner-warn" role="status">
          <div>
            <b>Some settings need you</b>
            <p>Add or fix them in Cloudflare, under Settings, Variables and Secrets. A secret needs no new deploy.</p>
            <ul>
              {banner.problems.map((problem) => (
                <li>{problem}</li>
              ))}
            </ul>
          </div>
          <Out href={cloudflare} class="btn btn-secondary btn-small">
            Open Cloudflare
          </Out>
        </div>
      );
    case "signing_key":
      return (
        <div class="banner banner-warn" role="status">
          <div>
            <b>The bridge has no signing key yet</b>
            <p>Every deploy makes it. Deploy once more, and nobody can sign in until you do.</p>
          </div>
        </div>
      );
    case "credentials": {
      const oauth = sweatstackTab(facts, "oauth");
      return (
        <div class="banner banner-warn" role="status">
          {banner.status === 401 ? (
            <div>
              <b>SweatStack doesn't accept this bridge's Client ID and secret</b>
              <p>
                Check <code>SWEATSTACK_CLIENT_ID</code> and <code>SWEATSTACK_CLIENT_SECRET</code> in Cloudflare against your app's OAuth tab. SweatStack
                says the same while your app is suspended.
              </p>
            </div>
          ) : (
            <div>
              <b>{banner.status === null ? "SweatStack didn't answer" : `SweatStack answered ${banner.status}`}</b>
              <p>The bridge tries again on its own. If this lasts, check SWEATSTACK_URL.</p>
            </div>
          )}
          {oauth !== null && banner.status === 401 && (
            <Out href={oauth} class="btn btn-secondary btn-small">
              Open the OAuth tab
            </Out>
          )}
        </div>
      );
    }
    case "failure": {
      const what = { activity_file: "activity files", wellness: "daily values", declare: "connections" }[banner.jobKind as string] ?? "jobs";
      const tab = sweatstackTab(facts, banner.tab);
      return (
        <div class="banner banner-warn" role="status">
          <div>
            <b>
              {banner.count} {banner.count === 1 ? what.replace(/s$/, "") : what} couldn't reach SweatStack
            </b>
            <p>
              {banner.fix} The latest was <When at={banner.latest} now={facts.now} />.
            </p>
          </div>
          {tab !== null && (
            <Out href={tab} class="btn btn-secondary btn-small">
              Open the tab
            </Out>
          )}
        </div>
      );
    }
    case "release":
      return (
        <div class="banner banner-info" role="status">
          <div>
            <b>{banner.latest} is available</b>
            <p>
              You run {facts.version}. <Out href={`${RUNBOOK}#run-it`}>The runbook</Out> says how to update your copy.
            </p>
          </div>
          <Out href={`${RELEASES}/tag/${banner.latest}`} class="btn btn-secondary btn-small">
            What's new
          </Out>
        </div>
      );
  }
}

function StatusView({ facts }: { facts: Facts }) {
  const numbers = status(facts);
  const { now } = facts;
  const never = "None yet";
  return (
    <>
      <dl class="tiles">
        <div class="tile">
          <dt>Athletes connected</dt>
          <dd>
            {numbers.connected}
            {numbers.needsReconnect > 0 && <small>{numbers.needsReconnect} need to reconnect</small>}
            {numbers.waitingForUser > 0 && <small>{numbers.waitingForUser} waiting for SweatStack</small>}
          </dd>
        </div>
        <div class="tile">
          <dt>Last activity file</dt>
          <dd class="time">{numbers.lastFile === null ? never : <When at={numbers.lastFile} now={now} />}</dd>
        </div>
        {numbers.lastWellness !== undefined && (
          <div class="tile">
            <dt>Last daily values</dt>
            <dd class="time">{numbers.lastWellness === null ? never : <When at={numbers.lastWellness} now={now} />}</dd>
          </div>
        )}
        <div class="tile">
          <dt>Jobs waiting</dt>
          <dd>{numbers.jobsWaiting}</dd>
        </div>
        <div class="tile">
          <dt>Failures, 30 days</dt>
          <dd>{numbers.failures}</dd>
        </div>
      </dl>
      <section class="card">
        <h3>What {facts.platform.guide.name} sends</h3>
        <ul class="feeds">
          {notificationRows(facts).map((row) => (
            <li>
              <span>{row.setting.label}</span>
              <span class="when">{row.lastPush === null ? "Nothing yet" : <When at={row.lastPush} now={now} />}</span>
            </li>
          ))}
        </ul>
      </section>
      <p class="status-line">
        Version {facts.version}. More detail is in the Worker's logs in Cloudflare.
      </p>
    </>
  );
}

/** How often the walk's page looks again while it waits for data. */
const WALK_REFRESH_SECONDS = 15;

const NOTICES: Record<Notice, string> = {
  refused: "The account wasn't connected, or its sign-in was more than 10 minutes ago. Get a new link and try again.",
  expired: "The link expired before anyone signed in. Get a new one.",
  same_account: "That was the other account. Use a new private window, and sign in with the account this step names.",
  connection_ended: "The bridge ended the first account's connection, as it does a day after the sign-in for an account nobody claims. The walk starts again.",
  skipped: "Skipped. The tests will show whether that data came.",
};

/** The platform's verification, one step at a time, moving on by itself as each step's data arrives. */
export function WalkPage({
  origin,
  provider,
  platform,
  guide,
  steps,
  walk,
  now,
}: {
  origin: string;
  provider: string;
  platform: string;
  guide: VerificationGuide;
  steps: readonly VerificationStep[];
  walk: Walk | null;
  now: number;
}) {
  const index = walk === null ? -1 : walk.finishedAt !== undefined ? steps.length : steps.findIndex((step) => step.id === walk.step);
  const step = steps[index];
  const waiting = walk !== null && step !== undefined && (step.proof.kind !== "connected" || walk.flow !== undefined) && step.proof.kind !== "tests";
  return (
    <Layout host={new URL(origin).host} signedIn={true} refresh={waiting ? WALK_REFRESH_SECONDS : undefined}>
      <main class="walk">
        <a class="back" href="/console">
          ← Console
        </a>
        <div class="page-head">
          <div class="step-label">Step 3 · Optional</div>
          <h1>Pass {platform}'s verification</h1>
          <p>
            {guide.why} Each step here moves on by itself once its data reaches the bridge.{" "}
            <Out href={`${RUNBOOK}#${guide.runbookSection}`}>More in the runbook</Out>
          </p>
        </div>
        <div class="walk-body">
          <ol class="rail" aria-label="The walk">
            {steps.map((candidate, at) => (
              <li class={at < index ? "done" : at === index ? "now" : undefined} aria-current={at === index ? "step" : undefined}>
                <span class={at < index ? "tick" : at === index && waiting ? "tick wait" : "tick todo"} aria-hidden="true">
                  {at < index ? "✓" : ""}
                </span>
                {candidate.title}
                {candidate.account !== undefined && <span class="who">{candidate.account.toUpperCase()}</span>}
              </li>
            ))}
          </ol>
          <section class="now-card">
            {walk === null ? (
              <WalkStart guide={guide} steps={steps} />
            ) : step === undefined ? (
              <>
                <div class="of">Done</div>
                <h2>The walk is done</h2>
                <p>{platform}'s tests passed. The bridge ends these test connections itself, a day after their sign-in.</p>
              </>
            ) : (
              <WalkStep origin={origin} provider={provider} platform={platform} guide={guide} step={step} number={index + 1} of={steps.length} walk={walk} waiting={waiting} now={now} />
            )}
            {walk !== null && (
              <form method="post" action="/console/verification" class="walk-foot">
                <button class="link-button" type="submit" name="action" value="restart">
                  Start the walk again
                </button>
              </form>
            )}
          </section>
        </div>
      </main>
    </Layout>
  );
}

function WalkStart({ guide, steps }: { guide: VerificationGuide; steps: readonly VerificationStep[] }) {
  const overnight = steps.some((step) => step.proof.kind === "measured" && step.proof.fromHours > 0);
  return (
    <>
      <div class="of">Before you start</div>
      <h2>Two accounts, and {overnight ? "about 15 minutes, then a night" : "about 15 minutes"}</h2>
      <ul class="accounts">
        <li>
          <span class="account">A</span>
          <span>{guide.accounts.a}</span>
        </li>
        <li>
          <span class="account">B</span>
          <span>{guide.accounts.b}</span>
        </li>
      </ul>
      <p class="hint">Turn on the notifications in step 2 of the console first: each step here waits for one of them.</p>
      <form method="post" action="/console/verification" class="walk-foot">
        {/* Filled in by the script with the browser's time zone, for the calendar day of a daily value. */}
        <input type="hidden" name="timeZone" value="UTC" data-time-zone />
        <button class="btn btn-primary" type="submit" name="action" value="start">
          Start the walk
        </button>
      </form>
    </>
  );
}

function WalkStep({
  origin,
  provider,
  platform,
  guide,
  step,
  number,
  of,
  walk,
  waiting,
  now,
}: {
  origin: string;
  provider: string;
  platform: string;
  guide: VerificationGuide;
  step: VerificationStep;
  number: number;
  of: number;
  walk: Walk;
  waiting: boolean;
  now: number;
}) {
  const kind = step.proof.kind;
  return (
    <>
      <div class="of">
        Step {number} of {of}
      </div>
      <h2>
        {step.title}
        {step.account !== undefined && ` with account ${step.account.toUpperCase()}`}
      </h2>
      {walk.notice !== undefined && (
        <p class="error" role="status">
          {NOTICES[walk.notice]}
        </p>
      )}
      <ol>
        {step.instructions.map((line) => (
          <li>{line}</li>
        ))}
      </ol>
      {step.link !== undefined && (
        <p>
          <Out href={step.link.url}>{step.link.label}</Out>
        </p>
      )}
      {kind === "connected" && walk.flow !== undefined && (
        <Copy label={`Sign-in link for account ${step.account?.toUpperCase()}, until ${utc(walk.flow.expiresAt)}`} value={`${origin}/start/${provider}/${walk.flow.id}`} />
      )}
      {kind === "tests" && walk.connectedAt !== undefined && (
        <p class="hint">
          Run them before {utc(walk.connectedAt + guide.windowSeconds)}: {platform} only counts what it received in the{" "}
          {guide.windowSeconds / 3600} hours after the first sign-in. If a test fails, <Out href={`${RUNBOOK}#${guide.runbookSection}`}>the runbook's table</Out> says which step passes it.
        </p>
      )}
      {waiting && (
        <div class="waiting">
          <span class="tick wait" aria-hidden="true"></span>
          <div>
            <b>{kind === "connected" ? `Waiting for account ${step.account?.toUpperCase()} to connect` : "Waiting for its data to reach the bridge"}</b>
            <p>
              This page looks again every {WALK_REFRESH_SECONDS} seconds. You can close it and come back: the walk keeps its place. Started{" "}
              <When at={walk.since} now={now} />.
            </p>
          </div>
        </div>
      )}
      <form method="post" action="/console/verification" class="walk-foot">
        {kind === "connected" && (
          <button class={walk.flow === undefined ? "btn btn-primary" : "btn btn-secondary btn-small"} type="submit" name="action" value="link">
            {walk.flow === undefined ? "Get a sign-in link" : "New link"}
          </button>
        )}
        {(kind === "job" || kind === "removed" || kind === "measured") && (
          <button class="btn btn-secondary btn-small" type="submit" name="action" value="skip">
            Skip this check
          </button>
        )}
        {kind === "tests" && (
          <button class="btn btn-primary" type="submit" name="action" value="passed">
            The tests passed
          </button>
        )}
      </form>
    </>
  );
}

/** Where the private window lands after the platform's consent. Public, so it says nothing about the bridge. */
export function LandedPage({ origin, failed }: { origin: string; failed: boolean }) {
  return (
    <Layout host={new URL(origin).host} signedIn={false}>
      <main class="public">
        <AppIcon class="mark" />
        <h1>{failed ? "The account wasn't connected" : "The account is connected"}</h1>
        <p>{failed ? "Close this window, and get a new link in the walk." : "Close this window. The walk moves on by itself."}</p>
      </main>
    </Layout>
  );
}
