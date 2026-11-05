# SweatStack bridge

The SweatStack bridge is an OpenID Provider that brokers your athletes' Garmin sign-in to SweatStack Sign-In, and a client of SweatStack's public API that relays their data. It runs under your domain, on your Garmin keys.

> **Status: being built.** This README describes bridge 0.1, which doesn't exist yet. The deploy button
> and most commands below don't work yet, and the SweatStack feature the bridge depends on most, signing
> in through a provider you run yourself, is still being built too.

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/SweatStack/sweatstack-bridge)

## Why you would run this

The bridge is a small service you deploy yourself, on your own Garmin keys, while your athletes keep the
normal sign-in:

- **Your Garmin consent.** Athletes pick Garmin on SweatStack Sign-In, see Garmin's consent screen
  with your app's name, and return to your app signed in.
- **Your keys and tokens.** The Garmin client secret and every athlete's Garmin tokens stay in your
  Cloudflare account. SweatStack holds no Garmin credential and no Garmin user id.
- **Truthful status.** The bridge tells SweatStack what each connection can do, so the account status
  and the Portal stay correct, including "Reconnect Garmin" when an athlete didn't grant activity export.
- **Your code, if you prefer.** SweatStack doesn't depend on this repository. Anything that meets
  the [self-hosted integration contract](https://docs.sweatstack.no) works, including an existing
  Garmin integration of your own. The bridge is the reference implementation for those who don't
  have one.

Bridge 0.1 covers activities and activity history. Workouts and health summaries come in later versions.

## How it works

```
                     sign-in (OpenID Connect)
 Garmin  ◄────────►  Bridge  ◄────────────────►  SweatStack  ◄────►  Your app
 consent, tokens,    (your Worker,                Sign-In, API,
 webhooks, files     your D1)                     Portal
                        └── activity files, connection state ──►
                            (public API, on your app's credentials)
```

The bridge is two things:

- **An OpenID Provider, one issuer per platform.** SweatStack is its relying party. When an athlete
  picks Garmin, the bridge runs Garmin's consent, starts the backfill, tells SweatStack what the
  connection provides, and hands SweatStack an ID token. SweatStack makes or finds your app's user;
  the bridge never creates one.
- **A client of the public API.** Garmin pings the bridge whenever a file is ready. The bridge
  acknowledges at once, queues the work in D1, downloads the file with the athlete's token, and
  uploads it to SweatStack, deduplicated on Garmin's activity id. A cron trigger runs every minute
  and handles retries.

## Before you start

- **A live SweatStack app:** public profile, purposes, and the developer terms and DPA accepted on
  the Consent screen tab. Its scopes must include `activities:write`, or SweatStack refuses every
  relayed file.
- **Your athletes get Garmin in one of two ways.** They sign in with it on SweatStack Sign-In, or, if
  they are already one of your app's users, they connect it from the Portal. So an app with its own
  sign-in can use the bridge too: create the user, send them to the Portal, and they connect there.
- **Send athletes straight to Garmin if Garmin is what they need**, with `integration=garmin_connect`
  on your authorize request. Once your app runs Garmin itself, its sign-in page has no email field:
  athletes pick a platform, or use an existing SweatStack account. Someone who signs in with a
  platform that SweatStack hosts gets a SweatStack account, which can't connect your Garmin; to get it,
  they sign in with Garmin, which creates a new, separate user. That user may use the same email
  address, so never merge users by email. The Garmin account is how they get back in, so someone who
  loses access to it can't return to that user.
- **Keys from Garmin's developer program.** Request these early, because it's the one step whose
  timing you don't control. Starter access is approved in about an hour; Enterprise takes longer.
- **A Cloudflare account.** The free plan covers a small app, and USD 5 a month removes the worry
  about its limits.

## Deploy

1. **Click the deploy button.** Cloudflare copies this repository to your GitHub or GitLab account,
   creates the Worker and its D1 database, and asks for the settings below. You can leave anything
   you don't have yet empty.
2. **Clone your copy and log in to Cloudflare:**

   ```sh
   npm ci
   npx wrangler login
   npm run status   # what's still missing; no secrets, safe to share
   npm run urls     # every URL you need to paste; includes a secret, so keep it private
   ```

3. **In SweatStack's OAuth tab**, create a client secret for the bridge. Set `SWEATSTACK_APP_ID` and
   `SWEATSTACK_CLIENT_SECRET` on the Worker.
4. **In Garmin's developer tools**, paste the OAuth redirect URI and the seven endpoint URLs from
   `npm run urls`. Set `GARMIN_CLIENT_ID` and `GARMIN_CLIENT_SECRET` on the Worker.
5. **In SweatStack's Data sources tab**, choose "Self-hosted" on the Garmin card and paste the issuer
   URL from `npm run urls`. SweatStack registers itself with the bridge, so no secret crosses a human.
6. **Test in a private window.** A federated sign-in always produces your app's user, and leaves your
   own SweatStack session alone.

Choose your domain before athletes connect. The issuer and webhook URLs are derived from the domain
the Worker runs on, so moving it later means repeating steps 4 and 5. Your athletes stay the same users.

**Don't delete the D1 database.** It holds every athlete's Garmin tokens and the key that identifies
them. Without it, every athlete has to connect again and comes back as a new user. `npx wrangler d1
export` makes a backup; the file holds those tokens, so keep it as safe as your Garmin secret.

### Settings

| Name | Kind | What |
|---|---|---|
| `SWEATSTACK_URL` | var | Where SweatStack runs. Leave as is unless you're pointed at staging |
| `SWEATSTACK_APP_ID` | var | Your app's client id, from the OAuth tab |
| `GARMIN_CLIENT_ID` | var | Your Garmin client id |
| `BACKFILL_DAYS` | var | Days of history to request when an athlete connects. Default 90 |
| `SWEATSTACK_CLIENT_SECRET` | secret | A client secret of your app, separate from your backend's so the two rotate independently |
| `GARMIN_CLIENT_SECRET` | secret | Your Garmin client secret. Sent to Garmin's token endpoint and nowhere else |

The deploy generates the random webhook path segment itself. It never appears on a web page: only
`npm run urls` shows it, through your Cloudflare login.

## Updating

```sh
npm run update            # to the latest release
npm run update -- v0.2.0  # to a specific one
```

The command applies the difference between your version and the new one as a three-way merge, keeping
your own edits and marking any real conflicts. Review the result, commit and push. Workers Builds
redeploys, and the deploy script applies any new database migrations.

Plain `git merge upstream/main` doesn't work on a copy made with the deploy button, because the copy
shares no git history with this repository.

Nothing published here changes your deployment. `npm run status` tells you when a release is available.
You can also watch this repository on GitHub (Watch, Custom, Releases).

## Run it locally

```sh
npm ci
cp .dev.vars.example .dev.vars   # fill in your keys
npm run dev         # local D1, against the real Garmin and SweatStack
npm test            # the full suite, in the Workers runtime, needs no keys
npm run typecheck
```

## What it doesn't do

- It keeps no athlete data. A file is held in memory between download and upload, and is never
  written to D1 or other storage.
- It has no admin page and no admin password. You reach it through your Cloudflare login.
- It serves only your app's own users. A SweatStack account can't connect through it.

## No guarantees

**This software comes with no guarantees of any kind.** We publish it in the hope that it's useful, and
we promise nothing about it. Specifically, we don't promise that it:

- works, is free of bugs, or is secure
- keeps working when SweatStack, Garmin or Cloudflare change something
- gets updates, fixes or answers to your questions
- suits your app, or meets any agreement or law that applies to you

**Running it is your responsibility.** That includes your deployment, your athletes' tokens and data, any
agreements that apply to you, and any harm or loss that comes from using this code. Read the code and test it before
you rely on it. SweatStack doesn't operate, monitor or update your deployment.

Issues and pull requests are welcome, with no promise of a reply. When something is wrong, start with
`npm run status`, and include its output if you open an issue.

The [LICENSE](LICENSE) is what legally applies. Your use of SweatStack's own service stays under your
agreement with SweatStack, which this repository doesn't change.

## License

[MIT](LICENSE). Use it for anything, commercial or not, change it and redistribute it, without asking or
paying. The only condition is to keep the copyright and license notice in copies of the code.
