# Changelog

Versions follow [Semantic Versioning](https://semver.org). `npm run update` moves a deployment between
them.

## Unreleased

- **Sign-in with Garmin:** an OpenID Provider with discovery, keys, registration, the authorization code flow and the connection call.
- **Activity files and history** are relayed, with retries and token refresh.
- **Connections are looked after:** permission changes, deregistration, and the refresh of a quiet athlete's grant. A connection nobody claims within a day is removed.
- **Disconnect:** the Portal and SweatStack's request for a deleted user end a connection, with a signed request.
- **Commands:** `npm run status` reports on a bridge, with nothing you can't share. `npm run urls` prints every URL to paste. `npm run update` moves a copy to a newer release and keeps its edits.
