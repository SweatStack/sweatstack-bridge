# Changelog

Versions follow [Semantic Versioning](https://semver.org). `npm run update` moves a deployment between
them.

## Unreleased

- **Uploads name the platform as `platform`**, which SweatStack reads from its release that separates who wrote a record from where its data came from. **Update on the day that release ships:** a bridge on 0.1.0 relays files without their platform, and an athlete who moved their account to your app gets each earlier activity twice. Nothing to configure.

## 0.1.0

- **Sign-in with Garmin:** an OpenID Provider with discovery, keys, registration, the authorization code flow and the connection call.
- **Activity files and history** are relayed, with retries and token refresh.
- **Connections are looked after:** permission changes, deregistration, and the refresh of a quiet athlete's grant. A connection nobody claims within a day is removed.
- **Disconnect:** the Portal and SweatStack's request for a deleted user end a connection, with a signed request.
- **Moving an existing account:** the call after consent tells SweatStack who the person is at the platform, once, and the bridge keeps it nowhere. Someone who already uses your app through a SweatStack account can then be asked whether to move that account.
- **Commands:** `npm run status` reports on a bridge, with nothing you can't share. `npm run urls` prints every URL to paste. `npm run update` moves a copy to a newer release and keeps its edits.
