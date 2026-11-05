# Developing

How the bridge works, and how to run and change it. Start here if you're changing your own copy.

**Being built.** This describes the code as it's intended to be, and some of it doesn't exist yet. So far
there's the OpenID Provider and the sign-in. Files, retries and the owner's commands come next.

## How it works

The bridge is two things that share only a user id:

- **An OpenID Provider, one issuer per platform.** SweatStack is its relying party. The bridge runs the
  platform's consent, starts the backfill, tells SweatStack what the connection provides, and hands back an
  ID token. SweatStack makes or finds the user; the bridge never creates one.
- **A client of SweatStack's public API.** The platform pings the bridge when a file is ready. The bridge
  acknowledges at once, queues the work in D1, downloads the file and uploads it to SweatStack, deduplicated
  on the platform's activity id. A cron trigger every minute handles retries.

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
  connections.ts      What a connection provides, and whose it is
  oidc/               The OpenID Provider: discovery, keys, registration, authorize, token
  flows/              The platform's redirect, and what follows a consent
  providers/          Everything specific to one platform
migrations/           The D1 schema
scripts/              deploy, dev, and what they share
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
   D1 holds only what's needed to act, and anything that can be derived or fetched isn't stored.
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

## Free plan limits

The design assumes Cloudflare's free plan: 10 ms of CPU per request or run, and 50 external subrequests.

| Work | CPU, measured |
|---|---|
| Generating an RSA key | 24 to 222 ms, so the deploy script does it and the Worker never does |
| Signing an ID token | 1 to 3 ms |
| Relaying a file | About 3 ms per MB |
| Verifying a registration | 11 ms from cold. It's rare, and SweatStack can simply be asked to save again |

## Tests

- **`test/contract/`** speaks only HTTP, as SweatStack would: no reading the database, and nothing from `src/`
  beyond building the app.
- **`test/internal/`** covers what SweatStack can't see.
- **`test/fake-check/`** runs the same calls against the fake SweatStack and a real one, because the contract
  tests only prove the bridge matches the fake.

To run that last one against a real SweatStack, use a test app with no real users, with the
`activities:write` scope and its Garmin card set to Self-hosted. Each run deletes and recreates one test user,
found by the reference `bridge-fake-check`:

```sh
SWEATSTACK_URL=... SWEATSTACK_APP_ID=... SWEATSTACK_CLIENT_SECRET=... npm run test:staging
```

## Updating a copy

A copy made with the deploy button shares no git history with this repository, so a plain `git merge` doesn't
work. `npm run update` applies the difference between two releases as a three-way merge, keeping your edits
and marking real conflicts. Workers Builds then redeploys, and the deploy script applies any new migrations.
