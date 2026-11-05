# SweatStack bridge

The SweatStack bridge is an OpenID Provider that brokers your athletes' Garmin sign-in to SweatStack Sign-In, and a client of SweatStack's public API that relays their data. It runs under your domain, on your Garmin keys.

> **Being built.** This README describes bridge 0.1, which doesn't exist yet. The deploy button and most
> commands don't work yet, and some links lead to docs still being written.

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/SweatStack/sweatstack-bridge)

## Why run it

The bridge is a small service you deploy yourself, and your athletes keep the normal sign-in.
[Compare the ways to connect data.](https://sweatstack.no/data-provenance/)

- **Your Garmin consent:** athletes see your app's name on Garmin's consent screen.
- **Your keys and tokens:** they stay in your Cloudflare account. SweatStack never holds them.
- **Truthful status:** the account status and the Portal show what each connection can do.
- **No lock-in:** SweatStack doesn't depend on this code. [The contract](https://docs.sweatstack.no/learn/integrations/self-hosted/contract/)
  is all you need if you'd rather build your own.

Bridge 0.1 covers activities and activity history.

```
                     sign-in (OpenID Connect)
 Garmin  ◄────────►  Bridge  ◄────────────────►  SweatStack  ◄────►  Your app
 consent, tokens,    (your Worker,                Sign-In, API,
 webhooks, files     your D1)                     Portal
                        └── activity files, connection state ──►
```

## Before you start

- [ ] A [live SweatStack app](https://docs.sweatstack.no/learn/applications/going-live/) with the `activities:write` scope
- [ ] [Keys from Garmin's developer program](https://docs.sweatstack.no/learn/integrations/garmin/). Request them early: it's the one step whose timing you don't control
- [ ] A Cloudflare account. The free plan covers a small app, and USD 5 a month removes its limits
- [ ] You've read [what changes for your users](https://docs.sweatstack.no/learn/integrations/self-hosted/#your-users). In short: your sign-in page loses its email field, and one person can end up as two users. **Never merge users by email.**

## Deploy

1. **Click the deploy button.** Leave anything you don't have yet empty.
2. **Clone your copy, then:**

   ```sh
   npm ci
   npx wrangler login
   npm run status   # what's still missing; no secrets, safe to share
   npm run urls     # every URL to paste; includes a secret, so keep it private
   ```

3. **In SweatStack's OAuth tab:** create a client secret. Set `SWEATSTACK_APP_ID` and `SWEATSTACK_CLIENT_SECRET`.
4. **In Garmin's developer tools:** paste the URLs from `npm run urls`. Set `GARMIN_CLIENT_ID` and `GARMIN_CLIENT_SECRET`.
5. **In SweatStack's Data sources tab:** choose "Self-hosted" on the Garmin card and paste the issuer URL.
6. **Test in a private window.**

> **Choose your domain before athletes connect.** Moving it later means repeating steps 4 and 5.
>
> **Don't delete the D1 database.** Without it, every athlete has to connect again and comes back as a new
> user. `npx wrangler d1 export` makes a backup. The file holds their tokens, so keep it safe.

### Settings

| Name | Kind | What |
|---|---|---|
| `SWEATSTACK_URL` | var | Where SweatStack runs. Leave as is |
| `SWEATSTACK_APP_ID` | var | Your app's client id |
| `GARMIN_CLIENT_ID` | var | Your Garmin client id |
| `BACKFILL_DAYS` | var | Days of history to request on connecting. Default 90 |
| `SWEATSTACK_CLIENT_SECRET` | secret | A client secret just for the bridge, so it rotates separately |
| `GARMIN_CLIENT_SECRET` | secret | Your Garmin client secret |

## Update

```sh
npm run update            # to the latest release
npm run update -- v0.2.0  # to a specific one
```

Review the result, commit and push. Nothing published here changes your deployment until you do.
`npm run status` tells you when a release is available.

## Learn more

- [Self-hosted integrations](https://docs.sweatstack.no/learn/integrations/self-hosted/): how they work and what changes for your users
- [The contract](https://docs.sweatstack.no/learn/integrations/self-hosted/contract/): what SweatStack requires of any integration
- [Garmin setup](https://docs.sweatstack.no/learn/integrations/garmin/): keys, permissions and URLs
- [DEVELOPING.md](DEVELOPING.md): how the code works, and how to run and change your copy
- [CHANGELOG.md](CHANGELOG.md)

Questions? [info@sweatstack.no](mailto:info@sweatstack.no). This repository [doesn't take contributions](CONTRIBUTING.md).

## No guarantees

**This software comes with no guarantees of any kind.** We don't promise that it:

- works, is free of bugs, or is secure
- keeps working when SweatStack, Garmin or Cloudflare change something
- gets updates, fixes or answers to your questions
- suits your app, or meets any agreement or law that applies to you

**Running it is your responsibility**, including your deployment, your athletes' tokens and data, any
agreements that apply to you, and any harm or loss from using this code. SweatStack doesn't operate, monitor or update
your deployment. Read the code and test it before you rely on it.

The [LICENSE](LICENSE) is what legally applies. Your use of SweatStack's own service stays under your
agreement with SweatStack.

## License

[MIT](LICENSE). Use it for anything, change it and redistribute it, without asking or paying. Just keep the
copyright and license notice in copies of the code.
