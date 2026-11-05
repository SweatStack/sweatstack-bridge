# Runbook

Everything an owner of a bridge does by hand, and how to tell it worked. [DEVELOPING.md](DEVELOPING.md) explains
how the code works.

- [Before you start](#before-you-start)
- [Deploy](#deploy)
- [Settings](#settings)
- [Run it](#run-it): check on it, update it
- [Set up Garmin's notifications](#set-up-garmins-notifications)
- [Fix a missing Disconnect button](#fix-a-missing-disconnect-button)
- [Try a sign-in again](#try-a-sign-in-again)

## Before you start

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

Three things to get right from the start:

- **Choose your domain before athletes connect.** Moving it later means repeating steps 4 and 6. To use your own, add `"routes": [{ "pattern": "garmin.example.com", "custom_domain": true }]` to `wrangler.jsonc`.
- **Don't delete the D1 database.** Without it, every athlete has to connect again and comes back as a new user. `npx wrangler d1 export` makes a backup. The file holds their tokens, so keep it safe.
- **Deploy one bridge per Cloudflare account, or rename its database.** A second copy with the same `database_name` attaches to the first copy's database, and shares its tokens.

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
| `GARMIN_APP_OFFERS` | What your Garmin app is approved for: `activities`, `activity_history`, `wellness`, `workouts`. Athletes are only asked to reconnect for what your app can actually request |

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

- Activity: Activity Files (ping)
- Common: User Permissions Change
- Common: Deregistrations

Leave every other setting disabled. Garmin allows one URL per setting, so any other server you had on these
settings stops receiving them.

### What goes wrong without each one

| Missing | What you see |
|---|---|
| Activity Files | New activities and history never arrive, because Garmin delivers both as these pings. A sign-in still works |
| User Permissions Change | When an athlete changes what they share, the status and the Portal stay out of date, and history doesn't start when they allow it later |
| Deregistrations | When an athlete removes your app in Garmin Connect, the connection stays. It only shows as needing a reconnect once the bridge next fails to use its token |

The bridge can't know about anything that happened before the URL was set. To correct a connection from that
time, have the athlete sign in again.

### Check it

| Do this in Garmin Connect | Then, in `inbox` |
|---|---|
| Sync an activity | A finished `activity_file` row with no `last_error` |
| Change what you share with the app | A finished `permissions_change` row |
| Remove the app from your connected apps | The connection is gone, and a finished `declare` row is left |

```sh
npx wrangler d1 execute sweatstack-bridge --remote --command "SELECT kind, attempts, last_error, done_at FROM inbox ORDER BY id DESC LIMIT 5"
```

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
