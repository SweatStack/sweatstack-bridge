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
- [ ] [Keys from Garmin's developer program](https://docs.sweatstack.no/learn/integrations/garmin/). Garmin approves a new app automatically, at once
- [ ] A Cloudflare account on the [Workers Paid plan](https://developers.cloudflare.com/workers/platform/pricing/): USD 5 a month, which covers a small app. The free plan's CPU limit is too tight for the bridge
- [ ] You've read [what changes for your users](https://docs.sweatstack.no/learn/applications/self-hosted-integrations/#what-athletes-see-on-your-sign-in-screen). In short: your sign-in page loses its email field, and one person can end up as two users. **Never merge users by email**

## Deploy

About 15 minutes, or 30 with Garmin's verification. You need no terminal.

1. **In SweatStack, on your app's OAuth tab:** create a client secret just for the bridge, so it rotates separately. Save it in your password manager: you paste it twice.
2. [Deploy to Cloudflare](https://deploy.workers.cloudflare.com/?url=https://github.com/SweatStack/sweatstack-bridge). Cloudflare makes a copy of this repository in your GitHub account, and deploys the bridge from it. Every push to that copy deploys again. **GitHub not connected to Cloudflare yet?** Connect it when Cloudflare asks, then click the button above again: only then does it offer to create the repository. Paste your app's Client ID and the secret from step 1, your Garmin client id and secret, and set `GARMIN_APP_OFFERS` to what your Garmin app is approved for. A field you leave empty can be added later, in the Worker's settings in Cloudflare, with no new deploy.
3. **Open your bridge's console**, at its address with `/console` at the end, such as `https://sweatstack-bridge.<your-subdomain>.workers.dev/console`. Sign in with the client secret from step 1.
4. **Do the four steps the console lists.** Each happens in one place, gives you the exact values to paste, and ticks itself off when the bridge sees it working:
   1. Connect your Garmin app, in Garmin's developer portal.
   2. Turn on Garmin's notifications, in Garmin's endpoint configuration. See [Set up Garmin's notifications](#set-up-garmins-notifications).
   3. Pass Garmin's verification, which is optional. See [Pass Garmin's verification](#pass-garmins-verification). Do it before step 4, so your athletes never see Garmin say that your app is unverified.
   4. Switch SweatStack to your bridge, on your app's Data sources tab. Then [try a sign-in](#try-a-sign-in-again) in a private window.

Once the steps are done, the console is where you [check on your bridge](#run-it).

Three things to get right from the start:

- **Decide on your address before you paste the console's URLs, so you only paste them once.** Your bridge starts at `https://sweatstack-bridge.<your-subdomain>.workers.dev`, and you can keep it: athletes only pass through it during sign-in. Use your own domain if you want the bridge to stay at one address wherever it runs, or don't want to show your Cloudflare subdomain. The domain has to be on Cloudflare in the same account. Then add `"routes": [{ "pattern": "garmin.example.com", "custom_domain": true }]` to `wrangler.jsonc`. Moving later means repeating the console's steps 1, 2 and 4.
- **Don't delete the D1 database.** Without it, every athlete has to connect again and comes back as a new user. See [Back up and restore](#back-up-and-restore).
- **A second bridge in the same Cloudflare account, such as a test setup, needs its own name and database.** A copy with the same `database_name` attaches to the first copy's database, and shares its tokens. The button deploys before you can change that, so don't use it for the second one. Clone this repository, change `name` and `database_name` in `wrangler.jsonc`, then run `npm ci` and `npm run deploy`. Set its secrets with `npx wrangler secret put <name>`, and continue from step 3. Where a step says push, run `npm run deploy` again.

## Settings

Add these in the Worker's settings in Cloudflare, under Variables and Secrets, or with `npx wrangler secret put <name>`. A deploy leaves them alone, and a new one takes effect without a deploy.

| Name | What |
|---|---|
| `SWEATSTACK_CLIENT_ID` | Your app's Client ID, from its OAuth tab in SweatStack. The same value as its Application ID. Before 0.5.0 this was `SWEATSTACK_APP_ID`, which still works |
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

Nobody at SweatStack monitors your bridge, so this is yours to check. Open your bridge's console, at its
address with `/console` at the end. It shows what's missing, when Garmin last sent to each URL, how many
athletes are connected, which jobs are waiting or failed with the fix where there's one, and when a release
is out. It never shows a client secret or anything about an athlete. More detail is in the Worker's logs in
Cloudflare, or in `npx wrangler tail`.

When the console says a release is available, in your copy:

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
relayed. Check the console afterwards.

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

Step 2 of your bridge's console lists every URL to paste, with when Garmin last sent to it. The URLs hold a
secret, so keep them private.

Open [Garmin's endpoint configuration](https://apis.garmin.com/tools/endpoints) and sign in with the consumer
key and secret. Enable these three settings, with the URLs from the console:

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
| A health setting | No dailies of that kind arrive. The console says nothing has come to that URL |

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

If an activity gives no row, run `npx wrangler tail` and sync it again. The bridge logs why it skipped the file:

- `file_skipped` with `manual`: Garmin sent an activity that no device recorded, without a file. Garmin does send a file for an activity entered by hand or imported into Garmin Connect, so those are relayed. One entered by hand has no activity data in it, and SweatStack records its upload as failed with `no_data`.
- `file_skipped` with `format`: Garmin has the activity in a format the bridge doesn't relay, such as `TCX`.
- The warning `file_ping_unreadable`: Garmin left out a field the bridge needs. Report it.

## Wellness

The bridge can relay an athlete's resting heart rate, sleep duration, HRV, body mass and body fat to SweatStack as
dailies, the same values SweatStack's own Garmin connection fills. It needs your Garmin app to have the Health API.

1. Add `wellness` to `GARMIN_APP_OFFERS` in `wrangler.jsonc`, then commit and push.
2. On your app's Consent screen tab in SweatStack, tick write for Wellness under Data your app uses.
3. Step 2 of your console now lists the four health settings, each with its URL. In Garmin's endpoint
   configuration, enable them: `HEALTH - Body Compositions`, `HEALTH - Dailies`, `HEALTH - HRV Summary` and
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

Run `npm run verify` in your copy. It walks you through the steps below one at a time, and goes on once a step's
data has reached the bridge. Type q to stop at any step, and run it again to carry on there. It's the one step
that still needs a terminal: clone the copy that Cloudflare made in your GitHub account, then, in that folder,
run `npm ci` and, once on this computer, `npx wrangler login`.

You need:

- **Account A:** your own Garmin account. If your app offers wellness, it needs a Garmin watch that records sleep
  and HRV status. Without wellness, it needs no watch.
- **Account B:** a new Garmin account. Make it at https://connect.garmin.com. It is free and needs no watch.
- **About 15 minutes.** With wellness, one night more, because Garmin must receive sleep and HRV status.

1. [Set up Garmin's notifications](#set-up-garmins-notifications), and the health settings under
   [Wellness](#wellness) if your app offers it.
2. Open the link that `npm run verify` prints in a private browser window. Sign in to Garmin with account A, and
   allow all permissions. You come back to this page.
3. With account A, import the walk that `npm run verify` made, at https://connect.garmin.com/app/import-data.
4. Connect account B with the new link that `npm run verify` prints.
5. With account B, import the new walk.
6. With account B, turn off one of your app's permissions in Garmin Connect.
7. With account B, remove your app in Garmin Connect.
8. Only with wellness: with account A, enter a weight in Garmin Connect.
9. Only with wellness: wear the watch tonight. Tomorrow morning, sync it with the Garmin Connect app.
10. Open Garmin's [partner verification](https://apis.garmin.com/tools/partnerVerification), sign in with your
    consumer key, and select **Run Tests**. Do it within 24 hours of step 2, because Garmin counts the last 24 hours.
    Without wellness, this is step 8 in `npm run verify`.

You can run Garmin's tests at any time: a setting without data shows which step is still missing.

- **The bridge ends each of these connections a day after its consent**, at Garmin too, because no SweatStack user
  claims it. `npm run verify` then starts again at step 2 by itself.
- **If you come back to this page with `error=` in the address**, Garmin didn't connect the account.
  `npm run verify` prints a new link. If Garmin shows an error page instead, type n for a new link.
- **If account A is already connected to your app**, the sign-in reconnects it, and the walk arrives as your
  activity.
- **Until you set Garmin to Self-hosted**, the console counts these accounts as waiting for SweatStack and
  shows a `declare` failure, `sweatstack_409`. In `npx wrangler tail`, the bridge warns `sweatstack_not_connected` and
  `push_waiting_for_user`. All of that is expected here.

| Garmin's test | What passes it |
|---|---|
| "A deregistration endpoint, a user permissions change endpoint, and at least 1 other endpoint must be enabled." | Step 1 |
| "N enabled summary domain(s) without data in the last 24 hours." | Each setting you enabled gets data from a step, by the name Garmin's test shows: `ACTIVITY_FILE_DATA` from steps 3 and 5, `CONSUMER_PERMISSIONS` from step 6, `USER_DEREG` from step 7, `WELLNESS_BODY_COMP` from step 8, `WELLNESS_DAILY`, `WELLNESS_SLEEP` and `HRV` from step 9 |
| "N user(s) with data uploaded in the last 24 hours. 2 required." | Steps 3 and 5 |
| "N http error(s) in the last 24 hours." | The bridge answered every push. If it refused one, `npx wrangler tail` shows `webhook_refused` with the reason. `unknown_secret`: paste the URLs from the console again. `unknown_kind`: disable that setting at Garmin. `invalid_body`: report it. Garmin counts an error for 24 hours |

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
