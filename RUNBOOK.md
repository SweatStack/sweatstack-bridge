# Runbook

Everything an owner of a bridge does by hand, and how to tell it worked. The bridge works with Garmin, so the
wearable platform steps here are Garmin's. [DEVELOPING.md](DEVELOPING.md) explains how the code works.

- [Before you start](#before-you-start)
- [Deploy](#deploy)
- [Settings](#settings)
- [Run it](#run-it): check on it, update it
- [Back up and restore](#back-up-and-restore)
- [Set up Garmin's notifications](#set-up-garmins-notifications)
- [Wellness](#wellness): dailies from Garmin
- [Pass Garmin's verification](#pass-garmins-verification)
- [Fix a missing Disconnect button](#fix-a-missing-disconnect-button)
- [Try a sign-in again](#try-a-sign-in-again)

## Before you start

If your app already has athletes who use it with Garmin through SweatStack, email [info@sweatstack.no](mailto:info@sweatstack.no) before you deploy. We help you move them, and they keep their history.

- [ ] A [live app on SweatStack](https://docs.sweatstack.no/learn/applications/going-live/) with **write** ticked for Activities under "Data your app uses". Without it, SweatStack refuses every file
- [ ] [Keys from Garmin's developer program](https://docs.sweatstack.no/learn/integrations/garmin/). Request them early: it's the one step whose timing you don't control
- [ ] A Cloudflare account on the [Workers Paid plan](https://developers.cloudflare.com/workers/platform/pricing/): USD 5 a month, which covers a small app. The free plan's CPU limit is too tight for the bridge
- [ ] You've read [what changes for your users](https://docs.sweatstack.no/learn/applications/self-hosted-integrations/#what-athletes-see-on-your-sign-in-screen). In short: your sign-in page loses its email field, and one person can end up as two users. **Never merge users by email**

## Deploy

1. [Deploy to Cloudflare](https://deploy.workers.cloudflare.com/?url=https://github.com/SweatStack/sweatstack-bridge). Leave anything you don't have yet empty, and set it in steps 3 to 5.
2. Clone your copy, then:

   ```sh
   npm ci
   npx wrangler login
   npm run status   # what's still missing; no secrets, safe to share
   npm run urls     # every URL to paste; includes a secret, so keep it private
   ```

3. **In SweatStack's OAuth tab:** create a client secret. Then run `npx wrangler secret put SWEATSTACK_APP_ID`, and the same for `SWEATSTACK_CLIENT_SECRET`.
4. **In Garmin's developer tools:** [paste the URLs](#set-up-garmins-notifications). Then set `GARMIN_CLIENT_ID` and `GARMIN_CLIENT_SECRET` the same way.
5. **In `wrangler.jsonc`:** set `GARMIN_APP_OFFERS` to what your Garmin app is approved for, then commit and push.
6. **In SweatStack's Data sources tab:** choose "Self-hosted" on the Garmin card and paste the issuer URL.
7. Run `npm run status`, then [try a sign-in](#try-a-sign-in-again) in a private window.
8. **At Garmin:** [pass the partner verification](#pass-garmins-verification). Your app works without it: until it passes, Garmin shows your athletes that your app is unverified. You can do it before step 6.

Three things to get right from the start:

- **Decide on your address before step 4, so you only paste the URLs once.** Your bridge starts at `https://sweatstack-bridge.<your-subdomain>.workers.dev`, and you can keep it: athletes only pass through it during sign-in. Use your own domain if you want the bridge to stay at one address wherever it runs, or don't want to show your Cloudflare subdomain. The domain has to be on Cloudflare in the same account. Then add `"routes": [{ "pattern": "garmin.example.com", "custom_domain": true }]` to `wrangler.jsonc`. Moving later means repeating steps 4 and 6.
- **Don't delete the D1 database.** Without it, every athlete has to connect again and comes back as a new user. See [Back up and restore](#back-up-and-restore).
- **A second bridge in the same Cloudflare account, such as a test setup, needs its own name and database.** A copy with the same `database_name` attaches to the first copy's database, and shares its tokens. The button deploys before you can change that, so don't use it for the second one. Clone this repository, change `name` and `database_name` in `wrangler.jsonc`, then run `npm ci` and `npm run deploy`. Continue from step 2. Where a step says push, run `npm run deploy` again.

## Settings

Set these with `npx wrangler secret put <name>`. A deploy leaves them alone.

| Name | What |
|---|---|
| `SWEATSTACK_APP_ID` | Your app's client id |
| `SWEATSTACK_CLIENT_SECRET` | A client secret just for the bridge, so it rotates separately |
| `GARMIN_CLIENT_ID` | Your Garmin client id |
| `GARMIN_CLIENT_SECRET` | Your Garmin client secret |

Change these in `wrangler.jsonc` in your copy, not in the Cloudflare dashboard, because a deploy resets them to what the file says.

| Name | What |
|---|---|
| `SWEATSTACK_URL` | Where SweatStack runs. Leave as is |
| `BACKFILL_DAYS` | Days of history to request on connecting. Default 90 |
| `GARMIN_APP_OFFERS` | What your Garmin app is approved for: `activities`, `activity_history`, `wellness`, `workouts`. Athletes are only asked to reconnect for what your app can actually request. Garmin's Starter Access has no history: leave `activity_history` out. For `wellness`, see [Wellness](#wellness) |

## Run it

Nobody at SweatStack monitors your bridge, so this is yours to check.

```sh
npm run status
```

It shows your version, what's missing, whether your bridge and SweatStack answer, how many athletes are connected,
and which jobs are waiting or failed, with the fix where there's one. It prints no secrets, so it's safe to share.
More detail is in `npx wrangler tail`.

When it says a release is available:

```sh
npm run update            # to the latest release
npm run update -- v0.2.0  # to a specific one
```

It applies what changed between two releases and keeps your own edits, marking any real clash. Review the result,
commit and push: nothing published upstream changes your deployment until you do. To hear about releases on GitHub,
choose Watch, Custom, Releases on this repository.

## Back up and restore

The bridge's database holds every athlete's connection and their platform tokens. Lose it, and each athlete
has to connect again and comes back as a new user. Cloudflare keeps 30 days of its history, so most mistakes
can be undone in place. A file is only needed if the database itself is deleted.

The commands use the database name `sweatstack-bridge`. If you changed `database_name` in `wrangler.jsonc`,
use yours.

### Undo a change: go back to a moment in time

Before anything risky, such as a manual change in the database, note the current bookmark:

```sh
npx wrangler d1 time-travel info sweatstack-bridge
```

To go back, give that bookmark, or a moment within the last 30 days:

```sh
npx wrangler d1 time-travel restore sweatstack-bridge --bookmark <bookmark>
npx wrangler d1 time-travel restore sweatstack-bridge --timestamp 2026-11-09T10:00:00Z
```

It asks to confirm, then prints a bookmark that undoes the restore. Everything written after that moment
is gone: athletes who connected since connect again, and files the platform announced since aren't
relayed. Check with `npm run status` afterwards.

### Keep a copy as a file

```sh
npx wrangler d1 export sweatstack-bridge --remote --output bridge-backup.sql
```

The file holds every athlete's platform tokens. Keep it as safe as your platform's client secret, and
not in your repository. A copy is only as recent as its file, so make one before a change you're unsure
of.

### Restore the file into a new database

Only when the database was deleted:

```sh
npx wrangler d1 create sweatstack-bridge
npx wrangler d1 execute sweatstack-bridge --remote --file bridge-backup.sql
```

Put the `database_id` that `d1 create` printed into `wrangler.jsonc`, then commit and push. The bridge
comes back with its signing key and every connection in the file. Athletes who connected after the file
was made connect again.

## Set up Garmin's notifications

Garmin tells the bridge about new files, changed permissions and removed connections by calling three URLs.
Garmin only calls the URLs you've set for your consumer key. Nothing warns you if you haven't, because sign-in
works without them.

Run this in your copy:

```sh
npm run urls
```

It prints every URL to paste and where it goes, and checks the bridge answers on each one. The webhook URLs hold
a secret, so keep the output private. It finds your bridge's address through Cloudflare.
`npm run urls -- --origin https://your-bridge` overrides that.

Open [Garmin's endpoint configuration](https://apis.garmin.com/tools/endpoints) and sign in with the consumer
key and secret. Enable these three settings, with the URLs from the command:

- ACTIVITY - Activity Files
- COMMON - Deregistrations
- COMMON - User Permissions Change

Leave every other setting disabled, apart from the health ones under [Wellness](#wellness) if your app offers it.
Garmin allows one URL per setting, so any other server you had on these settings stops receiving them.

### What goes wrong without each one

| Missing | What you see |
|---|---|
| Activity Files | New activities and history never arrive, because Garmin announces both through this setting. A sign-in still works |
| User Permissions Change | When an athlete changes what they share, the status and the Portal stay out of date, and history doesn't start when they allow it later |
| Deregistrations | When an athlete removes your app in Garmin Connect, the connection stays. It only shows as needing a reconnect once the bridge next fails to use its token |
| A health setting | No dailies of that kind arrive. `npm run status` says "Last wellness: none on record" while none have |

The bridge can't know about anything that happened before the URL was set. To correct a connection from that
time, have the athlete sign in again.

### Check it

| Do this in Garmin Connect | Then, in `inbox` |
|---|---|
| Sync an activity | A finished `activity_file` row with no `last_error` |
| Change what you share with the app | A finished `permissions_change` row |
| Remove the app from your connected apps | The connection is gone, and a finished `declare` row is left |
| Sync a watch or a scale, with wellness on offer | A finished `wellness` row with no `last_error` |

```sh
npx wrangler d1 execute sweatstack-bridge --remote --command "SELECT kind, attempts, last_error, done_at FROM inbox ORDER BY id DESC LIMIT 5"
```

## Wellness

The bridge can relay an athlete's resting heart rate, sleep duration, HRV, body mass and body fat to SweatStack as
dailies, the same values SweatStack's own Garmin connection fills. It needs your Garmin app to have the Health API.

1. Add `wellness` to `GARMIN_APP_OFFERS` in `wrangler.jsonc`, then commit and push.
2. On your app's Consent screen tab in SweatStack, tick write for Wellness under Data your app uses.
3. Run `npm run urls`. In Garmin's endpoint configuration, enable the four health settings it prints, each
   with its URL: `HEALTH - Body Compositions`, `HEALTH - Dailies`, `HEALTH - HRV Summary` and
   `HEALTH - Sleeps`. Leave every other health setting disabled, and save the page.

Athletes are asked to share their health data on Garmin's consent screen, and athletes connected before are asked
to reconnect if they didn't. With `activity_history` on offer too, the bridge asks Garmin for each athlete's last
28 days when they connect.

A value replaces whatever SweatStack held for that day, including one the athlete entered. A value waits in the
bridge's database until it's delivered, for at most 3 days, and is deleted then. The rest of what Garmin sends
is never stored.

## Pass Garmin's verification

Your app works without this verification. Until it passes, Garmin shows your athletes that your app is unverified.

Garmin's [partner verification](https://apis.garmin.com/tools/partnerVerification) checks that your bridge gets
data from two Garmin users. You can pass it before you set Garmin to Self-hosted in SweatStack: `npm run verify`
connects two Garmin accounts of your own to the bridge, with no SweatStack in between. Nothing has to change after
it passes.

You need:

- **Account A:** your own Garmin account. If your app offers wellness, it needs a Garmin watch that records sleep
  and HRV status.
- **Account B:** a new Garmin account. Make it at https://connect.garmin.com. It is free and needs no watch.
- **One night** if your app offers wellness, because Garmin must receive sleep and HRV data. Without wellness, it
  takes about 15 minutes, and you skip steps 3 and 4.

1. [Set up Garmin's notifications](#set-up-garmins-notifications), and the health settings under
   [Wellness](#wellness) if your app offers it.
2. Run `npm run verify`. Open its link in a private browser window, sign in to Garmin with account A, and allow
   all permissions. You come back to this page.
3. With account A, enter a weight in Garmin Connect.
4. Wear the watch tonight. Tomorrow morning, sync it with the Garmin Connect app.
5. With account A, import the walk that `npm run verify` made, at https://connect.garmin.com/app/import-data.
6. Run `npm run verify` again. Connect account B with its new link.
7. With account B, import the new walk.
8. With account B, set one permission of your app to off in Garmin Connect, then to on again.
9. With account B, remove your app in Garmin Connect.
10. Open Garmin's [partner verification](https://apis.garmin.com/tools/partnerVerification), sign in with your
    consumer key, and select **Run Tests**. Do it within 24 hours of step 2.

You can run Garmin's tests at any time: a setting without data shows which step is still missing. Steps 5 to 9
can be in the evening or in the morning, because Garmin counts the last 24 hours.

- **The bridge ends each of these connections a day after its consent**, at Garmin too, because no SweatStack user
  claims it. To try again later, start at step 2.
- **If you come back to this page with `error=` in the address**, Garmin didn't connect the account. Run
  `npm run verify` for a new link.
- **If account A is already connected to your app**, the sign-in reconnects it, and the walk arrives as your
  activity.
- **Until you set Garmin to Self-hosted**, `npm run status` counts these accounts as waiting for a user and shows
  a `declare` failure, `sweatstack_409`. In `npx wrangler tail`, the bridge warns `sweatstack_not_connected` and
  `push_waiting_for_user`. All of that is expected here.

| Garmin's test | What passes it |
|---|---|
| "A deregistration endpoint, a user permissions change endpoint, and at least 1 other endpoint must be enabled." | Step 1 |
| "N enabled summary domain(s) without data in the last 24 hours." | Each setting you enabled gets data from a step, by the name Garmin's test shows: `ACTIVITY_FILE_DATA` from step 5, `WELLNESS_BODY_COMP` from step 3, `WELLNESS_DAILY`, `WELLNESS_SLEEP` and `HRV` from step 4, `CONSUMER_PERMISSIONS` from step 8, `USER_DEREG` from step 9 |
| "N user(s) with data uploaded in the last 24 hours. 2 required." | Steps 5 and 7 |
| "N http error(s) in the last 24 hours." | The bridge answered every push. If it refused one, `npx wrangler tail` shows `webhook_refused` with the reason. `unknown_secret`: paste the URLs that `npm run urls` prints again. `unknown_kind`: disable that setting at Garmin. `invalid_body`: report it. Garmin counts an error for 24 hours |

## Fix a missing Disconnect button

SweatStack reads the bridge's disconnect endpoint from its discovery document when you save the Garmin card. If
the Portal has no Disconnect button, open your app's Data sources tab and select **Save** on the card again. It
keeps your connections.

When an athlete disconnects, SweatStack waits five seconds for the answer. If Garmin is down, the bridge answers
`503`, the connection stays, and the Portal asks the athlete to try again.

## Try a sign-in again

Add `integration=garmin_connect&prompt=login` to your authorize URL when you test. If the browser is already
signed in to your app, SweatStack answers an authorize request at once and never asks Garmin or the bridge. That is correct for an
athlete and easy to mistake for a fault in a test. A private window doesn't help if another private window is
still open, because they share their cookies. With `prompt=login`, SweatStack shows its sign-in page instead:
choose Garmin there.

No request to `/oidc/garmin_connect/authorize` in `npx wrangler tail` means the sign-in never reached the
bridge.
