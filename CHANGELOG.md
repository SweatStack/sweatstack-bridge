# Changelog

Versions follow [Semantic Versioning](https://semver.org). `npm run update` moves a deployment between
them.

## Unreleased

Not usable yet. The OpenID Provider and the sign-in, on Garmin: discovery, keys, registration, the
authorization code flow, and the connection call. Activity files are relayed, with retries and token refresh.
Connections are looked after: permission changes, deregistration, history, the refresh of a quiet athlete's
grant, and the removal of a connection nobody claims within a day. A user's token now asks for
`activities:write` and nothing else. Disconnect is still to come.
