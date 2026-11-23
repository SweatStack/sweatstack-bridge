import type { Child } from "hono/jsx";
import { raw } from "hono/html";

/**
 * The console's pages, rendered on the server. No inline script or style: the CSP allows only the files under
 * `public/console/`.
 */

/** Tabler Icons (MIT, tabler.io/icons), drawn inline so the page needs no request for them. */
const ICON_PATHS = {
  bridge: (
    <>
      <path d="M6 5l0 14" />
      <path d="M18 5l0 14" />
      <path d="M2 15l20 0" />
      <path d="M3 8a7.5 7.5 0 0 0 3 -2a6.5 6.5 0 0 0 12 0a7.5 7.5 0 0 0 3 2" />
      <path d="M12 10l0 5" />
    </>
  ),
  sun: (
    <>
      <path d="M12 12m-4 0a4 4 0 1 0 8 0a4 4 0 1 0 -8 0" />
      <path d="M3 12h1m8 -9v1m8 8h1m-9 8v1m-6.4 -15.4l.7 .7m12.1 -.7l-.7 .7m0 11.4l.7 .7m-12.1 -.7l-.7 .7" />
    </>
  ),
  moon: <path d="M12 3c.132 0 .263 0 .393 0a7.5 7.5 0 0 0 7.92 12.446a9 9 0 1 1 -8.313 -12.454z" />,
};

function Icon({ name, class: className = "icon" }: { name: "sun" | "moon"; class?: string }) {
  return (
    <svg class={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      {ICON_PATHS[name]}
    </svg>
  );
}

/** The app icon: a rounded square in the Norwegian flag's red, with the bridge in its blue. As `icon.svg`. */
function AppIcon({ class: className }: { class: string }) {
  return (
    <svg class={className} viewBox="0 0 24 24" aria-hidden="true">
      <rect width="24" height="24" rx="5.5" fill="#BA0C2F" />
      <g transform="translate(4 4) scale(0.6667)" fill="none" stroke="#00205B" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round">
        {ICON_PATHS.bridge}
      </g>
    </svg>
  );
}

function Layout({ host, signedIn, children }: { host: string; signedIn: boolean; children: Child }) {
  return (
    <>
      {raw("<!doctype html>")}
      <html lang="en">
        <head>
          <meta charset="utf-8" />
          <meta name="viewport" content="width=device-width, initial-scale=1" />
          <meta name="robots" content="noindex" />
          <title>SweatStack bridge</title>
          <link rel="icon" type="image/svg+xml" href="/console/icon.svg" />
          <link rel="stylesheet" href="/console/console.css" />
          {/* In <head>, so the page never shows the other theme first. It waits for the page itself. */}
          <script src="/console/console.js"></script>
        </head>
        <body>
          <header class="topbar">
            <span class="brand">
              <AppIcon class="icon" />
              SweatStack bridge
            </span>
            <span class="host">{host}</span>
            <span class="right">
              {signedIn && (
                <form method="post" action="/console/sign-out">
                  <button class="link-button" type="submit">
                    Sign out
                  </button>
                </form>
              )}
              <button class="theme-toggle" type="button" data-theme-toggle hidden>
                <Icon name="moon" class="icon show-light" />
                <Icon name="sun" class="icon show-dark" />
              </button>
            </span>
          </header>
          {children}
        </body>
      </html>
    </>
  );
}

/** Before `SWEATSTACK_CLIENT_SECRET` is set: nobody can sign in, and the bridge has nothing to protect yet. */
export function NoSecretPage({ host }: { host: string }) {
  return (
    <Layout host={host} signedIn={false}>
      <main class="public">
        <AppIcon class="mark" />
        <h1>Almost there</h1>
        <p>
          This bridge has no SweatStack client secret yet, so nobody can sign in. Add <code>SWEATSTACK_CLIENT_SECRET</code> to this Worker in
          Cloudflare, under Settings, Variables and Secrets. You don't need to deploy again.
        </p>
      </main>
    </Layout>
  );
}

/** Signed out: nothing about the bridge, only the form. */
export function SignInPage({ host, failed }: { host: string; failed: boolean }) {
  return (
    <Layout host={host} signedIn={false}>
      <main class="public">
        <AppIcon class="mark" />
        <h1>A SweatStack bridge</h1>
        <p>It connects a wearable platform to an app built on SweatStack. Its owner signs in here.</p>
        <form class="signin" method="post" action="/console/sign-in">
          {/* A fixed username, so a password manager saves the secret for this site. */}
          <input type="hidden" name="username" autocomplete="username" value="owner" />
          <div>
            <label for="secret">Your bridge's SweatStack client secret</label>
            <input id="secret" type="password" name="secret" autocomplete="current-password" required autofocus />
          </div>
          {failed && (
            <p class="error" role="alert">
              That isn't this bridge's secret.
            </p>
          )}
          <button class="btn btn-primary" type="submit">
            Sign in
          </button>
          <p class="hint">
            The secret you pasted when you deployed. Lost it? Create a new one on your app's OAuth tab in SweatStack, and replace{" "}
            <code>SWEATSTACK_CLIENT_SECRET</code> in Cloudflare.
          </p>
        </form>
      </main>
    </Layout>
  );
}

/** Signed in. */
export function ConsolePage({ host }: { host: string }) {
  return (
    <Layout host={host} signedIn={true}>
      <main class="column" data-page="console">
        <h1>Signed in</h1>
      </main>
    </Layout>
  );
}
