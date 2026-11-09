# Developing

How the bridge works, and how to run and change it. Start here if you're changing your own copy.

## How it works

The bridge connects a wearable platform to your app built on SweatStack, and it works with Garmin. It's two
things that share only a user id:

- **An OpenID Provider, one issuer per platform.** SweatStack is its relying party. The bridge runs the
  platform's consent, starts the backfill, tells SweatStack what the connection provides, and hands back an
  ID token. SweatStack makes or finds the user; the bridge never creates one.
- **A client of SweatStack's public API.** The platform pings the bridge when a file is ready. The bridge
  acknowledges at once, queues the work in D1, downloads the file and uploads it to SweatStack, naming the
  platform and deduplicated on the platform's activity id. Daily values arrive in the platform's push itself:
  the bridge keeps those values, and nothing else from the push, until it has written them as the athlete. A
  cron trigger every minute handles retries.

### The job queue

Everything that can fail is a job in the `inbox` table, so it all gets the same retries: backing off to an
hour, and ending after three days. A job reads the connection when it runs, so the order doesn't matter,
with one exception: a connection's `wellness` jobs run in the order they arrived, because each value replaces
the day's, and an older one retried after a newer one would put the older value back.

| Kind | Added by | What it does |
|---|---|---|
| `activity_file` | The platform's ping | Downloads a file and uploads it as the athlete |
| `wellness` | The platform's push of health summaries | Writes the daily values it carries as the athlete, one at a time. The values are its payload, and go with it when it finishes or gives up. A value SweatStack refuses is skipped |
| `declare` | Anything that changes a connection | Tells SweatStack what it provides now, or that it's gone |
| `permissions_change` | The platform's webhook, or a consent where it wouldn't say yet | Asks the platform, stores the answer, declares, and adds `backfill` if newly allowed. The webhook's own list is never believed |
| `backfill` | A consent or a permission change | Asks for one 30-day window of history, keeps its place on the row, and goes back in line for the next |
| `wellness_history` | A consent or a permission change | Asks once for the last 28 days of each health summary type, which the platform sends as pushes |
| `deregistration` | The platform's webhook | Deletes the connection and its jobs, and adds a `declare`. With no connection (the echo of a disconnect) it does nothing. A message older than the latest consent is ignored |
| `refresh_grant` | The cron, 30 days before a refresh token ends | Refreshes it, so a quiet athlete's grant doesn't lapse. Access tokens are refreshed only when a call needs one |
| `expire_unclaimed` | The cron, a day after a consent with no user | Asks SweatStack once more, deregisters at the platform, deletes, and adds a `declare` |

**The first seconds after a consent.** The browser's redirect waits only for the connection call. The rest runs
behind it, for that connection only, so nobody else's backlog can delay it. A brief refusal from the platform
is retried every half second at first and for seven seconds in all on a job's first run, and after that with
the usual backoff.

**Someone with a SweatStack account.** The call after consent also carries the platform's id for the person, so
that SweatStack can ask whether to move an account they already use with the app. It's only ever in memory, for
that one call: `sub` stays the only id the bridge keeps. Until they answer, the answer is `user_id: null`, files
wait, and the connection looks like any other waiting for its user. The flow's `state` is in memory for that call
too, and goes on the row only if the call fails. A job can run at that very moment, because the platform's
notifications arrive with the consent, and a call with the `state` and no id would make a new user and end the
question. If that first
call fails, nobody is asked: SweatStack makes a new user as for anyone.

SweatStack doesn't tell the bridge when it knows a user, so a connection waiting for one asks every minute for its
first hour, and then backs off as any job does. The first files never wait much longer than a minute after the
athlete has answered.

**History reads `ready` once every window has an answer and at least one was accepted.** The platform has no
signal for "finished", and files keep arriving afterwards. If it accepted none, the connection stays `syncing`,
which SweatStack ends after 24 hours, and the next consent or permission change asks again.

**Ending a connection** has three ways in, and all three delete the row and its jobs and add a `declare`, whose
`DELETE` is what SweatStack hears last. The platform's webhook is one, and a day with no user is another.
SweatStack's signed disconnect is the third: it comes from the Portal or for a deleted user, and the bridge deregisters at
the platform first, answering `503` and keeping the row if the platform can't be reached, so "try again" is true.

