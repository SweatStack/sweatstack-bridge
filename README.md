# SweatStack bridge

**Let athletes sign in with Garmin to your app built on SweatStack, and get their activities, on your own Garmin keys.**
It's a small service that runs in your own Cloudflare account.

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/SweatStack/sweatstack-bridge)

```
Garmin  ──►  Bridge, in your Cloudflare account  ──►  SweatStack  ──►  Your app
```

- **Your name:** athletes see your app on Garmin's consent screen.
- **Your keys:** Garmin keys and athletes' tokens stay in your Cloudflare account. SweatStack never holds them.
- **Activities and history:** files are relayed as they arrive, with retries, and history is fetched on connecting.
- **Reference implementation:** this is SweatStack's reference implementation of [its public contract](https://docs.sweatstack.no/learn/applications/self-hosted-integrations/), [tested against it](DEVELOPING.md#tests). SweatStack relies only on that contract, so you can replace this code with your own.

## Where to go

| To | Read |
|---|---|
| Deploy a bridge | [Runbook: Before you start](RUNBOOK.md#before-you-start) |
| Get Garmin keys and permissions | [Set up Garmin Connect](https://docs.sweatstack.no/learn/integrations/garmin/) |
| See what changes for your users | [What athletes see](https://docs.sweatstack.no/learn/applications/self-hosted-integrations/#what-athletes-see-on-your-sign-in-screen) |
| Check on it, or update it | [Runbook: Run it](RUNBOOK.md#run-it) |
| Understand or change the code | [DEVELOPING.md](DEVELOPING.md) |
| See what changed | [CHANGELOG.md](CHANGELOG.md) |

Questions? [info@sweatstack.no](mailto:info@sweatstack.no). This repository [doesn't take contributions](CONTRIBUTING.md).

## No guarantees

This software comes with no guarantees of any kind. Running it is your responsibility, including your deployment,
your athletes' tokens and data, and whatever applies to you legally. SweatStack doesn't operate, monitor or update
your deployment. Read the code and test it before you rely on it.

[MIT licensed](LICENSE): use it for anything, change it and redistribute it.
