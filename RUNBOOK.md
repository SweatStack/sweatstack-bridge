# Runbook

What an owner of a bridge does by hand, and how to tell it worked. [DEVELOPING.md](DEVELOPING.md) explains
how the code works.

## Set up Garmin's notifications

Garmin tells the bridge about new files, changed permissions and removed connections by calling three URLs.
Garmin only calls the URLs you've set for your consumer key. Nothing warns you if you haven't, because sign-in
works without them.

Run this in your copy:

```sh
npm run urls
```

It prints every URL to paste and where it goes, and checks the bridge answers on each one. The webhook URLs hold
a secret, so keep the output private. It finds your bridge's address through
Cloudflare. `npm run urls -- --origin https://your-bridge` overrides that.

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

## Try a sign-in again

Add `prompt=login` to your authorize URL when you test. If the browser is already signed in to your app,
SweatStack answers an authorize request at once and never asks Garmin or the bridge. That is correct for an
athlete and easy to mistake for a fault in a test. A private window doesn't help if another private window is
still open, because they share their cookies. With `prompt=login`, SweatStack shows its sign-in page instead:
choose Garmin there.

No request to `/oidc/garmin_connect/authorize` in `npx wrangler tail` means the sign-in never reached the
bridge.