[The contract](https://docs.sweatstack.no/learn/applications/self-hosted-integrations/) is the whole of what
SweatStack expects from it.

## Layout

```
src/
  index.ts            Worker entry: builds the dependencies
  app.ts              createApp(deps): the routes
  config.ts           Reads the settings; reports what's missing
  db.ts               The SQL: one method per query
  crypto.ts           Random values, hashes, the subject
  http.ts             Every outbound call goes through here
  log.ts              The one way to log
  sweatstack.ts       The calls to SweatStack's public API, and nothing else
  connections.ts      What a connection provides, whose it is, and its access token
  inbox/              The job queue, what runs the jobs, and the cron
  oidc/               The OpenID Provider: discovery, keys, registration, authorize, token
  flows/              The platform's redirect and webhooks, SweatStack's signed disconnect, what follows a consent
  providers/          Everything specific to one platform
migrations/           The D1 schema
scripts/              The owner's commands: deploy, dev, status, urls, update. Also the release notes
test/
  contract/           What SweatStack can see, over HTTP only
  internal/           What it can't see: races, retries, budgets
  fake-check/         Holds the fake SweatStack to a real one
  fakes/              The fake SweatStack and the fake Garmin
  fixtures/           Sample data shared with SweatStack
  support/            The test harness
```

## Run it

Needs Node 22 or later.

```sh
npm ci
cp .dev.vars.example .dev.vars   # fill in your keys
npm run dev                      # a local database, against the real services
npm test                         # needs no keys
npm run test:scripts             # the commands that can't run in the Workers runtime; needs git
npm run typecheck
```

`npm run deploy` applies migrations, makes sure the signing key exists, and then deploys, so live code always
finds the schema and the key it expects. Workers Builds runs the same script when you push.

## Rules

Check every change against these.

1. **One code path.** A step is one function. The live path calls it inline for speed, and a job calls it
   for safety. There is no separate retry logic, and no behaviour that exists only in tests.
2. **Every step can run twice.** Jobs may repeat, overlap or arrive out of order. They read current state
   when they run, and the two outside systems dedupe.
3. **Each fact has one owner.** SweatStack decides who a person is. The platform decides what was granted.
   D1 holds only what's needed to act, and anything that can be derived or fetched isn't stored. Daily values
   are the one kind of athlete data in it, because the platform sends nothing to fetch them by, and only until
   they're written.
4. **No setting for what can be derived.** Each setting is a step in the README and a way to get it wrong.
5. **Bounded everything.** Every outbound call has a timeout, every run has a budget, every retry has an
   end, and every table has a purge.
6. **Secrets stay out of logs and output.** Logging goes through `src/log.ts`. It never receives a token, a
   platform's file URL or a request URL, because the webhook path holds a secret. Secrets are compared in
   constant time.
7. **Migrations only add, run before the code deploys, and are never edited once published.** The running
   version then always works with the next schema, and a database that has already run a migration can't
   miss a change to it. A test holds that.

Core code never names a platform. Everything specific to one lives in `src/providers/`, and a test holds that.

## Limits

The bridge needs Cloudflare's Workers Paid plan: 30 seconds of CPU per request by default, and 10,000
subrequests. The free plan's 10 ms isn't enough. Measured on a real sign-in, from cold, the sign-in's requests
took 10 to 15 ms, and a request that does almost nothing took 8.

A run of the job queue still stops at 50 jobs or 25 seconds, so that one bad minute can't run for ever. The
next run carries on. Generating an RSA key takes up to 222 ms, and the deploy script does that, so the Worker
never needs to.

## Tests

- **`test/contract/`** speaks only HTTP, as SweatStack would: no reading the database, and nothing from `src/`
  beyond building the app.
- **`test/internal/`** covers what SweatStack can't see.
- **`test/fake-check/`** runs the same calls against the fake SweatStack and a real one, because the contract
  tests only prove the bridge matches the fake.

To run that last one against a real SweatStack, use a test app with no real users, with write ticked for
Activities and its Garmin card set to Self-hosted. Each run deletes and recreates one test user,
found by the reference `bridge-fake-check`:

```sh
SWEATSTACK_URL=... SWEATSTACK_APP_ID=... SWEATSTACK_CLIENT_SECRET=... npm run test:staging
```

## Updating a copy

[The runbook](RUNBOOK.md#run-it) has the commands. A copy made with the deploy button shares no git history with
this repository, so a plain `git merge` doesn't work. `npm run update` applies the difference between two releases as a three-way merge, keeping your edits
and marking real conflicts. Workers Builds then redeploys, and the deploy script applies any new migrations.

## Release

For this repository only: a copy has no reason to tag.

1. `npm version --no-git-tag-version 1.2.3`. A copy knows its version from `package.json`, and `npm run update`
   compares tags with it.
2. In `CHANGELOG.md`, turn what's under Unreleased into a section `## 1.2.3`, the heading `npm run update` and the
   release notes look for.
3. Commit, then `git tag v1.2.3 && git push origin main v1.2.3`. The Release workflow publishes that section, and
   refuses a tag that doesn't match `package.json` or has no section.

Pushing to `main` changes nothing for anyone: only a tag is noticed, and then only by `npm run status`.
