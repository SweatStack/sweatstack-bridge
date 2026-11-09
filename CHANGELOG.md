# Changelog

Versions follow [Semantic Versioning](https://semver.org). `npm run update` moves a deployment between
them.

## Unreleased

- **Wellness:** resting heart rate, sleep duration, HRV, body mass and body fat from Garmin's health summaries, written to SweatStack as the athlete's dailies with `platform` `garmin_connect`, the same values SweatStack's own Garmin connection fills. A later value replaces what the day held, including one the athlete entered. With history on offer, the last 28 days are asked for when an athlete connects. To turn it on, see the runbook's Wellness section: your Garmin app needs the Health API. **If `GARMIN_APP_OFFERS` already names `wellness`, this update turns it on**, and athletes who didn't share their health data are asked to reconnect: before updating, tick write for Wellness on your app's Consent screen tab and set up the four health settings in Garmin's tool. Without `wellness` in `GARMIN_APP_OFFERS`, nothing changes.
- **Daily values wait in the bridge's database** until they're delivered, for at most 3 days, and nothing else from Garmin's health summaries is kept. Files are still never stored.
- **On its first run of this version, every bridge tells SweatStack again what each connection provides**, as it does when you change `GARMIN_APP_OFFERS`.

## 0.2.0

- **Uploads name the platform as `platform`**, which SweatStack reads from its release 0.155.0 of 2026-11-09. **Update now:** a bridge on 0.1.0 relays files without their platform, and an athlete who moved their account to your app gets each earlier activity twice. Nothing to configure.

## 0.1.0

- **Sign-in with Garmin:** an OpenID Provider with discovery, keys, registration, the authorization code flow and the connection call.
- **Activity files and history** are relayed, with retries and token refresh.
- **Connections are looked after:** permission changes, deregistration, and the refresh of a quiet athlete's grant. A connection nobody claims within a day is removed.
- **Disconnect:** the Portal and SweatStack's request for a deleted user end a connection, with a signed request.
- **Moving an existing account:** the call after consent tells SweatStack who the person is at the platform, once, and the bridge keeps it nowhere. Someone who already uses your app through a SweatStack account can then be asked whether to move that account.
- **Commands:** `npm run status` reports on a bridge, with nothing you can't share. `npm run urls` prints every URL to paste. `npm run update` moves a copy to a newer release and keeps its edits.
