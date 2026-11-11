# Changelog

Versions follow [Semantic Versioning](https://semver.org). `npm run update` moves a deployment between
them.

## 0.4.2

- **The npm scripts work on Windows:** `npm run urls`, `dev`, `deploy`, `status` and `verify` couldn't start wrangler there, and `npm run urls` asked you to run `npx wrangler login`, even after you had. When wrangler can't tell which Cloudflare account to use, the scripts now show its own error, and point out that a `CLOUDFLARE_API_TOKEN` takes precedence over `npx wrangler login`.

## 0.4.1

- **A file the bridge skips is logged, with the reason:** `file_skipped` with `manual` for an activity entered by hand, which has no file, or `format` for a format the bridge doesn't relay, such as TCX. The warning `file_ping_unreadable` says that Garmin left out a field the bridge needs. Before, the bridge skipped these without a word, and Garmin still heard 200.

## 0.4.0

- **`npm run verify` helps you pass Garmin's partner verification**, before or after you set Garmin to Self-hosted in SweatStack. It makes a Garmin sign-in link that needs no SweatStack, and a walk to import. The runbook's section "Pass Garmin's verification" has the steps. Your app works without the verification.
- **Warnings in the logs** say why nothing reaches SweatStack: `sweatstack_not_connected` when SweatStack answers that Garmin isn't Self-hosted, with the fix, `push_waiting_for_user` once for each push whose athlete has no user yet, and `webhook_refused` with the reason for each push the bridge refused. Garmin counts each refused push as an error.

## 0.3.0

- **Wellness:** resting heart rate, sleep duration, HRV, body mass and body fat from Garmin's health summaries, written to SweatStack as the athlete's dailies with `platform` `garmin_connect`, the same values SweatStack's own Garmin connection fills. A later value replaces what the day held, including one the athlete entered. With history on offer, the last 28 days are asked for when an athlete connects. To turn it on, see the runbook's Wellness section: your Garmin app needs the Health API. **If `GARMIN_APP_OFFERS` already names `wellness`, this update turns it on**, and athletes who didn't share their health data are asked to reconnect: before updating, tick write for Wellness on your app's Consent screen tab and set up the four health settings in Garmin's tool. Without `wellness` in `GARMIN_APP_OFFERS`, nothing changes.
- **Daily values wait in the bridge's database** until they're delivered, for at most 3 days, and nothing else from Garmin's health summaries is kept. Files are still never stored.
- **On its first run of this version, every bridge tells SweatStack again what each connection provides**, as it does when you change `GARMIN_APP_OFFERS`.
- **`npm run urls` names Garmin's settings as its endpoint configuration does**, such as `ACTIVITY - Activity Files`, and in the same order, so you can go down the page. The URLs are unchanged.

## 0.2.0

- **Uploads name the platform as `platform`**, which SweatStack reads from its release 0.155.0 of 2026-11-09. **Update now:** a bridge on 0.1.0 relays files without their platform, and an athlete who moved their account to your app gets each earlier activity twice. Nothing to configure.

## 0.1.0

- **Sign-in with Garmin:** an OpenID Provider with discovery, keys, registration, the authorization code flow and the connection call.
- **Activity files and history** are relayed, with retries and token refresh.
- **Connections are looked after:** permission changes, deregistration, and the refresh of a quiet athlete's grant. A connection nobody claims within a day is removed.
- **Disconnect:** the Portal and SweatStack's request for a deleted user end a connection, with a signed request.
- **Moving an existing account:** the call after consent tells SweatStack who the person is at the platform, once, and the bridge keeps it nowhere. Someone who already uses your app through a SweatStack account can then be asked whether to move that account.
- **Commands:** `npm run status` reports on a bridge, with nothing you can't share. `npm run urls` prints every URL to paste. `npm run update` moves a copy to a newer release and keeps its edits.
