# Contributing

Issues and pull requests are welcome, with no promise of a reply. See "No guarantees" in the
[README](README.md).

## Checks

```sh
npm ci
npm run typecheck
npm test
```

## The rules

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
7. **Migrations only add, and run before the code deploys**, so the running version always works with the
   next schema.

Core code never names a platform. Everything specific to one lives in `src/providers/`, and a test holds
that.

## Tests

- `test/contract/` tests what SweatStack can see. These speak only HTTP: no imports from `src/` beyond
  building the app, and no reading the database.
- `test/internal/` tests what SweatStack can't see, such as races, retries and budgets.
- `test/fake-check/` runs the same calls against the fake SweatStack and against a real one, because the
  contract tests only prove anything if the fake is right.

`npm run test:staging` runs that last check against a real SweatStack. Set `SWEATSTACK_URL`,
`SWEATSTACK_APP_ID` and `SWEATSTACK_CLIENT_SECRET` for a test app whose Garmin card is set to Self-hosted.
Never point it at an app with real users.
